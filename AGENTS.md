# Agent Instructions

These are company-level instructions for work launched from the War Room workspace.

## Precedence

Read these War Room instructions first. Before modifying a child repository, also read that child repo's `AGENTS.md` and follow its repo-specific rules.

If instructions conflict:

1. System/developer instructions from the current session win.
2. The child repository's safety and implementation rules win for files it owns.
3. These War Room instructions govern cross-repo coordination and local orchestration.

## Ownership

- War Room owns repo maps, local command orchestration, company-level agent guidance, local run artifacts, and future issue/PR workflow helpers.
- Child repositories own product source code, product CI, deployable infrastructure, package publishing, and repo-specific docs.
- Do not copy SDK, backend, app, or infra product source into War Room.
- Keep child repo checkouts under ignored `maps/repos/*`; commit product changes in the owning child repository.

## Safety

- Never perform destructive actions without explicit confirmation in the current thread.
- Destructive actions include deleting/replacing infrastructure resources, running Terraform actions that remove or recreate live resources, deleting data, force-resetting git state, cleaning dirty worktrees, deleting branches, or reverting user work.
- War Room commands must preserve work by default and print recovery instructions before suggesting any stash/reset/clean action.
- Dirty child repos must be skipped by sync/bootstrap-style commands unless the user explicitly chooses a safe action.

## Secrets

- Do not commit real secrets, tokens, private endpoints, local env values, certificates, or provider credentials.
- `.env.local` is local-only and ignored.
- `repos.yaml`, `resources.yaml`, and map docs may contain logical resource IDs, public docs URLs, and safe internal documentation paths only.

## Cross-Repo Workflow

- Use `repos.yaml` for machine-readable repo ownership and local paths.
- Use `maps/campaign-atlas.md` for the human-readable repo map and specialist context.
- Keep app repos standalone. `sdk`, `demo`, `docs`, `dashboard`, `landing`, `backend`, and `infra` must install, test, build, and deploy without cloning War Room.
- Local SDK-to-demo linking belongs in a War Room dev workflow after standalone app repos exist. Do not reintroduce committed `workspace:*` SDK dependencies into app repos.

## GitHub Project

TeamFloPay Project 1 is the Campaign Map. For now its statuses are `Todo`, `In Progress`, `Blocked`, and `Done`.

When updating issues or project state:

- Keep parent epics and implementation slices linked with comments.
- Mark work blocked when a dependency is real and current.
- Include a human-readable blocker reason.
- Avoid duplicate issues; search first.
