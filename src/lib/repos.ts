import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const SpecialistSchema = z.object({
  name: z.string(),
  context: z.object({
    frameworks: z.array(z.string()).default([]),
    domains: z.array(z.string()).default([]),
    resources: z.array(z.string()).default([]),
  }),
});

const RepoSchema = z.object({
  id: z.string(),
  name: z.string(),
  github: z.string(),
  ssh_url: z.string(),
  local_path: z.string(),
  status: z.enum(['active', 'planned']),
  planned_by: z.string().optional(),
  owner: z.string(),
  description: z.string(),
  specialist: SpecialistSchema,
});

const RepoManifestSchema = z.object({
  version: z.number(),
  defaults: z.object({
    owner: z.string(),
    clone_protocol: z.string(),
    default_branch: z.string(),
    local_root: z.string(),
  }),
  repos: z.array(RepoSchema),
});

export type RepoEntry = z.infer<typeof RepoSchema>;
export type RepoManifest = z.infer<typeof RepoManifestSchema>;

export function loadRepoManifest(workspaceRoot: string): RepoManifest {
  const manifestPath = path.join(workspaceRoot, 'repos.yaml');
  const raw = readFileSync(manifestPath, 'utf8');
  return RepoManifestSchema.parse(YAML.parse(raw));
}

export function getRepoHealth(workspaceRoot: string, repo: RepoEntry) {
  const absolutePath = path.join(workspaceRoot, repo.local_path);
  return {
    ...repo,
    absolutePath,
    checkedOut: existsSync(path.join(absolutePath, '.git')),
  };
}
