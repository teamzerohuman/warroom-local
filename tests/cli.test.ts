import { buildProgram } from '../src/cli.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { runAbort } from '../src/commands/abort.js';
import { runAlliesStatus } from '../src/commands/allies.js';
import { runBootstrap } from '../src/commands/bootstrap.js';
import { runCampaignStatusCheck } from '../src/commands/campaign.js';
import { runCommitCreate } from '../src/commands/commit-create.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runDevStatus } from '../src/commands/dev-link.js';
import { getAdapterInvocation, getEnvStatus } from '../src/lib/env.js';
import { runMapsAssign } from '../src/commands/maps-assign.js';
import { runMapsStudy } from '../src/commands/maps-study.js';
import { runSync } from '../src/commands/sync.js';

const workspaceRoot = new URL('..', import.meta.url).pathname;

describe('phase-1 CLI', () => {
  it('loads the repo map', () => {
    const repos = runMapsStudy(workspaceRoot);
    expect(repos.map((repo) => repo.id)).toEqual([
      'sdk',
      'backend',
      'infra',
      'demo',
      'docs',
      'dashboard',
      'landing',
    ]);
  });

  it('loads ally workspace status', () => {
    const result = runAlliesStatus(workspaceRoot);

    expect(result.ok).toBe(true);
    expect(result.allies.map((ally) => ally.id)).toEqual(['clicktech']);
    expect(result.allies[0]?.issue_repo.github).toBe('TeamFloPay/ally-clicktech');
    expect(result.allies[0]?.envExampleExists).toBe(true);
    expect(result.allies[0]?.labels.missing).toEqual([]);
  });

  it('passes the skeleton doctor check', () => {
    expect(runDoctor(workspaceRoot).ok).toBe(true);
  }, 30000);

  it('sees the Campaign Map status options', () => {
    const result = runCampaignStatusCheck();

    expect(result.missing).toEqual([]);
    expect(result.options.map((option) => option.name)).toEqual([
      'needs-triage',
      'ready-to-engage',
      'battlefield-active',
      'skirmish',
      'blockaded',
      'victory',
    ]);
  }, 30000);

  it('validates campaign atlas generation state', () => {
    const result = runMapsAssign(workspaceRoot, { check: true });

    expect(result.resourceReferencesOk).toBe(true);
    expect(result.atlasMatches).toBe(true);
  });

  it('prints maps study output', async () => {
    const lines: string[] = [];
    const program = buildProgram({ cwd: workspaceRoot, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'maps', 'study']);

    expect(lines.some((line) => line.includes('TeamFloPay/sdk'))).toBe(true);
    expect(lines.some((line) => line.includes('TeamFloPay/demo'))).toBe(true);
  });

  it('prints allies status output', async () => {
    const lines: string[] = [];
    const program = buildProgram({ cwd: workspaceRoot, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'allies', 'status']);

    expect(lines.some((line) => line.includes('Allies: ok'))).toBe(true);
    expect(lines.some((line) => line.includes('clicktech: active'))).toBe(true);
  });

  it('selects a ready issue and creates a PR engagement handoff', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = Readable.from(['1\n']);
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      await program.parseAsync(['node', 'warroom', 'issue', 'next']);

      expect(lines).toContain('Issues with Campaign status ready-to-engage: 1');
      expect(lines.some((line) => line.startsWith('1. TeamFloPay/sdk#7'))).toBe(true);
      expect(lines).toContain('Engaging TeamFloPay/sdk#7');
      expect(lines).toContain('PR engage: launched');
      expect(lines.some((line) => line.startsWith('Adapter: codex exec --cd '))).toBe(true);
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> battlefield-active');
      expect(lines.some((line) => line.includes('War Room implementation handoff for TeamFloPay/sdk#7'))).toBe(true);
      expect(lines.some((line) => line.includes('Title: Build the selector'))).toBe(true);
      expect(lines.some((line) => line.includes('Feature branch: warroom/7-build-the-selector'))).toBe(true);
      expect(lines.some((line) => line.includes('Do not stop after writing a plan'))).toBe(true);
      expect(lines.some((line) => line.includes('Triage complete: build the feature directly.'))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('can submit PR engagement through Codex Cloud adapter', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\nCODEX_CLOUD_ENV_SDK=env_fixture\n');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'engage', '--issue', 'TeamFloPay/sdk#7', '--launch', '--confirm-status']);

      expect(lines).toContain('Preparing implementation for TeamFloPay/sdk#7...');
      expect(lines).toContain('PR engage: launched');
      expect(lines.some((line) => line.includes('Adapter: codex cloud exec --env env_fixture <prompt>'))).toBe(true);
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> battlefield-active');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('lists open PRs for active and skirmish Campaign Map issues', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'review']);

      expect(lines[0]).toBe('Open PRs for Campaign statuses battlefield-active, skirmish: 2');
      expect(lines[1]).toContain('TeamFloPay/sdk#12 Review active SDK work');
      expect(lines[1]).toContain('updated 2026-05-06T12:00:00Z; issue TeamFloPay/sdk#8 battlefield-active');
      expect(lines[2]).toContain('TeamFloPay/demo#3 Review demo follow-up');
      expect(lines[2]).toContain('updated 2026-05-05T12:00:00Z; issue TeamFloPay/demo#9 skirmish');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('explains incomplete Codex Cloud setup when the environment id is missing', () => {
    const root = makeDevFixture();
    const home = path.join(root, 'home');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\n');
    writeFileSync(
      path.join(home, '.codex', '.codex-global-state.json'),
      JSON.stringify({ 'electron-persisted-atom-state': { codexCloudAccess: 'enabled_needs_setup' } })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const result = getEnvStatus(root);

      expect(result.notes.some((note) => note.includes('CODEX_CLOUD_ENV or repo-specific CODEX_CLOUD_ENV_<REPO_ID>'))).toBe(true);
      expect(result.notes.some((note) => note.includes('Codex Cloud is enabled but still needs setup'))).toBe(true);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('requires the owning repo Codex Cloud environment for mapped launches', () => {
    const root = makeDevFixture();
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\nCODEX_CLOUD_ENV_BACKEND=env_backend\n');

    expect(() => getAdapterInvocation(root, root, { repoId: 'sdk' })).toThrow(/CODEX_CLOUD_ENV_SDK is required/);
    expect(getAdapterInvocation(root, root, { repoId: 'backend' }).display).toContain('codex cloud exec --env env_backend <prompt>');
  });

  it('reports SDK-to-demo link state from sibling checkouts', () => {
    const root = makeDevFixture();

    const status = runDevStatus(root);

    expect(status.sdk.checkedOut).toBe(true);
    expect(status.sdk.source).toBe('sibling');
    expect(status.demo.checkedOut).toBe(true);
    expect(status.linked).toBe(true);
    expect(status.packages.map((pkg) => [pkg.name, pkg.linked])).toEqual([
      ['@flopay/shared', true],
      ['@flopay/js', true],
      ['@flopay/react', true],
      ['@flopay/node', true],
    ]);
  });

  it('prints dev status output', async () => {
    const root = makeDevFixture();
    const lines: string[] = [];
    const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'dev', 'status']);

    expect(lines.some((line) => line.includes('SDK-to-demo dev link: linked'))).toBe(true);
    expect(lines.some((line) => line.includes('Demo Playwright core:'))).toBe(true);
    expect(lines.some((line) => line.includes('NODE_OPTIONS=--preserve-symlinks'))).toBe(false);
  });

  it('previews bootstrap without cloning sibling checkouts', () => {
    const root = makeDevFixture();

    const result = runBootstrap(root, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.repos.map((repo) => repo.state)).toEqual(['sibling-present', 'sibling-present']);
  });

  it('reports sync state without mutating repos', () => {
    const root = makeDevFixture();

    const result = runSync(root, { report: true });

    expect(result.reportOnly).toBe(true);
    expect(result.repos).toHaveLength(2);
  });

  it('prints preservation-first abort recovery output', () => {
    const root = makeDevFixture();

    const result = runAbort(root);

    expect(result.mutated).toBe(false);
    expect(result.repos.map((repo) => repo.repo)).toEqual(['TeamFloPay/sdk', 'TeamFloPay/demo']);
  });

  it('preflights commit creation with validation artifacts', () => {
    const { root, sdk } = makeCommitFixture();
    mkdirSync(path.join(sdk, 'docs'), { recursive: true });
    writeFileSync(path.join(sdk, 'docs', 'note.md'), 'Commit notes.\n');

    const result = runCommitCreate(root, {
      repo: 'sdk',
      validate: ['node -e "console.log(42)"'],
      writeArtifact: true,
    });

    expect(result.blocked).toEqual([]);
    expect(result.committed).toBe(false);
    expect(result.suggestedMessage).toBe('docs(sdk): update war room workflow');
    expect(result.changes.map((change) => [change.path, change.unstaged])).toEqual([['docs/note.md', true]]);
    expect(result.validation).toHaveLength(1);
    expect(result.validation[0]?.ok).toBe(true);
    expect(result.validation[0]?.stdout).toBe('42');
    expect(result.artifact).toBeDefined();
    expect(existsSync(path.join(result.artifact!.runDir, 'summary.md'))).toBe(true);
    expect(readFileSync(path.join(result.artifact!.runDir, 'summary.md'), 'utf8')).toContain('ok node -e "console.log(42)"');
  });

  it('infers the commit repo when run from a mapped child checkout', async () => {
    const { sdk } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    const lines: string[] = [];
    const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'commit', 'create']);

    expect(lines).toContain('Commit create for sdk: preflight only');
    expect(lines).toContain(`Path: ${sdk}`);
    expect(lines).toContain('Suggested message: chore(sdk): update war room workflow');
    expect(lines).toContain('?? index.ts (unstaged)');
  });

  it('prompts for a full commit after the commit dry run in an interactive terminal', async () => {
    const { sdk, sdkRemote } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    const lines: string[] = [];
    const input = Readable.from(['yes\n']);
    const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line), input, interactive: true });

    await program.parseAsync(['node', 'warroom', 'commit', 'create', '--message', 'chore(sdk): save fixture']);

    expect(lines).toContain('Commit create for sdk: preflight only');
    expect(lines).toContain('Commit all listed changes and push to the remote branch now? This will run git add -A before committing. [y/N]');
    expect(lines).toContain('Creating commit and pushing...');
    expect(lines).toContain('Commit create for sdk: committed');
    expect(lines).toContain('Push: pushed git push -u origin HEAD');

    const log = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: sdk, encoding: 'utf8' });
    expect(log.stdout.trim()).toBe('chore(sdk): save fixture');

    const remoteLog = spawnSync('git', ['--git-dir', sdkRemote, 'log', '-1', '--pretty=%s', 'refs/heads/main'], { encoding: 'utf8' });
    expect(remoteLog.stdout.trim()).toBe('chore(sdk): save fixture');

    const status = spawnSync('git', ['status', '--short'], { cwd: sdk, encoding: 'utf8' });
    expect(status.stdout.trim()).toBe('');
  });

  it('reuses an existing backend before confirming PR merge e2e validation', async () => {
    const { root, demo } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);

    const backendPort = 39_151;
    const demoPort = 39_152;
    const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    const existingBackend = spawn('node', [path.join(root, 'existing-backend.mjs'), String(backendPort)], {
      stdio: 'ignore',
    });

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_BACKEND_BASE_URL',
      'WARROOM_MERGE_BACKEND_READY_URL',
      'WARROOM_MERGE_DEMO_BASE_URL',
      'WARROOM_MERGE_BACKEND_COMMAND',
      'WARROOM_MERGE_DEMO_E2E_COMMAND',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_BACKEND_BASE_URL = backendBaseUrl;
    process.env.WARROOM_MERGE_BACKEND_READY_URL = `${backendBaseUrl}/health`;
    process.env.WARROOM_MERGE_DEMO_BASE_URL = `http://127.0.0.1:${demoPort}`;
    process.env.WARROOM_MERGE_BACKEND_COMMAND = 'npm run start:api';
    process.env.WARROOM_MERGE_DEMO_E2E_COMMAND = 'npm run test:e2e';

    try {
      await waitForUrl(`${backendBaseUrl}/health`);

      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/backend#655', '--confirm']);

      expect(lines).toContain(`Demo Playwright e2e: checking backend readiness at ${backendBaseUrl}/health`);
      expect(lines).toContain(`Demo Playwright e2e: reusing existing backend at ${backendBaseUrl}/health`);
      expect(lines).toContain(`Demo Playwright e2e: running \`npm run test:e2e\` from ${demo}`);
      expect(lines).toContain('demo e2e passed');
      expect(lines.some((line) => line.startsWith('Demo Playwright e2e: finished with exit 0 after '))).toBe(true);
      expect(lines).toContain('Merge e2e: passed');
      expect(lines).toContain('Backend process: reused existing');
      expect(lines).toContain('Merged: yes');
      expect(existsSync(path.join(root, 'backend-started.txt'))).toBe(false);
      await expect(fetch(`${backendBaseUrl}/health`).then((response) => response.ok)).resolves.toBe(true);
    } finally {
      await stopChild(existingBackend);
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('reuses an existing local HTTPS backend with an untrusted local certificate', async () => {
    const { root, demo } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeFileSync(
      path.join(demo, 'e2e-no-backend-fetch.mjs'),
      "console.log('NODE_OPTIONS=' + (process.env.NODE_OPTIONS || ''));\nconsole.log('demo e2e passed');\n"
    );

    const healthServer = await startSelfSignedHealthServer();
    const backendBaseUrl = `https://127.0.0.1:${healthServer.port}`;

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_BACKEND_BASE_URL',
      'WARROOM_MERGE_BACKEND_READY_URL',
      'WARROOM_MERGE_BACKEND_ALLOW_INSECURE_LOCAL_TLS',
      'WARROOM_MERGE_BACKEND_STRICT_TLS',
      'WARROOM_MERGE_DEMO_E2E_COMMAND',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_BACKEND_BASE_URL = backendBaseUrl;
    process.env.WARROOM_MERGE_BACKEND_READY_URL = `${backendBaseUrl}/health`;
    process.env.WARROOM_MERGE_BACKEND_ALLOW_INSECURE_LOCAL_TLS = 'true';
    process.env.WARROOM_MERGE_BACKEND_STRICT_TLS = 'false';
    process.env.WARROOM_MERGE_DEMO_E2E_COMMAND = 'node e2e-no-backend-fetch.mjs';

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/backend#655', '--confirm']);

      expect(lines).toContain(`Demo Playwright e2e: checking backend readiness at ${backendBaseUrl}/health`);
      expect(lines).toContain(`Demo Playwright e2e: reusing existing backend at ${backendBaseUrl}/health`);
      expect(lines).toContain(`Demo Playwright e2e: enabling Node system CA trust for ${backendBaseUrl}`);
      expect(lines).toContain('NODE_OPTIONS=--use-system-ca');
      expect(lines).toContain('Backend process: reused existing');
      expect(lines).toContain('Merged: yes');
      expect(existsSync(path.join(root, 'backend-started.txt'))).toBe(false);
    } finally {
      await stopServer(healthServer.server);
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('skips demo Playwright e2e for repos without merge_playwright enabled', async () => {
    const { root } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/infra#655', '--confirm']);

      expect(lines).toContain('Merge e2e: skipped (repos.yaml has merge_playwright: false for TeamFloPay/infra.)');
      expect(lines).toContain('Merged: yes');
      expect(lines.some((line) => line.startsWith('Backend:'))).toBe(false);
      expect(existsSync(path.join(root, 'backend-started.txt'))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('adds a targeted diagnostic when backend startup fails on Sentry profiling native addon load', async () => {
    const { root } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeFileSync(
      path.join(root, 'fail-sentry-profiler.mjs'),
      `console.error('Error: dlopen sentry_cpu_profiler-darwin-arm64-137.node');\nconsole.error("code: 'ERR_DLOPEN_FAILED'");\nconsole.error('Node.js v24.14.0');\nprocess.exit(1);\n`
    );

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_BACKEND_BASE_URL',
      'WARROOM_MERGE_BACKEND_READY_URL',
      'WARROOM_MERGE_BACKEND_COMMAND',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_BACKEND_BASE_URL = 'http://127.0.0.1:39157';
    process.env.WARROOM_MERGE_BACKEND_READY_URL = 'http://127.0.0.1:39157/health';
    process.env.WARROOM_MERGE_BACKEND_COMMAND = 'node ../warroom/fail-sentry-profiler.mjs';

    try {
      const program = buildProgram({ cwd: root, output: () => undefined });

      await expect(
        program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/backend#655', '--confirm'])
      ).rejects.toThrow(/War Room diagnostic:[\s\S]*Sentry profiling native addon[\s\S]*Backend startup used v24\.14\.0/);
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('explains blocked PR merge readiness with actionable evidence', async () => {
    const { root } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeBlockedMergeGhFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/backend#655']);

      expect(lines).toContain('Merge readiness: blocked');
      expect(lines).toContain('blocked: Merge state is BLOCKED.');
      expect(lines).toContain(
        'why blocked: GitHub reports that the PR cannot be merged yet because at least one branch protection, ruleset, review, conversation, or required-status condition is not satisfied.'
      );
      expect(lines).toContain('evidence: Requested review still pending from: TeamFloPay/review.');
      expect(lines).toContain('evidence: Unresolved current review threads: 1.');
      expect(lines).toContain('evidence: All visible status checks returned by GitHub are passing.');
      expect(lines.some((line) => line.startsWith('resolve: Resolve the listed evidence first.'))).toBe(true);
      expect(lines).toContain('Requested reviewers: TeamFloPay/review');
      expect(lines).toContain(
        'review thread: DEVELOPMENT.md:27 by @coderabbitai (unresolved) https://github.com/TeamFloPay/backend/pull/655#discussion_r1'
      );
      expect(lines.some((line) => line.includes('- CodeRabbit: SUCCESS'))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('prompts to continue from PR merge preflight into the confirmed merge flow', async () => {
    const { root } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);

    const backendPort = 39_155;
    const demoPort = 39_156;
    const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    const existingBackend = spawn('node', [path.join(root, 'existing-backend.mjs'), String(backendPort)], {
      stdio: 'ignore',
    });

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_BACKEND_BASE_URL',
      'WARROOM_MERGE_BACKEND_READY_URL',
      'WARROOM_MERGE_DEMO_BASE_URL',
      'WARROOM_MERGE_BACKEND_COMMAND',
      'WARROOM_MERGE_DEMO_E2E_COMMAND',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_BACKEND_BASE_URL = backendBaseUrl;
    process.env.WARROOM_MERGE_BACKEND_READY_URL = `${backendBaseUrl}/health`;
    process.env.WARROOM_MERGE_DEMO_BASE_URL = `http://127.0.0.1:${demoPort}`;
    process.env.WARROOM_MERGE_BACKEND_COMMAND = 'npm run start:api';
    process.env.WARROOM_MERGE_DEMO_E2E_COMMAND = 'npm run test:e2e';

    try {
      await waitForUrl(`${backendBaseUrl}/health`);

      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['yes\n', 'no\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 500);
      try {
        await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/backend#655']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('PR merge: preflight only');
      expect(lines).toContain('Continue to run the demo Playwright e2e gate and merge this PR now? [y/N]');
      expect(lines).toContain('Running confirmed PR merge...');
      expect(lines).toContain('Merge e2e: passed');
      expect(lines).toContain('Backend process: reused existing');
      expect(lines).toContain('Merged: yes');
      expect(lines).toContain('Post victory summary comments now? [y/N]');
      expect(lines).toContain('Return the local checkout to the PR base branch now? [y/N]');
      expect(existsSync(path.join(root, 'backend-started.txt'))).toBe(false);
    } finally {
      await stopChild(existingBackend);
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30000);

  it('infers the current branch PR and prompts for merge follow-up actions', async () => {
    const { root, backend } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);

    const backendPort = 39_153;
    const demoPort = 39_154;
    const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    const existingBackend = spawn('node', [path.join(root, 'existing-backend.mjs'), String(backendPort)], {
      stdio: 'ignore',
    });

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_BACKEND_BASE_URL',
      'WARROOM_MERGE_BACKEND_READY_URL',
      'WARROOM_MERGE_DEMO_BASE_URL',
      'WARROOM_MERGE_BACKEND_COMMAND',
      'WARROOM_MERGE_DEMO_E2E_COMMAND',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_BACKEND_BASE_URL = backendBaseUrl;
    process.env.WARROOM_MERGE_BACKEND_READY_URL = `${backendBaseUrl}/health`;
    process.env.WARROOM_MERGE_DEMO_BASE_URL = `http://127.0.0.1:${demoPort}`;
    process.env.WARROOM_MERGE_BACKEND_COMMAND = 'npm run start:api';
    process.env.WARROOM_MERGE_DEMO_E2E_COMMAND = 'npm run test:e2e';

    try {
      await waitForUrl(`${backendBaseUrl}/health`);

      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: backend, output: (line) => lines.push(line), input, interactive: true });

      const promptAnswers = setInterval(() => input.write('yes\n'), 500);
      try {
        await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--confirm', '--issue', 'TeamFloPay/backend#562']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Resolved current branch PR: TeamFloPay/backend#655');
      expect(lines).toContain('Post victory summary comments now? [y/N]');
      expect(lines).toContain('Summary pr: posted TeamFloPay/backend#655 https://github.com/TeamFloPay/backend/pull/655#issuecomment-1');
      expect(lines).toContain('Summary issue: posted TeamFloPay/backend#562 https://github.com/TeamFloPay/backend/issues/562#issuecomment-2');
      expect(lines).toContain('Return the local checkout to the PR base branch now? [y/N]');
      expect(lines).toContain('Local cleanup: applied TeamFloPay/backend');

      const branch = spawnSync('git', ['branch', '--show-current'], { cwd: backend, encoding: 'utf8' });
      expect(branch.stdout.trim()).toBe('main');
    } finally {
      await stopChild(existingBackend);
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30000);

  it('blocks confirmed commit creation when changes are unstaged and --all is absent', () => {
    const { root, sdk } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    expect(() => runCommitCreate(root, { repo: 'sdk', confirm: true })).toThrow(/No staged changes/);
  });

  it('blocks commit creation when validation fails', () => {
    const { root, sdk } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    const result = runCommitCreate(root, { repo: 'sdk', validate: ['node -e "process.exit(7)"'] });

    expect(result.validation[0]?.ok).toBe(false);
    expect(result.validation[0]?.status).toBe(7);
    expect(result.blocked).toContain('Validation failed: node -e "process.exit(7)"');
  });
});

function makeDevFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'warroom-dev-'));
  const root = path.join(base, 'warroom');
  const sdk = path.join(base, 'sdk');
  const demo = path.join(base, 'demo');

  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, 'maps', 'repos'), { recursive: true });
  mkdirSync(path.join(sdk, '.git'), { recursive: true });
  mkdirSync(path.join(demo, '.git'), { recursive: true });
  mkdirSync(path.join(demo, 'node_modules', '@flopay'), { recursive: true });

  writeFileSync(
    path.join(root, 'repos.yaml'),
    `version: 1
defaults:
  owner: TeamFloPay
  clone_protocol: ssh
  default_branch: main
  local_root: maps/repos
repos:
  - id: sdk
    name: sdk
    github: TeamFloPay/sdk
    ssh_url: git@github.com:TeamFloPay/sdk.git
    local_path: maps/repos/sdk
    status: active
    owner: sdk
    description: SDK packages.
    specialist:
      name: SDK Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
  - id: demo
    name: demo
    github: TeamFloPay/demo
    ssh_url: git@github.com:TeamFloPay/demo.git
    local_path: maps/repos/demo
    status: active
    owner: demo
    description: Demo app.
    specialist:
      name: Demo Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
`
  );
  writeResourcesFixture(root);

  writeFileSync(path.join(sdk, 'package.json'), '{"packageManager":"pnpm@9.15.0"}\n');
  writeFileSync(path.join(demo, 'package.json'), '{"packageManager":"pnpm@9.15.0"}\n');

  for (const packageName of ['shared', 'js', 'react', 'node']) {
    const packagePath = path.join(sdk, 'packages', packageName);
    const mirrorPath = path.join(root, '.warroom', 'dev', 'sdk-packages', packageName);
    mkdirSync(path.join(packagePath, 'dist'), { recursive: true });
    mkdirSync(path.join(mirrorPath, 'dist'), { recursive: true });
    writeFileSync(path.join(packagePath, 'package.json'), `{"name":"@flopay/${packageName}"}\n`);
    writeFileSync(path.join(packagePath, 'dist', 'index.mjs'), '');
    writeFileSync(path.join(mirrorPath, 'package.json'), `{"name":"@flopay/${packageName}"}\n`);
    symlinkSync(mirrorPath, path.join(demo, 'node_modules', '@flopay', packageName), 'dir');
  }

  return root;
}

function makeCommitFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'warroom-commit-'));
  const root = path.join(base, 'warroom');
  const sdk = path.join(base, 'sdk');
  const demo = path.join(base, 'demo');
  const sdkRemote = path.join(base, 'sdk-remote.git');
  const demoRemote = path.join(base, 'demo-remote.git');

  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, 'maps', 'repos'), { recursive: true });
  initGitRepo(sdk);
  initGitRepo(demo);
  initBareRemote(sdkRemote);
  initBareRemote(demoRemote);
  spawnSync('git', ['remote', 'add', 'origin', sdkRemote], { cwd: sdk });
  spawnSync('git', ['remote', 'add', 'origin', demoRemote], { cwd: demo });

  writeFileSync(
    path.join(root, 'repos.yaml'),
    `version: 1
defaults:
  owner: TeamFloPay
  clone_protocol: ssh
  default_branch: main
  local_root: maps/repos
repos:
  - id: sdk
    name: sdk
    github: TeamFloPay/sdk
    ssh_url: git@github.com:TeamFloPay/sdk.git
    local_path: maps/repos/sdk
    status: active
    owner: sdk
    description: SDK packages.
    specialist:
      name: SDK Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
  - id: demo
    name: demo
    github: TeamFloPay/demo
    ssh_url: git@github.com:TeamFloPay/demo.git
    local_path: maps/repos/demo
    status: active
    owner: demo
    description: Demo app.
    specialist:
      name: Demo Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
`
  );
  writeResourcesFixture(root);

  return { root, sdk, demo, sdkRemote, demoRemote };
}

function makeMergeFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'warroom-merge-'));
  const root = path.join(base, 'warroom');
  const backend = path.join(base, 'backend');
  const demo = path.join(base, 'demo');

  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, 'maps', 'repos'), { recursive: true });
  initGitRepo(backend);
  initGitRepo(demo);

  writeFileSync(
    path.join(root, 'repos.yaml'),
    `version: 1
defaults:
  owner: TeamFloPay
  clone_protocol: ssh
  default_branch: main
  local_root: maps/repos
repos:
  - id: backend
    name: backend
    github: TeamFloPay/backend
    ssh_url: git@github.com:TeamFloPay/backend.git
    local_path: maps/repos/backend
    status: active
    merge_playwright: true
    owner: backend
    description: Backend.
    specialist:
      name: Backend Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
  - id: infra
    name: infra
    github: TeamFloPay/infra
    ssh_url: git@github.com:TeamFloPay/infra.git
    local_path: maps/repos/infra
    status: active
    merge_playwright: false
    owner: infra
    description: Infra.
    specialist:
      name: Infra Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
  - id: demo
    name: demo
    github: TeamFloPay/demo
    ssh_url: git@github.com:TeamFloPay/demo.git
    local_path: maps/repos/demo
    status: active
    merge_playwright: true
    owner: demo
    description: Demo.
    specialist:
      name: Demo Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
`
  );
  writeResourcesFixture(root);
  writeFileSync(
    path.join(root, 'existing-backend.mjs'),
    `import http from 'node:http';
const port = Number(process.argv[2]);
http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, source: 'existing' }));
    return;
  }
  response.writeHead(404);
  response.end();
}).listen(port, '127.0.0.1');
`
  );
  writeFileSync(
    path.join(backend, 'package.json'),
    JSON.stringify({ scripts: { 'start:api': 'node server.mjs' } }, null, 2)
  );
  writeFileSync(
    path.join(backend, 'server.mjs'),
    `import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
fs.writeFileSync(path.resolve('../warroom/backend-started.txt'), 'started');
const port = Number(process.env.APP_PORT || process.env.PORT || 3001);
http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, source: 'warroom-started' }));
    return;
  }
  response.writeHead(404);
  response.end();
}).listen(port, '127.0.0.1');
`
  );
  writeFileSync(
    path.join(demo, 'package.json'),
    JSON.stringify({ scripts: { 'test:e2e': 'node e2e.mjs' } }, null, 2)
  );
  writeFileSync(
    path.join(demo, 'e2e.mjs'),
    `const response = await fetch(process.env.BILLING_API_URL + '/health');
if (!response.ok) process.exit(1);
console.log('demo e2e passed');
`
  );
  commitAll(backend, 'fixture backend');
  commitAll(demo, 'fixture demo');
  const branch = spawnSync('git', ['switch', '-c', 'feature/backend'], { cwd: backend, encoding: 'utf8' });
  if (branch.status !== 0) throw new Error(branch.stderr);

  return { root, backend, demo };
}

