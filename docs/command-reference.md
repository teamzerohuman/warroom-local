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
warroom issue create
warroom issue fortify
warroom pr engage --issue TeamFloPay/infra#4 --base main
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
- Issue and PR handoff commands print scoped prompts by default, except interactive `issue next`, which launches the selected issue by default. `pr engage` and selected `issue next` launches are implementation handoffs, not preflight-only planning. Add `--dry-run` for preview mode.
- Workflow status movement is guarded separately with `--confirm-status`, except interactive `issue next`, which moves the selected issue to `battlefield-active` by default. Add `--no-status` to skip that movement.
- `pr merge` only merges after explicit confirmation through `--confirm` or an interactive yes answer after the preflight. Confirmed merges for repos with `merge_playwright: true` must pass the full demo Playwright `test:e2e` run against the local backend API first, with backend readiness progress and Playwright command output printed live. Repos with `merge_playwright: false` skip that backend/demo gate. Interactive confirmed merges prompt for victory summary comments and local checkout cleanup; non-interactive follow-up actions use `--post-summary --confirm-summary` and `--cleanup-local --confirm-cleanup`.
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

`warroom issue next` lists Campaign Map items in `ready-to-engage`. If the project query returns no items, it falls back to open issues with the `ready-to-engage` label. In an interactive terminal it prompts for a numbered issue and then starts the same scoped implementation handoff as `warroom pr engage --issue ... --launch --confirm-status`. Add `--dry-run` to preview the handoff without launching or moving status, `--no-status` to launch without Campaign Map movement, or `--no-select` to keep list-only output.

`warroom issue create` and `warroom issue fortify` are explicit post-MVP placeholders tracked by TeamFloPay/infra#7.

`warroom pr engage` launches development from an issue. It includes the issue body, GitHub discussion/triage comments, assigned Sergeant, repo specialist context, allowed resources, base branch, and a generated feature branch name, then instructs the adapter to implement, validate, and commit rather than write a preflight markdown plan. `pr engage --base main` defaults to `main`; `stage` remains the secondary target option after validation. `warroom pr review` without `--pr` lists open PRs linked from Campaign Map issues in `battlefield-active` or `skirmish`, ordered by latest PR update. `warroom pr review --pr ...` and `warroom pr merge` provide scoped handoffs for later review and merge stages. `pr review --dry-run` includes PR files, comments, latest reviews, check state, context size, and a 60-minute default check-in instruction for future feedback loops. `pr merge` includes merge state, GitHub mergeability, review decision, requested reviewers, unresolved review threads, draft state, status checks, readiness blocker explanations, a generated victory summary, and the repo-specific demo e2e gate decision from `merge_playwright`. When `--pr` is omitted, War Room infers the current mapped child repo, reads its current branch, and selects the single open GitHub PR for that branch. In an interactive terminal without `--confirm`, War Room prints the preflight and then asks whether to continue into the confirmed merge path. On `--confirm` or a yes answer, War Room first rechecks merge readiness. For repos with `merge_playwright: true`, it then probes `https://api.local.flopay.com/v1/health`; if that backend is already running it reuses it and leaves it running, otherwise it starts the mapped backend with `npm run start:api` and stops only that War Room-started process after validation. It then runs `npm run test:e2e` from the mapped demo repo with `BILLING_API_URL=https://api.local.flopay.com` and `PLAYWRIGHT_LOCAL_BASE_URL=https://demo.local.flopay.com`, streaming the Playwright output in the terminal. Those repos are blocked unless the full Playwright run passes. Repos with `merge_playwright: false` skip the backend/demo Playwright gate. If required gates pass, War Room runs `gh pr merge --squash --delete-branch`. After a successful interactive confirmed merge, War Room prompts to post the victory summary comments and then prompts to return the local checkout to the PR base branch. Add `--summary <text>` to customize the summary, `--write-artifact` to store `prompt.md`, `pr.json`, `readiness.json`, `merge-e2e.json`, `summary.md`, `summary-posts.json`, and `local-cleanup.json`, and `--post-summary --confirm-summary` to post comments to the PR plus linked issue without prompting. Add `--cleanup-local --confirm-cleanup` to switch the mapped clean local checkout back to the PR base branch without prompting when it is currently on the PR branch. `pr engage --confirm-status` moves the issue to `battlefield-active`; `pr review --issue ... --confirm-status` moves it to `skirmish`; `pr merge --issue ... --confirm-status` moves it to `victory` only when no merge-readiness blockers are detected.

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
