#!/usr/bin/env node
// Reliable Jira MCP server.
// Stdout is reserved for the MCP protocol — every log/diagnostic must go to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

// ---------- logging (stderr only) ----------
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = LOG_LEVELS[(process.env.JIRA_LOG_LEVEL || 'info').toLowerCase()] ?? LOG_LEVELS.info;
function log(level, msg, data) {
  if ((LOG_LEVELS[level] ?? 0) < LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase()} ${msg}${data !== undefined ? ' ' + safeStringify(data) : ''}`;
  process.stderr.write(line + '\n');
}
function safeStringify(v) {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------- JiraClient ----------
const DEFAULT_TIMEOUT_MS = Number(process.env.JIRA_TIMEOUT_MS || 30000);
const DEFAULT_RETRIES = Number(process.env.JIRA_MAX_RETRIES || 2);
const DEFAULT_SEARCH_FIELDS = ['summary', 'status', 'assignee', 'issuetype', 'priority', 'labels', 'updated'];
const HARD_MAX_RESULTS = 100;
const DEFAULT_MAX_RESULTS = 25;

class JiraError extends Error {
  constructor(status, statusText, body, url, method) {
    const bodySnippet = typeof body === 'string' ? body.slice(0, 2000) : safeStringify(body)?.slice(0, 2000);
    super(`Jira ${method} ${url} → HTTP ${status} ${statusText || ''}\n${bodySnippet}`);
    this.name = 'JiraError';
    this.status = status;
    this.body = body;
  }
}

class JiraClient {
  constructor() {
    const raw = process.env.JIRA_BASE_URL;
    if (!raw) throw new Error('JIRA_BASE_URL is not set');
    this.baseUrl = raw.replace(/\/+$/, '');
    this.token = process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN;
    this.email = process.env.JIRA_EMAIL || process.env.JIRA_USERNAME;
    if (!this.token) throw new Error('JIRA_API_TOKEN is not set');

    const explicitMode = (process.env.JIRA_AUTH_MODE || '').toLowerCase();
    const looksCloud = /\.atlassian\.net$/i.test(new URL(this.baseUrl).hostname);
    if (explicitMode === 'basic' || (explicitMode === '' && looksCloud)) {
      if (!this.email) throw new Error('Cloud Basic auth needs JIRA_EMAIL (or JIRA_USERNAME)');
      this.authMode = 'basic';
      this.apiVersion = process.env.JIRA_API_VERSION || '3';
    } else {
      this.authMode = 'bearer';
      this.apiVersion = process.env.JIRA_API_VERSION || '2';
    }
    log('info', 'JiraClient initialized', {
      baseUrl: this.baseUrl,
      authMode: this.authMode,
      apiVersion: this.apiVersion,
      email: this.email || null,
    });
  }

  authHeader() {
    if (this.authMode === 'basic') {
      const b64 = Buffer.from(`${this.email}:${this.token}`).toString('base64');
      return `Basic ${b64}`;
    }
    return `Bearer ${this.token}`;
  }

  url(endpoint, { api = `rest/api/${this.apiVersion}` } = {}) {
    const clean = endpoint.replace(/^\/+/, '');
    if (clean.startsWith('rest/')) return `${this.baseUrl}/${clean}`;
    return `${this.baseUrl}/${api}/${clean}`;
  }

  async request(endpoint, { method = 'GET', body, query, headers = {}, api, raw = false } = {}) {
    const u = new URL(this.url(endpoint, { api }));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) u.searchParams.set(k, v.join(','));
        else u.searchParams.set(k, String(v));
      }
    }
    const url = u.toString();

    const finalHeaders = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
      'User-Agent': 'ff-mcp-jira/1.0',
      ...headers,
    };
    let payload;
    if (body !== undefined) {
      if (body instanceof FormData || body instanceof Uint8Array || body instanceof Buffer) {
        payload = body;
        // do not set Content-Type for FormData (let fetch set boundary)
      } else if (typeof body === 'string') {
        payload = body;
        finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
      } else {
        payload = JSON.stringify(body);
        finalHeaders['Content-Type'] = 'application/json';
      }
    }

    let lastErr;
    for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
      try {
        log('debug', 'jira request', { method, url, attempt });
        const res = await fetch(url, {
          method,
          headers: finalHeaders,
          body: payload,
          signal: ctrl.signal,
          redirect: 'follow',
        });
        clearTimeout(t);

        const text = await res.text();
        let parsed = text;
        if (text && (res.headers.get('content-type') || '').includes('application/json')) {
          try { parsed = JSON.parse(text); } catch { /* keep text */ }
        } else if (text && text.startsWith('{')) {
          try { parsed = JSON.parse(text); } catch { /* keep text */ }
        }

        if (!res.ok) {
          if ([429, 502, 503, 504].includes(res.status) && attempt < DEFAULT_RETRIES) {
            const wait = Math.min(2000 * 2 ** attempt, 8000);
            log('warn', 'retryable error, backing off', { status: res.status, wait });
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw new JiraError(res.status, res.statusText, parsed, url, method);
        }
        return raw ? { status: res.status, body: parsed } : parsed;
      } catch (e) {
        clearTimeout(t);
        if (e instanceof JiraError) throw e;
        lastErr = e;
        if (attempt < DEFAULT_RETRIES) {
          const wait = Math.min(1000 * 2 ** attempt, 5000);
          log('warn', 'network error, backing off', { err: e.message, wait });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  // ---------- ADF helper (Cloud v3) ----------
  toADF(input) {
    if (input == null) return input;
    if (typeof input === 'object' && input.type === 'doc') return input;
    const text = typeof input === 'string' ? input : safeStringify(input);
    return {
      type: 'doc',
      version: 1,
      content: text.split(/\n{2,}/).map((p) => ({
        type: 'paragraph',
        content: p
          .split('\n')
          .flatMap((line, i, arr) => {
            const segs = [];
            if (line.length) segs.push({ type: 'text', text: line });
            if (i < arr.length - 1) segs.push({ type: 'hardBreak' });
            return segs;
          }),
      })),
    };
  }

  needsADF() {
    return this.authMode === 'basic' && this.apiVersion === '3';
  }
}

// ---------- response helpers ----------
function ok(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}
function err(message, details) {
  const text = details ? `${message}\n${typeof details === 'string' ? details : JSON.stringify(details, null, 2)}` : message;
  return { isError: true, content: [{ type: 'text', text }] };
}
function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      log('error', 'tool failed', { msg: e.message, stack: e.stack?.split('\n').slice(0, 3).join(' | ') });
      if (e instanceof JiraError) {
        return err(`Jira error ${e.status}`, e.body);
      }
      return err(e.message || 'Unknown error');
    }
  };
}
function clampMax(n) {
  if (n == null) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(HARD_MAX_RESULTS, Math.floor(n)));
}

// ---------- server + tools ----------
const server = new McpServer({ name: 'ff-mcp-jira', version: '1.0.0' });
const jira = new JiraClient();

server.registerTool(
  'jira_get_myself',
  {
    title: 'Get current user',
    description: 'Return the authenticated Jira user. Use this as a smoke test for auth and base URL.',
    inputSchema: {},
  },
  wrap(async () => {
    const me = await jira.request('myself');
    return ok({
      name: me.name,
      key: me.key,
      accountId: me.accountId,
      displayName: me.displayName,
      email: me.emailAddress,
      timeZone: me.timeZone,
      active: me.active,
    });
  })
);

server.registerTool(
  'jira_find_users',
  {
    title: 'Find users',
    description:
      'Search users by name/username/email. Use to resolve a handle to an assignee/watcher value (username on Server, accountId on Cloud). Returns the value to feed into jira_assign_issue / jira_create_issue.',
    inputSchema: {
      query: z.string().describe('Name, username, or email fragment'),
      maxResults: z.number().int().positive().optional().describe('1..100, default 25'),
    },
  },
  wrap(async ({ query, maxResults }) => {
    // Server/DC takes `username`; Cloud takes `query`. ponytail: one param per auth mode, no fallback chasing.
    const q = jira.authMode === 'basic' ? { query } : { username: query };
    const data = await jira.request('user/search', { query: { ...q, maxResults: clampMax(maxResults) } });
    const users = (Array.isArray(data) ? data : []).map((u) => ({
      name: u.name,
      key: u.key,
      accountId: u.accountId,
      displayName: u.displayName,
      email: u.emailAddress,
      active: u.active,
      assignValue: jira.authMode === 'basic' ? u.accountId : u.name,
    }));
    return ok({ count: users.length, users });
  })
);

server.registerTool(
  'jira_search',
  {
    title: 'Search issues by JQL',
    description:
      'Run a JQL search. Defaults to a lean set of fields and 25 results — pass `fields:["*all"]` for everything, or a specific list. Hard cap maxResults at 100.',
    inputSchema: {
      jql: z.string().describe('JQL query, e.g. `project = AZ AND status = "In Progress"`'),
      maxResults: z.number().int().positive().optional().describe('1..100, default 25'),
      startAt: z.number().int().nonnegative().optional(),
      fields: z.array(z.string()).optional().describe('Defaults to a lean preset. Use ["*all"] or ["*navigable"] to widen.'),
      expand: z.array(z.string()).optional(),
    },
  },
  wrap(async ({ jql, maxResults, startAt = 0, fields, expand }) => {
    const body = {
      jql,
      startAt,
      maxResults: clampMax(maxResults),
      fields: fields && fields.length ? fields : DEFAULT_SEARCH_FIELDS,
    };
    if (expand?.length) body.expand = expand;
    const data = await jira.request('search', { method: 'POST', body });
    const slim = (data.issues || []).map((i) => ({ key: i.key, id: i.id, fields: i.fields }));
    return ok({
      total: data.total,
      startAt: data.startAt,
      maxResults: data.maxResults,
      returned: slim.length,
      issues: slim,
    });
  })
);

server.registerTool(
  'jira_get_issue',
  {
    title: 'Get one issue',
    description: 'Fetch a single issue. By default returns a lean field set; pass `fields:["*all"]` for everything.',
    inputSchema: {
      issueKey: z.string().describe('Issue key, e.g. AZ-12345'),
      fields: z.array(z.string()).optional(),
      expand: z.array(z.string()).optional(),
    },
  },
  wrap(async ({ issueKey, fields, expand }) => {
    const query = {
      fields: fields && fields.length ? fields.join(',') : DEFAULT_SEARCH_FIELDS.concat('description', 'parent', 'subtasks').join(','),
    };
    if (expand?.length) query.expand = expand.join(',');
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}`, { query });
    return ok({ key: data.key, id: data.id, fields: data.fields });
  })
);

