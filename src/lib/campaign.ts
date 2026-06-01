import { spawnSync } from 'node:child_process';
import { parseRepoRef } from './refs.js';
import { getProjectConfig, parseCampaignProjectEnv } from './repos.js';
import { findWarRoomWorkspace } from './workspace.js';

// The campaign GitHub Project owner/number come from repos.yaml `defaults`
// (campaign_owner falls back to the repo owner; project number defaults to 1),
// overridable via WARROOM_CAMPAIGN_OWNER / WARROOM_CAMPAIGN_PROJECT.
export function campaignTarget(): { owner: string; project: number } {
  const env = process.env;
  const envOwner = env.WARROOM_CAMPAIGN_OWNER;
  const envProject = parseCampaignProjectEnv(env.WARROOM_CAMPAIGN_PROJECT);
  if (envOwner && envProject !== undefined) return { owner: envOwner, project: envProject };
  try {
    const config = getProjectConfig(findWarRoomWorkspace());
    return {
      owner: envOwner ?? config.campaignOwner,
      project: envProject ?? config.campaignProjectNumber,
    };
  } catch {
    return { owner: envOwner ?? 'your-org', project: envProject ?? 1 };
  }
}

const PROJECT_ITEM_LIST_RECENT_LIMIT = '200';
const PROJECT_ITEM_LIST_FALLBACK_LIMIT = '2000';
const RATE_LIMIT_RETRY_DELAY_MS = 30_000;

export const CAMPAIGN_STATUSES = [
  { name: 'needs-triage', color: 'GRAY', description: 'Blurry territory that needs planning before execution.' },
  { name: 'ready-to-engage', color: 'GREEN', description: 'Planned territory ready for implementation.' },
  { name: 'battlefield-active', color: 'BLUE', description: 'Work is actively being implemented.' },
  { name: 'skirmish', color: 'YELLOW', description: 'PR review, CodeRabbit feedback, or follow-up changes are being handled.' },
  { name: 'blockaded', color: 'RED', description: 'Work is blocked by an external dependency, decision, access issue, or prerequisite.' },
  { name: 'victory', color: 'PURPLE', description: 'Work is merged, cleaned up, and reported.' },
] as const;

export type CampaignStatusName = (typeof CAMPAIGN_STATUSES)[number]['name'];

export type CampaignStatusReport = {
  checked: boolean;
  expected: typeof CAMPAIGN_STATUSES;
  missing: string[];
  unexpected: string[];
  options: Array<{ id: string; name: string }>;
  projectId: string | null;
  statusFieldId: string | null;
  errors: string[];
};

export type CampaignStatusSetResult = {
  issue: string;
  status: CampaignStatusName;
  projectItemId: string | null;
  optionId: string;
  applied: boolean;
  added: boolean;
  reason: string | null;
};

export type CampaignProjectIssue = {
  repo: string;
  number: number;
  title: string;
  url: string;
  status: string | null;
  labels: string[];
  projectItemId: string;
};

type ProjectItem = {
  id: string;
  title?: string;
  status?: string;
  labels?: string[];
  content?: {
    repository?: string;
    number?: number;
    title?: string;
    url?: string;
  };
};

type CampaignCache = {
  pathKey?: string;
  projectView?: { id?: string; title?: string };
  statusField?: {
    id: string;
    name: string;
    type: string;
    options?: Array<{ id: string; name: string }>;
  } | null;
  items?: { items: ProjectItem[]; scope: 'recent' | 'fallback' };
};

let cache: CampaignCache = {};

function ensureCacheForCurrentPath() {
  const currentPath = process.env.PATH ?? '';
  if (cache.pathKey !== currentPath) {
    cache = { pathKey: currentPath };
  }
}

export function resetCampaignCache() {
  cache = { pathKey: process.env.PATH ?? '' };
}

function isRateLimitError(stderr: string) {
  const lower = stderr.toLowerCase();
  return lower.includes('api rate limit') || lower.includes('secondary rate limit') || lower.includes('rate limit exceeded');
}

