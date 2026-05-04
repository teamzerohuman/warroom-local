# Issue Territory

This file tracks the current known territory for the War Room foundation and SDK app split. GitHub issues remain the source of truth for execution state.

## Known Territory

| Issue | Repo | Status | Purpose |
| --- | --- | --- | --- |
| TeamFloPay/infra#4 | infra | parent epic | War Room foundation and cross-repo command center. |
| TeamFloPay/infra#11 | infra | ready | Phase-1 War Room skeleton and repo map. |
| TeamFloPay/sdk#55 | sdk | parent epic | Move docs and demo to their own repos. |
| TeamFloPay/sdk#60 | sdk | ready | Extract app repos and make them standalone. |
| TeamFloPay/sdk#59 | sdk | blocked | Clean SDK repo after app extraction. |
| TeamFloPay/infra#10 | infra | blocked | Implement SDK-to-demo local dev link after standalone demo exists. |

## Critical Path

1. Finish TeamFloPay/infra#11.
2. Implement TeamFloPay/sdk#60.
3. Unblock TeamFloPay/sdk#59 and TeamFloPay/infra#10.

## Boundary

War Room can coordinate local workflows, but product repos must remain standalone. App repos should commit normal dependency ranges and deployment configs. Local SDK linking is a local-only War Room workflow after the app split.