server.registerTool(
  'jira_create_issue',
  {
    title: 'Create issue',
    description:
      'Create an issue. Always pass `project` (key) and `issueType` (name). Optional fields (labels, components, fixVersions, customfield_*, etc.) go through `fields`. `description` accepts plain text and is auto-converted to ADF on Cloud v3. Server/DC value formats: Sprint customfield takes a NUMERIC sprint id (from jira_list_sprints), Epic Link takes the epic issue key string (e.g. "KG-58"), assignee is the exact username — usernames are NOT derivable from email (resolve via jira_find_assignable_users first). Prefer setting everything in this single create call.',
    inputSchema: {
      project: z.string(),
      issueType: z.string(),
      summary: z.string(),
      description: z.union([z.string(), z.record(z.any())]).optional(),
      assignee: z.string().optional().describe('Exact username (Server — not derivable from email, resolve via jira_find_assignable_users) or accountId (Cloud)'),
      priority: z.string().optional(),
      labels: z.array(z.string()).optional(),
      components: z.array(z.string()).optional(),
      parentKey: z.string().optional().describe('Set parent key when creating a subtask'),
      fields: z.record(z.any()).optional().describe('Any extra fields, merged last (wins on conflict).'),
    },
  },
  wrap(async ({ project, issueType, summary, description, assignee, priority, labels, components, parentKey, fields }) => {
    const out = {
      project: { key: project },
      issuetype: { name: issueType },
      summary,
    };
    if (description !== undefined) {
      out.description = jira.needsADF() ? jira.toADF(description) : description;
    }
    if (assignee !== undefined) {
      out.assignee = jira.authMode === 'basic' ? { accountId: assignee } : { name: assignee };
    }
    if (priority) out.priority = { name: priority };
    if (labels) out.labels = labels;
    if (components) out.components = components.map((c) => (typeof c === 'string' ? { name: c } : c));
    if (parentKey) out.parent = { key: parentKey };
    if (fields) Object.assign(out, fields);

    const data = await jira.request('issue', { method: 'POST', body: { fields: out } });
    return ok(data);
  })
);

