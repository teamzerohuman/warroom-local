# TeamFloPay War Room

War Room is the local command center for TeamFloPay cross-repo work. It owns the operating layer around repositories: repo maps, company-level agent rules, local-only orchestration, issue/PR workflow helpers, and future intelligence/reporting contracts.

It does not own product source code. Product code remains in the child repositories that build, test, deploy, and publish independently.

## Current Phase

This repository starts with the phase-1 foundation from TeamFloPay/infra#11:

- private `TeamFloPay/warroom` repository
- company-level `AGENTS.md`
- safe ignored locations for child repo checkouts and local run artifacts
- initial `repos.yaml`, `resources.yaml`, `maps/campaign-atlas.md`, and `maps/issue-territory.md`
- npm/TypeScript-ready CLI skeleton

## Implementation Order

The current cross-repo implementation order is:

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

The phase-1 CLI is intentionally small:

```sh
npm run warroom -- --help
npm run warroom -- maps study
npm run warroom -- doctor
```

Future implementation issues will fill in bootstrap, sync, issue, PR, commit, abort, and dev-link behavior.

## Child Repo Map

The machine-readable source of truth is `repos.yaml`. The human-readable view is `maps/campaign-atlas.md`.

Current mapped repos:

- `sdk`
- `backend`
- `infra`
- `demo` (planned by TeamFloPay/sdk#60)
- `docs` (planned by TeamFloPay/sdk#60)
- `dashboard` (planned by TeamFloPay/sdk#60)
- `landing` (planned by TeamFloPay/sdk#60)

## Manual Bypass

War Room is an accelerator, not a dependency for product development. Direct child-repo work remains valid: clone the owning repo, read its `AGENTS.md`, use its normal setup/test commands, and open PRs from that repo.
