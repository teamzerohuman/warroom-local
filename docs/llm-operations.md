# LLM Operations

War Room launches LLM adapters only when a command is explicitly given `--launch`, except interactive `issue next`, where selecting an issue launches the configured adapter by default, and interactive `pr review`, where confirming a detected PR launches the review loop. Without launch behavior, issue and PR commands print scoped prompts and can write local artifacts under `.warroom/runs/*`; for `issue next`, use `--dry-run` for that preview path.

Interactive `issue next` and direct `issue next --issue owner/repo#number` are implementation launches. Before launching, War Room creates and checks out a GitHub-linked development branch with `gh issue develop --checkout` so the issue, branch, and eventual PR stay connected in GitHub. The mapped checkout must be clean because the adapter runs locally in that owning child repo. The adapter is instructed to use that branch, fetching and switching to it first if the checkout is not already there. It uses the complete GitHub issue body and discussion as already-triaged context, edits the owning child repo, runs relevant validation, commits when validation passes, and includes `Closes <issue>` in the PR body. It must not stop at a preflight or create standalone planning markdown unless the issue specifically asks for product documentation.

Interactive `issue triage` is a planning-only Codex TUI session. The adapter must post final notes back to the GitHub issue with a `## War Room triage notes` heading and a standalone `Ready for ready-to-engage: yes` or `no` line. After a selected interactive session exits successfully, War Room checks for that new ready note before moving the issue to `ready-to-engage` and replacing the workflow label. If the note is missing or says `no`, the CLI leaves the issue in triage and prints the reason in the final `Outcome:`.

`pr create` is the publication step after implementation work is committed. It runs from the mapped child repo, uses the current or supplied branch, infers the linked issue from `warroom/<issue-number>-...` when possible, asks the foreground LLM adapter to generate a PR title/body from the actual branch commit log and diff unless supplied explicitly, and creates the GitHub PR only with `--confirm`. Large diffs are summarized in full through multiple adapter chunks before the final PR title/body prompt, rather than being clipped from the prompt. If the adapter fails or cannot return parseable JSON, it falls back to the local issue/commit summary.

`pr review` uses a fixed GitHub/CodeRabbit handoff. Without `--pr`, it reads Campaign PRs first; when that queue is empty, it falls back to the open PR for the current mapped child repo branch. Launched runs wait for a new PR commit after each adapter pass, wait for CodeRabbit to appear and settle on that commit, check current unresolved CodeRabbit comments, verify that handled CodeRabbit threads have `Change made:` or `Skipped:` replies, and relaunch the adapter while CodeRabbit feedback remains. Like other adapter handoffs, it runs through the local terminal adapter so it has local GitHub/CodeRabbit app access, `gh` auth, and the working PR branch remote.

## Configuration

`.env.local.example` documents safe placeholders:

```sh
LLM_ADAPTER=codex
CODEX_COMMAND=codex
CLAUDE_COMMAND=claude
```

For Codex, `CODEX_COMMAND` is the executable path only. If `codex` is not on `PATH`, set it to the bundled Codex Desktop executable, for example `/Applications/Codex.app/Contents/Resources/codex` on macOS. War Room launches implementation and review handoffs with `codex exec --model gpt-5.5 -c model_reasoning_effort="xhigh" --disable fast_mode --cd <owning-repo> -` so edits happen from the mapped child repository instead of the War Room workspace without enabling Fast Mode. Interactive issue triage launches the Codex TUI with `codex --model gpt-5.5 -c model_reasoning_effort="xhigh" --disable fast_mode --sandbox workspace-write -c sandbox_workspace_write.network_access=true --cd <owning-repo> <prompt>` so `@grill-me` questions can be answered in the terminal and read-only API checks can reach services like Stripe. Override with `CODEX_MODEL`, `CODEX_REASONING_EFFORT`, `CODEX_FAST_MODE`, `CODEX_INTERACTIVE_SANDBOX`, and `CODEX_INTERACTIVE_NETWORK_ACCESS` in `.env.local` when needed.

`LLM_ADAPTER=codex-cloud` is a deprecated alias for `codex` to keep older local `.env.local` files working. War Room no longer submits durable Codex Cloud tasks or reads `CODEX_CLOUD_ENV*` values.

Real provider keys and local secrets belong in `.env.local`, ally-specific `.env.local` files, the developer's configured MCP/tool environment, or an approved secret manager. They are never committed.

## Handoff Rules

- Include the selected issue or PR, relevant metadata, repo ownership, and validation requirements.
- Include only scoped context; do not dump whole repos by default.
- Preserve child repo boundaries and read child `AGENTS.md` before product edits.
- Pause when context is too large, feedback is circular, or the owner repo is ambiguous.

## Dry Run Examples

```sh
npm run warroom -- issue triage --issue TeamFloPay/infra#4 --write-artifact
npm run warroom -- issue next --issue TeamFloPay/infra#4 --dry-run --write-artifact
npm run warroom -- pr create --write-artifact
npm run warroom -- pr review --pr TeamFloPay/warroom#1 --write-artifact
npm run warroom -- pr merge --pr TeamFloPay/warroom#1 --issue TeamFloPay/infra#4 --write-artifact
```

Artifacts are local audit/debug files. GitHub comments should contain useful summaries, not local artifact paths.