function sleepSyncMs(ms: number) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function ghRun(args: string[]): { status: number | null; stdout: string; stderr: string } {
  let result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 && isRateLimitError(result.stderr ?? '')) {
    process.stderr.write(`gh rate limit hit; waiting ${Math.round(RATE_LIMIT_RETRY_DELAY_MS / 1000)}s before retry...\n`);
    sleepSyncMs(RATE_LIMIT_RETRY_DELAY_MS);
    result = spawnSync('gh', args, { encoding: 'utf8' });
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function ghJson<T>(args: string[], fallback: T): T {
  const result = ghRun(args);
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
}

function projectView() {
  ensureCacheForCurrentPath();
  if (cache.projectView !== undefined) return cache.projectView;
  const target = campaignTarget();
  cache.projectView = ghJson<{
    id?: string;
    title?: string;
  }>(['project', 'view', String(target.project), '--owner', target.owner, '--format', 'json'], {});
  return cache.projectView;
}

function projectStatusField() {
  ensureCacheForCurrentPath();
  if (cache.statusField !== undefined) return cache.statusField;
  const fields = ghJson<{
    fields?: Array<{
      id: string;
      name: string;
      type: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  }>(['project', 'field-list', String(campaignTarget().project), '--owner', campaignTarget().owner, '--format', 'json'], {});

  cache.statusField = fields.fields?.find((field) => field.name === 'Status' && field.type === 'ProjectV2SingleSelectField') ?? null;
  return cache.statusField;
}

function fetchProjectItems(scope: 'recent' | 'fallback'): ProjectItem[] {
  const limit = scope === 'recent' ? PROJECT_ITEM_LIST_RECENT_LIMIT : PROJECT_ITEM_LIST_FALLBACK_LIMIT;
  const target = campaignTarget();
  const args = ['project', 'item-list', String(target.project), '--owner', target.owner, '--format', 'json', '--limit', limit];
  const response = ghJson<{ items?: ProjectItem[] }>(args, {});
  return response.items ?? [];
}

function projectItems(scope: 'recent' | 'fallback' = 'recent'): ProjectItem[] {
  ensureCacheForCurrentPath();
  if (cache.items && (cache.items.scope === scope || cache.items.scope === 'fallback')) {
    return cache.items.items;
  }
  const items = fetchProjectItems(scope);
  cache.items = { items, scope };
  return items;
}

export function checkCampaignStatusOptions(): CampaignStatusReport {
  const errors: string[] = [];
  const project = projectView();
  const field = projectStatusField();

  if (!project.id) {
    const target = campaignTarget();
    errors.push(`Could not load ${target.owner} Project ${target.project}.`);
  }
  if (!field) errors.push('Could not load Campaign Map Status field.');

  const options = field?.options ?? [];
  const optionNames = new Set(options.map((option) => option.name));
  const expectedNames = CAMPAIGN_STATUSES.map((status) => status.name);

  return {
    checked: errors.length === 0,
    expected: CAMPAIGN_STATUSES,
    missing: expectedNames.filter((name) => !optionNames.has(name)),
    unexpected: options.map((option) => option.name).filter((name) => !expectedNames.includes(name as CampaignStatusName)),
    options,
    projectId: project.id ?? null,
    statusFieldId: field?.id ?? null,
    errors,
  };
}

export function parseIssueRef(value: string) {
  const ref = parseRepoRef(value);
  return { ...ref, label: `${ref.repo}#${ref.number}` };
}

function projectItemForIssue(issue: string) {
  const ref = parseIssueRef(issue);
  const match = (items: ProjectItem[]) =>
    items.find((item) => item.content?.repository === ref.repo && item.content?.number === ref.number) ?? null;

  const recent = match(projectItems('recent'));
  if (recent) return recent;
  if (cache.items?.scope === 'fallback') return null;
  return match(projectItems('fallback'));
}

export function listCampaignIssuesByStatus(status: CampaignStatusName, repo: string | null = null): CampaignProjectIssue[] {
  const matchesRepo = (item: ProjectItem) => !repo || item.content?.repository === repo;
  const filtered = (items: ProjectItem[]) =>
    items.filter((item) => item.status === status && item.content?.repository && item.content?.number && matchesRepo(item));

  let items = filtered(projectItems('recent'));
  if (items.length === 0 && repo && cache.items?.scope !== 'fallback') {
    items = filtered(projectItems('fallback'));
  }

  return items.map((item) => ({
    repo: item.content?.repository ?? '',
    number: item.content?.number ?? 0,
    title: item.content?.title ?? item.title ?? '',
    url: item.content?.url ?? `https://github.com/${item.content?.repository}/issues/${item.content?.number}`,
    status: item.status ?? null,
    labels: item.labels ?? [],
    projectItemId: item.id,
  }));
}

function ensureProjectItem(issue: string): { item: { id: string; content: { repository: string; number: number; url: string } }; added: boolean } {
  const existing = projectItemForIssue(issue);
  if (existing) {
    const ref = parseIssueRef(issue);
    return {
      item: {
        id: existing.id,
        content: {
          repository: existing.content?.repository ?? ref.repo,
          number: existing.content?.number ?? ref.number,
          url: existing.content?.url ?? `https://github.com/${ref.repo}/issues/${ref.number}`,
        },
      },
      added: false,
    };
  }

  const ref = parseIssueRef(issue);
  const url = `https://github.com/${ref.repo}/issues/${ref.number}`;
  const target = campaignTarget();
  const added = ghJson<{ id?: string }>(
    ['project', 'item-add', String(target.project), '--owner', target.owner, '--url', url, '--format', 'json'],
    {}
  );
  if (!added.id) throw new Error(`Could not add ${issue} to Campaign Map.`);
  cache.items = undefined;
  return {
    item: { id: added.id, content: { repository: ref.repo, number: ref.number, url } },
    added: true,
  };
}

export function setCampaignStatus(issue: string, status: CampaignStatusName, options: { confirm?: boolean; reason?: string | null } = {}): CampaignStatusSetResult {
  if (!CAMPAIGN_STATUSES.some((entry) => entry.name === status)) {
    throw new Error(`Unknown Campaign Map status "${status}".`);
  }
  if (status === 'blockaded' && !options.reason) {
    throw new Error('Moving work to blockaded requires a human-readable --reason.');
  }

  const report = checkCampaignStatusOptions();
  if (report.errors.length > 0 || report.missing.length > 0 || !report.projectId || !report.statusFieldId) {
    throw new Error(`Campaign Map status field is not ready: ${[...report.errors, ...report.missing].join(', ')}`);
  }

  const option = report.options.find((entry) => entry.name === status);
  if (!option) throw new Error(`Campaign Map status option missing: ${status}`);

  const { item, added } = ensureProjectItem(issue);

  if (options.confirm) {
    const result = ghRun([
      'project',
      'item-edit',
      '--id',
      item.id,
      '--project-id',
      report.projectId,
      '--field-id',
      report.statusFieldId,
      '--single-select-option-id',
      option.id,
    ]);
    if (result.status !== 0) throw new Error(`${result.stderr || result.stdout}`.trim());
    if (cache.items) {
      const cached = cache.items.items.find((entry) => entry.id === item.id);
      if (cached) cached.status = status;
    }
  }

  return {
    issue,
    status,
    projectItemId: item.id,
    optionId: option.id,
    applied: options.confirm ?? false,
    added,
    reason: options.reason ?? null,
  };
}
