import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRunArtifact, type RunArtifact } from '../lib/artifacts.js';
import { loadAlliesManifest, resolveAllyIssueRepo, type AllyEntry } from '../lib/allies.js';
import { listCampaignIssuesByStatus, setCampaignStatus, type CampaignStatusName, type CampaignStatusSetResult } from '../lib/campaign.js';
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
  status?: string;
  repo?: string;
  source: 'campaign';
  issues: IssueSummary[];
};

export type IssueHandoffResult = {
  prompt: string;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string;
  campaignStatus: CampaignStatusSetResult | null;
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

export type IssueAssigneeUpdateResult = {
  issue: string;
  assignee: string;
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
  markReady?: boolean;
  confirmStatus?: boolean;
  dryRun?: boolean;
  writeArtifact?: boolean;
  currentPath?: string;
  allRepos?: boolean;
};

export type FeedbackPostResult = {
  target: 'issue' | 'pr';
  ref: string;
  applied: boolean;
  url: string | null;
  reason: string | null;
  error: string | null;
};

export type FeedbackNotesResult = {
  marker: string;
  beforeIssueComments: number | null;
  afterIssueComments: number | null;
  foundIssueComment: boolean;
  issueCommentUrl: string | null;
  beforePrComments: number | null;
  afterPrComments: number | null;
  foundPrComment: boolean;
  prCommentUrl: string | null;
  expectedPrComment: boolean;
  reason: string | null;
  error: string | null;
};

export type IssueFeedbackOptions = {
  issue: string;
  prRef?: string;
  body?: string;
  bodyFile?: string;
  postPrComment?: boolean;
  dryRun?: boolean;
  writeArtifact?: boolean;
};

export type IssueFeedbackResult = {
  mode: 'adapter' | 'direct';
  marker: string;
  issue: string;
  prRef: string | null;
  prompt: string | null;
  formattedBody: string | null;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string | null;
  adapterCwd: string | null;
  launchError: string | null;
  feedbackNotes: FeedbackNotesResult | null;
  issueComment: FeedbackPostResult | null;
  prComment: FeedbackPostResult | null;
  contextSummary: {
    promptCharacters: number | null;
    feedbackCharacters: number | null;
  };
};

export type IssueNextOptions = {
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
const FEEDBACK_NOTES_MARKER = '## War Room feedback';

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
  if (!body) return null;
  for (const rawLine of body.split(/\r?\n/)) {
    const stripped = rawLine.replace(/[*_`]/g, '').trim();
    const match = stripped.match(/^Ready for ready-to-engage\s*:\s*(yes|no)\b/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
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

  const requestedLabels = stringArray(record.labels)
    .map((label) => label.trim())
    .filter((label) => label);
  const ally = allyForIssueRepo(workspaceRoot, repo);
  const generatedLabels = ally ? ['ally', ally.id] : [];
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
    '  "repo": "<owner>/<repo>",',
    '  "title": "Short client-safe issue title",',
    '  "body": "Markdown body focused on business scope, observed behavior, desired outcome, known links, constraints, and open questions for triage.",',
    '  "labels": ["optional-domain-or-client-label"],',
    '  "issueType": "Bug|Task|Feature|...",',
    '  "assignees": [],',
    '  "milestone": null',
    '}',
    '',
    'War Room will automatically add ally labels for ally issue repos, add the issue to Campaign Map Project 1, and set Campaign status `needs-triage`.',
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
    `- Include a standalone readiness line on its own line, written exactly as: \`${TRIAGE_READY_LINE}\` (or \`Ready for ready-to-engage: no\` when a blocker remains). Write it as plain text — no bold, italics, backticks, blockquote, or list markers around the line, the label, or the value. A line like \`**Ready for ready-to-engage:** yes\` will not be detected.`,
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

export function runIssueNext(workspaceRoot: string, options: IssueNextOptions = {}): IssueListResult {
  const currentRepo = options.allRepos ? null : repoForCurrentPath(workspaceRoot, options.currentPath);
  const repoFilter = currentRepo?.github ?? null;
  const campaignIssues = listIssuesByCampaignStatus('ready-to-engage', repoFilter);
  const issues = campaignIssues.filter((issue) => issueMatchesRepoFilter(workspaceRoot, issue, repoFilter));
  return { status: 'ready-to-engage', repo: repoFilter ?? undefined, source: 'campaign', issues };
}

function listIssuesByCampaignStatus(status: 'needs-triage' | 'ready-to-engage', repo: string | null = null) {
  return listCampaignIssuesByStatus(status, repo).map((issue) => ({
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
    status: issue.status,
    projectItemId: issue.projectItemId,
  }));
}

export function assignSelfToIssue(issue: string, confirm: boolean): IssueAssigneeUpdateResult {
  const ref = parseIssueRef(issue);
  const assignee = '@me';
  if (!confirm) {
    return { issue, assignee, applied: false, error: null };
  }
  const result = spawnSync(
    'gh',
    ['issue', 'edit', String(ref.number), '--repo', ref.repo, '--add-assignee', assignee],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    return {
      issue,
      assignee,
      applied: false,
      error:
        `${result.stderr || result.stdout}`.trim() ||
        `gh issue edit failed with exit ${result.status ?? 'unknown'}.`,
    };
  }
  return { issue, assignee, applied: true, error: null };
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
  if (!options.issue) {
    const currentRepo = options.allRepos ? null : repoForCurrentPath(workspaceRoot, options.currentPath);
    const repoFilter = currentRepo?.github ?? null;
    const campaignIssues = listIssuesByCampaignStatus('needs-triage', repoFilter);
    const issues = campaignIssues.filter((issue) => issueMatchesRepoFilter(workspaceRoot, issue, repoFilter));
    return { status: 'needs-triage', repo: repoFilter ?? undefined, source: 'campaign', issues };
  }

  const ref = parseIssueRef(options.issue);
  const prompt = buildTriagePrompt(workspaceRoot, ref);
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'issue-triage', {
        'prompt.md': prompt,
        'input.json': JSON.stringify({ issue: options.issue }, null, 2),
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
    return { prompt, artifact, launched: false, adapterCommand, campaignStatus, triageNotes: null, contextSummary };
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
    } else if (triageNotes.found) {
      const reason = triageNotes.commentUrl
        ? `Triage notes marked the issue as not ready for ready-to-engage. See ${triageNotes.commentUrl}.`
        : 'Triage notes marked the issue as not ready for ready-to-engage.';
      try {
        campaignStatus = setCampaignStatus(options.issue, 'blockaded', { confirm: options.confirmStatus, reason });
      } catch (error) {
        closeoutError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  return {
    prompt,
    artifact,
    launched: launch.launched,
    adapterCommand: launch.invocation.display,
    campaignStatus,
    triageNotes,
    contextSummary,
    launchError: launch.error,
    closeoutError,
  };
}

function currentGhUserLogin(): string | null {
  const result = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function formatFeedbackComment(args: {
  feedbackBody: string;
  author: string | null;
  prRef: string | null;
  postedAt: Date;
}): string {
  const lines: string[] = [FEEDBACK_NOTES_MARKER, ''];
  if (args.author) lines.push(`**Author:** @${args.author}`);
  lines.push(`**Posted:** ${args.postedAt.toISOString()}`);
  if (args.prRef) lines.push(`**Related PR:** ${args.prRef}`);
  lines.push('', '---', '', args.feedbackBody.trim());
  return lines.join('\n');
}

function postIssueFeedbackComment(ref: IssueRef, body: string): FeedbackPostResult {
  const result = spawnSync('gh', ['issue', 'comment', String(ref.number), '--repo', ref.repo, '--body', body], { encoding: 'utf8' });
  if (result.status !== 0) {
    return {
      target: 'issue',
      ref: `${ref.repo}#${ref.number}`,
      applied: false,
      url: null,
      reason: null,
      error: result.stderr.trim() || `gh issue comment failed with exit ${result.status ?? 'unknown'}.`,
    };
  }
  return {
    target: 'issue',
    ref: `${ref.repo}#${ref.number}`,
    applied: true,
    url: result.stdout.trim() || null,
    reason: null,
    error: null,
  };
}

function postPrFeedbackComment(ref: IssueRef, body: string): FeedbackPostResult {
  const result = spawnSync('gh', ['pr', 'comment', String(ref.number), '--repo', ref.repo, '--body', body], { encoding: 'utf8' });
  if (result.status !== 0) {
    return {
      target: 'pr',
      ref: `${ref.repo}#${ref.number}`,
      applied: false,
      url: null,
      reason: null,
      error: result.stderr.trim() || `gh pr comment failed with exit ${result.status ?? 'unknown'}.`,
    };
  }
  return {
    target: 'pr',
    ref: `${ref.repo}#${ref.number}`,
    applied: true,
    url: result.stdout.trim() || null,
    reason: null,
    error: null,
  };
}

function prComments(ref: IssueRef): { comments: IssueComment[]; error: string | null } {
  const result = spawnSync('gh', ['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', 'comments'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return { comments: [], error: `${result.stderr || result.stdout}`.trim() || `gh pr view failed with exit ${result.status ?? 'unknown'}.` };
  }
  try {
    const parsed = JSON.parse(result.stdout || '{}') as { comments?: IssueComment[] };
    return { comments: parsed.comments ?? [], error: null };
  } catch {
    return { comments: [], error: 'Could not parse gh pr comments output.' };
  }
}

function verifyFeedbackNotes(
  issueRef: IssueRef,
  prRef: IssueRef | null,
  expectPrComment: boolean,
  before: {
    issue: { comments: IssueComment[]; error: string | null };
    pr: { comments: IssueComment[]; error: string | null } | null;
  }
): FeedbackNotesResult {
  if (before.issue.error) {
    return {
      marker: FEEDBACK_NOTES_MARKER,
      beforeIssueComments: null,
      afterIssueComments: null,
      foundIssueComment: false,
      issueCommentUrl: null,
      beforePrComments: before.pr?.comments.length ?? null,
      afterPrComments: null,
      foundPrComment: false,
      prCommentUrl: null,
      expectedPrComment: expectPrComment,
      reason: 'Could not inspect issue comments before launch.',
      error: before.issue.error,
    };
  }

  const afterIssue = issueComments(issueRef);
  if (afterIssue.error) {
    return {
      marker: FEEDBACK_NOTES_MARKER,
      beforeIssueComments: before.issue.comments.length,
      afterIssueComments: null,
      foundIssueComment: false,
      issueCommentUrl: null,
      beforePrComments: before.pr?.comments.length ?? null,
      afterPrComments: null,
      foundPrComment: false,
      prCommentUrl: null,
      expectedPrComment: expectPrComment,
      reason: 'Could not inspect issue comments after launch.',
      error: afterIssue.error,
    };
  }

  const beforeIssueKeys = new Set(before.issue.comments.map(commentKey));
  const newIssueComments = afterIssue.comments.filter((comment) => !beforeIssueKeys.has(commentKey(comment)));
  const issueNote = newIssueComments.find((comment) => comment.body?.includes(FEEDBACK_NOTES_MARKER));

  let foundPrComment = false;
  let prCommentUrl: string | null = null;
  let afterPrCommentCount: number | null = null;
  let prReason: string | null = null;
  let prError: string | null = null;

  if (expectPrComment && prRef) {
    const afterPr = prComments(prRef);
    afterPrCommentCount = afterPr.comments.length;
    if (afterPr.error) {
      prError = afterPr.error;
      prReason = 'Could not inspect PR comments after launch.';
    } else {
      const beforePrKeys = new Set((before.pr?.comments ?? []).map(commentKey));
      const newPrComments = afterPr.comments.filter((comment) => !beforePrKeys.has(commentKey(comment)));
      const prNote = newPrComments.find((comment) => comment.body?.includes(FEEDBACK_NOTES_MARKER));
      if (prNote) {
        foundPrComment = true;
        prCommentUrl = prNote.url ?? null;
      } else {
        prReason = `No new PR comment containing "${FEEDBACK_NOTES_MARKER}" was found.`;
      }
    }
  }

  const reason = !issueNote
    ? `No new issue comment containing "${FEEDBACK_NOTES_MARKER}" was found.`
    : prReason;

  return {
    marker: FEEDBACK_NOTES_MARKER,
    beforeIssueComments: before.issue.comments.length,
    afterIssueComments: afterIssue.comments.length,
    foundIssueComment: Boolean(issueNote),
    issueCommentUrl: issueNote?.url ?? null,
    beforePrComments: before.pr?.comments.length ?? null,
    afterPrComments: afterPrCommentCount,
    foundPrComment,
    prCommentUrl,
    expectedPrComment: expectPrComment,
    reason,
    error: prError,
  };
}

function buildFeedbackPrompt(
  workspaceRoot: string,
  issueRef: IssueRef,
  prRef: IssueRef | null,
  postedAt: Date
): string {
  const issue = issueContext(issueRef);
  const labels = labelsFromGh(issue.labels ?? []);
  const pr = prRef
    ? ghJson<{ title?: string; url?: string; body?: string; headRefName?: string }>(
        ['pr', 'view', String(prRef.number), '--repo', prRef.repo, '--json', 'title,url,body,headRefName'],
        {}
      )
    : null;
  const isoDate = postedAt.toISOString();
  const ghLogin = currentGhUserLogin();
  const lines: (string | null)[] = [
    `War Room issue feedback handoff for ${issueRef.repo}#${issueRef.number}`,
    '',
    `Parent issue: ${issueRef.repo}#${issueRef.number}`,
    `Title: ${issue.title ?? 'unknown'}`,
    `URL: ${issue.url ?? `https://github.com/${issueRef.repo}/issues/${issueRef.number}`}`,
    `Labels: ${labels.length ? labels.join(', ') : 'none'}`,
    prRef ? `In-flight PR: ${prRef.repo}#${prRef.number}` : null,
    pr?.url ? `PR URL: ${pr.url}` : null,
    pr?.headRefName ? `PR branch: ${pr.headRefName}` : null,
    '',
    buildSpecialistContext(workspaceRoot, issueRef.repo),
    '',
    'Feedback intake mode contract:',
    '- This is a light, scoped feedback intake — not a full re-triage. The parent issue has already been triaged.',
    '- Read-only inspection only. Do not edit repository files, create branches, commit, open PRs, or run formatters in this session.',
    '- Do not include the feedback content in implementation prompts. Posting the structured comment is the deliverable.',
    '- Treat client data, secrets, payment details, private URLs, and raw PII as confidential. Do not copy them into the GitHub comment.',
    '',
    'Light grill-me workflow:',
    '- Open the session with: "What feedback would you like to add to this issue?"',
    '- Wait for the user reply, then ask up to 2 clarifying questions one at a time — only when there is genuine ambiguity. Skip questions whose answers are already clear from the user reply.',
    '  - Clarifier 1 (only if missing): What problem does this feedback solve, and why does it want to land alongside the parent work rather than as a separate follow-up?',
    prRef
      ? `  - Clarifier 2 (only if missing): Should this fold into the in-flight PR ${prRef.repo}#${prRef.number} before merge, or land as a follow-up after it ships? Recommend in-PR by default when --pr was passed; only diverge when the user signals otherwise.`
      : `  - Clarifier 2 (only if missing): Which repo/branch should pick this up — does this need its own follow-up PR, or is it scoped to the parent issue's existing work?`,
    '- Stop questioning as soon as you have what + why + scope. Do not ask filler questions.',
    '- Read-only investigation (gh / repo files) is allowed and preferred over asking a question whose answer is in the repo.',
    '',
    'Posting the structured feedback comment:',
    `- After the interview, post a single comment to ${issueRef.repo}#${issueRef.number} using \`gh issue comment ${issueRef.number} --repo ${issueRef.repo} --body <body>\` (or the equivalent GitHub MCP call).`,
    `- The comment body MUST start with exactly: ${FEEDBACK_NOTES_MARKER}`,
    '- The next non-empty lines, in order, must be:',
    ghLogin ? `  - **Author:** @${ghLogin}` : `  - **Author:** @<your GitHub login>`,
    `  - **Posted:** ${isoDate}`,
    prRef ? `  - **Related PR:** ${prRef.repo}#${prRef.number}` : null,
    '- Then a horizontal rule (`---`) on its own line, then the structured feedback content with these sections:',
    '  - **What:** one-paragraph description of the refinement.',
    '  - **Why:** the motivation — what breaks or what we gain if this lands alongside the parent issue.',
    '  - **Scope:** explicit out-of-scope list so the implementer keeps the change narrow.',
    '  - **Where it lands:** which repo / PR / branch picks this up (cite the in-flight PR when set).',
    '- Keep the comment compact. This is a refinement comment, not a re-triage. Aim for under ~30 lines.',
    prRef
      ? `- After posting the issue comment, post the same body as a PR conversation comment using \`gh pr comment ${prRef.number} --repo ${prRef.repo} --body <body>\` so the in-flight PR review picks it up. (Skip this step only if the user explicitly says not to cross-post.)`
      : null,
    '',
    'Wrap-up:',
    '- After posting, print the comment URL(s) and tell the user the suggested next step:',
    prRef
      ? `  - "Drop a review comment / nudge on ${prRef.repo}#${prRef.number} reviewers so they fold this into the PR before merge."`
      : `  - "Run \`warroom issue next --issue ${issueRef.repo}#${issueRef.number}\` (or open a focused follow-up PR) to implement this feedback."`,
    '',
    'Issue body (for context only — do not re-summarize):',
    truncateText(issue.body),
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

export function runIssueFeedback(workspaceRoot: string, options: IssueFeedbackOptions): IssueFeedbackResult {
  const ref = parseIssueRef(options.issue);
  const prRef = options.prRef ? parseIssueRef(options.prRef) : null;
  const shouldPostPrComment = Boolean(prRef && options.postPrComment !== false);

  // Direct mode: caller provided --body or --file. Skip the LLM and post the structured comment ourselves.
  let directBody: string | null = null;
  if (options.body) directBody = options.body.trim();
  else if (options.bodyFile) {
    const filePath = path.isAbsolute(options.bodyFile)
      ? options.bodyFile
      : path.resolve(process.cwd(), options.bodyFile);
    if (!existsSync(filePath)) {
      throw new Error(`Feedback body file not found: ${filePath}`);
    }
    directBody = readFileSync(filePath, 'utf8').trim();
  }
  if (directBody !== null && !directBody) {
    throw new Error('Feedback body resolved to an empty string. Provide non-empty --body or --file.');
  }

  if (directBody) {
    return runDirectFeedback(workspaceRoot, options, ref, prRef, shouldPostPrComment, directBody);
  }

  return runAdapterFeedback(workspaceRoot, options, ref, prRef, shouldPostPrComment);
}

function runDirectFeedback(
  workspaceRoot: string,
  options: IssueFeedbackOptions,
  ref: IssueRef,
  prRef: IssueRef | null,
  shouldPostPrComment: boolean,
  feedbackBody: string
): IssueFeedbackResult {
  const author = currentGhUserLogin();
  const postedAt = new Date();
  const formattedBody = formatFeedbackComment({
    feedbackBody,
    author,
    prRef: prRef ? `${prRef.repo}#${prRef.number}` : null,
    postedAt,
  });

  const planOnly = options.dryRun !== false;
  let issueComment: FeedbackPostResult;
  let prComment: FeedbackPostResult | null = null;

  if (planOnly) {
    issueComment = {
      target: 'issue',
      ref: `${ref.repo}#${ref.number}`,
      applied: false,
      url: null,
      reason: 'Dry run; rerun without --dry-run (and with --body/--file) to post directly.',
      error: null,
    };
    if (shouldPostPrComment && prRef) {
      prComment = {
        target: 'pr',
        ref: `${prRef.repo}#${prRef.number}`,
        applied: false,
        url: null,
        reason: 'Dry run; rerun without --dry-run to post directly.',
        error: null,
      };
    }
  } else {
    issueComment = postIssueFeedbackComment(ref, formattedBody);
    if (shouldPostPrComment && prRef) {
      prComment = postPrFeedbackComment(prRef, formattedBody);
    }
  }

  let artifact: RunArtifact | null = null;
  if (options.writeArtifact) {
    artifact = createRunArtifact(workspaceRoot, 'issue-feedback', {
      'input.json': JSON.stringify(options, null, 2),
      'feedback.md': formattedBody,
    });
  }

  return {
    mode: 'direct',
    marker: FEEDBACK_NOTES_MARKER,
    issue: options.issue,
    prRef: prRef ? `${prRef.repo}#${prRef.number}` : null,
    prompt: null,
    formattedBody,
    artifact,
    launched: false,
    adapterCommand: null,
    adapterCwd: null,
    launchError: null,
    feedbackNotes: null,
    issueComment,
    prComment,
    contextSummary: {
      promptCharacters: null,
      feedbackCharacters: feedbackBody.length,
    },
  };
}

function runAdapterFeedback(
  workspaceRoot: string,
  options: IssueFeedbackOptions,
  ref: IssueRef,
  prRef: IssueRef | null,
  shouldPostPrComment: boolean
): IssueFeedbackResult {
  const postedAt = new Date();
  const prompt = buildFeedbackPrompt(workspaceRoot, ref, prRef, postedAt);
  const adapterCwd = repoWorkspaceForGitHub(workspaceRoot, prRef?.repo ?? ref.repo);
  const adapterCommand = getInteractiveAdapterInvocation(workspaceRoot, adapterCwd).display;
  const contextSummary = {
    promptCharacters: prompt.length,
    feedbackCharacters: null,
  };

  let artifact: RunArtifact | null = null;
  if (options.writeArtifact) {
    artifact = createRunArtifact(workspaceRoot, 'issue-feedback', {
      'prompt.md': prompt,
      'input.json': JSON.stringify(options, null, 2),
    });
  }

  if (options.dryRun !== false) {
    return {
      mode: 'adapter',
      marker: FEEDBACK_NOTES_MARKER,
      issue: options.issue,
      prRef: prRef ? `${prRef.repo}#${prRef.number}` : null,
      prompt,
      formattedBody: null,
      artifact,
      launched: false,
      adapterCommand,
      adapterCwd,
      launchError: null,
      feedbackNotes: null,
      issueComment: null,
      prComment: null,
      contextSummary,
    };
  }

  const beforeIssue = issueComments(ref);
  const beforePr = shouldPostPrComment && prRef ? prComments(prRef) : null;
  const launch = runInteractiveAdapter(workspaceRoot, prompt, {
    cwd: adapterCwd,
    usage: {
      issue: options.issue,
      command: 'issue-feedback',
      stage: 'interactive-feedback',
      repo: ref.repo,
      runDir: artifact?.runDir ?? null,
      commandRunId: createUsageCommandRunId('issue-feedback'),
    },
  });

  let feedbackNotes: FeedbackNotesResult | null = null;
  if (launch.launched) {
    feedbackNotes = verifyFeedbackNotes(ref, prRef, shouldPostPrComment, { issue: beforeIssue, pr: beforePr });
  }

  return {
    mode: 'adapter',
    marker: FEEDBACK_NOTES_MARKER,
    issue: options.issue,
    prRef: prRef ? `${prRef.repo}#${prRef.number}` : null,
    prompt,
    formattedBody: null,
    artifact,
    launched: launch.launched,
    adapterCommand: launch.invocation.display,
    adapterCwd,
    launchError: launch.error,
    feedbackNotes,
    issueComment: null,
    prComment: null,
    contextSummary,
  };
}
