import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRunArtifact, type RunArtifact } from '../lib/artifacts.js';
import { loadAlliesManifest, resolveAllyIssueRepo, type AllyEntry } from '../lib/allies.js';
import { CAMPAIGN_LABELS, listCampaignIssuesByStatus, setCampaignStatus, type CampaignStatusName, type CampaignStatusSetResult } from '../lib/campaign.js';
import { getInteractiveAdapterInvocation, runInteractiveAdapter } from '../lib/env.js';
import { ownerRepoFromText } from '../lib/issue-links.js';
import { attachRunUsageToIssue, createUsageCommandRunId } from '../lib/llm-usage.js';
import { parseRepoRef } from '../lib/refs.js';
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

export type IssueCreateDraft = {
  repo: string;
  title: string;
  body: string;
  labels: string[];
  issueType: string | null;
  assignees: string[];
  milestone: string | null;
};

export type IssueTypeUpdateResult = {
  issue: string;
  type: string;
  applied: boolean;
  error: string | null;
};

export type IssueCreateResult = {
  prompt: string;
  artifact: RunArtifact | null;
  draftPath: string | null;
  adapterCommand: string;
  launched: boolean;
  launchError: string | null;
  draft: IssueCreateDraft | null;
  draftError: string | null;
  draftWarnings: string[];
  created: boolean;
  issue: string | null;
  url: string | null;
  createCommand: string | null;
  campaignStatus: CampaignStatusSetResult | null;
  labelUpdate: IssueLabelUpdateResult | null;
  issueTypeUpdate: IssueTypeUpdateResult | null;
  closeoutError: string | null;
  contextSummary: {
    promptCharacters: number;
  };
};

export type IssueCreateOptions = {
  repo?: string;
  title?: string;
  body?: string;
  labels?: string[];
  issueType?: string;
  confirm?: boolean;
  dryRun?: boolean;
  writeArtifact?: boolean;
};

const TRIAGE_NOTES_MARKER = '## War Room triage notes';
const TRIAGE_READY_LINE = 'Ready for ready-to-engage: yes';

function ghJson<T>(args: string[], fallback: T): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
}

export function parseIssueRef(value: string): IssueRef {
  return parseRepoRef(value);
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

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '');
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function repoParts(repo: string) {
  const [owner, name] = repo.split('/');
  return owner && name ? { owner, name } : null;
}

function loadAllies(workspaceRoot: string): AllyEntry[] {
  try {
    return loadAlliesManifest(workspaceRoot).allies;
  } catch {
    return [];
  }
}

function allyForIssueRepo(workspaceRoot: string, githubRepo: string) {
  return loadAllies(workspaceRoot).find((ally) => ally.issue_repo.github === githubRepo) ?? null;
}

function knownIssueRepos(workspaceRoot: string) {
  const mapped = loadRepoManifest(workspaceRoot).repos.map((repo) => ({
    repo: repo.github,
    kind: 'mapped product repo',
    description: repo.description,
  }));
  const allies = loadAllies(workspaceRoot).map((ally) => ({
    repo: ally.issue_repo.github,
    kind: 'ally issue repo',
    description: `${ally.name} client-facing issue sync from ${ally.issue_repo.client_system}`,
  }));
  return [...mapped, ...allies];
}

function isKnownIssueRepo(workspaceRoot: string, repo: string) {
  return knownIssueRepos(workspaceRoot).some((entry) => entry.repo === repo);
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim());
  return [];
}

