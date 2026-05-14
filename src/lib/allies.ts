import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { z } from 'zod';
import { absolutePath, getGitStatus, isGitCheckout } from './repos.js';
import { CAMPAIGN_LABELS } from './campaign.js';

const AllyIssueRepoSchema = z.object({
  github: z.string(),
  local_path: z.string(),
  sync: z.enum(['unito']),
  client_system: z.string(),
});

const AllyEnvSchema = z.object({
  example: z.string(),
  local: z.string(),
});

const AllyCommsSchema = z.object({
  type: z.literal('slack'),
  channels: z.array(z.string()),
});

const AllySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['active', 'planned']),
  local_path: z.string(),
  issue_repo: AllyIssueRepoSchema,
  env: AllyEnvSchema,
  docs: z.array(z.string()).default([]),
  comms: z.array(AllyCommsSchema).optional(),
});

const AlliesManifestSchema = z.object({
  version: z.number(),
  allies: z.array(AllySchema),
});

export type AllyEntry = z.infer<typeof AllySchema>;
export type AlliesManifest = z.infer<typeof AlliesManifestSchema>;

export type AllyHealth = AllyEntry & {
  localPath: string;
  localPathExists: boolean;
  envExamplePath: string;
  envExampleExists: boolean;
  envLocalPath: string;
  envLocalExists: boolean;
  issueRepoPath: string;
  issueRepoCheckedOut: boolean;
  issueRepoClean: boolean | null;
  issueRepoStatusLines: string[];
  docsStatus: Array<{ path: string; exists: boolean }>;
  labels: {
    checked: boolean;
    expected: Array<{ name: string; color: string; description: string }>;
    missing: string[];
    error: string | null;
  };
  sharedDocsOk: boolean;
  structuralOk: boolean;
};

export type AllyIssueRepoResolution = {
  ally: AllyEntry;
  issueRepoPath: string;
  issueRepoCheckedOut: boolean;
};

export function loadAlliesManifest(workspaceRoot: string): AlliesManifest {
  const manifestPath = path.join(workspaceRoot, 'allies.yaml');
  const raw = readFileSync(manifestPath, 'utf8');
  return AlliesManifestSchema.parse(YAML.parse(raw));
}

export function resolveAllyIssueRepo(workspaceRoot: string, githubRepo: string): AllyIssueRepoResolution | null {
  let manifest: AlliesManifest;
  try {
    manifest = loadAlliesManifest(workspaceRoot);
  } catch {
    return null;
  }

  const ally = manifest.allies.find((entry) => entry.issue_repo.github === githubRepo);
  if (!ally) return null;

  const issueRepoPath = absolutePath(workspaceRoot, ally.issue_repo.local_path);
  return {
    ally,
    issueRepoPath,
    issueRepoCheckedOut: isGitCheckout(issueRepoPath),
  };
}

function expectedLabels(ally: AllyEntry) {
  return [
    ...CAMPAIGN_LABELS,
    { name: 'ally', color: '0E8A16', description: 'Enterprise ally/client issue.' },
    { name: ally.id, color: '5319E7', description: `${ally.name} ally workspace issue.` },
  ];
}

function checkAllyLabels(ally: AllyEntry) {
  const expected = expectedLabels(ally);
  const result = spawnSync('gh', ['label', 'list', '--repo', ally.issue_repo.github, '--json', 'name', '--limit', '100'], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    return {
      checked: false,
      expected,
      missing: expected.map((label) => label.name),
      error: `${result.stderr || result.stdout}`.trim() || 'Could not list ally issue repo labels.',
    };
  }

  try {
    const labels = JSON.parse(result.stdout || '[]') as Array<{ name?: string }>;
    const existing = new Set(labels.map((label) => label.name).filter(Boolean));
    return {
      checked: true,
      expected,
      missing: expected.filter((label) => !existing.has(label.name)).map((label) => label.name),
      error: null,
    };
  } catch {
    return {
      checked: false,
      expected,
      missing: expected.map((label) => label.name),
      error: 'Could not parse ally issue repo label list output.',
    };
  }
}

export function getAllyHealth(workspaceRoot: string, ally: AllyEntry): AllyHealth {
  const localPath = absolutePath(workspaceRoot, ally.local_path);
  const envExamplePath = absolutePath(workspaceRoot, ally.env.example);
  const envLocalPath = absolutePath(workspaceRoot, ally.env.local);
  const issueRepoPath = absolutePath(workspaceRoot, ally.issue_repo.local_path);
  const docsStatus = ally.docs.map((docPath) => ({
    path: absolutePath(workspaceRoot, docPath),
    exists: existsSync(absolutePath(workspaceRoot, docPath)),
  }));
  const issueRepoStatus = getGitStatus(issueRepoPath);
  const sharedDocsOk = docsStatus.every((doc) => doc.exists);
  const localPathExists = existsSync(localPath);
  const envExampleExists = existsSync(envExamplePath);
  const labels = checkAllyLabels(ally);

  return {
    ...ally,
    localPath,
    localPathExists,
    envExamplePath,
    envExampleExists,
    envLocalPath,
    envLocalExists: existsSync(envLocalPath),
    issueRepoPath,
    issueRepoCheckedOut: isGitCheckout(issueRepoPath),
    issueRepoClean: issueRepoStatus.clean,
    issueRepoStatusLines: issueRepoStatus.statusLines,
    docsStatus,
    labels,
    sharedDocsOk,
    structuralOk: localPathExists && envExampleExists && sharedDocsOk && labels.checked && labels.missing.length === 0,
  };
}
