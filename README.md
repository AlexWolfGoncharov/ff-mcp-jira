# ff-mcp-jira

A reliable [Model Context Protocol](https://modelcontextprotocol.io) server for **Jira Server / Data Center / Atlassian Cloud**.

Drop-in replacement for the unmaintained `mcp-jira@0.1.0` with the bugs that make Claude trip over Jira:

| Old `mcp-jira@0.1.0` problem | What this package does |
| --- | --- |
| `JIRA API error: 400` — body swallowed | Throws **status + full Jira error body** so the model can self-correct |
| `update_issue` accepts only 4 hardcoded fields | Generic `fields` and `update` passthrough — set labels, components, fixVersions, customfield_*, anything |
| No `add_labels` / `remove_labels` | Dedicated tools for label add/remove without overwrites |
| No `list_transitions` | You can finally call `transition_issue` by name without guessing IDs |
| No subtask / link / worklog / watcher / attach | All covered |
| Search returns megabytes — exceeds token budgets | Lean default `fields`, default `maxResults=25`, hard cap 100 |
| Bearer auth hardcoded — breaks Cloud | Auto-detects Cloud vs Server, Basic for Cloud, Bearer (PAT) for Server |
| `/rest/api/2` hardcoded — no ADF on Cloud | v2 or v3 per deployment, auto-wraps text to ADF on Cloud v3 |
| No retries, no timeouts | 30s timeout + exponential backoff on 429/502/503/504 |

## Install

### Via npx (no install)

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%/Claude/claude_desktop_config.json` on Windows) or Claude Code config:

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "ff-mcp-jira"],
      "env": {
        "JIRA_BASE_URL": "https://your-jira.example.com",
        "JIRA_API_TOKEN": "your-personal-access-token",
        "JIRA_USERNAME": "you@example.com"
      }
    }
  }
}
```

Restart Claude Desktop (⌘Q, then reopen) — the `jira_*` tools appear in the next conversation.

### Local install

```bash
npm install -g ff-mcp-jira
ff-mcp-jira
```

## Auth

| Deployment | `JIRA_API_TOKEN` is | `JIRA_USERNAME` / `JIRA_EMAIL` |
| --- | --- | --- |
| **Jira Server / Data Center** | Personal Access Token (from your profile → Personal Access Tokens) | Optional, ignored for auth |
| **Atlassian Cloud** (`*.atlassian.net`) | API token from `https://id.atlassian.com/manage-profile/security/api-tokens` | Required (your account email) |

The auth mode is auto-detected from the hostname. Force it with `JIRA_AUTH_MODE=basic` or `JIRA_AUTH_MODE=bearer` if needed.

## Tools (23)

| Tool | Purpose |
| --- | --- |
| `jira_get_myself` | Auth smoke test — returns current user |
| `jira_search` | JQL search with lean default `fields` and 25-result cap |
| `jira_get_issue` | Fetch one issue with configurable fields/expand |
| `jira_create_issue` | Create issue. Generic `fields` passthrough for any custom field |
| `jira_update_issue` | Update issue. Generic `fields` + `update` ops. Convenience args for summary, description, assignee, priority, labels |
| `jira_add_labels` / `jira_remove_labels` | Add/remove labels without overwriting |
| `jira_list_transitions` | List available workflow transitions |
| `jira_transition_issue` | Transition by id or by name (case-insensitive) |
| `jira_add_comment` / `jira_list_comments` | Comments — ADF auto-wrapping on Cloud v3 |
| `jira_assign_issue` | Set / clear / auto-assign |
| `jira_create_subtask` | Subtask under a parent (auto-detects parent's project) |
| `jira_link_issues` / `jira_list_link_types` | Issue linking |
| `jira_add_watcher` / `jira_remove_watcher` | Watchers |
| `jira_log_work` / `jira_list_worklogs` | Worklog |
| `jira_list_projects` / `jira_list_issue_types` | Discovery |
| `jira_attach_file` | Upload a local file |
| `jira_raw_request` | Escape hatch — any Jira REST call |

## Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `JIRA_BASE_URL` | yes | e.g. `https://jira.example.com` or `https://you.atlassian.net` |
| `JIRA_API_TOKEN` | yes | PAT (Server) or API token (Cloud) |
| `JIRA_EMAIL` / `JIRA_USERNAME` | Cloud only | Account email — required when auth mode is Basic |
| `JIRA_AUTH_MODE` | no | `bearer` (Server, default) or `basic` (Cloud, auto-detected for `*.atlassian.net`) |
| `JIRA_API_VERSION` | no | `2` (Server) or `3` (Cloud) — auto-detected |
| `JIRA_TIMEOUT_MS` | no | default 30000 |
| `JIRA_MAX_RETRIES` | no | default 2 — retries on 429/502/503/504 |
| `JIRA_LOG_LEVEL` | no | `debug` / `info` / `warn` / `error` (stderr only — stdout is reserved for MCP) |

## Development

```bash
git clone https://github.com/AlexWolfGoncharov/ff-mcp-jira
cd ff-mcp-jira
npm install
cp .env.example .env  # fill in your creds, then `set -a; source .env; set +a`
node smoke.js
```

`smoke.js` exercises auth, search, get/transitions/comments/labels round-trip, list_link_types, list_projects, and verifies that errors include the full Jira response body.

## License

MIT