async function waitForUrl(url: string, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

async function startSelfSignedHealthServer() {
  const server = https.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, port: address.port };
}

async function stopServer(server: https.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCaBJyKDLYh3x/4
nsTvRnTnLJJ3MpFo2iDKw7j7IBFUm3EqbUCfG/ZQ0ZNu3RyZ6awaq1u7RwxZ22k8
PC9TmQVVgcqwV+CSOC2P6BXEnpBaqchCE3sY4twhe5DAWmqAbDzvJwXUdis9Lh8O
JdlcLNcIYHWowBpL1R5RmHb9lf14RrJb/U6jj9SHCXO6wZb8pk8LomUnliOGqVrL
a1/n+TwQdCBKClOtsudYGeZ7Pyg3olHmBCJhyQpd7BZd85oYOUaJqxnUYv8/Vuc3
gBt142bN/0TeN+DGdfZvmR5n1FDND8hGCEgZGVWMLs/O40cCVyInlyY4N1bos2Xz
KjuFyGWhAgMBAAECggEAEZP+qLvYKqf8TmQSfmuYaoz5/2wwT9r7XKD3cwPfLnya
Lxkug6pNk75DmSbXvZI/kACoNMjgVj4WNed5kE054F8ymqtA6HdMbezzVRAy0gIo
JrBx/25e6NxhMi7vkk4oKzRVNEEzYKVrqnHz65L7jMtzikm4hpihf/cKd5k/h1M+
xNoHMOocNOWxS8X7m5dCk1rXJERaCKRMUfhaU9LrOESYAov5NPWxG5UD0r5jd+7P
mdj8YVR4oxO5aDyApryIn9G/9yLzCEjU/W2OCbn4fws1wZWppzjnyIUpYeQR5QKn
o47R81W9juOdzVzta1fCTUZAaDVx/qm4nmR6pvCONQKBgQDZHw8Nu91Sqb4d6JZU
HU2nWSK8jHWtHgdBqOKHR03/Jag+FML4atsVCImRFukT4mKSPka+iZuZ66q/LM16
XLYSv2SwqBW4499m2dGy3VmIQR3X6FidduIAuHl46VrLOpvUbSjnsdQGoNIf7YzS
DrgFO+tbADYOsaNEZLMUQo13VQKBgQC1mN4zQD7/86oMYdsxtKmrliVAXidkOf1A
Tj5Tmmw+daGHP5b9uXSxYoMZmWnCsZA6tV4DHsgfpW+fdgOjBdX/x9ULoSJki4Hc
yJ46wgl2vj6ANfz/OQELrqeV/Oxfo37kHygSXzidO2Sajuw+pKx7UpYHUg5MSvU4
UkAd6chdHQKBgCxC2J7EHWoskEUolPywvJPQ5/Pn7lVMOc54zzUkpBHPa2y8bsKV
hfPTubeKJBmZnN6TM3jENKQ8FqLCT2ESZUuNGMmqekMmsPQWk1kTJp1QKPVKuEXh
ZlEfSiQL7iZf3ESBvET/S2nOfwdjNcHcnkby4Be9A0gbjlzy6k7HAm/BAoGAXn2l
mPtkDKCIKhs9B/celibxSTX0v0UhTrWn3q6qhjGFFC/1bB505twApXBbRLBKARJg
UbVRoo3dsBajO8+Mk6QyafO1RqYEs5I8KwzOCdhiAyqUc2UA80g08WmCwRz8qMzB
eBXOCppd9cJKkSn0idLmN/btc6tJP74kmKwN0s0CgYEAp0FbiigCIEWcL5+qBMz9
52cZvE0lupqkUyAnwTIqTPrMLfNmLUJf3hLAdGzYjW8Jmikm3CugM2DXp8KBqxJb
UOxDcFuammE2McUjvXNv7FUlkI7z4zbfvSW1/GtmkGONdmQTZaFPJZ4wzu8ut9HH
d3WpXpQMQeY57krsO3mmvDg=
-----END PRIVATE KEY-----`;

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDPTCCAiWgAwIBAgIUMeFhCVKoLqaAKnJ3WGiBkm9ZfHIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDUwNjA5MTkzMFoXDTM2MDUw
MzA5MTkzMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAmgScigy2Id8f+J7E70Z05yySdzKRaNogysO4+yARVJtx
Km1Anxv2UNGTbt0cmemsGqtbu0cMWdtpPDwvU5kFVYHKsFfgkjgtj+gVxJ6QWqnI
QhN7GOLcIXuQwFpqgGw87ycF1HYrPS4fDiXZXCzXCGB1qMAaS9UeUZh2/ZX9eEay
W/1Oo4/UhwlzusGW/KZPC6JlJ5Yjhqlay2tf5/k8EHQgSgpTrbLnWBnmez8oN6JR
5gQiYckKXewWXfOaGDlGiasZ1GL/P1bnN4AbdeNmzf9E3jfgxnX2b5keZ9RQzQ/I
RghIGRlVjC7PzuNHAlciJ5cmODdW6LNl8yo7hchloQIDAQABo4GGMIGDMB0GA1Ud
DgQWBBR/kOh23/VTRpr/caZlCEnAuytWnTAfBgNVHSMEGDAWgBR/kOh23/VTRpr/
caZlCEnAuytWnTAPBgNVHRMBAf8EBTADAQH/MDAGA1UdEQQpMCeCCWxvY2FsaG9z
dIcEfwAAAYIUYXBpLmxvY2FsLmZsb3BheS5jb20wDQYJKoZIhvcNAQELBQADggEB
AGOXABngUr+gqIDNmOd//NjP7LVPldntvuXLJ/Y4yi4/RT28ID0O5H3iC3tGeuBd
4LfnsKQ3RovN3nnhfzeEREmEnFq1H6I/WXDoMcMyf8qkIwVPrsfRd8iheggHUboG
Wb2cMG14vkxr193sGC22N4Ci1W88oc+R+7ctu3MdLbCh5m77sDtX7SIvGAY/oBq0
xIMxw/CNN7F4/pwTW/KhCuRvraSJb6tnQe9AviEljxpvquFksvJtzTF3i94hQZJy
M6KzmHVx2Qfw2nEV52AGxmCnup8i/lwnMso1NrrBIP6z+pHUJ9I6PT3SlFaXByFY
s8TKot2uBRmTisxTbLDjtMc=
-----END CERTIFICATE-----`;

function initGitRepo(repoPath: string) {
  mkdirSync(repoPath, { recursive: true });
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: repoPath, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr);
  spawnSync('git', ['config', 'user.email', 'warroom@example.com'], { cwd: repoPath });
  spawnSync('git', ['config', 'user.name', 'War Room'], { cwd: repoPath });
}

