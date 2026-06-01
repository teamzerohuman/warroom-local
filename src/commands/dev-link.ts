import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getProjectConfig, loadRepoManifest, type RepoEntry } from '../lib/repos.js';

// SDK-to-demo linking is opt-in: the npm scope and workspace package list come
// from repos.yaml `defaults` (npm_scope / dev_link_packages). Returns null when
// the project has not configured it, so `dev` commands degrade gracefully.
function getDevLinkConfig(workspaceRoot: string): { scope: string; packages: string[] } | null {
  const config = getProjectConfig(workspaceRoot);
  if (!config.npmScope || config.devLinkPackages.length === 0) return null;
  return { scope: config.npmScope, packages: config.devLinkPackages };
}

const STATE_FILE = path.join('.warroom', 'dev', 'sdk-demo-link.json');
const MIRROR_DIR = path.join('.warroom', 'dev', 'sdk-packages');

type RepoSource = 'manifest' | 'sibling' | 'missing';

export type RepoDevStatus = {
  id: string;
  github: string;
  configuredPath: string;
  resolvedPath: string;
  source: RepoSource;
  checkedOut: boolean;
  clean: boolean | null;
  statusLines: string[];
  packageManager: string | null;
  nodeModules: boolean;
};

export type PackageLinkStatus = {
  name: string;
  linkPath: string;
  targetPath: string;
  sdkPackagePath: string;
  mirrorPackageJsonExists: boolean;
  mirrorDistPath: string;
  mirrorDistTarget: string | null;
  mirrorDistLinked: boolean;
  buildOutputExists: boolean;
  exists: boolean;
  isSymlink: boolean;
  actualTarget: string | null;
  linked: boolean;
  staleMirror: boolean;
  legacyDirectLinked: boolean;
};

export type ToolStatus = {
  name: string;
  available: boolean;
  detail: string | null;
};

export type DevStatus = {
  sdk: RepoDevStatus;
  demo: RepoDevStatus;
  stateFile: string;
  stateExists: boolean;
  tools: ToolStatus[];
  packages: PackageLinkStatus[];
  linked: boolean;
  partiallyLinked: boolean;
  staleMirror: boolean;
  legacyDirectLinked: boolean;
  ready: boolean;
  recommended: {
    sdkWatch: string;
    demoDev: string;
    demoBuild: string;
    demoTypecheck: string;
    demoPlaywrightCore: string;
  };
};

type CommandResult = {
  command: string;
  args: string[];
  cwd: string;
  status: number | null;
};

export type DevActionResult = {
  status: DevStatus;
  commands: CommandResult[];
  messages: string[];
};

export type LinkOptions = {
  skipBuild?: boolean;
};

export type UnlinkOptions = {
  skipInstall?: boolean;
};

function absolutePath(workspaceRoot: string, maybeRelativePath: string) {
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.resolve(workspaceRoot, maybeRelativePath);
}

function isGitCheckout(repoPath: string) {
  return existsSync(path.join(repoPath, '.git'));
}

function getSiblingRepoPath(workspaceRoot: string, repo: RepoEntry) {
  return path.resolve(workspaceRoot, '..', repo.name);
}

function resolveRepo(workspaceRoot: string, repo: RepoEntry) {
  const configuredPath = absolutePath(workspaceRoot, repo.local_path);
  if (isGitCheckout(configuredPath)) {
    return { resolvedPath: configuredPath, source: 'manifest' as const };
  }

  const siblingPath = getSiblingRepoPath(workspaceRoot, repo);
  if (isGitCheckout(siblingPath)) {
    return { resolvedPath: siblingPath, source: 'sibling' as const };
  }

  return { resolvedPath: configuredPath, source: 'missing' as const };
}

function readPackageManager(repoPath: string) {
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (!existsSync(packageJsonPath)) return null;

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { packageManager?: unknown };
    return typeof packageJson.packageManager === 'string' ? packageJson.packageManager : null;
  } catch {
    return null;
  }
}

