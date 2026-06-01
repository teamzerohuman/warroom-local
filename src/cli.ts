#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runAbort, type AbortResult } from './commands/abort.js';
import { runAlliesStatus, type AlliesStatus } from './commands/allies.js';
import { runBootstrap, type BootstrapResult } from './commands/bootstrap.js';
import {
  runSetup,
  scaffoldFromExample,
  regenerateAtlas,
  readManifestDefaults,
  writeRepoManifestFromInputs,
  SCAFFOLD_TARGETS,
  type RepoDefaultsInput,
  type RepoInput,
  type SetupResult,
} from './commands/setup.js';
import { runCampaignStatus, runCampaignStatusCheck } from './commands/campaign.js';
import { runCommitCreate, type CommitCreateResult } from './commands/commit-create.js';
import {
  isDevLinkAvailable,
  linkSdkToDemo,
  runDevStatus,
  type DevActionResult,
  type DevStatus,
  unlinkSdkFromDemo,
} from './commands/dev-link.js';
import { runDoctor } from './commands/doctor.js';
import {
  confirmIssueCreate,
  parseIssueRef,
  runIssueCreate,
  runIssueFeedback,
  runIssueNext,
  runIssueTriage,
  type IssueCreateResult,
  type IssueFeedbackResult,
  type IssueHandoffResult,
  type IssueListResult,
  type IssueSummary,
} from './commands/issues.js';
import { resolveAllyIssueRepo } from './lib/allies.js';
import { ownerRepoFromText } from './lib/issue-links.js';
import { runMapsAssign, type MapsAssignResult } from './commands/maps-assign.js';
import { runMapsStudy } from './commands/maps-study.js';
import {
  findOpenPrForBranch,
  inferCurrentBranchContext,
  inferIssueRefForCurrentBranch,
  inferPrRefForCurrentBranch,
  runIssueStart,
  runMergeE2E,
  runPrCreate,
  runPrMerge,
  runPrReview,
  runPrReviewQueue,
  type ChangelogDecision,
  type LocalCleanupResult,
  type MergeBumpResult,
  type MergeChangelogResult,
  type MergeE2EResult,
  type MergePostMergeResult,
  type PrCreateResult,
  type PrPlanResult,
  type PrReviewQueueResult,
  type SummaryPostResult,
  type VersionBumpChoice,
} from './commands/pr.js';
import {
  buildSlackBlocks,
  postToSlack,
  reviseChangelogContent,
  runChangelogShare,
  loadChangelogDraft,
  saveChangelogDraft,
  clearChangelogDraft,
  resumeChangelogShare,
  captureInteractiveEditNotes,
  recordChangelogShareSent,
  PERIOD_LABEL,
  type ChangelogPeriod,
  type ChangelogShareResult,
  type SlackPostResult,
} from './commands/changelog-share.js';
import { runSync, type SyncResult } from './commands/sync.js';
import { CAMPAIGN_STATUSES, resetCampaignCache, type CampaignStatusName } from './lib/campaign.js';
import { readWorkspaceEnvVar } from './lib/env.js';
import { formatLlmUsageSummary, refreshIssueUsageLedgerCosts, summarizeIssueUsage, type LlmUsageSummary } from './lib/llm-usage.js';
import { pickCommandPath } from './lib/interactive-menu.js';
import { selectChoice } from './lib/prompt.js';
import { loadRepoManifest, runGit } from './lib/repos.js';
import { findWarRoomRoot, findWarRoomWorkspace } from './lib/workspace.js';

type Output = (text: string) => void;
type Input = NodeJS.ReadableStream & { isTTY?: boolean };
type E2EOutput = (chunk: string, stream: 'stdout' | 'stderr') => void;
type BuildProgramOptions = {
  cwd?: string;
  output?: Output;
  input?: Input;
  interactive?: boolean;
};

const OUTCOME_SEPARATOR = '-----------------------------------------';
const DEV_LINK_UNAVAILABLE =
  'SDK-to-demo dev link is not configured for this project. Set defaults.npm_scope and defaults.dev_link_packages in repos.yaml and map `sdk` and `demo` repos.';

function printJson(output: Output, value: unknown) {
  output(JSON.stringify(value, null, 2));
}

function printOutcome(output: Output, outcome: string) {
  output(OUTCOME_SEPARATOR);
  output(outcome);
  output(OUTCOME_SEPARATOR);
}

function printNotImplemented(output: Output, command: string, issue: string) {
  output(`${command} is not implemented in phase 1. Track it in ${issue}.`);
}

function collect(value: string, previous: string[]) {
  previous.push(value);
  return previous;
}

function printBootstrap(output: Output, result: BootstrapResult) {
  output(`War Room bootstrap: ${result.ok ? 'ok' : 'needs attention'}${result.dryRun ? ' (dry run)' : ''}`);
  for (const tool of result.tools) {
    output(`${tool.ok ? 'ok' : 'missing'} ${tool.name}${tool.detail ? ` (${tool.detail})` : ''}`);
  }
  for (const repo of result.repos) {
    output(`${repo.state} ${repo.repo} -> ${repo.path}${repo.detail ? ` (${repo.detail})` : ''}`);
  }
  output(`Resource proposals: ${result.resourceProposals.length}${result.proposalsApplied ? ' (applied)' : ''}`);
  for (const proposal of result.resourceProposals) {
    output(`proposal ${proposal.action} ${proposal.repo}:${proposal.resource} (${proposal.reason})`);
  }
}

function printSync(output: Output, result: SyncResult) {
  output(`War Room sync: ${result.ok ? 'ok' : 'needs attention'}${result.reportOnly ? ' (report only)' : ''}`);
  for (const repo of result.repos) {
    output(`${repo.state} ${repo.repo} ${repo.branch ?? 'no-branch'}@${repo.headSha ?? 'unknown'} -> ${repo.path}`);
    if (repo.detail) output(repo.detail);
  }
}

function printSetup(output: Output, result: SetupResult) {
  output(`War Room setup: ${result.ok ? 'ok' : 'needs attention'}${result.initializedBefore ? '' : ' (initializing)'}`);
  for (const action of result.scaffolded) {
    output(`${action.state} ${action.target}${action.detail ? ` (${action.detail})` : ''}`);
  }
  output(`Campaign atlas: ${result.atlas.state}${result.atlas.detail ? ` (${result.atlas.detail})` : ''}`);
}

async function promptRepoEntries(
  output: Output,
  input: Input,
  defaults: RepoDefaultsInput
): Promise<RepoInput[]> {
  const repos: RepoInput[] = [];
  for (;;) {
    const more = repos.length === 0
      ? await promptConfirmation(output, input, 'Add a repo to the manifest now? [Y/n]')
      : await promptConfirmation(output, input, `Added ${repos.length} repo(s). Add another? [Y/n]`);
    if (!more) break;

    const id = await promptText(output, input, 'Repo id (short slug, e.g. "backend"):');
    if (!id) {
      output('Skipped: a repo id is required.');
      continue;
    }
    const github = await promptText(output, input, `GitHub slug [${defaults.owner}/${id}]:`);
    const description = await promptText(output, input, 'One-line description (optional):');
    const sergeant = await promptText(output, input, `Sergeant name [${id} Sergeant]:`);
    const status = await selectChoice<'active' | 'planned'>({
      output,
      input,
      question: 'Status: active (cloned by bootstrap) or planned (skipped)?',
      default: 'active',
      choices: [
        { label: 'Active', value: 'active', aliases: ['a'] },
        { label: 'Planned', value: 'planned', aliases: ['p'] },
      ],
      retryHelp: 'Enter active or planned.',
    });

    repos.push({
      id,
      github: github || undefined,
      description: description || undefined,
      sergeant: sergeant || undefined,
      status,
    });
    output(`Queued ${github || `${defaults.owner}/${id}`} (${status}).`);
  }
  return repos;
}

async function runInteractiveSetup(
  workspaceRoot: string,
  output: Output,
  input: Input,
  opts: { force?: boolean }
) {
  output('War Room setup — generating project-specific config from templates.');
  output('');

  // 1. repos.yaml — the required manifest.
  const reposPath = path.join(workspaceRoot, 'repos.yaml');
  if (existsSync(reposPath) && !opts.force) {
    output('repos.yaml already exists — leaving it unchanged (use --force to rebuild).');
  } else {
    const mode = await selectChoice<'interactive' | 'template' | 'skip'>({
      output,
      input,
      question: 'Build repos.yaml interactively, copy the example template, or skip?',
      default: 'interactive',
      choices: [
        { label: 'Build interactively', value: 'interactive', aliases: ['i', 'build'] },
        { label: 'Copy example template', value: 'template', aliases: ['t', 'copy', 'example'] },
        { label: 'Skip', value: 'skip', aliases: ['s'] },
      ],
      retryHelp: 'Enter interactive, template, or skip.',
    });

    if (mode === 'template') {
      const action = scaffoldFromExample(workspaceRoot, 'repos.yaml', 'repos.example.yaml', true);
      output(`${action.state} repos.yaml${action.detail ? ` (${action.detail})` : ''} — edit it, then re-run setup or \`warroom bootstrap\`.`);
    } else if (mode === 'interactive') {
      const exampleDefaults = readManifestDefaults(workspaceRoot) ?? {
        owner: 'your-org',
        clone_protocol: 'ssh',
        default_branch: 'main',
        local_root: 'maps/repos',
      };
      const owner = (await promptText(output, input, `GitHub owner/org [${exampleDefaults.owner}]:`)) || exampleDefaults.owner;
      const protocol = await selectChoice<'ssh' | 'https'>({
        output,
        input,
        question: 'Clone protocol?',
        default: exampleDefaults.clone_protocol === 'https' ? 'https' : 'ssh',
        choices: [
          { label: 'SSH', value: 'ssh' },
          { label: 'HTTPS', value: 'https' },
        ],
        retryHelp: 'Enter ssh or https.',
      });
      const defaultBranch = (await promptText(output, input, `Default branch [${exampleDefaults.default_branch}]:`)) || exampleDefaults.default_branch;
      const defaults: RepoDefaultsInput = {
        owner,
        clone_protocol: protocol,
        default_branch: defaultBranch,
        local_root: exampleDefaults.local_root || 'maps/repos',
      };

      const repos = await promptRepoEntries(output, input, defaults);
      try {
        writeRepoManifestFromInputs(workspaceRoot, defaults, repos);
        output(`Wrote repos.yaml with ${repos.length} repo(s).`);
      } catch (error) {
        output(`Failed to write a valid repos.yaml: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else {
      output('Skipped repos.yaml — War Room needs it before other commands work.');
    }
  }

  // 2. Optional companion files, scaffolded from templates if missing.
  for (const entry of SCAFFOLD_TARGETS) {
    if (entry.target === 'repos.yaml') continue;
    const targetPath = path.join(workspaceRoot, entry.target);
    if (existsSync(targetPath) && !opts.force) continue;
    if (!existsSync(path.join(workspaceRoot, entry.example))) continue;
    const create = await promptConfirmation(output, input, `Create ${entry.target} from ${entry.example}? [Y/n]`);
    if (!create) continue;
    const action = scaffoldFromExample(workspaceRoot, entry.target, entry.example, opts.force);
    output(`${action.state} ${entry.target}${action.detail ? ` (${action.detail})` : ''}`);
  }

  // 3. Campaign atlas, generated from the finished manifest.
  if (existsSync(reposPath)) {
    const regen = await promptConfirmation(output, input, 'Generate maps/campaign-atlas.md from repos.yaml now? [Y/n]');
    if (regen) {
      const atlas = regenerateAtlas(workspaceRoot);
      output(`Campaign atlas: ${atlas.state}${atlas.detail ? ` (${atlas.detail})` : ''}`);
    }
  }

  // 4. Offer to clone the active repos.
  if (existsSync(reposPath)) {
    const clone = await promptConfirmation(output, input, 'Clone active repos now (runs `warroom bootstrap`)? [y/N]');
    if (clone) {
      const result = runBootstrap(workspaceRoot, {});
      printBootstrap(output, result);
    } else {
      output('Run `warroom bootstrap` later to clone the mapped repos.');
    }
  }

  output('');
  output('Setup complete. Next: `warroom doctor` to validate the workspace.');
}

function printAlliesStatus(output: Output, result: AlliesStatus) {
  output(`Allies: ${result.ok ? 'ok' : 'needs attention'} (${result.activeAllyCount} active, ${result.plannedAllyCount} planned)`);
  for (const ally of result.allies) {
    const issueRepo = ally.issueRepoCheckedOut
      ? `issue repo present${ally.issueRepoClean === false ? ', dirty' : ally.issueRepoClean === true ? ', clean' : ''}`
      : 'issue repo missing';
    output(
      `${ally.id}: ${ally.status}, docs ${ally.sharedDocsOk ? 'ok' : 'missing'}, labels ${ally.labels.missing.length === 0 && ally.labels.checked ? 'ok' : 'missing'}, env ${ally.envLocalExists ? 'present' : 'missing'}, ${issueRepo} -> ${ally.localPath}`
    );
    if (!ally.envExampleExists) output(`missing env example: ${ally.envExamplePath}`);
    for (const doc of ally.docsStatus.filter((entry) => !entry.exists)) output(`missing doc: ${doc.path}`);
    if (ally.labels.error) output(`label check failed: ${ally.labels.error}`);
    for (const label of ally.labels.missing) output(`missing ally label: ${ally.issue_repo.github}:${label}`);
  }
}

function printMapsAssign(output: Output, result: MapsAssignResult) {
  output(`Campaign atlas: ${result.atlasMatches ? 'up to date' : 'needs regeneration'}`);
  output(`Resource references: ${result.resourceReferencesOk ? 'ok' : 'missing references'}`);
  for (const missing of result.missingResources) output(`missing ${missing.resource} referenced by ${missing.repo}`);
  for (const message of result.messages) output(message);
}

function printIssueList(output: Output, result: IssueListResult, options: { numbered?: boolean } = {}) {
  const selector = `Campaign status ${result.status}`;
  const repo = result.repo ? ` for ${result.repo}` : '';
  output(`Issues with ${selector}${repo}: ${result.issues.length}`);
  result.issues.forEach((issue, index) => {
    const prefix = options.numbered ? `${index + 1}. ` : '';
    output(`${prefix}${issue.repo}#${issue.number} ${issue.title} ${issue.url}`);
  });
}

async function ensureAllyImplementationRepo(
  workspaceRoot: string,
  output: Output,
  input: Input,
  interactive: boolean,
  issueRef: string
): Promise<boolean> {
  let ref;
  try {
    ref = parseIssueRef(issueRef);
  } catch {
    return true;
  }

  const allyResolution = resolveAllyIssueRepo(workspaceRoot, ref.repo);
  if (!allyResolution) return true;

  const result = spawnSync(
    'gh',
    ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'body,comments'],
    { encoding: 'utf8' }
  );
  let issue: { body?: string; comments?: Array<{ body?: string }> } = {};
  if (result.status === 0 && result.stdout.trim()) {
    try {
      issue = JSON.parse(result.stdout);
    } catch {
      issue = {};
    }
  }

  const candidates = [
    ...(issue.comments ?? []).slice().reverse().map((comment) => ownerRepoFromText(comment.body)),
    ownerRepoFromText(issue.body),
  ].filter((repo): repo is string => Boolean(repo));

  const manifest = loadRepoManifest(workspaceRoot);
  const isMapped = (repo: string) => manifest.repos.some((entry) => entry.github === repo);
  if (candidates.some(isMapped)) return true;

  if (!interactive) {
    output(
      `Ally issue ${ref.repo}#${ref.number} has no implementation repo declared. Re-run interactively, or add a comment like \`Owner repo: <owner>/<mapped-repo>\` on the issue.`
    );
    return false;
  }

  const activeRepos = manifest.repos.filter((repo) => repo.status === 'active');
  if (activeRepos.length === 0) {
    output('repos.yaml has no active mapped repos to choose from.');
    return false;
  }

  output(
    `Ally issue ${ref.repo}#${ref.number} does not declare an implementation repo. Pick the repo where work will happen:`
  );
  const cancelSentinel = '__cancel__';
  const choice = await selectChoice<string>({
    output,
    input,
    question: 'Implementation repo:',
    default: activeRepos[0]!.github,
    choices: [
      ...activeRepos.map((repo) => ({
        label: `${repo.github} — ${repo.description}`,
        value: repo.github,
        aliases: [repo.id, repo.github.split('/')[1] ?? repo.id],
      })),
      { label: 'Cancel', value: cancelSentinel, aliases: ['cancel', 'q', 'quit', '0'] },
    ],
    retryHelp: 'Choose a mapped repo by label, id, or cancel.',
  });

  if (choice === cancelSentinel) {
    output('No implementation repo selected.');
    return false;
  }

  const body = `Owner repo: ${choice}`;
  const post = spawnSync(
    'gh',
    ['issue', 'comment', String(ref.number), '--repo', ref.repo, '--body', body],
    { encoding: 'utf8' }
  );
  if (post.status !== 0) {
    output(
      `Failed to post Owner repo comment on ${ref.repo}#${ref.number}: ${(post.stderr || post.stdout).trim()}`
    );
    return false;
  }
  output(`Posted "Owner repo: ${choice}" comment on ${ref.repo}#${ref.number}.`);
  return true;
}

async function promptIssueSelection(output: Output, input: Input, issues: IssueSummary[], action = 'start') {
  if (issues.length === 0) return null;

  const cancelSentinel = '__cancel__';
  const choice = await selectChoice<IssueSummary | typeof cancelSentinel>({
    output,
    input,
    question: `Select an issue to ${action}:`,
    default: issues[0]!,
    choices: [
      ...issues.map((issue, index) => ({
        label: `${index + 1}. ${issue.repo}#${issue.number} ${issue.title}`,
        value: issue as IssueSummary | typeof cancelSentinel,
        aliases: [String(index + 1), `${issue.repo}#${issue.number}`, `#${issue.number}`],
      })),
      { label: 'Cancel', value: cancelSentinel, aliases: ['0', 'q', 'quit', 'cancel'] },
    ],
    retryHelp: `Enter a number from 1 to ${issues.length}, or 0 to cancel.`,
  });

  return choice === cancelSentinel ? null : choice;
}

function prReviewRef(pr: PrReviewQueueResult['prs'][number]) {
  return `${pr.repo}#${pr.number}`;
}

function primaryIssueRef(pr: PrReviewQueueResult['prs'][number]) {
  const issue = pr.issues[0];
  return issue ? `${issue.repo}#${issue.number}` : undefined;
}

function shouldConfirmPrReviewStatus(dryRun: boolean, options: { confirmStatus?: boolean; status?: boolean }) {
  return dryRun ? options.confirmStatus === true : options.status !== false || options.confirmStatus === true;
}

async function promptPrReviewSelection(output: Output, input: Input, prs: PrReviewQueueResult['prs']) {
  if (prs.length === 0) return null;

  if (prs.length === 1) {
    const pr = prs[0];
    if (!pr) return null;
    output(`Starting PR review handoff for ${prReviewRef(pr)}...`);
    return pr;
  }

  type PrChoice = PrReviewQueueResult['prs'][number];
  const cancelSentinel = '__cancel__';
  const choice = await selectChoice<PrChoice | typeof cancelSentinel>({
    output,
    input,
    question: 'Select a PR to review:',
    default: prs[0]!,
    choices: [
      ...prs.map((pr, index) => ({
        label: `${index + 1}. ${prReviewRef(pr)} ${pr.title ?? ''}`.trim(),
        value: pr as PrChoice | typeof cancelSentinel,
        aliases: [String(index + 1), prReviewRef(pr), `#${pr.number}`],
      })),
      { label: 'Cancel', value: cancelSentinel, aliases: ['0', 'q', 'quit', 'cancel'] },
    ],
    retryHelp: `Enter a number from 1 to ${prs.length}, or 0 to cancel.`,
  });

  return choice === cancelSentinel ? null : choice;
}

async function promptConfirmation(output: Output, input: Input, question: string) {
  return selectChoice<boolean>({
    output,
    input,
    question,
    default: true,
    choices: [
      { label: 'Yes', value: true, aliases: ['y'] },
      { label: 'No', value: false, aliases: ['n'] },
    ],
    retryHelp: 'Enter yes or no.',
  });
}

async function promptPrMergeOrReviewAgain(
  output: Output,
  input: Input,
  question: string
): Promise<'merge' | 'review-again' | 'cancel'> {
  return selectChoice<'merge' | 'review-again' | 'cancel'>({
    output,
    input,
    question,
    default: 'merge',
    choices: [
      { label: 'Yes', value: 'merge', aliases: ['y'] },
      { label: 'No', value: 'cancel', aliases: ['n'] },
      { label: 'Review Again', value: 'review-again', aliases: ['r', 'review', 'again'] },
    ],
    retryHelp: 'Enter yes to merge, no to cancel, or review-again to rerun PR review.',
  });
}

async function promptText(output: Output, input: Input, question: string): Promise<string> {
  output(question);
  // readline.close() pauses stdin; resume it so the next interface can read
  (input as NodeJS.ReadStream).resume?.();
  const readline = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      return line.trim();
    }
  } finally {
    readline.close();
  }
  return '';
}


