#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runAbort, type AbortResult } from './commands/abort.js';
import { runAlliesStatus, type AlliesStatus } from './commands/allies.js';
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
import {
  confirmIssueCreate,
  runIssueCreate,
  runIssueNext,
  runIssueTriage,
  type IssueCreateResult,
  type IssueHandoffResult,
  type IssueListResult,
  type IssueSummary,
} from './commands/issues.js';
import { runMapsAssign, type MapsAssignResult } from './commands/maps-assign.js';
import { runMapsStudy } from './commands/maps-study.js';
import {
  inferIssueRefForCurrentBranch,
  inferPrRefForCurrentBranch,
  runIssueStart,
  runPrCreate,
  runPrMerge,
  runPrReview,
  runPrReviewQueue,
  type LocalCleanupResult,
  type PrCreateResult,
  type PrPlanResult,
  type PrReviewQueueResult,
  type SummaryPostResult,
} from './commands/pr.js';
import { runSync, type SyncResult } from './commands/sync.js';
import { CAMPAIGN_STATUSES, type CampaignStatusName } from './lib/campaign.js';
import { runGit } from './lib/repos.js';
import { findWarRoomWorkspace } from './lib/workspace.js';

type Output = (text: string) => void;
type Input = NodeJS.ReadableStream & { isTTY?: boolean };
type E2EOutput = (chunk: string, stream: 'stdout' | 'stderr') => void;
type BuildProgramOptions = {
  cwd?: string;
  output?: Output;
  input?: Input;
  interactive?: boolean;
};

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
    for (const label of ally.labels.missing) output(`missing label: ${ally.issue_repo.github}:${label}`);
  }
}

function printMapsAssign(output: Output, result: MapsAssignResult) {
  output(`Campaign atlas: ${result.atlasMatches ? 'up to date' : 'needs regeneration'}`);
  output(`Resource references: ${result.resourceReferencesOk ? 'ok' : 'missing references'}`);
  for (const missing of result.missingResources) output(`missing ${missing.resource} referenced by ${missing.repo}`);
  for (const message of result.messages) output(message);
}

function printIssueList(output: Output, result: IssueListResult, options: { numbered?: boolean } = {}) {
  const selector = result.source === 'campaign' ? `Campaign status ${result.status}` : `label ${result.label}`;
  const repo = result.repo ? ` for ${result.repo}` : '';
  output(`Issues with ${selector}${repo}: ${result.issues.length}`);
  result.issues.forEach((issue, index) => {
    const prefix = options.numbered ? `${index + 1}. ` : '';
    output(`${prefix}${issue.repo}#${issue.number} ${issue.title} ${issue.url}`);
  });
}

async function promptIssueSelection(output: Output, input: Input, issues: IssueSummary[], action = 'start') {
  if (issues.length === 0) return null;

  output(`Select an issue number to ${action}, or enter 0 to cancel.`);
  output('Selection:');

  const readline = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      const answer = line.trim().toLowerCase();
      if (answer === '0' || answer === 'q' || answer === 'quit' || answer === 'cancel') return null;

      const selected = Number(answer);
      if (Number.isInteger(selected) && selected >= 1 && selected <= issues.length) {
        return issues[selected - 1] ?? null;
      }

      output(`Enter a number from 1 to ${issues.length}, or 0 to cancel.`);
      output('Selection:');
    }
  } finally {
    readline.close();
  }

  return null;
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
    return (await promptConfirmation(
      output,
      input,
      `Start PR review handoff for ${prReviewRef(pr)} now? This will run \`warroom pr review --pr ${prReviewRef(pr)} --launch\`. [y/N]`
    ))
      ? pr
      : null;
  }

  output('Select a PR number to review, or enter 0 to cancel.');
  output('Selection:');

  const readline = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      const answer = line.trim().toLowerCase();
      if (answer === '0' || answer === 'q' || answer === 'quit' || answer === 'cancel') return null;

      const selected = Number(answer);
      if (Number.isInteger(selected) && selected >= 1 && selected <= prs.length) {
        return prs[selected - 1] ?? null;
      }

      output(`Enter a number from 1 to ${prs.length}, or 0 to cancel.`);
      output('Selection:');
    }
  } finally {
    readline.close();
  }

  return null;
}