function commitAll(repoPath: string, message: string) {
  const add = spawnSync('git', ['add', '-A'], { cwd: repoPath, encoding: 'utf8' });
  if (add.status !== 0) throw new Error(add.stderr);
  const commit = spawnSync('git', ['commit', '-m', message], { cwd: repoPath, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(commit.stderr);
}

function initBareRemote(repoPath: string) {
  const init = spawnSync('git', ['init', '--bare', repoPath], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr);
}

function writeResourcesFixture(root: string) {
  writeFileSync(
    path.join(root, 'resources.yaml'),
    `version: 1
resources:
  - id: github-cli
    type: cli
    name: GitHub CLI
    description: Fixture GitHub CLI resource.
  - id: typescript-docs
    type: docs
    name: TypeScript Documentation
    description: Fixture TypeScript docs resource.
`
  );
}

function writeGhFixture(bin: string) {
  const ghPath = path.join(bin, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);

function json(value) {
  process.stdout.write(JSON.stringify(value));
}

if (args[0] === 'project' && args[1] === 'item-list') {
  json({
    items: [
      {
        id: 'PVTI_ready',
        title: 'Build the selector',
        status: 'ready-to-engage',
        labels: ['ready-to-engage'],
        content: {
          repository: 'TeamFloPay/sdk',
          number: 7,
          title: 'Build the selector',
          url: 'https://github.com/TeamFloPay/sdk/issues/7'
        }
      },
      {
        id: 'PVTI_active',
        title: 'Active SDK work',
        status: 'battlefield-active',
        labels: ['battlefield-active'],
        content: {
          repository: 'TeamFloPay/sdk',
          number: 8,
          title: 'Active SDK work',
          type: 'Issue',
          url: 'https://github.com/TeamFloPay/sdk/issues/8'
        }
      },
      {
        id: 'PVTI_skirmish',
        title: 'Demo follow-up',
        status: 'skirmish',
        labels: ['skirmish'],
        content: {
          repository: 'TeamFloPay/demo',
          number: 9,
          title: 'Demo follow-up',
          type: 'Issue',
          url: 'https://github.com/TeamFloPay/demo/issues/9'
        }
      }
    ]
  });
  process.exit(0);
}

function valueFor(name) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-f' && args[index] !== '-F') continue;
    const [key, value] = args[index + 1].split('=');
    if (key === name) return value;
  }
}

function prNode(repo, number, title, updatedAt, state = 'OPEN') {
  return {
    __typename: 'PullRequest',
    number,
    title,
    url: 'https://github.com/' + repo + '/pull/' + number,
    state,
    updatedAt,
    repository: { nameWithOwner: repo }
  };
}

if (args[0] === 'api' && args[1] === 'graphql') {
  const repo = valueFor('repo');
  const number = Number(valueFor('number'));
  const fullRepo = 'TeamFloPay/' + repo;
  const activePr = prNode('TeamFloPay/sdk', 12, 'Review active SDK work', '2026-05-06T12:00:00Z');
  const closedPr = prNode('TeamFloPay/sdk', 13, 'Closed SDK work', '2026-05-07T12:00:00Z', 'CLOSED');
  const demoPr = prNode('TeamFloPay/demo', 3, 'Review demo follow-up', '2026-05-05T12:00:00Z');

  if (fullRepo === 'TeamFloPay/sdk' && number === 8) {
    json({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: { nodes: [activePr] },
            timelineItems: {
              nodes: [
                { source: activePr },
                { source: closedPr }
              ]
            }
          }
        }
      }
    });
    process.exit(0);
  }

  if (fullRepo === 'TeamFloPay/demo' && number === 9) {
    json({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: { nodes: [] },
            timelineItems: {
              nodes: [
                { subject: demoPr }
              ]
            }
          }
        }
      }
    });
    process.exit(0);
  }

  json({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } } } } });
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  json({
    title: 'Build the selector',
    body: 'Allow operators to pick a ready issue and start PR engagement.',
    url: 'https://github.com/TeamFloPay/sdk/issues/7',
    comments: [
      {
        author: { login: 'andrewslack' },
        body: 'Triage complete: build the feature directly.',
        createdAt: '2026-05-05T00:00:00Z'
      }
    ]
  });
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'view') {
  json({
    title: 'Ready backend PR',
    url: 'https://github.com/TeamFloPay/backend/pull/655',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    headRefName: 'feature/backend',
    baseRefName: 'main',
    isDraft: false,
    statusCheckRollup: [
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }
    ]
  });
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'list') {
  json([
    {
      number: 655,
      title: 'Ready backend PR',
      url: 'https://github.com/TeamFloPay/backend/pull/655',
      headRefName: 'feature/backend'
    }
  ]);
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'comment') {
  process.stdout.write('https://github.com/TeamFloPay/backend/pull/655#issuecomment-1');
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'comment') {
  process.stdout.write('https://github.com/TeamFloPay/backend/issues/562#issuecomment-2');
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'merge') {
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'view') {
  json({ id: 'PVT_campaign', title: 'Campaign Map' });
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'field-list') {
  json({
    fields: [
      {
        id: 'PVTSSF_status',
        name: 'Status',
        type: 'ProjectV2SingleSelectField',
        options: [
          { id: 'status_needs', name: 'needs-triage' },
          { id: 'status_ready', name: 'ready-to-engage' },
          { id: 'status_active', name: 'battlefield-active' },
          { id: 'status_skirmish', name: 'skirmish' },
          { id: 'status_blockaded', name: 'blockaded' },
          { id: 'status_victory', name: 'victory' }
        ]
      }
    ]
  });
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'item-edit') {
  process.exit(0);
}

