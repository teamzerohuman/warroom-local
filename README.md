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

In an interactive terminal, `issue next` prints numbered ready issues and lets you choose one to start the PR engagement handoff. The selected issue is moved to `battlefield-active` and handed to the configured LLM adapter; add `--dry-run` to preview without launching or moving status.

If you already keep sibling checkouts next to War Room, such as `../sdk` or `../demo`, the CLI can detect those when the mapped `maps/repos/*` checkout is missing. `repos.yaml` remains the ownership map either way.

## Full Development Lifecycle

Use this flow when an existing GitHub issue should move from triage to an opened PR. Replace the example refs with the real issue, repo, and PR numbers.

```sh
ISSUE=TeamFloPay/backend#562
REPO=TeamFloPay/backend
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

`issue triage` lists `needs-triage` Campaign Map items when no issue is passed. With `--issue`, it builds a scoped triage handoff with repo specialist context. `--mark-ready --confirm-status` moves the issue to `ready-to-engage` after the triage handoff is launched.

3. Start implementation from the ready issue.

Interactive selection:

```sh
warroom issue next
```

Direct issue launch:

```sh
warroom pr engage --issue "$ISSUE" --base "$BASE" --launch --confirm-status --write-artifact
```

The implementation handoff creates or switches to a feature branch in the owning child repo, uses the issue body and discussion as accepted context, and moves the issue to `battlefield-active` when status movement is confirmed.

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

When run interactively from a mapped child checkout, `commit create` first prints a dry run, then asks before staging, committing, and pushing to the remote branch. Pass `--repo <id>` when running from War Room instead of the child repo.

6. Publish the PR on GitHub.

```
TODO: what happens when you run warroom pr engage (this should create the PR with LLM generated commit?)
```

```sh
PR_BODY=$(mktemp)
cat > "$PR_BODY" <<EOF
Closes $ISSUE

## Summary
- <what changed>

## Validation
- npm test
EOF

gh pr create \
  --repo "$REPO" \
  --base "$BASE" \
  --head "$(git branch --show-current)" \
  --title "<clear PR title>" \
  --body-file "$PR_BODY"

rm "$PR_BODY"
```

At this point the PR is published. Copy the PR ref from GitHub, for example `TeamFloPay/backend#655`.

7. Move into the review loop.

```sh
warroom pr review
warroom pr review --pr TeamFloPay/backend#655 --issue "$ISSUE" --launch --confirm-status --write-artifact
```

Without `--pr`, `pr review` lists open PRs linked from issues in `battlefield-active` or `skirmish`, ordered by latest update. With `--pr`, it creates a scoped review-loop handoff and moves the issue to `skirmish` when confirmed.

8. Finish through the merge gate when review is clear.

From the PR branch in the child repo, War Room can infer the PR:

```sh
warroom pr merge
warroom pr merge --issue "$ISSUE" --confirm
```

`pr merge` explains merge-readiness blockers, requested reviewers, unresolved review threads, and check state. Without `--confirm`, an interactive preflight asks whether to continue into the confirmed merge path. A confirmed merge first reruns merge readiness. For repos with `merge_playwright: true` in `repos.yaml`, it then runs the required demo Playwright `test:e2e` gate against the local backend API, printing backend readiness progress and streaming the Playwright command output in the terminal. Repos with `merge_playwright: false` skip that backend/demo gate. If required gates pass, War Room runs `gh pr merge --squash --delete-branch`. After a successful interactive merge, War Room prompts to post the victory summary and then prompts for local cleanup.

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

`merge_playwright` controls the confirmed PR merge e2e gate. It is enabled for `sdk`, `backend`, and `demo`; all other mapped repos skip the demo Playwright gate during `warroom pr merge`.

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
