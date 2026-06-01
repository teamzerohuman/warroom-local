import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadRepoManifest } from '../lib/repos.js';
import { loadResourcesManifest } from '../lib/resources.js';
import { generateCampaignAtlas, atlasPath, readExistingAtlas } from '../lib/atlas.js';
import { isWarRoomWorkspace } from '../lib/workspace.js';

// Project-specific files that the shared War Room ships only as `*.example`
// templates. `warroom setup` scaffolds the real file from its template so a
// freshly cloned War Room becomes a usable workspace without leaking project
// config upstream.
export const SCAFFOLD_TARGETS = [
  { target: 'repos.yaml', example: 'repos.example.yaml', required: true },
  { target: 'allies.yaml', example: 'allies.example.yaml', required: false },
  { target: '.env.local', example: '.env.local.example', required: false },
  { target: 'maps/issue-territory.md', example: 'maps/issue-territory.example.md', required: false },
] as const;

export type ScaffoldAction = {
  target: string;
  example: string;
  state: 'created' | 'exists' | 'no-template' | 'failed';
  detail?: string;
};

export type SetupResult = {
  workspaceRoot: string;
  initializedBefore: boolean;
  scaffolded: ScaffoldAction[];
  atlas: { state: 'written' | 'skipped' | 'failed'; detail?: string };
  ok: boolean;
};

export type SetupOptions = {
  // Overwrite existing files from their templates instead of leaving them.
  force?: boolean;
  // Limit scaffolding to these targets (defaults to all SCAFFOLD_TARGETS).
  only?: string[];
  // Regenerate maps/campaign-atlas.md from repos.yaml after scaffolding.
  regenerateAtlas?: boolean;
};

export function scaffoldFromExample(workspaceRoot: string, target: string, example: string, force = false): ScaffoldAction {
  const targetPath = path.join(workspaceRoot, target);
  const examplePath = path.join(workspaceRoot, example);

  if (existsSync(targetPath) && !force) {
    return { target, example, state: 'exists', detail: 'left unchanged' };
  }
  if (!existsSync(examplePath)) {
    return { target, example, state: 'no-template', detail: `missing template ${example}` };
  }

  try {
    copyFileSync(examplePath, targetPath);
    return { target, example, state: 'created', detail: force && existsSync(targetPath) ? 'overwritten from template' : 'created from template' };
  } catch (error) {
    return { target, example, state: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

export function regenerateAtlas(workspaceRoot: string): SetupResult['atlas'] {
  if (!existsSync(path.join(workspaceRoot, 'repos.yaml')) || !existsSync(path.join(workspaceRoot, 'resources.yaml'))) {
    return { state: 'skipped', detail: 'repos.yaml and resources.yaml required to generate the atlas' };
  }
  try {
    const manifest = loadRepoManifest(workspaceRoot);
    const resources = loadResourcesManifest(workspaceRoot);
    const content = generateCampaignAtlas(manifest, resources, readExistingAtlas(workspaceRoot));
    writeFileSync(atlasPath(workspaceRoot), content);
    return { state: 'written' };
  } catch (error) {
    return { state: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

export function runSetup(workspaceRoot: string, options: SetupOptions = {}): SetupResult {
  const initializedBefore = isWarRoomWorkspace(workspaceRoot);
  const only = options.only;
  const targets = only ? SCAFFOLD_TARGETS.filter((entry) => only.includes(entry.target)) : SCAFFOLD_TARGETS;

  const scaffolded = targets.map((entry) => scaffoldFromExample(workspaceRoot, entry.target, entry.example, options.force));

  const atlas = options.regenerateAtlas
    ? regenerateAtlas(workspaceRoot)
    : { state: 'skipped' as const, detail: 'pass --atlas to regenerate' };

  const requiredOk = targets
    .filter((entry) => entry.required)
    .every((entry) => {
      const action = scaffolded.find((scaffold) => scaffold.target === entry.target);
      return action ? action.state === 'created' || action.state === 'exists' : true;
    });

  return {
    workspaceRoot,
    initializedBefore,
    scaffolded,
    atlas,
    ok: requiredOk && scaffolded.every((action) => action.state !== 'failed') && atlas.state !== 'failed',
  };
}

// ---- Interactive repo-manifest building -----------------------------------
// Plain (untransformed) manifest shapes, written directly as YAML so the
// generated repos.yaml mirrors repos.example.yaml. After writing we re-parse
// via loadRepoManifest to validate against the zod schema.

export type RepoDefaultsInput = {
  owner: string;
  clone_protocol: 'ssh' | 'https';
  default_branch: string;
  local_root: string;
};

export type RepoInput = {
  id: string;
  name?: string;
  github?: string;
  status?: 'active' | 'planned';
  description?: string;
  sergeant?: string;
  frameworks?: string[];
  domains?: string[];
  resources?: string[];
  playwright?: boolean;
};

function sshUrlFor(github: string, protocol: 'ssh' | 'https') {
  return protocol === 'https' ? `https://github.com/${github}.git` : `git@github.com:${github}.git`;
}

export function buildRepoEntry(defaults: RepoDefaultsInput, input: RepoInput) {
  const github = input.github ?? `${defaults.owner}/${input.id}`;
  const name = input.name ?? input.id;
  return {
    id: input.id,
    name,
    github,
    ssh_url: sshUrlFor(github, defaults.clone_protocol),
    local_path: `${defaults.local_root}/${input.id}`,
    status: input.status ?? 'active',
    merge: {
      playwright: input.playwright ?? false,
      bump: false,
      changelog: false,
    },
    owner: input.id,
    description: input.description ?? `${name} repository.`,
    specialist: {
      name: input.sergeant ?? `${name} Sergeant`,
      context: {
        frameworks: input.frameworks ?? [],
        domains: input.domains ?? [],
        resources: input.resources ?? ['github-cli'],
      },
    },
  };
}

export function buildRepoManifest(defaults: RepoDefaultsInput, repos: RepoInput[]) {
  return {
    version: 1,
    defaults,
    repos: repos.map((repo) => buildRepoEntry(defaults, repo)),
  };
}

// Writes the manifest as YAML and validates it parses. Throws on invalid input.
// On validation failure, restores any previous repos.yaml (or removes it if
// none existed) so a broken manifest is never persisted on disk.
export function writeRepoManifestFromInputs(workspaceRoot: string, defaults: RepoDefaultsInput, repos: RepoInput[]) {
  const manifest = buildRepoManifest(defaults, repos);
  const manifestPath = path.join(workspaceRoot, 'repos.yaml');
  const previous = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
  writeFileSync(manifestPath, YAML.stringify(manifest));
  try {
    loadRepoManifest(workspaceRoot);
  } catch (error) {
    if (previous === null) {
      try {
        unlinkSync(manifestPath);
      } catch {
        // ignore rollback cleanup error
      }
    } else {
      writeFileSync(manifestPath, previous);
    }
    throw error;
  }
  return manifest;
}

export function readManifestDefaults(workspaceRoot: string, exampleFallback = true): RepoDefaultsInput | null {
  const candidates = [path.join(workspaceRoot, 'repos.yaml')];
  if (exampleFallback) candidates.push(path.join(workspaceRoot, 'repos.example.yaml'));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = YAML.parse(readFileSync(candidate, 'utf8')) as { defaults?: RepoDefaultsInput };
      if (parsed?.defaults) return parsed.defaults;
    } catch {
      // try next candidate
    }
  }
  return null;
}