async function promptConfirmation(output: Output, input: Input, question: string) {
  output(question);

  const readline = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      const answer = line.trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    }
  } finally {
    readline.close();
  }

  return false;
}

async function promptMergeConfirmation(output: Output, input: Input, question: string): Promise<'confirm' | 'skip' | 'cancel'> {
  output(question);

  const readline = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      const answer = line.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return 'confirm';
      if (answer === 's' || answer === 'skip') return 'skip';
      if (!answer || answer === 'n' || answer === 'no') return 'cancel';
      output('Enter y to run the gate, skip to merge without Playwright, or n to cancel.');
    }
  } finally {
    readline.close();
  }

  return 'cancel';
}

async function promptBlockedMergeConfirmation(output: Output, input: Input, question: string): Promise<'confirm' | 'skip' | 'cancel'> {
  output(question);

  const readline = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      const answer = line.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return 'confirm';
      if (answer === 's' || answer === 'skip') return 'skip';
      if (!answer || answer === 'n' || answer === 'no') return 'cancel';
      output('Enter y to recheck blockers, skip to allow unresolved review threads, or n to cancel.');
    }
  } finally {
    readline.close();
  }

  return 'cancel';
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
  if (result.labelUpdate) {
    const removed = result.labelUpdate.removeLabels.length ? `; removed ${result.labelUpdate.removeLabels.join(', ')}` : '';
    output(
      `Issue labels: ${result.labelUpdate.applied ? 'updated' : 'planned'} ${result.labelUpdate.issue} +${result.labelUpdate.addLabel}${removed}`
    );
    if (result.labelUpdate.error) output(`label update error: ${result.labelUpdate.error}`);
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
  if (!options.suppressOutcome) output(issueTriageOutcome(result));
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
      return `Outcome: interactive issue triage session completed, but ready-to-engage closeout was blocked. ${result.closeoutError}`;
    }
    if (result.triageNotes && !result.triageNotes.ready) {
      return `Outcome: interactive issue triage session completed, but Campaign status was not updated. ${result.triageNotes.reason ?? 'Triage notes did not mark the issue ready.'}`;
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
  if (result.labelUpdate) {
    const removed = result.labelUpdate.removeLabels.length ? `; removed ${result.labelUpdate.removeLabels.join(', ')}` : '';
    output(
      `Issue labels: ${result.labelUpdate.applied ? 'updated' : 'planned'} ${result.labelUpdate.issue} +${result.labelUpdate.addLabel}${removed}`
    );
    if (result.labelUpdate.error) output(`label update error: ${result.labelUpdate.error}`);
  }
  if (result.closeoutError) output(`issue closeout error: ${result.closeoutError}`);
  output(issueCreateOutcome(result));
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
    return `Outcome: not handed off to LLM adapter. Resolve the blocker above, then rerun the issue start command.`;
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
    return 'Outcome: PR review loop blocked. Resolve the blocker above, then rerun the PR review command.';
  }

  if (result.prReviewLoop?.completed) {
    return 'Outcome: PR review loop complete; no outstanding CodeRabbit feedback remains.';
  }

  if (result.launched) {
    return `Outcome: handed off to LLM adapter for PR review.${status}`;
  }

  return 'Outcome: preflight only; no LLM handoff was launched. Rerun with `--launch` to start the PR review loop.';
}

