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
npm run warroom -- maps study
npm run warroom -- issue next
```

If you already keep sibling checkouts next to War Room, such as `../sdk` or `../demo`, the CLI can detect those when the mapped `maps/repos/*` checkout is missing. `repos.yaml` remains the ownership map either way.

## Daily Commands

Useful CLI entry points:

```sh
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
- War Room uses npm for its TypeScript CLI package.
- Child repos can use their own package managers and workflows.

## Child Repo Map

The machine-readable source of truth is `repos.yaml`. The human-readable view is `maps/campaign-atlas.md`.

Current mapped repos:

- `sdk`
- `backend`
- `infra`
- `demo`
- `docs`
- `dashboard`
- `landing`

## Documentation

- [Command reference](docs/command-reference.md)
- [Local development](docs/local-development.md)
- [Manual operations](docs/manual-operations.md)
- [LLM operations](docs/llm-operations.md)
- [Release process](docs/release-process.md)
- [War Room operations](docs/war-room-operations.md)

## Manual Bypass

War Room is an accelerator, not a dependency for product development. Direct child-repo work remains valid: clone the owning repo, read its `AGENTS.md`, use its normal setup/test commands, and open PRs from that repo.
