# Manual Operations

War Room is an accelerator, not a dependency. Every workflow can be performed directly in the owning child repo.

## Direct Child-Repo Work

```sh
cd ../sdk
sed -n '1,220p' AGENTS.md
npm test
git status --short
```

Use the owning repo's package manager, tests, CI, and release process. Commit product changes in the owning repo.

## Repo Sync

```sh
cd ../sdk
git status --short
git fetch --prune
git pull --ff-only
```

Skip dirty repos until the work is committed, stashed, or deliberately preserved elsewhere.

## Issue Triage

```sh
gh issue view 4 --repo TeamFloPay/infra --json title,body,labels,comments
gh issue list --repo TeamFloPay/infra --state open --label needs-triage
```

Write the implementation plan back to the issue as a normal GitHub comment.

## Campaign Map

```sh
gh project field-list 1 --owner TeamFloPay
gh project item-list 1 --owner TeamFloPay --limit 100
gh project item-edit --id <item-id> --project-id <project-id> --field-id <status-field-id> --single-select-option-id <option-id>
```

Use `needs-triage`, `ready-to-engage`, `battlefield-active`, `skirmish`, `blockaded`, and `victory` as the board states.

## PR Engagement

```sh
gh issue view 4 --repo TeamFloPay/infra
git switch -c issue-4-warroom-work
npm run build
npm test
gh pr create --repo TeamFloPay/warroom
```

Confirm the owner repo, intended file areas, validation commands, and base branch before coding.

## PR Review

```sh
gh pr view 1 --repo TeamFloPay/warroom --comments
gh pr checks 1 --repo TeamFloPay/warroom
```

Handle feedback comment by comment. Reply with the outcome after validation.

## PR Merge

```sh
gh pr view 1 --repo TeamFloPay/warroom
gh pr merge 1 --repo TeamFloPay/warroom --squash --delete-branch
```

Merge only after review feedback and CI are resolved.

## Recovery

```sh
git status --short
git branch --show-current
git stash list
```

Avoid reset, clean, branch deletion, or checkout churn until the current dirty state is understood.
