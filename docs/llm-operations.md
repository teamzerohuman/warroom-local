# LLM Operations

War Room launches LLM adapters only when a command is explicitly given `--launch`. Without that flag, issue and PR commands print scoped prompts and can write local artifacts under `.warroom/runs/*`.

## Configuration

`.env.example` documents safe placeholders:

```sh
LLM_ADAPTER=codex
CODEX_COMMAND=codex
CLAUDE_COMMAND=claude
```

Real provider keys and local secrets belong in `.env.local`, the developer's configured MCP/tool environment, or an approved secret manager. They are never committed.

## Handoff Rules

- Include the selected issue or PR, relevant metadata, repo ownership, and validation requirements.
- Include only scoped context; do not dump whole repos by default.
- Preserve child repo boundaries and read child `AGENTS.md` before product edits.
- Pause when context is too large, feedback is circular, or the owner repo is ambiguous.

## Dry Run Examples

```sh
npm run warroom -- issue triage --issue TeamFloPay/infra#4 --write-artifact
npm run warroom -- pr engage --issue TeamFloPay/infra#4 --write-artifact
npm run warroom -- pr review --pr TeamFloPay/warroom#1 --write-artifact
npm run warroom -- pr merge --pr TeamFloPay/warroom#1 --issue TeamFloPay/infra#4 --write-artifact
```

Artifacts are local audit/debug files. GitHub comments should contain useful summaries, not local artifact paths.