async function promptMergeConfirmation(output: Output, input: Input, question: string): Promise<'confirm' | 'skip' | 'cancel'> {
  return selectChoice<'confirm' | 'skip' | 'cancel'>({
    output,
    input,
    question,
    default: 'confirm',
    choices: [
      { label: 'Yes', value: 'confirm', aliases: ['y'] },
      { label: 'No', value: 'cancel', aliases: ['n'] },
      { label: 'Skip', value: 'skip', aliases: ['s'] },
    ],
    retryHelp: 'Enter yes to run the gate, skip to merge without Playwright, or no to cancel.',
  });
}

async function promptBlockedMergeConfirmation(output: Output, input: Input, question: string): Promise<'confirm' | 'skip' | 'cancel'> {
  return selectChoice<'confirm' | 'skip' | 'cancel'>({
    output,
    input,
    question,
    default: 'confirm',
    choices: [
      { label: 'Yes', value: 'confirm', aliases: ['y'] },
      { label: 'No', value: 'cancel', aliases: ['n'] },
      { label: 'Skip', value: 'skip', aliases: ['s'] },
    ],
    retryHelp: 'Enter yes to recheck blockers, skip to bypass failing checks and unresolved threads (gh pr merge --admin), or no to cancel.',
  });
}

async function promptMergeChangelogConfirmation(
  output: Output,
  input: Input,
  plan: MergeChangelogResult
): Promise<ChangelogDecision> {
  const target =
    plan.changelogFormat === 'openchangelog'
      ? `create one public OpenChangelog release note under ${plan.changelogPath ?? 'the configured release-notes folder'}`
      : `update ${plan.changelogPath ?? 'the configured changelog file'}`;
  const choice = await selectChoice<'create' | 'skip' | 'existing'>({
    output,
    input,
    question: `Run the public changelog update now (${target})?`,
    default: 'create',
    choices: [
      { label: 'Yes', value: 'create', aliases: ['y'] },
      { label: 'No', value: 'skip', aliases: ['n'] },
      { label: 'Use existing file', value: 'existing', aliases: ['e', 'existing', 'use existing', 'use existing file'] },
    ],
    retryHelp: 'Enter yes to generate a new changelog, no to skip, or "use existing file" to provide a path to a pre-written file.',
  });

  if (choice !== 'existing') return { kind: choice };

  for (;;) {
    const raw = await promptText(output, input, 'Paste the path to the existing changelog file (or leave blank to cancel):');
    if (!raw) return { kind: 'skip' };
    const absolutePath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    if (!existsSync(absolutePath)) {
      output(`File not found: ${absolutePath}`);
      continue;
    }
    if (!statSync(absolutePath).isFile()) {
      output(`Not a file: ${absolutePath}`);
      continue;
    }
    try {
      const content = readFileSync(absolutePath, 'utf8');
      if (!content.trim()) {
        output(`File is empty: ${absolutePath}`);
        continue;
      }
      return { kind: 'existing', filePath: absolutePath, content };
    } catch (error) {
      output(`Could not read ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
  }
}

async function promptMergeChangelogPushConfirmation(output: Output, input: Input, plan: MergeChangelogResult) {
  const filePath = plan.path && plan.changelogFile ? path.join(plan.path, plan.changelogFile) : plan.changelogPath ?? 'the changelog file';
  output(`Changelog committed locally at ${filePath}. Edit the file now if you want to tweak it before publishing.`);
  return promptConfirmation(output, input, 'Should we push the ChangeLog live? [Y/n]');
}

function parseVersionBumpChoice(value: string | undefined): VersionBumpChoice | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['patch', 'minor', 'major', 'skip'].includes(normalized)) return normalized as VersionBumpChoice;
  throw new Error('Version bump must be one of: patch, minor, major, skip.');
}

async function promptMergeBumpChoice(output: Output, input: Input, _plan: MergeBumpResult): Promise<VersionBumpChoice> {
  return selectChoice<VersionBumpChoice>({
    output,
    input,
    question: 'Should we bump the version number? [PATCH|minor|major|skip]',
    default: 'patch',
    choices: [
      { label: 'Patch', value: 'patch' },
      { label: 'Minor', value: 'minor' },
      { label: 'Major', value: 'major' },
      { label: 'Skip', value: 'skip' },
    ],
    retryHelp: 'Enter patch, minor, major, skip, or press Enter for patch.',
  });
}

function createE2EOutput(output: Output, customOutput: boolean): E2EOutput {
  if (!customOutput) {
    return (chunk, stream) => {
      const target = stream === 'stderr' ? process.stderr : process.stdout;
      target.write(chunk);
    };
  }

  return (chunk) => {
    const normalized = chunk.replace(/\r/g, '\n').trimEnd();
    if (!normalized) return;
    for (const line of normalized.split('\n')) output(line);
  };
}

function printIssueHandoff(output: Output, result: IssueHandoffResult, options: { suppressOutcome?: boolean } = {}) {
  output(`Adapter: ${result.adapterCommand}${result.launched ? ' (launched)' : ' (not launched)'}`);
  if (result.launchError) output(`Adapter error: ${result.launchError}`);
  if (result.artifact) output(`Artifact: ${result.artifact.runDir}`);
  if (result.contextSummary) {
    output(`Context size: ${result.contextSummary.promptCharacters} chars`);
    if (result.contextSummary.changedFiles !== undefined) output(`Changed files: ${result.contextSummary.changedFiles}`);
    if (result.contextSummary.comments !== undefined) output(`Comments: ${result.contextSummary.comments}`);
    if (result.contextSummary.reviews !== undefined) output(`Reviews: ${result.contextSummary.reviews}`);
    if (result.contextSummary.checks !== undefined) output(`Checks: ${result.contextSummary.checks}`);
    if (result.contextSummary.checkInMinutes !== undefined) output(`Check-in: ${result.contextSummary.checkInMinutes} minutes`);
  }
  if (result.campaignStatus) {
    output(`Campaign status: ${result.campaignStatus.applied ? 'updated' : 'planned'} ${result.campaignStatus.issue} -> ${result.campaignStatus.status}`);
  }
  if (result.triageNotes) {
    const notes = result.triageNotes;
    output(
      `Triage notes: ${notes.found ? notes.ready ? 'ready' : 'not ready' : 'missing'}${notes.commentUrl ? ` ${notes.commentUrl}` : ''}`
    );
    if (notes.reason) output(`triage notes reason: ${notes.reason}`);
    if (notes.error) output(`triage notes error: ${notes.error}`);
  }
  if (result.closeoutError) output(`triage closeout error: ${result.closeoutError}`);
  output(result.prompt);
  if (!options.suppressOutcome) printOutcome(output, issueTriageOutcome(result));
}

function issueTriageOutcome(result: IssueHandoffResult) {
  const status = result.campaignStatus
    ? result.campaignStatus.applied
      ? ` Campaign status updated to ${result.campaignStatus.status}.`
      : ` Campaign status not updated; planned ${result.campaignStatus.issue} -> ${result.campaignStatus.status}.`
    : '';

  if (result.launchError) {
    return 'Outcome: issue triage handoff blocked. Resolve the adapter error above, then rerun the issue triage command.';
  }

  if (result.launched) {
    if (result.closeoutError) {
      const targetStatus = result.campaignStatus?.status ?? 'ready-to-engage';
      return `Outcome: interactive issue triage session completed, but ${targetStatus} closeout was blocked. ${result.closeoutError}`;
    }
    if (result.triageNotes && !result.triageNotes.ready && !result.triageNotes.found) {
      return `Outcome: interactive issue triage session completed, but Campaign status was not updated. ${result.triageNotes.reason ?? 'Triage notes were not posted.'}`;
    }
    if (result.triageNotes && !result.triageNotes.ready && result.campaignStatus?.status === 'blockaded') {
      const reason = result.triageNotes.reason ?? 'Triage notes marked the issue as not ready for ready-to-engage.';
      return `Outcome: interactive issue triage session completed.${status} ${reason}`;
    }
    return `Outcome: interactive issue triage session completed.${status}`;
  }

  return `Outcome: dry run only; no LLM handoff was launched.${status}`;
}

function issueCreateOutcome(result: IssueCreateResult) {
  if (result.launchError) {
    return 'Outcome: issue create session blocked. Resolve the adapter error above, then rerun `warroom issue create`.';
  }
  if (result.draftError && !result.created) {
    return `Outcome: issue not created. ${result.draftError}`;
  }
  if (result.created) {
    const warnings = [
      ...result.draftWarnings.map((warning) => `draft warning: ${warning}`),
      result.closeoutError ? `closeout warning: ${result.closeoutError}` : null,
      result.issueTypeUpdate?.error ? `issue type warning: ${result.issueTypeUpdate.error}` : null,
    ].filter((warning): warning is string => Boolean(warning));
    return warnings.length
      ? `Outcome: issue created with follow-up warnings. ${warnings.join(' ')}`
      : 'Outcome: issue created and queued for triage.';
  }
  if (result.draft) {
    return 'Outcome: issue draft ready; confirm creation to post it to GitHub.';
  }
  return 'Outcome: dry run only; no issue create session was launched.';
}

function printIssueCreate(output: Output, result: IssueCreateResult) {
  output(`Issue create: ${result.created ? 'created' : result.draft ? 'draft ready' : result.launched ? 'blocked' : 'dry run'}`);
  output(`Adapter: ${result.adapterCommand}${result.launched ? ' (launched)' : ' (not launched)'}`);
  if (result.launchError) output(`Adapter error: ${result.launchError}`);
  if (result.artifact) output(`Artifact: ${result.artifact.runDir}`);
  if (result.draftPath) output(`Draft file: ${result.draftPath}`);
  output(`Context size: ${result.contextSummary.promptCharacters} chars`);
  if (result.draftError) output(`Draft error: ${result.draftError}`);
  for (const warning of result.draftWarnings) output(`Draft warning: ${warning}`);
  if (result.draft) {
    output(`Repo: ${result.draft.repo}`);
    output(`Title: ${result.draft.title}`);
    output(`Issue type: ${result.draft.issueType ?? 'none'}`);
    output(`Labels: ${result.draft.labels.length ? result.draft.labels.join(', ') : 'none'}`);
    if (result.draft.assignees.length) output(`Assignees: ${result.draft.assignees.join(', ')}`);
    if (result.draft.milestone) output(`Milestone: ${result.draft.milestone}`);
    if (result.createCommand) output(`Create: ${result.created ? 'created' : 'planned'} ${result.createCommand}`);
    output(result.draft.body);
  } else if (!result.launched) {
    output(result.prompt);
  }
  if (result.url) output(`URL: ${result.url}`);
  if (result.issueTypeUpdate) {
    output(
      `Issue type: ${result.issueTypeUpdate.applied ? 'updated' : 'failed'} ${result.issueTypeUpdate.issue} -> ${result.issueTypeUpdate.type}`
    );
    if (result.issueTypeUpdate.error) output(`issue type error: ${result.issueTypeUpdate.error}`);
  }
  if (result.campaignStatus) {
    output(`Campaign status: ${result.campaignStatus.applied ? 'updated' : 'planned'} ${result.campaignStatus.issue} -> ${result.campaignStatus.status}`);
  }
  if (result.closeoutError) output(`issue closeout error: ${result.closeoutError}`);
  printOutcome(output, issueCreateOutcome(result));
}

function formatFeedbackPost(post: { applied: boolean; ref: string; url: string | null; reason: string | null; error: string | null } | null) {
  if (!post) return 'not posted';
  if (post.applied) return `posted ${post.ref}${post.url ? ` ${post.url}` : ''}`;
  if (post.error) return `failed ${post.ref}: ${post.error}`;
  return `planned ${post.ref}${post.reason ? ` (${post.reason})` : ''}`;
}

function printIssueFeedback(output: Output, result: IssueFeedbackResult) {
  output(`Issue feedback for ${result.issue}: ${issueFeedbackState(result)}`);
  output(`Mode: ${result.mode === 'adapter' ? 'interactive LLM intake' : 'direct (--body/--file)'}`);
  output(`Marker: ${result.marker}`);
  if (result.prRef) output(`Related PR: ${result.prRef}`);
  if (result.adapterCommand) {
    output(`Adapter: ${result.adapterCommand}${result.launched ? ' (launched)' : ' (not launched)'}`);
  }
  if (result.adapterCwd) output(`Adapter cwd: ${result.adapterCwd}`);
  if (result.launchError) output(`Adapter error: ${result.launchError}`);
  if (result.artifact) output(`Artifact: ${result.artifact.runDir}`);
  if (result.contextSummary.promptCharacters !== null) {
    output(`Prompt size: ${result.contextSummary.promptCharacters} chars`);
  }
  if (result.contextSummary.feedbackCharacters !== null) {
    output(`Feedback size: ${result.contextSummary.feedbackCharacters} chars`);
  }
  if (result.feedbackNotes) {
    const notes = result.feedbackNotes;
    output(
      `Issue feedback comment: ${notes.foundIssueComment ? 'posted' : 'missing'}${notes.issueCommentUrl ? ` ${notes.issueCommentUrl}` : ''}`
    );
    if (notes.expectedPrComment) {
      output(
        `PR feedback comment: ${notes.foundPrComment ? 'posted' : 'missing'}${notes.prCommentUrl ? ` ${notes.prCommentUrl}` : ''}`
      );
    }
    if (notes.reason) output(`feedback notes reason: ${notes.reason}`);
    if (notes.error) output(`feedback notes error: ${notes.error}`);
  }
  if (result.issueComment) output(`Issue comment: ${formatFeedbackPost(result.issueComment)}`);
  if (result.prComment) output(`PR comment: ${formatFeedbackPost(result.prComment)}`);
  if (result.formattedBody) {
    output('');
    output('--- comment body ---');
    output(result.formattedBody);
    output('--- end comment body ---');
  }
  printOutcome(output, issueFeedbackOutcome(result));
}

function issueFeedbackState(result: IssueFeedbackResult) {
  if (result.mode === 'direct') {
    if (!result.issueComment) return 'preflight only';
    if (result.issueComment.applied) return 'posted';
    if (result.issueComment.error) return 'failed';
    return 'preflight only';
  }
  if (!result.launched) {
    return result.prompt ? 'preflight only' : 'blocked';
  }
  if (result.feedbackNotes?.foundIssueComment) {
    return result.feedbackNotes.expectedPrComment && !result.feedbackNotes.foundPrComment
      ? 'posted (PR cross-post missing)'
      : 'posted';
  }
  return 'adapter completed; feedback comment missing';
}

function issueFeedbackOutcome(result: IssueFeedbackResult) {
  if (result.mode === 'direct') {
    if (result.issueComment?.applied) {
      const crossPost = result.prComment?.applied ? ` and cross-posted to PR ${result.prRef}` : '';
      return `Outcome: feedback posted to ${result.issue}${crossPost}.`;
    }
    if (result.issueComment?.error) {
      return `Outcome: feedback not posted. ${result.issueComment.error}`;
    }
    return 'Outcome: preflight only; no comment posted. Rerun without --dry-run (and with --body/--file) to post directly.';
  }
  if (result.launchError) {
    return `Outcome: feedback intake blocked. ${result.launchError}`;
  }
  if (!result.launched) {
    return 'Outcome: dry run only; no LLM feedback session was launched. Drop --dry-run to start the interactive intake.';
  }
  if (result.feedbackNotes?.foundIssueComment) {
    const crossNote = result.feedbackNotes.expectedPrComment
      ? result.feedbackNotes.foundPrComment
        ? ` Cross-posted to PR ${result.prRef}.`
        : ` PR cross-post missing — paste the same comment on PR ${result.prRef} manually.`
      : '';
    return `Outcome: interactive feedback intake completed; feedback comment posted to ${result.issue}.${crossNote}`;
  }
  return `Outcome: interactive feedback intake completed, but no "${result.marker}" comment was detected on ${result.issue}.${result.feedbackNotes?.reason ? ` ${result.feedbackNotes.reason}` : ''}`;
}

function issueStartOutcome(result: PrPlanResult) {
  if (result.action !== 'issue-start') return null;

  const status = result.campaignStatus
    ? result.campaignStatus.applied
      ? ` Campaign status updated to ${result.campaignStatus.status}.`
      : ` Campaign status not updated; planned ${result.campaignStatus.issue} -> ${result.campaignStatus.status}.`
    : '';
  const branch = result.developmentBranch?.branch ? ` on ${result.developmentBranch.branch}` : '';

  if (result.launched) {
    return `Outcome: LLM adapter completed${branch}; no background session remains.${status}`;
  }

  if (result.launchError) {
    if (result.adapterStarted) {
      return `Outcome: LLM adapter ran but exited with an error${branch}; inspect the adapter output above, resolve the failure, then rerun the issue start command.${status}`;
    }
    return `Outcome: not handed off to LLM adapter. Blocker: ${result.launchError} Resolve the blocker, then rerun the issue start command.`;
  }

  return `Outcome: dry run only; no LLM handoff was launched, no development branch was created, and no Campaign status was updated.`;
}

function prReviewOutcome(result: PrPlanResult) {
  if (result.action !== 'review') return null;

  const status = result.campaignStatus
    ? result.campaignStatus.applied
      ? ` Campaign status updated to ${result.campaignStatus.status}.`
      : ` Campaign status not updated; planned ${result.campaignStatus.issue} -> ${result.campaignStatus.status}.`
    : '';

  if (result.launchError || result.prReviewLoop?.status === 'failed') {
    const blocker = result.launchError ?? result.prReviewLoop?.error ?? result.prReviewLoop?.blocked.join(' ');
    const detail = blocker ? ` Blocker: ${blocker}` : '';
    return `Outcome: PR review loop blocked.${detail} Resolve the blocker, then rerun the PR review command.`;
  }

  if (result.prReviewLoop?.completed) {
    const sawHuman = result.prReviewLoop.iterations.some(
      (iteration) =>
        (iteration.outstandingHumanReviewThreads ?? 0) > 0 ||
        (iteration.outstandingHumanPrComments ?? 0) > 0
    );
    return sawHuman
      ? 'Outcome: PR review loop complete; no outstanding review feedback remains.'
      : 'Outcome: PR review loop complete; no outstanding CodeRabbit feedback remains.';
  }

  if (result.launched) {
    return `Outcome: handed off to LLM adapter for PR review.${status}`;
  }

  return 'Outcome: preflight only; no LLM handoff was launched. Rerun with `--launch` to start the PR review loop.';
}

function printPrPlan(output: Output, result: PrPlanResult) {
  const issueAdapterFailed = result.action === 'issue-start' && Boolean(result.launchError) && result.adapterStarted === true;
  const state = result.launchError
    ? issueAdapterFailed
      ? 'adapter failed'
      : 'blocked'
    : result.action === 'review' && result.prReviewLoop?.completed && !result.launched
      ? 'complete'
      : result.launched
        ? 'launched'
        : result.action === 'issue-start'
          ? 'dry run'
          : 'preflight only';
  const label = result.action === 'issue-start' ? 'Issue start' : `PR ${result.action}`;
  output(`${label}: ${state}`);
  if (result.action !== 'issue-start' && result.issue) output(`Issue: ${result.issue}`);
  if (result.adapterCommand) output(`Adapter: ${result.adapterCommand}`);
  if (result.adapterCwd) output(`Adapter cwd: ${result.adapterCwd}`);
  if (result.action === 'issue-start' && result.launched) {
    output('Adapter run: completed (foreground process; no background session remains)');
  } else if (issueAdapterFailed) {
    const detail =
      result.adapterExitStatus !== null && result.adapterExitStatus !== undefined
        ? ` with status ${result.adapterExitStatus}`
        : result.adapterSignal
          ? ` with signal ${result.adapterSignal}`
          : '';
    output(`Adapter run: failed${detail} (foreground process; no background session remains)`);
  }
  if (result.launchError) output(`Adapter error: ${result.launchError}`);
  if (result.artifact) output(`Artifact: ${result.artifact.runDir}`);
  if (result.contextSummary) {
    output(`Context size: ${result.contextSummary.promptCharacters} chars`);
    if (result.contextSummary.changedFiles !== undefined) output(`Changed files: ${result.contextSummary.changedFiles}`);
    if (result.contextSummary.comments !== undefined) output(`Comments: ${result.contextSummary.comments}`);
    if (result.contextSummary.reviews !== undefined) output(`Reviews: ${result.contextSummary.reviews}`);
    if (result.contextSummary.checks !== undefined) output(`Checks: ${result.contextSummary.checks}`);
    if (result.contextSummary.checkInMinutes !== undefined) output(`Check-in: ${result.contextSummary.checkInMinutes} minutes`);
  }
  if (result.developmentBranch) {
    const branch = result.developmentBranch;
    const branchSetupLabel =
      branch.linked || branch.command.startsWith('gh issue develop') || branch.command.startsWith('gh api graphql createLinkedBranch')
        ? 'Development branch link'
        : 'Development branch setup';
    output(`Development branch: ${branch.applied ? 'ready' : 'planned'} ${branch.branch} from ${branch.base}`);
    output(`${branchSetupLabel}: ${branch.applied ? 'created' : 'planned'} ${branch.command}`);
    output(
      `Development checkout: ${branch.checkoutRequired ? branch.checkedOut ? 'checked out' : branch.path ? `not checked out (${branch.path})` : 'missing checkout' : 'not checked out'}`
    );
    for (const blocker of branch.blocked) output(`branch blocked: ${blocker}`);
    if (branch.error) output(`branch error: ${branch.error}`);
  }
  if (result.mergeReadiness) {
    output(`Merge readiness: ${result.mergeReadiness.blocked.length === 0 ? 'clear' : 'blocked'}`);
    for (const blocker of result.mergeReadiness.blocked) output(`blocked: ${blocker}`);
    for (const detail of result.mergeReadiness.details) {
      output(`why blocked: ${detail.explanation}`);
      for (const evidence of detail.evidence) output(`evidence: ${evidence}`);
      output(`resolve: ${detail.resolution}`);
    }
    if (result.mergeReadiness.requestedReviewers.length > 0) {
      output(`Requested reviewers: ${result.mergeReadiness.requestedReviewers.join(', ')}`);
    }
    for (const thread of result.mergeReadiness.unresolvedReviewThreads) {
      const line = thread.line === null ? '' : `:${thread.line}`;
      const state = thread.isOutdated ? 'outdated unresolved' : 'unresolved';
      output(`review thread: ${thread.path}${line} by @${thread.author} (${state})${thread.url ? ` ${thread.url}` : ''}`);
    }
  }
  if (result.mergeE2E) {
    output(`Merge e2e: ${result.mergeE2E.status}${result.mergeE2E.skipReason ? ` (${result.mergeE2E.skipReason})` : ''}`);
    if (result.mergeE2E.required) {
      output(`Backend: ${result.mergeE2E.backendPath ?? 'missing'} (${result.mergeE2E.backendCommand}, ready ${result.mergeE2E.backendReadyUrl})`);
      output(`Backend process: ${result.mergeE2E.usedExistingBackend ? 'reused existing' : result.mergeE2E.startedBackend ? 'started by War Room' : 'planned'}`);
      output(`Demo: ${result.mergeE2E.demoPath ?? 'missing'} (${result.mergeE2E.demoCommand}, base ${result.mergeE2E.demoBaseUrl})`);
    }
    if (result.mergeE2E.durationMs !== null) output(`Merge e2e duration: ${result.mergeE2E.durationMs}ms`);
    if (result.mergeE2E.testExitStatus !== null) output(`Merge e2e exit: ${result.mergeE2E.testExitStatus}`);
    for (const blocker of result.mergeE2E.blocked) output(`e2e blocked: ${blocker}`);
    if (result.mergeE2E.error) output(`e2e error: ${result.mergeE2E.error}`);
  }
  if (result.mergeBump) {
    output(`Merge bump: ${result.mergeBump.status}${result.mergeBump.skipReason ? ` (${result.mergeBump.skipReason})` : ''}`);
    if (result.mergeBump.required) {
      output(
        `Bump: ${result.mergeBump.path ?? 'missing'} (${result.mergeBump.command ?? 'missing command'}, branch ${
          result.mergeBump.headBranch ?? 'missing'
        }, base ${result.mergeBump.base})`
      );
      if (result.mergeBump.level) output(`Bump level: ${result.mergeBump.level}`);
      if (result.mergeBump.versionBefore || result.mergeBump.versionAfter) {
        output(`Bump version: ${result.mergeBump.versionBefore ?? 'unknown'} -> ${result.mergeBump.versionAfter ?? 'unknown'}`);
      }
      if (result.mergeBump.changedFiles.length > 0) output(`Bump files: ${result.mergeBump.changedFiles.join(', ')}`);
      output(
        `Bump commit: ${
          result.mergeBump.pushed
            ? `pushed ${result.mergeBump.commitSha ?? 'unknown'}`
            : result.mergeBump.committed
              ? `committed ${result.mergeBump.commitSha ?? 'unknown'}`
              : 'planned'
        }`
      );
      if (result.mergeBump.durationMs !== null) output(`Bump duration: ${result.mergeBump.durationMs}ms`);
    }
    for (const blocker of result.mergeBump.blocked) output(`bump blocked: ${blocker}`);
    if (result.mergeBump.error) output(`bump error: ${result.mergeBump.error}`);
  }
  if (result.mergePostMerge) {
    output(`Merge post-merge: ${result.mergePostMerge.status}${result.mergePostMerge.skipReason ? ` (${result.mergePostMerge.skipReason})` : ''}`);
    if (result.mergePostMerge.required) {
      output(
        `Post-merge: ${result.mergePostMerge.path ?? 'missing'} (${result.mergePostMerge.command ?? 'missing command'}, base ${result.mergePostMerge.base})`
      );
      if (result.mergePostMerge.durationMs !== null) output(`Post-merge duration: ${result.mergePostMerge.durationMs}ms`);
    }
    for (const blocker of result.mergePostMerge.blocked) output(`post-merge blocked: ${blocker}`);
    if (result.mergePostMerge.error) output(`post-merge error: ${result.mergePostMerge.error}`);
  }
  if (result.mergeChangelog) {
    output(`Merge changelog: ${result.mergeChangelog.status}${result.mergeChangelog.skipReason ? ` (${result.mergeChangelog.skipReason})` : ''}`);
    if (result.mergeChangelog.required) {
      output(
        `Changelog: ${result.mergeChangelog.changelogPath ?? 'missing'} (${result.mergeChangelog.changelogFormat}, base ${result.mergeChangelog.base})`
      );
      if (result.mergeChangelog.changelogFile) output(`Changelog file: ${result.mergeChangelog.changelogFile}`);
      if (result.mergeChangelog.changelogUrl) output(`Changelog URL: ${result.mergeChangelog.changelogUrl}`);
      if (result.mergeChangelog.version) output(`Changelog version: ${result.mergeChangelog.version}`);
      output(
        `Changelog commit: ${
          result.mergeChangelog.pushed
            ? `pushed ${result.mergeChangelog.commitSha ?? 'unknown'}`
            : result.mergeChangelog.committed
              ? `committed ${result.mergeChangelog.commitSha ?? 'unknown'}`
              : 'planned'
        }`
      );
      if (result.mergeChangelog.durationMs !== null) output(`Changelog duration: ${result.mergeChangelog.durationMs}ms`);
    }
    for (const blocker of result.mergeChangelog.blocked) output(`changelog blocked: ${blocker}`);
    if (result.mergeChangelog.error) output(`changelog error: ${result.mergeChangelog.error}`);
  }
  if (result.prReviewLoop) {
    output(`PR review loop: ${result.prReviewLoop.status}`);
    output(`PR review loop iterations: ${result.prReviewLoop.iterations.length}`);
    for (const iteration of result.prReviewLoop.iterations) {
      const comments =
        iteration.outstandingCodeRabbitComments === null
          ? 'unknown'
          : String(iteration.outstandingCodeRabbitComments);
      const humanThreadCount = iteration.outstandingHumanReviewThreads;
      const humanCommentCount = iteration.outstandingHumanPrComments;
      const humanSuffix =
        (humanThreadCount && humanThreadCount > 0) || (humanCommentCount && humanCommentCount > 0)
          ? `; human review threads ${humanThreadCount ?? 0}; human PR comments ${humanCommentCount ?? 0}`
          : '';
      output(
        `review loop ${iteration.iteration}: ${iteration.startHeadSha ?? 'unknown'} -> ${iteration.endHeadSha ?? 'unknown'}; CodeRabbit comments ${comments}${humanSuffix}`
      );
      if (iteration.adapterError) output(`review loop ${iteration.iteration} adapter error: ${iteration.adapterError}`);
    }
    for (const blocker of result.prReviewLoop.blocked) output(`review loop blocked: ${blocker}`);
    if (result.prReviewLoop.error) output(`review loop error: ${result.prReviewLoop.error}`);
  }
  if (result.merged !== undefined) output(`Merged: ${result.merged ? 'yes' : 'no'}`);
  printSummaryPosts(output, result.summaryPosts);
  printFinalIssueComment(output, result.finalIssueComment);
  printLocalCleanup(output, result.localCleanup);
  if (result.campaignStatus) {
    output(`Campaign status: ${result.campaignStatus.applied ? 'updated' : 'planned'} ${result.campaignStatus.issue} -> ${result.campaignStatus.status}`);
  }
  if (result.assigneeUpdate) {
    output(
      `Issue assignee: ${result.assigneeUpdate.applied ? 'updated' : 'planned'} ${result.assigneeUpdate.issue} +${result.assigneeUpdate.assignee}`
    );
    if (result.assigneeUpdate.error) output(`assignee update error: ${result.assigneeUpdate.error}`);
  }
  output(result.prompt);
  printLlmUsage(output, result.usageSummary);
  const outcome = issueStartOutcome(result) ?? prReviewOutcome(result);
  if (outcome) printOutcome(output, outcome);
}

function printLlmUsage(output: Output, summary: LlmUsageSummary | null | undefined) {
  if (!summary) return;
  for (const line of formatLlmUsageSummary(summary)) output(line);
}

function printPrCreate(output: Output, result: PrCreateResult) {
  output(`PR create: ${result.created ? 'created' : result.existingPr ? 'existing PR reused' : 'preflight only'}`);
  output(`Repo: ${result.repo}`);
  output(`Path: ${result.path}`);
  output(`Branch: ${result.branch} -> ${result.base}`);
  output(`Issue: ${result.issue ?? 'none inferred'}`);
  output(`Title: ${result.title}`);
  output(`PR text: ${result.prText.source === 'adapter' ? 'generated by LLM adapter' : result.prText.source === 'manual' ? 'supplied by flags' : 'local fallback'}`);
  if (result.prText.adapterCommand) output(`Adapter: ${result.prText.adapterCommand}`);
  if (result.prText.error) output(`adapter warning: ${result.prText.error}`);
  output(`Draft: ${result.draft ? 'yes' : 'no'}`);
  if (result.pushCommand) output(`Push: ${result.pushed ? 'pushed' : 'planned'} ${result.pushCommand}`);
  output(`Create: ${result.created ? 'created' : 'planned'} ${result.createCommand}`);
  if (result.url) output(`URL: ${result.url}`);
  if (result.issueComment) {
    const state = result.issueComment.applied
      ? `posted ${result.issueComment.ref} ${result.issueComment.url ?? ''}`.trim()
      : result.issueComment.error
        ? `failed ${result.issueComment.ref}: ${result.issueComment.error}`
        : `planned ${result.issueComment.ref} (${result.issueComment.reason ?? 'not posted'})`;
    output(`Issue progress: ${state}`);
  }
  if (result.artifact) output(`Artifact: ${result.artifact.runDir}`);
  for (const blocker of result.blocked) output(`blocked: ${blocker}`);
  if (result.campaignStatus) {
    output(`Campaign status: ${result.campaignStatus.applied ? 'updated' : 'planned'} ${result.campaignStatus.issue} -> ${result.campaignStatus.status}`);
  }
  output(result.body);
  if ((result.created || result.existingPr) && result.url) {
    output(`PR URL: ${result.url}`);
  } else if (result.blocked.length > 0) {
    printOutcome(output, 'Outcome: PR not created. Resolve the blocked items above, then rerun `warroom pr create --confirm`.');
  } else {
    printOutcome(
      output,
      'Outcome: PR not created. This was a preflight; run `warroom pr create --confirm` or answer yes in an interactive terminal to push and create the PR.'
    );
  }
}

function printSummaryPosts(output: Output, posts: SummaryPostResult[] | undefined) {
  for (const post of posts ?? []) {
    const state = post.applied ? 'posted' : post.error ? 'failed' : 'planned';
    output(`Summary ${post.target}: ${state} ${post.ref}${post.url ? ` ${post.url}` : ''}${post.reason ? ` (${post.reason})` : ''}`);
    if (post.error) output(`summary error: ${post.error}`);
  }
}

function printFinalIssueComment(output: Output, post: SummaryPostResult | null | undefined) {
  if (!post) return;
  if (post.applied) {
    output(`Victory issue: posted ${post.ref}${post.url ? ` ${post.url}` : ''}`);
  } else if (post.error) {
    output(`Victory issue: failed ${post.ref}: ${post.error}`);
  } else {
    output(`Victory issue: planned ${post.ref}${post.reason ? ` (${post.reason})` : ''}`);
  }
}

function printLocalCleanup(output: Output, cleanup: LocalCleanupResult | null | undefined) {
  if (!cleanup) return;
  output(`Local cleanup: ${cleanup.applied ? 'applied' : cleanup.blocked.length ? 'blocked' : 'planned'} ${cleanup.repo}`);
  for (const blocker of cleanup.blocked) output(`cleanup blocked: ${blocker}`);
  for (const message of cleanup.messages) output(`cleanup: ${message}`);
}

function mergeCloseoutFailed(result: PrPlanResult) {
  return (
    (result.mergeBump?.required && result.mergeBump.status === 'failed') ||
    (result.mergeChangelog?.required && result.mergeChangelog.status === 'failed')
  );
}

async function promptPrMergeFollowUps(
  workspaceRoot: string,
  output: Output,
  input: Input,
  options: {
    pr: string;
    issue?: string;
    summary?: string;
    summaryBody?: string;
    confirmSummary?: boolean;
    confirmCleanup?: boolean;
  }
) {
  if (!options.confirmSummary) {
    const postSummary = await promptConfirmation(output, input, 'Post victory summary comments now? [Y/n]');
    if (postSummary) {
      const summaryResult = await runPrMerge(workspaceRoot, {
        pr: options.pr,
        issue: options.issue,
        summary: options.summary,
        summaryBody: options.summaryBody,
        postSummary: true,
        confirmSummary: true,
        confirmStatus: true,
      });
      printSummaryPosts(output, summaryResult.summaryPosts);
      if (summaryResult.campaignStatus) {
        output(
          `Campaign status: ${summaryResult.campaignStatus.applied ? 'updated' : 'planned'} ${summaryResult.campaignStatus.issue} -> ${summaryResult.campaignStatus.status}`
        );
      }
    }
  }

  if (!options.confirmCleanup) {
    output('Returning the local checkout to the PR base branch...');
    const cleanupResult = await runPrMerge(workspaceRoot, {
      pr: options.pr,
      cleanupLocal: true,
      confirmCleanup: true,
    });
    printLocalCleanup(output, cleanupResult.localCleanup);
  }
}

type PrMergeLiveOutput = {
  e2eStatus?: (message: string) => void;
  e2eOutput?: E2EOutput;
  mergeStatus?: (message: string) => void;
};

async function runInteractivePrMergeFlow(
  workspaceRoot: string,
  output: Output,
  input: Input,
  options: {
    pr: string;
    issue?: string;
    summary?: string;
    postSummary?: boolean;
    confirmSummary?: boolean;
    confirmChangelog?: boolean;
    bumpVersion?: VersionBumpChoice;
    issueComment?: boolean;
    cleanupLocal?: boolean;
    confirmCleanup?: boolean;
    writeArtifact?: boolean;
    liveOutput?: PrMergeLiveOutput;
  }
) {
  const baseOptions = {
    pr: options.pr,
    issue: options.issue,
    summary: options.summary,
    postSummary: options.postSummary || options.confirmSummary,
    confirmSummary: options.confirmSummary,
    confirmChangelog: options.confirmChangelog,
    bumpVersion: options.bumpVersion,
    bumpConfirmation: options.bumpVersion
      ? undefined
      : (plan: MergeBumpResult) => promptMergeBumpChoice(output, input, plan),
    changelogConfirmation: options.confirmChangelog
      ? undefined
      : (plan: MergeChangelogResult) => promptMergeChangelogConfirmation(output, input, plan),
    changelogPushConfirmation: options.confirmChangelog
      ? undefined
      : (plan: MergeChangelogResult) => promptMergeChangelogPushConfirmation(output, input, plan),
    issueComment: options.issueComment,
    cleanupLocal: options.cleanupLocal || options.confirmCleanup,
    confirmCleanup: options.confirmCleanup,
    writeArtifact: options.writeArtifact,
    ...(options.liveOutput ?? {}),
  };

  let confirmedResult = await runPrMerge(workspaceRoot, baseOptions);
  printPrPlan(output, confirmedResult);
  if (mergeCloseoutFailed(confirmedResult)) process.exitCode = 1;

  if (!confirmedResult.merged) {
    const blocked = (confirmedResult.mergeReadiness?.blocked.length ?? 0) > 0;
    const e2eRequired = confirmedResult.mergeE2E?.required ?? true;
    let allowUnresolvedReviewThreads = false;
    let allowFailingChecks = false;
    let skipMergeE2E = false;
    let mergeChoice: 'confirm' | 'skip' | 'cancel';
    if (blocked) {
      mergeChoice = await promptBlockedMergeConfirmation(
        output,
        input,
        'Preflight is blocked. Recheck readiness and attempt the confirmed merge only if blockers are clear? Type "skip" to bypass failing checks and unresolved review threads (uses gh pr merge --admin). [Y/n/skip]'
      );
      allowUnresolvedReviewThreads = mergeChoice === 'skip';
      allowFailingChecks = mergeChoice === 'skip';
      if (mergeChoice === 'skip' && e2eRequired) {
        const e2eChoice = await promptMergeConfirmation(
          output,
          input,
          'Continue to run the demo Playwright e2e gate and merge this PR now? Type "skip" to merge without the Playwright gate. [Y/n/skip]'
        );
        skipMergeE2E = e2eChoice === 'skip';
        if (e2eChoice === 'cancel') mergeChoice = 'cancel';
      }
    } else if (e2eRequired) {
      mergeChoice = await promptMergeConfirmation(
        output,
        input,
        'Continue to run the demo Playwright e2e gate and merge this PR now? Type "skip" to merge without the Playwright gate. [Y/n/skip]'
      );
      skipMergeE2E = mergeChoice === 'skip';
    } else {
      const confirmed = await promptConfirmation(output, input, 'Merge this PR now? [Y/n]');
      mergeChoice = confirmed ? 'confirm' : 'cancel';
    }

    if (mergeChoice !== 'cancel') {
      const bypassing = allowFailingChecks || allowUnresolvedReviewThreads;
      output(
        bypassing && skipMergeE2E
          ? 'Running confirmed PR merge while bypassing preflight blockers (gh pr merge --admin) and without demo Playwright e2e...'
          : bypassing
            ? 'Running confirmed PR merge while bypassing preflight blockers (gh pr merge --admin)...'
            : skipMergeE2E
              ? 'Running confirmed PR merge without demo Playwright e2e...'
              : 'Running confirmed PR merge...'
      );
      confirmedResult = await runPrMerge(workspaceRoot, {
        ...baseOptions,
        confirm: true,
        skipMergeE2E,
        allowUnresolvedReviewThreads,
        allowFailingChecks,
      });
      printPrPlan(output, confirmedResult);
      if (mergeCloseoutFailed(confirmedResult)) process.exitCode = 1;
    }
  }

  if (!confirmedResult.merged) return;
  if (mergeCloseoutFailed(confirmedResult)) return;

  await promptPrMergeFollowUps(workspaceRoot, output, input, {
    pr: options.pr,
    issue: confirmedResult.issue ?? options.issue,
    summary: options.summary,
    summaryBody: confirmedResult.summary,
    confirmSummary: options.confirmSummary,
    confirmCleanup: options.confirmCleanup,
  });
}

function printPrReviewQueue(output: Output, result: PrReviewQueueResult, options: { numbered?: boolean; suppressOutcome?: boolean } = {}) {
  const repo = result.repo ? ` for ${result.repo}` : '';
  output(`Open PRs for Campaign statuses ${result.statuses.join(', ')}${repo}: ${result.prs.length}`);
  result.prs.forEach((pr, index) => {
    const issues = pr.issues
      .map((issue) => `${issue.repo}#${issue.number}${issue.status ? ` ${issue.status}` : ''}`)
      .join(', ');
    const prefix = options.numbered ? `${index + 1}. ` : '';
    output(`${prefix}${pr.repo}#${pr.number} ${pr.title} (updated ${pr.updatedAt ?? 'unknown'}; issue ${issues}) ${pr.url}`);
  });
  if (options.suppressOutcome) return;
  if (result.prs.length === 0) {
    printOutcome(output, `Outcome: no open PRs found for Campaign statuses ${result.statuses.join(', ')}.`);
  } else {
    printOutcome(
      output,
      `Outcome: listed ${result.prs.length} PR${result.prs.length === 1 ? '' : 's'} ready for review; no LLM handoff was launched. Run \`warroom pr review --pr <owner/repo#number> --launch\` to start one.`
    );
  }
}

function printCommitCreate(output: Output, result: CommitCreateResult) {
  output(`Commit create for ${result.repo}: ${result.committed ? 'committed' : 'preflight only'}`);
  output(`Path: ${result.path}`);
  output(`Branch: ${result.branch ?? 'unknown'}@${result.headSha ?? 'unknown'}`);
  if (result.issue) output(`Issue: ${result.issue}`);
  output(`Suggested message: ${result.suggestedMessage}`);
  if (result.pushSkippedReason) output(`Push: skipped (${result.pushSkippedReason})`);
  else if (result.pushCommand) output(`Push: ${result.pushed ? 'pushed' : 'planned'} ${result.pushCommand}`);
  if (result.issueComment) {
    const state = result.issueComment.applied
      ? `posted ${result.issueComment.issue} ${result.issueComment.url ?? ''}`.trim()
      : result.issueComment.error
        ? `failed ${result.issueComment.issue}: ${result.issueComment.error}`
        : `planned ${result.issueComment.issue} (${result.issueComment.reason ?? 'not posted'})`;
    output(`Issue progress: ${state}`);
  }
  if (result.artifact) output(`Artifact: ${result.artifact.runDir}`);
  for (const change of result.changes) {
    const state = change.staged && change.unstaged ? 'staged+unstaged' : change.staged ? 'staged' : 'unstaged';
    output(`${change.indexStatus}${change.worktreeStatus} ${change.path} (${state})`);
  }
  for (const validation of result.validation) {
    output(
      `${validation.ok ? 'ok' : 'failed'} validation: ${validation.command} (exit ${validation.status ?? 'unknown'}, ${validation.durationMs}ms)`
    );
  }
  for (const warning of result.warnings) output(`warning: ${warning}`);
  for (const blocker of result.blocked) output(`blocked: ${blocker}`);
}

async function promptPrCreateAfterCommit(
  workspaceRoot: string,
  output: Output,
  input: Input,
  result: CommitCreateResult,
  options: { autoCreatePr?: boolean } = {}
) {
  if (!result.committed) return;
  if (options.autoCreatePr === false) return;

  const existingPr = result.branch ? findOpenPrForBranch(result.githubRepo, result.branch) : null;
  if (existingPr) {
    output(`Existing PR detected: ${existingPr.url}`);
    await promptPrReviewForRef(workspaceRoot, output, input, existingPr.ref, result.issue, {});
    return;
  }

  const createPr =
    options.autoCreatePr === true
      ? true
      : await promptConfirmation(output, input, 'Run `warroom pr create` next? [Y/n]');
  if (!createPr) return;

  output('Creating PR...');
  try {
    const created = runPrCreate(workspaceRoot, {
      confirm: true,
      currentPath: result.path,
    });
    printPrCreate(output, created);
    await promptPrReviewAfterPrCreate(workspaceRoot, output, input, created, {});
  } catch (error) {
    output(`PR create failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

type IssueStartPrReadiness = {
  ready: boolean;
  dirty: boolean;
  dirtyCount: number;
  repoPath: string;
  branch: string;
  base: string;
  blocker: string | null;
};

function issueStartPrReadiness(result: PrPlanResult): IssueStartPrReadiness | null {
  const repoPath = result.adapterCwd ?? result.developmentBranch?.path;
  const branch = result.developmentBranch?.branch;
  const base = result.developmentBranch?.base;
  if (!repoPath || !branch || !base) return null;

  const currentBranch = runGit(repoPath, ['branch', '--show-current']);
  if (currentBranch.status !== 0) {
    return {
      ready: false,
      dirty: false,
      dirtyCount: 0,
      repoPath,
      branch,
      base,
      blocker: currentBranch.stderr || `Could not read current branch in ${repoPath}.`,
    };
  }
  if (currentBranch.stdout !== branch) {
    return {
      ready: false,
      dirty: false,
      dirtyCount: 0,
      repoPath,
      branch,
      base,
      blocker: `Expected checkout on ${branch}, but ${repoPath} is on ${currentBranch.stdout || 'unknown'}.`,
    };
  }

  const status = runGit(repoPath, ['status', '--short', '--untracked-files=all']);
  if (status.status !== 0) {
    return {
      ready: false,
      dirty: false,
      dirtyCount: 0,
      repoPath,
      branch,
      base,
      blocker: status.stderr || `Could not inspect uncommitted changes in ${repoPath}.`,
    };
  }

  const dirtyCount = status.stdout.split(/\r?\n/).filter(Boolean).length;
  if (dirtyCount > 0) {
    return { ready: false, dirty: true, dirtyCount, repoPath, branch, base, blocker: null };
  }

  const commits = runGit(repoPath, ['rev-list', '--count', `${base}..${branch}`]);
  if (commits.status !== 0) {
    return {
      ready: false,
      dirty: false,
      dirtyCount: 0,
      repoPath,
      branch,
      base,
      blocker: commits.stderr || `Could not compare ${branch} with ${base}.`,
    };
  }

  const commitCount = Number(commits.stdout);
  if (!Number.isFinite(commitCount) || commitCount <= 0) {
    return {
      ready: false,
      dirty: false,
      dirtyCount: 0,
      repoPath,
      branch,
      base,
      blocker: `No commits found on ${branch} ahead of ${base}.`,
    };
  }

  return { ready: true, dirty: false, dirtyCount: 0, repoPath, branch, base, blocker: null };
}

async function promptPrCreateAfterIssueStart(
  workspaceRoot: string,
  output: Output,
  input: Input,
  result: PrPlanResult,
  options: { autoCreatePr?: boolean } = {}
) {
  if (result.action !== 'issue-start' || !result.launched || result.launchError || !result.adapterCwd) return;
  if (options.autoCreatePr === false) return;

  const readiness = issueStartPrReadiness(result);
  if (readiness?.dirty) {
    output(
      `PR create is not ready: ${readiness.dirtyCount} uncommitted change${
        readiness.dirtyCount === 1 ? '' : 's'
      } ${readiness.dirtyCount === 1 ? 'remains' : 'remain'} in ${readiness.repoPath}.`
    );
    const commitNow =
      options.autoCreatePr === true
        ? true
        : await promptConfirmation(
            output,
            input,
            `Run \`warroom commit create --issue ${result.issue ?? '<issue>'}\` now? This will stage all current changes before committing. [Y/n]`
          );
    if (!commitNow) return;

    output('Creating commit and pushing...');
    try {
      const committed = runCommitCreate(workspaceRoot, {
        currentPath: readiness.repoPath,
        issue: result.issue ?? undefined,
        confirm: true,
        all: true,
      });
      printCommitCreate(output, committed);
      await promptPrCreateAfterCommit(workspaceRoot, output, input, committed, { autoCreatePr: options.autoCreatePr });
    } catch (error) {
      output(`Commit create failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (readiness && !readiness.ready) {
    output(`PR create is not ready: ${readiness.blocker ?? 'branch is not ready for PR creation.'}`);
    printOutcome(
      output,
      `Outcome: PR create was not offered. Commit the implementation on ${readiness.branch}, then rerun \`warroom pr create\`.`
    );
    return;
  }

  const createPr =
    options.autoCreatePr === true
      ? true
      : await promptConfirmation(output, input, 'Run `warroom pr create` next? [Y/n]');
  if (!createPr) return;

  output('Creating PR...');
  try {
    const created = runPrCreate(workspaceRoot, {
      confirm: true,
      currentPath: result.adapterCwd,
      issue: result.issue ?? undefined,
      // Leave title/body unset so pr create asks the adapter to summarize the actual branch commits and diff.
    });
    printPrCreate(output, created);
    await promptPrReviewAfterPrCreate(workspaceRoot, output, input, created, {});
  } catch (error) {
    output(`PR create failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function triageReadyForIssueNext(result: IssueHandoffResult) {
  return (
    result.launched &&
    !result.launchError &&
    !result.closeoutError &&
    result.triageNotes?.ready === true &&
    result.campaignStatus?.applied === true &&
    result.campaignStatus.status === 'ready-to-engage'
  );
}

async function promptIssueNextAfterTriage(
  workspaceRoot: string,
  output: Output,
  input: Input,
  issue: string,
  result: IssueHandoffResult
) {
  if (!triageReadyForIssueNext(result)) return;

  const startIssue = await promptConfirmation(output, input, `Run \`warroom issue next --issue ${issue}\` now? [Y/n]`);
  if (!startIssue) return;

  output(`Starting ${issue}`);
  const plan = runIssueStart(workspaceRoot, {
    issue,
    dryRun: false,
    confirmStatus: true,
  });
  printPrPlan(output, plan);
  if (plan.launchError) process.exitCode = 1;
  await promptPrCreateAfterIssueStart(workspaceRoot, output, input, plan);
}

function prRefFromCreateResult(result: PrCreateResult) {
  const match = result.url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return match ? `${match[1]}#${match[2]}` : null;
}

async function promptPrReviewForRef(
  workspaceRoot: string,
  output: Output,
  input: Input,
  prRef: string,
  issue: string | null | undefined,
  options: { writeArtifact?: boolean; liveMergeOutput?: PrMergeLiveOutput }
) {
  const reviewPr = await promptConfirmation(output, input, 'Run `warroom pr review` next? [Y/n]');
  if (!reviewPr) return;

  output(`Starting PR review for ${prRef}`);
  const review = await runPrReview(workspaceRoot, {
    pr: prRef,
    issue: issue ?? undefined,
    dryRun: false,
    confirmStatus: true,
    writeArtifact: options.writeArtifact,
    reviewStatus: output,
    waitForInitialCodeRabbit: true,
  });
  printPrPlan(output, review);
  if (review.launchError) process.exitCode = 1;
  await promptPrMergeAfterPrReview(workspaceRoot, output, input, review, {
    pr: prRef,
    writeArtifact: options.writeArtifact,
    liveOutput: options.liveMergeOutput,
  });
}

async function promptPrReviewAfterPrCreate(
  workspaceRoot: string,
  output: Output,
  input: Input,
  result: PrCreateResult,
  options: { writeArtifact?: boolean; liveMergeOutput?: PrMergeLiveOutput }
) {
  if (!result.created && !result.existingPr) return;
  const prRef = prRefFromCreateResult(result);
  if (!prRef) return;
  await promptPrReviewForRef(workspaceRoot, output, input, prRef, result.issue, options);
}

async function promptPrMergeAfterPrReview(
  workspaceRoot: string,
  output: Output,
  input: Input,
  result: PrPlanResult,
  options: { pr: string; writeArtifact?: boolean; liveOutput?: PrMergeLiveOutput }
) {
  let current = result;
  while (current.action === 'review' && !current.launchError && current.prReviewLoop?.completed) {
    const choice = await promptPrMergeOrReviewAgain(
      output,
      input,
      `Run \`warroom pr merge --pr ${options.pr}\` now? [Y/n/Review Again]`
    );
    if (choice === 'cancel') return;
    if (choice === 'merge') {
      output(`Starting PR merge for ${options.pr}`);
      try {
        await runInteractivePrMergeFlow(workspaceRoot, output, input, {
          pr: options.pr,
          issue: current.issue ?? undefined,
          writeArtifact: options.writeArtifact,
          liveOutput: options.liveOutput ?? { e2eStatus: output, mergeStatus: output },
        });
      } catch (error) {
        output(`PR merge failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      return;
    }

    output(`Starting PR review for ${options.pr}`);
    current = await runPrReview(workspaceRoot, {
      pr: options.pr,
      issue: current.issue ?? undefined,
      dryRun: false,
      confirmStatus: true,
      writeArtifact: options.writeArtifact,
      reviewStatus: output,
      waitForInitialCodeRabbit: true,
    });
    printPrPlan(output, current);
    if (current.launchError) {
      process.exitCode = 1;
      return;
    }
  }
}

async function promptIssueTriageAfterCreate(
  workspaceRoot: string,
  output: Output,
  input: Input,
  result: IssueCreateResult
) {
  if (!result.created || !result.issue) return;

  const triage = await promptConfirmation(output, input, `Run \`warroom issue triage --issue ${result.issue}\` now? [Y/n]`);
  if (!triage) return;

  output(`Triaging ${result.issue}`);
  const handoff = runIssueTriage(workspaceRoot, {
    issue: result.issue,
    markReady: true,
    confirmStatus: true,
    dryRun: false,
  });
  if ('issues' in handoff) printIssueList(output, handoff);
  else {
    printIssueHandoff(output, handoff);
    await promptIssueNextAfterTriage(workspaceRoot, output, input, result.issue, handoff);
  }
}

function printAbort(output: Output, result: AbortResult) {
  for (const message of result.messages) output(message);
  for (const repo of result.repos) {
    const mutation = repo.reset ? ' reset' : repo.stashed ? ' stashed' : '';
    output(`${repo.repo}: ${repo.checkedOut ? 'present' : 'missing'} ${repo.branch ?? 'no-branch'}@${repo.headSha ?? 'unknown'}${repo.dirty ? ' dirty' : ' clean'}${mutation}`);
    for (const command of repo.recoveryCommands) output(`  ${command}`);
  }
}

function printCampaignStatusCheck(output: Output, result: ReturnType<typeof runCampaignStatusCheck>) {
  output(`Campaign statuses: ${result.errors.length > 0 ? 'check failed' : result.missing.length === 0 && result.unexpected.length === 0 ? 'ok' : 'needs attention'}`);
  output(`Project: ${result.projectId ?? 'unknown'}`);
  output(`Status field: ${result.statusFieldId ?? 'unknown'}`);
  for (const option of result.options) output(`option ${option.name} (${option.id})`);
  for (const missing of result.missing) output(`missing status ${missing}`);
  for (const unexpected of result.unexpected) output(`unexpected status ${unexpected}`);
  for (const error of result.errors) output(`error: ${error}`);
}

function printCampaignStatus(output: Output, result: ReturnType<typeof runCampaignStatus>) {
  output(`Campaign status: ${result.applied ? 'updated' : 'planned'} ${result.issue} -> ${result.status}`);
  output(`Project item: ${result.projectItemId}${result.added ? ' (added to board)' : ''}`);
  output(`Option: ${result.optionId}`);
  if (result.reason) output(`Reason: ${result.reason}`);
}

function formatRepoLine(label: string, repo: DevStatus['sdk']) {
  const checkout = repo.checkedOut ? 'present' : 'missing';
  const source = repo.source === 'sibling' ? ', sibling fallback' : repo.source === 'manifest' ? ', manifest path' : '';
  const dirty = repo.clean === false ? ', dirty' : repo.clean === true ? ', clean' : '';
  return `${label}: ${checkout}${source}${dirty} -> ${repo.resolvedPath}`;
}

function printDevStatus(output: Output, result: DevStatus) {
  output(formatRepoLine('SDK checkout', result.sdk));
  output(formatRepoLine('Demo checkout', result.demo));
  output(`Demo dependencies: ${result.demo.nodeModules ? 'installed' : 'missing node_modules'}`);
  for (const tool of result.tools) {
    output(`${tool.name}: ${tool.available ? 'ok' : 'missing'}${tool.detail ? ` (${tool.detail})` : ''}`);
  }

  let linkState = 'unlinked';
  if (result.linked) {
    linkState = 'linked';
  } else if (result.staleMirror) {
    linkState = 'stale mirror links';
  } else if (result.partiallyLinked) {
    linkState = 'partially linked';
  } else if (result.legacyDirectLinked) {
    linkState = 'legacy direct links';
  }
  output(`SDK-to-demo dev link: ${linkState}`);
  for (const packageLink of result.packages) {
    const build = packageLink.buildOutputExists ? 'built' : 'missing dist';
    if (packageLink.linked) {
      output(`ok ${packageLink.name} -> ${packageLink.targetPath} (${build})`);
    } else if (packageLink.staleMirror) {
      output(
        `stale-mirror ${packageLink.name} -> ${packageLink.targetPath} (dist -> ${packageLink.mirrorDistTarget ?? 'missing'}, ${build})`
      );
    } else if (packageLink.legacyDirectLinked) {
      output(`legacy-direct ${packageLink.name} -> ${packageLink.sdkPackagePath} (${build})`);
    } else if (packageLink.exists) {
      output(`published ${packageLink.name} (${packageLink.isSymlink ? packageLink.actualTarget : 'not a symlink'}, ${build})`);
    } else {
      output(`missing ${packageLink.name} (${build})`);
    }
  }

  output('');
  output('Recommended linked workflow:');
  output(`SDK watch: ${result.recommended.sdkWatch}`);
  output(`Demo dev: ${result.recommended.demoDev}`);
  output(`Demo build: ${result.recommended.demoBuild}`);
  output(`Demo typecheck: ${result.recommended.demoTypecheck}`);
  output(`Demo Playwright core: ${result.recommended.demoPlaywrightCore}`);
}

function printDevAction(output: Output, action: DevActionResult) {
  for (const message of action.messages) output(message);
  printDevStatus(output, action.status);
}

function printDevTest(output: Output, result: MergeE2EResult) {
  output(`Dev test: ${result.status}${result.skipReason ? ` (${result.skipReason})` : ''}`);
  output(`Backend: ${result.backendPath ?? 'missing'} (${result.backendCommand}, ready ${result.backendReadyUrl})`);
  output(
    `Backend process: ${result.usedExistingBackend ? 'reused existing' : result.startedBackend ? 'started by War Room (stopped on exit)' : 'planned'}`
  );
  output(`Demo: ${result.demoPath ?? 'missing'} (${result.demoCommand}, base ${result.demoBaseUrl})`);
  if (result.durationMs !== null) output(`Dev test duration: ${result.durationMs}ms`);
  if (result.testExitStatus !== null) output(`Dev test exit: ${result.testExitStatus}`);
  for (const blocker of result.blocked) output(`dev test blocked: ${blocker}`);
  if (result.error) output(`dev test error: ${result.error}`);
}

export function buildProgram(options: BuildProgramOptions = {}) {
  resetCampaignCache();
  const invocationCwd = options.cwd ?? process.cwd();
  // Resolve the initialized workspace when possible, but fall back to the War
  // Room checkout root so `setup` can run before `repos.yaml` exists. Commands
  // that require an initialized workspace surface a clear error when they load
  // the manifest.
  let workspaceRoot: string;
  try {
    workspaceRoot = findWarRoomWorkspace(invocationCwd);
  } catch (error) {
    try {
      workspaceRoot = findWarRoomRoot(invocationCwd);
    } catch {
      throw error;
    }
  }
  const output = options.output ?? console.log;
  const customOutput = options.output !== undefined;
  const input = options.input ?? process.stdin;
  const interactive = options.interactive ?? Boolean(input.isTTY);
  const liveMergeOutput = (): PrMergeLiveOutput => ({
    e2eStatus: output,
    e2eOutput: createE2EOutput(output, customOutput),
    mergeStatus: output,
  });
  const program = new Command();

  program
    .name('warroom')
    .description('Local command center and cross-repo orchestration workspace.')
    .version('0.1.0')
    .helpOption('-h, --help, -help', 'Display help.')
    .showHelpAfterError();

  program
    .command('doctor')
    .description('Validate the phase-1 War Room skeleton.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const result = runDoctor(workspaceRoot);
      if (opts.json) {
        printJson(output, result);
        return;
      }

      output(`War Room doctor: ${result.ok ? 'ok' : 'needs attention'}`);
      output(`Repos mapped: ${result.repoCount} (${result.activeRepoCount} active, ${result.plannedRepoCount} planned)`);
      for (const file of result.files) {
        output(`${file.exists ? 'ok' : 'missing'} ${file.file}`);
      }
      for (const tool of result.tools) {
        output(`${tool.ok ? 'ok' : 'missing'} ${tool.name}${tool.detail ? ` (${tool.detail})` : ''}`);
      }
      output(`LLM adapter: ${result.env.adapter ?? 'unset'}${result.env.adapterSupported ? '' : ' (unsupported)'}`);
      for (const note of result.env.notes) output(`LLM note: ${note}`);
      output(`Allies: ${result.allies.ok ? 'ok' : 'needs attention'} (${result.allies.activeAllyCount} active, ${result.allies.plannedAllyCount} planned)`);
      output(`Resource references: ${result.resources.referencesOk ? 'ok' : 'missing references'}`);
      output(
        `Campaign statuses: ${result.campaignStatuses.errors.length > 0 ? 'check failed' : result.campaignStatuses.missing.length === 0 && result.campaignStatuses.unexpected.length === 0 ? 'ok' : 'needs attention'}`
      );
      for (const repo of result.repos) {
        const checkout = repo.checkedOut ? `${repo.source} checkout` : 'missing';
        const dirty = repo.clean === false ? ', dirty' : repo.clean === true ? ', clean' : '';
        output(`${repo.github}: ${checkout}${dirty} -> ${repo.resolvedPath}`);
      }
    });

  const allies = program.command('allies').description('Inspect enterprise ally workspaces.');

  allies
    .command('status')
    .description('Show ally workspace health, shared docs, local env, and issue repo checkout state.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const result = runAlliesStatus(workspaceRoot);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printAlliesStatus(output, result);
    });

  const maps = program.command('maps').description('Inspect and maintain the repo map.');

  maps
    .command('study')
    .description('Show local repo map health and specialist assignments.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const repos = runMapsStudy(workspaceRoot);
      if (opts.json) {
        printJson(output, repos);
        return;
      }

      for (const repo of repos) {
        const checkoutState = repo.checkedOut ? 'checked out' : repo.status === 'planned' ? 'planned' : 'missing';
        const dirty = repo.clean === false ? ', dirty' : repo.clean === true ? ', clean' : '';
        const branch = repo.branch ? ` ${repo.branch}@${repo.headSha ?? 'unknown'}` : '';
        output(`${repo.github} [${repo.status}, ${checkoutState}${dirty}${branch}] -> ${repo.resolvedPath} (${repo.specialist.name})`);
      }
      if (isDevLinkAvailable(workspaceRoot)) {
        const devStatus = runDevStatus(workspaceRoot);
        output(`SDK-to-demo dev link: ${devStatus.linked ? 'linked' : devStatus.partiallyLinked ? 'partially linked' : 'unlinked'}`);
      }
    });

  maps
    .command('assign')
    .description('Validate or update repo specialist/resource assignments and regenerate the campaign atlas.')
    .option('--repo <id>', 'Repo id to update.')
    .option('--sergeant <name>', 'Set the repo Sergeant name.')
    .option('--add-framework <name>', 'Add a framework to the repo specialist context.', collect, [])
    .option('--remove-framework <name>', 'Remove a framework from the repo specialist context.', collect, [])
    .option('--add-domain <name>', 'Add a domain to the repo specialist context.', collect, [])
    .option('--remove-domain <name>', 'Remove a domain from the repo specialist context.', collect, [])
    .option('--add-resource <id>', 'Add a resource id to the repo allowlist.', collect, [])
    .option('--remove-resource <id>', 'Remove a resource id from the repo allowlist.', collect, [])
    .option('--resource-id <id>', 'Create or update a logical resource definition.')
    .option('--resource-type <type>', 'Resource type for --resource-id, such as docs, cli, mcp, api, or app.')
    .option('--resource-name <name>', 'Human-readable resource name for --resource-id.')
    .option('--resource-description <text>', 'Safe non-secret description for --resource-id.')
    .option('--resource-docs-url <url>', 'Public docs URL for --resource-id.')
    .option('--write', 'Write repos.yaml and regenerate maps/campaign-atlas.md.')
    .option('--check', 'Validate assignments and atlas state.')
    .option('--json', 'Print machine-readable output.')
    .action(
      (opts: {
        repo?: string;
        sergeant?: string;
        addFramework?: string[];
        removeFramework?: string[];
        addDomain?: string[];
        removeDomain?: string[];
        addResource?: string[];
        removeResource?: string[];
        resourceId?: string;
        resourceType?: string;
        resourceName?: string;
        resourceDescription?: string;
        resourceDocsUrl?: string;
        write?: boolean;
        check?: boolean;
        json?: boolean;
      }) => {
      const result = runMapsAssign(workspaceRoot, opts);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printMapsAssign(output, result);
    }
    );

  program
    .command('bootstrap')
    .description('Clone missing child repos under maps/repos and verify required tools.')
    .option('--dry-run', 'Show clone actions without running them.')
    .option('--include-planned', 'Include planned repos.')
    .option('--write-proposals', 'Write inferred resource registry and repo allowlist proposals. Requires --confirm.')
    .option('--confirm', 'Confirm proposal writes when used with --write-proposals.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { dryRun?: boolean; includePlanned?: boolean; writeProposals?: boolean; confirm?: boolean; json?: boolean }) => {
      const result = runBootstrap(workspaceRoot, opts);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printBootstrap(output, result);
    });

  program
    .command('sync')
    .description('Fetch and fast-forward clean child repos, skipping dirty repos.')
    .option('--report', 'Report status only without fetching or pulling.')
    .option('--include-planned', 'Include planned repos.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { report?: boolean; includePlanned?: boolean; json?: boolean }) => {
      const result = runSync(workspaceRoot, opts);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printSync(output, result);
    });

  program
    .command('setup')
    .description('Initialize project-specific config (repos.yaml, allies.yaml, .env.local, maps) from templates.')
    .option('--yes', 'Non-interactive: scaffold all missing files from their templates.')
    .option('--force', 'Overwrite existing files from their templates.')
    .option('--atlas', 'Regenerate maps/campaign-atlas.md after scaffolding (with --yes).')
    .option('--json', 'Print machine-readable output (implies --yes).')
    .action(async (opts: { yes?: boolean; force?: boolean; atlas?: boolean; json?: boolean }) => {
      if (opts.yes || opts.json || !interactive) {
        const result = runSetup(workspaceRoot, { force: opts.force, regenerateAtlas: opts.atlas });
        if (opts.json) {
          printJson(output, result);
        } else {
          printSetup(output, result);
        }
        if (!result.ok) process.exitCode = 1;
        return;
      }
      await runInteractiveSetup(workspaceRoot, output, input, { force: opts.force });
    });

  const campaign = program.command('campaign').description('Campaign Map setup and status commands.');
  campaign
    .command('status-check')
    .description('Validate Campaign Map Status options.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const result = runCampaignStatusCheck();
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printCampaignStatusCheck(output, result);
    });

  campaign
    .command('status')
    .description('Set or preview an issue Campaign Map status.')
    .requiredOption('--issue <owner/repo#number>', 'Issue to update.')
    .requiredOption('--status <status>', `One of: ${CAMPAIGN_STATUSES.map((status) => status.name).join(', ')}`)
    .option('--reason <text>', 'Human-readable reason, required for blockaded.')
    .option('--confirm', 'Actually update the Campaign Map item.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { issue: string; status: CampaignStatusName; reason?: string; confirm?: boolean; json?: boolean }) => {
      const result = runCampaignStatus(opts);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printCampaignStatus(output, result);
    });

  const issue = program.command('issue').description('Issue workflow commands.');
  issue
    .command('create')
    .description('Interactively shape and create a new needs-triage issue.')
    .option('--repo <owner/repo>', 'Preferred target GitHub repo for the issue draft.')
    .option('--title <title>', 'Seed title for direct or adapter-assisted issue creation.')
    .option('--body <body>', 'Seed business context for direct or adapter-assisted issue creation.')
    .option('--label <label>', 'Additional label to apply. Repeatable.', collect, [])
    .option('--issue-type <type>', 'GitHub issue type to apply after creation when available.')
    .option('--confirm', 'Create the drafted issue without asking for the final confirmation.')
    .option('--dry-run', 'Print the PM session prompt without launching the configured LLM adapter.')
    .option('--write-artifact', 'Write prompt/input/draft artifacts under .warroom/runs.')
    .option('--json', 'Print machine-readable output.')
    .action(
      async (opts: {
        repo?: string;
        title?: string;
        body?: string;
        label?: string[];
        issueType?: string;
        confirm?: boolean;
        dryRun?: boolean;
        writeArtifact?: boolean;
        json?: boolean;
      }) => {
        const directDraft = Boolean(opts.repo && opts.title && opts.body);
        const dryRun = opts.dryRun === true ? true : directDraft ? false : !interactive;
        let result = runIssueCreate(workspaceRoot, {
          repo: opts.repo,
          title: opts.title,
          body: opts.body,
          labels: opts.label,
          issueType: opts.issueType,
          confirm: opts.confirm,
          dryRun,
          writeArtifact: opts.writeArtifact,
        });
        if (opts.json) {
          printJson(output, result);
          return;
        }

        printIssueCreate(output, result);
        if (result.created) {
          if (interactive) await promptIssueTriageAfterCreate(workspaceRoot, output, input, result);
          return;
        }
        if (!interactive || opts.confirm || opts.dryRun || !result.draft || result.draftError) return;

        const confirmed = await promptConfirmation(output, input, 'Create this GitHub issue now? [Y/n]');
        if (!confirmed) {
          output('Issue not created.');
          printOutcome(output, 'Outcome: issue not created. Draft remains available for review.');
          return;
        }

        result = confirmIssueCreate(workspaceRoot, result);
        printIssueCreate(output, result);
        await promptIssueTriageAfterCreate(workspaceRoot, output, input, result);
      }
    );
  issue
    .command('fortify')
    .description('Post-MVP quality/refactor issue creation flow.')
    .action(() => output('warroom issue fortify is deferred from the MVP.'));
  issue
    .command('usage')
    .description('Print War Room LLM usage tracked for an issue.')
    .requiredOption('--issue <owner/repo#number>', 'Issue to summarize.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { issue: string; json?: boolean }) => {
      refreshIssueUsageLedgerCosts(workspaceRoot, opts.issue);
      const summary = summarizeIssueUsage(workspaceRoot, opts.issue);
      if (opts.json) {
        printJson(output, summary);
        return;
      }
      printLlmUsage(output, summary);
    });
  issue
    .command('triage')
    .description('List triage issues or create a scoped LLM triage handoff for one issue.')
    .option('--issue <owner/repo#number>', 'Issue to triage.')
    .option('--mark-ready', 'Preview or move the issue to ready-to-engage after triage.')
    .option('--confirm-status', 'Apply the Campaign Map status movement requested by --mark-ready.')
    .option('--dry-run', 'Print the structured handoff without launching the configured LLM adapter.')
    .option('--launch', 'Compatibility option; issue triage launches by default unless --dry-run is passed.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--no-select', 'List issues without prompting for a selection.')
    .option('--all', 'List triage issues across all mapped repos, even from inside a child repo checkout.')
    .option('--json', 'Print machine-readable output.')
    .action(async (opts: { issue?: string; markReady?: boolean; confirmStatus?: boolean; dryRun?: boolean; launch?: boolean; writeArtifact?: boolean; select?: boolean; all?: boolean; json?: boolean }) => {
      const triageDryRun = () => opts.dryRun === true;
      const runTriage = (issueRef?: string, selectedInteractively = false) => {
        const dryRun = triageDryRun();
        return runIssueTriage(workspaceRoot, {
          issue: issueRef,
          markReady: dryRun ? opts.markReady : opts.markReady || selectedInteractively || Boolean(issueRef),
          confirmStatus: dryRun ? false : opts.confirmStatus || selectedInteractively || Boolean(issueRef),
          dryRun,
          writeArtifact: opts.writeArtifact,
          currentPath: invocationCwd,
          allRepos: opts.all,
        });
      };

      if (opts.issue && !opts.json && opts.dryRun !== true) output(`Triaging ${opts.issue}`);
      const result = runTriage(opts.issue);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      if (!('issues' in result)) {
        printIssueHandoff(output, result);
        if (opts.issue) await promptIssueNextAfterTriage(workspaceRoot, output, input, opts.issue, result);
        return;
      }

      const canSelect = opts.select !== false && interactive && result.issues.length > 0;
      printIssueList(output, result, { numbered: canSelect });

      if (!canSelect) {
        if (opts.select !== false && result.issues.length > 0 && !interactive) {
          output(
            'Selection is available in an interactive terminal. Run warroom issue triage --issue <owner/repo#number> to triage one directly.'
          );
        }
        printOutcome(output, result.issues.length === 0 ? 'Outcome: no triage issues found; no issue selected.' : 'Outcome: no issue selected.');
        return;
      }

      const selected = await promptIssueSelection(output, input, result.issues, 'triage');
      if (!selected) {
        output('No issue selected.');
        printOutcome(output, 'Outcome: no issue selected.');
        return;
      }

      const issueRef = `${selected.repo}#${selected.number}`;
      output(`Triaging ${issueRef}`);
      const handoff = runTriage(issueRef, true);
      if ('issues' in handoff) printIssueList(output, handoff);
      else {
        printIssueHandoff(output, handoff);
        await promptIssueNextAfterTriage(workspaceRoot, output, input, issueRef, handoff);
      }
    });
  issue
    .command('feedback [issue]')
    .description('Capture structured refinement feedback on an existing issue. Launches an interactive LLM session that does a light grill-me intake and posts a `## War Room feedback` comment (and optionally cross-posts to a related PR). When run from inside a mapped repo on a feature branch, the issue and open PR are auto-detected.')
    .option('--pr <owner/repo#number>', 'Cross-post the feedback to an in-flight PR conversation so reviewers fold it in before merge. Auto-detected from the current branch when omitted.')
    .option('--no-pr-comment', 'Do not cross-post the feedback to the PR even when --pr is set or auto-detected.')
    .option('--body <text>', 'Skip the LLM intake and post pre-written feedback content directly (bypass mode).')
    .option('--file <path>', 'Skip the LLM intake and post pre-written feedback from a file (bypass mode).')
    .option('--dry-run', 'Print the prompt (or the structured comment for direct mode) without launching the adapter or posting.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--json', 'Print machine-readable output.')
    .action(
      async (
        issueArg: string | undefined,
        opts: {
          pr?: string;
          prComment?: boolean;
          body?: string;
          file?: string;
          dryRun?: boolean;
          writeArtifact?: boolean;
          json?: boolean;
        }
      ) => {
        try {
          let resolvedIssue = issueArg;
          let resolvedPr = opts.pr;
          if (!resolvedIssue || !resolvedPr) {
            const ctx = inferCurrentBranchContext(workspaceRoot, invocationCwd);
            if (!resolvedIssue) {
              if (!ctx) {
                output('Could not auto-detect an issue: run inside a mapped child repo checkout, or pass an explicit `<issue>` argument.');
                process.exitCode = 1;
                return;
              }
              if (ctx.branchIsBase) {
                output(`Could not auto-detect an issue: ${ctx.repo} is on the base branch (${ctx.branch}). Switch to a feature branch or pass an explicit \`<issue>\` argument.`);
                process.exitCode = 1;
                return;
              }
              if (!ctx.issue) {
                output(`Could not auto-detect an issue for ${ctx.repo} branch ${ctx.branch}. Branches created by \`warroom issue next\` set this automatically; otherwise pass an explicit \`<issue>\` argument.`);
                process.exitCode = 1;
                return;
              }
              resolvedIssue = ctx.issue;
              if (!opts.json) output(`Auto-detected issue: ${resolvedIssue} (from ${ctx.repo} branch ${ctx.branch})`);
            }
            if (!resolvedPr && ctx?.pr) {
              resolvedPr = ctx.pr;
              if (!opts.json) output(`Auto-detected PR: ${resolvedPr}${ctx.prUrl ? ` ${ctx.prUrl}` : ''}`);
            }
          }
          const result = runIssueFeedback(workspaceRoot, {
            issue: resolvedIssue,
            prRef: resolvedPr,
            body: opts.body,
            bodyFile: opts.file,
            postPrComment: opts.prComment,
            dryRun: opts.dryRun === true,
            writeArtifact: opts.writeArtifact,
          });
          if (opts.json) {
            printJson(output, result);
          } else {
            printIssueFeedback(output, result);
          }
          if (result.launchError) process.exitCode = 1;
          if (result.mode === 'direct' && result.issueComment && !result.issueComment.applied && result.issueComment.error) {
            process.exitCode = 1;
          }
          if (
            result.mode === 'adapter' &&
            result.launched &&
            result.feedbackNotes &&
            !result.feedbackNotes.foundIssueComment
          ) {
            process.exitCode = 1;
          }
          const feedbackPosted =
            (result.mode === 'adapter' && result.feedbackNotes?.foundIssueComment) ||
            (result.mode === 'direct' && result.issueComment?.applied === true);
          if (feedbackPosted && resolvedPr && interactive && !opts.json) {
            await promptPrReviewForRef(workspaceRoot, output, input, resolvedPr, resolvedIssue, {
              writeArtifact: opts.writeArtifact,
              liveMergeOutput: liveMergeOutput(),
            });
          }
        } catch (error) {
          output(`Feedback failed: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      }
    );
  issue
    .command('next')
    .description('List issues ready for implementation and select one to start development.')
    .option('--issue <owner/repo#number>', 'Start this issue directly instead of prompting for a selection.')
    .option('--base <branch>', 'Target branch for the eventual PR.', 'main')
    .option('--dry-run', 'Print the selected issue handoff without launching the adapter or moving Campaign Map status.')
    .option('--launch', 'Launch the configured LLM adapter for the selected issue. This is the default after selection.')
    .option('--confirm-status', 'Move the selected issue to battlefield-active on the Campaign Map. This is the default after selection.')
    .option('--no-status', 'Do not move the selected issue to battlefield-active.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--no-select', 'List issues without prompting for a selection.')
    .option('--no-pr-creation', 'Do not auto-create the PR after development. By default, the PR is created without prompting.')
    .option('--all', 'List ready issues across all mapped repos, even from inside a child repo checkout.')
    .option('--json', 'Print machine-readable output.')
    .action(
      async (opts: {
        issue?: string;
        base?: string;
        dryRun?: boolean;
        launch?: boolean;
        confirmStatus?: boolean;
        status?: boolean;
        writeArtifact?: boolean;
        select?: boolean;
        prCreation?: boolean;
        all?: boolean;
        json?: boolean;
      }) => {
        const autoCreatePr = opts.prCreation !== false;
        if (opts.issue) {
          const dryRun = opts.dryRun === true;
          if (!opts.json) output(`Starting ${opts.issue}`);
          if (!dryRun) {
            const ensured = await ensureAllyImplementationRepo(
              workspaceRoot,
              output,
              input,
              interactive && opts.json !== true,
              opts.issue
            );
            if (!ensured) {
              if (opts.json) {
                printJson(output, { ok: false, issue: opts.issue, error: 'Implementation repo not selected for ally issue.' });
              } else {
                printOutcome(
                  output,
                  'Outcome: not started. Ally issue has no implementation repo. Re-run interactively or add an `Owner repo: <owner>/<mapped-repo>` comment, then retry.'
                );
              }
              process.exitCode = 1;
              return;
            }
          }
          const plan = runIssueStart(workspaceRoot, {
            issue: opts.issue,
            base: opts.base,
            dryRun,
            confirmStatus: dryRun ? false : opts.status !== false || opts.confirmStatus === true,
            writeArtifact: opts.writeArtifact,
          });
          if (opts.json) {
            printJson(output, plan);
            return;
          }
          printPrPlan(output, plan);
          if (plan.launchError) process.exitCode = 1;
          if (interactive) await promptPrCreateAfterIssueStart(workspaceRoot, output, input, plan, { autoCreatePr });
          return;
        }

        const result = runIssueNext(workspaceRoot, {
          currentPath: invocationCwd,
          allRepos: opts.all,
        });
        if (opts.json) {
          printJson(output, result);
          return;
        }
        const canSelect = opts.select !== false && interactive && result.issues.length > 0;
        printIssueList(output, result, { numbered: canSelect });

        if (!canSelect) {
          if (opts.select !== false && result.issues.length > 0 && !interactive) {
            output(
              'Selection is available in an interactive terminal. Run warroom issue next --issue <owner/repo#number> to start one directly.'
            );
          }
          printOutcome(output, result.issues.length === 0 ? 'Outcome: no ready issues found; no issue started.' : 'Outcome: no issue started.');
          return;
        }

        const selected = await promptIssueSelection(output, input, result.issues);
        if (!selected) {
          output('No issue selected.');
          printOutcome(output, 'Outcome: no issue started.');
          return;
        }

        const issueRef = `${selected.repo}#${selected.number}`;
        output(`Starting ${issueRef}`);
        const dryRun = opts.dryRun === true;
        if (!dryRun) {
          const ensured = await ensureAllyImplementationRepo(workspaceRoot, output, input, interactive, issueRef);
          if (!ensured) {
            printOutcome(
              output,
              'Outcome: not started. Ally issue has no implementation repo. Pick a repo when prompted or add an `Owner repo: <owner>/<mapped-repo>` comment, then retry.'
            );
            process.exitCode = 1;
            return;
          }
        }
        const plan = runIssueStart(workspaceRoot, {
          issue: issueRef,
          base: opts.base,
          dryRun,
          confirmStatus: dryRun ? false : opts.status !== false || opts.confirmStatus === true,
          writeArtifact: opts.writeArtifact,
          issueTitle: selected.title,
          issueUrl: selected.url,
        });
        printPrPlan(output, plan);
        if (plan.launchError) process.exitCode = 1;
        await promptPrCreateAfterIssueStart(workspaceRoot, output, input, plan, { autoCreatePr });
      }
    );

  const pr = program.command('pr').description('Pull request workflow commands.');
  pr
    .command('create')
    .description('Create a GitHub PR from the current or selected branch.')
    .option('--branch <name>', 'Branch to publish. Defaults to the current branch.')
    .option('--issue <owner/repo#number>', 'Issue to link in the PR body. Defaults to warroom/<number>-... branch inference.')
    .option('--base <branch>', 'Target base branch. Defaults to branch gh-merge-base or the repo default branch.')
    .option('--title <text>', 'PR title. Defaults to the linked issue title or first commit subject.')
    .option('--body <markdown>', 'PR body markdown. Defaults to a generated body with Closes <issue> when an issue is known.')
    .option('--draft', 'Create the PR as a draft.')
    .option('--confirm', 'Push the branch and create the PR.')
    .option('--confirm-status', 'Move the linked issue to skirmish after creating the PR.')
    .option('--no-issue-comment', 'Do not post the generated PR summary back to the linked issue after creation.')
    .option('--no-push', 'Create the PR without pushing first.')
    .option('--write-artifact', 'Write PR body/result artifacts under .warroom/runs.')
    .option('--json', 'Print machine-readable output.')
    .action(async (opts: {
      branch?: string;
      issue?: string;
      base?: string;
      title?: string;
      body?: string;
      draft?: boolean;
      confirm?: boolean;
      confirmStatus?: boolean;
      issueComment?: boolean;
      push?: boolean;
      writeArtifact?: boolean;
      json?: boolean;
    }) => {
      const result = runPrCreate(workspaceRoot, {
        branch: opts.branch,
        issue: opts.issue,
        base: opts.base,
        title: opts.title,
        body: opts.body,
        draft: opts.draft,
        confirm: opts.confirm,
        confirmStatus: opts.confirmStatus,
        issueComment: opts.issueComment,
        push: opts.push,
        writeArtifact: opts.writeArtifact,
        currentPath: invocationCwd,
      });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printPrCreate(output, result);

      if (interactive && result.created) {
        await promptPrReviewAfterPrCreate(workspaceRoot, output, input, result, {
          writeArtifact: opts.writeArtifact,
          liveMergeOutput: liveMergeOutput(),
        });
        return;
      }

      if (opts.confirm || !interactive || result.blocked.length > 0) return;

      const confirmed = await promptConfirmation(output, input, 'Push this branch and create the GitHub PR now? [Y/n]');
      if (!confirmed) {
        output('PR not created.');
        return;
      }

      output('Creating PR...');
      try {
        const created = runPrCreate(workspaceRoot, {
          branch: opts.branch,
          issue: opts.issue,
          base: opts.base,
          title: opts.title ?? result.title,
          body: opts.body ?? result.body,
          prText: result.prText,
          draft: opts.draft,
          confirm: true,
          confirmStatus: opts.confirmStatus,
          issueComment: opts.issueComment,
          push: opts.push,
          writeArtifact: opts.writeArtifact,
          currentPath: invocationCwd,
        });
        printPrCreate(output, created);
        await promptPrReviewAfterPrCreate(workspaceRoot, output, input, created, {
          writeArtifact: opts.writeArtifact,
          liveMergeOutput: liveMergeOutput(),
        });
      } catch (error) {
        output(`PR create failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  pr
    .command('review')
    .description('Create a PR review-loop (skirmish) handoff.')
    .option('--pr <owner/repo#number>', 'PR to review. Omit to list open review PRs from active Campaign Map issues.')
    .option('--issue <owner/repo#number>', 'Linked issue to move to skirmish.')
    .option('--dry-run', 'Print the structured handoff and context summary without launching the configured LLM adapter.')
    .option('--launch', 'Deprecated; launching is now the default. Pass --dry-run to skip the launch.')
    .option('--check-in-minutes <minutes>', 'Compatibility option; review polling is controlled by WARROOM_PR_REVIEW_* env vars.', (value) => Number(value), 60)
    .option('--confirm-status', 'Move the linked issue to skirmish on the Campaign Map. This is the default when launching review.')
    .option('--no-status', 'Do not move the linked issue to skirmish.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--all', 'List review-queue PRs across all mapped repos, even from inside a child repo checkout.')
    .option('--json', 'Print machine-readable output.')
    .action(async (opts: { pr?: string; issue?: string; dryRun?: boolean; launch?: boolean; checkInMinutes?: number; confirmStatus?: boolean; status?: boolean; writeArtifact?: boolean; all?: boolean; json?: boolean }) => {
      if (!opts.pr) {
        const result = runPrReviewQueue(workspaceRoot, { currentPath: invocationCwd, allRepos: opts.all });
        if (opts.json) {
          printJson(output, result);
          return;
        }
        const canStart = interactive && opts.dryRun !== true && result.prs.length > 0;
        printPrReviewQueue(output, result, {
          numbered: canStart && result.prs.length > 1,
          suppressOutcome: canStart || result.prs.length === 0,
        });
        if (!canStart && result.prs.length > 0) return;

        if (result.prs.length === 0) {
          let inferredPr: string | null = null;
          try {
            inferredPr = inferPrRefForCurrentBranch(workspaceRoot, invocationCwd);
          } catch {
            printOutcome(output, `Outcome: no open PRs found for Campaign statuses ${result.statuses.join(', ')} or the current branch.`);
            return;
          }

          output(`Resolved current branch PR: ${inferredPr}`);
          const dryRun = opts.dryRun === true;
          const launch = !dryRun;
          const review = await runPrReview(workspaceRoot, {
            pr: inferredPr,
            issue: opts.issue ?? inferIssueRefForCurrentBranch(workspaceRoot, invocationCwd) ?? undefined,
            dryRun,
            checkInMinutes: opts.checkInMinutes,
            confirmStatus: shouldConfirmPrReviewStatus(dryRun, opts),
            writeArtifact: opts.writeArtifact,
            reviewStatus: launch ? output : undefined,
            waitForInitialCodeRabbit: launch,
          });
          printPrPlan(output, review);
          if (review.launchError) process.exitCode = 1;
          if (interactive) {
            await promptPrMergeAfterPrReview(workspaceRoot, output, input, review, {
              pr: inferredPr,
              writeArtifact: opts.writeArtifact,
              liveOutput: liveMergeOutput(),
            });
          }
          return;
        }

        const selected = await promptPrReviewSelection(output, input, result.prs);
        if (!selected) {
          printOutcome(output, 'Outcome: no PR review handoff started.');
          return;
        }

        const selectedPr = prReviewRef(selected);
        output(`Starting PR review for ${selectedPr}`);
        const review = await runPrReview(workspaceRoot, {
          pr: selectedPr,
          issue: opts.issue ?? primaryIssueRef(selected),
          dryRun: false,
          checkInMinutes: opts.checkInMinutes,
          confirmStatus: shouldConfirmPrReviewStatus(false, opts),
          writeArtifact: opts.writeArtifact,
          reviewStatus: output,
          waitForInitialCodeRabbit: true,
        });
        printPrPlan(output, review);
        if (review.launchError) process.exitCode = 1;
        await promptPrMergeAfterPrReview(workspaceRoot, output, input, review, {
          pr: selectedPr,
          writeArtifact: opts.writeArtifact,
          liveOutput: liveMergeOutput(),
        });
        return;
      }

      const dryRun = opts.dryRun === true;
      const result = await runPrReview(workspaceRoot, {
        pr: opts.pr,
        issue: opts.issue ?? inferIssueRefForCurrentBranch(workspaceRoot, invocationCwd) ?? undefined,
        dryRun,
        checkInMinutes: opts.checkInMinutes,
        confirmStatus: shouldConfirmPrReviewStatus(dryRun, opts),
        writeArtifact: opts.writeArtifact,
        reviewStatus: opts.json ? undefined : output,
        waitForInitialCodeRabbit: !dryRun,
      });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printPrPlan(output, result);
      if (result.launchError) process.exitCode = 1;
      if (interactive) {
        await promptPrMergeAfterPrReview(workspaceRoot, output, input, result, {
          pr: opts.pr,
          writeArtifact: opts.writeArtifact,
          liveOutput: liveMergeOutput(),
        });
      }
    });
  pr
    .command('merge')
    .description('Preflight or confirm a GitHub PR merge gated by the demo Playwright e2e run.')
    .option('--pr <owner/repo#number>', 'PR to merge. Omit to infer from the current mapped repo branch.')
    .option('--issue <owner/repo#number>', 'Linked issue to move to victory.')
    .option('--confirm', 'Run configured merge gates, then gh pr merge --squash --delete-branch.')
    .option('--confirm-status', 'Move the linked issue to victory on the Campaign Map.')
    .option('--confirm-changelog', 'Run the guarded post-merge changelog update without asking.')
    .option('--resume-changelog', 'Resume only the post-merge changelog closeout for an already merged PR.')
    .option('--bump-version <level>', 'Run or skip the configured pre-merge version bump: patch, minor, major, or skip.')
    .option('--summary <text>', 'Victory summary to include in local artifacts and optional comments.')
    .option('--post-summary', 'Plan or post victory summary comments to the PR and linked issue.')
    .option('--confirm-summary', 'Actually post victory summary comments. Implies --post-summary.')
    .option('--no-issue-comment', 'Do not post the final victory closeout comment back to the linked issue after merge.')
    .option('--cleanup-local', 'Plan or return the mapped local checkout to the PR base branch and pull it.')
    .option('--confirm-cleanup', 'Actually switch the mapped local checkout and pull when cleanup is safe. Implies --cleanup-local.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--allow-failing-checks', 'Bypass failing or incomplete status checks and unresolved review threads. Runs gh pr merge with --admin to override branch protection.')
    .option('--json', 'Print machine-readable output.')
    .action(async (opts: {
      pr?: string;
      issue?: string;
      confirm?: boolean;
      confirmStatus?: boolean;
      confirmChangelog?: boolean;
      resumeChangelog?: boolean;
      bumpVersion?: string;
      summary?: string;
      postSummary?: boolean;
      confirmSummary?: boolean;
      issueComment?: boolean;
      cleanupLocal?: boolean;
      confirmCleanup?: boolean;
      writeArtifact?: boolean;
      allowFailingChecks?: boolean;
      json?: boolean;
    }) => {
      const bumpVersion = parseVersionBumpChoice(opts.bumpVersion);
      const resolvedPr = opts.pr ?? inferPrRefForCurrentBranch(workspaceRoot, invocationCwd);
      const resolvedIssue = opts.issue ?? inferIssueRefForCurrentBranch(workspaceRoot, invocationCwd) ?? undefined;
      if (!opts.pr && !opts.json) output(`Resolved current branch PR: ${resolvedPr}`);
      const liveE2EOutput = opts.json
        ? {}
        : {
            e2eStatus: output,
            e2eOutput: createE2EOutput(output, customOutput),
            mergeStatus: output,
          };

      const result = await runPrMerge(workspaceRoot, {
        pr: resolvedPr,
        issue: resolvedIssue,
        confirm: opts.confirm || opts.resumeChangelog === true,
        confirmStatus: opts.confirmStatus,
        confirmChangelog: opts.confirmChangelog,
        resumeChangelog: opts.resumeChangelog,
        bumpVersion,
        bumpConfirmation:
          interactive && !bumpVersion
            ? (plan: MergeBumpResult) => promptMergeBumpChoice(output, input, plan)
            : undefined,
        changelogConfirmation:
          interactive && !opts.confirmChangelog
            ? (plan: MergeChangelogResult) => promptMergeChangelogConfirmation(output, input, plan)
            : undefined,
        changelogPushConfirmation:
          interactive && !opts.confirmChangelog
            ? (plan: MergeChangelogResult) => promptMergeChangelogPushConfirmation(output, input, plan)
            : undefined,
        summary: opts.summary,
        postSummary: opts.postSummary || opts.confirmSummary,
        confirmSummary: opts.confirmSummary,
        issueComment: opts.issueComment,
        cleanupLocal: opts.cleanupLocal || opts.confirmCleanup,
        confirmCleanup: opts.confirmCleanup,
        writeArtifact: opts.writeArtifact,
        allowFailingChecks: opts.allowFailingChecks,
        allowUnresolvedReviewThreads: opts.allowFailingChecks,
        ...liveE2EOutput,
      });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printPrPlan(output, result);
      if (mergeCloseoutFailed(result)) process.exitCode = 1;

      let confirmedResult = result;
      if (interactive && !opts.confirm && !result.merged) {
        const blocked = (result.mergeReadiness?.blocked.length ?? 0) > 0;
        const e2eRequired = result.mergeE2E?.required ?? true;
        let allowUnresolvedReviewThreads = false;
        let allowFailingChecks = false;
        let skipMergeE2E = false;
        let mergeChoice: 'confirm' | 'skip' | 'cancel';
        if (blocked) {
          mergeChoice = await promptBlockedMergeConfirmation(
            output,
            input,
            'Preflight is blocked. Recheck readiness and attempt the confirmed merge only if blockers are clear? Type "skip" to bypass failing checks and unresolved review threads (uses gh pr merge --admin). [Y/n/skip]'
          );
          allowUnresolvedReviewThreads = mergeChoice === 'skip';
          allowFailingChecks = mergeChoice === 'skip';
          if (mergeChoice === 'skip' && e2eRequired) {
            const e2eChoice = await promptMergeConfirmation(
              output,
              input,
              'Continue to run the demo Playwright e2e gate and merge this PR now? Type "skip" to merge without the Playwright gate. [Y/n/skip]'
            );
            skipMergeE2E = e2eChoice === 'skip';
            if (e2eChoice === 'cancel') mergeChoice = 'cancel';
          }
        } else if (e2eRequired) {
          mergeChoice = await promptMergeConfirmation(
            output,
            input,
            'Continue to run the demo Playwright e2e gate and merge this PR now? Type "skip" to merge without the Playwright gate. [Y/n/skip]'
          );
          skipMergeE2E = mergeChoice === 'skip';
        } else {
          const confirmed = await promptConfirmation(output, input, 'Merge this PR now? [Y/n]');
          mergeChoice = confirmed ? 'confirm' : 'cancel';
        }
        if (mergeChoice !== 'cancel') {
          const bypassing = allowFailingChecks || allowUnresolvedReviewThreads;
          output(
            bypassing && skipMergeE2E
              ? 'Running confirmed PR merge while bypassing preflight blockers (gh pr merge --admin) and without demo Playwright e2e...'
              : bypassing
                ? 'Running confirmed PR merge while bypassing preflight blockers (gh pr merge --admin)...'
                : skipMergeE2E
                  ? 'Running confirmed PR merge without demo Playwright e2e...'
                  : 'Running confirmed PR merge...'
          );
          confirmedResult = await runPrMerge(workspaceRoot, {
            pr: resolvedPr,
            issue: resolvedIssue,
            confirm: true,
            skipMergeE2E,
            allowUnresolvedReviewThreads,
            allowFailingChecks,
            confirmStatus: opts.confirmStatus,
            confirmChangelog: opts.confirmChangelog,
            resumeChangelog: opts.resumeChangelog,
            bumpVersion,
            bumpConfirmation: bumpVersion ? undefined : (plan: MergeBumpResult) => promptMergeBumpChoice(output, input, plan),
            changelogConfirmation: opts.confirmChangelog
              ? undefined
              : (plan: MergeChangelogResult) => promptMergeChangelogConfirmation(output, input, plan),
            changelogPushConfirmation: opts.confirmChangelog
              ? undefined
              : (plan: MergeChangelogResult) => promptMergeChangelogPushConfirmation(output, input, plan),
            summary: opts.summary,
            postSummary: opts.postSummary || opts.confirmSummary,
            confirmSummary: opts.confirmSummary,
            issueComment: opts.issueComment,
            cleanupLocal: opts.cleanupLocal || opts.confirmCleanup,
            confirmCleanup: opts.confirmCleanup,
            writeArtifact: opts.writeArtifact,
            ...liveE2EOutput,
          });
          printPrPlan(output, confirmedResult);
          if (mergeCloseoutFailed(confirmedResult)) process.exitCode = 1;
        }
      }

      if (!interactive || !confirmedResult.merged) return;
      if (mergeCloseoutFailed(confirmedResult)) return;

      await promptPrMergeFollowUps(workspaceRoot, output, input, {
        pr: resolvedPr,
        issue: confirmedResult.issue ?? resolvedIssue,
        summary: opts.summary,
        summaryBody: confirmedResult.summary,
        confirmSummary: opts.confirmSummary,
        confirmCleanup: opts.confirmCleanup,
      });
    });

  const commit = program.command('commit').description('Commit workflow commands.');
  commit
    .command('create')
    .description('Inspect a child repo and optionally create a conventional commit.')
    .option('--repo <id>', 'Repo id from repos.yaml. Defaults to the current mapped child repo or single active mapped development branch.')
    .option('--issue <owner/repo#number>', 'Issue to post commit progress to. Defaults to branch metadata or warroom/<number>-... inference.')
    .option('--message <message>', 'Commit message to use.')
    .option('--validate <command>', 'Validation command to run from the target repo before commit. Repeatable.', collect, [])
    .option('--write-artifact', 'Write input/result/summary artifacts under .warroom/runs.')
    .option('--all', 'Stage all changes before committing. Requires --confirm or interactive approval.')
    .option('--no-push', 'Create the commit without pushing to the remote branch.')
    .option('--no-issue-comment', 'Do not post the commit progress comment back to the linked issue after commit.')
    .option('--confirm', 'Actually create the commit and push it to the remote branch.')
    .option('--json', 'Print machine-readable output.')
    .action(async (opts: { repo?: string; issue?: string; message?: string; validate?: string[]; writeArtifact?: boolean; all?: boolean; push?: boolean; issueComment?: boolean; confirm?: boolean; json?: boolean }) => {
      const commandOptions = { ...opts, currentPath: invocationCwd };
      const result = runCommitCreate(workspaceRoot, opts.confirm ? commandOptions : { ...commandOptions, confirm: false });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printCommitCreate(output, result);

      if (!interactive) return;

      if (opts.confirm || result.committed) {
        await promptPrCreateAfterCommit(workspaceRoot, output, input, result);
        return;
      }

      if (result.blocked.length > 0) return;

      const commitAll = opts.all === true || result.changes.some((change) => change.unstaged);
      const willPush = opts.push !== false;
      output(willPush ? 'Creating commit and pushing...' : 'Creating commit...');
      const committed = runCommitCreate(workspaceRoot, { ...commandOptions, confirm: true, all: commitAll });
      printCommitCreate(output, committed);
      await promptPrCreateAfterCommit(workspaceRoot, output, input, committed);
    });

  program
    .command('abort')
    .description('Print preservation-first recovery information for mapped repos.')
    .option('--print-recovery', 'Print recovery commands without mutation.')
    .option('--stash', 'Stash dirty work in mapped repos. Requires --confirm.')
    .option('--confirm', 'Confirm the requested non-destructive mutation, such as --stash.')
    .option('--danger-reset', 'Destructive last-resort reset and clean for dirty mapped repos. Requires --confirm-danger.')
    .option('--confirm-danger <phrase>', 'Exact required phrase for --danger-reset: "discard local work".')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { stash?: boolean; confirm?: boolean; dangerReset?: boolean; confirmDanger?: string; json?: boolean }) => {
      const result = runAbort(workspaceRoot, opts);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printAbort(output, result);
    });

  const dev = program.command('dev').description('Local development orchestration commands.');
  dev
    .command('status')
    .description('Show SDK-to-demo local dev-link state and prerequisites.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      if (!isDevLinkAvailable(workspaceRoot)) {
        output(DEV_LINK_UNAVAILABLE);
        return;
      }
      const result = runDevStatus(workspaceRoot);
      if (opts.json) {
        printJson(output, result);
        return;
      }

      printDevStatus(output, result);
    });

  dev
    .command('link')
    .description('Link local SDK packages into the standalone demo checkout.')
    .option('--skip-build', 'Do not build SDK packages before linking.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { skipBuild?: boolean; json?: boolean }) => {
      if (!isDevLinkAvailable(workspaceRoot)) {
        output(DEV_LINK_UNAVAILABLE);
        return;
      }
      const result = linkSdkToDemo(workspaceRoot, { skipBuild: opts.skipBuild });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printDevAction(output, result);
    });

  dev
    .command('unlink')
    .description('Remove local SDK package links and restore demo published-package install.')
    .option('--skip-install', 'Do not run pnpm install after removing local links.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { skipInstall?: boolean; json?: boolean }) => {
      if (!isDevLinkAvailable(workspaceRoot)) {
        output(DEV_LINK_UNAVAILABLE);
        return;
      }
      const result = unlinkSdkFromDemo(workspaceRoot, { skipInstall: opts.skipInstall });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printDevAction(output, result);
    });

  dev
    .command('test')
    .description('Run the demo Playwright e2e suite against the local backend, starting it if it is not already healthy. Reuses the same flow as `warroom pr merge`.')
    .option('--json', 'Print machine-readable output.')
    .action(async (opts: { json?: boolean }) => {
      const live = liveMergeOutput();
      const result = await runMergeE2E(
        workspaceRoot,
        { required: true, skipReason: null },
        { e2eStatus: live.e2eStatus, e2eOutput: live.e2eOutput }
      );
      if (opts.json) {
        printJson(output, result);
      } else {
        printDevTest(output, result);
      }
      if (result.status !== 'passed') process.exitCode = 1;
    });

  const changelog = program.command('changelog').description('Changelog distribution commands.');
  changelog
    .command('share')
    .description('Generate and distribute changelog updates to ally Slack channels.')
    .option('--period <period>', 'Reporting period: day, week, or month. Prompted interactively if omitted.')
    .action(async (opts: { period?: string }) => {
      const validPeriods: ChangelogPeriod[] = ['day', 'week', 'month'];

      let result: ChangelogShareResult | null = null;
      let savedDraft = loadChangelogDraft(workspaceRoot);

      if (savedDraft && interactive && !opts.period) {
        const updated = new Date(savedDraft.updatedAt);
        const ageMinutes = Math.max(1, Math.round((Date.now() - updated.getTime()) / 60_000));
        const ageLabel = ageMinutes < 60 ? `${ageMinutes} min ago` : ageMinutes < 1440 ? `${Math.round(ageMinutes / 60)} hr ago` : `${Math.round(ageMinutes / 1440)} days ago`;
        output(`Found a saved ${PERIOD_LABEL[savedDraft.period].toLowerCase()} draft from ${ageLabel} ("${savedDraft.content.title}").`);
        const resume = await promptConfirmation(output, input, 'Resume the saved draft? [Y/n]');
        if (resume) {
          output(`Resuming ${PERIOD_LABEL[savedDraft.period].toLowerCase()} draft with ${savedDraft.entries.length} entr${savedDraft.entries.length === 1 ? 'y' : 'ies'}...`);
          result = resumeChangelogShare(workspaceRoot, savedDraft);
        } else {
          clearChangelogDraft(workspaceRoot);
          savedDraft = null;
        }
      } else if (savedDraft && !interactive) {
        clearChangelogDraft(workspaceRoot);
        savedDraft = null;
      }

      if (!result) {
        let period: ChangelogPeriod;
        if (opts.period && (validPeriods as string[]).includes(opts.period)) {
          period = opts.period as ChangelogPeriod;
        } else if (opts.period) {
          output(`Invalid period "${opts.period}". Must be day, week, or month.`);
          process.exitCode = 1;
          return;
        } else if (interactive) {
          period = await selectChoice<ChangelogPeriod>({
            output,
            input,
            question: 'Select reporting period (day/week/month) [week]:',
            default: 'week',
            choices: [
              { label: 'Week', value: 'week' },
              { label: 'Day', value: 'day' },
              { label: 'Month', value: 'month' },
            ],
            retryHelp: 'Enter day, week, or month, or press Enter for week.',
          });
        } else {
          period = 'week';
        }

        output(`Loading ${PERIOD_LABEL[period].toLowerCase()} changelog entries...`);
        result = runChangelogShare(workspaceRoot, period);
        const cutoffLabel = result.cutoffSource === 'last-sent'
          ? `Cutoff: since last send at ${result.cutoff.toISOString()}.`
          : `Cutoff: rolling ${PERIOD_LABEL[period].toLowerCase().replace(' update', '')} window starting ${result.cutoff.toISOString()} (no prior send recorded).`;
        output(cutoffLabel);
      }

      if (result.error) {
        printOutcome(output, `Outcome: ${result.error}`);
        return;
      }

      output(`Found ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}:`);
      for (const entry of result.entries) output(`  ${entry.repoName}: ${entry.title}`);

      if (result.adapterError) {
        output(`Adapter error: ${result.adapterError}`);
        printOutcome(output, 'Outcome: changelog share failed — LLM adapter could not generate message content.');
        process.exitCode = 1;
        return;
      }
      if (result.adapterCommand) output(`Adapter: ${result.adapterCommand}`);

      if (result.content && !savedDraft) {
        saveChangelogDraft(workspaceRoot, result.period, result.periodLabel, result.entries, result.content, {
          cutoff: result.cutoff,
          cutoffSource: result.cutoffSource,
        });
      }

      const slackToken = readWorkspaceEnvVar(workspaceRoot, 'SLACK_BOT_TOKEN') ?? process.env.SLACK_BOT_TOKEN ?? '';
      if (!slackToken) {
        output('SLACK_BOT_TOKEN is not set. Add it to .env.local and try again.');
        printOutcome(output, 'Outcome: changelog share failed — missing SLACK_BOT_TOKEN.');
        process.exitCode = 1;
        return;
      }

      output('Posting draft to #changelog-review...');
      const reviewPost: SlackPostResult = await postToSlack(
        slackToken,
        'changelog-review',
        result.blocks!,
        result.fallbackText!
      );
      if (!reviewPost.ok) {
        output(`Failed to post to #changelog-review: ${reviewPost.error ?? 'unknown error'}`);
        printOutcome(output, 'Outcome: changelog share failed — could not post draft to #changelog-review.');
        process.exitCode = 1;
        return;
      }
      output('Draft posted to #changelog-review. Check Slack to review the message.');

      if (!interactive) {
        printOutcome(output, 'Outcome: draft posted to #changelog-review. Run interactively to approve and distribute to ally channels.');
        return;
      }

      let currentResult: ChangelogShareResult = result;
      let currentBlocks = result.blocks!;
      let currentFallbackText = result.fallbackText!;

      while (true) {
        const wantsEdits = await promptConfirmation(output, input, 'Draft sent to Slack. Would you like to make edits? [Y/n]');
        if (!wantsEdits) break;

        output('Launching interactive editor — talk through the changes with the assistant, then exit the session.');
        const editSession = captureInteractiveEditNotes(workspaceRoot, currentResult);

        if (editSession.adapterError && !editSession.launched) {
          output(`Adapter error: ${editSession.adapterError}`);
          output('Keeping previous draft.');
          break;
        }
        if (editSession.notes === null) {
          if (editSession.adapterError) output(editSession.adapterError);
          output('No revision notes captured — keeping previous draft.');
          break;
        }

        output('Regenerating with notes from the editor session...');
        const revision = reviseChangelogContent(workspaceRoot, currentResult, editSession.notes);

        if (revision.adapterError || !revision.blocks) {
          output(`Adapter error: ${revision.adapterError ?? 'no content returned'}`);
          output('Keeping previous draft.');
          break;
        }

        currentResult = { ...currentResult, content: revision.content, blocks: revision.blocks, fallbackText: revision.fallbackText };
        currentBlocks = revision.blocks;
        currentFallbackText = revision.fallbackText!;

        if (revision.content) {
          saveChangelogDraft(
            workspaceRoot,
            currentResult.period,
            currentResult.periodLabel,
            currentResult.entries,
            revision.content,
            { cutoff: currentResult.cutoff, cutoffSource: currentResult.cutoffSource },
            loadChangelogDraft(workspaceRoot)
          );
        }

        output('Posting revised draft to #changelog-review...');
        const repost = await postToSlack(slackToken, 'changelog-review', currentBlocks, currentFallbackText);
        if (!repost.ok) {
          output(`Failed to re-post to #changelog-review: ${repost.error ?? 'unknown error'}`);
          break;
        }
        output('Revised draft posted to #changelog-review.');
      }

      const finalConfirm = await promptConfirmation(output, input, 'Are you sure you\'re ready to share this changelog with your allies? [Y/n]');
      if (!finalConfirm) {
        printOutcome(output, 'Outcome: draft posted to #changelog-review. Ally distribution cancelled at final confirmation. Saved draft kept — re-run `warroom changelog share` to resume.');
        return;
      }

      if (result.alliesWithComms.length === 0) {
        output('No allies with Slack comms configured in allies.yaml.');
        clearChangelogDraft(workspaceRoot);
        printOutcome(output, 'Outcome: draft approved but no ally comms configured — nothing distributed.');
        return;
      }

      let successCount = 0;
      let failCount = 0;
      for (const ally of result.alliesWithComms) {
        for (const channel of ally.channels) {
          const post = await postToSlack(slackToken, channel, currentBlocks, currentFallbackText);
          if (post.ok) {
            output(`Posted to #${channel} (${ally.allyName})`);
            successCount++;
          } else {
            output(`Failed to post to #${channel} (${ally.allyName}): ${post.error ?? 'unknown error'}`);
            failCount++;
          }
        }
      }

      clearChangelogDraft(workspaceRoot);
      if (successCount > 0) {
        const sentAt = new Date();
        recordChangelogShareSent(workspaceRoot, currentResult.period, sentAt);
        output(`Recorded last-sent timestamp for ${PERIOD_LABEL[currentResult.period].toLowerCase()}: ${sentAt.toISOString()}.`);
      }

      printOutcome(
        output,
        `Outcome: changelog distributed to ${successCount} channel${successCount === 1 ? '' : 's'}${failCount > 0 ? `; ${failCount} failed — check output above` : ''}.`
      );
    });

  return program;
}

function realpathOrResolve(filePath: string) {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

const currentFile = realpathOrResolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? realpathOrResolve(process.argv[1]) : '';

if (currentFile === invokedFile) {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  const program = buildProgram();
  const userArgs = process.argv.slice(2);
  const shouldShowMenu = userArgs.length === 0 && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  const run = shouldShowMenu
    ? pickCommandPath(program).then((selected) => {
        if (!selected || selected.length === 0) return undefined;
        return program.parseAsync(['node', 'warroom', ...selected], { from: 'node' });
      })
    : program.parseAsync(process.argv.map((arg) => (arg === '-help' ? '--help' : arg)));
  run.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
