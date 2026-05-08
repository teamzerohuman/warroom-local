import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRunArtifact, type RunArtifact } from '../lib/artifacts.js';
import { resolveAllyIssueRepo } from '../lib/allies.js';
import { CAMPAIGN_LABELS, listCampaignIssuesByStatus, setCampaignStatus, type CampaignStatusName, type CampaignStatusSetResult } from '../lib/campaign.js';
import { getInteractiveAdapterInvocation, runInteractiveAdapter } from '../lib/env.js';
import { getRepoHealth, loadRepoManifest } from '../lib/repos.js';
import { buildSpecialistContext } from '../lib/specialist-context.js';

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
  repo?: string;
  source: 'campaign' | 'labels';
  issues: IssueSummary[];
};

export type IssueHandoffResult = {
  prompt: string;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string;
  campaignStatus: CampaignStatusSetResult | null;
  labelUpdate: IssueLabelUpdateResult | null;
  triageNotes: TriageNotesResult | null;
  contextSummary: {
    promptCharacters: number;
    changedFiles?: number;
    comments?: number;
    reviews?: number;
    checks?: number;
    checkInMinutes?: number;
  };
  launchError?: string | null;
  closeoutError?: string | null;
};

export type IssueLabelUpdateResult = {
  issue: string;
  status: CampaignStatusName;
  addLabel: string;
  removeLabels: string[];
  applied: boolean;
  error: string | null;
};

export type TriageNotesResult = {
  marker: string;
  beforeComments: number | null;
  afterComments: number | null;
  found: boolean;
  ready: boolean;
  commentUrl: string | null;
  reason: string | null;
  error: string | null;
};

export type IssueTriageOptions = {
  issue?: string;
  label?: string;
  markReady?: boolean;
  confirmStatus?: boolean;
  dryRun?: boolean;
  writeArtifact?: boolean;
};

export type IssueNextOptions = {
  label?: string;
  currentPath?: string;
  allRepos?: boolean;
};

const TRIAGE_NOTES_MARKER = '## War Room triage notes';
const TRIAGE_READY_LINE = 'Ready for ready-to-engage: yes';

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

function containsPath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function repoForCurrentPath(workspaceRoot: string, currentPath: string | undefined) {
  if (!currentPath) return null;

  const resolved = path.resolve(currentPath);
  return loadRepoManifest(workspaceRoot).repos
    .map((entry) => getRepoHealth(workspaceRoot, entry))
    .filter((repo) => repo.checkedOut && containsPath(repo.resolvedPath, resolved))
    .sort((left, right) => right.resolvedPath.length - left.resolvedPath.length)[0] ?? null;
}

export function listIssuesByLabel(workspaceRoot: string, label: string, repoFilter: string | null = null): IssueListResult {
  const manifest = loadRepoManifest(workspaceRoot);
  const issues: IssueSummary[] = [];

  for (const repo of manifest.repos.filter((entry) => !repoFilter || entry.github === repoFilter)) {
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

  return { label, repo: repoFilter ?? undefined, source: 'labels', issues };
}

function issueContext(ref: IssueRef) {
  return ghJson<{ title?: string; body?: string; url?: string; labels?: Array<{ name?: string }> }>(
    ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'title,body,url,labels'],
    {}
  );
}

type IssueComment = {
  body?: string;
  url?: string;
  createdAt?: string;
  author?: {
    login?: string;
  };
};

function issueComments(ref: IssueRef): { comments: IssueComment[]; error: string | null } {
  const result = spawnSync('gh', ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'comments'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return { comments: [], error: `${result.stderr || result.stdout}`.trim() || `gh issue view failed with exit ${result.status ?? 'unknown'}.` };
  }

  try {
    const parsed = JSON.parse(result.stdout || '{}') as { comments?: IssueComment[] };
    return { comments: parsed.comments ?? [], error: null };
  } catch {
    return { comments: [], error: 'Could not parse gh issue comments output.' };
  }
}

function commentKey(comment: IssueComment) {
  return [comment.url ?? '', comment.createdAt ?? '', comment.author?.login ?? '', comment.body ?? ''].join('\0');
}

function readinessFromTriageNotes(body: string | undefined) {
  const match = body?.match(/^\s*Ready for ready-to-engage:\s*(yes|no)\s*$/im);
  return match?.[1]?.toLowerCase() ?? null;
}

