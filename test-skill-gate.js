// node test-skill-gate.js — the ff-jira skill gate (stop once, resend passes, skill/bug/INF/Cloud untouched)
// JiraClient is built at import: give it a dummy host (the gate takes its host as an argument)
process.env.JIRA_BASE_URL ||= 'https://jira.example.test'; process.env.JIRA_API_TOKEN ||= 'stub';
import assert from 'node:assert/strict';
const { skillStop } = await import('./server.js');

const FF = 'https://jira.fintech-farm.com';
assert.match(skillStop(FF, 'AZ', 'Task', undefined, 'x'), /skill_required/);
assert.equal(skillStop(FF, 'AZ', 'Task', undefined, 'x'), null, 'identical resend passes');
assert.match(skillStop(FF, 'VN', 'Story', '', 'y'), /skill_required/);
assert.equal(skillStop(FF, 'AZ', 'Task', 'ff-jira', 'z'), null);
assert.equal(skillStop(FF, 'KG', 'Story', 'FF-BRD', 'z'), null);
assert.equal(skillStop(FF, 'AZ', 'Bug', undefined, 'z'), null);
assert.equal(skillStop(FF, 'INF', 'Task', undefined, 'z'), null);
assert.equal(skillStop('https://acme.atlassian.net', 'AZ', 'Task', undefined, 'z'), null, 'other Jira untouched');
console.log('skill gate OK');
