# Command Reference

The War Room CLI is a local accelerator for cross-repo work. Human-readable output is the default; core commands support `--json` for agents and tests.

## Available

```sh
warroom --help
warroom doctor
warroom bootstrap --dry-run
warroom bootstrap --dry-run --write-proposals
warroom sync --report
warroom campaign status-check
warroom campaign labels
warroom campaign status --issue TeamFloPay/infra#4 --status battlefield-active
warroom allies status
warroom maps study
warroom maps assign --check
warroom maps assign --repo sdk --add-framework TypeScript --add-resource github-cli
warroom issue triage
warroom issue triage --issue TeamFloPay/infra#4 --dry-run --mark-ready --write-artifact
warroom issue next
warroom issue next --dry-run
warroom issue next --issue TeamFloPay/infra#4 --base main
warroom issue create
warroom issue fortify
warroom pr create
warroom pr create --branch warroom/4-example --base main --confirm
warroom pr review
warroom pr review --pr TeamFloPay/warroom#1 --issue TeamFloPay/infra#4 --dry-run
warroom pr merge
warroom pr merge --pr TeamFloPay/warroom#1 --issue TeamFloPay/infra#4 --write-artifact
warroom commit create
warroom commit create --repo sdk --validate "npm test" --write-artifact
warroom abort --print-recovery
warroom dev status
warroom dev link
warroom dev unlink
```

Namespace and command help support `--help`; the executable also normalizes `-help` for operator muscle memory:

```sh
warroom maps -help
warroom pr review --help
```

After `npm run link:global`, `warroom` can be run from the War Room checkout or from mapped child checkouts. Workspace discovery checks the current directory, parent directories, sibling `warroom` directories, and finally `WARROOM_ROOT`.

## Safety Defaults

- `bootstrap --dry-run` previews clone actions and inferred resource/allowlist proposals. Without `--dry-run`, missing active repos are cloned under ignored `maps/repos/*`. Resource proposal writes require `--write-proposals --confirm`.
- `sync --report` does not fetch or pull. Without `--report`, sync skips dirty repos and only fast-forwards clean checkouts.
- `campaign labels --apply` creates missing repo labels only when `--confirm` is also present.
- `campaign status` previews issue status movement unless `--confirm` is present. Moving to `blockaded` requires `--reason`.
- Issue and PR handoff commands print scoped prompts by default, except interactive `issue next`, which launches the selected issue by default. Selected `issue next` launches are implementation starts, not preflight-only planning. Add `--dry-run` for preview mode.
- Workflow status movement is guarded separately with `--confirm-status`, except interactive `issue next`, which moves the selected issue to `battlefield-active` by default. Add `--no-status` to skip that movement.
- `pr merge` only merges after explicit confirmation through `--confirm` or an interactive confirmation after the preflight. The interactive prompt accepts `yes` to run the demo Playwright gate or `skip` to continue the merge without that gate. Confirmed merges for repos with `merge.playwright: true` normally must pass the full demo Playwright `test:e2e` run against the local backend API first, with backend readiness progress and Playwright command output printed live. Repos with `merge.playwright: false` skip that backend/demo gate. Repos with `merge.changelog: true` wait for base-branch GitHub Actions after merge, pull the latest release files, use the LLM to update `CHANGELOG.md`, and push a `[skip-ci]` changelog commit to the base branch. Interactive confirmed merges prompt for victory summary comments and local checkout cleanup; non-interactive follow-up actions use `--post-summary --confirm-summary` and `--cleanup-local --confirm-cleanup`.
- `commit create` prints a dry run first. In an interactive terminal it can commit and push after a yes/no prompt; non-interactive use still requires `--confirm`. Pass `--no-push` only when a local-only commit is intentional. Validation commands must pass before a commit proceeds.
- The `pr merge` backend readiness probe uses a direct GET with a short per-request timeout. Local HTTPS certificates are accepted by default for `localhost`, loopback, and `*.local.flopay.com`; set `WARROOM_MERGE_BACKEND_STRICT_TLS=true` to require a trusted certificate. Demo e2e runs against a local HTTPS backend receive `NODE_OPTIONS=--use-system-ca` by default; set `WARROOM_MERGE_DEMO_USE_SYSTEM_CA=false` to disable that flag.
- `allies status` is read-only. It validates shared ally docs and env templates, and reports local-only env/checkouts without cloning, syncing, or reading secret values.
- `abort` preserves work by default. `--stash` requires `--confirm`; the destructive last-resort reset path requires `--danger-reset --confirm-danger "discard local work"`.

## Command Notes

`warroom doctor` validates files, `repos.yaml`, `allies.yaml`, `resources.yaml`, ally shared docs, resource references, LLM adapter shape, local repo health, local tool availability including `gh`, and Campaign Map label presence. Label fixes are printed as a reviewed create plan; doctor does not mutate labels.

`warroom campaign status-check` validates the Campaign Map Status field options: `needs-triage`, `ready-to-engage`, `battlefield-active`, `skirmish`, `blockaded`, and `victory`.