console.error('Unexpected gh fixture call: ' + args.join(' '));
process.exit(1);
`
  );
  chmodSync(ghPath, 0o755);
}

function writeBlockedMergeGhFixture(bin: string) {
  const ghPath = path.join(bin, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);

function json(value) {
  process.stdout.write(JSON.stringify(value));
}

if (args[0] === 'pr' && args[1] === 'view') {
  json({
    title: 'Blocked backend PR',
    url: 'https://github.com/TeamFloPay/backend/pull/655',
    mergeStateStatus: 'BLOCKED',
    mergeable: 'MERGEABLE',
    reviewDecision: '',
    headRefName: 'feature/backend',
    baseRefName: 'main',
    isDraft: false,
    reviewRequests: [
      { __typename: 'Team', name: 'Review', slug: 'TeamFloPay/review' }
    ],
    latestReviews: [
      {
        author: { login: 'coderabbitai' },
        state: 'COMMENTED',
        submittedAt: '2026-05-06T07:58:39Z'
      }
    ],
    statusCheckRollup: [
      {
        name: 'Analyze (javascript-typescript)',
        workflowName: 'CodeQL',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/TeamFloPay/backend/actions/runs/1'
      },
      {
        context: 'CodeRabbit',
        state: 'SUCCESS',
        targetUrl: 'https://github.com/TeamFloPay/backend/pull/655#coderabbit'
      }
    ]
  });
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  json({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                isResolved: false,
                isOutdated: false,
                comments: {
                  nodes: [
                    {
                      path: 'DEVELOPMENT.md',
                      line: 27,
                      url: 'https://github.com/TeamFloPay/backend/pull/655#discussion_r1',
                      body: 'Add exactly one trailing newline character at the end of DEVELOPMENT.md.',
                      author: { login: 'coderabbitai' }
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    }
  });
  process.exit(0);
}

process.exit(1);
`
  );
  chmodSync(ghPath, 0o755);
}

function writeCodexFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === 'cloud' && args[1] === 'exec' && args[2] === '--env' && args[3]) {
  if (!args[4]) {
    console.error('missing prompt');
    process.exit(1);
  }
  console.log('submitted cloud task');
  process.exit(0);
}

process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`
  );
  chmodSync(codexPath, 0o755);
}
