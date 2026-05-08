# Company Brain Plugin Tools

This plugin exposes Company Brain only through explicit Cortex HTTP tools. It
does not inject generic always-on Company Brain memory and it does not read or
write shared MCP/plugin storage.

## Tools

| tool | purpose |
|------|---------|
| `company_brain_accounts_list` | Resolve stable account and workspace IDs. |
| `company_brain_account_brief` | Fetch source-backed account facts, contacts, open loops, follow-ups, and blockers. |
| `company_brain_account_timeline` | Fetch artifact and claim events with timeline pagination. |
| `company_brain_query` | Ask narrow pilot questions such as `what_changed`, `follow_ups`, `blocked`, and `daily_brief`. |

The raw Cortex JSON response is returned as tool text so downstream agents keep
`citations`, `verification_status`, `requires_approval`, `action_readiness`,
pagination fields, and `insufficient_evidence` intact.

## Owner Handling

The tools call `/api/v1/company-brain/*` on the configured `cortexUrl`. The
configured `ownerId` is sent only as an explicit owner-bound selector for
self-hosted installs and owner-bound API-key deployments. Hosted Cortex remains
authoritative: non-admin/JWT callers cannot override the authenticated owner.

Agents should call `company_brain_accounts_list` before account brief, timeline,
or query tools. Do not flatten Company Brain account context into generic
personal memory. Treat `insufficient_evidence` as a successful honest response,
not as a tool failure.

## Canary

Run the live canary against a local or staged Cortex endpoint:

```bash
CORTEX_URL=http://localhost:8000 \
CORTEX_API_KEY=... \
CORTEX_OWNER_ID=company-acme \
COMPANY_BRAIN_ACCOUNT_ID=optional-account-id \
npm run company-brain:canary
```

If `COMPANY_BRAIN_ACCOUNT_ID` is omitted, the canary lists accounts and uses the
first returned account when one exists. A tenant with no accounts is accepted as
a route/auth smoke pass for the account-list stage.
