# ClickTech Ally Workspace

ClickTech is an enterprise ally workspace. War Room keeps safe shared operating context here and keeps client secrets, local checkouts, and scratch work out of git.

## Layout

```text
allies/clicktech/
  README.md
  .env.local.example
  .env.local
  docs/
  scripts/
  repos/
  workspace/
```

- `README.md` and `docs/*` are committed shared context for the Flo team.
- `scripts/*` are committed local helpers for ClickTech-specific tool setup.
- `.env.local.example` is a committed template with safe placeholders only.
- `.env.local` is ignored and holds ClickTech-specific local secrets such as Stripe keys.
- `repos/*` is ignored and reserved for client issue repo checkouts such as `TeamFloPay/ally-clicktech`.
- `workspace/*` is ignored local scratch space for client-specific work that should not be shared.

## Environment

ClickTech Stripe keys belong in `allies/clicktech/.env.local`.

Existing consumers may expect these aliases:

```sh
STRIPE_USD=
STRIPE_GBP=
STRIPE_EUR=
```

STRIPE_USD is related to account: acct_1SLgSaCr7M3f6cXu
STRIPE_GBP is related to account: acct_1QP3UVCZdfjaOnwJ
STRIPE_EUR is related to account: acct_1SKy9rELRd0GNEUW



When adding new Stripe accounts, prefer account-specific names only after the consuming workflow is clear:

```sh
STRIPE_ACCOUNT_SAFE_ALIAS_SECRET_KEY=
```

Do not commit real keys, account IDs, private endpoints, exports, production data, or client PII.

## LogRocket MCP

ClickTech LogRocket MCP setup is documented in `docs/logrocket-mcp.md`.

Use the local helper after adding a ClickTech-scoped LogRocket org/project to `.env.local`:

```sh
scripts/setup-logrocket-mcp.sh
```

This configures the MCP server name `logrocket-clicktech` for Codex and Claude Code when those CLIs are installed. The helper refuses the unscoped LogRocket MCP base URL.

## Issue Tracking

Client issue sync is documented in `docs/issue-sync.md`. The planned sync boundary is `TeamFloPay/ally-clicktech`, linked with ClickTech Jira through Unito.

The issue repo carries Campaign Map workflow labels plus `ally` and `clicktech`, but it stays out of core `repos.yaml`.

Run the local status check from War Room:

```sh
npm run warroom -- allies status
```
