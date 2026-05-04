# Campaign Atlas

This atlas is the human-readable view of `repos.yaml`. The YAML manifest is the machine-readable source of truth for repo ownership, local paths, specialist context, and resource allowlists.

War Room owns coordination. Child repositories own code.

## Current Implementation Queue

1. TeamFloPay/infra#11: create War Room skeleton and repo map.
2. TeamFloPay/sdk#60: extract app repos from `sdk/apps` and make them standalone.
3. TeamFloPay/sdk#59: clean SDK repo after app extraction.
4. TeamFloPay/infra#10: implement SDK-to-demo local dev link.

## Repo Map

| Repo | Status | Local path | Sergeant | Notes |
| --- | --- | --- | --- | --- |
| `TeamFloPay/sdk` | active | `maps/repos/sdk` | SDK Sergeant | SDK packages and publish workflow. |
| `TeamFloPay/backend` | active | `maps/repos/backend` | Backend Sergeant | Central API and server-side application. |
| `TeamFloPay/infra` | active | `maps/repos/infra` | Infra Sergeant | Live infrastructure and operational config. |
| `TeamFloPay/demo` | planned | `maps/repos/demo` | Demo Sergeant | Created by TeamFloPay/sdk#60. |
| `TeamFloPay/docs` | planned | `maps/repos/docs` | Docs Sergeant | Created by TeamFloPay/sdk#60. |
| `TeamFloPay/dashboard` | planned | `maps/repos/dashboard` | Dashboard Sergeant | Created by TeamFloPay/sdk#60. |
| `TeamFloPay/landing` | planned | `maps/repos/landing` | Landing Sergeant | Created by TeamFloPay/sdk#60. |

## Specialist Context

### SDK Sergeant

- Repo: `TeamFloPay/sdk`
- Focus: SDK packages, package publishing, package-level docs, demo compatibility.
- Main resources: GitHub CLI, npm docs, TypeScript docs.

<!-- warroom:notes:start repo=sdk -->
<!-- Add hand-written SDK notes here. This block should be preserved by future atlas generation. -->
<!-- warroom:notes:end repo=sdk -->

### Backend Sergeant

- Repo: `TeamFloPay/backend`
- Focus: Central API, checkout orchestration, billing, provider integrations.
- Main resources: GitHub CLI, NestJS docs, Stripe docs.

<!-- warroom:notes:start repo=backend -->
<!-- Add hand-written backend notes here. This block should be preserved by future atlas generation. -->
<!-- warroom:notes:end repo=backend -->

### Infra Sergeant

- Repo: `TeamFloPay/infra`
- Focus: infrastructure safety, Railway, Cloudflare, Terraform, deployment wiring.
- Main resources: GitHub CLI, Railway docs, Cloudflare docs.

<!-- warroom:notes:start repo=infra -->
<!-- Add hand-written infra notes here. This block should be preserved by future atlas generation. -->
<!-- warroom:notes:end repo=infra -->

### Demo Sergeant

- Repo: `TeamFloPay/demo`
- Status: planned by TeamFloPay/sdk#60.
- Focus: SDK verification, checkout demos, Playwright coverage, local SDK linking after extraction.

<!-- warroom:notes:start repo=demo -->
<!-- Add hand-written demo notes here. This block should be preserved by future atlas generation. -->
<!-- warroom:notes:end repo=demo -->

### Docs Sergeant

- Repo: `TeamFloPay/docs`
- Status: planned by TeamFloPay/sdk#60.
- Focus: SDK documentation, examples, API reference, guide content.

<!-- warroom:notes:start repo=docs -->
<!-- Add hand-written docs notes here. This block should be preserved by future atlas generation. -->
<!-- warroom:notes:end repo=docs -->

### Dashboard Sergeant

- Repo: `TeamFloPay/dashboard`
- Status: planned by TeamFloPay/sdk#60.
- Focus: dashboard app and billing/admin workflows.

<!-- warroom:notes:start repo=dashboard -->
<!-- Add hand-written dashboard notes here. This block should be preserved by future atlas generation. -->
<!-- warroom:notes:end repo=dashboard -->

### Landing Sergeant

- Repo: `TeamFloPay/landing`
- Status: planned by TeamFloPay/sdk#60.
- Focus: marketing site and public product pages.

<!-- warroom:notes:start repo=landing -->
<!-- Add hand-written landing notes here. This block should be preserved by future atlas generation. -->
<!-- warroom:notes:end repo=landing -->
