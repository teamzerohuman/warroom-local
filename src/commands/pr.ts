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
};

export type PrPlanResult = {
  prompt: string;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string | null;
  action: 'engage' | 'review' | 'merge';
  campaignStatus: CampaignStatusSetResult | null;
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
  const pr = ghJson<{ title?: string; body?: string; url?: string; headRefName?: string; baseRefName?: string }>(
    ['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', 'title,body,url,headRefName,baseRefName'],
    {}
  );
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
  const pr = ghJson<{ title?: string; url?: string; mergeStateStatus?: string; reviewDecision?: string }>(
    ['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', 'title,url,mergeStateStatus,reviewDecision'],
    {}
  );
  const prompt = [
    `War Room PR merge preflight for ${options.pr}`,
    '',
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`}`,
    `Merge state: ${pr.mergeStateStatus ?? 'unknown'}`,
    `Review decision: ${pr.reviewDecision ?? 'unknown'}`,
    '',
    'Required merge checks:',
    '- Confirm all review and CodeRabbit feedback loops are resolved.',
    '- Confirm validation status and target branch.',
    '- Merge only after explicit confirmation.',
    '- Post issue/PR summary and return local checkout to the default branch safely.',
  ].join('\n');
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-merge', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
      })
    : null;

  if (options.confirm) {
    const result = spawnSync(
      'gh',
      ['pr', 'merge', String(ref.number), '--repo', ref.repo, '--squash', '--delete-branch'],
      { stdio: 'inherit' }
    );
    if (result.status !== 0) throw new Error(`gh pr merge failed with exit ${result.status ?? 'unknown'}.`);
  }

  const campaignStatus = options.issue
    ? setCampaignStatus(options.issue, 'victory', { confirm: options.confirmStatus })
    : null;

  return { prompt, artifact, launched: false, adapterCommand: null, action: 'merge', campaignStatus };
}
