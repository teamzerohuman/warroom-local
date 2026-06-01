import { existsSync } from 'node:fs';
import path from 'node:path';

function parentDirs(start: string) {
  const dirs: string[] = [];
  let current = path.resolve(start);

  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

export function isWarRoomWorkspace(candidate: string) {
  return existsSync(path.join(candidate, 'repos.yaml')) && existsSync(path.join(candidate, 'resources.yaml'));
}

// A War Room checkout always ships the manifest template, even before `warroom
// setup` has generated the project-specific `repos.yaml`. This lets `setup`
// (and `doctor`) run in a freshly cloned, not-yet-initialized workspace.
export function isWarRoomRoot(candidate: string) {
  return existsSync(path.join(candidate, 'repos.example.yaml')) || isWarRoomWorkspace(candidate);
}

export function findWarRoomRoot(start = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  const envRoot = env.WARROOM_ROOT;
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (!isWarRoomRoot(resolved)) {
      throw new Error(`WARROOM_ROOT does not point to a War Room checkout: ${resolved}`);
    }
    return resolved;
  }

  const resolvedStart = path.resolve(start);
  for (const dir of parentDirs(resolvedStart)) {
    if (isWarRoomRoot(dir)) return dir;
  }

  for (const dir of parentDirs(resolvedStart)) {
    const sibling = path.join(dir, 'warroom');
    if (isWarRoomRoot(sibling)) return sibling;
  }

  throw new Error('Could not find a War Room checkout. Run from War Room or set WARROOM_ROOT=/path/to/warroom.');
}

export function findWarRoomWorkspace(start = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  const envRoot = env.WARROOM_ROOT;
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (!isWarRoomWorkspace(resolved)) {
      throw new Error(`WARROOM_ROOT does not point to a War Room workspace: ${resolved}`);
    }
    return resolved;
  }

  const resolvedStart = path.resolve(start);
  for (const dir of parentDirs(resolvedStart)) {
    if (isWarRoomWorkspace(dir)) return dir;
  }

  for (const dir of parentDirs(resolvedStart)) {
    const sibling = path.join(dir, 'warroom');
    if (isWarRoomWorkspace(sibling)) return sibling;
  }

  throw new Error('Could not find War Room workspace. Run from War Room, a sibling child checkout, or set WARROOM_ROOT=/path/to/warroom.');
}
