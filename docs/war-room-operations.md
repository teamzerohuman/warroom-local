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

`issue next` prompts for a ready issue in an interactive terminal, creates and checks out a GitHub-linked development branch with `gh issue develop --checkout`, moves the selected issue to `battlefield-active`, and launches the implementation handoff for that selection in the owning child repo. The mapped checkout must be clean before launch. From a mapped child repo checkout, it lists only that repo's ready issues by default; use `--all` to show the cross-repo queue. The command ends with an explicit `Outcome:` line for launched, dry-run, blocked, and not-started cases. Use `--dry-run` to preview without creating the branch, launching, or moving Campaign Map status.
Use `warroom commit create --repo <id> --validate "<command>" --write-artifact` before a final commit when the repo needs a deterministic change summary, validation record, and local audit bundle.
Use `warroom maps assign --repo <id>` with framework/domain/resource flags for reviewed specialist-context edits; pass `--write` only after checking the dry-run messages.

## Campaign Map

TeamFloPay Project 1 is the Campaign Map. Current project statuses are `needs-triage`, `ready-to-engage`, `battlefield-active`, `skirmish`, `blockaded`, and `victory`.

Use `warroom campaign status-check` to validate board status options, `warroom campaign labels` to inspect matching repo labels, and `warroom campaign status --issue owner/repo#number --status <status> --confirm` to move an issue deliberately.

Workflow commands also understand the Campaign Map:

- `warroom issue next` reads `ready-to-engage` project items first, then can select one for implementation, create the linked development branch, and move it to `battlefield-active`.
- `warroom issue triage` reads `needs-triage` project items first and can select one interactively to launch a planning-only triage handoff in the Codex TUI. The handoff may post triage notes back to the GitHub issue, but must not implement code. Ally issue repos are resolved through `allies.yaml` when they are not mapped in `repos.yaml`.
- `warroom issue triage --mark-ready --confirm-status` moves work to `ready-to-engage`.
- `warroom issue next --issue ... --confirm-status` moves work to `battlefield-active`.
- `warroom pr create --confirm --confirm-status` moves work to `skirmish` after publishing the PR.
- `warroom pr review --issue ... --confirm-status` moves work to `skirmish`.
- `warroom pr merge --issue ... --confirm-status` moves work to `victory`.

`warroom pr create` previews the PR title/body and branch push by default. Unless title/body flags are supplied, the preview asks the LLM adapter to draft PR text from the actual branch commits and diff. Large diffs are summarized through multiple adapter chunk calls before the final title/body prompt, so the final prompt has full diff coverage without a clipped patch. It falls back to a local issue/commit summary if adapter drafting fails. In an interactive terminal, the preflight asks whether to continue; a yes answer reuses the previewed PR text and runs the same confirmed path as `--confirm`. Successful confirmed creation prints the GitHub PR URL as the final line, while blocked or declined runs print a clear not-created outcome.

`warroom pr review` without `--pr` lists open PRs linked from issues in the `battlefield-active` and `skirmish` columns, ordered by latest PR update. If that queue is empty and the command is run inside a mapped child repo branch with a single open PR, it falls back to that current-branch PR. In an interactive terminal it confirms the single detected PR or asks for a numbered selection, then launches the selected review handoff as if `--pr <owner/repo#number> --launch` was passed. Non-interactive current-branch fallback runs print the PR review preflight. `warroom pr review --pr ... --launch` sends a fixed GitHub/CodeRabbit handoff that tells the adapter to analyze the latest CodeRabbit feedback on the latest PR commit, optionally mark each comment with eyes while working, reply to the review thread with `Change made:` or `Skipped:`, and commit the changes. The handoff includes the current CodeRabbit review-thread IDs and the GitHub thread-reply mutation to avoid relying on CodeRabbit auto-resolution alone. The eyes reaction is best-effort and must not block code fixes; final thread replies are required. The review loop uses the same foreground terminal adapter as other handoffs so it has local GitHub/CodeRabbit app access, `gh` auth, and a working PR branch remote. The CLI owns the loop: it logs each stage, waits for a new PR commit, waits for CodeRabbit to appear and settle on that commit, checks current unresolved CodeRabbit comments, verifies final replies on handled CodeRabbit threads, and relaunches the adapter while CodeRabbit feedback remains. Direct PR review handoffs end with an `Outcome:` line for completed, preflight-only, or blocked loops.
The loop defaults can be tuned with `WARROOM_PR_REVIEW_MAX_LOOPS`, `WARROOM_PR_REVIEW_COMMIT_TIMEOUT_MS`, `WARROOM_PR_REVIEW_CODERABBIT_TIMEOUT_MS`, `WARROOM_PR_REVIEW_CODERABBIT_SETTLE_MS`, and `WARROOM_PR_REVIEW_POLL_MS`.

