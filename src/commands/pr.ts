import { spawnSync } from 'node:child_process';
import { createRunArtifact, type RunArtifact } from '../lib/artifacts.js';
import { setCampaignStatus, type CampaignStatusSetResult } from '../lib/campaign.js';
import { getAdapterCommand } from '../lib/env.js';
import { parseIssueRef } from './issues.js';

export type PrOptions = {
  issue?: string;
  pr?: string;
  dryRun?: boolean;
  writeArtifact?: boolean;
  confirm?: boolean;
  base?: string;
  confirmStatus?: boolean;
  summary?: string;
  postSummary?: boolean;
  confirmSummary?: boolean;
};

export type MergeReadiness = {
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  isDraft: boolean | null;
  checks: Array<{
    name: string;
    state: string;
  }>;
  blocked: string[];
};

export type SummaryPostResult = {
  target: 'pr' | 'issue';
  ref: string;
  applied: boolean;
  url: string | null;
  reason: string | null;
  error: string | null;
};

export type PrPlanResult = {
  prompt: string;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string | null;
  action: 'engage' | 'review' | 'merge';
  campaignStatus: CampaignStatusSetResult | null;
  mergeReadiness?: MergeReadiness;
  summary?: string;
  summaryPosts?: SummaryPostResult[];
  merged?: boolean;
};

function ghJson<T>(args: string[], fallback: T): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
}

