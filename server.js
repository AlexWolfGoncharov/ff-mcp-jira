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
      'Create an issue. Always pass `project` (key) and `issueType` (name). Optional fields (labels, components, fixVersions, customfield_*, etc.) go through `fields`. `description` accepts plain text and is auto-converted to ADF on Cloud v3.',
    inputSchema: {
      project: z.string(),
      issueType: z.string(),
      summary: z.string(),
      description: z.union([z.string(), z.record(z.any())]).optional(),
      assignee: z.string().optional().describe('username (Server) or accountId (Cloud)'),
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
      'Update an issue. Pass `fields` for absolute values OR `update` for ops (`add`/`remove`/`set`). Convenience shortcuts: `labels`, `assignee`, `priority`, `summary`, `description`.',
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
