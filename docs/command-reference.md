# Command Reference

The War Room CLI is a local accelerator for cross-repo work. Human-readable output is the default; core commands support `--json` for agents and tests.

## Available

```sh
warroom --help
warroom doctor
warroom bootstrap --dry-run
warroom sync --report
warroom campaign status-check
warroom campaign labels
warroom campaign status --issue TeamFloPay/infra#4 --status battlefield-active
warroom maps study
warroom maps assign --check
warroom issue triage
warroom issue triage --issue TeamFloPay/infra#4 --mark-ready --write-artifact
warroom issue next
warroom issue create
warroom issue fortify
warroom pr engage --issue TeamFloPay/infra#4
warroom pr review --pr TeamFloPay/warroom#1 --issue TeamFloPay/infra#4
warroom pr merge --pr TeamFloPay/warroom#1 --issue TeamFloPay/infra#4
warroom commit create --repo sdk
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

## Safety Defaults

- `bootstrap --dry-run` previews clone actions. Without `--dry-run`, missing active repos are cloned under ignored `maps/repos/*`.
- `sync --report` does not fetch or pull. Without `--report`, sync skips dirty repos and only fast-forwards clean checkouts.
- `campaign labels --apply` creates missing repo labels only when `--confirm` is also present.
- `campaign status` previews issue status movement unless `--confirm` is present. Moving to `blockaded` requires `--reason`.
- Issue and PR handoff commands print scoped prompts by default. Add `--launch` to start the configured LLM adapter.
- Workflow status movement is guarded separately with `--confirm-status`.
- `pr merge` only merges when `--confirm` is present.
- `commit create` only commits when `--confirm` is present. `--all` is also explicit.
- `abort` never resets, cleans, checks out, or deletes branches. `--stash` requires `--confirm`.

## Command Notes

`warroom doctor` validates files, `repos.yaml`, `resources.yaml`, resource references, LLM adapter shape, local repo health, local tool availability including `gh`, and Campaign Map label presence. Label fixes are printed as a reviewed create plan; doctor does not mutate labels.

`warroom campaign status-check` validates the Campaign Map Status field options: `needs-triage`, `ready-to-engage`, `battlefield-active`, `skirmish`, `blockaded`, and `victory`.

`warroom campaign labels` checks matching workflow labels across mapped repos. Add `--apply --confirm` to create missing labels.

`warroom campaign status` previews or applies issue movement on the Campaign Map. Use `--confirm` to mutate the board.

`warroom maps assign` validates or updates Sergeant/resource assignments. Use `--repo`, `--sergeant`, `--add-resource`, and `--remove-resource` for targeted edits. Pass `--write` to update `repos.yaml` and regenerate `maps/campaign-atlas.md`; protected notes blocks are preserved.

`warroom issue triage` lists Campaign Map items in `needs-triage`. If the project query returns no items, it falls back to open issues with the `needs-triage` label. With `--issue owner/repo#number`, it builds a scoped handoff prompt and can write `.warroom/runs/*` artifacts. Add `--mark-ready --confirm-status` after a successful triage to move the issue to `ready-to-engage`.

`warroom issue next` lists Campaign Map items in `ready-to-engage`. If the project query returns no items, it falls back to open issues with the `ready-to-engage` label.

`warroom issue create` and `warroom issue fortify` are explicit post-MVP placeholders tracked by TeamFloPay/infra#7.

`warroom pr engage`, `warroom pr review`, and `warroom pr merge` provide preflight plans and scoped handoffs. `pr engage --confirm-status` moves the issue to `battlefield-active`; `pr review --issue ... --confirm-status` moves it to `skirmish`; `pr merge --issue ... --confirm-status` moves it to `victory`. Full code-writing automation remains human-directed through the launched adapter.

`warroom commit create` inspects a mapped child repo, proposes a conventional commit message, and refuses to proceed when other child repos are dirty.

`warroom abort` prints recovery commands for every mapped checkout and preserves work by default.

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
