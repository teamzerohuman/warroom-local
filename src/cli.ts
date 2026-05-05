#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAbort, type AbortResult } from './commands/abort.js';
import { runBootstrap, type BootstrapResult } from './commands/bootstrap.js';
import { runCampaignLabels, runCampaignStatus, runCampaignStatusCheck } from './commands/campaign.js';
import { runCommitCreate, type CommitCreateResult } from './commands/commit-create.js';
import {
  linkSdkToDemo,
  runDevStatus,
  type DevActionResult,
  type DevStatus,
  unlinkSdkFromDemo,
} from './commands/dev-link.js';
import { runDoctor } from './commands/doctor.js';
import { runIssueNext, runIssueTriage, type IssueHandoffResult, type IssueListResult } from './commands/issues.js';
import { runMapsAssign, type MapsAssignResult } from './commands/maps-assign.js';
import { runMapsStudy } from './commands/maps-study.js';
import { runPrEngage, runPrMerge, runPrReview, type PrPlanResult } from './commands/pr.js';
import { runSync, type SyncResult } from './commands/sync.js';
import { CAMPAIGN_STATUSES, type CampaignStatusName } from './lib/campaign.js';

type Output = (text: string) => void;

function printJson(output: Output, value: unknown) {
  output(JSON.stringify(value, null, 2));
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
}

function printSync(output: Output, result: SyncResult) {
  output(`War Room sync: ${result.ok ? 'ok' : 'needs attention'}${result.reportOnly ? ' (report only)' : ''}`);
  for (const repo of result.repos) {
    output(`${repo.state} ${repo.repo} ${repo.branch ?? 'no-branch'}@${repo.headSha ?? 'unknown'} -> ${repo.path}`);
    if (repo.detail) output(repo.detail);
  }
}

function printMapsAssign(output: Output, result: MapsAssignResult) {
  output(`Campaign atlas: ${result.atlasMatches ? 'up to date' : 'needs regeneration'}`);
  output(`Resource references: ${result.resourceReferencesOk ? 'ok' : 'missing references'}`);
  for (const missing of result.missingResources) output(`missing ${missing.resource} referenced by ${missing.repo}`);
  for (const message of result.messages) output(message);
}

function printIssueList(output: Output, result: IssueListResult) {
  output(`Issues with label ${result.label}: ${result.issues.length}`);
  for (const issue of result.issues) output(`${issue.repo}#${issue.number} ${issue.title} ${issue.url}`);
}

function printIssueHandoff(output: Output, result: IssueHandoffResult) {
  output(`Adapter: ${result.adapterCommand}${result.launched ? ' (launched)' : ' (not launched)'}`);
  if (result.artifact) output(`Artifact: ${result.artifact.runDir}`);
  output(result.prompt);
}

function printPrPlan(output: Output, result: PrPlanResult) {
  output(`PR ${result.action}: ${result.launched ? 'launched' : 'preflight only'}`);
  if (result.adapterCommand) output(`Adapter: ${result.adapterCommand}`);
  if (result.artifact) output(`Artifact: ${result.artifact.runDir}`);
  output(result.prompt);
}

function printCommitCreate(output: Output, result: CommitCreateResult) {
  output(`Commit create for ${result.repo}: ${result.committed ? 'committed' : 'preflight only'}`);
  output(`Path: ${result.path}`);
  output(`Suggested message: ${result.suggestedMessage}`);
  for (const line of result.statusLines) output(line);
  for (const blocker of result.blocked) output(`blocked: ${blocker}`);
}

function printAbort(output: Output, result: AbortResult) {
  for (const message of result.messages) output(message);
  for (const repo of result.repos) {
    output(`${repo.repo}: ${repo.checkedOut ? 'present' : 'missing'} ${repo.branch ?? 'no-branch'}@${repo.headSha ?? 'unknown'}${repo.dirty ? ' dirty' : ' clean'}`);
    for (const command of repo.recoveryCommands) output(`  ${command}`);
  }
}