`warroom campaign labels` checks matching workflow labels across mapped repos. Add `--apply --confirm` to create missing labels.

`warroom campaign status` previews or applies issue movement on the Campaign Map. Use `--confirm` to mutate the board.

`warroom allies status` reports enterprise ally workspace health. It checks committed safe metadata and docs, verifies expected Campaign Map/client labels on ally issue repos, reports whether local ally `.env.local` files exist, and reports whether client issue repos are checked out under ignored `allies/<ally>/repos/*`. It does not clone repos, sync Unito data, mutate labels, or print secret values.

`warroom maps assign` validates or updates Sergeant/resource assignments. Use `--repo`, `--sergeant`, `--add-framework`, `--remove-framework`, `--add-domain`, `--remove-domain`, `--add-resource`, and `--remove-resource` for targeted specialist-context edits. Use `--resource-id` with `--resource-type`, `--resource-name`, `--resource-description`, and `--resource-docs-url` to add or update safe logical resource definitions. Pass `--write` to update `repos.yaml`, `resources.yaml`, and regenerate `maps/campaign-atlas.md`; protected notes blocks are preserved.

`warroom issue triage` lists Campaign Map items in `needs-triage`. If the project query returns no items, it falls back to open issues with the `needs-triage` label. With `--issue owner/repo#number`, it builds a scoped handoff prompt with the assigned Sergeant, repo specialist context, and allowed resources, and can write `.warroom/runs/*` artifacts. Add `--mark-ready --confirm-status` after a successful triage to move the issue to `ready-to-engage`.

`warroom issue next` lists Campaign Map items in `ready-to-engage`. If the project query returns no items, it falls back to open issues with the `ready-to-engage` label. From a mapped child repo checkout, the list is scoped to that repo by default; add `--all` to show ready issues across every mapped repo. In an interactive terminal it prompts for a numbered issue and starts a scoped implementation handoff. With `--issue owner/repo#number`, it starts that issue directly. Before launching, War Room runs `gh issue develop <number> --repo <owner/repo> --base <base> --name <generated-branch>` so GitHub links the development branch to the issue; foreground/local adapters also use `--checkout` and require a clean local checkout. Codex Cloud task adapters skip local checkout, so unrelated local dirty files do not block the cloud task. The implementation handoff tells local and cloud adapters to fetch/switch to the branch if their checkout starts elsewhere, includes the complete issue body and all issue comments, and `--write-artifact` also writes `issue.json` beside `prompt.md`. The command ends with an explicit `Outcome:` line saying whether work was handed off to the LLM adapter, only previewed, blocked, or not started. Add `--dry-run` to preview the handoff without creating the branch, launching, or moving status; `--no-status` to launch without Campaign Map movement; or `--no-select` to keep list-only output.

`warroom issue create` and `warroom issue fortify` are explicit post-MVP placeholders tracked by TeamFloPay/infra#7.

`warroom pr create` publishes the current or selected development branch as a GitHub PR. Run it from a mapped child repo checkout, or pass `--branch <name>`. It infers the linked issue from `warroom/<issue-number>-...` branch names unless `--issue owner/repo#number` is passed, builds a title/body from the issue and branch commits unless `--title` or `--body` is supplied, includes `Closes <issue>` when an issue is known, and previews by default. In an interactive terminal, the preflight asks whether to push the branch and create the PR. Add `--confirm` to push the branch and run `gh pr create` without prompting; add `--confirm-status` to move the linked issue to `skirmish` after the PR is created. A successful confirmed create prints the PR URL as the final outcome line; blocked or preflight-only runs print an explicit not-created outcome.

