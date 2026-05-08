# Flo War Room

War Room is the local command center for Flo cross-repo work. It owns the operating layer around repositories: repo maps, company-level agent rules, local-only orchestration, issue/PR workflow helpers, and future intelligence/reporting contracts.

It does not own product source code. Product code remains in the child repositories that build, test, deploy, and publish independently.

Flo is the company/product umbrella term.


## Quick Start

Prerequisites:

- Node.js `20` or newer
- Git and GitHub SSH access to `TeamFloPay/*`
- GitHub CLI authenticated with project/repo access for issue, PR, and Campaign Map commands

From the War Room repo:

```sh
npm install
npm run build
npm test
npm run warroom -- doctor
```

Install the `warroom` command globally from this checkout:

```sh
npm run link:global
warroom doctor
```

The global command resolves the War Room workspace from the current directory. It works from War Room itself, nested `maps/repos/*` checkouts, and sibling child repos such as `../backend`. If your checkouts are elsewhere, set `WARROOM_ROOT=/path/to/warroom`.

Check what War Room would clone or update:

```sh
npm run warroom -- bootstrap --dry-run
npm run warroom -- sync --report
```

Clone missing mapped child repos under ignored `maps/repos/*` when you are ready:

```sh
npm run warroom -- bootstrap
```

Run the normal operating checks:

```sh
npm run warroom -- campaign status-check
npm run warroom -- campaign labels
npm run warroom -- allies status
npm run warroom -- maps study
npm run warroom -- issue next
```

In an interactive terminal, `issue next` prints numbered ready issues and lets you choose one to start implementation. From a mapped child repo checkout, the list is scoped to that repo by default; add `--all` to show the cross-repo queue. War Room creates and checks out a GitHub-linked development branch with `gh issue develop`, moves the selected issue to `battlefield-active`, and hands the work to the configured terminal LLM adapter from the owning child repo. The mapped checkout must be clean before launch. The command ends with an explicit `Outcome:` line, so it is clear whether the issue was handed off, previewed, blocked, or not started. Add `--dry-run` to preview without creating the branch, launching, or moving status.

If you already keep sibling checkouts next to War Room, such as `../sdk` or `../demo`, the CLI can detect those when the mapped `maps/repos/*` checkout is missing. `repos.yaml` remains the ownership map either way.

## Full Development Lifecycle

Use this flow when an existing GitHub issue should move from triage to an opened PR. Replace the example refs with the real issue, repo, and PR numbers.

```sh
ISSUE=TeamFloPay/backend#562
BASE=main
```

1. Confirm the workspace and Campaign Map are healthy.

```sh
warroom doctor
warroom sync --report
warroom campaign status-check
warroom campaign labels
```

2. Triage the existing issue.

```sh
warroom issue triage
warroom issue triage --issue "$ISSUE" --launch --mark-ready --confirm-status --write-artifact
```

In an interactive terminal, `issue triage` prints numbered `needs-triage` Campaign Map items and lets you choose one to launch the scoped triage handoff in the Codex TUI, so `@grill-me` questions can be answered directly. Triage handoffs are planning-only: they may do read-only investigation, ask questions, and post final triage notes back to the GitHub issue, but must not edit code, create branches, commit, or open PRs. War Room starts Codex with workspace-write sandboxing plus outbound network access for read-only API checks. Add `--dry-run` to preview the selected handoff without launching. With `--issue`, it builds that handoff directly with repo specialist context and previews by default unless `--launch` is passed. Ally issue repos fall back to the matching `allies.yaml` checkout when they are not in `repos.yaml`. The command ends with an explicit `Outcome:` line for completed, dry-run, or blocked handoffs. `--mark-ready --confirm-status` moves the issue to `ready-to-engage` after the triage handoff is launched.

3. Start implementation from the ready issue.

Interactive selection:

```sh
warroom issue next
```

Direct issue launch:

```sh
warroom issue next --issue "$ISSUE" --base "$BASE" --confirm-status --write-artifact
```