`warroom pr merge` handoffs include merge state, GitHub mergeability, review decision, requested reviewers, unresolved review threads, draft state, status checks, readiness blocker explanations, the repo-specific merge gate decisions from `merge.playwright` and `merge.changelog`, and a generated victory summary. If `--pr` is omitted, War Room infers the PR from the current mapped child repo branch by finding the single open GitHub PR for that branch. In an interactive terminal without `--confirm`, War Room prints the preflight and asks whether to continue into the confirmed merge path. On a blocked preflight, type `skip` to allow unresolved review threads if no other blockers remain. On a clear preflight, type `skip` to continue while skipping the demo Playwright gate. `--confirm`, a yes answer, or either interactive skip choice rechecks merge readiness. For repos with `merge.playwright: true`, War Room then checks whether `https://api.local.flopay.com/v1/health` is already running; if so War Room reuses that backend and leaves it running. If not, War Room starts the mapped backend with `npm run start:api`, waits for the health endpoint, runs the full demo `npm run test:e2e` Playwright suite from the mapped demo repo, and stops only the backend process it started. The confirmed run prints backend readiness progress and streams the Playwright command output so the terminal shows test progress and results unless the clear-preflight skip choice was used. Those repos are not merged unless all demo e2e tests pass or the clear-preflight skip choice was used. Repos with `merge.playwright: false` skip the backend/demo Playwright gate. If pre-merge gates pass, War Room runs `gh pr merge --squash --delete-branch`. For repos with `merge.changelog: true`, War Room then waits for GitHub Actions on the base branch, pulls the latest base branch release/version files, uses the foreground LLM adapter to edit only `CHANGELOG.md`, and pushes a `[skip-ci]` changelog commit to the base branch. After a successful interactive confirmed merge, War Room prompts for victory summary posting and then prompts for local checkout cleanup, which switches to the PR base branch and pulls it with `git pull --ff-only`. Pass `--post-summary --confirm-summary` or `--cleanup-local --confirm-cleanup` to perform those follow-up actions without prompting. `--confirm-status` moves the linked issue to `victory` only when the merge-readiness preflight is clear.

The backend readiness probe uses a direct GET with a short per-request timeout. Local HTTPS certificates are accepted by default for `localhost`, loopback, and `*.local.flopay.com`; set `WARROOM_MERGE_BACKEND_STRICT_TLS=true` to require a trusted certificate, or tune the per-probe timeout with `WARROOM_MERGE_BACKEND_READY_PROBE_TIMEOUT_MS`. When the demo e2e run targets a local HTTPS backend, War Room passes `NODE_OPTIONS=--use-system-ca` to the Playwright process so the demo web server can trust locally installed development certificates. Set `WARROOM_MERGE_DEMO_USE_SYSTEM_CA=false` to disable that flag.

The changelog gate waits for GitHub Actions using `gh run list` on the PR base branch. Tune it with `WARROOM_MERGE_CHANGELOG_ACTIONS_TIMEOUT_MS`, `WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS`, and `WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS` when release workflows need more time to publish version files.

`warroom commit create` summarizes changed files, runs requested validation commands from the owning child repo, and writes ignored run artifacts when `--write-artifact` is present. Interactive runs print the dry run first and then ask before committing and pushing; after a successful commit they ask whether to run `warroom pr create` next. Non-interactive commits still require `--confirm`. If unstaged files are present, the interactive prompt explicitly confirms `git add -A`. Confirmed commits push to the current upstream, or to `origin` with upstream setup when the branch has no upstream. Use `--no-push` only for intentional local-only commits.

## Recovery

`warroom abort --print-recovery` is the first command to run when a multi-repo operation becomes unclear. It prints repo state and recovery commands without mutation. `--stash --confirm` is the preferred mutation when work should be preserved; `--danger-reset --confirm-danger "discard local work"` exists only as a last-resort local discard path.
