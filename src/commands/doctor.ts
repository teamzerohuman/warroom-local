import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadRepoManifest } from '../lib/repos.js';

const requiredFiles = [
  'AGENTS.md',
  'README.md',
  '.env.example',
  'repos.yaml',
  'resources.yaml',
  'maps/campaign-atlas.md',
  'maps/issue-territory.md',
];

export function runDoctor(workspaceRoot: string) {
  const files = requiredFiles.map((file) => ({
    file,
    exists: existsSync(path.join(workspaceRoot, file)),
  }));

  const manifest = loadRepoManifest(workspaceRoot);

  return {
    ok: files.every((file) => file.exists) && manifest.repos.length > 0,
    files,
    repoCount: manifest.repos.length,
    activeRepoCount: manifest.repos.filter((repo) => repo.status === 'active').length,
    plannedRepoCount: manifest.repos.filter((repo) => repo.status === 'planned').length,
  };
}
