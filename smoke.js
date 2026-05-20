#!/usr/bin/env node
// Spawns ./server.js, talks MCP over stdio, and exercises the main tools.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
let id = 0;

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error('non-json line:', line); continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

function send(method, params) {
  const reqId = ++id;
  const req = { jsonrpc: '2.0', id: reqId, method, params };
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    child.stdin.write(JSON.stringify(req) + '\n');
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        reject(new Error(`timeout for ${method}`));
      }
    }, 30000);
  });
}

function notify(method, params) {
  const req = { jsonrpc: '2.0', method, params };
  child.stdin.write(JSON.stringify(req) + '\n');
}

function call(name, args) {
  return send('tools/call', { name, arguments: args });
}

function show(label, r) {
  const txt = r?.content?.[0]?.text || JSON.stringify(r);
  const trimmed = txt.length > 600 ? txt.slice(0, 600) + '...[truncated]' : txt;
  console.error(`\n--- ${label}${r?.isError ? ' (ERROR)' : ''} ---\n${trimmed}`);
}

(async () => {
  try {
    const init = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    });
    console.error('initialized:', init.serverInfo);
    notify('notifications/initialized', {});

    const tools = await send('tools/list', {});
    console.error(`tools advertised: ${tools.tools.length}`);

    show('jira_get_myself', await call('jira_get_myself', {}));

    const search = await call('jira_search', {
      jql: 'assignee = currentUser() ORDER BY updated DESC',
      maxResults: 3,
    });
    show('jira_search (lean)', search);
    let firstKey = null;
    try {
      const parsed = JSON.parse(search.content[0].text);
      firstKey = parsed.issues?.[0]?.key;
    } catch {}

    if (firstKey) {
      show(`jira_get_issue ${firstKey}`, await call('jira_get_issue', { issueKey: firstKey }));
      show(`jira_list_transitions ${firstKey}`, await call('jira_list_transitions', { issueKey: firstKey }));
      show(`jira_list_comments ${firstKey}`, await call('jira_list_comments', { issueKey: firstKey, maxResults: 3 }));

      // label round-trip on the user's own issue (safe: adds + removes a unique label)
      const tag = `smoke-${Date.now()}`;
      show(`jira_add_labels ${tag}`, await call('jira_add_labels', { issueKey: firstKey, labels: [tag] }));
      show(`jira_remove_labels ${tag}`, await call('jira_remove_labels', { issueKey: firstKey, labels: [tag] }));
    } else {
      console.error('No issue assigned to current user — skipping issue-scoped tests.');
    }

    show('jira_list_link_types', await call('jira_list_link_types', {}));
    show('jira_list_projects (sample)', await call('jira_list_projects', {}));

    // error reporting test: force a 404
    show('jira_get_issue NOPE-1 (should ERROR with body)', await call('jira_get_issue', { issueKey: 'NOPE-1' }));

    console.error('\n=== smoke PASS ===');
    child.kill('SIGTERM');
    process.exit(0);
  } catch (e) {
    console.error('smoke FAIL:', e.message);
    child.kill('SIGTERM');
    process.exit(1);
  }
})();
