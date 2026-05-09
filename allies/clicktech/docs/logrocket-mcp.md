# ClickTech LogRocket MCP

## Scope

ClickTech LogRocket access must be configured as a client-scoped MCP server named `logrocket-clicktech`.

Use the narrowest LogRocket MCP URL that works for the task:

```sh
https://mcp.logrocket.com/mcp/<org>
https://mcp.logrocket.com/mcp/<org>/<project>
```

Do not configure the unscoped base URL for ClickTech work.

## Local Environment

Keep concrete IDs and secrets in `allies/clicktech/.env.local`:

```sh
LOGROCKET_ORG_ID=
LOGROCKET_PROJECT_ID=
LOGROCKET_MCP_URL=
LOGROCKET_API_KEY=
```

Prefer `LOGROCKET_ORG_ID` plus `LOGROCKET_PROJECT_ID`; `LOGROCKET_MCP_URL` is only for an explicit fully scoped override. `LOGROCKET_API_KEY` is optional and should only be used when OAuth is not practical for the workflow.

LogRocket organization and project IDs are visible in most LogRocket app URLs and in the App ID under Settings > Project Settings. API keys are project-scoped and can be created under Settings > API Keys.

## Setup

From `allies/clicktech`:

```sh
scripts/setup-logrocket-mcp.sh
```

The helper reads `.env.local`, refuses an unscoped LogRocket MCP URL, and configures the local MCP server name `logrocket-clicktech` for both Codex and Claude Code when those CLIs are installed.

Codex OAuth setup:

```sh
scripts/setup-logrocket-mcp.sh --codex
codex mcp login logrocket-clicktech
codex mcp list
```

Codex API-key setup:

```sh
scripts/setup-logrocket-mcp.sh --codex
```

When `LOGROCKET_API_KEY` is set, Codex is configured with `--bearer-token-env-var LOGROCKET_API_KEY`. Direct Codex sessions must inherit that environment variable; War Room adapter launches load ally `.env.local` values.

Claude Code OAuth setup:

```sh
scripts/setup-logrocket-mcp.sh --claude
claude
/mcp
```

Claude Code stores this as a local project MCP server, not a committed project `.mcp.json`, because the ClickTech scope and credentials are client-specific. If an API key is required for Claude Code, add it manually as a local header only:

```sh
claude mcp add --scope local --transport http logrocket-clicktech "$LOGROCKET_MCP_URL" --header "Authorization: Bearer <api-key>"
```

## Use

When investigating a ClickTech issue, ask the agent to use `logrocket-clicktech` for session, issue, and metric context, then summarize findings back into the ClickTech issue boundary without copying raw session data, production data, credentials, or client PII into git.