server.registerTool(
  'jira_update_issue',
  {
    title: 'Update issue',
    description:
      'Update an issue. Pass `fields` for absolute values OR `update` for ops (`add`/`remove`/`set`). Convenience shortcuts: `labels`, `assignee`, `priority`, `summary`, `description`. Server/DC value formats: Sprint customfield = NUMERIC sprint id (jira_list_sprints), Epic Link = epic issue key string, assignee = exact username (resolve via jira_find_assignable_users — not derivable from email).',
    inputSchema: {
      issueKey: z.string(),
      summary: z.string().optional(),
      description: z.union([z.string(), z.record(z.any())]).optional(),
      assignee: z.string().nullable().optional().describe('username (Server) / accountId (Cloud); pass null to unassign'),
      priority: z.string().optional(),
      labels: z.array(z.string()).optional().describe('Sets the full label list (replace)'),
      fields: z.record(z.any()).optional(),
      update: z.record(z.any()).optional(),
      notifyUsers: z.boolean().optional(),
    },
  },
  wrap(async ({ issueKey, summary, description, assignee, priority, labels, fields, update, notifyUsers }) => {
    const f = { ...(fields || {}) };
    if (summary !== undefined) f.summary = summary;
    if (description !== undefined) f.description = jira.needsADF() ? jira.toADF(description) : description;
    if (assignee !== undefined) {
      if (assignee === null) f.assignee = jira.authMode === 'basic' ? { accountId: null } : { name: null };
      else f.assignee = jira.authMode === 'basic' ? { accountId: assignee } : { name: assignee };
    }
    if (priority !== undefined) f.priority = { name: priority };
    if (labels !== undefined) f.labels = labels;

    const body = {};
    if (Object.keys(f).length) body.fields = f;
    if (update && Object.keys(update).length) body.update = update;
    if (!body.fields && !body.update) throw new Error('Nothing to update — pass at least one field.');

    const query = notifyUsers === false ? { notifyUsers: 'false' } : undefined;
    await jira.request(`issue/${encodeURIComponent(issueKey)}`, { method: 'PUT', body, query });
    return ok({ key: issueKey, updated: Object.keys(f), updateOps: update ? Object.keys(update) : [] });
  })
);

