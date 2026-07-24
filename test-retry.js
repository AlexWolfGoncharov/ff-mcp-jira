#!/usr/bin/env node
// Unit check for the idempotency-gated retry (the KG-24237..41 duplicate root cause).
// No network: global.fetch is mocked. Run: node test-retry.js
process.env.JIRA_BASE_URL = 'https://jira.example.com';
process.env.JIRA_API_TOKEN = 'dummy';
process.env.JIRA_MAX_RETRIES = '2';
process.env.JIRA_LOG_LEVEL = 'error';

import assert from 'node:assert';
const { JiraClient, JiraWriteUncertain } = await import('./server.js');

const jsonRes = (obj) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: new Map([['content-type', 'application/json']]),
  text: async () => JSON.stringify(obj),
});

const c = new JiraClient();
let calls;

// 1) Non-idempotent write that fails on the network → exactly ONE POST, distinguishable error.
calls = 0;
global.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
await assert.rejects(
  c.request('issue', { method: 'POST', body: { fields: {} } }),
  (e) => e instanceof JiraWriteUncertain && e.code === 'WRITE_OUTCOME_UNKNOWN',
  'a write network error must throw JiraWriteUncertain'
);
assert.equal(calls, 1, `write must NOT retry (got ${calls} POSTs — this is the duplicate bug)`);

// 2) Idempotent GET fails once then succeeds → it retries.
calls = 0;
global.fetch = async () => { calls++; if (calls === 1) throw new TypeError('fetch failed'); return jsonRes({ ok: true }); };
await c.request('myself', { method: 'GET' });
assert.equal(calls, 2, `GET should retry on a network blip (got ${calls})`);

// 3) Search (read-only POST, idempotent:true) also retries — must NOT regress into fail-fast.
calls = 0;
global.fetch = async () => { calls++; if (calls === 1) throw new TypeError('fetch failed'); return jsonRes({ issues: [], total: 0 }); };
await c.request('search', { method: 'POST', body: {}, idempotent: true });
assert.equal(calls, 2, `idempotent POST (search) should retry (got ${calls})`);

console.log('OK — writes fail fast (no dup), reads + search retry');
