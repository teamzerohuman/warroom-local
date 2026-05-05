# War Room Operations

War Room coordinates the campaign; child repositories own the code.

## Boundaries

- `repos.yaml` is the machine-readable map for child repos, ownership, local paths, Sergeant assignments, and resource allowlists.
- `resources.yaml` is the registry for logical Skills, MCPs, APIs, docs, and third-party resources. It contains no secrets.
- `maps/campaign-atlas.md` is generated from the manifests while preserving protected hand-written notes blocks.
- `maps/repos/*`, `.warroom/runs/*`, and `.warroom/dev/*` are local-only ignored paths.

## Normal Loop

```sh
npm run warroom -- doctor
npm run warroom -- sync --report
npm run warroom -- issue next
npm run warroom -- pr engage --issue TeamFloPay/infra#4
```

Use `--launch` only when ready to hand the scoped prompt to the configured LLM adapter.
Use `--confirm-status` only when ready to mutate the Campaign Map state for the selected issue.

## Campaign Map

TeamFloPay Project 1 is the Campaign Map. Current project statuses are `needs-triage`, `ready-to-engage`, `battlefield-active`, `skirmish`, `blockaded`, and `victory`.

Use `warroom campaign status-check` to validate board status options, `warroom campaign labels` to inspect matching repo labels, and `warroom campaign status --issue owner/repo#number --status <status> --confirm` to move an issue deliberately.

Workflow commands also understand the Campaign Map:

- `warroom issue next` reads `ready-to-engage` project items first.
- `warroom issue triage --mark-ready --confirm-status` moves work to `ready-to-engage`.
- `warroom pr engage --confirm-status` moves work to `battlefield-active`.
- `warroom pr review --issue ... --confirm-status` moves work to `skirmish`.
- `warroom pr merge --issue ... --confirm-status` moves work to `victory`.

## Recovery

`warroom abort --print-recovery` is the first command to run when a multi-repo operation becomes unclear. It prints repo state and recovery commands without mutation.
