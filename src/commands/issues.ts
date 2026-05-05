import { spawnSync } from 'node:child_process';
import { createRunArtifact, type RunArtifact } from '../lib/artifacts.js';
import { listCampaignIssuesByStatus, setCampaignStatus, type CampaignStatusSetResult } from '../lib/campaign.js';
import { getAdapterCommand } from '../lib/env.js';
import { loadRepoManifest } from '../lib/repos.js';

export type IssueRef = {
  repo: string;
  number: number;
};

export type IssueSummary = IssueRef & {
  title: string;
  url: string;
  labels: string[];
  status?: string | null;
  projectItemId?: string;
};

export type IssueListResult = {
  label?: string;
  status?: string;
  source: 'campaign' | 'labels';
  issues: IssueSummary[];
};

export type IssueHandoffResult = {
  prompt: string;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string;
  campaignStatus: CampaignStatusSetResult | null;
};

export type IssueTriageOptions = {
  issue?: string;
  label?: string;
  markReady?: boolean;
  confirmStatus?: boolean;
  dryRun?: boolean;
  writeArtifact?: boolean;
};

function ghJson<T>(args: string[], fallback: T): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
}

export function parseIssueRef(value: string): IssueRef {
  const match = value.match(/^([^#]+)#(\d+)$/);
  if (!match) throw new Error('Issue references must use owner/repo#number, for example TeamFloPay/infra#4.');
  return { repo: match[1], number: Number(match[2]) };
}

function labelsFromGh(labels: Array<{ name?: string }>) {
  return labels.map((label) => label.name).filter((label): label is string => Boolean(label));
}

function truncateText(value: string | undefined, limit = 6000) {
  if (!value) return '(not available)';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Truncated by War Room to keep the handoff scoped. Re-run with direct GitHub inspection if more issue body context is needed.]`;
}

export function listIssuesByLabel(workspaceRoot: string, label: string): IssueListResult {
  const manifest = loadRepoManifest(workspaceRoot);
  const issues: IssueSummary[] = [];

  for (const repo of manifest.repos) {
    const rows = ghJson<Array<{ number: number; title: string; url: string; labels: Array<{ name?: string }> }>>(
      ['issue', 'list', '--repo', repo.github, '--state', 'open', '--label', label, '--json', 'number,title,url,labels'],
      []
    );
    for (const row of rows) {
      issues.push({
        repo: repo.github,
        number: row.number,
        title: row.title,
        url: row.url,
        labels: labelsFromGh(row.labels),
      });
    }
  }

  return { label, source: 'labels', issues };
}

function issueContext(ref: IssueRef) {
  return ghJson<{ title?: string; body?: string; url?: string; labels?: Array<{ name?: string }> }>(
    ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'title,body,url,labels'],
    {}
  );
}

function buildTriagePrompt(ref: IssueRef) {
  const issue = issueContext(ref);
  const labels = labelsFromGh(issue.labels ?? []);
  return [
    `War Room issue triage handoff for ${ref.repo}#${ref.number}`,
    '',
    `Title: ${issue.title ?? 'unknown'}`,
    `URL: ${issue.url ?? `https://github.com/${ref.repo}/issues/${ref.number}`}`,
    `Labels: ${labels.length ? labels.join(', ') : 'none'}`,
    '',
    'Goal:',
    '- Clarify the problem, acceptance criteria, owner repo, risk, dependencies, and validation commands.',
    '- Produce a compact implementation-ready battle plan.',
    '- Keep context scoped; ask for more information if needed.',
    '',
    'Issue body:',
    truncateText(issue.body),
  ].join('\n');
}

export function runIssueNext(workspaceRoot: string, label = 'ready-to-engage') {
  const issues = listIssuesByCampaignStatus('ready-to-engage');
  if (issues.length > 0) return { status: 'ready-to-engage', source: 'campaign' as const, issues };
  return listIssuesByLabel(workspaceRoot, label);
}

function listIssuesByCampaignStatus(status: 'needs-triage' | 'ready-to-engage') {
  return listCampaignIssuesByStatus(status).map((issue) => ({
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
    status: issue.status,
    projectItemId: issue.projectItemId,
  }));
}

export function runIssueTriage(workspaceRoot: string, options: IssueTriageOptions = {}): IssueListResult | IssueHandoffResult {
  const label = options.label ?? 'needs-triage';
  if (!options.issue) {
    const issues = listIssuesByCampaignStatus('needs-triage');
    if (issues.length > 0) return { status: 'needs-triage', source: 'campaign' as const, issues };
    return listIssuesByLabel(workspaceRoot, label);
  }

  const ref = parseIssueRef(options.issue);
  const prompt = buildTriagePrompt(ref);
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'issue-triage', {
        'prompt.md': prompt,
        'input.json': JSON.stringify({ issue: options.issue, label }, null, 2),
      })
    : null;
  const adapterCommand = getAdapterCommand(workspaceRoot);
  const campaignStatus = options.markReady
    ? setCampaignStatus(options.issue, 'ready-to-engage', { confirm: options.confirmStatus })
    : null;

  if (options.dryRun !== false) {
    return { prompt, artifact, launched: false, adapterCommand, campaignStatus };
  }

  const launched = spawnSync(adapterCommand, [], { input: prompt, stdio: ['pipe', 'inherit', 'inherit'] }).status === 0;
  return { prompt, artifact, launched, adapterCommand, campaignStatus };
}