server.registerTool(
  'jira_add_labels',
  {
    title: 'Add labels',
    description: 'Add one or more labels to an issue without overwriting existing ones.',
    inputSchema: { issueKey: z.string(), labels: z.array(z.string()).min(1) },
  },
  wrap(async ({ issueKey, labels }) => {
    const body = { update: { labels: labels.map((l) => ({ add: l })) } };
    await jira.request(`issue/${encodeURIComponent(issueKey)}`, { method: 'PUT', body });
    return ok({ key: issueKey, added: labels });
  })
);

server.registerTool(
  'jira_remove_labels',
  {
    title: 'Remove labels',
    description: 'Remove labels from an issue.',
    inputSchema: { issueKey: z.string(), labels: z.array(z.string()).min(1) },
  },
  wrap(async ({ issueKey, labels }) => {
    const body = { update: { labels: labels.map((l) => ({ remove: l })) } };
    await jira.request(`issue/${encodeURIComponent(issueKey)}`, { method: 'PUT', body });
    return ok({ key: issueKey, removed: labels });
  })
);

server.registerTool(
  'jira_list_transitions',
  {
    title: 'List transitions',
    description: 'List available transitions for an issue. Use the returned `id` with jira_transition_issue.',
    inputSchema: { issueKey: z.string() },
  },
  wrap(async ({ issueKey }) => {
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/transitions`);
    return ok((data.transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name })));
  })
);

server.registerTool(
  'jira_transition_issue',
  {
    title: 'Transition issue',
    description:
      'Move an issue to a new status. Pass either `transitionId` (preferred) or `transitionName` (case-insensitive match). Optional `comment` and `fields`.',
    inputSchema: {
      issueKey: z.string(),
      transitionId: z.string().optional(),
      transitionName: z.string().optional(),
      comment: z.string().optional(),
      fields: z.record(z.any()).optional(),
    },
  },
  wrap(async ({ issueKey, transitionId, transitionName, comment, fields }) => {
    let tid = transitionId;
    if (!tid) {
      if (!transitionName) throw new Error('Pass transitionId or transitionName.');
      const t = await jira.request(`issue/${encodeURIComponent(issueKey)}/transitions`);
      const match = (t.transitions || []).find((x) => x.name.toLowerCase() === transitionName.toLowerCase());
      if (!match) throw new Error(`No transition named "${transitionName}". Available: ${(t.transitions || []).map((x) => x.name).join(', ')}`);
      tid = match.id;
    }
    const body = { transition: { id: tid } };
    if (fields) body.fields = fields;
    if (comment) {
      const cb = jira.needsADF() ? jira.toADF(comment) : comment;
      body.update = { comment: [{ add: { body: cb } }] };
    }
    await jira.request(`issue/${encodeURIComponent(issueKey)}/transitions`, { method: 'POST', body });
    return ok({ key: issueKey, transitionId: tid });
  })
);

server.registerTool(
  'jira_add_comment',
  {
    title: 'Add comment',
    description: 'Add a comment to an issue. Plain text is auto-wrapped to ADF on Cloud v3.',
    inputSchema: { issueKey: z.string(), body: z.union([z.string(), z.record(z.any())]) },
  },
  wrap(async ({ issueKey, body }) => {
    const payload = { body: jira.needsADF() ? jira.toADF(body) : body };
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/comment`, { method: 'POST', body: payload });
    return ok({ id: data.id, created: data.created, author: data.author?.displayName });
  })
);