function listRepoLabelNames(repo: string) {
  const result = spawnSync('gh', ['label', 'list', '--repo', repo, '--json', 'name', '--limit', '1000'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return {
      labels: [] as string[],
      error: `${result.stderr || result.stdout}`.trim() || `gh label list failed with exit ${result.status ?? 'unknown'}.`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout || '[]') as Array<{ name?: string }>;
    return { labels: labelsFromGh(parsed), error: null };
  } catch {
    return { labels: [] as string[], error: 'Could not parse gh label list output.' };
  }
}

function listOrgIssueTypeNames(owner: string) {
  const query = `
query IssueTypeLookup($org: String!) {
  organization(login: $org) {
    issueTypes(first: 50) {
      nodes {
        name
        isEnabled
      }
    }
  }
}
`;
  const result = spawnSync('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `org=${owner}`], { encoding: 'utf8' });
  if (result.status !== 0) {
    return {
      issueTypes: [] as string[],
      error: `${result.stderr || result.stdout}`.trim() || `gh api graphql failed with exit ${result.status ?? 'unknown'}.`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout || '{}') as {
      data?: {
        organization?: { issueTypes?: { nodes?: Array<{ name?: string; isEnabled?: boolean } | null> } | null } | null;
      };
    };
    const issueTypes =
      parsed.data?.organization?.issueTypes?.nodes
        ?.filter((entry): entry is { name?: string; isEnabled?: boolean } => Boolean(entry))
        .filter((entry) => entry.isEnabled !== false)
        .map((entry) => entry.name)
        .filter((name): name is string => Boolean(name)) ?? [];
    return { issueTypes, error: null };
  } catch {
    return { issueTypes: [] as string[], error: 'Could not parse issue type lookup response.' };
  }
}

function validateIssueCreateLabels(repo: string, generatedLabels: string[], requestedLabels: string[]) {
  const lookup = listRepoLabelNames(repo);
  if (lookup.error) return { labels: [] as string[], error: `Could not fetch labels for ${repo}: ${lookup.error}`, warnings: [] as string[] };

  const availableByLower = new Map(lookup.labels.map((label) => [label.toLowerCase(), label]));
  const generatedByLower = new Set(generatedLabels.map((label) => label.toLowerCase()));
  const labels: string[] = [];
  const warnings: string[] = [];
  const missingRequired: string[] = [];

  for (const label of uniqueStrings([...generatedLabels, ...requestedLabels])) {
    const match = availableByLower.get(label.toLowerCase());
    if (match) {
      labels.push(match);
      continue;
    }

    if (generatedByLower.has(label.toLowerCase())) missingRequired.push(label);
    else warnings.push(`Ignored label "${label}" because it does not exist in ${repo}.`);
  }

  if (missingRequired.length > 0) {
    return {
      labels: [] as string[],
      error: `Required issue label${missingRequired.length === 1 ? '' : 's'} missing in ${repo}: ${missingRequired.join(', ')}.`,
      warnings,
    };
  }

  return { labels: uniqueStrings(labels), error: null, warnings };
}

function validateIssueCreateType(repo: string, issueType: string | null) {
  if (!issueType) return { issueType: null, warnings: [] as string[] };
  const parts = repoParts(repo);
  if (!parts) return { issueType: null, warnings: [`Ignored issue type "${issueType}" because ${repo} is not a valid owner/repo.`] };
  const lookup = listOrgIssueTypeNames(parts.owner);
  if (lookup.error) return { issueType: null, warnings: [`Ignored issue type "${issueType}" because issue types could not be fetched: ${lookup.error}`] };
  const match = lookup.issueTypes.find((type) => type.toLowerCase() === issueType.toLowerCase());
  if (!match) {
    const available = lookup.issueTypes.length ? lookup.issueTypes.join(', ') : 'none';
    return { issueType: null, warnings: [`Ignored issue type "${issueType}" because it does not exist for ${parts.owner}. Available: ${available}.`] };
  }
  return { issueType: match, warnings: [] as string[] };
}

function normalizeIssueCreateDraft(workspaceRoot: string, raw: unknown): { draft: IssueCreateDraft | null; error: string | null; warnings: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { draft: null, error: 'Issue draft JSON must be an object.', warnings: [] };
  }
  const record = raw as Record<string, unknown>;
  const repo = typeof record.repo === 'string' ? record.repo.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim().replace(/\s+/g, ' ') : '';
  const body = typeof record.body === 'string' ? record.body.trim() : '';
  const issueType =
    typeof record.issueType === 'string'
      ? record.issueType.trim()
      : typeof record.type === 'string'
        ? record.type.trim()
        : '';
  const assignees = uniqueStrings(stringArray(record.assignees));
  const milestone = typeof record.milestone === 'string' && record.milestone.trim() ? record.milestone.trim() : null;

  if (!repo) return { draft: null, error: 'Issue draft is missing repo.', warnings: [] };
  if (!isKnownIssueRepo(workspaceRoot, repo)) {
    return { draft: null, error: `Issue draft repo is not mapped in repos.yaml or allies.yaml: ${repo}.`, warnings: [] };
  }
  if (!title) return { draft: null, error: 'Issue draft is missing title.', warnings: [] };
  if (!body) return { draft: null, error: 'Issue draft is missing body.', warnings: [] };

  const workflowLabels = new Set<string>(CAMPAIGN_LABELS.map((label) => label.name.toLowerCase()));
  const requestedLabels = stringArray(record.labels)
    .map((label) => label.trim())
    .filter((label) => label && !workflowLabels.has(label.toLowerCase()));
  const ally = allyForIssueRepo(workspaceRoot, repo);
  const generatedLabels = ['needs-triage', ...(ally ? ['ally', ally.id] : [])];
  const labelValidation = validateIssueCreateLabels(repo, generatedLabels, requestedLabels);
  if (labelValidation.error) return { draft: null, error: labelValidation.error, warnings: labelValidation.warnings };
  const issueTypeValidation = validateIssueCreateType(repo, issueType || null);
  const warnings = [...labelValidation.warnings, ...issueTypeValidation.warnings];

  return {
    draft: {
      repo,
      title,
      body,
      labels: labelValidation.labels,
      issueType: issueTypeValidation.issueType,
      assignees,
      milestone,
    },
    error: null,
    warnings,
  };
}

function parseIssueCreateDraft(workspaceRoot: string, draftPath: string) {
  if (!existsSync(draftPath)) {
    return { draft: null, error: `Adapter did not write issue draft JSON to ${draftPath}.`, warnings: [] };
  }

  const raw = readFileSync(draftPath, 'utf8').trim();
  if (!raw) return { draft: null, error: `Adapter left issue draft JSON empty at ${draftPath}.`, warnings: [] };

  try {
    return normalizeIssueCreateDraft(workspaceRoot, JSON.parse(raw));
  } catch (error) {
    return {
      draft: null,
      error: `Could not parse issue draft JSON at ${draftPath}: ${error instanceof Error ? error.message : String(error)}`,
      warnings: [],
    };
  }
}

function createIssueCreateArtifact(
  workspaceRoot: string,
  input: Record<string, unknown>
): { artifact: RunArtifact; draftPath: string; promptPath: string } {
  const runDir = path.join(workspaceRoot, '.warroom', 'runs', `${safeTimestamp()}-issue-create`);
  mkdirSync(runDir, { recursive: true });
  const inputPath = path.join(runDir, 'input.json');
  const promptPath = path.join(runDir, 'prompt.md');
  const draftPath = path.join(runDir, 'issue-draft.json');
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  writeFileSync(draftPath, '\n');
  return { artifact: { runDir, files: [inputPath, promptPath, draftPath] }, draftPath, promptPath };
}

function issueCreateMetadataText(workspaceRoot: string, options: IssueCreateOptions = {}) {
  const repos = knownIssueRepos(workspaceRoot).filter((entry) => !options.repo || entry.repo === options.repo);
  const issueTypesByOwner = new Map<string, ReturnType<typeof listOrgIssueTypeNames>>();
  const lines: string[] = [];

  for (const entry of repos) {
    const labels = listRepoLabelNames(entry.repo);
    const owner = repoParts(entry.repo)?.owner ?? null;
    const issueTypes =
      owner && issueTypesByOwner.has(owner)
        ? issueTypesByOwner.get(owner)
        : owner
          ? listOrgIssueTypeNames(owner)
          : null;
    if (owner && issueTypes && !issueTypesByOwner.has(owner)) issueTypesByOwner.set(owner, issueTypes);

    lines.push(`- ${entry.repo}`);
    lines.push(`  Labels: ${labels.error ? `unavailable (${labels.error})` : labels.labels.join(', ') || 'none'}`);
    lines.push(
      `  Issue types: ${
        !issueTypes
          ? 'unavailable'
          : issueTypes.error
            ? `unavailable (${issueTypes.error})`
            : issueTypes.issueTypes.join(', ') || 'none'
      }`
    );
  }

  return lines.length ? lines.join('\n') : '- No matching issue metadata found.';
}

function buildIssueCreatePrompt(workspaceRoot: string, draftPath: string, options: IssueCreateOptions = {}) {
  const repos = knownIssueRepos(workspaceRoot)
    .map((entry) => `- ${entry.repo} (${entry.kind}): ${entry.description}`)
    .join('\n');
  const metadata = issueCreateMetadataText(workspaceRoot, options);
  const seed = [
    options.repo ? `Preferred repo: ${options.repo}` : null,
    options.title ? `Seed title: ${options.title}` : null,
    options.body ? `Seed context:\n${options.body}` : null,
    options.labels?.length ? `Suggested labels: ${options.labels.join(', ')}` : null,
    options.issueType ? `Suggested issue type: ${options.issueType}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n\n');

  return [
    'War Room issue creation PM session',
    '',
    'Role:',
    '- Act as a product/project manager gathering enough business context to create a useful GitHub issue.',
    '- Use @grill-me lightly: ask one blocking business-scope question at a time, then wait for the user answer.',
    '- Do not perform technical implementation triage; that belongs to `warroom issue triage` after the issue exists.',
    '- Do not edit code, create branches, commit changes, open pull requests, or mutate GitHub directly.',
    '- Do not include raw client PII, secrets, private endpoints, tokens, payment details, or sensitive exports in the issue.',
    '',
    'Sentry linkage:',
    '- If the user references a Sentry issue, Sentry event, Sentry short ID, or Sentry URL, preserve that reference in the draft issue body.',
    '- Add enough non-sensitive Sentry context for triage to find the same issue again, but do not copy raw stack traces, request payloads, user PII, or secrets.',
    '- Note in the draft body that technical triage must link the created GitHub issue to the referenced Sentry issue using [@sentry](plugin://sentry@openai-curated) / Sentry MCP when available.',
    '- Do not claim the Sentry link already exists during issue creation; the GitHub issue does not exist until the CLI creates it after this session.',
    '',
    'Choose the target repo:',
    '- Use an ally issue repo when the issue is client-facing or the client must keep access to the details.',
    '- Use a mapped product repo for internal/product-only work that does not need to live in an ally repo.',
    '- If an ally issue likely needs implementation in a product repo, still create the issue in the ally repo and leave owner-repo selection for technical triage.',
    '',
    'Available issue repos:',
    repos || '- No mapped issue repos found.',
    '',
    'Available GitHub metadata:',
    metadata,
    '',
    'Metadata rules:',
    '- Only use labels that are listed for the chosen repo. If no exact label exists, omit it.',
    '- Only use issue types that are listed for the chosen repo owner. If no exact type exists, set issueType to null.',
    '- Do not invent labels, milestones, assignees, or issue types.',
    '',
    'Minimum business scope to collect:',
    '- Who is affected and why this matters.',
    '- The current observed behavior or opportunity.',
    '- The desired business outcome.',
    '- Known constraints, urgency, customer visibility, and useful links.',
    '- What would make the issue clear enough for technical triage.',
    '',
    'Final output contract:',
    `- Write the final draft JSON to exactly: ${draftPath}`,
    '- Do not wrap the JSON in Markdown fences.',
    '- The CLI will preview and create the GitHub issue; do not create it yourself.',
    '- JSON schema:',
    '{',
    '  "repo": "TeamFloPay/<repo>",',
    '  "title": "Short client-safe issue title",',
    '  "body": "Markdown body focused on business scope, observed behavior, desired outcome, known links, constraints, and open questions for triage.",',
    '  "labels": ["optional-domain-or-client-label"],',
    '  "issueType": "Bug|Task|Feature|...",',
    '  "assignees": [],',
    '  "milestone": null',
    '}',
    '',
    'War Room will automatically add the `needs-triage` workflow label, ally labels for ally issue repos, Campaign Map Project 1, and Campaign status `needs-triage`.',
    seed ? ['', 'Seed context from CLI flags:', seed].join('\n') : '',
  ]
    .filter((line, index, lines) => line !== '' || index !== lines.length - 1)
    .join('\n');
}

function issueRefFromUrl(url: string | null) {
  const match = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  return match ? `${match[1]}#${match[2]}` : null;
}

function applyIssueType(issue: string, issueType: string | null): IssueTypeUpdateResult | null {
  if (!issueType) return null;
  const ref = parseIssueRef(issue);
  const parts = repoParts(ref.repo);
  if (!parts) {
    return { issue, type: issueType, applied: false, error: `Invalid issue repo: ${ref.repo}.` };
  }

  const lookupQuery = `
query IssueTypeLookup($owner: String!, $name: String!, $number: Int!, $org: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id
    }
  }
  organization(login: $org) {
    issueTypes(first: 50) {
      nodes {
        id
        name
        isEnabled
      }
    }
  }
}
`;
  const lookup = spawnSync(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${lookupQuery}`,
      '-f',
      `owner=${parts.owner}`,
      '-f',
      `name=${parts.name}`,
      '-F',
      `number=${ref.number}`,
      '-f',
      `org=${parts.owner}`,
    ],
    { encoding: 'utf8' }
  );
  if (lookup.status !== 0) {
    return {
      issue,
      type: issueType,
      applied: false,
      error: `${lookup.stderr || lookup.stdout}`.trim() || `gh api graphql failed with exit ${lookup.status ?? 'unknown'}.`,
    };
  }

  let parsed: {
    data?: {
      repository?: { issue?: { id?: string } | null } | null;
      organization?: { issueTypes?: { nodes?: Array<{ id?: string; name?: string; isEnabled?: boolean } | null> } | null } | null;
    };
  };
  try {
    parsed = JSON.parse(lookup.stdout || '{}');
  } catch {
    return { issue, type: issueType, applied: false, error: 'Could not parse issue type lookup response.' };
  }

  const issueId = parsed.data?.repository?.issue?.id;
  const issueTypes = parsed.data?.organization?.issueTypes?.nodes?.filter((entry): entry is { id?: string; name?: string; isEnabled?: boolean } =>
    Boolean(entry)
  ) ?? [];
  const match = issueTypes.find((entry) => entry.name?.toLowerCase() === issueType.toLowerCase() && entry.isEnabled !== false);
  if (!issueId) return { issue, type: issueType, applied: false, error: `Could not resolve GitHub node id for ${issue}.` };
  if (!match?.id) {
    const available = issueTypes.map((entry) => entry.name).filter(Boolean).join(', ') || 'none';
    return { issue, type: issueType, applied: false, error: `Issue type "${issueType}" was not found for ${parts.owner}. Available: ${available}.` };
  }

  const mutation = `
mutation UpdateIssueType($issueId: ID!, $issueTypeId: ID!) {
  updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $issueTypeId }) {
    issue {
      number
      issueType {
        name
      }
    }
  }
}
`;
  const updated = spawnSync(
    'gh',
    ['api', 'graphql', '-f', `query=${mutation}`, '-f', `issueId=${issueId}`, '-f', `issueTypeId=${match.id}`],
    { encoding: 'utf8' }
  );
  if (updated.status !== 0) {
    return {
      issue,
      type: issueType,
      applied: false,
      error: `${updated.stderr || updated.stdout}`.trim() || `gh api graphql failed with exit ${updated.status ?? 'unknown'}.`,
    };
  }
  return { issue, type: issueType, applied: true, error: null };
}

function issueCreateCommand(draft: IssueCreateDraft) {
  const args = [
    'gh',
    'issue',
    'create',
    '--repo',
    draft.repo,
    '--title',
    draft.title,
    '--body-file',
    '-',
  ];
  for (const label of draft.labels) args.push('--label', label);
  for (const assignee of draft.assignees) args.push('--assignee', assignee);
  if (draft.milestone) args.push('--milestone', draft.milestone);
  return args.map(shellQuote).join(' ');
}

function createIssueFromDraft(workspaceRoot: string, result: IssueCreateResult): IssueCreateResult {
  if (!result.draft) {
    return { ...result, draftError: result.draftError ?? 'No issue draft is available to create.' };
  }

  const draft = result.draft;
  const args = ['issue', 'create', '--repo', draft.repo, '--title', draft.title, '--body-file', '-'];
  for (const label of draft.labels) args.push('--label', label);
  for (const assignee of draft.assignees) args.push('--assignee', assignee);
  if (draft.milestone) args.push('--milestone', draft.milestone);
  const created = spawnSync('gh', args, { encoding: 'utf8', input: draft.body });
  const createCommand = issueCreateCommand(draft);
  if (created.status !== 0) {
    return {
      ...result,
      createCommand,
      draftError: `${created.stderr || created.stdout}`.trim() || `gh issue create failed with exit ${created.status ?? 'unknown'}.`,
    };
  }

  const url = created.stdout.trim().split(/\r?\n/).find((line) => line.includes('/issues/')) ?? created.stdout.trim();
  const issue = issueRefFromUrl(url);
  let campaignStatus: CampaignStatusSetResult | null = null;
  let labelUpdate: IssueLabelUpdateResult | null = null;
  let issueTypeUpdate: IssueTypeUpdateResult | null = null;
  const closeoutErrors: string[] = [];

  if (issue) {
    const usageMigration = attachRunUsageToIssue(workspaceRoot, result.artifact?.runDir, issue);
    if (usageMigration.warning) closeoutErrors.push(usageMigration.warning);

    try {
      campaignStatus = setCampaignStatus(issue, 'needs-triage', { confirm: true });
    } catch (error) {
      closeoutErrors.push(error instanceof Error ? error.message : String(error));
    }

    labelUpdate = setIssueWorkflowLabel(issue, 'needs-triage', true);
    if (labelUpdate.error) closeoutErrors.push(labelUpdate.error);

    issueTypeUpdate = applyIssueType(issue, draft.issueType);
  } else {
    closeoutErrors.push(`Could not parse created issue URL: ${url || '(empty gh output)'}.`);
  }

  return {
    ...result,
    created: Boolean(issue),
    issue,
    url: url || null,
    createCommand,
    campaignStatus,
    labelUpdate,
    issueTypeUpdate,
    closeoutError: closeoutErrors.length ? closeoutErrors.join(' ') : null,
  };
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
    '- Exception: if the issue references a Sentry issue, Sentry event, Sentry short ID, or Sentry URL, use [@sentry](plugin://sentry@openai-curated) / Sentry MCP to link this GitHub issue to the referenced Sentry issue when linking is supported.',
    '- Do not mutate Sentry status, assignees, resolution, or event data during triage; only create/verify the GitHub-to-Sentry issue link and inspect safely.',
    '- Treat client data, secrets, payment details, private URLs, and raw PII as confidential. Do not copy them into GitHub comments or local files.',
    '- If Codex offers a Plan mode, stay in Plan mode for this session. Do not switch into implementation mode.',
    '',
    'Interactive triage workflow:',
    '- Use the grill-me interview behavior literally, not just as a label.',
    '- Interview the user relentlessly about every aspect of the issue until there is shared understanding.',
    '- Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one.',
    '- Ask exactly one blocking clarification question at a time, and include your recommended answer with that question.',
    '- After asking a blocking question, stop and wait for the user answer. Do not include the final battle plan in the same response as a blocking question.',
    '- If a question can be answered safely by read-only investigation, do that investigation instead of asking, then summarize only non-sensitive facts.',
    '- Only produce and post final triage notes after all blocking branches are resolved or after read-only investigation proves no user answer is needed.',
    '- Stop when the issue has a clear owner repo, problem statement, acceptance criteria, risks, dependencies, and validation commands.',
    '',
    'Goal:',
    '- Produce a compact implementation-ready battle plan, but do not implement it.',
    '- Post the final triage notes back to this GitHub issue using [@github](plugin://github@openai-curated) or `gh issue comment`.',
    '- If a Sentry issue was referenced, include the Sentry issue URL or short ID and a `Sentry link:` line stating linked, already linked, or blocked with the specific blocker.',
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

function implementationRepoForIssue(workspaceRoot: string, issue: IssueRef) {
  const context = issueContext(issue);
  const comments = issueComments(issue).comments;
  const candidates = [
    ...comments.slice().reverse().map((comment) => ownerRepoFromText(comment.body)),
    ownerRepoFromText(context.body),
  ].filter((repo): repo is string => Boolean(repo));
  const mapped = candidates.find((repo) => repoEntryForGitHub(workspaceRoot, repo));
  return mapped ?? candidates[0] ?? issue.repo;
}

function issueMatchesRepoFilter(workspaceRoot: string, issue: IssueSummary, repoFilter: string | null) {
  if (!repoFilter) return true;
  if (issue.repo === repoFilter) return true;
  return implementationRepoForIssue(workspaceRoot, issue) === repoFilter;
}

export function runIssueNext(workspaceRoot: string, options: IssueNextOptions | string = {}) {
  const label = typeof options === 'string' ? options : options.label ?? 'ready-to-engage';
  const currentRepo = typeof options === 'string' || options.allRepos ? null : repoForCurrentPath(workspaceRoot, options.currentPath);
  const repoFilter = currentRepo?.github ?? null;
  const campaignIssues = listIssuesByCampaignStatus('ready-to-engage');
  const issues = campaignIssues.filter((issue) => issueMatchesRepoFilter(workspaceRoot, issue, repoFilter));
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

export function setIssueWorkflowLabel(issue: string, status: CampaignStatusName, confirm: boolean): IssueLabelUpdateResult {
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

function emptyIssueCreateResult(
  prompt: string,
  artifact: RunArtifact | null,
  draftPath: string | null,
  adapterCommand: string,
  launched: boolean,
  launchError: string | null,
  draft: IssueCreateDraft | null,
  draftError: string | null,
  draftWarnings: string[] = []
): IssueCreateResult {
  return {
    prompt,
    artifact,
    draftPath,
    adapterCommand,
    launched,
    launchError,
    draft,
    draftError,
    draftWarnings,
    created: false,
    issue: null,
    url: null,
    createCommand: draft ? issueCreateCommand(draft) : null,
    campaignStatus: null,
    labelUpdate: null,
    issueTypeUpdate: null,
    closeoutError: null,
    contextSummary: {
      promptCharacters: prompt.length,
    },
  };
}

export function confirmIssueCreate(workspaceRoot: string, result: IssueCreateResult): IssueCreateResult {
  return createIssueFromDraft(workspaceRoot, result);
}

export function runIssueCreate(workspaceRoot: string, options: IssueCreateOptions = {}): IssueCreateResult {
  const directDraft =
    options.repo && options.title && options.body
      ? normalizeIssueCreateDraft(workspaceRoot, {
          repo: options.repo,
          title: options.title,
          body: options.body,
          labels: options.labels ?? [],
          issueType: options.issueType ?? null,
        })
      : null;
  const needsAdapter = !directDraft?.draft;
  const shouldLaunch = needsAdapter && options.dryRun === false;
  const artifactContext = shouldLaunch || options.writeArtifact ? createIssueCreateArtifact(workspaceRoot, options) : null;
  const commandRunId = createUsageCommandRunId('issue-create');
  const draftPath = artifactContext?.draftPath ?? path.join('<warroom-run>', 'issue-draft.json');
  const prompt = buildIssueCreatePrompt(workspaceRoot, draftPath, options);
  if (artifactContext) writeFileSync(artifactContext.promptPath, `${prompt}\n`);

  if (directDraft) {
    const result = emptyIssueCreateResult(
      prompt,
      artifactContext?.artifact ?? null,
      artifactContext?.draftPath ?? null,
      getInteractiveAdapterInvocation(workspaceRoot, workspaceRoot).display,
      false,
      null,
      directDraft.draft,
      directDraft.error,
      directDraft.warnings
    );
    return options.confirm && result.draft ? createIssueFromDraft(workspaceRoot, result) : result;
  }

  const adapterCommand = getInteractiveAdapterInvocation(workspaceRoot, workspaceRoot).display;
  if (!shouldLaunch) {
    return emptyIssueCreateResult(prompt, artifactContext?.artifact ?? null, artifactContext?.draftPath ?? null, adapterCommand, false, null, null, null);
  }

  const launch = runInteractiveAdapter(workspaceRoot, prompt, {
    cwd: workspaceRoot,
    usage: {
      issue: null,
      command: 'issue-create',
      stage: 'pm-session',
      repo: null,
      runDir: artifactContext?.artifact.runDir ?? null,
      commandRunId,
    },
  });
  const parsed = launch.launched && artifactContext ? parseIssueCreateDraft(workspaceRoot, artifactContext.draftPath) : { draft: null, error: null, warnings: [] };
  const result = emptyIssueCreateResult(
    prompt,
    artifactContext?.artifact ?? null,
    artifactContext?.draftPath ?? null,
    launch.invocation.display,
    launch.launched,
    launch.error,
    parsed.draft,
    parsed.error,
    parsed.warnings
  );

  return options.confirm && result.draft ? createIssueFromDraft(workspaceRoot, result) : result;
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
  const commandRunId = createUsageCommandRunId('issue-triage');

  if (options.dryRun !== false) {
    const campaignStatus = shouldMarkReady
      ? setCampaignStatus(options.issue, 'ready-to-engage', { confirm: false })
      : null;
    const labelUpdate = shouldMarkReady ? setIssueWorkflowLabel(options.issue, 'ready-to-engage', false) : null;
    return { prompt, artifact, launched: false, adapterCommand, campaignStatus, labelUpdate, triageNotes: null, contextSummary };
  }

  const beforeComments = shouldMarkReady ? issueComments(ref) : { comments: [], error: null };
  const launch = runInteractiveAdapter(workspaceRoot, prompt, {
    cwd: adapterCwd,
    usage: {
      issue: options.issue,
      command: 'issue-triage',
      stage: 'interactive-triage',
      repo: ref.repo,
      runDir: artifact?.runDir ?? null,
      commandRunId,
    },
  });
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