function printPrPlan(output: Output, result: PrPlanResult) {
  const state = result.launchError
    ? 'blocked'
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
  if (result.mergeChangelog) {
    output(`Merge changelog: ${result.mergeChangelog.status}${result.mergeChangelog.skipReason ? ` (${result.mergeChangelog.skipReason})` : ''}`);
    if (result.mergeChangelog.required) {
      output(`Changelog: ${result.mergeChangelog.changelogPath ?? 'missing'} (base ${result.mergeChangelog.base})`);
      output(`Changelog actions: ${result.mergeChangelog.actionsHeadSha ?? 'planned'} (${result.mergeChangelog.actionsRuns.length} runs)`);
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
      output(
        `review loop ${iteration.iteration}: ${iteration.startHeadSha ?? 'unknown'} -> ${iteration.endHeadSha ?? 'unknown'}; CodeRabbit comments ${comments}`
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
  if (result.labelUpdate) {
    const removed = result.labelUpdate.removeLabels.length ? `; removed ${result.labelUpdate.removeLabels.join(', ')}` : '';
    output(
      `Issue labels: ${result.labelUpdate.applied ? 'updated' : 'planned'} ${result.labelUpdate.issue} +${result.labelUpdate.addLabel}${removed}`
    );
    if (result.labelUpdate.error) output(`label update error: ${result.labelUpdate.error}`);
  }
  output(result.prompt);
  const outcome = issueStartOutcome(result) ?? prReviewOutcome(result);
  if (outcome) output(outcome);
}

function printPrCreate(output: Output, result: PrCreateResult) {
  output(`PR create: ${result.created ? 'created' : 'preflight only'}`);
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
  if (result.labelUpdate) {
    const removed = result.labelUpdate.removeLabels.length ? `; removed ${result.labelUpdate.removeLabels.join(', ')}` : '';
    output(
      `Issue labels: ${result.labelUpdate.applied ? 'updated' : 'planned'} ${result.labelUpdate.issue} +${result.labelUpdate.addLabel}${removed}`
    );
    if (result.labelUpdate.error) output(`label update error: ${result.labelUpdate.error}`);
  }
  output(result.body);
  if (result.created && result.url) {
    output(`PR URL: ${result.url}`);
  } else if (result.blocked.length > 0) {
    output('Outcome: PR not created. Resolve the blocked items above, then rerun `warroom pr create --confirm`.');
  } else {
    output('Outcome: PR not created. This was a preflight; run `warroom pr create --confirm` or answer yes in an interactive terminal to push and create the PR.');
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

async function promptPrMergeFollowUps(
  workspaceRoot: string,
  output: Output,
  input: Input,
  options: {
    pr: string;
    issue?: string;
    summary?: string;
    confirmSummary?: boolean;
    confirmCleanup?: boolean;
  }
) {
  if (!options.confirmSummary) {
    const postSummary = await promptConfirmation(output, input, 'Post victory summary comments now? [y/N]');
    if (postSummary) {
      const summaryResult = await runPrMerge(workspaceRoot, {
        pr: options.pr,
        issue: options.issue,
        summary: options.summary,
        postSummary: true,
        confirmSummary: true,
      });
      printSummaryPosts(output, summaryResult.summaryPosts);
    }
  }

  if (!options.confirmCleanup) {
    const cleanup = await promptConfirmation(output, input, 'Return the local checkout to the PR base branch now? [y/N]');
    if (cleanup) {
      const cleanupResult = await runPrMerge(workspaceRoot, {
        pr: options.pr,
        cleanupLocal: true,
        confirmCleanup: true,
      });
      printLocalCleanup(output, cleanupResult.localCleanup);
    }
  }
}

function printPrReviewQueue(output: Output, result: PrReviewQueueResult, options: { numbered?: boolean; suppressOutcome?: boolean } = {}) {
  output(`Open PRs for Campaign statuses ${result.statuses.join(', ')}: ${result.prs.length}`);
  result.prs.forEach((pr, index) => {
    const issues = pr.issues
      .map((issue) => `${issue.repo}#${issue.number}${issue.status ? ` ${issue.status}` : ''}`)
      .join(', ');
    const prefix = options.numbered ? `${index + 1}. ` : '';
    output(`${prefix}${pr.repo}#${pr.number} ${pr.title} (updated ${pr.updatedAt ?? 'unknown'}; issue ${issues}) ${pr.url}`);
  });
  if (options.suppressOutcome) return;
  if (result.prs.length === 0) {
    output(`Outcome: no open PRs found for Campaign statuses ${result.statuses.join(', ')}.`);
  } else {
    output(
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
  for (const blocker of result.blocked) output(`blocked: ${blocker}`);
}

async function promptPrCreateAfterCommit(
  workspaceRoot: string,
  output: Output,
  input: Input,
  result: CommitCreateResult
) {
  if (!result.committed) return;

  const createPr = await promptConfirmation(output, input, 'Run `warroom pr create` next? [y/N]');
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
  result: PrPlanResult
) {
  if (result.action !== 'issue-start' || !result.launched || result.launchError || !result.adapterCwd) return;

  const readiness = issueStartPrReadiness(result);
  if (readiness?.dirty) {
    output(
      `PR create is not ready: ${readiness.dirtyCount} uncommitted change${
        readiness.dirtyCount === 1 ? '' : 's'
      } ${readiness.dirtyCount === 1 ? 'remains' : 'remain'} in ${readiness.repoPath}.`
    );
    const commitNow = await promptConfirmation(
      output,
      input,
      `Run \`warroom commit create --issue ${result.issue ?? '<issue>'}\` now? This will stage all current changes before committing. [y/N]`
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
      await promptPrCreateAfterCommit(workspaceRoot, output, input, committed);
    } catch (error) {
      output(`Commit create failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (readiness && !readiness.ready) {
    output(`PR create is not ready: ${readiness.blocker ?? 'branch is not ready for PR creation.'}`);
    output(
      `Outcome: PR create was not offered. Commit the implementation on ${readiness.branch}, then rerun \`warroom pr create\`.`
    );
    return;
  }

  const createPr = await promptConfirmation(output, input, 'Run `warroom pr create` next? [y/N]');
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

  const startIssue = await promptConfirmation(output, input, `Run \`warroom issue next --issue ${issue}\` now? [y/N]`);
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

async function promptPrReviewAfterPrCreate(
  workspaceRoot: string,
  output: Output,
  input: Input,
  result: PrCreateResult,
  options: { writeArtifact?: boolean }
) {
  if (!result.created) return;
  const prRef = prRefFromCreateResult(result);
  if (!prRef) return;

  const reviewPr = await promptConfirmation(output, input, 'Run `warroom pr review` next? [y/N]');
  if (!reviewPr) return;

  output(`Starting PR review for ${prRef}`);
  const review = await runPrReview(workspaceRoot, {
    pr: prRef,
    issue: result.issue ?? undefined,
    dryRun: false,
    confirmStatus: true,
    writeArtifact: options.writeArtifact,
    reviewStatus: output,
    waitForInitialCodeRabbit: true,
  });
  printPrPlan(output, review);
  if (review.launchError) process.exitCode = 1;
}

async function promptIssueTriageAfterCreate(
  workspaceRoot: string,
  output: Output,
  input: Input,
  result: IssueCreateResult
) {
  if (!result.created || !result.issue) return;

  const triage = await promptConfirmation(output, input, `Run \`warroom issue triage --issue ${result.issue}\` now? [y/N]`);
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
  output(`Project item: ${result.projectItemId ?? 'not added in preview'}`);
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

export function buildProgram(options: BuildProgramOptions = {}) {
  const invocationCwd = options.cwd ?? process.cwd();
  const workspaceRoot = findWarRoomWorkspace(invocationCwd);
  const output = options.output ?? console.log;
  const customOutput = options.output !== undefined;
  const input = options.input ?? process.stdin;
  const interactive = options.interactive ?? Boolean(input.isTTY);
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
      for (const note of result.env.notes) output(`LLM note: ${note}`);
      output(`Allies: ${result.allies.ok ? 'ok' : 'needs attention'} (${result.allies.activeAllyCount} active, ${result.allies.plannedAllyCount} planned)`);
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
      const devStatus = runDevStatus(workspaceRoot);
      output(`SDK-to-demo dev link: ${devStatus.linked ? 'linked' : devStatus.partiallyLinked ? 'partially linked' : 'unlinked'}`);
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

        const confirmed = await promptConfirmation(output, input, 'Create this GitHub issue now? [y/N]');
        if (!confirmed) {
          output('Issue not created.');
          output('Outcome: issue not created. Draft remains available for review.');
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
    .action(() => output('warroom issue fortify is deferred from the MVP and tracked in TeamFloPay/infra#7.'));
  issue
    .command('triage')
    .description('List triage issues or create a scoped LLM triage handoff for one issue.')
    .option('--issue <owner/repo#number>', 'Issue to triage.')
    .option('--label <label>', 'Label used for triage listing.', 'needs-triage')
    .option('--mark-ready', 'Preview or move the issue to ready-to-engage after triage.')
    .option('--confirm-status', 'Apply the Campaign Map status movement requested by --mark-ready.')
    .option('--dry-run', 'Print the structured handoff without launching the configured LLM adapter.')
    .option('--launch', 'Launch the configured LLM adapter. Direct issue handoffs default to dry-run output.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--no-select', 'List issues without prompting for a selection.')
    .option('--json', 'Print machine-readable output.')
    .action(async (opts: { issue?: string; label?: string; markReady?: boolean; confirmStatus?: boolean; dryRun?: boolean; launch?: boolean; writeArtifact?: boolean; select?: boolean; json?: boolean }) => {
      const triageDryRun = (selectedInteractively: boolean) =>
        opts.dryRun === true ? true : selectedInteractively ? false : !opts.launch;
      const runTriage = (issueRef?: string, selectedInteractively = false) => {
        const dryRun = triageDryRun(selectedInteractively);
        return runIssueTriage(workspaceRoot, {
          issue: issueRef,
          label: opts.label,
          markReady: opts.markReady || selectedInteractively,
          confirmStatus: dryRun ? false : opts.confirmStatus || selectedInteractively,
          dryRun,
          writeArtifact: opts.writeArtifact,
        });
      };

      const result = runTriage(opts.issue);
      if (opts.json) {
        printJson(output, result);
        return;
      }
      if (!('issues' in result)) {
        const canLaunchAfterPreview =
          Boolean(opts.issue) && interactive && opts.dryRun !== true && opts.launch !== true && !result.launched && !result.launchError;
        printIssueHandoff(output, result, { suppressOutcome: canLaunchAfterPreview });
        if (canLaunchAfterPreview && opts.issue) {
          const launch = await promptConfirmation(
            output,
            input,
            `Start issue triage handoff for ${opts.issue} now? This will run \`warroom issue triage --issue ${opts.issue} --launch --mark-ready --confirm-status\`. [y/N]`
          );
          if (!launch) {
            output('Outcome: no issue triage handoff started.');
            return;
          }

          output(`Triaging ${opts.issue}`);
          const launched = runIssueTriage(workspaceRoot, {
            issue: opts.issue,
            label: opts.label,
            markReady: true,
            confirmStatus: true,
            dryRun: false,
            writeArtifact: opts.writeArtifact,
          });
          if ('issues' in launched) printIssueList(output, launched);
          else {
            printIssueHandoff(output, launched);
            await promptIssueNextAfterTriage(workspaceRoot, output, input, opts.issue, launched);
          }
        }
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
        output(result.issues.length === 0 ? 'Outcome: no triage issues found; no issue selected.' : 'Outcome: no issue selected.');
        return;
      }

      const selected = await promptIssueSelection(output, input, result.issues, 'triage');
      if (!selected) {
        output('No issue selected.');
        output('Outcome: no issue selected.');
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
    .command('next')
    .description('List issues ready for implementation and select one to start development.')
    .option('--issue <owner/repo#number>', 'Start this issue directly instead of prompting for a selection.')
    .option('--label <label>', 'Ready label to query.', 'ready-to-engage')
    .option('--base <branch>', 'Target branch for the eventual PR.', 'main')
    .option('--dry-run', 'Print the selected issue handoff without launching the adapter or moving Campaign Map status.')
    .option('--launch', 'Launch the configured LLM adapter for the selected issue. This is the default after selection.')
    .option('--confirm-status', 'Move the selected issue to battlefield-active on the Campaign Map. This is the default after selection.')
    .option('--no-status', 'Do not move the selected issue to battlefield-active.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--no-select', 'List issues without prompting for a selection.')
    .option('--all', 'List ready issues across all mapped repos, even from inside a child repo checkout.')
    .option('--json', 'Print machine-readable output.')
    .action(
      async (opts: {
        issue?: string;
        label?: string;
        base?: string;
        dryRun?: boolean;
        launch?: boolean;
        confirmStatus?: boolean;
        status?: boolean;
        writeArtifact?: boolean;
        select?: boolean;
        all?: boolean;
        json?: boolean;
      }) => {
        if (opts.issue) {
          const dryRun = opts.dryRun === true;
          if (!opts.json) output(`Starting ${opts.issue}`);
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
          if (interactive) await promptPrCreateAfterIssueStart(workspaceRoot, output, input, plan);
          return;
        }

        const result = runIssueNext(workspaceRoot, {
          label: opts.label,
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
          output(result.issues.length === 0 ? 'Outcome: no ready issues found; no issue started.' : 'Outcome: no issue started.');
          return;
        }

        const selected = await promptIssueSelection(output, input, result.issues);
        if (!selected) {
          output('No issue selected.');
          output('Outcome: no issue started.');
          return;
        }

        const issueRef = `${selected.repo}#${selected.number}`;
        output(`Starting ${issueRef}`);
        const dryRun = opts.dryRun === true;
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
        await promptPrCreateAfterIssueStart(workspaceRoot, output, input, plan);
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
        });
        return;
      }

      if (opts.confirm || !interactive || result.blocked.length > 0) return;

      const confirmed = await promptConfirmation(output, input, 'Push this branch and create the GitHub PR now? [y/N]');
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
    .option('--launch', 'Launch the configured LLM adapter. Defaults to dry-run handoff output.')
    .option('--check-in-minutes <minutes>', 'Compatibility option; review polling is controlled by WARROOM_PR_REVIEW_* env vars.', (value) => Number(value), 60)
    .option('--confirm-status', 'Move the linked issue to skirmish on the Campaign Map. This is the default when launching review.')
    .option('--no-status', 'Do not move the linked issue to skirmish.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--json', 'Print machine-readable output.')
    .action(async (opts: { pr?: string; issue?: string; dryRun?: boolean; launch?: boolean; checkInMinutes?: number; confirmStatus?: boolean; status?: boolean; writeArtifact?: boolean; json?: boolean }) => {
      if (!opts.pr) {
        const result = runPrReviewQueue();
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
            output(`Outcome: no open PRs found for Campaign statuses ${result.statuses.join(', ')} or the current branch.`);
            return;
          }

          output(`Resolved current branch PR: ${inferredPr}`);
          let launch = opts.launch === true;
          if (!launch && interactive && opts.dryRun !== true) {
            launch = await promptConfirmation(
              output,
              input,
              `Start PR review handoff for ${inferredPr} now? This will run \`warroom pr review --pr ${inferredPr} --launch\`. [y/N]`
            );
            if (!launch) {
              output('Outcome: no PR review handoff started.');
              return;
            }
          }

          const dryRun = opts.dryRun === true ? true : !launch;
          const review = await runPrReview(workspaceRoot, {
            pr: inferredPr,
            issue: opts.issue ?? inferIssueRefForCurrentBranch(workspaceRoot, invocationCwd) ?? undefined,
            dryRun,
            checkInMinutes: opts.checkInMinutes,
            confirmStatus: shouldConfirmPrReviewStatus(dryRun, opts),
            writeArtifact: opts.writeArtifact,
            reviewStatus: launch ? output : undefined,
          });
          printPrPlan(output, review);
          if (review.launchError) process.exitCode = 1;
          return;
        }

        const selected = await promptPrReviewSelection(output, input, result.prs);
        if (!selected) {
          output('Outcome: no PR review handoff started.');
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
        });
        printPrPlan(output, review);
        if (review.launchError) process.exitCode = 1;
        return;
      }

      const dryRun = opts.dryRun ?? !opts.launch;
      const result = await runPrReview(workspaceRoot, {
        pr: opts.pr,
        issue: opts.issue ?? inferIssueRefForCurrentBranch(workspaceRoot, invocationCwd) ?? undefined,
        dryRun,
        checkInMinutes: opts.checkInMinutes,
        confirmStatus: shouldConfirmPrReviewStatus(dryRun, opts),
        writeArtifact: opts.writeArtifact,
        reviewStatus: opts.json ? undefined : output,
      });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printPrPlan(output, result);
      if (result.launchError) process.exitCode = 1;
    });
  pr
    .command('merge')
    .description('Preflight or confirm a GitHub PR merge gated by the demo Playwright e2e run.')
    .option('--pr <owner/repo#number>', 'PR to merge. Omit to infer from the current mapped repo branch.')
    .option('--issue <owner/repo#number>', 'Linked issue to move to victory.')
    .option('--confirm', 'Run the demo e2e gate, then gh pr merge --squash --delete-branch.')
    .option('--confirm-status', 'Move the linked issue to victory on the Campaign Map.')
    .option('--summary <text>', 'Victory summary to include in local artifacts and optional comments.')
    .option('--post-summary', 'Plan or post victory summary comments to the PR and linked issue.')
    .option('--confirm-summary', 'Actually post victory summary comments. Implies --post-summary.')
    .option('--no-issue-comment', 'Do not post the final victory closeout comment back to the linked issue after merge.')
    .option('--cleanup-local', 'Plan or return the mapped local checkout to the PR base branch and pull it.')
    .option('--confirm-cleanup', 'Actually switch the mapped local checkout and pull when cleanup is safe. Implies --cleanup-local.')
    .option('--write-artifact', 'Write prompt/input artifacts under .warroom/runs.')
    .option('--json', 'Print machine-readable output.')
    .action(async (opts: {
      pr?: string;
      issue?: string;
      confirm?: boolean;
      confirmStatus?: boolean;
      summary?: string;
      postSummary?: boolean;
      confirmSummary?: boolean;
      issueComment?: boolean;
      cleanupLocal?: boolean;
      confirmCleanup?: boolean;
      writeArtifact?: boolean;
      json?: boolean;
    }) => {
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
        confirm: opts.confirm,
        confirmStatus: opts.confirmStatus,
        summary: opts.summary,
        postSummary: opts.postSummary || opts.confirmSummary,
        confirmSummary: opts.confirmSummary,
        issueComment: opts.issueComment,
        cleanupLocal: opts.cleanupLocal || opts.confirmCleanup,
        confirmCleanup: opts.confirmCleanup,
        writeArtifact: opts.writeArtifact,
        ...liveE2EOutput,
      });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printPrPlan(output, result);
      if (result.mergeChangelog?.required && result.mergeChangelog.status === 'failed') process.exitCode = 1;

      let confirmedResult = result;
      if (interactive && !opts.confirm && !result.merged) {
        const blocked = (result.mergeReadiness?.blocked.length ?? 0) > 0;
        let allowUnresolvedReviewThreads = false;
        let skipMergeE2E = false;
        let mergeChoice: 'confirm' | 'skip' | 'cancel';
        if (blocked) {
          mergeChoice = await promptBlockedMergeConfirmation(
            output,
            input,
            'Preflight is blocked. Recheck readiness and attempt the confirmed merge only if blockers are clear? Type "skip" to allow unresolved review threads if no other blockers remain. [y/N/skip]'
          );
          allowUnresolvedReviewThreads = mergeChoice === 'skip';
        } else {
          mergeChoice = await promptMergeConfirmation(
            output,
            input,
            'Continue to run the demo Playwright e2e gate and merge this PR now? Type "skip" to merge without the Playwright gate. [y/N/skip]'
          );
          skipMergeE2E = mergeChoice === 'skip';
        }
        if (mergeChoice !== 'cancel') {
          output(
            allowUnresolvedReviewThreads
              ? 'Running confirmed PR merge while allowing unresolved review threads...'
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
            confirmStatus: opts.confirmStatus,
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
          if (confirmedResult.mergeChangelog?.required && confirmedResult.mergeChangelog.status === 'failed') process.exitCode = 1;
        }
      }

      if (!interactive || !confirmedResult.merged) return;
      if (confirmedResult.mergeChangelog?.required && confirmedResult.mergeChangelog.status === 'failed') return;

      await promptPrMergeFollowUps(workspaceRoot, output, input, {
        pr: resolvedPr,
        issue: confirmedResult.issue ?? resolvedIssue,
        summary: opts.summary,
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
      const question = commitAll
        ? willPush
          ? 'Commit all listed changes and push to the remote branch now? This will run git add -A before committing. [y/N]'
          : 'Commit all listed changes now? This will run git add -A before committing. [y/N]'
        : willPush
          ? 'Commit staged changes and push to the remote branch now? [y/N]'
          : 'Commit staged changes now? [y/N]';
      const confirmed = await promptConfirmation(output, input, question);
      if (!confirmed) {
        output('Commit cancelled.');
        return;
      }

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
  buildProgram()
    .parseAsync(process.argv.map((arg) => (arg === '-help' ? '--help' : arg)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