server.registerTool(
  'jira_list_comments',
  {
    title: 'List comments',
    description: 'List comments on an issue.',
    inputSchema: { issueKey: z.string(), maxResults: z.number().int().positive().optional() },
  },
  wrap(async ({ issueKey, maxResults }) => {
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/comment`, {
      query: { maxResults: clampMax(maxResults) },
    });
    const slim = (data.comments || []).map((c) => ({
      id: c.id,
      author: c.author?.displayName || c.author?.name,
      created: c.created,
      updated: c.updated,
      body: typeof c.body === 'string' ? c.body : safeStringify(c.body),
    }));
    return ok({ total: data.total, returned: slim.length, comments: slim });
  })
);

server.registerTool(
  'jira_assign_issue',
  {
    title: 'Assign issue',
    description: 'Set or clear the assignee. Pass `assignee` as username (Server) or accountId (Cloud). Use `-1` to auto-assign, null to unassign.',
    inputSchema: { issueKey: z.string(), assignee: z.string().nullable() },
  },
  wrap(async ({ issueKey, assignee }) => {
    const body = jira.authMode === 'basic' ? { accountId: assignee } : { name: assignee };
    await jira.request(`issue/${encodeURIComponent(issueKey)}/assignee`, { method: 'PUT', body });
    return ok({ key: issueKey, assignee });
  })
);

server.registerTool(
  'jira_create_subtask',
  {
    title: 'Create subtask',
    description: 'Create a subtask under a parent issue. Defaults the subtask type to "Sub-task" — override with `subtaskType`.',
    inputSchema: {
      parentKey: z.string(),
      summary: z.string(),
      description: z.string().optional(),
      subtaskType: z.string().optional(),
      assignee: z.string().optional(),
      labels: z.array(z.string()).optional(),
      fields: z.record(z.any()).optional(),
    },
  },
  wrap(async ({ parentKey, summary, description, subtaskType, assignee, labels, fields }) => {
    const parent = await jira.request(`issue/${encodeURIComponent(parentKey)}`, { query: { fields: 'project' } });
    const projectKey = parent.fields?.project?.key;
    if (!projectKey) throw new Error(`Cannot determine project from parent ${parentKey}`);
    const f = {
      project: { key: projectKey },
      issuetype: { name: subtaskType || 'Sub-task' },
      parent: { key: parentKey },
      summary,
      ...(fields || {}),
    };
    if (description !== undefined) f.description = jira.needsADF() ? jira.toADF(description) : description;
    if (assignee) f.assignee = jira.authMode === 'basic' ? { accountId: assignee } : { name: assignee };
    if (labels) f.labels = labels;
    const data = await jira.request('issue', { method: 'POST', body: { fields: f } });
    return ok(data);
  })
);

server.registerTool(
  'jira_link_issues',
  {
    title: 'Link issues',
    description: 'Create an issue link. Example types: "Blocks", "Relates", "Duplicate". Use jira_list_link_types to discover.',
    inputSchema: {
      inwardIssueKey: z.string().describe('The issue on the inward side of the link'),
      outwardIssueKey: z.string().describe('The issue on the outward side'),
      linkType: z.string().describe('Link type name'),
      comment: z.string().optional(),
    },
  },
  wrap(async ({ inwardIssueKey, outwardIssueKey, linkType, comment }) => {
    const body = {
      type: { name: linkType },
      inwardIssue: { key: inwardIssueKey },
      outwardIssue: { key: outwardIssueKey },
    };
    if (comment) body.comment = { body: jira.needsADF() ? jira.toADF(comment) : comment };
    await jira.request('issueLink', { method: 'POST', body });
    return ok({ inwardIssueKey, outwardIssueKey, linkType });
  })
);

server.registerTool(
  'jira_list_link_types',
  {
    title: 'List link types',
    description: 'List available issue link types.',
    inputSchema: {},
  },
  wrap(async () => {
    const data = await jira.request('issueLinkType');
    return ok((data.issueLinkTypes || []).map((t) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward })));
  })
);

server.registerTool(
  'jira_add_watcher',
  {
    title: 'Add watcher',
    description: 'Add a watcher (username on Server, accountId on Cloud).',
    inputSchema: { issueKey: z.string(), user: z.string() },
  },
  wrap(async ({ issueKey, user }) => {
    await jira.request(`issue/${encodeURIComponent(issueKey)}/watchers`, { method: 'POST', body: user });
    return ok({ key: issueKey, addedWatcher: user });
  })
);

server.registerTool(
  'jira_remove_watcher',
  {
    title: 'Remove watcher',
    description: 'Remove a watcher.',
    inputSchema: { issueKey: z.string(), user: z.string() },
  },
  wrap(async ({ issueKey, user }) => {
    const key = jira.authMode === 'basic' ? 'accountId' : 'username';
    await jira.request(`issue/${encodeURIComponent(issueKey)}/watchers`, { method: 'DELETE', query: { [key]: user } });
    return ok({ key: issueKey, removedWatcher: user });
  })
);

server.registerTool(
  'jira_log_work',
  {
    title: 'Log work',
    description: 'Add a worklog. timeSpent uses Jira syntax: "1h", "30m", "1h 30m".',
    inputSchema: {
      issueKey: z.string(),
      timeSpent: z.string(),
      comment: z.string().optional(),
      started: z.string().optional().describe('ISO date with offset, e.g. 2026-05-19T10:00:00.000+0000'),
    },
  },
  wrap(async ({ issueKey, timeSpent, comment, started }) => {
    const body = { timeSpent };
    if (comment) body.comment = jira.needsADF() ? jira.toADF(comment) : comment;
    if (started) body.started = started;
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/worklog`, { method: 'POST', body });
    return ok({ id: data.id, timeSpent: data.timeSpent, started: data.started });
  })
);

