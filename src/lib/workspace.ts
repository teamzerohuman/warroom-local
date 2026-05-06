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