function getGitStatus(repoPath: string) {
  if (!isGitCheckout(repoPath)) {
    return { clean: null, statusLines: [] };
  }

  const result = spawnSync('git', ['status', '--short'], {
    cwd: repoPath,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    return { clean: null, statusLines: [`git status failed with exit ${result.status ?? 'unknown'}`] };
  }

  const statusLines = result.stdout.split(/\r?\n/).filter(Boolean);
  return { clean: statusLines.length === 0, statusLines };
}

function getRepoDevStatus(workspaceRoot: string, repo: RepoEntry): RepoDevStatus {
  const resolution = resolveRepo(workspaceRoot, repo);
  const git = getGitStatus(resolution.resolvedPath);

  return {
    id: repo.id,
    github: repo.github,
    configuredPath: absolutePath(workspaceRoot, repo.local_path),
    resolvedPath: resolution.resolvedPath,
    source: resolution.source,
    checkedOut: isGitCheckout(resolution.resolvedPath),
    clean: git.clean,
    statusLines: git.statusLines,
    packageManager: readPackageManager(resolution.resolvedPath),
    nodeModules: existsSync(path.join(resolution.resolvedPath, 'node_modules')),
  };
}

function safeRealpath(filePath: string) {
  try {
    return path.resolve(filePath);
  } catch {
    return null;
  }
}

function readSymlinkTarget(linkPath: string) {
  try {
    const rawTarget = readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), rawTarget);
  } catch {
    return null;
  }
}

function samePath(left: string | null, right: string) {
  if (!left) return false;
  return safeRealpath(left) === safeRealpath(right);
}