server.registerTool(
  'jira_list_worklogs',
  {
    title: 'List worklogs',
    description: 'List worklog entries for an issue.',
    inputSchema: { issueKey: z.string() },
  },
  wrap(async ({ issueKey }) => {
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/worklog`);
    return ok({
      total: data.total,
      worklogs: (data.worklogs || []).map((w) => ({
        id: w.id,
        author: w.author?.displayName || w.author?.name,
        timeSpent: w.timeSpent,
        timeSpentSeconds: w.timeSpentSeconds,
        started: w.started,
        comment: typeof w.comment === 'string' ? w.comment : safeStringify(w.comment),
      })),
    });
  })
);

server.registerTool(
  'jira_list_projects',
  {
    title: 'List projects',
    description: 'List visible projects.',
    inputSchema: { query: z.string().optional().describe('Optional substring filter applied client-side') },
  },
  wrap(async ({ query }) => {
    const data = await jira.request('project');
    const items = (Array.isArray(data) ? data : []).map((p) => ({ key: p.key, name: p.name, id: p.id, projectTypeKey: p.projectTypeKey }));
    const filtered = query ? items.filter((p) => (p.key + ' ' + p.name).toLowerCase().includes(query.toLowerCase())) : items;
    return ok({ count: filtered.length, projects: filtered.slice(0, 200) });
  })
);

server.registerTool(
  'jira_list_issue_types',
  {
    title: 'List issue types',
    description: 'List issue types — global or per-project.',
    inputSchema: { project: z.string().optional() },
  },
  wrap(async ({ project }) => {
    if (project) {
      const data = await jira.request(`project/${encodeURIComponent(project)}`);
      return ok((data.issueTypes || []).map((t) => ({ id: t.id, name: t.name, subtask: t.subtask })));
    }
    const data = await jira.request('issuetype');
    return ok((Array.isArray(data) ? data : []).map((t) => ({ id: t.id, name: t.name, subtask: t.subtask })));
  })
);

server.registerTool(
  'jira_attach_file',
  {
    title: 'Attach file',
    description: 'Attach a local file to an issue. Pass absolute path.',
    inputSchema: { issueKey: z.string(), filePath: z.string() },
  },
  wrap(async ({ issueKey, filePath }) => {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
    const buf = fs.readFileSync(abs);
    const form = new FormData();
    form.append('file', new Blob([buf]), path.basename(abs));
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/attachments`, {
      method: 'POST',
      body: form,
      headers: { 'X-Atlassian-Token': 'no-check' },
    });
    return ok((Array.isArray(data) ? data : []).map((a) => ({ id: a.id, filename: a.filename, size: a.size })));
  })
);

server.registerTool(
  'jira_raw_request',
  {
    title: 'Raw API call (escape hatch)',
    description:
      'Make an arbitrary call against the Jira REST API. Use when no other tool fits, or to debug. `endpoint` can be relative (joined with /rest/api/<v>) or start with `rest/` for an absolute path under base URL.',
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
      endpoint: z.string(),
      body: z.any().optional(),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    },
  },
  wrap(async ({ method, endpoint, body, query }) => {
    const data = await jira.request(endpoint, { method, body, query });
    return ok(data);
  })
);

// ---------- discovery: fields & create metadata ----------
server.registerTool(
  'jira_list_fields',
  {
    title: 'List fields',
    description:
      'List all fields (system + custom). Use to resolve a customfield_NNNNN id ↔ human name before setting it in jira_create_issue / jira_update_issue.',
    inputSchema: { query: z.string().optional().describe('Optional substring filter on id/name, applied client-side') },
  },
  wrap(async ({ query }) => {
    const data = await jira.request('field');
    let items = (Array.isArray(data) ? data : []).map((f) => ({
      id: f.id,
      name: f.name,
      custom: !!f.custom,
      type: f.schema?.type,
      items: f.schema?.items,
    }));
    if (query) {
      const q = query.toLowerCase();
      items = items.filter((f) => (f.id + ' ' + f.name).toLowerCase().includes(q));
    }
    return ok({ count: items.length, fields: items });
  })
);