function verifyTriageNotes(ref: IssueRef, before: { comments: IssueComment[]; error: string | null }): TriageNotesResult {
  if (before.error) {
    return {
      marker: TRIAGE_NOTES_MARKER,
      beforeComments: null,
      afterComments: null,
      found: false,
      ready: false,
      commentUrl: null,
      reason: 'Could not inspect issue comments before launch.',
      error: before.error,
    };
  }

  const after = issueComments(ref);
  if (after.error) {
    return {
      marker: TRIAGE_NOTES_MARKER,
      beforeComments: before.comments.length,
      afterComments: null,
      found: false,
      ready: false,
      commentUrl: null,
      reason: 'Could not inspect issue comments after launch.',
      error: after.error,
    };
  }

  const beforeKeys = new Set(before.comments.map(commentKey));
  const newComments = after.comments.filter((comment) => !beforeKeys.has(commentKey(comment)));
  const note = newComments.find((comment) => comment.body?.includes(TRIAGE_NOTES_MARKER));
  if (!note) {
    return {
      marker: TRIAGE_NOTES_MARKER,
      beforeComments: before.comments.length,
      afterComments: after.comments.length,
      found: false,
      ready: false,
      commentUrl: null,
      reason: `No new issue comment containing "${TRIAGE_NOTES_MARKER}" was found.`,
      error: null,
    };
  }

  const readiness = readinessFromTriageNotes(note.body);
  return {
    marker: TRIAGE_NOTES_MARKER,
    beforeComments: before.comments.length,
    afterComments: after.comments.length,
    found: true,
    ready: readiness === 'yes',
    commentUrl: note.url ?? null,
    reason:
      readiness === 'yes'
        ? null
        : readiness === 'no'
          ? 'Triage notes marked the issue as not ready for ready-to-engage.'
          : `Triage notes are missing the "${TRIAGE_READY_LINE}" readiness line.`,
    error: null,
  };
}

function buildTriagePrompt(workspaceRoot: string, ref: IssueRef) {
  const issue = issueContext(ref);
  const labels = labelsFromGh(issue.labels ?? []);
  return [
    `War Room issue triage handoff for ${ref.repo}#${ref.number}`,
    '',
    `Title: ${issue.title ?? 'unknown'}`,
    `URL: ${issue.url ?? `https://github.com/${ref.repo}/issues/${ref.number}`}`,
    `Labels: ${labels.length ? labels.join(', ') : 'none'}`,
    '',
    buildSpecialistContext(workspaceRoot, ref.repo),
    '',
    'Triage mode contract:',
    '- This is planning and issue triage only. Do not implement code.',
    '- Do not edit repository files, create branches, commit changes, open pull requests, run formatters, or create implementation artifacts.',
    '- Use read-only inspection only: GitHub issue/PR context, docs, safe logs, and read-only provider/API checks when credentials are available.',
    '- Treat client data, secrets, payment details, private URLs, and raw PII as confidential. Do not copy them into GitHub comments or local files.',
    '- If Codex offers a Plan mode, stay in Plan mode for this session. Do not switch into implementation mode.',
    '',
    'Interactive triage workflow:',
    '- Use @grill-me: ask blocking clarification questions one at a time and wait for the user answer before finalizing the plan.',
    '- If a question can be answered safely by read-only investigation, do that investigation and summarize only non-sensitive facts.',
    '- Stop when the issue has a clear owner repo, problem statement, acceptance criteria, risks, dependencies, and validation commands.',
    '',
    'Goal:',
    '- Produce a compact implementation-ready battle plan, but do not implement it.',
    '- Post the final triage notes back to this GitHub issue using [@github](plugin://github@openai-curated) or `gh issue comment`.',
    `- Start the GitHub issue comment with exactly: ${TRIAGE_NOTES_MARKER}`,
    `- Include a standalone readiness line: \`${TRIAGE_READY_LINE}\` only when the issue has enough information to move forward, or \`Ready for ready-to-engage: no\` when a blocker remains.`,
    '- The GitHub issue comment must include: owner repo, diagnosis or remaining unknowns, acceptance criteria, implementation plan, validation commands, dependencies/blockers, and a concise safe client-facing summary when relevant.',
    '- After posting the issue comment, tell the user whether the issue is ready to move to `ready-to-engage` or what blocker remains.',
    '- Keep context scoped; ask for more information if needed.',
    '',
    'Issue body:',
    truncateText(issue.body),
  ].join('\n');
}

function repoEntryForGitHub(workspaceRoot: string, githubRepo: string) {
  const manifest = loadRepoManifest(workspaceRoot);
  return manifest.repos.find((entry) => entry.github === githubRepo) ?? null;
}

function repoWorkspaceForGitHub(workspaceRoot: string, githubRepo: string) {
  const repo = repoEntryForGitHub(workspaceRoot, githubRepo);
  if (repo) {
    const health = getRepoHealth(workspaceRoot, repo);
    return health.checkedOut ? health.resolvedPath : workspaceRoot;
  }

  const allyIssueRepo = resolveAllyIssueRepo(workspaceRoot, githubRepo);
  return allyIssueRepo?.issueRepoCheckedOut ? allyIssueRepo.issueRepoPath : workspaceRoot;
}