`warroom pr review` without `--pr` lists open PRs linked from Campaign Map issues in `battlefield-active` or `skirmish`, ordered by latest PR update. In an interactive terminal it confirms the single detected PR or asks for a numbered selection, then launches the selected review handoff as if `--pr <owner/repo#number> --launch` was passed. Non-interactive runs only list the queue and print an explicit `Outcome:` line. `warroom pr review --pr ... --launch` sends a fixed GitHub/CodeRabbit handoff to the adapter, then the CLI waits for a new PR commit, waits until CodeRabbit is observed on that latest commit and its feedback is quiet, checks current unresolved CodeRabbit comments, and repeats the adapter loop while feedback remains. Review handoffs always force the foreground adapter, even when `LLM_ADAPTER=codex-cloud`, because Codex Cloud does not inherit local GitHub/CodeRabbit app access, `gh` auth, or local PR remotes. `pr review --dry-run` prints that fixed handoff without launching or polling. The loop logs progress to the terminal and ends with an `Outcome:` line for complete, preflight-only, or blocked states. Tune the loop with `WARROOM_PR_REVIEW_MAX_LOOPS`, `WARROOM_PR_REVIEW_COMMIT_TIMEOUT_MS`, `WARROOM_PR_REVIEW_CODERABBIT_TIMEOUT_MS`, `WARROOM_PR_REVIEW_CODERABBIT_SETTLE_MS`, and `WARROOM_PR_REVIEW_POLL_MS`. `warroom pr merge` provides the merge-stage handoff; it includes merge state, GitHub mergeability, review decision, requested reviewers, unresolved review threads, draft state, status checks, readiness blocker explanations, a generated victory summary, and the repo-specific merge gate decisions from `merge.playwright` and `merge.changelog`. When `--pr` is omitted, War Room infers the current mapped child repo, reads its current branch, and selects the single open GitHub PR for that branch. In an interactive terminal without `--confirm`, War Room prints the preflight and then asks whether to continue into the confirmed merge path; type `skip` at that prompt to continue without the demo Playwright gate. On `--confirm`, a yes answer, or the interactive skip choice, War Room first rechecks merge readiness. For repos with `merge.playwright: true`, it then probes `https://api.local.flopay.com/v1/health`; if that backend is already running it reuses it and leaves it running, otherwise it starts the mapped backend with `npm run start:api` and stops only that War Room-started process after validation. It then runs `npm run test:e2e` from the mapped demo repo with `BILLING_API_URL=https://api.local.flopay.com` and `PLAYWRIGHT_LOCAL_BASE_URL=https://demo.local.flopay.com`, streaming the Playwright output in the terminal unless the interactive skip choice was used. Those repos are blocked unless the full Playwright run passes or the interactive skip choice was used. Repos with `merge.playwright: false` skip the backend/demo Playwright gate. If pre-merge gates pass, War Room runs `gh pr merge --squash --delete-branch`. For repos with `merge.changelog: true`, War Room then waits for GitHub Actions on the PR base branch, pulls the latest base branch so release/version files are current, uses the foreground LLM adapter to edit only `CHANGELOG.md`, then commits and pushes the changelog with a `[skip-ci]` commit message. After a successful interactive confirmed merge, War Room prompts to post the victory summary comments and then prompts to return the local checkout to the PR base branch. Add `--summary <text>` to customize the summary, `--write-artifact` to store `prompt.md`, `pr.json`, `readiness.json`, `merge-e2e.json`, `merge-changelog.json`, `summary.md`, `summary-posts.json`, and `local-cleanup.json`, and `--post-summary --confirm-summary` to post comments to the PR plus linked issue without prompting. Add `--cleanup-local --confirm-cleanup` to switch the mapped clean local checkout back to the PR base branch without prompting when it is currently on the PR branch. `issue next --confirm-status` moves the issue to `battlefield-active`; `pr create --confirm --confirm-status` and `pr review --issue ... --confirm-status` move it to `skirmish`; `pr merge --issue ... --confirm-status` moves it to `victory` only when no merge-readiness blockers are detected.

Set `LLM_ADAPTER=codex-cloud` and repo-specific environment ids such as `CODEX_CLOUD_ENV_BACKEND=<environment-id>` or `CODEX_CLOUD_ENV_SDK=<environment-id>` in `.env.local` when launches should create durable Codex Cloud tasks instead of foreground terminal sessions. War Room selects the environment from the owning repo id in `repos.yaml`. If `codex cloud` opens Codex Desktop without showing an environment id, Codex Cloud still needs an environment configured for the target repo before War Room can submit tasks.

`warroom commit create` inspects a mapped child repo, summarizes changed files, proposes a conventional commit message, optionally runs repeatable `--validate <command>` checks from the target repo, and refuses to proceed when other child repos are dirty. When run from inside a mapped child checkout, `--repo` is inferred from the current directory; otherwise pass `--repo <id>`. In an interactive terminal without `--confirm` or `--json`, it prints the dry run first and then asks whether to create and push the commit. If unstaged changes are present, the prompt explicitly confirms `git add -A` before committing. Confirmed commits push to the current upstream with `git push`; when no upstream exists, War Room pushes `HEAD` to `origin` and sets upstream. Pass `--no-push` for a local-only commit. Add `--write-artifact` to write `input.json`, `result.json`, `summary.md`, `status.txt`, and `validation.json` under ignored `.warroom/runs/*`. A confirmed commit without `--all` requires the target repo to have only staged changes.

`warroom abort` prints recovery commands for every mapped checkout and preserves work by default. It can stash dirty work with `--stash --confirm`. The destructive reset/clean escape hatch is intentionally awkward and requires the exact `--danger-reset --confirm-danger "discard local work"` phrase.

## SDK-To-Demo Local Linking

`warroom dev link` builds the local SDK packages and replaces the demo repo's installed `node_modules/@flopay/*` package symlinks with links to War Room package mirrors under `.warroom/dev/sdk-packages/*`. Each mirror keeps package metadata local and points its `dist` directory at `sdk/packages/*/dist`, so the demo consumes built SDK output without editing committed demo dependencies or the demo lockfile.

Run the linked demo normally:

```sh
corepack pnpm dev
```

Useful validation commands from the demo repo:

```sh
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test:e2e:core
```

Use `warroom dev unlink` to remove local links and run `pnpm install --frozen-lockfile` in the demo repo, restoring published-package behavior.
