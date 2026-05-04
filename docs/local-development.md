# Local Development

War Room is a parent workspace for local coordination. It is not required to build or deploy product repositories.

## Install

```sh
npm install
npm run build
npm test
```

## Child Repos

Child repositories should be checked out under `maps/repos/*` by future bootstrap/sync commands. That directory is ignored because child repos commit their work independently.

For phase 1, clone child repos manually only if needed:

```sh
git clone git@github.com:TeamFloPay/sdk.git maps/repos/sdk
git clone git@github.com:TeamFloPay/backend.git maps/repos/backend
git clone git@github.com:TeamFloPay/infra.git maps/repos/infra
```

App repos are planned by TeamFloPay/sdk#60 and may not exist yet.

## SDK-To-Demo Linking

The local SDK-to-demo workflow is not part of phase 1. It is tracked by TeamFloPay/infra#10 and should be implemented after `TeamFloPay/demo` exists as a standalone repository.