export function runIssueNext(workspaceRoot: string, options: IssueNextOptions | string = {}) {
  const label = typeof options === 'string' ? options : options.label ?? 'ready-to-engage';
  const currentRepo = typeof options === 'string' || options.allRepos ? null : repoForCurrentPath(workspaceRoot, options.currentPath);
  const repoFilter = currentRepo?.github ?? null;
  const campaignIssues = listIssuesByCampaignStatus('ready-to-engage');
  const issues = campaignIssues.filter((issue) => !repoFilter || issue.repo === repoFilter);
  if (campaignIssues.length > 0) return { status: 'ready-to-engage', repo: repoFilter ?? undefined, source: 'campaign' as const, issues };
  return listIssuesByLabel(workspaceRoot, label, repoFilter);
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

function setIssueWorkflowLabel(issue: string, status: CampaignStatusName, confirm: boolean): IssueLabelUpdateResult {
  const ref = parseIssueRef(issue);
  const current = labelsFromGh(issueContext(ref).labels ?? []);
  const workflowLabels = new Set<string>(CAMPAIGN_LABELS.map((label) => label.name));
  const removeLabels = current.filter((label) => workflowLabels.has(label) && label !== status);
  const addLabel = status;

  if (confirm) {
    const args = ['issue', 'edit', String(ref.number), '--repo', ref.repo, '--add-label', addLabel];
    for (const label of removeLabels) args.push('--remove-label', label);
    const result = spawnSync('gh', args, { encoding: 'utf8' });
    if (result.status !== 0) {
      return {
        issue,
        status,
        addLabel,
        removeLabels,
        applied: false,
        error: `${result.stderr || result.stdout}`.trim() || `gh issue edit failed with exit ${result.status ?? 'unknown'}.`,
      };
    }
  }

  return {
    issue,
    status,
    addLabel,
    removeLabels,
    applied: confirm,
    error: null,
  };
}

export function runIssueTriage(workspaceRoot: string, options: IssueTriageOptions = {}): IssueListResult | IssueHandoffResult {
  const label = options.label ?? 'needs-triage';
  if (!options.issue) {
    const issues = listIssuesByCampaignStatus('needs-triage');
    if (issues.length > 0) return { status: 'needs-triage', source: 'campaign' as const, issues };
    return listIssuesByLabel(workspaceRoot, label);
  }

  const ref = parseIssueRef(options.issue);
  const prompt = buildTriagePrompt(workspaceRoot, ref);
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'issue-triage', {
        'prompt.md': prompt,
        'input.json': JSON.stringify({ issue: options.issue, label }, null, 2),
      })
    : null;
  const adapterCwd = repoWorkspaceForGitHub(workspaceRoot, ref.repo);
  const adapterCommand = getInteractiveAdapterInvocation(workspaceRoot, adapterCwd).display;
  const contextSummary = { promptCharacters: prompt.length };
  const shouldMarkReady = options.markReady === true;

  if (options.dryRun !== false) {
    const campaignStatus = shouldMarkReady
      ? setCampaignStatus(options.issue, 'ready-to-engage', { confirm: false })
      : null;
    const labelUpdate = shouldMarkReady ? setIssueWorkflowLabel(options.issue, 'ready-to-engage', false) : null;
    return { prompt, artifact, launched: false, adapterCommand, campaignStatus, labelUpdate, triageNotes: null, contextSummary };
  }

  const beforeComments = shouldMarkReady ? issueComments(ref) : { comments: [], error: null };
  const launch = runInteractiveAdapter(workspaceRoot, prompt, { cwd: adapterCwd });
  let campaignStatus: CampaignStatusSetResult | null = null;
  let labelUpdate: IssueLabelUpdateResult | null = null;
  let triageNotes: TriageNotesResult | null = null;
  let closeoutError: string | null = null;

  if (launch.launched && shouldMarkReady) {
    triageNotes = verifyTriageNotes(ref, beforeComments);
    if (triageNotes.ready) {
      try {
        campaignStatus = setCampaignStatus(options.issue, 'ready-to-engage', { confirm: options.confirmStatus });
      } catch (error) {
        closeoutError = error instanceof Error ? error.message : String(error);
      }

      if (!closeoutError) {
        labelUpdate = setIssueWorkflowLabel(options.issue, 'ready-to-engage', options.confirmStatus === true);
        if (labelUpdate.error) closeoutError = labelUpdate.error;
      }
    }
  }

  return {
    prompt,
    artifact,
    launched: launch.launched,
    adapterCommand: launch.invocation.display,
    campaignStatus,
    labelUpdate,
    triageNotes,
    contextSummary,
    launchError: launch.error,
    closeoutError,
  };
}