The implementation handoff creates and checks out a GitHub-linked development branch in the owning child repo with `gh issue develop`, uses the issue body and discussion as accepted context, and moves the issue to `battlefield-active` when status movement is confirmed. The handoff also tells the implementer to include `Closes <issue>` in the PR body so GitHub links the PR and closes the issue on merge.

4. Work in the owning child repo and validate there.

```sh
cd ../backend
git status --short
npm test
```

Use the child repo's own `AGENTS.md`, package manager, and validation commands. Product code belongs in the child repo, not War Room.

5. Create and push the implementation commit.

```sh
warroom commit create --validate "npm test" --write-artifact
```

When run interactively from a mapped child checkout, `commit create` first prints a dry run, then asks before staging, committing, and pushing to the remote branch. After a successful commit, it asks whether to run `warroom pr create` next so the PR can be opened immediately. Pass `--repo <id>` when running from War Room instead of the child repo.

6. Publish the PR on GitHub.

```sh
warroom pr create --confirm --confirm-status --write-artifact
```

Run this from the development branch in the owning child repo, or pass `--branch <name>`. `pr create` infers `TeamFloPay/backend#562` from a `warroom/562-...` branch, asks the LLM adapter to draft a PR title/body from the actual branch commits and diff, includes `Closes <issue>`, pushes the branch, creates the GitHub PR, and moves the issue to `skirmish` when `--confirm-status` is present. Large diffs are summarized across multiple adapter chunk calls before the final PR text prompt instead of being clipped from the prompt. If the adapter fails, War Room falls back to a local issue/commit summary. At this point the PR is published. Copy the PR ref from GitHub, for example `TeamFloPay/backend#655`.

7. Move into the review loop.

```sh
warroom pr review
warroom pr review --pr TeamFloPay/backend#655 --issue "$ISSUE" --launch --confirm-status --write-artifact
```

Without `--pr`, `pr review` lists open PRs linked from issues in `battlefield-active` or `skirmish`, ordered by latest update. If that Campaign queue is empty and the command is run inside a mapped child repo branch with a single open PR, it falls back to that current-branch PR. In an interactive terminal it asks whether to launch the detected PR review handoff, using the selected PR as if `--pr <owner/repo#number> --launch` was passed. Non-interactive fallback runs print the current-branch PR preflight. With `--pr --launch`, it sends the fixed GitHub/CodeRabbit feedback handoff to the adapter with the current review-thread IDs, waits for a new PR commit, waits for CodeRabbit to appear and settle on that commit, checks outstanding current CodeRabbit comments, verifies that handled CodeRabbit threads have `Change made:` or `Skipped:` replies, and repeats the adapter loop until no CodeRabbit feedback remains or the loop blocks. It moves the issue to `skirmish` when confirmed.

8. Finish through the merge gate when review is clear.

From the PR branch in the child repo, War Room can infer the PR:

```sh
warroom pr merge
warroom pr merge --issue "$ISSUE" --confirm
```

`pr merge` explains merge-readiness blockers, requested reviewers, unresolved review threads, and check state. Without `--confirm`, an interactive preflight asks whether to continue into the confirmed merge path. If the preflight is blocked, type `skip` to allow unresolved review threads only when no other blockers remain. If the preflight is clear, type `skip` to continue the merge while skipping the demo Playwright gate. A confirmed merge first reruns merge readiness. For repos with `merge.playwright: true` in `repos.yaml`, it then runs the required demo Playwright `test:e2e` gate against the local backend API unless the clear-preflight skip choice was used, printing backend readiness progress and streaming the Playwright command output in the terminal. Repos with `merge.playwright: false` skip that backend/demo gate. If `merge.changelog: true`, War Room waits for base-branch GitHub Actions after merge, pulls the latest files, asks the LLM to update `CHANGELOG.md`, and pushes a `[skip-ci]` changelog commit to the base branch. After a successful interactive merge, War Room prompts to post the victory summary and then prompts for local cleanup, which switches to the PR base branch and pulls it with `git pull --ff-only`.

If work becomes blocked, mark it explicitly:

```sh
warroom campaign status --issue "$ISSUE" --status blockaded --reason "<current blocker>" --confirm
```

## Daily Commands

Useful CLI entry points:

```sh
warroom --help
warroom doctor
warroom commit create
npm run warroom -- --help
npm run warroom -- doctor
npm run warroom -- bootstrap --dry-run
npm run warroom -- sync --report
npm run warroom -- campaign status-check
npm run warroom -- campaign labels
npm run warroom -- maps study
npm run warroom -- maps assign --check
npm run warroom -- issue triage
npm run warroom -- issue next
npm run warroom -- abort --print-recovery
npm run warroom -- dev status
```

## SDK-To-Demo Linking

SDK-to-demo local linking is available through `warroom dev link`, `warroom dev status`, and `warroom dev unlink`.

Use local linking only when you need unreleased SDK package changes to be consumed by the standalone demo app. App repos should keep normal published `@flopay/*` semver ranges by default; War Room linking is a local development convenience, not a committed dependency model.

Typical flow:

```sh
npm run warroom -- dev status
npm run warroom -- dev link
```

Then run the linked demo from the demo repo:

```sh
corepack pnpm dev
```

Use `npm run warroom -- dev unlink` to restore published-package behavior.

## Repository Rules

- `warroom` commands the campaign; child repositories own the code.
- Child repos live locally under ignored `maps/repos/*`.
- No Git submodules by default.
- Secrets are never committed.
- Enterprise ally secrets live in ignored `allies/<ally>/.env.local` files.
- War Room uses npm for its TypeScript CLI package.
- Child repos can use their own package managers and workflows.

## Child Repo Map

The machine-readable source of truth is `repos.yaml`. The human-readable view is `maps/campaign-atlas.md`.

The nested `merge` config controls confirmed PR merge gates. `merge.playwright` is enabled for `sdk`, `backend`, and `demo`; all other mapped repos skip the demo Playwright gate during `warroom pr merge`. `merge.changelog` is enabled for `sdk` only, so SDK merges update `CHANGELOG.md` after release actions publish the new package version.

The merge gate checks backend readiness with a direct GET to `https://api.local.flopay.com/v1/health`. For local hosts (`localhost`, loopback, and `*.local.flopay.com`), War Room accepts untrusted local TLS certificates by default so it can reuse an already-running API instead of starting another one. When the demo e2e run targets a local HTTPS backend, War Room also passes `NODE_OPTIONS=--use-system-ca` to the Playwright process so the demo web server can trust locally installed development certificates. Set `WARROOM_MERGE_BACKEND_STRICT_TLS=true` to require trusted certificates for the readiness probe, or `WARROOM_MERGE_DEMO_USE_SYSTEM_CA=false` to disable the demo Node system CA flag.

Current mapped repos:

- `sdk`
- `backend`
- `infra`
- `demo`
- `docs`
- `dashboard`
- `landing`

## Enterprise Allies

Enterprise client support lives under `allies/*`. The shared manifest is `allies.yaml`; it tracks safe metadata such as ally id, shared docs, local env path, and client issue repo sync boundary.

ClickTech is the first ally workspace:

- Safe shared docs: `allies/clicktech/docs/*`
- Local secrets: `allies/clicktech/.env.local`
- Local scratch: `allies/clicktech/workspace/*`
- Client issue repo checkout: `allies/clicktech/repos/ally-clicktech`
- Planned issue sync: ClickTech Jira <> Unito <> `TeamFloPay/ally-clicktech`

Check ally readiness:

```sh
npm run warroom -- allies status
```

## Documentation

- [Command reference](docs/command-reference.md)
- [Local development](docs/local-development.md)
- [Manual operations](docs/manual-operations.md)
- [LLM operations](docs/llm-operations.md)
- [Release process](docs/release-process.md)
- [War Room operations](docs/war-room-operations.md)

## Manual Bypass

War Room is an accelerator, not a dependency for product development. Direct child-repo work remains valid: clone the owning repo, read its `AGENTS.md`, use its normal setup/test commands, and open PRs from that repo.
