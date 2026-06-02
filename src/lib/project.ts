import { spawnSync } from 'node:child_process';
import { CAMPAIGN_STATUSES } from './campaign.js';

// Thin, injectable wrapper around the `gh` CLI so the project-board helpers can
// be unit-tested with a recording runner instead of a real GitHub account.
export type GhRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: GhRunner = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const STATUS_FIELD_NAME = 'Status';
const SINGLE_SELECT_TYPE = 'ProjectV2SingleSelectField';

// The six Campaign Map board states, in order. Sourced from CAMPAIGN_STATUSES so
// the board this command creates always matches what `campaign status-check`
// validates and what the workflow commands move issues between.
export const CAMPAIGN_STATUS_NAMES = CAMPAIGN_STATUSES.map((status) => status.name);

export type CampaignProject = {
  number: number;
  id: string;
  url: string;
  title: string;
};

export type StatusFieldResult = {
  fieldId: string;
  /** A brand-new field was created (no prior Status field existed). */
  created: boolean;
  /** An existing Status field with the wrong options was deleted and recreated. */
  replaced: boolean;
};

type ProjectField = {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; name: string }>;
};

function ghJson<T>(runner: GhRunner, args: string[]): T {
  const result = runner(args);
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  if (!result.stdout.trim()) {
    throw new Error(`gh ${args.join(' ')} returned no output.`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`gh ${args.join(' ')} returned non-JSON output: ${result.stdout.trim()}`);
  }
}

// Creates a brand-new GitHub Project (ProjectV2) under the given owner and
// returns its number/id/url. The owner may be an org login or `@me`.
export function createCampaignProject(owner: string, title: string, runner: GhRunner = defaultRunner): CampaignProject {
  const created = ghJson<{ number?: number; id?: string; url?: string; title?: string }>(runner, [
    'project',
    'create',
    '--owner',
    owner,
    '--title',
    title,
    '--format',
    'json',
  ]);
  if (typeof created.number !== 'number' || !created.id) {
    throw new Error(`gh project create did not return a usable project (got ${JSON.stringify(created)}).`);
  }
  return {
    number: created.number,
    id: created.id,
    url: created.url ?? `https://github.com/orgs/${owner}/projects/${created.number}`,
    title: created.title ?? title,
  };
}

// Looks up an existing project by owner + number, returning null when it does
// not exist or is inaccessible. Used by the `project link` (use-existing) path.
export function viewCampaignProject(owner: string, projectNumber: number, runner: GhRunner = defaultRunner): CampaignProject | null {
  const result = runner(['project', 'view', String(projectNumber), '--owner', owner, '--format', 'json']);
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const project = JSON.parse(result.stdout) as { number?: number; id?: string; url?: string; title?: string };
    if (typeof project.number !== 'number' || !project.id) return null;
    return {
      number: project.number,
      id: project.id,
      url: project.url ?? `https://github.com/orgs/${owner}/projects/${project.number}`,
      title: project.title ?? '',
    };
  } catch {
    return null;
  }
}

function findStatusField(owner: string, projectNumber: number, runner: GhRunner): ProjectField | null {
  const fields = ghJson<{ fields?: ProjectField[] }>(runner, [
    'project',
    'field-list',
    String(projectNumber),
    '--owner',
    owner,
    '--format',
    'json',
  ]);
  return fields.fields?.find((field) => field.name === STATUS_FIELD_NAME && field.type === SINGLE_SELECT_TYPE) ?? null;
}

function optionsMatchCampaign(field: ProjectField): boolean {
  const names = (field.options ?? []).map((option) => option.name);
  return (
    names.length === CAMPAIGN_STATUS_NAMES.length &&
    CAMPAIGN_STATUS_NAMES.every((name, index) => names[index] === name)
  );
}

// Ensures the project's single-select `Status` field carries exactly the six
// Campaign Map states in order. A freshly created GitHub Project ships with a
// default Status field (Todo/In Progress/Done); when its options do not match we
// delete it and recreate it so `campaign status-check` passes. Idempotent: a
// field that already matches is left untouched.
export function configureCampaignStatusField(
  owner: string,
  projectNumber: number,
  runner: GhRunner = defaultRunner
): StatusFieldResult {
  const existing = findStatusField(owner, projectNumber, runner);

  if (existing && optionsMatchCampaign(existing)) {
    return { fieldId: existing.id, created: false, replaced: false };
  }

  let replaced = false;
  if (existing) {
    const deleted = runner(['project', 'field-delete', '--id', existing.id, '--format', 'json']);
    if (deleted.status !== 0) {
      throw new Error(`gh project field-delete failed: ${(deleted.stderr || deleted.stdout || '').trim()}`);
    }
    replaced = true;
  }

  const created = ghJson<{ id?: string }>(runner, [
    'project',
    'field-create',
    String(projectNumber),
    '--owner',
    owner,
    '--name',
    STATUS_FIELD_NAME,
    '--data-type',
    'SINGLE_SELECT',
    '--single-select-options',
    CAMPAIGN_STATUS_NAMES.join(','),
    '--format',
    'json',
  ]);
  if (!created.id) {
    throw new Error(`gh project field-create did not return a field id (got ${JSON.stringify(created)}).`);
  }

  return { fieldId: created.id, created: !replaced, replaced };
}