server.registerTool(
  'jira_get_create_meta',
  {
    title: 'Get create metadata',
    description:
      'Discover fields for creating an issue. Without issueType, lists the project\'s issue types — pass one back to get its required/allowed fields (with field ids) for jira_create_issue.',
    inputSchema: {
      project: z.string().describe('Project key'),
      issueType: z.string().optional().describe('Issue type name — omit to just list the available types'),
    },
  },
  // ponytail: uses the split createmeta endpoint (Jira DC 8.4+ / Cloud); the classic /issue/createmeta?projectKeys was removed there.
  wrap(async ({ project, issueType }) => {
    const typesData = await jira.request(`issue/createmeta/${encodeURIComponent(project)}/issuetypes`, {
      query: { maxResults: 200 },
    });
    const types = (typesData.values || []).map((t) => ({ id: t.id, name: t.name, subtask: t.subtask }));
    if (!issueType) {
      return ok({ project, issueTypes: types, note: 'Pass issueType to get its fields.' });
    }
    const match = types.find((t) => t.name.toLowerCase() === issueType.toLowerCase());
    if (!match) throw new Error(`No issue type "${issueType}" in ${project}. Available: ${types.map((t) => t.name).join(', ')}`);
    const fieldsData = await jira.request(`issue/createmeta/${encodeURIComponent(project)}/issuetypes/${match.id}`, {
      query: { maxResults: 200 },
    });
    const fields = (fieldsData.values || []).map((f) => {
      const out = { key: f.fieldId, name: f.name, required: !!f.required, type: f.schema?.type };
      if (Array.isArray(f.allowedValues) && f.allowedValues.length) {
        out.allowedValues = f.allowedValues.slice(0, 50).map((v) => v.name || v.value || v.key || v.id);
        if (f.allowedValues.length > 50) out.allowedValuesTruncated = f.allowedValues.length;
      }
      return out;
    });
    return ok({ project, issueType: match.name, fields });
  })
);

server.registerTool(
  'jira_get_edit_meta',
  {
    title: 'Get edit metadata',
    description: 'Discover which fields can be edited on an existing issue, with allowed values. Mirror of jira_get_create_meta for updates.',
    inputSchema: { issueKey: z.string() },
  },
  wrap(async ({ issueKey }) => {
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/editmeta`);
    const fields = Object.entries(data.fields || {}).map(([key, f]) => {
      const out = { key, name: f.name, required: !!f.required, type: f.schema?.type, operations: f.operations };
      if (Array.isArray(f.allowedValues) && f.allowedValues.length) {
        out.allowedValues = f.allowedValues.slice(0, 50).map((v) => v.name || v.value || v.key || v.id);
        if (f.allowedValues.length > 50) out.allowedValuesTruncated = f.allowedValues.length;
      }
      return out;
    });
    return ok({ key: issueKey, fields });
  })
);

// ---------- agile: boards & sprints ----------
server.registerTool(
  'jira_list_boards',
  {
    title: 'List boards',
    description: 'List agile boards. Filter by project or name. Use a board id with jira_list_sprints.',
    inputSchema: {
      projectKeyOrId: z.string().optional(),
      name: z.string().optional().describe('Substring match on board name'),
      maxResults: z.number().int().positive().optional(),
    },
  },
  wrap(async ({ projectKeyOrId, name, maxResults }) => {
    const query = { maxResults: clampMax(maxResults) };
    if (projectKeyOrId) query.projectKeyOrId = projectKeyOrId;
    if (name) query.name = name;
    const data = await jira.request('board', { api: 'rest/agile/1.0', query });
    return ok({
      total: data.total,
      boards: (data.values || []).map((b) => ({ id: b.id, name: b.name, type: b.type })),
    });
  })
);

server.registerTool(
  'jira_list_sprints',
  {
    title: 'List sprints',
    description: 'List sprints on a board. Defaults to active+future (the "next sprint" lives here). Use a sprint id with jira_move_to_sprint.',
    inputSchema: {
      boardId: z.number().int().positive(),
      state: z.string().optional().describe('Comma list: active,future,closed. Default "active,future".'),
      maxResults: z.number().int().positive().optional(),
    },
  },
  wrap(async ({ boardId, state, maxResults }) => {
    const data = await jira.request(`board/${boardId}/sprint`, {
      api: 'rest/agile/1.0',
      query: { state: state || 'active,future', maxResults: clampMax(maxResults) },
    });
    return ok({
      total: data.total,
      sprints: (data.values || []).map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
        startDate: s.startDate,
        endDate: s.endDate,
      })),
    });
  })
);

server.registerTool(
  'jira_move_to_sprint',
  {
    title: 'Move issues to sprint',
    description: 'Move one or more issues into a sprint (by sprint id from jira_list_sprints).',
    inputSchema: { sprintId: z.number().int().positive(), issueKeys: z.array(z.string()).min(1) },
  },
  wrap(async ({ sprintId, issueKeys }) => {
    await jira.request(`sprint/${sprintId}/issue`, { api: 'rest/agile/1.0', method: 'POST', body: { issues: issueKeys } });
    return ok({ sprintId, moved: issueKeys });
  })
);

// ---------- assignable users ----------
server.registerTool(
  'jira_find_assignable_users',
  {
    title: 'Find assignable users',
    description:
      'Search users who can be ASSIGNED in a project (stricter than jira_find_users). Returns assignValue ready for jira_assign_issue / jira_create_issue.',
    inputSchema: {
      query: z.string().describe('Name/username/email fragment'),
      project: z.string().describe('Project key'),
      issueKey: z.string().optional().describe('Narrow to who can be assigned on this specific issue'),
      maxResults: z.number().int().positive().optional(),
    },
  },
  wrap(async ({ query, project, issueKey, maxResults }) => {
    const q = jira.authMode === 'basic' ? { query } : { username: query };
    const params = { ...q, project, maxResults: clampMax(maxResults) };
    if (issueKey) params.issueKey = issueKey;
    const data = await jira.request('user/assignable/search', { query: params });
    const users = (Array.isArray(data) ? data : []).map((u) => ({
      name: u.name,
      accountId: u.accountId,
      displayName: u.displayName,
      email: u.emailAddress,
      active: u.active,
      assignValue: jira.authMode === 'basic' ? u.accountId : u.name,
    }));
    return ok({ count: users.length, users });
  })
);

// ---------- remote links, link & issue deletion ----------
server.registerTool(
  'jira_remote_link',
  {
    title: 'Add remote link',
    description: 'Attach a remote/web link (e.g. a Confluence BRD page) to an issue — a real remote link, not a URL in the body.',
    inputSchema: {
      issueKey: z.string(),
      url: z.string().describe('Target URL'),
      title: z.string().describe('Link title shown on the issue'),
      summary: z.string().optional(),
    },
  },
  wrap(async ({ issueKey, url, title, summary }) => {
    const object = { url, title };
    if (summary) object.summary = summary;
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/remotelink`, { method: 'POST', body: { object } });
    return ok({ key: issueKey, id: data.id, url, title });
  })
);

