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
Use `warroom commit create --repo <id> --validate "<command>" --write-artifact` before a final commit when the repo needs a deterministic change summary, validation record, and local audit bundle.

## Campaign Map

TeamFloPay Project 1 is the Campaign Map. Current project statuses are `needs-triage`, `ready-to-engage`, `battlefield-active`, `skirmish`, `blockaded`, and `victory`.

Use `warroom campaign status-check` to validate board status options, `warroom campaign labels` to inspect matching repo labels, and `warroom campaign status --issue owner/repo#number --status <status> --confirm` to move an issue deliberately.

Workflow commands also understand the Campaign Map:

- `warroom issue next` reads `ready-to-engage` project items first.
- `warroom issue triage` reads `needs-triage` project items first.
- `warroom issue triage --mark-ready --confirm-status` moves work to `ready-to-engage`.
- `warroom pr engage --confirm-status` moves work to `battlefield-active`.
- `warroom pr review --issue ... --confirm-status` moves work to `skirmish`.
- `warroom pr merge --issue ... --confirm-status` moves work to `victory`.

`warroom pr review` handoffs include the PR body, changed files, latest reviews, comments, and check rollup so the launched adapter starts from scoped review context instead of only the PR description.

`warroom pr merge` handoffs include merge state, review decision, draft state, status checks, readiness blockers, and a generated victory summary. `--confirm` is still required for the merge itself. `--post-summary --confirm-summary` is required before War Room posts victory summary comments to GitHub. `--confirm-status` moves the linked issue to `victory` only when the merge-readiness preflight is clear.

`warroom commit create` summarizes changed files, runs requested validation commands from the owning child repo, and writes ignored run artifacts when `--write-artifact` is present. A confirmed commit is still gated by `--confirm`; staging all files is gated separately by `--all`.

## Recovery

`warroom abort --print-recovery` is the first command to run when a multi-repo operation becomes unclear. It prints repo state and recovery commands without mutation.