function parsePrRef(value: string) {
  const match = value.match(/^([^#]+)#(\d+)$/);
  if (!match) throw new Error('PR references must use owner/repo#number, for example TeamFloPay/sdk#12.');
  return { repo: match[1], number: Number(match[2]) };
}

function truncateText(value: string | undefined, limit = 6000) {
  if (!value) return '(not available)';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Truncated by War Room to keep the handoff scoped. Re-run with direct GitHub inspection if more context is needed.]`;
}

function summarizeList<T>(values: T[] | undefined, map: (value: T) => string, limit = 12) {
  const rows = (values ?? []).slice(0, limit).map(map);
  if ((values ?? []).length > limit) rows.push(`[${(values ?? []).length - limit} more omitted]`);
  return rows.length ? rows.join('\n') : 'none';
}

function ghComment(args: string[]): { url: string | null; error: string | null } {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    return { url: null, error: result.stderr.trim() || `gh exited ${result.status ?? 'unknown'}` };
  }
  return { url: result.stdout.trim() || null, error: null };
}

function buildMergeReadiness(pr: {
  mergeStateStatus?: string;
  reviewDecision?: string;
  isDraft?: boolean;
  statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string; workflowName?: string }>;
}): MergeReadiness {
  const checks = (pr.statusCheckRollup ?? [])
    .filter((check) => check.name || check.status || check.conclusion || check.workflowName)
    .map((check) => ({
      name: check.workflowName ? `${check.name ?? 'unknown'} (${check.workflowName})` : (check.name ?? 'unknown'),
      state: check.conclusion ?? check.status ?? 'unknown',
    }));
  const blocked: string[] = [];
  const mergeStateStatus = pr.mergeStateStatus ?? null;
  const reviewDecision = pr.reviewDecision ?? null;

  if (pr.isDraft === true) blocked.push('PR is still marked as draft.');
  if (mergeStateStatus && ['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN'].includes(mergeStateStatus)) {
    blocked.push(`Merge state is ${mergeStateStatus}.`);
  }
  if (reviewDecision && ['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(reviewDecision)) {
    blocked.push(`Review decision is ${reviewDecision}.`);
  }

  for (const check of checks) {
    if (['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'TIMED_OUT'].includes(check.state)) {
      blocked.push(`Check failed: ${check.name} (${check.state}).`);
    } else if (!['COMPLETED', 'SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.state)) {
      blocked.push(`Check is not complete: ${check.name} (${check.state}).`);
    }
  }

  return {
    mergeStateStatus,
    reviewDecision,
    isDraft: typeof pr.isDraft === 'boolean' ? pr.isDraft : null,
    checks,
    blocked,
  };
}

function buildVictorySummary(
  prRef: string,
  issueRef: string | undefined,
  pr: { title?: string; url?: string; headRefName?: string; baseRefName?: string },
  readiness: MergeReadiness,
  operatorSummary: string | undefined
) {
  const defaultOutcome =
    readiness.blocked.length === 0
      ? 'Ready for final merge and cleanup through `warroom pr merge`.'
      : 'Preflight is blocked. Resolve merge-readiness blockers before marking victory.';
  const lines = [
    '## Victory summary',
    '',
    `PR: ${prRef}`,
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? 'unknown'}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
  ];

  if (issueRef) lines.push(`Linked issue: ${issueRef}`);

  lines.push(
    '',
    'Outcome:',
    operatorSummary ?? defaultOutcome,
    '',
    'Merge readiness:',
    readiness.blocked.length === 0 ? 'No blockers detected by War Room preflight.' : readiness.blocked.map((blocker) => `- ${blocker}`).join('\n'),
    '',
    'Checks:',
    readiness.checks.length === 0 ? 'No status checks were returned by GitHub.' : readiness.checks.map((check) => `- ${check.name}: ${check.state}`).join('\n')
  );

  return lines.join('\n');
}

function buildSummaryPostPlan(options: PrOptions, summary: string, readiness: MergeReadiness): SummaryPostResult[] {
  if (!options.pr || !options.postSummary) return [];

  const targets: Array<{ target: 'pr' | 'issue'; ref: string }> = [{ target: 'pr', ref: options.pr }];
  if (options.issue) targets.push({ target: 'issue', ref: options.issue });

  if (!options.confirmSummary) {
    return targets.map((target) => ({
      ...target,
      applied: false,
      url: null,
      reason: 'Pass --confirm-summary to post victory summary comments.',
      error: null,
    }));
  }

  if (readiness.blocked.length > 0) {
    return targets.map((target) => ({
      ...target,
      applied: false,
      url: null,
      reason: 'Merge readiness blockers are present.',
      error: null,
    }));
  }

  return targets.map((target) => {
    if (target.target === 'pr') {
      const ref = parsePrRef(target.ref);
      const result = ghComment(['pr', 'comment', String(ref.number), '--repo', ref.repo, '--body', summary]);
      return {
        ...target,
        applied: result.error === null,
        url: result.url,
        reason: null,
        error: result.error,
      };
    }

    const ref = parseIssueRef(target.ref);
    const result = ghComment(['issue', 'comment', String(ref.number), '--repo', ref.repo, '--body', summary]);
    return {
      ...target,
      applied: result.error === null,
      url: result.url,
      reason: null,
      error: result.error,
    };
  });
}

export function runPrEngage(workspaceRoot: string, options: PrOptions): PrPlanResult {
  if (!options.issue) throw new Error('warroom pr engage requires --issue owner/repo#number.');
  const ref = parseIssueRef(options.issue);
  const issue = ghJson<{ title?: string; body?: string; url?: string }>(
    ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'title,body,url'],
    {}
  );
  const prompt = [
    `War Room PR engage preflight for ${options.issue}`,
    '',
    `Title: ${issue.title ?? 'unknown'}`,
    `URL: ${issue.url ?? `https://github.com/${ref.repo}/issues/${ref.number}`}`,
    '',
    'Required preflight:',
    '- Confirm owner repo and branch strategy.',
    '- Identify intended files or areas.',
    '- List validation commands before code changes.',
    '- Keep product edits in the owning child repo.',
    '- Do not open a PR until validation and commit creation are complete.',
    '',
    'Issue body:',
    truncateText(issue.body),
  ].join('\n');
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-engage', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
      })
    : null;
  const adapterCommand = getAdapterCommand(workspaceRoot);
  const campaignStatus = setCampaignStatus(options.issue, 'battlefield-active', { confirm: options.confirmStatus });

  if (options.dryRun !== false) return { prompt, artifact, launched: false, adapterCommand, action: 'engage', campaignStatus };
  const launched = spawnSync(adapterCommand, [], { input: prompt, stdio: ['pipe', 'inherit', 'inherit'] }).status === 0;
  return { prompt, artifact, launched, adapterCommand, action: 'engage', campaignStatus };
}

export function runPrReview(workspaceRoot: string, options: PrOptions): PrPlanResult {
  if (!options.pr) throw new Error('warroom pr review requires --pr owner/repo#number.');
  const ref = parsePrRef(options.pr);
  const pr = ghJson<{
    title?: string;
    body?: string;
    url?: string;
    headRefName?: string;
    baseRefName?: string;
    files?: Array<{ path?: string; additions?: number; deletions?: number }>;
    comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
    latestReviews?: Array<{ author?: { login?: string }; state?: string; body?: string; submittedAt?: string }>;
    statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string; workflowName?: string }>;
  }>(
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      ref.repo,
      '--json',
      'title,body,url,headRefName,baseRefName,files,comments,latestReviews,statusCheckRollup',
    ],
    {}
  );
  const files = summarizeList(
    pr.files,
    (file) => `- ${file.path ?? 'unknown'} (+${file.additions ?? 0}/-${file.deletions ?? 0})`
  );
  const comments = summarizeList(pr.comments, (comment) => {
    const author = comment.author?.login ?? 'unknown';
    return `- ${author} at ${comment.createdAt ?? 'unknown'}: ${truncateText(comment.body, 500)}`;
  });
  const reviews = summarizeList(pr.latestReviews, (review) => {
    const author = review.author?.login ?? 'unknown';
    return `- ${review.state ?? 'UNKNOWN'} by ${author} at ${review.submittedAt ?? 'unknown'}: ${truncateText(review.body, 500)}`;
  });
  const checks = summarizeList(pr.statusCheckRollup, (check) => {
    const state = check.conclusion ?? check.status ?? 'unknown';
    const workflow = check.workflowName ? ` (${check.workflowName})` : '';
    return `- ${check.name ?? 'unknown'}${workflow}: ${state}`;
  });
  const prompt = [
    `War Room PR review handoff for ${options.pr}`,
    '',
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
    '',
    'Required review loop:',
    '- Gather current GitHub and CodeRabbit feedback before editing.',
    '- Reply to each actionable comment with an outcome marker after handling it.',
    '- Pause on vague, repeated, or circular feedback.',
    '- Keep context scoped to changed files, comments, and repo instructions.',
    '- Use warroom abort for preservation-first recovery if the loop needs to stop.',
    '',
    'Changed files:',
    files,
    '',
    'Latest reviews:',
    reviews,
    '',
    'Comments:',
    comments,
    '',
    'Checks:',
    checks,
    '',
    'PR body:',
    truncateText(pr.body),
  ].join('\n');
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-review', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
      })
    : null;
  const adapterCommand = getAdapterCommand(workspaceRoot);
  const campaignStatus = options.issue
    ? setCampaignStatus(options.issue, 'skirmish', { confirm: options.confirmStatus })
    : null;

  if (options.dryRun !== false) return { prompt, artifact, launched: false, adapterCommand, action: 'review', campaignStatus };
  const launched = spawnSync(adapterCommand, [], { input: prompt, stdio: ['pipe', 'inherit', 'inherit'] }).status === 0;
  return { prompt, artifact, launched, adapterCommand, action: 'review', campaignStatus };
}

export function runPrMerge(workspaceRoot: string, options: PrOptions): PrPlanResult {
  if (!options.pr) throw new Error('warroom pr merge requires --pr owner/repo#number.');
  const ref = parsePrRef(options.pr);
  const pr = ghJson<{
    title?: string;
    url?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    headRefName?: string;
    baseRefName?: string;
    isDraft?: boolean;
    statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string; workflowName?: string }>;
  }>(
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      ref.repo,
      '--json',
      'title,url,mergeStateStatus,reviewDecision,headRefName,baseRefName,isDraft,statusCheckRollup',
    ],
    {}
  );
  const readiness = buildMergeReadiness(pr);
  const summary = buildVictorySummary(options.pr, options.issue, pr, readiness, options.summary);
  const prompt = [
    `War Room PR merge preflight for ${options.pr}`,
    '',
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
    `Merge state: ${pr.mergeStateStatus ?? 'unknown'}`,
    `Review decision: ${pr.reviewDecision ?? 'unknown'}`,
    `Draft: ${pr.isDraft === undefined ? 'unknown' : pr.isDraft ? 'yes' : 'no'}`,
    '',
    'Readiness blockers:',
    readiness.blocked.length ? readiness.blocked.map((blocker) => `- ${blocker}`).join('\n') : 'none',
    '',
    'Checks:',
    readiness.checks.length ? readiness.checks.map((check) => `- ${check.name}: ${check.state}`).join('\n') : 'none',
    '',
    'Required merge checks:',
    '- Confirm all review and CodeRabbit feedback loops are resolved.',
    '- Confirm validation status and target branch.',
    '- Merge only after explicit confirmation.',
    '- Post issue/PR summary and return local checkout to the default branch safely.',
    '',
    'Victory summary:',
    summary,
  ].join('\n');
  let merged = false;

  if (options.confirm) {
    if (readiness.blocked.length > 0) throw new Error(`PR is not merge-ready: ${readiness.blocked.join(' ')}`);
    const result = spawnSync(
      'gh',
      ['pr', 'merge', String(ref.number), '--repo', ref.repo, '--squash', '--delete-branch'],
      { stdio: 'inherit' }
    );
    if (result.status !== 0) throw new Error(`gh pr merge failed with exit ${result.status ?? 'unknown'}.`);
    merged = true;
  }

  const summaryPosts = buildSummaryPostPlan(options, summary, readiness);
  const campaignStatus = options.issue
    ? setCampaignStatus(options.issue, 'victory', { confirm: options.confirmStatus && readiness.blocked.length === 0 })
    : null;
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-merge', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
        'pr.json': JSON.stringify(pr, null, 2),
        'readiness.json': JSON.stringify(readiness, null, 2),
        'summary.md': summary,
        'summary-posts.json': JSON.stringify(summaryPosts, null, 2),
      })
    : null;

  return {
    prompt,
    artifact,
    launched: false,
    adapterCommand: null,
    action: 'merge',
    campaignStatus,
    mergeReadiness: readiness,
    summary,
    summaryPosts,
    merged,
  };
}
