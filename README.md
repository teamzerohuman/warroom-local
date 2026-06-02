# ZeroHuman - War Room

War Room is the local command center for your own AI army and  cross-repo work. It owns the operating layer around repositories: repo maps, company-level agent rules, local-only orchestration, issue/PR workflow helpers, and future intelligence/reporting contracts.

It does not own product source code. Product code remains in the child repositories that build, test, deploy, and publish independently.

This is a harness to help you develop with AI and increase development productivity. 

## Quick Start

Prerequisites:

- Node.js `20` or newer
- Fork [https://github.com/teamzerohuman/warroom](ZeroHuman - War Room) locally

```sh
npm install
npm run build
```

First-time setup — generate your project-specific config from the shipped
templates. War Room tracks only `*.example` files; `repos.yaml`, `allies.yaml`,
`.env.local`, and the `maps/*.md` files are gitignored so they never travel
upstream to a shared/parent War Room:

```sh
npm run warroom -- setup        # interactive: build repos.yaml, allies, atlas
# or non-interactive, copying every template verbatim:
npm run warroom -- setup --yes --atlas
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

Set up the Campaign Map board. War Room drives a GitHub Project (the Campaign Map); `warroom setup` offers this automatically when `repos.yaml` has no `campaign_project_number`, or run it directly:

```sh
npm run warroom -- project create            # interactive: create new / use existing / skip
# or non-interactive:
npm run warroom -- project create --title "Campaign Map" --owner your-org --confirm
npm run warroom -- project link --project 1 --owner your-org --confirm   # wire an existing board
```

`project create` creates the board, configures its `Status` field with the six Campaign Map states, and writes `campaign_owner`/`campaign_project_number` into `repos.yaml`.

Run the normal operating checks:

```sh
npm run warroom -- campaign status-check
npm run warroom -- campaign labels
npm run warroom -- allies status
npm run warroom -- maps study
npm run warroom -- issue create
npm run warroom -- issue next
```

In an interactive terminal, `issue next` prints numbered ready issues and lets you choose one to start implementation. From a mapped child repo checkout, the list is scoped to that repo by default; add `--all` to show the cross-repo queue. War Room normally creates and checks out a GitHub-linked development branch with `gh issue develop`, moves the selected issue to `battlefield-active`, replaces its workflow label, and runs the configured foreground LLM adapter from the owning child repo. For Codex this is `codex exec`, so the command returns after the adapter exits and no background cloud or TUI session remains. After a successful interactive adapter run, War Room asks whether to run `warroom pr create` from that same implementation checkout. If the selected issue is in an ally issue repo but triage notes name a mapped `Owner repo`, War Room keeps the source issue in the ally repo, creates a GitHub-linked branch in that owner repo with `createLinkedBranch`, stores the source issue on the branch metadata, and tells the adapter to implement only in the owner repo. The mapped checkout must be clean before launch. The command ends with an explicit `Outcome:` line, so it is clear whether the issue adapter completed, ran and failed, previewed, was blocked before handoff, or did not start. Add `--dry-run` to preview without creating the branch, launching, or moving status.

If you already keep sibling checkouts next to War Room, such as `../sdk` or `../demo`, the CLI can detect those when the mapped `maps/repos/*` checkout is missing. `repos.yaml` remains the ownership map either way.

## Full Development Lifecycle

Use this flow when an existing GitHub issue should move from triage to an opened PR. Replace the example refs with the real issue, repo, and PR numbers.

```sh
ISSUE=org/repo#562
BASE=main
```

1. Confirm the workspace and Campaign Map are healthy.

```sh
warroom doctor
warroom sync --report
warroom campaign status-check
warroom campaign labels
```

2. Create a new issue when the work is not already tracked.

```sh
warroom issue create
```

In an interactive terminal, `issue create` launches a PM-style Codex session that uses light `@grill-me` questioning to capture business scope, not technical implementation detail. The adapter writes a structured issue draft under `.warroom/runs/*`; War Room previews the repo, title, body, labels, and issue type, then asks before creating the GitHub issue. If the business context references a Sentry issue, event, short ID, or URL, the draft must preserve that reference and note that triage should link the created GitHub issue back to Sentry using the Sentry MCP. Confirmed creates add the issue to the Campaign Map as `needs-triage`, apply the `needs-triage` workflow label plus ally labels when the target is an ally issue repo, and best-effort set the GitHub issue type through GraphQL. After printing the issue URL and `Outcome:` line, War Room asks whether to start `warroom issue triage` for the new issue.

3. Triage the existing issue.

```sh
warroom issue triage
warroom issue triage --issue "$ISSUE" --launch --mark-ready --confirm-status --write-artifact
```

In an interactive terminal, `issue triage` prints numbered `needs-triage` Campaign Map items and lets you choose one to launch the scoped triage handoff in the Codex TUI, so `@grill-me` questions can be answered directly. Triage handoffs are planning-only: they may do read-only investigation, ask questions, and post final triage notes back to the GitHub issue, but must not edit code, create branches, commit, or open PRs. If the issue references Sentry, the handoff instructs Codex to use the Sentry MCP to inspect safely and create or verify the GitHub-to-Sentry issue link, then include a `Sentry link:` status line in the triage notes. War Room starts Codex with workspace-write sandboxing plus outbound network access for read-only API checks. Add `--dry-run` to preview the selected handoff without launching. With `--issue`, it builds that handoff directly with repo specialist context and previews by default unless `--launch` is passed. Ally issue repos fall back to the matching `allies.yaml` checkout when they are not in `repos.yaml`. After an interactive selected triage session exits successfully, War Room checks for a new issue comment starting `## War Room triage notes` with `Ready for ready-to-engage: yes`; only then does it move the Campaign status to `ready-to-engage` and replace the workflow label. Direct `--issue --launch` handoffs still require `--mark-ready --confirm-status` for that closeout. The command ends with an explicit `Outcome:` line for completed, dry-run, blocked, or not-ready handoffs.

4. Start implementation from the ready issue.

Interactive selection:

```sh
warroom issue next
```

Direct issue launch:

```sh
warroom issue next --issue "$ISSUE" --base "$BASE" --confirm-status --write-artifact
```

The implementation handoff creates and checks out a GitHub-linked development branch in the owning child repo with `gh issue develop`, uses the issue body and discussion as accepted context, and moves the issue to `battlefield-active` with the matching workflow label when status movement is confirmed. The handoff also tells the implementer to include `Closes <issue>` in the PR body so GitHub links the PR and closes the issue on merge.

5. Work in the owning child repo and validate there.

```sh
cd ../backend
git status --short
npm test
```

Use the child repo's own `AGENTS.md`, package manager, and validation commands. Product code belongs in the child repo, not War Room.

6. Create and push the implementation commit.

```sh
warroom commit create --validate "npm test" --write-artifact
```

When run interactively from a mapped child checkout, `commit create` first prints a dry run, then asks before staging, committing, and pushing to the remote branch. After a successful commit, it posts a compact commit progress comment to the linked source issue, then asks whether to run `warroom pr create` next so the PR can be opened immediately. From War Room root, it can infer the target repo from the single active mapped development branch written by `issue next`; pass `--repo <id>` when more than one child repo could match.

7. Publish the PR on GitHub.

```sh
warroom pr create --confirm --confirm-status --write-artifact
```

Run this from the development branch in the owning child repo, or pass `--branch <name>`. `pr create` first uses branch metadata written by `issue next`, then falls back to inferring `org/repo#562` from a `warroom/562-...` branch. It asks the LLM adapter to draft a PR title/body from the actual branch commits and diff, includes `Closes <issue>`, pushes the branch, creates the GitHub PR, posts the generated PR summary to the linked source issue, and moves the issue plus workflow label to `skirmish` when `--confirm-status` is present. Large diffs are summarized across multiple adapter chunk calls before the final PR text prompt instead of being clipped from the prompt. If the adapter fails, War Room falls back to a local issue/commit summary. After a successful interactive create, War Room asks whether to run `warroom pr review` for the new PR.

8. Move into the review loop.

```sh
warroom pr review
warroom pr review --pr org/repo#655 --issue "$ISSUE" --launch --confirm-status --write-artifact
```

Without `--pr`, `pr review` lists open PRs linked from issues in `battlefield-active` or `skirmish`, ordered by latest update. If that Campaign queue is empty and the command is run inside a mapped child repo branch with a single open PR, it falls back to that current-branch PR. In an interactive terminal it asks whether to launch the detected PR review handoff, using the selected PR as if `--pr <owner/repo#number> --launch` was passed. When launched from the `pr create` follow-up prompt, it first waits for CodeRabbit to appear and settle on the initial PR commit; if no outstanding CodeRabbit feedback remains, it exits complete without an adapter run. Non-interactive fallback runs print the current-branch PR preflight. With `--pr --launch`, it sends the fixed GitHub/CodeRabbit feedback handoff to the adapter with the current review-thread IDs, waits for a new PR commit, waits for CodeRabbit to appear and settle on that commit, checks outstanding current CodeRabbit comments, verifies that handled CodeRabbit threads have `Change made:` or `Skipped:` replies, and repeats the adapter loop until no CodeRabbit feedback remains or the loop blocks. It resolves the linked issue from queue selection, branch metadata, or the PR body closing line, so ally-source issues can still move to `skirmish` when confirmed.

9. Finish through the merge gate when review is clear.

From the PR branch in the child repo, War Room can infer the PR:

```sh
warroom pr merge
warroom pr merge --issue "$ISSUE" --confirm
```

`pr merge` explains merge-readiness blockers, requested reviewers, unresolved review threads, and check state. It resolves the linked issue from branch metadata or the PR body closing line when `--issue` is omitted, which keeps ally-source issue summaries and Campaign status updates pointed at the source issue. Without `--confirm`, an interactive preflight asks whether to continue into the confirmed merge path. If the preflight is blocked, type `skip` to allow unresolved review threads only when no other blockers remain. If the preflight is clear, type `skip` to continue the merge while skipping the demo Playwright gate. A confirmed merge first reruns merge readiness. For repos with `merge.playwright: true` in `repos.yaml`, it then runs the required demo Playwright `test:e2e` gate against the local backend API unless the clear-preflight skip choice was used, printing backend readiness progress and streaming the Playwright command output in the terminal. Repos with `merge.playwright: false` skip that backend/demo gate. After the demo Playwright gate and before PR merge, repos with `merge.bump` enabled ask `Should we bump the version number? [PATCH|minor|major|skip]` in interactive terminals; Enter runs the configured bump command with `patch`, commits the changed files to the PR branch, and pushes them before merge. Non-interactive runs skip unless `--bump-version patch`, `--bump-version minor`, or `--bump-version major` is passed. If `merge.changelog` is enabled, War Room asks `Run the public changelog update now ...? [y/N]` in interactive terminals after the PR merge, so the changelog adapter sees any bumped version merged through the PR. Non-interactive merges skip the changelog update unless `--confirm-changelog` is passed. When confirmed, War Room waits for base-branch GitHub Actions after merge, pulls the latest files, asks the LLM to write the configured public changelog target (`CHANGELOG.md` or one OpenChangelog Markdown file under `release-notes/`), and pushes a `[skip-ci]` changelog commit to the base branch. Once the PR is merged and the closeout gates are clear, War Room posts a short victory update to the linked issue unless `--no-issue-comment` is used. After a successful merge, War Room prints the issue's War Room LLM usage summary from `.warroom/runs/issues/<issue>/usage-ledger.json`. After a successful interactive merge, War Room prompts to post the fuller victory summary and then prompts for local cleanup, which switches to the PR base branch and pulls it with `git pull --ff-only`.

## LLM Usage Tracking

War Room records issue-attributed LLM adapter usage automatically. The canonical ledger is keyed by the source GitHub issue, so ally issues keep the same usage total even when implementation happens in a mapped product repo:

```text
.warroom/runs/issues/<org>__<repo>__<issue>/usage-ledger.json
.warroom/runs/issues/<org>__<repo>__<issue>/usage-summary.md
```

The ledger stores metadata, token counts, estimates, and cost fields only; it does not store prompts or model output. Every adapter prompt with an issue context starts with a task title like `[org/repo#666] issue-triage/interactive-triage`, and the same title is stored on the usage entry so Codex session history, local logs, and War Room cost records can be cross-checked. `codex exec` output is captured while still being shown in the terminal where possible, so War Room can parse adapter-reported token totals when present. Interactive Codex TUI sessions use the local terminal capture wrapper when a controlling terminal is available, so the final `Token usage:` footer can be parsed too. Otherwise War Room records prompt/output token estimates and marks the entry as estimated.

Pricing is read from `config/llm-pricing.json`. Missing rates are reported as `Cost: unavailable` rather than treated as zero. Inspect current usage before merge with:

```sh
warroom issue usage --issue "$ISSUE"
```

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
npm run warroom -- issue create
npm run warroom -- issue triage
npm run warroom -- issue next
npm run warroom -- issue usage --issue "$ISSUE"
npm run warroom -- abort --print-recovery
npm run warroom -- dev status
```

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

The nested `merge` config controls confirmed PR merge gates. `merge.playwright` is enabled for `sdk`, `backend`, and `demo`; all other mapped repos skip the demo Playwright gate during `warroom pr merge`. `merge.bump` is enabled for `sdk`, `backend`, and `docs`; confirmed merges can run each repo's configured package-script bump command on the PR branch before the PR is merged. `merge.changelog` is enabled for `sdk` and `backend` using OpenChangelog format, so confirmed and explicitly approved changelog closeouts create one public release-note Markdown file under each repo's configured `release-notes/` folder after base-branch actions pass and link the final victory update to the configured public changelog URL. See `docs/openchangelog-release-notes.md` for the adapter guardrails and examples.

War Room also passes `NODE_OPTIONS=--use-system-ca` to the Playwright process so the demo web server can trust locally installed development certificates. Set `WARROOM_MERGE_BACKEND_STRICT_TLS=true` to require trusted certificates for the readiness probe, or `WARROOM_MERGE_DEMO_USE_SYSTEM_CA=false` to disable the demo Node system CA flag.

## Enterprise Allies

Enterprise client support lives under `allies/*`. The shared manifest is `allies.yaml`; it tracks safe metadata such as ally id, shared docs, local env path, and client issue repo sync boundary.

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

## Contributing

Once forked you can open pull requests for review. Make sure all code is using TDD and that all tests pass before committing code.

```
npm test
```