function printCampaignLabels(output: Output, result: ReturnType<typeof runCampaignLabels>) {
  output(`Campaign labels: ${result.errors.length > 0 ? 'check failed' : result.missing.length === 0 ? 'ok' : `${result.missing.length} missing`}`);
  if ('applied' in result && 'created' in result && Array.isArray(result.created)) {
    output(`Applied: ${result.applied ? 'yes' : 'no'} (${result.created.length} created)`);
  }
  for (const missing of result.missing) output(`missing ${missing.label} in ${missing.repo}`);
  for (const command of result.createPlan) output(`create plan: ${command}`);
  for (const error of result.errors) output(`error ${error.repo}: ${error.detail}`);
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
  output(`Project item: ${result.projectItemId}`);
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

  const linkState = result.linked
    ? 'linked'
    : result.partiallyLinked
      ? 'partially linked'
      : result.legacyDirectLinked
        ? 'legacy direct links'
        : 'unlinked';
  output(`SDK-to-demo dev link: ${linkState}`);
  for (const packageLink of result.packages) {
    const build = packageLink.buildOutputExists ? 'built' : 'missing dist';
    if (packageLink.linked) {
      output(`ok ${packageLink.name} -> ${packageLink.targetPath} (${build})`);
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

export function buildProgram(options: { cwd?: string; output?: Output } = {}) {
  const workspaceRoot = options.cwd ?? process.cwd();
  const output = options.output ?? console.log;
  const program = new Command();

  program
    .name('warroom')
    .description('TeamFloPay local command center and cross-repo orchestration workspace.')
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
      output(`Resource references: ${result.resources.referencesOk ? 'ok' : 'missing references'}`);
      output(
        `Campaign statuses: ${result.campaignStatuses.errors.length > 0 ? 'check failed' : result.campaignStatuses.missing.length === 0 && result.campaignStatuses.unexpected.length === 0 ? 'ok' : 'needs attention'}`
      );
      const missingLabels = result.campaignLabels.missing.length;
      output(
        `Campaign labels: ${result.campaignLabels.errors.length > 0 ? 'check failed' : missingLabels === 0 ? 'ok' : `${missingLabels} missing`}`
      );
      if (missingLabels > 0) output('Run warroom doctor --json to inspect campaignLabels.createPlan before creating labels.');
      for (const repo of result.repos) {
        const checkout = repo.checkedOut ? `${repo.source} checkout` : 'missing';
        const dirty = repo.clean === false ? ', dirty' : repo.clean === true ? ', clean' : '';
        output(`${repo.github}: ${checkout}${dirty} -> ${repo.resolvedPath}`);
      }
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
      const devStatus = runDevStatus(workspaceRoot);
      output(`SDK-to-demo dev link: ${devStatus.linked ? 'linked' : devStatus.partiallyLinked ? 'partially linked' : 'unlinked'}`);
    });

  maps
    .command('assign')
    .description('Validate or update repo specialist/resource assignments and regenerate the campaign atlas.')
    .option('--repo <id>', 'Repo id to update.')
    .option('--sergeant <name>', 'Set the repo Sergeant name.')
    .option('--add-resource <id>', 'Add a resource id to the repo allowlist.', collect, [])
    .option('--remove-resource <id>', 'Remove a resource id from the repo allowlist.', collect, [])
    .option('--write', 'Write repos.yaml and regenerate maps/campaign-atlas.md.')
    .option('--check', 'Validate assignments and atlas state.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { repo?: string; sergeant?: string; addResource?: string[]; removeResource?: string[]; write?: boolean; check?: boolean; json?: boolean }) => {
      const result = runMapsAssign(workspaceRoot, opts);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printMapsAssign(output, result);
    });

  program
    .command('bootstrap')
    .description('Clone missing child repos under maps/repos and verify required tools.')
    .option('--dry-run', 'Show clone actions without running them.')
    .option('--include-planned', 'Include planned repos.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { dryRun?: boolean; includePlanned?: boolean; json?: boolean }) => {
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

  const campaign = program.command('campaign').description('Campaign Map setup and status commands.');
  campaign
    .command('labels')
    .description('Check or apply Campaign Map workflow labels across mapped repos.')
    .option('--apply', 'Create missing labels. Requires --confirm.')
    .option('--confirm', 'Confirm label creation when used with --apply.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { apply?: boolean; confirm?: boolean; json?: boolean }) => {
      const result = runCampaignLabels(workspaceRoot, opts);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printCampaignLabels(output, result);
    });

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
    .description('Post-MVP feature issue creation flow.')
    .action(() => output('warroom issue create is deferred from the MVP and tracked in TeamFloPay/infra#7.'));
  issue
    .command('fortify')
    .description('Post-MVP quality/refactor issue creation flow.')
    .action(() => output('warroom issue fortify is deferred from the MVP and tracked in TeamFloPay/infra#7.'));
  issue
    .command('triage')
    .description('List triage issues or create a scoped LLM triage handoff for one issue.')
    .option('--issue <owner/repo#number>', 'Issue to triage.')
    .option('--label <label>', 'Label used for triage listing.', 'needs-triage')
    .option('--launch', 'Launch the configured LLM adapter. Defaults to dry-run handoff output.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { issue?: string; label?: string; launch?: boolean; writeArtifact?: boolean; json?: boolean }) => {
      const result = runIssueTriage(workspaceRoot, {
        issue: opts.issue,
        label: opts.label,
        dryRun: !opts.launch,
        writeArtifact: opts.writeArtifact,
      });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      if ('issues' in result) printIssueList(output, result);
      else printIssueHandoff(output, result);
    });
  issue
    .command('next')
    .description('List issues ready for implementation using a matching label.')
    .option('--label <label>', 'Ready label to query.', 'ready-to-engage')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { label?: string; json?: boolean }) => {
      const result = runIssueNext(workspaceRoot, opts.label);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printIssueList(output, result);
    });

  const pr = program.command('pr').description('Pull request workflow commands.');
  pr
    .command('engage')
    .description('Create a scoped PR engagement preflight handoff from an issue.')
    .requiredOption('--issue <owner/repo#number>', 'Issue to implement.')
    .option('--launch', 'Launch the configured LLM adapter. Defaults to dry-run handoff output.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { issue: string; launch?: boolean; writeArtifact?: boolean; json?: boolean }) => {
      const result = runPrEngage(workspaceRoot, { issue: opts.issue, dryRun: !opts.launch, writeArtifact: opts.writeArtifact });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printPrPlan(output, result);
    });
  pr
    .command('review')
    .description('Create a scoped PR review-loop handoff.')
    .requiredOption('--pr <owner/repo#number>', 'PR to review.')
    .option('--launch', 'Launch the configured LLM adapter. Defaults to dry-run handoff output.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { pr: string; launch?: boolean; writeArtifact?: boolean; json?: boolean }) => {
      const result = runPrReview(workspaceRoot, { pr: opts.pr, dryRun: !opts.launch, writeArtifact: opts.writeArtifact });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printPrPlan(output, result);
    });
  pr
    .command('merge')
    .description('Preflight or confirm a GitHub PR merge.')
    .requiredOption('--pr <owner/repo#number>', 'PR to merge.')
    .option('--confirm', 'Actually run gh pr merge --squash --delete-branch.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { pr: string; confirm?: boolean; writeArtifact?: boolean; json?: boolean }) => {
      const result = runPrMerge(workspaceRoot, { pr: opts.pr, confirm: opts.confirm, writeArtifact: opts.writeArtifact });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printPrPlan(output, result);
    });

  const commit = program.command('commit').description('Commit workflow commands.');
  commit
    .command('create')
    .description('Inspect a child repo and optionally create a conventional commit.')
    .requiredOption('--repo <id>', 'Repo id from repos.yaml.')
    .option('--message <message>', 'Commit message to use.')
    .option('--all', 'Stage all changes before committing. Requires --confirm.')
    .option('--confirm', 'Actually create the commit.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { repo: string; message?: string; all?: boolean; confirm?: boolean; json?: boolean }) => {
      const result = runCommitCreate(workspaceRoot, opts);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printCommitCreate(output, result);
    });

  program
    .command('abort')
    .description('Print preservation-first recovery information for mapped repos.')
    .option('--print-recovery', 'Print recovery commands without mutation.')
    .option('--stash', 'Stash dirty work in mapped repos. Requires --confirm.')
    .option('--confirm', 'Confirm the requested non-destructive mutation, such as --stash.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { stash?: boolean; confirm?: boolean; json?: boolean }) => {
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
      const result = unlinkSdkFromDemo(workspaceRoot, { skipInstall: opts.skipInstall });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printDevAction(output, result);
    });

  return program;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (path.resolve(currentFile) === invokedFile) {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  buildProgram().parse(process.argv.map((arg) => (arg === '-help' ? '--help' : arg)));
}
