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
```

`issue next` prompts for a ready issue in an interactive terminal, moves the selected issue to `battlefield-active`, and launches the implementation handoff for that selection. Use `--dry-run` to preview without launching or moving Campaign Map status.
Use `warroom commit create --repo <id> --validate "<command>" --write-artifact` before a final commit when the repo needs a deterministic change summary, validation record, and local audit bundle.
Use `warroom maps assign --repo <id>` with framework/domain/resource flags for reviewed specialist-context edits; pass `--write` only after checking the dry-run messages.

## Campaign Map

TeamFloPay Project 1 is the Campaign Map. Current project statuses are `needs-triage`, `ready-to-engage`, `battlefield-active`, `skirmish`, `blockaded`, and `victory`.

Use `warroom campaign status-check` to validate board status options, `warroom campaign labels` to inspect matching repo labels, and `warroom campaign status --issue owner/repo#number --status <status> --confirm` to move an issue deliberately.

Workflow commands also understand the Campaign Map:

- `warroom issue next` reads `ready-to-engage` project items first, then can select one for implementation and move it to `battlefield-active`.
- `warroom issue triage` reads `needs-triage` project items first.
- `warroom issue triage --mark-ready --confirm-status` moves work to `ready-to-engage`.
- `warroom pr engage --confirm-status` moves work to `battlefield-active`.
- `warroom pr review --issue ... --confirm-status` moves work to `skirmish`.
- `warroom pr merge --issue ... --confirm-status` moves work to `victory`.

`warroom pr review` without `--pr` lists open PRs linked from issues in the `battlefield-active` and `skirmish` columns, ordered by latest PR update. `warroom pr review --pr ...` handoffs include the PR body, changed files, latest reviews, comments, and check rollup so the launched adapter starts from scoped review context instead of only the PR description.
The handoff also includes the assigned Sergeant, repo-specific frameworks/domains, allowed resources, context size, outcome-marker guidance, and the default 60-minute check-in loop.

`warroom pr merge` handoffs include merge state, GitHub mergeability, review decision, requested reviewers, unresolved review threads, draft state, status checks, readiness blocker explanations, the repo-specific demo e2e gate decision from `merge_playwright`, and a generated victory summary. If `--pr` is omitted, War Room infers the PR from the current mapped child repo branch by finding the single open GitHub PR for that branch. In an interactive terminal without `--confirm`, War Room prints the preflight and asks whether to continue into the confirmed merge path. `--confirm` or a yes answer rechecks merge readiness. For repos with `merge_playwright: true`, War Room then checks whether `https://api.local.flopay.com/v1/health` is already running; if so War Room reuses that backend and leaves it running. If not, War Room starts the mapped backend with `npm run start:api`, waits for the health endpoint, runs the full demo `npm run test:e2e` Playwright suite from the mapped demo repo, and stops only the backend process it started. The confirmed run prints backend readiness progress and streams the Playwright command output so the terminal shows test progress and results. Those repos are not merged unless all demo e2e tests pass. Repos with `merge_playwright: false` skip the backend/demo Playwright gate. If required gates pass, War Room runs `gh pr merge --squash --delete-branch`. After a successful interactive confirmed merge, War Room prompts for victory summary posting and then prompts for local checkout cleanup. Pass `--post-summary --confirm-summary` or `--cleanup-local --confirm-cleanup` to perform those follow-up actions without prompting. `--confirm-status` moves the linked issue to `victory` only when the merge-readiness preflight is clear.

The backend readiness probe uses a direct GET with a short per-request timeout. Local HTTPS certificates are accepted by default for `localhost`, loopback, and `*.local.flopay.com`; set `WARROOM_MERGE_BACKEND_STRICT_TLS=true` to require a trusted certificate, or tune the per-probe timeout with `WARROOM_MERGE_BACKEND_READY_PROBE_TIMEOUT_MS`. When the demo e2e run targets a local HTTPS backend, War Room passes `NODE_OPTIONS=--use-system-ca` to the Playwright process so the demo web server can trust locally installed development certificates. Set `WARROOM_MERGE_DEMO_USE_SYSTEM_CA=false` to disable that flag.

`warroom commit create` summarizes changed files, runs requested validation commands from the owning child repo, and writes ignored run artifacts when `--write-artifact` is present. Interactive runs print the dry run first and then ask before committing and pushing; non-interactive commits still require `--confirm`. If unstaged files are present, the interactive prompt explicitly confirms `git add -A`. Confirmed commits push to the current upstream, or to `origin` with upstream setup when the branch has no upstream. Use `--no-push` only for intentional local-only commits.

## Recovery

`warroom abort --print-recovery` is the first command to run when a multi-repo operation becomes unclear. It prints repo state and recovery commands without mutation. `--stash --confirm` is the preferred mutation when work should be preserved; `--danger-reset --confirm-danger "discard local work"` exists only as a last-resort local discard path.
