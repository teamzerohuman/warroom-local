import { getRepoHealth, loadRepoManifest } from '../lib/repos.js';

export function runMapsStudy(workspaceRoot: string) {
  const manifest = loadRepoManifest(workspaceRoot);
  return manifest.repos.map((repo) => getRepoHealth(workspaceRoot, repo));
}