function pathEntryExists(filePath: string) {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function getPackageMirrorPath(workspaceRoot: string, packageName: string) {
  return path.join(workspaceRoot, MIRROR_DIR, packageName);
}

function getPackageLinkStatus(
  workspaceRoot: string,
  demoPath: string,
  sdkPath: string,
  scope: string,
  packageName: string
): PackageLinkStatus {
  const linkPath = path.join(demoPath, 'node_modules', scope, packageName);
  const sdkPackagePath = path.join(sdkPath, 'packages', packageName);
  const targetPath = getPackageMirrorPath(workspaceRoot, packageName);
  const mirrorPackageJsonExists = existsSync(path.join(targetPath, 'package.json'));
  const mirrorDistPath = path.join(targetPath, 'dist');
  const expectedMirrorDistTarget = path.join(sdkPackagePath, 'dist');
  const mirrorDistExists = pathEntryExists(mirrorDistPath);
  const mirrorDistIsSymlink = mirrorDistExists && lstatSync(mirrorDistPath).isSymbolicLink();
  const mirrorDistTarget = mirrorDistIsSymlink ? readSymlinkTarget(mirrorDistPath) : null;
  const mirrorDistLinked = mirrorDistIsSymlink && samePath(mirrorDistTarget, expectedMirrorDistTarget);
  const buildOutputExists = existsSync(path.join(sdkPackagePath, 'dist', 'index.mjs'));

  if (!pathEntryExists(linkPath)) {
    return {
      name: `${scope}/${packageName}`,
      linkPath,
      targetPath,
      sdkPackagePath,
      mirrorPackageJsonExists,
      mirrorDistPath,
      mirrorDistTarget,
      mirrorDistLinked,
      buildOutputExists,
      exists: false,
      isSymlink: false,
      actualTarget: null,
      linked: false,
      staleMirror: false,
      legacyDirectLinked: false,
    };
  }

  const stat = lstatSync(linkPath);
  const isSymlink = stat.isSymbolicLink();
  const actualTarget = isSymlink ? readSymlinkTarget(linkPath) : null;
  const pointsAtMirror = isSymlink && samePath(actualTarget, targetPath);

  return {
    name: `${scope}/${packageName}`,
    linkPath,
    targetPath,
    sdkPackagePath,
    mirrorPackageJsonExists,
    mirrorDistPath,
    mirrorDistTarget,
    mirrorDistLinked,
    buildOutputExists,
    exists: true,
    isSymlink,
    actualTarget,
    linked: pointsAtMirror && mirrorPackageJsonExists && mirrorDistLinked,
    staleMirror: pointsAtMirror && (!mirrorPackageJsonExists || !mirrorDistLinked),
    legacyDirectLinked: isSymlink && samePath(actualTarget, sdkPackagePath),
  };
}

function toolStatus(name: string, command: string, args: string[], cwd?: string): ToolStatus {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return {
    name,
    available: result.status === 0,
    detail: result.status === 0 ? output.split(/\r?\n/)[0] ?? null : output || null,
  };
}

function getRequiredRepo(workspaceRoot: string, id: string) {
  const manifest = loadRepoManifest(workspaceRoot);
  const repo = manifest.repos.find((entry) => entry.id === id);
  if (!repo) throw new Error(`repos.yaml does not define required repo "${id}".`);
  return repo;
}

// The SDK-to-demo dev link is optional: it needs npm_scope/dev_link_packages
// configured and both the `sdk` and `demo` repos mapped. Projects without it
// (the generic default) should not see dev-link errors.
export function isDevLinkAvailable(workspaceRoot: string): boolean {
  try {
    if (!getDevLinkConfig(workspaceRoot)) return false;
    const manifest = loadRepoManifest(workspaceRoot);
    return ['sdk', 'demo'].every((id) => manifest.repos.some((entry) => entry.id === id));
  } catch {
    return false;
  }
}

function getStateFilePath(workspaceRoot: string) {
  return path.join(workspaceRoot, STATE_FILE);
}

function getRecommendedCommands(sdkPath: string, demoPath: string) {
  return {
    sdkWatch: `cd ${sdkPath} && corepack pnpm dev`,
    demoDev: `cd ${demoPath} && corepack pnpm dev`,
    demoBuild: `cd ${demoPath} && corepack pnpm build`,
    demoTypecheck: `cd ${demoPath} && corepack pnpm typecheck`,
    demoPlaywrightCore: `cd ${demoPath} && corepack pnpm test:e2e:core`,
  };
}

export function runDevStatus(workspaceRoot: string): DevStatus {
  const sdk = getRepoDevStatus(workspaceRoot, getRequiredRepo(workspaceRoot, 'sdk'));
  const demo = getRepoDevStatus(workspaceRoot, getRequiredRepo(workspaceRoot, 'demo'));
  const devLink = getDevLinkConfig(workspaceRoot);
  const packages = (devLink?.packages ?? []).map((packageName) =>
    getPackageLinkStatus(workspaceRoot, demo.resolvedPath, sdk.resolvedPath, devLink!.scope, packageName)
  );
  const linkedCount = packages.filter((pkg) => pkg.linked).length;
  const staleMirrorCount = packages.filter((pkg) => pkg.staleMirror).length;
  const legacyDirectLinkedCount = packages.filter((pkg) => pkg.legacyDirectLinked).length;
  const tools = [
    toolStatus('corepack', 'corepack', ['--version']),
    toolStatus('pnpm', 'corepack', ['pnpm', '--version'], demo.resolvedPath),
  ];

  return {
    sdk,
    demo,
    stateFile: getStateFilePath(workspaceRoot),
    stateExists: existsSync(getStateFilePath(workspaceRoot)),
    tools,
    packages,
    linked: packages.length > 0 && linkedCount === packages.length,
    partiallyLinked: linkedCount > 0 && linkedCount < packages.length,
    staleMirror: staleMirrorCount > 0,
    legacyDirectLinked: legacyDirectLinkedCount > 0,
    ready: sdk.checkedOut && demo.checkedOut && demo.nodeModules && tools.every((tool) => tool.available),
    recommended: getRecommendedCommands(sdk.resolvedPath, demo.resolvedPath),
  };
}

function runOrThrow(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  });
  const commandResult = { command, args, cwd, status: result.status };

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd} with exit ${result.status ?? 'unknown'}.`);
  }

  return commandResult;
}

function assertReadyForLink(status: DevStatus) {
  if (!status.sdk.checkedOut) throw new Error(`SDK repo is missing at ${status.sdk.resolvedPath}.`);
  if (!status.demo.checkedOut) throw new Error(`Demo repo is missing at ${status.demo.resolvedPath}.`);
  if (!status.demo.nodeModules) {
    throw new Error(
      `Demo dependencies are not installed. Run "cd ${status.demo.resolvedPath} && corepack pnpm install" first.`
    );
  }
  for (const tool of status.tools) {
    if (!tool.available) throw new Error(`${tool.name} is not available: ${tool.detail ?? 'not found'}`);
  }
}

function ensureSdkPackagesExist(status: DevStatus) {
  for (const packageLink of status.packages) {
    const packageJsonPath = path.join(packageLink.sdkPackagePath, 'package.json');
    if (!existsSync(packageJsonPath)) {
      throw new Error(`Missing SDK package: ${packageJsonPath}`);
    }
  }
}

function ensureSdkPackageBuildOutputs(status: DevStatus) {
  for (const packageLink of status.packages) {
    if (!packageLink.buildOutputExists) {
      throw new Error(`Missing SDK package build output: ${path.join(packageLink.sdkPackagePath, 'dist', 'index.mjs')}`);
    }
  }
}

function readJsonFile(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function getWorkspacePackageVersions(status: DevStatus) {
  const versions = new Map<string, string>();
  for (const packageLink of status.packages) {
    const packageJson = readJsonFile(path.join(packageLink.sdkPackagePath, 'package.json'));
    if (typeof packageJson.name === 'string' && typeof packageJson.version === 'string') {
      versions.set(packageJson.name, packageJson.version);
    }
  }
  return versions;
}

function normalizeWorkspaceRanges(value: unknown, versions: Map<string, string>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const [name, range] of Object.entries(value)) {
    normalized[name] = range === 'workspace:*' && versions.has(name) ? versions.get(name) : range;
  }
  return normalized;
}

function writePackageMirror(packageLink: PackageLinkStatus, versions: Map<string, string>) {
  rmSync(packageLink.targetPath, { recursive: true, force: true });
  mkdirSync(packageLink.targetPath, { recursive: true });

  const packageJson = readJsonFile(path.join(packageLink.sdkPackagePath, 'package.json'));
  const mirrorPackageJson = {
    ...packageJson,
    dependencies: normalizeWorkspaceRanges(packageJson.dependencies, versions),
    optionalDependencies: normalizeWorkspaceRanges(packageJson.optionalDependencies, versions),
    peerDependencies: normalizeWorkspaceRanges(packageJson.peerDependencies, versions),
  };

  writeFileSync(path.join(packageLink.targetPath, 'package.json'), `${JSON.stringify(mirrorPackageJson, null, 2)}\n`);
  symlinkSync(path.join(packageLink.sdkPackagePath, 'dist'), path.join(packageLink.targetPath, 'dist'), 'dir');
}

export function linkSdkToDemo(workspaceRoot: string, options: LinkOptions = {}): DevActionResult {
  const before = runDevStatus(workspaceRoot);
  assertReadyForLink(before);
  ensureSdkPackagesExist(before);

  const commands: CommandResult[] = [];
  const messages: string[] = [];

  if (!options.skipBuild) {
    commands.push(runOrThrow('corepack', ['pnpm', 'run', 'build'], before.sdk.resolvedPath));
  }

  const afterBuild = runDevStatus(workspaceRoot);
  ensureSdkPackageBuildOutputs(afterBuild);
  const versions = getWorkspacePackageVersions(afterBuild);

  const devLink = getDevLinkConfig(workspaceRoot);
  if (!devLink) {
    throw new Error('SDK-to-demo linking is not configured. Set defaults.npm_scope and defaults.dev_link_packages in repos.yaml.');
  }
  const scopeDir = path.join(afterBuild.demo.resolvedPath, 'node_modules', devLink.scope);
  mkdirSync(scopeDir, { recursive: true });

  for (const packageLink of afterBuild.packages) {
    writePackageMirror(packageLink, versions);

    if (existsSync(packageLink.linkPath)) {
      const stat = lstatSync(packageLink.linkPath);
      if (!stat.isSymbolicLink()) {
        throw new Error(`Refusing to replace non-symlink path: ${packageLink.linkPath}`);
      }
      unlinkSync(packageLink.linkPath);
    }

    symlinkSync(packageLink.targetPath, packageLink.linkPath, 'dir');
    messages.push(`Linked ${packageLink.name} -> ${packageLink.targetPath}`);
  }

  mkdirSync(path.dirname(getStateFilePath(workspaceRoot)), { recursive: true });
  writeFileSync(
    getStateFilePath(workspaceRoot),
    `${JSON.stringify(
      {
        linkedAt: new Date().toISOString(),
        sdkPath: afterBuild.sdk.resolvedPath,
        demoPath: afterBuild.demo.resolvedPath,
        mirrorRoot: path.join(workspaceRoot, MIRROR_DIR),
        packages: afterBuild.packages.map((pkg) => pkg.name),
      },
      null,
      2
    )}\n`
  );

  const after = runDevStatus(workspaceRoot);
  return { status: after, commands, messages };
}

export function unlinkSdkFromDemo(workspaceRoot: string, options: UnlinkOptions = {}): DevActionResult {
  const before = runDevStatus(workspaceRoot);
  if (!before.demo.checkedOut) throw new Error(`Demo repo is missing at ${before.demo.resolvedPath}.`);

  const commands: CommandResult[] = [];
  const messages: string[] = [];

  for (const packageLink of before.packages) {
    if (!packageLink.exists) continue;
    if (!packageLink.isSymlink) {
      messages.push(`Skipped non-symlink ${packageLink.linkPath}`);
      continue;
    }
    if (!packageLink.linked && !packageLink.legacyDirectLinked) {
      messages.push(`Skipped symlink not owned by this dev link: ${packageLink.linkPath}`);
      continue;
    }

    unlinkSync(packageLink.linkPath);
    messages.push(`Removed ${packageLink.name} local link`);
  }

  if (!options.skipInstall) {
    commands.push(runOrThrow('corepack', ['pnpm', 'install', '--frozen-lockfile'], before.demo.resolvedPath));
  }

  const stateFile = getStateFilePath(workspaceRoot);
  if (existsSync(stateFile)) rmSync(stateFile);
  rmSync(path.join(workspaceRoot, MIRROR_DIR), { recursive: true, force: true });

  const after = runDevStatus(workspaceRoot);
  return { status: after, commands, messages };
}