server.registerTool(
  'jira_delete_issue_link',
  {
    title: 'Delete issue link',
    description: 'Remove an issue link by its id (find ids via jira_get_issue → issuelinks[].id).',
    inputSchema: { linkId: z.string() },
  },
  wrap(async ({ linkId }) => {
    await jira.request(`issueLink/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
    return ok({ deletedLinkId: linkId });
  })
);

server.registerTool(
  'jira_delete_issue',
  {
    title: 'Delete issue',
    description: 'Delete an issue. Destructive and irreversible. Set deleteSubtasks=true to also remove its subtasks (required by Jira if any exist).',
    inputSchema: {
      issueKey: z.string(),
      deleteSubtasks: z.boolean().optional(),
    },
  },
  wrap(async ({ issueKey, deleteSubtasks }) => {
    const query = deleteSubtasks === undefined ? undefined : { deleteSubtasks: String(deleteSubtasks) };
    await jira.request(`issue/${encodeURIComponent(issueKey)}`, { method: 'DELETE', query });
    return ok({ deleted: issueKey });
  })
);

// ---------- watchers list & comment edit/delete ----------
server.registerTool(
  'jira_list_watchers',
  {
    title: 'List watchers',
    description: 'List watchers on an issue.',
    inputSchema: { issueKey: z.string() },
  },
  wrap(async ({ issueKey }) => {
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/watchers`);
    return ok({
      watchCount: data.watchCount,
      watchers: (data.watchers || []).map((w) => ({ name: w.name, accountId: w.accountId, displayName: w.displayName })),
    });
  })
);

server.registerTool(
  'jira_update_comment',
  {
    title: 'Update comment',
    description: 'Edit an existing comment by id. Plain text is auto-wrapped to ADF on Cloud v3.',
    inputSchema: { issueKey: z.string(), commentId: z.string(), body: z.union([z.string(), z.record(z.any())]) },
  },
  wrap(async ({ issueKey, commentId, body }) => {
    const payload = { body: jira.needsADF() ? jira.toADF(body) : body };
    const data = await jira.request(`issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, {
      method: 'PUT',
      body: payload,
    });
    return ok({ id: data.id, updated: data.updated });
  })
);

server.registerTool(
  'jira_delete_comment',
  {
    title: 'Delete comment',
    description: 'Delete a comment by id.',
    inputSchema: { issueKey: z.string(), commentId: z.string() },
  },
  wrap(async ({ issueKey, commentId }) => {
    await jira.request(`issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
    return ok({ key: issueKey, deletedComment: commentId });
  })
);

// ---------- start ----------
async function main() {
  const transport = new StdioServerTransport();
  log('info', 'Starting ff-mcp-jira', { node: process.version });
  await server.connect(transport);
  log('info', 'Connected to MCP client over stdio');
}

main().catch((e) => {
  log('error', 'Server crashed', { msg: e.message, stack: e.stack });
  process.exit(1);
});
