# Flo War Room

War Room is the local command center for Flo cross-repo work. It owns the operating layer around repositories: repo maps, company-level agent rules, local-only orchestration, issue/PR workflow helpers, and future intelligence/reporting contracts.

It does not own product source code. Product code remains in the child repositories that build, test, deploy, and publish independently.

## Current Phase

This repository implements the War Room foundation from [TeamFloPay/infra#4](https://github.com/TeamFloPay/infra/issues/4), with the phase-1 skeleton from [TeamFloPay/infra#11](https://github.com/TeamFloPay/infra/issues/11) and SDK-to-demo local linking from [TeamFloPay/infra#10](https://github.com/TeamFloPay/infra/issues/10):

- private `TeamFloPay/warroom` repository
- company-level `AGENTS.md`
- safe ignored locations for child repo checkouts and local run artifacts
- initial `repos.yaml`, `resources.yaml`, `maps/campaign-atlas.md`, and `maps/issue-territory.md`
- npm/TypeScript CLI for bootstrap, sync, maps, issue, PR, commit, abort, and dev-link workflows

## Implementation Order

Completed critical-path slices:

1. War Room phase 1: create this skeleton and repo map.
2. TeamFloPay/sdk#60: extract `sdk/apps/*` into standalone app repos.
3. TeamFloPay/sdk#59: clean the SDK repo after extraction.
4. TeamFloPay/infra#10: implement the SDK-to-demo local dev link from War Room.

SDK-to-demo linking intentionally waits until `TeamFloPay/demo` exists as a standalone repo. App repos must commit normal published package ranges by default; local SDK linking is a War Room convenience, not an app repo dependency model.

## Repository Rules

- `warroom` commands the campaign; child repositories own the code.
- Child repos live locally under ignored `maps/repos/*`.
- No Git submodules by default.
- Secrets are never committed.
- War Room uses npm for its TypeScript CLI package.
- Child repos can use their own package managers and workflows.

## Setup

```sh
npm install
npm run build
npm test
```

Useful CLI commands:

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

SDK-to-demo local linking is available through `warroom dev link`, `warroom dev status`, and `warroom dev unlink`.

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
- [War Room operations](docs/war-room-operations.md)

## Manual Bypass

War Room is an accelerator, not a dependency for product development. Direct child-repo work remains valid: clone the owning repo, read its `AGENTS.md`, use its normal setup/test commands, and open PRs from that repo.
