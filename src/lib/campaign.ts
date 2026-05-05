import { spawnSync } from 'node:child_process';
import { type RepoManifest } from './repos.js';

export const CAMPAIGN_OWNER = 'TeamFloPay';
export const CAMPAIGN_PROJECT_NUMBER = 1;

export const CAMPAIGN_STATUSES = [
  { name: 'needs-triage', color: 'GRAY', description: 'Blurry territory that needs planning before execution.' },
  { name: 'ready-to-engage', color: 'GREEN', description: 'Planned territory ready for implementation.' },
  { name: 'battlefield-active', color: 'BLUE', description: 'Work is actively being implemented.' },
  { name: 'skirmish', color: 'YELLOW', description: 'PR review, CodeRabbit feedback, or follow-up changes are being handled.' },
  { name: 'blockaded', color: 'RED', description: 'Work is blocked by an external dependency, decision, access issue, or prerequisite.' },
  { name: 'victory', color: 'PURPLE', description: 'Work is merged, cleaned up, and reported.' },
] as const;

export const CAMPAIGN_LABELS = [
  { name: 'needs-triage', color: 'D4C5F9', description: 'Blurry territory that needs planning before execution.' },
  { name: 'ready-to-engage', color: '0E8A16', description: 'Planned work ready for implementation.' },
  { name: 'battlefield-active', color: '1D76DB', description: 'Work is actively being implemented.' },
  { name: 'skirmish', color: 'FBCA04', description: 'PR review, CodeRabbit feedback, or follow-up changes are being handled.' },
  { name: 'blockaded', color: 'B60205', description: 'Work is blocked by an external dependency, decision, access issue, or prerequisite.' },
  { name: 'victory', color: '5319E7', description: 'Work is merged, cleaned up, and reported.' },
] as const;

export type CampaignStatusName = (typeof CAMPAIGN_STATUSES)[number]['name'];

export type CampaignLabelReport = {
  checked: boolean;
  expected: typeof CAMPAIGN_LABELS;
  missing: Array<{ repo: string; label: string }>;
  errors: Array<{ repo: string; detail: string }>;
  createPlan: string[];
};

export type CampaignLabelApplyResult = CampaignLabelReport & {
  applied: boolean;
  created: Array<{ repo: string; label: string }>;
};

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
  projectItemId: string;
  optionId: string;
  applied: boolean;
  reason: string | null;
};

function ghJson<T>(args: string[], fallback: T): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
}

export function checkCampaignLabels(manifest: RepoManifest): CampaignLabelReport {
  const missing: CampaignLabelReport['missing'] = [];
  const errors: CampaignLabelReport['errors'] = [];
  const createPlan: string[] = [];

  for (const repo of manifest.repos) {
    const result = spawnSync('gh', ['label', 'list', '--repo', repo.github, '--json', 'name', '--limit', '100'], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      errors.push({ repo: repo.github, detail: `${result.stderr || result.stdout}`.trim() });
      continue;
    }

    let labels: Array<{ name?: string }>;
    try {
      labels = JSON.parse(result.stdout || '[]') as Array<{ name?: string }>;
    } catch {
      errors.push({ repo: repo.github, detail: 'Could not parse gh label list output.' });
      continue;
    }
    const existing = new Set(labels.map((label) => label.name).filter(Boolean));
    for (const label of CAMPAIGN_LABELS) {
      if (!existing.has(label.name)) {
        missing.push({ repo: repo.github, label: label.name });
        createPlan.push(
          `gh label create ${label.name} --repo ${repo.github} --color ${label.color} --description "${label.description}"`
        );
      }
    }
  }

  return {
    checked: errors.length === 0,
    expected: CAMPAIGN_LABELS,
    missing,
    errors,
    createPlan,
  };
}

export function applyCampaignLabels(manifest: RepoManifest, confirm: boolean): CampaignLabelApplyResult {
  const report = checkCampaignLabels(manifest);
  const created: Array<{ repo: string; label: string }> = [];

  if (!confirm || report.errors.length > 0) {
    return { ...report, applied: false, created };
  }

  for (const missing of report.missing) {
    const label = CAMPAIGN_LABELS.find((entry) => entry.name === missing.label);
    if (!label) continue;
    const result = spawnSync(
      'gh',
      [
        'label',
        'create',
        label.name,
        '--repo',
        missing.repo,
        '--color',
        label.color,
        '--description',
        label.description,
      ],
      { encoding: 'utf8' }
    );
    if (result.status === 0) {
      created.push(missing);
    }
  }

  return { ...checkCampaignLabels(manifest), applied: true, created };
}

function projectView() {
  return ghJson<{
    id?: string;
    title?: string;
  }>(['project', 'view', String(CAMPAIGN_PROJECT_NUMBER), '--owner', CAMPAIGN_OWNER, '--format', 'json'], {});
}

function projectStatusField() {
  const fields = ghJson<{
    fields?: Array<{
      id: string;
      name: string;
      type: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  }>(['project', 'field-list', String(CAMPAIGN_PROJECT_NUMBER), '--owner', CAMPAIGN_OWNER, '--format', 'json'], {});

  return fields.fields?.find((field) => field.name === 'Status' && field.type === 'ProjectV2SingleSelectField') ?? null;
}

export function checkCampaignStatusOptions(): CampaignStatusReport {
  const errors: string[] = [];
  const project = projectView();
  const field = projectStatusField();

  if (!project.id) errors.push(`Could not load TeamFloPay Project ${CAMPAIGN_PROJECT_NUMBER}.`);
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
  const match = value.match(/^([^#]+)#(\d+)$/);
  if (!match) throw new Error('Issue references must use owner/repo#number, for example TeamFloPay/infra#4.');
  return { repo: match[1], number: Number(match[2]), label: value };
}

function projectItemForIssue(issue: string) {
  const ref = parseIssueRef(issue);
  const items = ghJson<{
    items?: Array<{
      id: string;
      content?: {
        repository?: string;
        number?: number;
        url?: string;
      };
    }>;
  }>(['project', 'item-list', String(CAMPAIGN_PROJECT_NUMBER), '--owner', CAMPAIGN_OWNER, '--format', 'json', '--limit', '100'], {});

  return items.items?.find((item) => item.content?.repository === ref.repo && item.content?.number === ref.number) ?? null;
}

function ensureProjectItem(issue: string) {
  const existing = projectItemForIssue(issue);
  if (existing) return existing;

  const ref = parseIssueRef(issue);
  const url = `https://github.com/${ref.repo}/issues/${ref.number}`;
  const added = ghJson<{ id?: string }>(
    ['project', 'item-add', String(CAMPAIGN_PROJECT_NUMBER), '--owner', CAMPAIGN_OWNER, '--url', url, '--format', 'json'],
    {}
  );
  if (!added.id) throw new Error(`Could not add ${issue} to Campaign Map.`);
  return { id: added.id, content: { repository: ref.repo, number: ref.number, url } };
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
  const item = ensureProjectItem(issue);

  if (options.confirm) {
    const result = spawnSync(
      'gh',
      [
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
      ],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) throw new Error(`${result.stderr || result.stdout}`.trim());
  }

  return {
    issue,
    status,
    projectItemId: item.id,
    optionId: option.id,
    applied: options.confirm ?? false,
    reason: options.reason ?? null,
  };
}
