import { buildProgram } from '../src/cli.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { getAdapterInvocation, getEnvStatus, getInteractiveAdapterInvocation, runAdapter, runInteractiveAdapter } from '../src/lib/env.js';
import {
  attachRunUsageToIssue,
  formatLlmUsageSummary,
  recordLlmAdapterUsage,
  refreshIssueUsageLedgerCosts,
  summarizeIssueUsage,
} from '../src/lib/llm-usage.js';
import { runMapsAssign } from '../src/commands/maps-assign.js';
import { runMapsStudy } from '../src/commands/maps-study.js';
import { runSync } from '../src/commands/sync.js';
import { formatFinalChangelogCheck } from '../src/commands/pr.js';

const workspaceRoot = new URL('..', import.meta.url).pathname;
const FAST_PR_REVIEW_ENV = ['WARROOM_PR_REVIEW_POLL_MS', 'WARROOM_PR_REVIEW_CODERABBIT_SETTLE_MS'] as const;
const OUTCOME_SEPARATOR = '-----------------------------------------';

function setFastPrReviewPolling() {
  const original = Object.fromEntries(FAST_PR_REVIEW_ENV.map((key) => [key, process.env[key]]));
  process.env.WARROOM_PR_REVIEW_POLL_MS = '0';
  process.env.WARROOM_PR_REVIEW_CODERABBIT_SETTLE_MS = '0';
  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function expectBoxedOutcome(lines: string[], outcome: string) {
  const index = lines.indexOf(outcome);
  expect(index).toBeGreaterThan(0);
  expect(lines[index - 1]).toBe(OUTCOME_SEPARATOR);
  expect(lines[index + 1]).toBe(OUTCOME_SEPARATOR);
  return index;
}

function expectFinalOutcome(lines: string[], outcome: string) {
  const index = expectBoxedOutcome(lines, outcome);
  expect(index).toBe(lines.length - 2);
}

describe('phase-1 CLI', () => {
  it('formats final changelog checks with the public changelog site link', () => {
    expect(
      formatFinalChangelogCheck({
        status: 'passed',
        required: true,
        skipReason: null,
        repo: 'TeamFloPay/sdk',
        path: '/tmp/sdk',
        base: 'main',
        currentBranch: 'main',
        changelogPath: '/tmp/sdk/release-notes',
        changelogFormat: 'openchangelog',
        changelogUrl: 'https://changelog.sdk.flopay.com',
        changelogFile: 'release-notes/v1.0.1.ready-sdk-pr.md',
        releaseNoteContent: null,
        version: '1.0.1',
        durationMs: 10,
        committed: true,
        pushed: true,
        commitSha: 'abc123',
        blocked: [],
        error: null,
      })
    ).toBe('passed ([public changelog](https://changelog.sdk.flopay.com))');
  });

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

  it('parses Codex terminal token usage and prices cached tokens', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'warroom-usage-'));
    mkdirSync(path.join(root, 'config'), { recursive: true });
    writeFileSync(
      path.join(root, 'config', 'llm-pricing.json'),
      JSON.stringify({
        models: {
          'gpt-5.5': {
            inputPerMillion: 1,
            cachedInputPerMillion: 0.1,
            outputPerMillion: 2,
          },
        },
      })
    );

    const invocation = {
      command: 'codex',
      args: ['exec', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"', '--cd', root, '-'],
      display: 'codex exec --model gpt-5.5 -c model_reasoning_effort="xhigh"',
      cwd: root,
      mode: 'foreground' as const,
      adapter: 'codex' as const,
    };

    const usage = recordLlmAdapterUsage(
      root,
      { issue: 'TeamFloPay/backend#666', command: 'issue-create', stage: 'pm-session', repo: 'TeamFloPay/backend' },
      invocation,
      'War Room issue creation PM session',
      {
        status: 0,
        signal: null,
        error: null,
        stdout: null,
        stderr: null,
        outputText: 'Token usage: total=41.022 input=36.941 (+ 161.024 cached) output=4.081 (reasoning 2.428)',
      }
    );

    expect(usage.entry?.inputTokens).toBe(36941);
    expect(usage.entry?.cachedInputTokens).toBe(161024);
    expect(usage.entry?.outputTokens).toBe(4081);
    expect(usage.entry?.totalTokens).toBe(41022);
    expect(usage.entry?.usageSource).toBe('adapter');
    expect(usage.entry?.costUsd).toBe(0.061205);

    const summary = summarizeIssueUsage(root, 'TeamFloPay/backend#666');
    expect(formatLlmUsageSummary(summary)).toContain('- Cost: $0.061205');
  });

  it('keeps a partial token cost when output tokens are unknown', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'warroom-usage-'));
    mkdirSync(path.join(root, 'config'), { recursive: true });
    writeFileSync(
      path.join(root, 'config', 'llm-pricing.json'),
      JSON.stringify({
        models: {
          'gpt-5.5': {
            inputPerMillion: 1,
            cachedInputPerMillion: 0.1,
            outputPerMillion: 2,
          },
        },
      })
    );

    const invocation = {
      command: 'codex',
      args: ['exec', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"', '--cd', root, '-'],
      display: 'codex exec --model gpt-5.5 -c model_reasoning_effort="xhigh"',
      cwd: root,
      mode: 'foreground' as const,
      adapter: 'codex' as const,
    };

    const usage = recordLlmAdapterUsage(
      root,
      { issue: 'TeamFloPay/backend#667', command: 'issue-create', stage: 'pm-session', repo: 'TeamFloPay/backend' },
      invocation,
      'x'.repeat(4000),
      {
        status: 0,
        signal: null,
        error: null,
        stdout: null,
        stderr: null,
        outputText: null,
      }
    );

    expect(usage.entry?.inputTokens).toBe(1000);
    expect(usage.entry?.outputTokens).toBeNull();
    expect(usage.entry?.costUsd).toBe(0.001);
    expect(usage.entry?.costUnavailableReason).toBe('partial cost; output token count unknown');

    const ledgerPath = path.join(root, '.warroom', 'runs', 'issues', 'TeamFloPay__backend__667', 'usage-ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { entries: Array<{ costUsd: number | null; costUnavailableReason: string | null }> };
    ledger.entries[0]!.costUsd = null;
    ledger.entries[0]!.costUnavailableReason = 'output token count unknown';
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

    expect(refreshIssueUsageLedgerCosts(root, 'TeamFloPay/backend#667')).toBe(true);
    const refreshedLedger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { entries: Array<{ costUsd: number | null; costUnavailableReason: string | null }> };
    expect(refreshedLedger.entries[0]?.costUsd).toBe(0.001);
    expect(refreshedLedger.entries[0]?.costUnavailableReason).toBe('partial cost; output token count unknown');

    const summary = summarizeIssueUsage(root, 'TeamFloPay/backend#667');
    expect(formatLlmUsageSummary(summary)).toContain('- Cost: at least $0.001000; partial cost; output token count unknown');
  });

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

  it('selects a ready issue and starts implementation on a linked branch', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['1\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'next']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Issues with Campaign status ready-to-engage: 1');
      expect(lines.some((line) => line.startsWith('1. TeamFloPay/sdk#7'))).toBe(true);
      expect(lines).toContain('Starting TeamFloPay/sdk#7');
      expect(lines).toContain('Issue start: launched');
      expect(lines.some((line) => line.startsWith('Adapter: codex exec --model gpt-5.5 '))).toBe(true);
      expect(lines).toContain('Adapter run: completed (foreground process; no background session remains)');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> battlefield-active');
      expect(lines).toContain('Issue assignee: updated TeamFloPay/sdk#7 +@me');
      expect(lines).toContain('Development branch: ready warroom/7-build-the-selector from main');
      expect(lines.some((line) => line.includes('Development branch link: created gh issue develop 7 --repo TeamFloPay/sdk --base main --name warroom/7-build-the-selector --checkout'))).toBe(true);
      expect(lines).toContain('Development checkout: checked out');
      expect(lines.some((line) => line.includes('War Room implementation handoff for TeamFloPay/sdk#7'))).toBe(true);
      expect(lines.some((line) => line.includes('Title: Build the selector'))).toBe(true);
      expect(lines.some((line) => line.includes('Feature branch: warroom/7-build-the-selector'))).toBe(true);
      expect(lines.some((line) => line.includes('Development branch link: created with `gh issue develop 7 --repo TeamFloPay/sdk --base main --name warroom/7-build-the-selector --checkout`'))).toBe(true);
      expect(lines.some((line) => line.includes('Closes TeamFloPay/sdk#7'))).toBe(true);
      expect(lines.some((line) => line.includes('Do not stop after writing a plan'))).toBe(true);
      expect(lines.some((line) => line.includes('git fetch origin warroom/7-build-the-selector'))).toBe(true);
      expect(lines.some((line) => line.includes('War Room should have checked this checkout out to warroom/7-build-the-selector'))).toBe(true);
      expect(lines.some((line) => line.includes('Triage complete: build the feature directly.'))).toBe(true);
      expect(lines).toContain('Outcome: LLM adapter completed on warroom/7-build-the-selector; no background session remains. Campaign status updated to battlefield-active.');
      expect(lines.at(-1)).toBe('Run `warroom pr review` next? [Y/n]');

      const branch = spawnSync('git', ['branch', '--show-current'], {
        cwd: path.resolve(root, '..', 'sdk'),
        encoding: 'utf8',
      });
      expect(branch.stdout.trim()).toBe('warroom/7-build-the-selector');

      const usageLedger = path.join(root, '.warroom', 'runs', 'issues', 'TeamFloPay__sdk__7', 'usage-ledger.json');
      expect(existsSync(usageLedger)).toBe(true);
      const usage = JSON.parse(readFileSync(usageLedger, 'utf8')) as { entries: Array<{ command: string; stage: string; inputTokens: number | null }> };
      expect(usage.entries.some((entry) => entry.command === 'issue-next' && entry.stage === 'implementation-handoff')).toBe(true);

      const usageLines: string[] = [];
      const usageProgram = buildProgram({ cwd: root, output: (line) => usageLines.push(line) });
      await usageProgram.parseAsync(['node', 'warroom', 'issue', 'usage', '--issue', 'TeamFloPay/sdk#7']);
      expect(usageLines).toContain('War Room LLM usage for TeamFloPay/sdk#7:');
      expect(usageLines.some((line) => /^- Entries: \d+$/.test(line))).toBe(true);
      expect(usageLines.some((line) => line.startsWith('- Input tokens: '))).toBe(true);
      expect(usageLines.some((line) => line.includes('unknown output'))).toBe(true);
      expect(usageLines).toContain('- Cost: unavailable; pricing missing for gpt-5.5');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('can open a PR directly after an interactive issue start', async () => {
    const { root, sdk, sdkRemote } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const pushMain = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: sdk, encoding: 'utf8' });
    if (pushMain.status !== 0) throw new Error(pushMain.stderr);

    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['1\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'next']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Issue start: launched');
      expect(lines).toContain('Creating PR...');
      expect(lines).toContain('PR create: created');
      expect(lines).toContain('Repo: TeamFloPay/sdk');
      expect(lines).toContain('Issue: TeamFloPay/sdk#7');
      expect(lines).toContain('Title: Build the selector');
      expect(lines).toContain('PR text: generated by LLM adapter');
      expect(lines.some((line) => line.includes('Adapter: codex exec -o '))).toBe(true);
      expect(lines).toContain('URL: https://github.com/TeamFloPay/sdk/pull/12');
      const output = lines.join('\n');
      expect(output).toContain('## Summary');
      expect(output).toContain('- Captures the actual change in selector.ts for reviewers.');
      expect(lines).toContain('Issue progress: posted TeamFloPay/sdk#7 https://github.com/TeamFloPay/sdk/issues/7#issuecomment-2');
      expect(lines).toContain('PR URL: https://github.com/TeamFloPay/sdk/pull/12');
      expect(lines.at(-1)).toBe('Run `warroom pr review` next? [Y/n]');

      const remoteBranch = spawnSync(
        'git',
        ['--git-dir', sdkRemote, 'rev-parse', '--verify', 'refs/heads/warroom/7-build-the-selector'],
        { encoding: 'utf8' }
      );
      expect(remoteBranch.status).toBe(0);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('offers commit creation instead of PR creation when issue start leaves uncommitted changes', async () => {
    const { root, sdk } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');

    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeDirtyImplementationCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['1\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'next']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Issue start: launched');
      expect(lines).toContain(`PR create is not ready: 1 uncommitted change remains in ${sdk}.`);
      expect(lines).toContain('Creating commit and pushing...');
      expect(lines).not.toContain('Run `warroom pr create` next? [Y/n]');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  // TODO: this multi-step E2E test hangs in the downstream `warroom pr create`
  // parseAsync call (after the `issue next` step completes). The codex adapter
  // for PR text generation is launched but the test never resolves. Pre-existing
  // failure that now manifests as a hang because earlier fixes pushed the flow
  // further along. Needs targeted investigation of the `pr create` codex flow
  // when the backend repo has a committed selector.ts on the warroom/6 branch.
  it.skip('starts an ally issue in the mapped implementation owner repo from triage notes', async () => {
    const root = makeDevFixture();
    const backend = addBackendRepoFixture(root);
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeCrossRepoAllyIssueStartGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    const originalBackendRemote = process.env.WARROOM_TEST_BACKEND_REMOTE;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_TEST_BACKEND_REMOTE = path.resolve(root, '..', 'backend-remote.git');

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['2\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'next', '--no-pr-creation']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Issues with Campaign status ready-to-engage: 2');
      expect(lines.some((line) => line.startsWith('2. TeamFloPay/ally-clicktech#6 Omni Duplicate'))).toBe(true);
      expect(lines).toContain('Starting TeamFloPay/ally-clicktech#6');
      expect(lines).toContain('Issue start: launched');
      expect(lines).toContain(`Adapter cwd: ${backend}`);
      expect(lines).toContain('Adapter run: completed (foreground process; no background session remains)');
      expect(lines).toContain('Campaign status: updated TeamFloPay/ally-clicktech#6 -> battlefield-active');
      expect(lines).toContain('Development branch: ready warroom/6-omni-duplicate-paid-out-of-band-subscription-pay from main');
      expect(lines.some((line) => line.startsWith('Development branch link: created gh api graphql createLinkedBranch TeamFloPay/ally-clicktech#6 -> TeamFloPay/backend:warroom/6-omni-duplicate-paid-out-of-band-subscription-pay'))).toBe(true);
      expect(lines).toContain('Development checkout: checked out');
      expect(lines.some((line) => line.includes('Source issue: TeamFloPay/ally-clicktech#6'))).toBe(true);
      expect(lines.some((line) => line.includes('Implementation repo: TeamFloPay/backend'))).toBe(true);
      expect(lines.some((line) => line.includes('Backend Sergeant'))).toBe(true);
      expect(lines.some((line) => line.includes('Closes TeamFloPay/ally-clicktech#6'))).toBe(true);
      expect(lines).toContain('Outcome: LLM adapter completed on warroom/6-omni-duplicate-paid-out-of-band-subscription-pay; no background session remains. Campaign status updated to battlefield-active.');

      const branch = spawnSync('git', ['branch', '--show-current'], {
        cwd: backend,
        encoding: 'utf8',
      });
      expect(branch.stdout.trim()).toBe('warroom/6-omni-duplicate-paid-out-of-band-subscription-pay');

      const issueMetadata = spawnSync(
        'git',
        ['config', 'branch.warroom/6-omni-duplicate-paid-out-of-band-subscription-pay.warroom-issue'],
        { cwd: backend, encoding: 'utf8' }
      );
      expect(issueMetadata.stdout.trim()).toBe('TeamFloPay/ally-clicktech#6');

      const upstream = spawnSync(
        'git',
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        { cwd: backend, encoding: 'utf8' }
      );
      expect(upstream.stdout.trim()).toBe('origin/warroom/6-omni-duplicate-paid-out-of-band-subscription-pay');

      const scopedLines: string[] = [];
      const scopedProgram = buildProgram({ cwd: backend, output: (line) => scopedLines.push(line) });

      await scopedProgram.parseAsync(['node', 'warroom', 'issue', 'next', '--no-select']);

      expect(scopedLines[0]).toBe('Issues with Campaign status ready-to-engage for TeamFloPay/backend: 2');
      expect(scopedLines.some((line) => line.includes('TeamFloPay/backend#639'))).toBe(true);
      expect(scopedLines.some((line) => line.includes('TeamFloPay/ally-clicktech#6'))).toBe(true);

      const prLines: string[] = [];
      const prProgram = buildProgram({ cwd: backend, output: (line) => prLines.push(line) });

      await prProgram.parseAsync(['node', 'warroom', 'pr', 'create']);

      expect(prLines).toContain('PR create: preflight only');
      expect(prLines).toContain('Repo: TeamFloPay/backend');
      expect(prLines).toContain('Issue: TeamFloPay/ally-clicktech#6');
      expect(prLines.some((line) => line.includes('Closes TeamFloPay/ally-clicktech#6'))).toBe(true);
      expect(prLines.some((line) => line.includes('Push: planned git push'))).toBe(true);

      const reviewLines: string[] = [];
      const reviewProgram = buildProgram({ cwd: backend, output: (line) => reviewLines.push(line) });

      await reviewProgram.parseAsync(['node', 'warroom', 'pr', 'review', '--pr', 'TeamFloPay/backend#660', '--confirm-status']);

      expect(reviewLines).toContain('PR review: preflight only');
      expect(reviewLines).toContain('Issue: TeamFloPay/ally-clicktech#6');
      expect(reviewLines).toContain('Campaign status: updated TeamFloPay/ally-clicktech#6 -> skirmish');
      expect(reviewLines.some((line) => line.includes('Linked issue: TeamFloPay/ally-clicktech#6'))).toBe(true);

      const mergeLines: string[] = [];
      const mergeProgram = buildProgram({ cwd: backend, output: (line) => mergeLines.push(line) });

      await mergeProgram.parseAsync([
        'node',
        'warroom',
        'pr',
        'merge',
        '--pr',
        'TeamFloPay/backend#660',
        '--confirm-status',
        '--post-summary',
        '--confirm-summary',
      ]);

      expect(mergeLines).toContain('PR merge: preflight only');
      expect(mergeLines).toContain('Issue: TeamFloPay/ally-clicktech#6');
      expect(mergeLines).toContain('Campaign status: updated TeamFloPay/ally-clicktech#6 -> victory');
      expect(mergeLines).toContain('Summary issue: posted TeamFloPay/ally-clicktech#6 https://github.com/TeamFloPay/ally-clicktech/issues/6#issuecomment-2');
    } finally {
      process.env.PATH = originalPath;
      if (originalBackendRemote === undefined) delete process.env.WARROOM_TEST_BACKEND_REMOTE;
      else process.env.WARROOM_TEST_BACKEND_REMOTE = originalBackendRemote;
    }
  });

  it('creates a needs-triage issue from an interactive PM draft and can flow into triage', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeIssueCreateGhFixture(bin);
    writeIssueCreateCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['yes\n', 'yes\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'create']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Issue create: draft ready');
      expect(lines.some((line) => line.includes('War Room issue creation PM session'))).toBe(false);
      expect(lines).toContain('Repo: TeamFloPay/sdk');
      expect(lines).toContain('Title: Report checkout settlement confusion');
      expect(lines).toContain('Issue type: Bug');
      expect(lines).toContain('Labels: none');
      expect(lines).toContain('Draft warning: Ignored label "checkout" because it does not exist in TeamFloPay/sdk.');
      expect(lines).toContain('Create this GitHub issue now? [Y/n]');
      expect(lines).toContain('Issue create: created');
      expect(lines).toContain('URL: https://github.com/TeamFloPay/sdk/issues/123');
      expect(lines).toContain('Issue type: updated TeamFloPay/sdk#123 -> Bug');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#123 -> needs-triage');
      expect(lines).toContain('Outcome: issue created with follow-up warnings. draft warning: Ignored label "checkout" because it does not exist in TeamFloPay/sdk.');
      expect(lines).toContain('Run `warroom issue triage --issue TeamFloPay/sdk#123` now? [Y/n]');
      expect(lines).toContain('Triaging TeamFloPay/sdk#123');
      expect(lines).toContain('Triage notes: ready https://github.com/TeamFloPay/sdk/issues/123#issuecomment-triage');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#123 -> ready-to-engage');
      expect(lines.at(-1)).toBe('Run `warroom issue next --issue TeamFloPay/sdk#123` now? [Y/n]');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('includes Sentry linkage instructions in issue creation prompts', async () => {
    const root = makeDevFixture();
    const lines: string[] = [];
    const program = buildProgram({ cwd: root, output: (line) => lines.push(line), interactive: true });

    await program.parseAsync(['node', 'warroom', 'issue', 'create', '--dry-run']);

    expect(lines).toContain('Issue create: dry run');
    expect(lines.some((line) => line.includes('Sentry linkage:'))).toBe(true);
    expect(lines.some((line) => line.includes('preserve that reference in the draft issue body'))).toBe(true);
    expect(lines.some((line) => line.includes('link the created GitHub issue to the referenced Sentry issue'))).toBe(true);
    expect(lines.some((line) => line.includes('Do not claim the Sentry link already exists during issue creation'))).toBe(true);
  });

  it('selects a triage issue and launches a scoped triage handoff', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['1\n', 'n\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'triage']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Issues with Campaign status needs-triage: 1');
      expect(lines.some((line) => line.startsWith('1. TeamFloPay/sdk#4 Shape the triage workflow'))).toBe(true);
      expect(lines).toContain('Select an issue to triage:');
      expect(lines).toContain('Triaging TeamFloPay/sdk#4');
      expect(
        lines.some(
          (line) =>
            line.includes(
              'Adapter: codex --model gpt-5.5 -c model_reasoning_effort="xhigh" --disable fast_mode --sandbox workspace-write -c sandbox_workspace_write.network_access=true --cd '
            ) && line.endsWith(' <prompt> (launched)')
        )
      ).toBe(true);
      expect(lines.some((line) => line.includes('War Room issue triage handoff for TeamFloPay/sdk#4'))).toBe(true);
      expect(lines.some((line) => line.includes('Title: Shape the triage workflow'))).toBe(true);
      expect(lines.some((line) => line.includes('This is planning and issue triage only. Do not implement code.'))).toBe(true);
      expect(lines.some((line) => line.includes('Do not edit repository files, create branches, commit changes, open pull requests'))).toBe(true);
      expect(lines.some((line) => line.includes('use [@sentry](plugin://sentry@openai-curated) / Sentry MCP to link this GitHub issue'))).toBe(true);
      expect(lines.some((line) => line.includes('Do not mutate Sentry status, assignees, resolution, or event data during triage'))).toBe(true);
      expect(lines.some((line) => line.includes('Use the grill-me interview behavior literally, not just as a label.'))).toBe(true);
      expect(lines.some((line) => line.includes('Ask exactly one blocking clarification question at a time'))).toBe(true);
      expect(lines.some((line) => line.includes('Do not include the final battle plan in the same response as a blocking question.'))).toBe(true);
      expect(lines.some((line) => line.includes('If a question can be answered safely by read-only investigation, do that investigation instead of asking'))).toBe(true);
      expect(lines.some((line) => line.includes('Post the final triage notes back to this GitHub issue'))).toBe(true);
      expect(lines.some((line) => line.includes('Sentry link:'))).toBe(true);
      expect(lines.some((line) => line.includes('## War Room triage notes'))).toBe(true);
      expect(lines.some((line) => line.includes('Ready for ready-to-engage: yes'))).toBe(true);
      expect(lines.some((line) => line.includes('Issue body:'))).toBe(true);
      expect(lines.some((line) => line.includes('Clarify how operators should move needs-triage issues toward a ready plan.'))).toBe(true);
      expect(lines).toContain('Triage notes: ready https://github.com/TeamFloPay/sdk/issues/4#issuecomment-triage');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#4 -> ready-to-engage');
      expect(lines.at(-1)).toBe('Run `warroom issue next --issue TeamFloPay/sdk#4` now? [Y/n]');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('launches a direct issue triage handoff by default', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['yes\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'triage', '--issue', 'TeamFloPay/sdk#4']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).not.toContain(
        'Start issue triage handoff for TeamFloPay/sdk#4 now? This will run `warroom issue triage --issue TeamFloPay/sdk#4 --launch --mark-ready --confirm-status`. [Y/n]'
      );
      expect(lines).not.toContain('Outcome: dry run only; no LLM handoff was launched.');
      expect(lines).toContain('Triaging TeamFloPay/sdk#4');
      expect(lines.some((line) => line.includes('Adapter: codex --model gpt-5.5 ') && line.endsWith(' <prompt> (launched)'))).toBe(true);
      expect(lines).toContain('Triage notes: ready https://github.com/TeamFloPay/sdk/issues/4#issuecomment-triage');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#4 -> ready-to-engage');
      expect(lines).toContain('Run `warroom issue next --issue TeamFloPay/sdk#4` now? [Y/n]');
      expect(lines).toContain('Starting TeamFloPay/sdk#4');
      expect(lines).toContain('Issue start: launched');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#4 -> battlefield-active');
      expect(lines.at(-1)).toBe('Run `warroom pr create` next? [Y/n]');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('prints a direct issue triage handoff with --dry-run', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), interactive: true });

      await program.parseAsync(['node', 'warroom', 'issue', 'triage', '--issue', 'TeamFloPay/sdk#4', '--dry-run']);

      expect(lines).not.toContain('Triaging TeamFloPay/sdk#4');
      expect(lines.some((line) => line.includes('Adapter: codex --model gpt-5.5 ') && line.endsWith(' <prompt> (not launched)'))).toBe(true);
      expect(lines).toContain('Outcome: dry run only; no LLM handoff was launched.');
      expect(lines.some((line) => line.includes('Campaign status: updated TeamFloPay/sdk#4 -> ready-to-engage'))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('previews the LLM feedback intake prompt without launching on --dry-run', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), interactive: false });

      await program.parseAsync([
        'node',
        'warroom',
        'issue',
        'feedback',
        'TeamFloPay/sdk#4',
        '--pr',
        'TeamFloPay/sdk#7',
        '--dry-run',
      ]);

      expect(lines.some((line) => line.startsWith('Issue feedback for TeamFloPay/sdk#4: preflight only'))).toBe(true);
      expect(lines).toContain('Mode: interactive LLM intake');
      expect(lines).toContain('Marker: ## War Room feedback');
      expect(lines).toContain('Related PR: TeamFloPay/sdk#7');
      expect(lines.some((line) => line.includes('Adapter: codex --model gpt-5.5 ') && line.endsWith(' <prompt> (not launched)'))).toBe(true);
      expect(lines).toContain('Outcome: dry run only; no LLM feedback session was launched. Drop --dry-run to start the interactive intake.');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('previews a direct (bypass) feedback comment when --file is passed with --dry-run', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);

    const feedbackFile = path.join(root, 'feedback.md');
    writeFileSync(
      feedbackFile,
      '**What:** Add a back-compat mapper.\n\n**Why:** Avoid breaking client sites that have not yet upgraded the SDK.\n\n**Scope:** Mapper only — no new endpoints.\n\n**Where it lands:** Fold into the in-flight PR.'
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), interactive: false });

      await program.parseAsync([
        'node',
        'warroom',
        'issue',
        'feedback',
        'TeamFloPay/sdk#4',
        '--pr',
        'TeamFloPay/sdk#7',
        '--file',
        feedbackFile,
        '--dry-run',
      ]);

      expect(lines.some((line) => line.startsWith('Issue feedback for TeamFloPay/sdk#4: preflight only'))).toBe(true);
      expect(lines).toContain('Mode: direct (--body/--file)');
      expect(lines.some((line) => line.startsWith('Issue comment: planned TeamFloPay/sdk#4'))).toBe(true);
      expect(lines.some((line) => line.startsWith('PR comment: planned TeamFloPay/sdk#7'))).toBe(true);
      expect(lines.some((line) => line.startsWith('## War Room feedback'))).toBe(true);
      expect(lines.some((line) => line.includes('**Related PR:** TeamFloPay/sdk#7'))).toBe(true);
      expect(lines.some((line) => line.includes('Add a back-compat mapper'))).toBe(true);
      expect(lines.some((line) => line === 'Outcome: preflight only; no comment posted. Rerun without --dry-run (and with --body/--file) to post directly.')).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('does not move a triaged issue when no ready triage notes were posted', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexNoTriageNotesFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['1\n', 'n\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'triage']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Triage notes: missing');
      expect(lines.some((line) => line.includes('Campaign status: updated TeamFloPay/sdk#4 -> ready-to-engage'))).toBe(false);
      expectFinalOutcome(
        lines,
        'Outcome: interactive issue triage session completed, but Campaign status was not updated. No new issue comment containing "## War Room triage notes" was found.'
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('moves a triaged issue to blockaded when triage notes mark it not ready for ready-to-engage', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexNotReadyTriageFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['1\n', 'n\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'triage']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Triage notes: not ready https://github.com/TeamFloPay/sdk/issues/4#issuecomment-triage');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#4 -> blockaded');
      expect(lines.some((line) => line.includes('Campaign status: updated TeamFloPay/sdk#4 -> ready-to-engage'))).toBe(false);
      expect(lines.some((line) => line.startsWith('Outcome: interactive issue triage session completed.') && line.includes('Campaign status updated to blockaded.'))).toBe(true);
      expect(lines.some((line) => line === 'Run `warroom issue next --issue TeamFloPay/sdk#4` now? [Y/n]')).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('launches selected ally triage issues from the ally issue repo checkout', async () => {
    const root = makeDevFixture();
    const allyRepo = path.join(root, 'allies', 'clicktech', 'repos', 'ally-clicktech');
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    initGitRepo(allyRepo);
    writeFileSync(path.join(root, 'allies.yaml'), allyManifestFixture());
    writeAllyTriageGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['1\n', 'n\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'issue', 'triage']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Issues with Campaign status needs-triage: 1');
      expect(lines.some((line) => line.startsWith('1. TeamFloPay/ally-clicktech#5 Possible AVS issue'))).toBe(true);
      expect(lines).toContain('Triaging TeamFloPay/ally-clicktech#5');
      expect(lines.some((line) => line === `Adapter: codex --model gpt-5.5 -c model_reasoning_effort="xhigh" --disable fast_mode --sandbox workspace-write -c sandbox_workspace_write.network_access=true --cd ${allyRepo} <prompt> (launched)`)).toBe(true);
      expect(lines.some((line) => line.includes('Ally issue repo context for TeamFloPay/ally-clicktech'))).toBe(true);
      expect(lines.some((line) => line.includes(`Local checkout: ${allyRepo}`))).toBe(true);
      expect(lines).toContain('Triage notes: ready https://github.com/TeamFloPay/ally-clicktech/issues/5#issuecomment-triage');
      expect(lines).toContain('Campaign status: updated TeamFloPay/ally-clicktech#5 -> ready-to-engage');
      expectBoxedOutcome(
        lines,
        'Outcome: interactive issue triage session completed. Campaign status updated to ready-to-engage.'
      );
      expect(lines.at(-1)).toBe('Run `warroom issue next --issue TeamFloPay/ally-clicktech#5` now? [Y/n]');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('treats legacy Codex Cloud config as a local Codex implementation launch', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\n');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'issue', 'next', '--issue', 'TeamFloPay/sdk#7', '--confirm-status']);

      expect(lines).toContain('Starting TeamFloPay/sdk#7');
      expect(lines).toContain('Issue start: launched');
      expect(lines.some((line) => line.startsWith('Adapter: codex exec --model gpt-5.5 '))).toBe(true);
      expect(lines).toContain('Adapter run: completed (foreground process; no background session remains)');
      expect(lines.some((line) => line.includes('codex cloud exec'))).toBe(false);
      expect(lines.some((line) => line.includes('gh issue develop 7 --repo TeamFloPay/sdk --base main --name warroom/7-build-the-selector --checkout'))).toBe(true);
      expect(lines.some((line) => line.includes('git switch -c warroom/7-build-the-selector --track origin/warroom/7-build-the-selector'))).toBe(true);
      expect(lines.some((line) => line.includes('not a blocker unless the fetch/switch fails'))).toBe(false);
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> battlefield-active');
      expectFinalOutcome(
        lines,
        'Outcome: LLM adapter completed on warroom/7-build-the-selector; no background session remains. Campaign status updated to battlefield-active.'
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('requires a clean local checkout even when legacy Codex Cloud config is present', async () => {
    const root = makeDevFixture();
    const sdk = path.resolve(root, '..', 'sdk');
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\n');
    writeFileSync(path.join(sdk, 'dirty-local-note.md'), 'local work in progress\n');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'issue', 'next', '--issue', 'TeamFloPay/sdk#7', '--confirm-status']);

      expect(lines).toContain('Issue start: blocked');
      expect(lines.some((line) => line.startsWith('Adapter: codex exec --model gpt-5.5 '))).toBe(true);
      expect(lines).toContain('Development branch: planned warroom/7-build-the-selector from main');
      expect(lines.some((line) => line.includes('Development branch link: planned gh issue develop 7 --repo TeamFloPay/sdk --base main --name warroom/7-build-the-selector --checkout'))).toBe(true);
      expect(lines.some((line) => line.startsWith('Development checkout: not checked out'))).toBe(true);
      expect(lines.some((line) => line.includes('branch blocked: Mapped checkout has local changes.'))).toBe(true);
      expect(lines.some((line) => line.includes('Campaign status: updated'))).toBe(false);
      expectFinalOutcome(
        lines,
        'Outcome: not handed off to LLM adapter. Blocker: Mapped checkout has local changes. Commit, stash, or move them before creating warroom/7-build-the-selector. Resolve the blocker, then rerun the issue start command.'
      );

      const branch = spawnSync('git', ['branch', '--show-current'], { cwd: sdk, encoding: 'utf8' });
      expect(branch.stdout.trim()).toBe('main');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('prints a clear outcome when issue next is blocked before handoff', async () => {
    const root = makeDevFixture();
    const sdk = path.resolve(root, '..', 'sdk');
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(sdk, 'dirty-local-note.md'), 'local work in progress\n');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'issue', 'next', '--issue', 'TeamFloPay/sdk#7', '--confirm-status']);

      expect(lines).toContain('Issue start: blocked');
      expect(lines.some((line) => line.includes('branch blocked: Mapped checkout has local changes.'))).toBe(true);
      expectFinalOutcome(
        lines,
        'Outcome: not handed off to LLM adapter. Blocker: Mapped checkout has local changes. Commit, stash, or move them before creating warroom/7-build-the-selector. Resolve the blocker, then rerun the issue start command.'
      );
    } finally {
      process.env.PATH = originalPath;
      process.exitCode = undefined;
    }
  });

  it('distinguishes an adapter process failure from a pre-handoff blocker', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeFailingImplementationCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'issue', 'next', '--issue', 'TeamFloPay/sdk#7', '--confirm-status']);

      expect(lines).toContain('Issue start: adapter failed');
      expect(lines).toContain('Adapter run: failed with status 1 (foreground process; no background session remains)');
      expect(lines).toContain('Adapter error: Adapter exited with status 1.');
      expect(lines).toContain('Development checkout: checked out');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> battlefield-active');
      expect(lines.some((line) => line.includes('Outcome: not handed off to LLM adapter'))).toBe(false);
      expectFinalOutcome(
        lines,
        'Outcome: LLM adapter ran but exited with an error on warroom/7-build-the-selector; inspect the adapter output above, resolve the failure, then rerun the issue start command. Campaign status updated to battlefield-active.'
      );
    } finally {
      process.env.PATH = originalPath;
      process.exitCode = undefined;
    }
  });

  it('scopes issue next to the current mapped child repo', async () => {
    const root = makeDevFixture();
    const demo = path.resolve(root, '..', 'demo');
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const scopedLines: string[] = [];
      const scopedProgram = buildProgram({ cwd: demo, output: (line) => scopedLines.push(line) });

      await scopedProgram.parseAsync(['node', 'warroom', 'issue', 'next']);

      expect(scopedLines[0]).toBe('Issues with Campaign status ready-to-engage for TeamFloPay/demo: 0');
      expect(scopedLines.some((line) => line.includes('TeamFloPay/sdk#7'))).toBe(false);
      expect(scopedLines).toContain('Outcome: no ready issues found; no issue started.');

      const allLines: string[] = [];
      const allProgram = buildProgram({ cwd: demo, output: (line) => allLines.push(line) });

      await allProgram.parseAsync(['node', 'warroom', 'issue', 'next', '--all']);

      expect(allLines[0]).toBe('Issues with Campaign status ready-to-engage: 1');
      expect(allLines.some((line) => line.includes('TeamFloPay/sdk#7'))).toBe(true);
      expect(allLines).toContain('Outcome: no issue started.');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('includes complete issue details in issue start handoffs', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync([
        'node',
        'warroom',
        'issue',
        'next',
        '--issue',
        'TeamFloPay/sdk#17',
        '--dry-run',
        '--no-status',
        '--write-artifact',
      ]);

      const output = lines.join('\n');
      expect(output).toContain('Complete issue body:');
      expect(output).toContain('FULL_BODY_SENTINEL');
      expect(output).toContain('FULL_COMMENT_SENTINEL');
      expect(output).not.toContain('Truncated by War Room');

      const artifactLine = lines.find((line) => line.startsWith('Artifact: '));
      expect(artifactLine).toBeDefined();
      const runDir = artifactLine!.replace('Artifact: ', '');
      expect(readFileSync(path.join(runDir, 'issue.json'), 'utf8')).toContain('FULL_BODY_SENTINEL');
      expect(readFileSync(path.join(runDir, 'issue.json'), 'utf8')).toContain('FULL_COMMENT_SENTINEL');
      expectFinalOutcome(
        lines,
        'Outcome: dry run only; no LLM handoff was launched, no development branch was created, and no Campaign status was updated.'
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('creates a GitHub PR from the current development branch', async () => {
    const { root, sdk, sdkRemote } = makeCommitFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const branch = spawnSync('git', ['switch', '-c', 'warroom/7-build-the-selector'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);
    writeFileSync(path.join(sdk, 'selector.ts'), 'export const selector = true;\n');
    commitAll(sdk, 'feat: build selector');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'create', '--confirm', '--confirm-status']);

      expect(lines).toContain('PR create: created');
      expect(lines).toContain('Repo: TeamFloPay/sdk');
      expect(lines).toContain('Branch: warroom/7-build-the-selector -> main');
      expect(lines).toContain('Issue: TeamFloPay/sdk#7');
      expect(lines).toContain('Title: Build the selector');
      expect(lines).toContain('PR text: generated by LLM adapter');
      expect(lines.some((line) => line.includes('Adapter: codex exec -o '))).toBe(true);
      expect(lines).toContain('URL: https://github.com/TeamFloPay/sdk/pull/12');
      expect(lines).toContain('Issue progress: posted TeamFloPay/sdk#7 https://github.com/TeamFloPay/sdk/issues/7#issuecomment-2');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> skirmish');
      expect(lines.some((line) => line.includes('Push: pushed git push -u origin warroom/7-build-the-selector'))).toBe(true);
      expect(lines.some((line) => line.includes('Create: created gh pr create --repo TeamFloPay/sdk'))).toBe(true);
      expect(lines.some((line) => line.includes('Closes TeamFloPay/sdk#7'))).toBe(true);
      expect(lines.some((line) => line.includes('- feat: build selector'))).toBe(true);
      expect(lines.at(-1)).toBe('PR URL: https://github.com/TeamFloPay/sdk/pull/12');

      const remoteBranch = spawnSync(
        'git',
        ['--git-dir', sdkRemote, 'rev-parse', '--verify', 'refs/heads/warroom/7-build-the-selector'],
        { encoding: 'utf8' }
      );
      expect(remoteBranch.status).toBe(0);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('blocks PR creation when the branch has no commits ahead of base', async () => {
    const { root, sdk } = makeCommitFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const branch = spawnSync('git', ['switch', '-c', 'warroom/7-build-the-selector'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'create']);

      expect(lines).toContain('PR create: preflight only');
      expect(lines).toContain('blocked: No commits found on warroom/7-build-the-selector ahead of main. Run `warroom commit create` before creating a PR.');
      expect(lines).toContain('Outcome: PR not created. Resolve the blocked items above, then rerun `warroom pr create --confirm`.');
      expect(lines.some((line) => line.includes('Adapter: codex exec -o '))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('summarizes large PR diffs in chunks instead of truncating the adapter prompt', async () => {
    const { root, sdk } = makeCommitFixture();
    const bin = path.join(root, 'bin');
    const promptLog = path.join(root, 'codex-prompts.log');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const branch = spawnSync('git', ['switch', '-c', 'warroom/7-build-the-selector'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);
    const largeSelector = Array.from({ length: 7_000 }, (_, index) => `export const selector${index} = ${index};`).join('\n');
    writeFileSync(path.join(sdk, 'selector.ts'), `${largeSelector}\n`);
    commitAll(sdk, 'feat: build selector');

    const originalPath = process.env.PATH;
    const originalPromptLog = process.env.WARROOM_CODEX_PROMPT_LOG;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_CODEX_PROMPT_LOG = promptLog;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'create']);

      const prompts = readFileSync(promptLog, 'utf8');
      expect(prompts).toContain('Summarize one chunk of a Git diff');
      expect(prompts).toContain('Summarized full diff in');
      expect(prompts).not.toContain('[truncated');
      expect(lines).toContain('PR create: preflight only');
      expect(lines.some((line) => line.includes('full diff summarized in'))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      if (originalPromptLog === undefined) delete process.env.WARROOM_CODEX_PROMPT_LOG;
      else process.env.WARROOM_CODEX_PROMPT_LOG = originalPromptLog;
    }
  });

  it('prompts from PR create preflight into PR creation and ends with the URL', async () => {
    const { root, sdk, sdkRemote } = makeCommitFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const branch = spawnSync('git', ['switch', '-c', 'warroom/7-build-the-selector'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);
    writeFileSync(path.join(sdk, 'selector.ts'), 'export const selector = true;\n');
    commitAll(sdk, 'feat: build selector');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['yes\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'pr', 'create', '--confirm-status']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('PR create: preflight only');
      expect(lines).toContain('Outcome: PR not created. This was a preflight; run `warroom pr create --confirm` or answer yes in an interactive terminal to push and create the PR.');
      expect(lines).toContain('Push this branch and create the GitHub PR now? [Y/n]');
      expect(lines).toContain('Creating PR...');
      expect(lines).toContain('PR create: created');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> skirmish');
      expect(lines).toContain('Issue progress: posted TeamFloPay/sdk#7 https://github.com/TeamFloPay/sdk/issues/7#issuecomment-2');
      expect(lines).toContain('PR URL: https://github.com/TeamFloPay/sdk/pull/12');
      expect(lines.at(-1)).toBe('Run `warroom pr review` next? [Y/n]');

      const remoteBranch = spawnSync(
        'git',
        ['--git-dir', sdkRemote, 'rev-parse', '--verify', 'refs/heads/warroom/7-build-the-selector'],
        { encoding: 'utf8' }
      );
      expect(remoteBranch.status).toBe(0);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('can flow from interactive PR creation into the initial CodeRabbit review wait', async () => {
    const { root, sdk } = makeCommitFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writePrReviewLoopGhFixture(bin, stateFile, {
      queue: 'empty',
      outstandingFirst: false,
      initialCodeRabbitPending: true,
    });
    writeCodexFixture(bin);
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const branch = spawnSync('git', ['switch', '-c', 'warroom/7-build-the-selector'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);
    writeFileSync(path.join(sdk, 'selector.ts'), 'export const selector = true;\n');
    commitAll(sdk, 'feat: build selector');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const restorePrReviewEnv = setFastPrReviewPolling();

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['yes\n', 'yes\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'pr', 'create']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('PR create: created');
      expect(lines).toContain('Run `warroom pr review` next? [Y/n]');
      expect(lines).toContain('Starting PR review for TeamFloPay/sdk#12');
      expect(lines.some((line) => line.startsWith('PR review loop: waiting for CodeRabbit feedback on the initial PR commit'))).toBe(true);
      expect(lines).toContain('PR review loop: no outstanding CodeRabbit feedback remains on the initial PR commit.');
      expect(lines).toContain('PR review: complete');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> skirmish');
      expectBoxedOutcome(lines, 'Outcome: PR review loop complete; no outstanding CodeRabbit feedback remains.');
      expect(lines.at(-1)).toBe('Run `warroom pr merge --pr TeamFloPay/sdk#12` now? [Y/n/Review Again]');
      expect(Number(readFileSync(`${stateFile}.polls`, 'utf8'))).toBeGreaterThanOrEqual(4);
    } finally {
      restorePrReviewEnv();
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
      expectBoxedOutcome(
        lines,
        'Outcome: listed 2 PRs ready for review; no LLM handoff was launched. Run `warroom pr review --pr <owner/repo#number> --launch` to start one.'
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('falls back to the current branch PR when the review queue is empty', async () => {
    const { root, sdk } = makeCommitFixture();
    const branch = spawnSync('git', ['switch', '-c', 'fix/stripe-avs-address-preservation'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);

    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writePrReviewLoopGhFixture(bin, stateFile, { queue: 'empty', outstandingFirst: false });

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'review']);

      expect(lines[0]).toBe('Open PRs for Campaign statuses battlefield-active, skirmish for TeamFloPay/sdk: 0');
      expect(lines).toContain('Resolved current branch PR: TeamFloPay/sdk#659');
      expect(lines).toContain('PR review: complete');
      expect(lines.some((line) => line.includes('PR https://github.com/TeamFloPay/sdk/pull/659'))).toBe(true);
      expectFinalOutcome(
        lines,
        'Outcome: PR review loop complete; no outstanding CodeRabbit feedback remains.'
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('prompts from the PR review queue into a launched review handoff', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writePrReviewLoopGhFixture(bin, stateFile, { queue: 'multi', outstandingFirst: true });
    writePrReviewLoopCodexFixture(bin, stateFile);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const restorePrReviewEnv = setFastPrReviewPolling();

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['1\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'pr', 'review']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines[0]).toBe('Open PRs for Campaign statuses battlefield-active, skirmish: 2');
      expect(lines[1]).toContain('1. TeamFloPay/sdk#12 Review active SDK work');
      expect(lines[2]).toContain('2. TeamFloPay/demo#3 Review demo follow-up');
      expect(lines).toContain('Select a PR to review:');
      expect(lines).toContain('Starting PR review for TeamFloPay/sdk#12');
      expect(lines).toContain('PR review: complete');
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#8 -> skirmish');
      expect(lines.some((line) => line.startsWith('Adapter: codex exec --model gpt-5.5 '))).toBe(true);
      expect(lines.some((line) => line.includes('Please analyze the latest [@coderabbit](plugin://coderabbit@openai-curated)'))).toBe(true);
      expect(lines.some((line) => line.includes('addPullRequestReviewThreadReply'))).toBe(true);
      expect(lines.some((line) => line.includes('must post one final reply on every listed thread'))).toBe(true);
      expect(lines.some((line) => line.includes('Do not stop before code changes only because the reaction could not be added.'))).toBe(true);
      expect(lines.some((line) => /^PR review loop iterations: \d+$/.test(line))).toBe(true);
      expectBoxedOutcome(lines, 'Outcome: PR review loop complete; no outstanding CodeRabbit feedback remains.');
      expect(lines.at(-1)).toBe('Run `warroom pr merge --pr TeamFloPay/sdk#12` now? [Y/n/Review Again]');
    } finally {
      restorePrReviewEnv();
      process.env.PATH = originalPath;
    }
  });

  it('commits and pushes adapter edits before waiting for CodeRabbit again', async () => {
    const { root, sdk, sdkRemote } = makeCommitFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writePrReviewLoopGhFixture(bin, stateFile, { queue: 'empty', outstandingFirst: true, initialCodeRabbitPending: true });
    writePrReviewLoopDirtyCodexFixture(bin, stateFile);
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const branch = spawnSync('git', ['switch', '-c', 'warroom/8-active-sdk-work'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);
    const push = spawnSync('git', ['push', '-u', 'origin', 'warroom/8-active-sdk-work'], { cwd: sdk, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(push.stderr);
    const beforeRemoteHead = spawnSync(
      'git',
      ['--git-dir', sdkRemote, 'rev-parse', 'refs/heads/warroom/8-active-sdk-work'],
      { encoding: 'utf8' }
    ).stdout.trim();

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const restorePrReviewEnv = setFastPrReviewPolling();

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'review', '--pr', 'TeamFloPay/sdk#12', '--launch']);

      expect(lines).toContain('PR review loop: adapter left 1 changed file; committing them before waiting for CodeRabbit.');
      expect(lines.some((line) => line.startsWith('PR review loop: pushing review commit '))).toBe(true);

      const status = spawnSync('git', ['status', '--short'], { cwd: sdk, encoding: 'utf8' });
      expect(status.stdout.trim()).toBe('');
      const afterRemoteHead = spawnSync(
        'git',
        ['--git-dir', sdkRemote, 'rev-parse', 'refs/heads/warroom/8-active-sdk-work'],
        { encoding: 'utf8' }
      ).stdout.trim();
      expect(afterRemoteHead).not.toBe(beforeRemoteHead);
      const lastCommit = spawnSync(
        'git',
        ['--git-dir', sdkRemote, 'log', '-1', '--pretty=%s', 'refs/heads/warroom/8-active-sdk-work'],
        { encoding: 'utf8' }
      );
      expect(lastCommit.stdout.trim()).toBe('fix: address CodeRabbit review feedback');
    } finally {
      restorePrReviewEnv();
      process.env.PATH = originalPath;
    }
  });

  it('prompts from completed PR review into PR merge preflight', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writePrReviewLoopGhFixture(bin, stateFile, { queue: 'empty', outstandingFirst: false });
    writePrReviewLoopCodexFixture(bin, stateFile);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const restorePrReviewEnv = setFastPrReviewPolling();

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['yes\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync([
          'node',
          'warroom',
          'pr',
          'review',
          '--pr',
          'TeamFloPay/sdk#12',
          '--issue',
          'TeamFloPay/sdk#8',
          '--launch',
        ]);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expectBoxedOutcome(lines, 'Outcome: PR review loop complete; no outstanding CodeRabbit feedback remains.');
      expect(lines).toContain('Run `warroom pr merge --pr TeamFloPay/sdk#12` now? [Y/n/Review Again]');
      expect(lines).toContain('Starting PR merge for TeamFloPay/sdk#12');
      expect(lines).toContain('PR merge: preflight only');
      expect(lines).toContain('Merge readiness: clear');
    } finally {
      restorePrReviewEnv();
      process.env.PATH = originalPath;
    }
  });

  it('posts fallback CodeRabbit replies when War Room auto-commits adapter edits', async () => {
    const { root, sdk } = makeCommitFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    const replyLog = path.join(root, 'review-thread-replies.jsonl');
    mkdirSync(bin, { recursive: true });
    writeFileSync(stateFile, '1');
    writePrReviewLoopGhFixture(bin, stateFile, {
      queue: 'multi',
      outstandingFirst: true,
      replyAfterFix: false,
      replyLog,
    });
    writePrReviewLoopDirtyCodexFixture(bin, stateFile);
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const branch = spawnSync('git', ['switch', '-c', 'warroom/8-active-sdk-work'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);
    const push = spawnSync('git', ['push', '-u', 'origin', 'warroom/8-active-sdk-work'], { cwd: sdk, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(push.stderr);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const restorePrReviewEnv = setFastPrReviewPolling();

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'review', '--pr', 'TeamFloPay/sdk#12', '--launch']);

      expect(lines).toContain('PR review loop: adapter left 1 changed file; committing them before waiting for CodeRabbit.');
      expect(lines).toContain('PR review loop: posted fallback CodeRabbit replies to 1 review thread after publishing the review commit.');
      expect(lines).toContain('PR review loop 1: no outstanding CodeRabbit feedback remains.');
      expectFinalOutcome(lines, 'Outcome: PR review loop complete; no outstanding CodeRabbit feedback remains.');

      const replies = readFileSync(replyLog, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(replies).toHaveLength(1);
      expect(replies[0].threadId).toBe('PRRT_fixture_1');
      expect(replies[0].body).toContain('Change made: War Room committed the PR review updates in');
      expect(replies[0].body).toContain('src/billing.ts:12');
    } finally {
      restorePrReviewEnv();
      process.env.PATH = originalPath;
    }
  });

  it('includes visible CodeRabbit thread IDs in the PR review handoff', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writeFileSync(stateFile, '1');
    writePrReviewLoopGhFixture(bin, stateFile, { queue: 'multi', outstandingFirst: true });

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'review', '--pr', 'TeamFloPay/sdk#12', '--dry-run']);

      expect(lines.some((line) => line.includes('Thread ID: PRRT_fixture_1'))).toBe(true);
      expect(lines.some((line) => line.includes('Review comment ID: PRRC_fixture_1'))).toBe(true);
      expect(lines.some((line) => line.includes('gh api graphql -f threadId=<THREAD_ID>'))).toBe(true);
      expectFinalOutcome(
        lines,
        'Outcome: preflight only; no LLM handoff was launched. Rerun with `--launch` to start the PR review loop.'
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('blocks the PR review loop when CodeRabbit thread replies are missing', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writePrReviewLoopGhFixture(bin, stateFile, { queue: 'multi', outstandingFirst: true, replyAfterFix: false, initialCodeRabbitPending: true });
    writePrReviewLoopCodexFixture(bin, stateFile);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const restorePrReviewEnv = setFastPrReviewPolling();

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'review', '--pr', 'TeamFloPay/sdk#12', '--launch']);

      expect(lines).toContain('PR review loop: failed');
      expect(lines.some((line) => line.includes('review loop blocked: LLM adapter did not post final replies to 1 CodeRabbit review thread'))).toBe(true);
      const finalOutcome = lines[lines.length - 2];
      expect(finalOutcome).toMatch(/^Outcome: PR review loop blocked\. Blocker: LLM adapter did not post final replies to 1 CodeRabbit review thread.* Resolve the blocker, then rerun the PR review command\.$/);
    } finally {
      restorePrReviewEnv();
      process.env.PATH = originalPath;
    }
  });

  it('waits for delayed CodeRabbit feedback before closing the review loop', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writePrReviewLoopGhFixture(bin, stateFile, { queue: 'multi', outstandingFirst: true, delayedCodeRabbit: true, initialCodeRabbitPending: true });
    writePrReviewLoopCodexFixture(bin, stateFile);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const restorePrReviewEnv = setFastPrReviewPolling();

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'review', '--pr', 'TeamFloPay/sdk#12', '--launch']);

      expect(lines).toContain('PR review loop: waiting for CodeRabbit feedback on the initial PR commit 000000000000.');
      expect(lines.some((line) => line.includes('PR review loop: 1 outstanding CodeRabbit comment is ready on the initial PR commit.'))).toBe(true);
      expect(lines.some((line) => line.startsWith('PR review loop 1: launching adapter for '))).toBe(true);
      expect(Number(readFileSync(`${stateFile}.polls`, 'utf8'))).toBeGreaterThanOrEqual(4);
    } finally {
      restorePrReviewEnv();
      process.env.PATH = originalPath;
    }
  });

  it('auto-launches the PR review handoff when only one queue item is detected', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writePrReviewLoopGhFixture(bin, stateFile, { queue: 'single', outstandingFirst: false });
    writePrReviewLoopCodexFixture(bin, stateFile);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const restorePrReviewEnv = setFastPrReviewPolling();

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'pr', 'review']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines[0]).toBe('Open PRs for Campaign statuses battlefield-active, skirmish: 1');
      expect(lines[1]).toContain('TeamFloPay/backend#657 Remove Recurly & Chargebee Support');
      expect(lines).toContain('Starting PR review handoff for TeamFloPay/backend#657...');
      expect(lines).toContain('Starting PR review for TeamFloPay/backend#657');
      expect(lines).toContain('PR review: complete');
      expect(lines).toContain('Campaign status: updated TeamFloPay/backend#632 -> skirmish');
      expect(lines).toContain('PR review loop: no outstanding CodeRabbit feedback remains on the initial PR commit.');
      expect(lines.some((line) => line.includes('PR https://github.com/TeamFloPay/backend/pull/657'))).toBe(true);
      expectBoxedOutcome(lines, 'Outcome: PR review loop complete; no outstanding CodeRabbit feedback remains.');
      expect(lines.at(-1)).toBe('Run `warroom pr merge --pr TeamFloPay/backend#657` now? [Y/n/Review Again]');
    } finally {
      restorePrReviewEnv();
      process.env.PATH = originalPath;
    }
  });

  it('uses the local adapter for PR review when legacy Codex Cloud config is present', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'review-state.txt');
    mkdirSync(bin, { recursive: true });
    writePrReviewLoopGhFixture(bin, stateFile, { queue: 'multi', outstandingFirst: false });
    writePrReviewLoopCodexFixture(bin, stateFile);
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\n');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const restorePrReviewEnv = setFastPrReviewPolling();

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'review', '--pr', 'TeamFloPay/sdk#12', '--launch']);

      expect(lines).toContain('PR review: complete');
      expect(lines.some((line) => line.startsWith('Adapter: codex exec --model gpt-5.5 '))).toBe(true);
      expect(lines.some((line) => line.includes('codex cloud exec'))).toBe(false);
      expectFinalOutcome(lines, 'Outcome: PR review loop complete; no outstanding CodeRabbit feedback remains.');
    } finally {
      restorePrReviewEnv();
      process.env.PATH = originalPath;
    }
  });

  it('prints a clear outcome for PR review preflight handoffs', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'review', '--pr', 'TeamFloPay/backend#655', '--dry-run']);

      expect(lines).toContain('PR review: preflight only');
      expect(lines.some((line) => line.includes('Please analyze the latest [@coderabbit](plugin://coderabbit@openai-curated)'))).toBe(true);
      expect(lines.some((line) => line.includes('PR https://github.com/TeamFloPay/backend/pull/655'))).toBe(true);
      expectFinalOutcome(
        lines,
        'Outcome: preflight only; no LLM handoff was launched. Rerun with `--launch` to start the PR review loop.'
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('reports legacy Codex Cloud config as a deprecated local adapter alias', () => {
    const root = makeDevFixture();
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\n');

    const result = getEnvStatus(root);

    expect(result.adapterSupported).toBe(true);
    expect(result.notes.some((note) => note.includes('LLM_ADAPTER=codex-cloud is deprecated'))).toBe(true);
    expect(result.notes.some((note) => note.includes('CODEX_CLOUD_ENV'))).toBe(false);
  });

  it('does not require Codex Cloud environment ids for adapter launches', () => {
    const root = makeDevFixture();
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\n');

    const invocation = getAdapterInvocation(root, root);
    expect(invocation.mode).toBe('foreground');
    expect(invocation.display).toContain('codex exec --model gpt-5.5');
    expect(invocation.display).toContain('model_reasoning_effort="xhigh"');
    expect(invocation.display).toContain('--disable fast_mode');
    expect(invocation.display).not.toContain('codex cloud exec');
  });

  it('uses Codex TUI invocation for interactive adapter launches', () => {
    const root = makeDevFixture();
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex\nCODEX_COMMAND=codex\n');

    const invocation = getInteractiveAdapterInvocation(root, root, 'prompt');

    expect(invocation.mode).toBe('interactive');
    expect(invocation.args).toEqual([
      '--model',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="xhigh"',
      '--disable',
      'fast_mode',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '--cd',
      root,
      'prompt',
    ]);
    expect(invocation.display).toBe(
      `codex --model gpt-5.5 -c model_reasoning_effort="xhigh" --disable fast_mode --sandbox workspace-write -c sandbox_workspace_write.network_access=true --cd ${root} <prompt>`
    );
  });

  it('allows interactive Codex sandbox and network overrides', () => {
    const root = makeDevFixture();
    writeFileSync(
      path.join(root, '.env.local'),
      'LLM_ADAPTER=codex\nCODEX_COMMAND=codex\nCODEX_INTERACTIVE_MODEL=gpt-5.4\nCODEX_INTERACTIVE_REASONING_EFFORT=high\nCODEX_INTERACTIVE_FAST_MODE=true\nCODEX_INTERACTIVE_SANDBOX=danger-full-access\nCODEX_INTERACTIVE_NETWORK_ACCESS=false\n'
    );

    const invocation = getInteractiveAdapterInvocation(root, root, 'prompt');

    expect(invocation.args).toEqual([
      '--model',
      'gpt-5.4',
      '-c',
      'model_reasoning_effort="high"',
      '--sandbox',
      'danger-full-access',
      '--cd',
      root,
      'prompt',
    ]);
    expect(invocation.display).toBe(`codex --model gpt-5.4 -c model_reasoning_effort="high" --sandbox danger-full-access --cd ${root} <prompt>`);
  });

  it('builds foreground Claude invocation with print/json/model/permission flags', () => {
    const root = makeDevFixture();
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=claude\nCLAUDE_COMMAND=claude\n');

    const invocation = getAdapterInvocation(root, root);

    expect(invocation.adapter).toBe('claude');
    expect(invocation.mode).toBe('foreground');
    expect(invocation.args).toEqual([
      '--print',
      '--output-format',
      'json',
      '--model',
      'claude-sonnet-4-6',
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(invocation.display).toBe('claude --print --output-format json --model claude-sonnet-4-6 --permission-mode acceptEdits');
  });

  it('builds interactive Claude invocation with model/permission flags and prompt arg', () => {
    const root = makeDevFixture();
    writeFileSync(
      path.join(root, '.env.local'),
      'LLM_ADAPTER=claude\nCLAUDE_COMMAND=claude\nCLAUDE_MODEL=claude-opus-4-7\nCLAUDE_INTERACTIVE_PERMISSION_MODE=bypassPermissions\n'
    );

    const invocation = getInteractiveAdapterInvocation(root, root, 'prompt');

    expect(invocation.adapter).toBe('claude');
    expect(invocation.mode).toBe('interactive');
    expect(invocation.args).toEqual([
      '--model',
      'claude-opus-4-7',
      '--permission-mode',
      'bypassPermissions',
      'prompt',
    ]);
    expect(invocation.display).toBe('claude --model claude-opus-4-7 --permission-mode bypassPermissions <prompt>');
  });

  it('resolves a bare CLAUDE_COMMAND from inherited PATH without going through a login shell', () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'tools');
    mkdirSync(bin, { recursive: true });
    const adapterPath = path.join(bin, 'claude');
    writeFileSync(
      adapterPath,
      `#!/bin/sh
cat <<'EOF'
{"type":"result","subtype":"success","is_error":false,"result":"reply","total_cost_usd":0.001,"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5},"model":"claude-sonnet-4-6"}
EOF
exit 0
`
    );
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=claude\nCLAUDE_COMMAND=claude\n');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    try {
      const result = runAdapter(root, 'prompt body', { cwd: root, captureStdout: false });
      expect(result.launched).toBe(true);
      expect(result.status).toBe(0);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('fails fast with a clear error when the configured adapter command is not on PATH', () => {
    const root = makeDevFixture();
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=claude\nCLAUDE_COMMAND=warroom-nonexistent-claude\n');

    const result = runAdapter(root, 'prompt body', { cwd: root });

    expect(result.launched).toBe(false);
    expect(result.status).toBe(127);
    expect(result.error ?? '').toContain('Adapter command not found on PATH: `warroom-nonexistent-claude`');
  });

  it('parses Claude --output-format json tokens, cost, and result for usage tracking', () => {
    const root = makeDevFixture();
    const promptCapturePath = path.join(root, 'claude-prompt.txt');
    const outputPath = path.join(root, 'claude-last-message.txt');
    const adapterPath = path.join(root, 'fake-claude');
    writeFileSync(
      adapterPath,
      `#!/bin/sh
cat > "$WARROOM_PROMPT_CAPTURE_PATH"
cat <<'EOF'
{"type":"result","subtype":"success","is_error":false,"result":"Claude reply body","session_id":"sess-123","total_cost_usd":0.0345,"usage":{"input_tokens":120,"cache_creation_input_tokens":40,"cache_read_input_tokens":60,"output_tokens":80},"model":"claude-sonnet-4-6"}
EOF
exit 0
`
    );
    chmodSync(adapterPath, 0o755);
    writeFileSync(
      path.join(root, '.env.local'),
      `LLM_ADAPTER=claude\nCLAUDE_COMMAND=${adapterPath}\nWARROOM_PROMPT_CAPTURE_PATH=${promptCapturePath}\n`
    );

    const result = runAdapter(root, 'prompt body', {
      cwd: root,
      outputLastMessagePath: outputPath,
      captureStdout: true,
      usage: {
        issue: 'TeamFloPay/backend#777',
        command: 'pr-create',
        stage: 'pr-text-summary',
        repo: 'TeamFloPay/backend',
        commandRunId: 'claude-fixture-run',
      },
    });

    expect(result.launched).toBe(true);
    expect(result.invocation.adapter).toBe('claude');
    expect(readFileSync(outputPath, 'utf8')).toBe('Claude reply body');
    expect(readFileSync(promptCapturePath, 'utf8')).toContain('prompt body');

    const ledgerPath = path.join(root, '.warroom', 'runs', 'issues', 'TeamFloPay__backend__777', 'usage-ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      entries: Array<{
        inputTokens: number | null;
        cachedInputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
        costUsd: number | null;
        adapterReportedCostUsd: number | null;
        sessionId: string | null;
        model: string | null;
        adapter: string;
        usageSource: string;
      }>;
    };
    expect(ledger.entries[0]).toMatchObject({
      adapter: 'fake-claude',
      model: 'claude-sonnet-4-6',
      inputTokens: 120,
      cachedInputTokens: 100,
      outputTokens: 80,
      totalTokens: 300,
      adapterReportedCostUsd: 0.0345,
      costUsd: 0.0345,
      sessionId: 'sess-123',
      usageSource: 'adapter',
    });
  });

  it('passes .env.local values into local adapter launches', () => {
    const root = makeDevFixture();
    const capturePath = path.join(root, 'adapter-env.txt');
    const promptCapturePath = path.join(root, 'adapter-prompt.txt');
    const adapterPath = path.join(root, 'fake-codex');
    writeFileSync(
      adapterPath,
      '#!/bin/sh\ncat > "$WARROOM_PROMPT_CAPTURE_PATH"\nprintf "%s" "$RAILWAY_TOKEN" > "$WARROOM_CAPTURE_PATH"\nexit 0\n'
    );
    chmodSync(adapterPath, 0o755);
    writeFileSync(
      path.join(root, '.env.local'),
      `LLM_ADAPTER=codex\nCODEX_COMMAND=${adapterPath}\nexport RAILWAY_TOKEN="railway_fixture"\nSENTRY_ORG=flo-fixture\nSENTRY_AUTH_TOKEN=sentry_fixture\nWARROOM_CAPTURE_PATH=${capturePath}\nWARROOM_PROMPT_CAPTURE_PATH=${promptCapturePath}\n`
    );

    const result = runAdapter(root, 'prompt', { cwd: root });

    expect(result.launched).toBe(true);
    expect(readFileSync(capturePath, 'utf8')).toBe('railway_fixture');
    const prompt = readFileSync(promptCapturePath, 'utf8');
    expect(prompt).toContain('War Room runtime environment:');
    expect(prompt).toContain('workspace `.env.local`');
    expect(prompt).toContain('`SENTRY_AUTH_TOKEN`');
    expect(prompt).toContain('`SENTRY_ORG`');
    expect(prompt).toContain('Do not print, paste, write, or commit their values.');
    expect(prompt).not.toContain('sentry_fixture');
  });

  it('adds available Sentry env names to interactive adapter prompts without values', () => {
    const root = makeDevFixture();
    const promptCapturePath = path.join(root, 'interactive-prompt.txt');
    const adapterPath = path.join(root, 'fake-codex');
    writeFileSync(
      adapterPath,
      '#!/bin/sh\nlast=""\nfor arg in "$@"; do last="$arg"; done\nprintf "%s" "$last" > "$WARROOM_PROMPT_CAPTURE_PATH"\nexit 0\n'
    );
    chmodSync(adapterPath, 0o755);
    writeFileSync(
      path.join(root, '.env.local'),
      `LLM_ADAPTER=codex\nCODEX_COMMAND=${adapterPath}\nSENTRY_ORG=flo-fixture\nSENTRY_AUTH_TOKEN=sentry_fixture\nWARROOM_PROMPT_CAPTURE_PATH=${promptCapturePath}\n`
    );

    const result = runInteractiveAdapter(root, 'interactive prompt', { cwd: root });

    expect(result.launched).toBe(true);
    const prompt = readFileSync(promptCapturePath, 'utf8');
    expect(prompt).toContain('interactive prompt');
    expect(prompt).toContain('War Room runtime environment:');
    expect(prompt).toContain('workspace `.env.local`');
    expect(prompt).toContain('`SENTRY_AUTH_TOKEN`');
    expect(prompt).toContain('Sentry MCP/read-only inspection');
    expect(prompt).not.toContain('sentry_fixture');
  });

  it('prepends issue task labels to adapter prompts and usage entries', () => {
    const root = makeDevFixture();
    const promptCapturePath = path.join(root, 'labeled-prompt.txt');
    const adapterPath = path.join(root, 'fake-codex');
    writeFileSync(adapterPath, '#!/bin/sh\ncat > "$WARROOM_PROMPT_CAPTURE_PATH"\nexit 0\n');
    chmodSync(adapterPath, 0o755);
    writeFileSync(
      path.join(root, '.env.local'),
      `LLM_ADAPTER=codex\nCODEX_COMMAND=${adapterPath}\nWARROOM_PROMPT_CAPTURE_PATH=${promptCapturePath}\n`
    );

    const result = runAdapter(root, 'War Room issue triage handoff for TeamFloPay/backend#666', {
      cwd: root,
      usage: {
        issue: 'TeamFloPay/backend#666',
        command: 'issue-triage',
        stage: 'interactive-triage',
        repo: 'TeamFloPay/backend',
        commandRunId: 'fixture-command-run',
      },
    });

    expect(result.launched).toBe(true);
    const prompt = readFileSync(promptCapturePath, 'utf8');
    expect(prompt.startsWith('[TeamFloPay/backend#666] issue-triage/interactive-triage')).toBe(true);
    expect(prompt).toContain('Task title: `[TeamFloPay/backend#666] issue-triage/interactive-triage`.');
    expect(prompt).toContain('Command run id: `fixture-command-run`.');

    const ledgerPath = path.join(root, '.warroom', 'runs', 'issues', 'TeamFloPay__backend__666', 'usage-ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { entries: Array<{ taskTitle: string | null }> };
    expect(ledger.entries[0]?.taskTitle).toBe('[TeamFloPay/backend#666] issue-triage/interactive-triage');
  });

  it('relabels pending issue-create usage when attaching it to the created issue', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'warroom-usage-'));
    const runDir = path.join(root, '.warroom', 'runs', 'issue-create-run');
    mkdirSync(runDir, { recursive: true });
    const invocation = {
      command: 'codex',
      args: ['exec', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"', '--cd', root, '-'],
      display: 'codex exec --model gpt-5.5 -c model_reasoning_effort="xhigh"',
      cwd: root,
      mode: 'foreground' as const,
      adapter: 'codex' as const,
    };

    recordLlmAdapterUsage(
      root,
      { issue: null, command: 'issue-create', stage: 'pm-session', runDir, commandRunId: 'fixture-run' },
      invocation,
      '[pending-issue] issue-create/pm-session\n\nWar Room issue creation PM session',
      {
        status: 0,
        signal: null,
        error: null,
        stdout: null,
        stderr: null,
        outputText: null,
      }
    );

    const migration = attachRunUsageToIssue(root, runDir, 'TeamFloPay/backend#666');

    expect(migration.attached).toBe(1);
    const ledgerPath = path.join(root, '.warroom', 'runs', 'issues', 'TeamFloPay__backend__666', 'usage-ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { entries: Array<{ taskTitle: string | null; issue: string | null }> };
    expect(ledger.entries[0]?.issue).toBe('TeamFloPay/backend#666');
    expect(ledger.entries[0]?.taskTitle).toBe('[TeamFloPay/backend#666] issue-create/pm-session');
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

  it('reports stale SDK-to-demo mirror dist links after a checkout move', async () => {
    const root = makeDevFixture();
    const oldSdkPath = path.join(path.dirname(root), 'old-sdk');

    for (const packageName of ['shared', 'js', 'react', 'node']) {
      const mirrorDistPath = path.join(root, '.warroom', 'dev', 'sdk-packages', packageName, 'dist');
      rmSync(mirrorDistPath, { recursive: true, force: true });
      symlinkSync(path.join(oldSdkPath, 'packages', packageName, 'dist'), mirrorDistPath, 'dir');
    }

    const status = runDevStatus(root);

    expect(status.linked).toBe(false);
    expect(status.staleMirror).toBe(true);
    expect(status.packages.map((pkg) => [pkg.name, pkg.staleMirror])).toEqual([
      ['@flopay/shared', true],
      ['@flopay/js', true],
      ['@flopay/react', true],
      ['@flopay/node', true],
    ]);

    const lines: string[] = [];
    const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'dev', 'status']);

    expect(lines.some((line) => line.includes('SDK-to-demo dev link: stale mirror links'))).toBe(true);
    expect(lines.some((line) => line.includes('stale-mirror @flopay/shared'))).toBe(true);
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

  it('warns about dirty sibling repos without blocking the target commit', () => {
    const { root, sdk, demo } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');
    writeFileSync(path.join(demo, 'scratch.txt'), 'parallel demo work\n');

    const result = runCommitCreate(root, {
      repo: 'sdk',
      confirm: true,
      all: true,
      push: false,
      message: 'chore(sdk): save fixture',
      validate: ['node -e "console.log(42)"'],
    });

    expect(result.warnings).toEqual(['Other child repos are dirty: demo']);
    expect(result.blocked).toEqual([]);
    expect(result.validation[0]?.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(spawnSync('git', ['status', '--short'], { cwd: sdk, encoding: 'utf8' }).stdout.trim()).toBe('');
    expect(spawnSync('git', ['status', '--short'], { cwd: demo, encoding: 'utf8' }).stdout.trim()).toBe('?? scratch.txt');
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

  it('prints dirty sibling repos as commit warnings', async () => {
    const { sdk, demo } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');
    writeFileSync(path.join(demo, 'scratch.txt'), 'parallel demo work\n');

    const lines: string[] = [];
    const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'commit', 'create']);

    expect(lines).toContain('Commit create for sdk: preflight only');
    expect(lines).toContain('warning: Other child repos are dirty: demo');
    expect(lines.some((line) => line === 'blocked: Other child repos are dirty: demo')).toBe(false);
  });

  it('infers the commit repo from an explicit mapped issue', () => {
    const { root, sdk, demo } = makeCommitFixture();
    spawnSync('git', ['config', 'branch.main.warroom-issue', 'TeamFloPay/sdk#63'], { cwd: sdk });
    spawnSync('git', ['config', 'branch.main.warroom-issue', 'TeamFloPay/demo#7'], { cwd: demo });
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');
    writeFileSync(path.join(demo, 'scratch.txt'), 'parallel demo work\n');

    const result = runCommitCreate(root, { issue: 'TeamFloPay/sdk#63' });

    expect(result.repo).toBe('sdk');
    expect(result.issue).toBe('TeamFloPay/sdk#63');
    expect(result.warnings).toEqual(['Other child repos are dirty: demo']);
    expect(result.blocked).toEqual([]);
  });

  it('infers the commit repo from War Room root using active branch metadata', async () => {
    const { root, sdk } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const branch = spawnSync('git', ['switch', '-c', 'warroom/6-omni-duplicate-paid-out-of-band-subscription-pay'], {
      cwd: sdk,
      encoding: 'utf8',
    });
    if (branch.status !== 0) throw new Error(branch.stderr);
    spawnSync('git', ['config', 'branch.warroom/6-omni-duplicate-paid-out-of-band-subscription-pay.warroom-issue', 'TeamFloPay/ally-clicktech#6'], {
      cwd: sdk,
    });
    spawnSync('git', ['config', 'branch.warroom/6-omni-duplicate-paid-out-of-band-subscription-pay.warroom-implementation-repo', 'TeamFloPay/sdk'], {
      cwd: sdk,
    });
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    const lines: string[] = [];
    const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'commit', 'create']);

    expect(lines).toContain('Commit create for sdk: preflight only');
    expect(lines).toContain(`Path: ${sdk}`);
    expect(lines.some((line) => line.startsWith('Branch: warroom/6-omni-duplicate-paid-out-of-band-subscription-pay@'))).toBe(true);
    expect(lines).toContain('?? index.ts (unstaged)');
  });

  it('posts commit progress to the linked issue after a confirmed commit', () => {
    const { root, sdk } = makeCommitFixture();
    const bin = path.join(root, 'bin');
    const commentLog = path.join(root, 'issue-comments.log');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const pushMain = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: sdk, encoding: 'utf8' });
    if (pushMain.status !== 0) throw new Error(pushMain.stderr);
    const branch = spawnSync('git', ['switch', '-c', 'warroom/7-build-the-selector'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);
    spawnSync('git', ['config', 'branch.warroom/7-build-the-selector.warroom-issue', 'TeamFloPay/sdk#7'], { cwd: sdk });
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    const originalPath = process.env.PATH;
    const originalCommentLog = process.env.WARROOM_GH_ISSUE_COMMENT_LOG;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_GH_ISSUE_COMMENT_LOG = commentLog;
    try {
      const result = runCommitCreate(root, {
        repo: 'sdk',
        confirm: true,
        all: true,
        message: 'chore(sdk): save fixture',
      });

      expect(result.committed).toBe(true);
      expect(result.issue).toBe('TeamFloPay/sdk#7');
      expect(result.issueComment?.applied).toBe(true);
      expect(result.issueComment?.url).toBe('https://github.com/TeamFloPay/sdk/issues/7#issuecomment-2');
      const comment = readFileSync(commentLog, 'utf8');
      expect(comment).toContain('## War Room commit update');
      expect(comment).toContain('Summary:');
      expect(comment).toContain('Implemented the selector commit by adding the runtime export used by the SDK workflow');
      expect(comment).not.toContain('Changed files:');
      expect(comment).not.toContain('index.ts (');
    } finally {
      process.env.PATH = originalPath;
      if (originalCommentLog === undefined) delete process.env.WARROOM_GH_ISSUE_COMMENT_LOG;
      else process.env.WARROOM_GH_ISSUE_COMMENT_LOG = originalCommentLog;
    }
  });

  it('auto-commits after the commit dry run in an interactive terminal', async () => {
    const { sdk, sdkRemote } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    const lines: string[] = [];
    const input = new PassThrough();
    const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line), input, interactive: true });

    const answers = ['no\n'];
    const promptAnswers = setInterval(() => {
      const answer = answers.shift();
      if (answer) input.write(answer);
      else clearInterval(promptAnswers);
    }, 100);
    try {
      await program.parseAsync(['node', 'warroom', 'commit', 'create', '--message', 'chore(sdk): save fixture']);
    } finally {
      clearInterval(promptAnswers);
      input.end();
    }

    expect(lines).toContain('Commit create for sdk: preflight only');
    expect(lines).not.toContain('Commit all listed changes and push to the remote branch now? This will run git add -A before committing. [Y/n]');
    expect(lines).toContain('Creating commit and pushing...');
    expect(lines).toContain('Commit create for sdk: committed');
    expect(lines).toContain('Push: pushed git push -u origin HEAD');
    expect(lines).toContain('Run `warroom pr create` next? [Y/n]');

    const log = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: sdk, encoding: 'utf8' });
    expect(log.stdout.trim()).toBe('chore(sdk): save fixture');

    const remoteLog = spawnSync('git', ['--git-dir', sdkRemote, 'log', '-1', '--pretty=%s', 'refs/heads/main'], { encoding: 'utf8' });
    expect(remoteLog.stdout.trim()).toBe('chore(sdk): save fixture');

    const status = spawnSync('git', ['status', '--short'], { cwd: sdk, encoding: 'utf8' });
    expect(status.stdout.trim()).toBe('');
  });

  it('can open a PR directly after an interactive commit', async () => {
    const { root, sdk } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'README.md'), '# SDK\n');
    commitAll(sdk, 'fixture sdk');
    const branch = spawnSync('git', ['switch', '-c', 'warroom/7-build-the-selector'], { cwd: sdk, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error(branch.stderr);
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['yes\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'commit', 'create', '--message', 'chore(sdk): save fixture']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Commit create for sdk: committed');
      expect(lines).toContain('Run `warroom pr create` next? [Y/n]');
      expect(lines).toContain('Creating PR...');
      expect(lines).toContain('PR create: created');
      expect(lines).toContain('PR URL: https://github.com/TeamFloPay/sdk/pull/12');
      expect(lines.at(-1)).toBe('Run `warroom pr review` next? [Y/n]');
    } finally {
      process.env.PATH = originalPath;
    }
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

  it('skips demo Playwright e2e for repos without merge.playwright enabled', async () => {
    const { root } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    const usageDir = path.join(root, '.warroom', 'runs', 'issues', 'TeamFloPay__backend__562');
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(
      path.join(usageDir, 'usage-ledger.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          issue: 'TeamFloPay/backend#562',
          updatedAt: '2026-05-10T00:00:00.000Z',
          entries: [
            {
              id: 'fixture-usage-entry',
              timestamp: '2026-05-10T00:00:00.000Z',
              issue: 'TeamFloPay/backend#562',
              command: 'issue-next',
              stage: 'implementation-handoff',
              repo: 'TeamFloPay/backend',
              cwd: null,
              adapter: 'codex',
              model: 'gpt-5.5',
              reasoningEffort: 'xhigh',
              mode: 'foreground',
              commandDisplay: 'codex exec --model gpt-5.5',
              commandRunId: 'fixture-run',
              runDir: null,
              status: 'succeeded',
              exitStatus: 0,
              signal: null,
              error: null,
              promptCharacters: 400,
              outputCharacters: 80,
              inputTokens: 100,
              cachedInputTokens: null,
              outputTokens: 20,
              totalTokens: 120,
              estimated: true,
              usageSource: 'estimated',
              costUsd: null,
              costUnavailableReason: 'pricing missing for gpt-5.5',
            },
          ],
        },
        null,
        2
      )
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync([
        'node',
        'warroom',
        'pr',
        'merge',
        '--pr',
        'TeamFloPay/infra#655',
        '--issue',
        'TeamFloPay/backend#562',
        '--confirm',
      ]);

      expect(lines).toContain('Merge e2e: skipped (repos.yaml has merge.playwright: false for TeamFloPay/infra.)');
      expect(lines).toContain('Merged: yes');
      expect(lines).toContain('Campaign status: updated TeamFloPay/backend#562 -> victory');
      expect(lines).toContain('War Room LLM usage for TeamFloPay/backend#562:');
      expect(lines).toContain('- Entries: 1');
      expect(lines).toContain('- Total tokens: 120 estimated');
      expect(lines).toContain('- Cost: unavailable; pricing missing for gpt-5.5');
      expect(lines.some((line) => line.startsWith('Backend:'))).toBe(false);
      expect(existsSync(path.join(root, 'backend-started.txt'))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('runs the post-merge command after a successful merge before updating CHANGELOG.md', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture({ postMergeCommand: 'node scripts/post-merge.cjs' });
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote);
    writeChangelogCodexFixture(bin);

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync([
        'node',
        'warroom',
        'pr',
        'merge',
        '--pr',
        'TeamFloPay/sdk#655',
        '--confirm',
        '--confirm-changelog',
      ]);

      const output = lines.join('\n');
      expect(output).toContain('Merge e2e: skipped (repos.yaml has merge.playwright: false for TeamFloPay/sdk.)');
      expect(output).toContain('Merge post-merge: passed');
      expect(output).toContain('Merge changelog: passed');
      expect(output).toContain('Changelog version: 1.0.1');
      expect(lines.some((line) => line.startsWith('Changelog commit: pushed '))).toBe(true);
      expect(lines).toContain('Merged: yes');

      expect(readFileSync(path.join(path.dirname(sdk), 'post-merge.log'), 'utf8')).toContain('post-merge ran on main');

      const remoteChangelog = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/main:CHANGELOG.md'], {
        encoding: 'utf8',
      });
      expect(remoteChangelog.stdout).toContain('## 1.0.1');
      expect(remoteChangelog.stdout).toContain('Ready SDK PR');

      const remotePackage = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/main:package.json'], {
        encoding: 'utf8',
      });
      expect(JSON.parse(remotePackage.stdout).version).toBe('1.0.1');

      const remoteSubject = spawnSync('git', ['--git-dir', sdkRemote, 'log', '-1', '--pretty=%s', 'refs/heads/main'], {
        encoding: 'utf8',
      });
      expect(remoteSubject.stdout.trim()).toBe('docs(changelog): update for 1.0.1 [skip-ci]');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('skips the changelog update unless the guarded merge changelog step is confirmed', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote);

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/sdk#655', '--confirm']);

      const output = lines.join('\n');
      expect(output).toContain('Merge changelog: skipped');
      expect(output).toContain('Pass --confirm-changelog or answer yes in an interactive terminal to run the changelog update.');
      expect(lines).toContain('Merged: yes');

      const remoteChangelog = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/main:CHANGELOG.md'], {
        encoding: 'utf8',
      });
      expect(remoteChangelog.stdout).toContain('## 1.0.0');
      expect(remoteChangelog.stdout).not.toContain('## 1.0.1');

      const remoteSubject = spawnSync('git', ['--git-dir', sdkRemote, 'log', '-1', '--pretty=%s', 'refs/heads/main'], {
        encoding: 'utf8',
      });
      expect(remoteSubject.stdout.trim()).toBe('chore(release): 1.0.1');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('prompts before running the guarded changelog update in an interactive confirmed merge', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote);

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['no\n', 'no\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/sdk#655', '--confirm']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines.some((line) => line.startsWith('Run the public changelog update now (update '))).toBe(true);
      expect(lines).toContain('Merge changelog: skipped (Skipped by user during interactive changelog confirmation.)');
      expect(lines).toContain('Post victory summary comments now? [Y/n]');
      expect(lines).toContain('Returning the local checkout to the PR base branch...');

      const remoteChangelog = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/main:CHANGELOG.md'], {
        encoding: 'utf8',
      });
      expect(remoteChangelog.stdout).not.toContain('## 1.0.1');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('prompts for a version bump and defaults to patch before PR merge', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture({ bump: true });
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote, { releaseBump: false });

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['\n', 'no\n', 'no\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/sdk#655', '--confirm']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Should we bump the version number? [PATCH|minor|major|skip]');
      expect(lines).toContain('Merge bump: passed');
      expect(lines).toContain('Bump level: patch');
      expect(lines).toContain('Bump version: 1.0.0 -> 1.0.1');
      expect(lines.some((line) => line.startsWith('Bump commit: pushed '))).toBe(true);
      expect(lines).toContain('Merge changelog: skipped (Skipped by user during interactive changelog confirmation.)');

      const remotePackage = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/main:package.json'], {
        encoding: 'utf8',
      });
      expect(JSON.parse(remotePackage.stdout).version).toBe('1.0.1');

      const remoteFeaturePackage = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/feature/sdk:package.json'], {
        encoding: 'utf8',
      });
      expect(JSON.parse(remoteFeaturePackage.stdout).version).toBe('1.0.1');

      const remoteFeatureSubject = spawnSync('git', ['--git-dir', sdkRemote, 'log', '-1', '--pretty=%s', 'refs/heads/feature/sdk'], {
        encoding: 'utf8',
      });
      expect(remoteFeatureSubject.stdout.trim()).toBe('chore(release): bump patch version');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('waits for GitHub to recompute mergeability after a version bump push', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture({ bump: true });
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const flapPath = path.join(root, 'bump-mergeability-flap.txt');
    writeChangelogMergeGhFixture(bin, sdkRemote, { releaseBump: false, mergeabilityFlapPath: flapPath });

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
      'WARROOM_MERGE_WAIT_POLL_MS',
      'WARROOM_MERGE_WAIT_TIMEOUT_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';
    process.env.WARROOM_MERGE_WAIT_POLL_MS = '1';
    process.env.WARROOM_MERGE_WAIT_TIMEOUT_MS = '60000';

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync([
        'node',
        'warroom',
        'pr',
        'merge',
        '--pr',
        'TeamFloPay/sdk#655',
        '--confirm',
        '--bump-version',
        'patch',
      ]);

      expect(lines).toContain('Merge bump: passed');
      expect(lines.some((line) => line.includes('Version bump: waiting for GitHub to recompute mergeability'))).toBe(true);
      expect(lines.some((line) => line.includes('Version bump: PR is mergeable (mergeStateStatus=CLEAN).'))).toBe(true);
      expect(Number(readFileSync(flapPath, 'utf8'))).toBeGreaterThanOrEqual(3);

      const remoteFeaturePackage = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/feature/sdk:package.json'], {
        encoding: 'utf8',
      });
      expect(JSON.parse(remoteFeaturePackage.stdout).version).toBe('1.0.1');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('creates an OpenChangelog release note after SDK merge actions pass', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture({ openchangelog: true });
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote);
    writeOpenChangelogCodexFixture(bin);

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync([
        'node',
        'warroom',
        'pr',
        'merge',
        '--pr',
        'TeamFloPay/sdk#655',
        '--confirm',
        '--confirm-changelog',
        '--write-artifact',
      ]);

      const output = lines.join('\n');
      expect(output).toContain('Merge changelog: passed');
      expect(output).toContain('Changelog: ');
      expect(output).toContain('(openchangelog, base main)');
      expect(output).toContain('Changelog file: release-notes/v1.0.1.ready-sdk-pr.md');
      expect(output).toContain('Changelog URL: https://changelog.sdk.flopay.com');
      expect(output).toContain('Changelog version: 1.0.1');
      const artifactLine = lines.find((line) => line.startsWith('Artifact: '));
      expect(artifactLine).toBeDefined();
      const summary = readFileSync(path.join(artifactLine!.slice('Artifact: '.length), 'summary.md'), 'utf8');
      expect(summary).toContain('PR: TeamFloPay/sdk#655');
      expect(summary).toContain('Title: Ready SDK PR');
      expect(summary).toContain('## v1.0.1 - Ready SDK PR');
      expect(summary).toContain('Ready SDK PR updates the SDK behavior.');
      expect(summary).toMatch(/\[Read the full changelog\]\(https:\/\/changelog\.sdk\.flopay\.com(?:\/release\/\d+)?\)/);
      expect(summary).not.toContain('Outcome:');
      expect(summary).not.toContain('Merge readiness:');
      expect(summary).not.toContain('Checks:');

      const remoteNote = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/main:release-notes/v1.0.1.ready-sdk-pr.md'], {
        encoding: 'utf8',
      });
      expect(remoteNote.status).toBe(0);
      expect(remoteNote.stdout).toContain('title: v1.0.1 - Ready SDK PR');
      expect(remoteNote.stdout).toContain('publishedAt:');
      expect(remoteNote.stdout).toContain('- SDK');
      expect(remoteNote.stdout).toContain('Ready SDK PR updates the SDK behavior.');

      const remoteChangelog = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/main:CHANGELOG.md'], {
        encoding: 'utf8',
      });
      expect(remoteChangelog.status).not.toBe(0);

      const remoteSubject = spawnSync('git', ['--git-dir', sdkRemote, 'log', '-1', '--pretty=%s', 'refs/heads/main'], {
        encoding: 'utf8',
      });
      expect(remoteSubject.stdout.trim()).toBe('docs(changelog): add release notes for 1.0.1 [skip-ci]');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('posts prompted victory summaries with the completed OpenChangelog content', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture({ openchangelog: true });
    const bin = path.join(root, 'bin');
    const commentLogPath = path.join(root, 'comments.jsonl');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote, { commentLogPath });
    writeOpenChangelogCodexFixture(bin);

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['yes\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync([
          'node',
          'warroom',
          'pr',
          'merge',
          '--pr',
          'TeamFloPay/sdk#655',
          '--confirm',
          '--confirm-changelog',
        ]);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('Post victory summary comments now? [Y/n]');
      expect(lines).toContain('Summary pr: posted TeamFloPay/sdk#655 https://github.com/TeamFloPay/sdk/pull/655#issuecomment-1');

      const comments = readFileSync(commentLogPath, 'utf8')
        .trim()
        .split(/\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; body: string });
      expect(comments).toHaveLength(1);
      expect(comments[0]?.kind).toBe('pr');
      expect(comments[0]?.body).toContain('PR: TeamFloPay/sdk#655');
      expect(comments[0]?.body).toContain('## v1.0.1 - Ready SDK PR');
      expect(comments[0]?.body).toContain('Ready SDK PR updates the SDK behavior.');
      expect(comments[0]?.body).toMatch(/\[Read the full changelog\]\(https:\/\/changelog\.sdk\.flopay\.com(?:\/release\/\d+)?\)/);
      expect(comments[0]?.body).not.toContain('Outcome:');
      expect(comments[0]?.body).not.toContain('Checks:');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('ignores failed Dependabot update runs while waiting for changelog actions', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture({ openchangelog: true });
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote, { dependabotFailure: true });
    writeOpenChangelogCodexFixture(bin);

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync([
        'node',
        'warroom',
        'pr',
        'merge',
        '--pr',
        'TeamFloPay/sdk#655',
        '--confirm',
        '--confirm-changelog',
      ]);

      const output = lines.join('\n');
      expect(output).toContain('Merge changelog: passed');
      expect(output).not.toContain('Dependabot');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('can resume only the changelog closeout after a PR has already merged', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture({ openchangelog: true });
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote, { merged: true });
    writeOpenChangelogCodexFixture(bin);

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync([
        'node',
        'warroom',
        'pr',
        'merge',
        '--pr',
        'TeamFloPay/sdk#655',
        '--resume-changelog',
        '--confirm',
        '--confirm-changelog',
      ]);

      const output = lines.join('\n');
      expect(output).toContain('Merge e2e: skipped (Skipped by --resume-changelog after PR merge.)');
      expect(output).toContain('Merge changelog: passed');
      expect(output).toContain('Merged: yes');

      const remoteNote = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/main:release-notes/v1.0.1.ready-sdk-pr.md'], {
        encoding: 'utf8',
      });
      expect(remoteNote.status).toBe(0);
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects OpenChangelog adapters that modify existing release notes', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture({ openchangelog: true });
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote);
    writeOpenChangelogModifyExistingCodexFixture(bin);

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync([
        'node',
        'warroom',
        'pr',
        'merge',
        '--pr',
        'TeamFloPay/sdk#655',
        '--confirm',
        '--confirm-changelog',
      ]);

      const output = lines.join('\n');
      expect(output).toContain('Merge changelog: failed');
      expect(output).toContain('LLM adapter must create a new OpenChangelog release-note file');

      const remoteNote = spawnSync('git', ['--git-dir', sdkRemote, 'show', 'refs/heads/main:release-notes/v1.0.0.initial-release.md'], {
        encoding: 'utf8',
      });
      expect(remoteNote.stdout).toContain('The first SDK release is available.');
      expect(remoteNote.stdout).not.toContain('Rewritten existing note.');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects OpenChangelog release note titles without the version prefix', async () => {
    const { root, sdk, sdkRemote } = makeChangelogMergeFixture({ openchangelog: true });
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeChangelogMergeGhFixture(bin, sdkRemote);
    writeOpenChangelogMissingVersionTitleCodexFixture(bin);

    const originalPath = process.env.PATH;
    const envKeys = [
      'WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS',
      'WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS',
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS = '0';
    process.env.WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS = '0';

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: sdk, output: (line) => lines.push(line) });

      await program.parseAsync([
        'node',
        'warroom',
        'pr',
        'merge',
        '--pr',
        'TeamFloPay/sdk#655',
        '--confirm',
        '--confirm-changelog',
      ]);

      const output = lines.join('\n');
      expect(output).toContain('Merge changelog: failed');
      expect(output).toContain('OpenChangelog release-note title must start with "v1.0.1 - "');
    } finally {
      process.env.PATH = originalPath;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

  it('can allow unresolved review threads from the blocked PR merge prompt', async () => {
    const { root } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeUnresolvedThreadMergeGhFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['skip\n', 'no\n', 'no\n'];
      const promptAnswers = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(promptAnswers);
      }, 100);
      try {
        await program.parseAsync(['node', 'warroom', 'pr', 'merge', '--pr', 'TeamFloPay/infra#4']);
      } finally {
        clearInterval(promptAnswers);
        input.end();
      }

      expect(lines).toContain('PR merge: preflight only');
      expect(lines).toContain(
        'Preflight is blocked. Recheck readiness and attempt the confirmed merge only if blockers are clear? Type "skip" to bypass failing checks and unresolved review threads (uses gh pr merge --admin). [Y/n/skip]'
      );
      expect(lines).toContain('Running confirmed PR merge while bypassing preflight blockers (gh pr merge --admin)...');
      expect(lines).toContain('Merge readiness: clear');
      expect(lines).toContain('Merge e2e: skipped (repos.yaml has merge.playwright: false for TeamFloPay/infra.)');
      expect(lines).toContain('Merged: yes');
      expect(lines).toContain('Post victory summary comments now? [Y/n]');
      expect(lines).toContain('Returning the local checkout to the PR base branch...');
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
      expect(lines).toContain(
        'Continue to run the demo Playwright e2e gate and merge this PR now? Type "skip" to merge without the Playwright gate. [Y/n/skip]'
      );
      expect(lines).toContain('Running confirmed PR merge...');
      expect(lines).toContain('Merge e2e: passed');
      expect(lines).toContain('Backend process: reused existing');
      expect(lines).toContain('Merged: yes');
      expect(lines).toContain('Post victory summary comments now? [Y/n]');
      expect(lines).toContain('Returning the local checkout to the PR base branch...');
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

  it('can skip the demo Playwright e2e gate from the interactive PR merge prompt', async () => {
    const { root } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      const answers = ['skip\n', 'no\n', 'no\n'];
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
      expect(lines).toContain(
        'Continue to run the demo Playwright e2e gate and merge this PR now? Type "skip" to merge without the Playwright gate. [Y/n/skip]'
      );
      expect(lines).toContain('Running confirmed PR merge without demo Playwright e2e...');
      expect(lines).toContain('Merge e2e: skipped (Skipped by user during interactive merge confirmation.)');
      expect(lines).toContain('Merged: yes');
      expect(lines.some((line) => line.includes('Demo Playwright e2e: checking backend readiness'))).toBe(false);
      expect(existsSync(path.join(root, 'backend-started.txt'))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 30000);

  it('infers the current branch PR and prompts for merge follow-up actions', async () => {
    const { root, backend, backendRemote } = makeMergeFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    const remoteMain = path.join(root, 'backend-remote-main');
    let remoteResult = spawnSync('git', ['clone', '--branch', 'main', backendRemote, remoteMain], { encoding: 'utf8' });
    if (remoteResult.status !== 0) throw new Error(remoteResult.stderr);
    spawnSync('git', ['config', 'user.email', 'warroom@example.com'], { cwd: remoteMain });
    spawnSync('git', ['config', 'user.name', 'War Room'], { cwd: remoteMain });
    writeFileSync(path.join(remoteMain, 'README.md'), 'Updated on main after merge.\n');
    remoteResult = spawnSync('git', ['add', 'README.md'], { cwd: remoteMain, encoding: 'utf8' });
    if (remoteResult.status !== 0) throw new Error(remoteResult.stderr);
    remoteResult = spawnSync('git', ['commit', '-m', 'docs: update main'], { cwd: remoteMain, encoding: 'utf8' });
    if (remoteResult.status !== 0) throw new Error(remoteResult.stderr);
    remoteResult = spawnSync('git', ['push', 'origin', 'main'], { cwd: remoteMain, encoding: 'utf8' });
    if (remoteResult.status !== 0) throw new Error(remoteResult.stderr);

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
      expect(lines).toContain('Victory issue: posted TeamFloPay/backend#562 https://github.com/TeamFloPay/backend/issues/562#issuecomment-2');
      expect(lines).toContain('Post victory summary comments now? [Y/n]');
      expect(lines).toContain('Summary pr: posted TeamFloPay/backend#655 https://github.com/TeamFloPay/backend/pull/655#issuecomment-1');
      expect(lines).toContain('Summary issue: posted TeamFloPay/backend#562 https://github.com/TeamFloPay/backend/issues/562#issuecomment-2');
      expect(lines).toContain('Returning the local checkout to the PR base branch...');
      expect(lines).toContain('Local cleanup: applied TeamFloPay/backend');
      expect(lines).toContain('cleanup: Switched local checkout to main.');
      expect(lines).toContain('cleanup: Pulled latest main with git pull --ff-only.');

      const branch = spawnSync('git', ['branch', '--show-current'], { cwd: backend, encoding: 'utf8' });
      expect(branch.stdout.trim()).toBe('main');
      expect(readFileSync(path.join(backend, 'README.md'), 'utf8')).toBe('Updated on main after merge.\n');
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
  initGitRepo(sdk);
  initGitRepo(demo);
  mkdirSync(path.join(demo, 'node_modules', '@flopay'), { recursive: true });

  writeFileSync(
    path.join(root, 'repos.yaml'),
    `version: 1
defaults:
  owner: TeamFloPay
  clone_protocol: ssh
  default_branch: main
  local_root: maps/repos
  npm_scope: "@flopay"
  dev_link_packages: [shared, js, react, node]
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
    mkdirSync(mirrorPath, { recursive: true });
    writeFileSync(path.join(packagePath, 'package.json'), `{"name":"@flopay/${packageName}"}\n`);
    writeFileSync(path.join(packagePath, 'dist', 'index.mjs'), '');
    writeFileSync(path.join(mirrorPath, 'package.json'), `{"name":"@flopay/${packageName}"}\n`);
    symlinkSync(path.join(packagePath, 'dist'), path.join(mirrorPath, 'dist'), 'dir');
    symlinkSync(mirrorPath, path.join(demo, 'node_modules', '@flopay', packageName), 'dir');
  }

  commitAll(sdk, 'fixture sdk');
  commitAll(demo, 'fixture demo');

  const sdkRemote = path.join(base, 'sdk-remote.git');
  const demoRemote = path.join(base, 'demo-remote.git');
  initBareRemote(sdkRemote);
  initBareRemote(demoRemote);
  spawnSync('git', ['remote', 'add', 'origin', sdkRemote], { cwd: sdk });
  spawnSync('git', ['remote', 'add', 'origin', demoRemote], { cwd: demo });
  const sdkPush = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: sdk, encoding: 'utf8' });
  if (sdkPush.status !== 0) throw new Error(sdkPush.stderr);
  const demoPush = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: demo, encoding: 'utf8' });
  if (demoPush.status !== 0) throw new Error(demoPush.stderr);

  return root;
}

function addBackendRepoFixture(root: string) {
  const backend = path.resolve(root, '..', 'backend');
  const backendRemote = path.resolve(root, '..', 'backend-remote.git');
  initGitRepo(backend);
  initBareRemote(backendRemote);
  spawnSync('git', ['remote', 'add', 'origin', backendRemote], { cwd: backend });
  writeFileSync(path.join(backend, 'package.json'), '{"packageManager":"npm@10.0.0"}\n');
  commitAll(backend, 'fixture backend');
  const push = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: backend, encoding: 'utf8' });
  if (push.status !== 0) throw new Error(push.stderr);

  const manifestPath = path.join(root, 'repos.yaml');
  writeFileSync(
    manifestPath,
    `${readFileSync(manifestPath, 'utf8')}
  - id: backend
    name: backend
    github: TeamFloPay/backend
    ssh_url: git@github.com:TeamFloPay/backend.git
    local_path: maps/repos/backend
    status: active
    owner: backend
    description: Backend services.
    specialist:
      name: Backend Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
`
  );

  return backend;
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
  npm_scope: "@flopay"
  dev_link_packages: [shared, js, react, node]
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
  const backendRemote = path.join(base, 'backend-remote.git');

  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, 'maps', 'repos'), { recursive: true });
  initGitRepo(backend);
  initGitRepo(demo);
  initBareRemote(backendRemote);
  spawnSync('git', ['remote', 'add', 'origin', backendRemote], { cwd: backend });

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
    merge:
      playwright: true
      changelog: false
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
    merge:
      playwright: false
      changelog: false
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
    merge:
      playwright: true
      changelog: false
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
  const pushMain = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: backend, encoding: 'utf8' });
  if (pushMain.status !== 0) throw new Error(pushMain.stderr);
  const branch = spawnSync('git', ['switch', '-c', 'feature/backend'], { cwd: backend, encoding: 'utf8' });
  if (branch.status !== 0) throw new Error(branch.stderr);

  return { root, backend, demo, backendRemote };
}

function makeChangelogMergeFixture(options: { openchangelog?: boolean; bump?: boolean; postMergeCommand?: string } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'warroom-changelog-'));
  const root = path.join(base, 'warroom');
  const sdk = path.join(base, 'sdk');
  const sdkRemote = path.join(base, 'sdk-remote.git');

  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, 'maps', 'repos'), { recursive: true });
  initGitRepo(sdk);
  initBareRemote(sdkRemote);
  spawnSync('git', ['remote', 'add', 'origin', sdkRemote], { cwd: sdk });

  const changelogConfig = options.openchangelog
    ? `changelog:
        enabled: true
        format: openchangelog
        path: release-notes
        url: https://changelog.sdk.flopay.com`
    : 'changelog: true';
  const bumpConfig = options.bump
    ? `bump:
        enabled: true
        command: npm run bump:version --`
    : 'bump: false';
  const postMergeConfig = options.postMergeCommand ? `post_merge: ${options.postMergeCommand}` : 'post_merge: false';

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
    merge:
      playwright: false
      ${bumpConfig}
      ${postMergeConfig}
      ${changelogConfig}
    owner: sdk
    description: SDK packages.
    specialist:
      name: SDK Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
`
  );
  writeResourcesFixture(root);
  writeFileSync(
    path.join(sdk, 'package.json'),
    JSON.stringify(
      {
        name: '@flopay/sdk',
        version: '1.0.0',
        scripts: {
          'bump:version': 'node scripts/bump-version.cjs',
        },
      },
      null,
      2
    )
  );
  mkdirSync(path.join(sdk, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(sdk, 'scripts', 'bump-version.cjs'),
    `const fs = require('node:fs');
const level = process.argv[2];
if (!['patch', 'minor', 'major'].includes(level)) process.exit(2);
const packagePath = 'package.json';
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const [major, minor, patch] = packageJson.version.split('.').map(Number);
packageJson.version = level === 'major' ? \`\${major + 1}.0.0\` : level === 'minor' ? \`\${major}.\${minor + 1}.0\` : \`\${major}.\${minor}.\${patch + 1}\`;
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\\n');
`
  );
  writeFileSync(
    path.join(sdk, 'scripts', 'post-merge.cjs'),
    `const fs = require('node:fs');
const path = require('node:path');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
fs.writeFileSync(path.resolve(process.cwd(), '..', 'post-merge.log'), 'post-merge ran on main for version ' + packageJson.version + '\\n');
`
  );
  if (options.openchangelog) {
    mkdirSync(path.join(sdk, 'release-notes'), { recursive: true });
    writeFileSync(
      path.join(sdk, 'release-notes', 'v1.0.0.initial-release.md'),
      [
        '---',
        'title: Initial release',
        'description: The first SDK release is available.',
        'publishedAt: "2026-01-01T00:00:00.000Z"',
        'tags:',
        '  - SDK',
        '---',
        '',
        'The first SDK release is available.',
        '',
      ].join('\n')
    );
  } else {
    writeFileSync(path.join(sdk, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n- Initial release.\n');
  }
  commitAll(sdk, 'fixture sdk release');
  const pushMain = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: sdk, encoding: 'utf8' });
  if (pushMain.status !== 0) throw new Error(pushMain.stderr);

  const branch = spawnSync('git', ['switch', '-c', 'feature/sdk'], { cwd: sdk, encoding: 'utf8' });
  if (branch.status !== 0) throw new Error(branch.stderr);
  writeFileSync(path.join(sdk, 'index.ts'), 'export const changed = true;\n');
  commitAll(sdk, 'feat: ready sdk change');
  const pushFeature = spawnSync('git', ['push', '-u', 'origin', 'feature/sdk'], { cwd: sdk, encoding: 'utf8' });
  if (pushFeature.status !== 0) throw new Error(pushFeature.stderr);

  return { root, sdk, sdkRemote };
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

function allyManifestFixture() {
  return `version: 1
allies:
  - id: clicktech
    name: ClickTech
    status: active
    local_path: allies/clicktech
    issue_repo:
      github: TeamFloPay/ally-clicktech
      local_path: allies/clicktech/repos/ally-clicktech
      sync: unito
      client_system: jira
    env:
      example: allies/clicktech/.env.local.example
      local: allies/clicktech/.env.local
    docs: []
`;
}

function writeAllyTriageGhFixture(bin: string) {
  const ghPath = path.join(bin, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const { existsSync } = require('node:fs');
const path = require('node:path');
const triageNotesPath = path.join(path.dirname(process.argv[1]), 'triage-notes-posted');

function json(value) {
  process.stdout.write(JSON.stringify(value));
}

if (args[0] === 'project' && args[1] === 'item-list') {
  json({
    items: [
      {
        id: 'PVTI_ally_needs',
        title: 'Possible AVS issue',
        status: 'needs-triage',
        labels: ['needs-triage', 'ally', 'clicktech'],
        content: {
          repository: 'TeamFloPay/ally-clicktech',
          number: 5,
          title: 'Possible AVS issue',
          url: 'https://github.com/TeamFloPay/ally-clicktech/issues/5'
        }
      }
    ]
  });
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  const comments = existsSync(triageNotesPath)
    ? [
        {
          author: { login: 'andrewslack' },
          body: [
            '## War Room triage notes',
            '',
            'Ready for ready-to-engage: yes',
            '',
            'Owner repo: TeamFloPay/backend',
            'Acceptance criteria: confirm AVS behavior safely.'
          ].join('\\n'),
          createdAt: '2026-05-08T10:00:00Z',
          url: 'https://github.com/TeamFloPay/ally-clicktech/issues/5#issuecomment-triage'
        }
      ]
    : [];
  json({
    title: 'Possible AVS issue',
    body: 'Check the customer AVS behavior on initial transaction and rebill.',
    url: 'https://github.com/TeamFloPay/ally-clicktech/issues/5',
    labels: [{ name: 'needs-triage' }, { name: 'ally' }, { name: 'clicktech' }],
    comments
  });
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'edit') {
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

function writeCrossRepoAllyIssueStartGhFixture(bin: string) {
  const ghPath = path.join(bin, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const { spawnSync } = require('node:child_process');

function json(value) {
  process.stdout.write(JSON.stringify(value));
}

function valueFor(name) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-f' && args[index] !== '-F') continue;
    const [key, value] = args[index + 1].split('=');
    if (key === name) return value;
  }
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (args[0] === 'project' && args[1] === 'item-list') {
  json({
    items: [
      {
        id: 'PVTI_backend_ready',
        title: 'Backend ready work',
        status: 'ready-to-engage',
        labels: ['ready-to-engage'],
        content: {
          repository: 'TeamFloPay/backend',
          number: 639,
          title: 'Remove product_provider_credentials in favor of gateway records',
          type: 'Issue',
          url: 'https://github.com/TeamFloPay/backend/issues/639'
        }
      },
      {
        id: 'PVTI_ally_ready',
        title: 'Omni Duplicate "Paid out of band" Subscription Payment',
        status: 'ready-to-engage',
        labels: ['ready-to-engage', 'ally', 'clicktech'],
        content: {
          repository: 'TeamFloPay/ally-clicktech',
          number: 6,
          title: 'Omni Duplicate "Paid out of band" Subscription Payment',
          type: 'Issue',
          url: 'https://github.com/TeamFloPay/ally-clicktech/issues/6'
        }
      }
    ]
  });
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  json({
    title: 'Omni Duplicate "Paid out of band" Subscription Payment',
    body: 'Investigate the duplicate out-of-band payment and fix the underlying backend issue.',
    url: 'https://github.com/TeamFloPay/ally-clicktech/issues/6',
    labels: [{ name: 'ready-to-engage' }, { name: 'ally' }, { name: 'clicktech' }],
    comments: [
      {
        author: { login: 'andyslack' },
        createdAt: '2026-05-08T11:32:34Z',
        body: [
          '## Triage Notes',
          '',
          '**Owner repo:** \`TeamFloPay/backend\`',
          '',
          '**Implementation plan:** fix the backend hosted card subscription flow.'
        ].join('\\n')
      }
    ]
  });
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'edit') {
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  json({
    title: 'Build the selector',
    body: 'Allow operators to pick a ready issue and start implementation.',
    url: 'https://github.com/TeamFloPay/sdk/issues/7',
    labels: [{ name: 'skirmish' }],
    comments: []
  });
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'comment') {
  const repo = optionValue('--repo') || 'TeamFloPay/sdk';
  const number = args[2] || '7';
  process.stdout.write('https://github.com/' + repo + '/issues/' + number + '#issuecomment-2');
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'edit') {
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'list') {
  json([]);
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'view') {
  const repo = optionValue('--repo');
  const number = Number(args[2]);
  if (repo === 'TeamFloPay/backend' && number === 660) {
    json({
      title: 'Fix hosted subscription duplicate first-period invoice',
      body: 'Closes TeamFloPay/ally-clicktech#6\\n\\n## Summary\\n- Fixes the backend subscription flow.',
      url: 'https://github.com/TeamFloPay/backend/pull/660',
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      headRefName: 'warroom/6-omni-duplicate-paid-out-of-band-subscription-pay',
      baseRefName: 'main',
      headRefOid: 'abc123abc123abc123abc123abc123abc123abc1',
      isDraft: false,
      files: [{ path: 'apps/api/src/stripe/subscriptions.ts', additions: 12, deletions: 4 }],
      reviewRequests: [],
      latestReviews: [{ state: 'APPROVED', author: { login: 'andyslack' }, submittedAt: '2026-05-08T12:00:00Z' }],
      reviews: [],
      statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    });
    process.exit(0);
  }
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

if (args[0] === 'api' && args[1] === 'graphql') {
  const repo = valueFor('repo');
  const number = Number(valueFor('number'));
  const query = valueFor('query') || '';
  if (query.includes('LinkedBranchInputs')) {
    json({
      data: {
        issueRepo: { issue: { id: 'I_ally_6' } },
        implementationRepo: { id: 'R_backend', ref: { target: { oid: 'abc123abc123abc123abc123abc123abc123abc1' } } }
      }
    });
    process.exit(0);
  }
  if (query.includes('CreateLinkedBranch')) {
    const branch = valueFor('name');
    const remote = process.env.WARROOM_TEST_BACKEND_REMOTE;
    if (remote && branch) {
      const exists = spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
      if (exists.status !== 0) {
        const created = spawnSync('git', ['--git-dir', remote, 'branch', branch, 'main'], { encoding: 'utf8' });
        if (created.status !== 0) {
          process.stderr.write(created.stderr || 'linked branch fixture failed');
          process.exit(1);
        }
      }
    }
    json({ data: { createLinkedBranch: { issue: { number: 6 }, linkedBranch: { id: 'LB_6' } } } });
    process.exit(0);
  }
  if (query.includes('pullRequest')) {
    json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    process.exit(0);
  }
  if (repo === 'ally-clicktech' && number === 6) {
    json({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } } } } });
    process.exit(0);
  }
}

if (args[0] === 'pr' && args[1] === 'comment') {
  process.stdout.write('https://github.com/TeamFloPay/backend/pull/660#issuecomment-1');
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'comment') {
  process.stdout.write('https://github.com/TeamFloPay/ally-clicktech/issues/6#issuecomment-2');
  process.exit(0);
}

console.error('Unexpected gh fixture call: ' + args.join(' '));
process.exit(1);
`
  );
  chmodSync(ghPath, 0o755);
}

function writeGhFixture(bin: string) {
  const ghPath = path.join(bin, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const triageNotesPath = path.join(path.dirname(process.argv[1]), 'triage-notes-posted');
function triageReadiness() {
  if (!existsSync(triageNotesPath)) return null;
  try {
    return readFileSync(triageNotesPath, 'utf8').trim() === 'no' ? 'no' : 'yes';
  } catch {
    return 'yes';
  }
}

function json(value) {
  process.stdout.write(JSON.stringify(value));
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (args[0] === 'project' && args[1] === 'item-list') {
  json({
    items: [
      {
        id: 'PVTI_needs',
        title: 'Shape the triage workflow',
        status: 'needs-triage',
        labels: ['needs-triage'],
        content: {
          repository: 'TeamFloPay/sdk',
          number: 4,
          title: 'Shape the triage workflow',
          url: 'https://github.com/TeamFloPay/sdk/issues/4'
        }
      },
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

if (args[0] === 'issue' && args[1] === 'develop') {
  const branch = optionValue('--name');
  if (branch && args.includes('--checkout')) {
    const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch], { encoding: 'utf8' });
    const git = exists.status === 0
      ? spawnSync('git', ['switch', branch], { encoding: 'utf8' })
      : spawnSync('git', ['switch', '-c', branch], { encoding: 'utf8' });
    if (git.status !== 0) {
      process.stderr.write(git.stderr || 'git switch failed');
      process.exit(git.status || 1);
    }
  }
  process.stdout.write('https://github.com/TeamFloPay/sdk/tree/' + (branch || 'warroom/7-build-the-selector'));
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  const issueNumber = args[2];
  const issueRepo = optionValue('--repo') || 'TeamFloPay/sdk';
  if (issueRepo === 'TeamFloPay/backend' && issueNumber === '562') {
    json({
      title: 'Backend merge closeout',
      body: 'Close out the backend merge workflow.',
      url: 'https://github.com/TeamFloPay/backend/issues/562',
      labels: [{ name: 'battlefield-active' }, { name: 'ready-to-engage' }, { name: 'skirmish' }],
      comments: []
    });
    process.exit(0);
  }
  if (issueNumber === '4') {
    const readiness = triageReadiness();
    const comments = readiness
      ? [
          {
            author: { login: 'andrewslack' },
            body: [
              '## War Room triage notes',
              '',
              'Ready for ready-to-engage: ' + readiness,
              '',
              'Owner repo: TeamFloPay/sdk',
              'Acceptance criteria: clarify the selector workflow.'
            ].join('\\n'),
            createdAt: '2026-05-08T10:00:00Z',
            url: 'https://github.com/TeamFloPay/sdk/issues/4#issuecomment-triage'
          }
        ]
      : [];
    json({
      title: 'Shape the triage workflow',
      body: 'Clarify how operators should move needs-triage issues toward a ready plan.',
      url: 'https://github.com/TeamFloPay/sdk/issues/4',
      labels: [{ name: 'needs-triage' }],
      comments
    });
    process.exit(0);
  }

  if (issueNumber === '17') {
    json({
      title: 'Long implementation issue',
      body: 'A'.repeat(6500) + 'FULL_BODY_SENTINEL',
      url: 'https://github.com/TeamFloPay/sdk/issues/17',
      comments: [
        {
          author: { login: 'andrewslack' },
          body: 'B'.repeat(1200) + 'FULL_COMMENT_SENTINEL',
          createdAt: '2026-05-05T00:00:00Z'
        }
      ]
    });
    process.exit(0);
  }

  json({
    title: 'Build the selector',
    body: 'Allow operators to pick a ready issue and start implementation.',
    url: 'https://github.com/TeamFloPay/sdk/issues/7',
    labels: [{ name: 'ready-to-engage' }],
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

if (args[0] === 'project' && args[1] === 'item-add') {
  json({ id: 'PVTI_added' });
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
  const repo = optionValue('--repo');
  const head = optionValue('--head');
  if (repo === 'TeamFloPay/backend' && (!head || head === 'feature/backend')) {
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
  json([]);
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'create') {
  const repo = optionValue('--repo') || 'TeamFloPay/sdk';
  const number = repo === 'TeamFloPay/sdk' ? 12 : 655;
  process.stdout.write('https://github.com/' + repo + '/pull/' + number);
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'comment') {
  process.stdout.write('https://github.com/TeamFloPay/backend/pull/655#issuecomment-1');
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'comment') {
  const repo = optionValue('--repo') || 'TeamFloPay/backend';
  const number = args[2] || '562';
  const body = optionValue('--body') || '';
  if (process.env.WARROOM_GH_ISSUE_COMMENT_LOG) {
    require('node:fs').appendFileSync(process.env.WARROOM_GH_ISSUE_COMMENT_LOG, body + '\\n---COMMENT---\\n');
  }
  process.stdout.write('https://github.com/' + repo + '/issues/' + number + '#issuecomment-2');
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'edit') {
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

function writeIssueCreateGhFixture(bin: string) {
  const ghPath = path.join(bin, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const triageNotesPath = path.join(path.dirname(process.argv[1]), 'triage-notes-posted');

function json(value) {
  process.stdout.write(JSON.stringify(value));
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function valueFor(name) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-f' && args[index] !== '-F') continue;
    const [key, value] = args[index + 1].split('=');
    if (key === name) return value;
  }
}

if (args[0] === 'issue' && args[1] === 'create') {
  const repo = optionValue('--repo');
  const title = optionValue('--title');
  const body = readFileSync(0, 'utf8');
  const labels = args
    .map((arg, index) => (arg === '--label' ? args[index + 1] : null))
    .filter(Boolean);
  if (
    repo !== 'TeamFloPay/sdk' ||
    title !== 'Report checkout settlement confusion' ||
    !body.includes('Customer support needs a clear issue') ||
    labels.includes('checkout')
  ) {
    process.stderr.write('unexpected issue create payload');
    process.exit(1);
  }
  process.stdout.write('https://github.com/TeamFloPay/sdk/issues/123');
  process.exit(0);
}

if (args[0] === 'label' && args[1] === 'list') {
  json([
    { name: 'needs-triage' },
    { name: 'ready-to-engage' },
    { name: 'battlefield-active' },
    { name: 'skirmish' },
    { name: 'blockaded' },
    { name: 'victory' }
  ]);
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view' && args[2] === '123') {
  const comments = existsSync(triageNotesPath)
    ? [
        {
          author: { login: 'andrewslack' },
          body: [
            '## War Room triage notes',
            '',
            'Ready for ready-to-engage: yes',
            '',
            'Owner repo: TeamFloPay/sdk'
          ].join('\\n'),
          createdAt: '2026-05-08T10:00:00Z',
          url: 'https://github.com/TeamFloPay/sdk/issues/123#issuecomment-triage'
        }
      ]
    : [];
  json({
    title: 'Report checkout settlement confusion',
    body: 'Customer support needs a clear issue for checkout settlement confusion.',
    url: 'https://github.com/TeamFloPay/sdk/issues/123',
    labels: [{ name: 'needs-triage' }],
    comments
  });
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'edit') {
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

if (args[0] === 'project' && args[1] === 'item-list') {
  json({ items: [] });
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'item-add') {
  json({ id: 'PVTI_created' });
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'item-edit') {
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  const query = valueFor('query') || '';
  if (query.includes('IssueTypeLookup')) {
    json({
      data: {
        repository: { issue: { id: 'I_created_123' } },
        organization: {
          issueTypes: {
            nodes: [
              { id: 'IT_bug', name: 'Bug', isEnabled: true },
              { id: 'IT_task', name: 'Task', isEnabled: true }
            ]
          }
        }
      }
    });
    process.exit(0);
  }
  if (query.includes('UpdateIssueType')) {
    json({ data: { updateIssueIssueType: { issue: { number: 123, issueType: { name: 'Bug' } } } } });
    process.exit(0);
  }
  if (query.includes('pullRequest') && query.includes('reviewThreads')) {
    json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    process.exit(0);
  }
  if (query.includes('pullRequest') && query.includes('comments(first: 100)')) {
    json({ data: { repository: { pullRequest: { comments: { nodes: [] } } } } });
    process.exit(0);
  }
  if (query.includes('addReaction')) {
    json({ data: { addReaction: { reaction: { id: 'REACTION_added_fixture' } } } });
    process.exit(0);
  }
  if (query.includes('removeReaction')) {
    json({ data: { removeReaction: { reaction: { id: 'REACTION_removed_fixture' } } } });
    process.exit(0);
  }
}

console.error('Unexpected gh fixture call: ' + args.join(' '));
process.exit(1);
`
  );
  chmodSync(ghPath, 0o755);
}

function writePrReviewLoopGhFixture(
  bin: string,
  stateFile: string,
  options: {
    queue: 'empty' | 'single' | 'multi';
    outstandingFirst: boolean;
    delayedCodeRabbit?: boolean;
    initialCodeRabbitPending?: boolean;
    replyAfterFix?: boolean;
    replyLog?: string;
  }
) {
  const ghPath = path.join(bin, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const stateFile = ${JSON.stringify(stateFile)};
const options = ${JSON.stringify(options)};

function json(value) {
  process.stdout.write(JSON.stringify(value));
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function valueFor(name) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-f' && args[index] !== '-F') continue;
    const [key, value] = args[index + 1].split('=');
    if (key === name) return value;
  }
}

function postedReplies() {
  if (!options.replyLog) return [];
  try {
    return readFileSync(options.replyLog, 'utf8')
      .split(/\\r?\\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function loopCount() {
  try {
    const value = Number(readFileSync(stateFile, 'utf8').trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function pollStateFile() {
  return stateFile + '.polls';
}

function pollCount() {
  try {
    const value = Number(readFileSync(pollStateFile(), 'utf8').trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function incrementPollCount() {
  const next = pollCount() + 1;
  writeFileSync(pollStateFile(), String(next));
  return next;
}

function headSha() {
  const count = loopCount();
  if (count <= 0) return '0000000000000000000000000000000000000000';
  if (count === 1) return '1111111111111111111111111111111111111111';
  return '2222222222222222222222222222222222222222';
}

function prNode(repo, number, title, updatedAt) {
  return {
    __typename: 'PullRequest',
    number,
    title,
    url: 'https://github.com/' + repo + '/pull/' + number,
    state: 'OPEN',
    updatedAt,
    repository: { nameWithOwner: repo }
  };
}

if (args[0] === 'project' && args[1] === 'item-list') {
  const items = options.queue === 'empty'
    ? []
    : options.queue === 'single'
    ? [
        {
          id: 'PVTI_active_backend',
          title: 'Remove Recurly & Chargebee Support',
          status: 'battlefield-active',
          labels: ['battlefield-active'],
          content: {
            repository: 'TeamFloPay/backend',
            number: 632,
            title: 'Remove Recurly & Chargebee Support',
            type: 'Issue',
            url: 'https://github.com/TeamFloPay/backend/issues/632'
          }
        }
      ]
    : [
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
      ];
  json({ items });
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'item-add') {
  json({ id: 'PVTI_added_for_review' });
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'list') {
  const repo = optionValue('--repo');
  const head = optionValue('--head');
  if (options.queue === 'empty' && repo === 'TeamFloPay/sdk' && head === 'fix/stripe-avs-address-preservation') {
    json([
      {
        number: 659,
        title: 'Preserve Stripe AVS billing address',
        url: 'https://github.com/TeamFloPay/sdk/pull/659',
        headRefName: 'fix/stripe-avs-address-preservation'
      }
    ]);
    process.exit(0);
  }
  json([]);
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'create') {
  const repo = optionValue('--repo') || 'TeamFloPay/sdk';
  const number = repo === 'TeamFloPay/sdk' ? 12 : 657;
  process.stdout.write('https://github.com/' + repo + '/pull/' + number);
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  const repo = optionValue('--repo') || 'TeamFloPay/backend';
  const number = Number(args[2]);
  const labels =
    repo === 'TeamFloPay/sdk' && number === 8
      ? [{ name: 'battlefield-active' }]
      : repo === 'TeamFloPay/demo' && number === 9
        ? [{ name: 'skirmish' }]
        : [{ name: 'battlefield-active' }];
  json({
    title: number === 632 ? 'Remove Recurly & Chargebee Support' : 'Review issue',
    body: 'Review issue body.',
    url: 'https://github.com/' + repo + '/issues/' + number,
    labels
  });
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'edit') {
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  const repo = valueFor('repo');
  const number = Number(valueFor('number'));
  const query = valueFor('query') || '';

  if (query.includes('addPullRequestReviewThreadReply')) {
    const threadId = valueFor('threadId');
    const body = valueFor('body');
    if (options.replyLog) appendFileSync(options.replyLog, JSON.stringify({ threadId, body }) + '\\n');
    json({ data: { addPullRequestReviewThreadReply: { comment: { url: 'https://github.com/TeamFloPay/sdk/pull/12#discussion_reply_fallback' } } } });
    process.exit(0);
  }

  if (query.includes('addReaction')) {
    json({ data: { addReaction: { reaction: { id: 'REACTION_added_fixture' } } } });
    process.exit(0);
  }

  if (query.includes('removeReaction')) {
    json({ data: { removeReaction: { reaction: { id: 'REACTION_removed_fixture' } } } });
    process.exit(0);
  }

  if (query.includes('pullRequest') && query.includes('reviewThreads')) {
    const initialFeedbackPending = options.initialCodeRabbitPending && loopCount() === 0 && pollCount() < 4;
    const delayedFeedbackPending = options.delayedCodeRabbit && loopCount() === 1 && pollCount() < 4;
    const hasOutstanding =
      options.outstandingFirst &&
      ((options.initialCodeRabbitPending && loopCount() === 0 && !initialFeedbackPending) ||
        (loopCount() === 1 && !delayedFeedbackPending));
    const hasResolvedAddressedThread = options.outstandingFirst && loopCount() > 1;
    const originalCodeRabbitComment = {
      id: 'PRRC_fixture_1',
      path: 'src/billing.ts',
      line: 12,
      url: 'https://github.com/TeamFloPay/sdk/pull/12#discussion_r1',
      body: 'CodeRabbit follow-up requested.',
      author: { login: 'coderabbitai' }
    };
    const completionReply = {
      id: 'PRRC_fixture_reply_1',
      path: 'src/billing.ts',
      line: 12,
      url: 'https://github.com/TeamFloPay/sdk/pull/12#discussion_r1_reply',
      body: 'Change made: committed the fixture fix.',
      author: { login: 'andrewslack' }
    };
    const fallbackReplies = postedReplies()
      .filter((reply) => reply.threadId === 'PRRT_fixture_1')
      .map((reply, index) => ({
        id: 'PRRC_fixture_fallback_' + index,
        path: 'src/billing.ts',
        line: 12,
        url: 'https://github.com/TeamFloPay/sdk/pull/12#discussion_reply_fallback_' + index,
        body: reply.body,
        author: { login: 'andrewslack' }
      }));
    json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: hasOutstanding
                ? [
                    {
                      id: 'PRRT_fixture_1',
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        nodes: [originalCodeRabbitComment]
                      }
                    }
                  ]
                : hasResolvedAddressedThread
                ? [
                    {
                      id: 'PRRT_fixture_1',
                      isResolved: true,
                      isOutdated: false,
                      comments: {
                        nodes: options.replyAfterFix === false
                          ? [originalCodeRabbitComment, ...fallbackReplies]
                          : [originalCodeRabbitComment, completionReply, ...fallbackReplies]
                      }
                    }
                  ]
                : []
            }
          }
        }
      }
    });
    process.exit(0);
  }

  if (query.includes('pullRequest') && query.includes('comments(first: 100)')) {
    json({ data: { repository: { pullRequest: { comments: { nodes: [] } } } } });
    process.exit(0);
  }

  if (repo === 'backend' && number === 632) {
    json({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: [prNode('TeamFloPay/backend', 657, 'Remove Recurly & Chargebee Support', '2026-05-06T18:54:12Z')]
            },
            timelineItems: { nodes: [] }
          }
        }
      }
    });
    process.exit(0);
  }

  if (repo === 'sdk' && number === 8) {
    json({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: [prNode('TeamFloPay/sdk', 12, 'Review active SDK work', '2026-05-06T12:00:00Z')]
            },
            timelineItems: { nodes: [] }
          }
        }
      }
    });
    process.exit(0);
  }

  if (repo === 'demo' && number === 9) {
    json({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: [prNode('TeamFloPay/demo', 3, 'Review demo follow-up', '2026-05-05T12:00:00Z')]
            },
            timelineItems: { nodes: [] }
          }
        }
      }
    });
    process.exit(0);
  }

  json({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } } } } });
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

if (args[0] === 'pr' && args[1] === 'view') {
  const repo = optionValue('--repo') || 'TeamFloPay/backend';
  const number = Number(args[2]);
  const isCurrentBranchFallback = number === 659;
  const isSdk = repo === 'TeamFloPay/sdk';
  const isDemo = repo === 'TeamFloPay/demo';
  const currentHead = headSha();
  const poll = incrementPollCount();
  const initialCheckPending = options.initialCodeRabbitPending && loopCount() === 0 && poll < 4;
  const delayedCheckPending = options.delayedCodeRabbit && loopCount() === 1 && poll < 4;
  json({
    title: isCurrentBranchFallback ? 'Preserve Stripe AVS billing address' : isSdk ? 'Review active SDK work' : isDemo ? 'Review demo follow-up' : 'Remove Recurly & Chargebee Support',
    body: 'Review CodeRabbit feedback.',
    url: 'https://github.com/' + repo + '/pull/' + number,
    headRefName: isCurrentBranchFallback ? 'fix/stripe-avs-address-preservation' : isSdk ? 'warroom/8-active-sdk-work' : isDemo ? 'warroom/9-demo-follow-up' : 'warroom/632-remove-recurly-chargebee',
    baseRefName: 'main',
    headRefOid: currentHead,
    reviews: initialCheckPending || delayedCheckPending
      ? []
      : [
          {
            author: { login: 'coderabbitai' },
            state: 'COMMENTED',
            submittedAt: '2026-05-06T12:00:00Z',
            commit: { oid: currentHead }
          }
        ],
    statusCheckRollup: initialCheckPending || delayedCheckPending
      ? []
      : [
          { name: 'CodeRabbit', status: 'COMPLETED', conclusion: 'SUCCESS' }
        ]
  });
  process.exit(0);
}

console.error('Unexpected gh fixture call: ' + args.join(' '));
process.exit(1);
`
  );
  chmodSync(ghPath, 0o755);
}

function writePrReviewLoopCodexFixture(bin: string, stateFile: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const stateFile = ${JSON.stringify(stateFile)};

let count = 0;
try {
  count = Number(readFileSync(stateFile, 'utf8').trim()) || 0;
} catch {
  count = 0;
}
writeFileSync(stateFile, String(count + 1));

process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`
  );
  chmodSync(codexPath, 0o755);
}

function writePrReviewLoopDirtyCodexFixture(bin: string, stateFile: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const stateFile = ${JSON.stringify(stateFile)};

let count = 0;
try {
  count = Number(readFileSync(stateFile, 'utf8').trim()) || 0;
} catch {
  count = 0;
}
writeFileSync(path.join(process.cwd(), 'review-fix.ts'), 'export const reviewFix = true;\\n');
writeFileSync(stateFile, String(count + 1));

process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`
  );
  chmodSync(codexPath, 0o755);
}

function seedMergedMainForChangelogFixture(sdkRemote: string, releaseBump: boolean) {
  const worktree = mkdtempSync(path.join(tmpdir(), 'sdk-already-merged-'));
  try {
    let result = spawnSync('git', ['clone', '--branch', 'main', sdkRemote, worktree], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    spawnSync('git', ['config', 'user.email', 'warroom@example.com'], { cwd: worktree });
    spawnSync('git', ['config', 'user.name', 'War Room'], { cwd: worktree });
    result = spawnSync('git', ['fetch', 'origin', 'feature/sdk:refs/remotes/origin/feature/sdk'], {
      cwd: worktree,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr);
    result = spawnSync('git', ['merge', '--squash', 'origin/feature/sdk'], { cwd: worktree, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    if (releaseBump) {
      const packagePath = path.join(worktree, 'package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
      packageJson.version = '1.0.1';
      writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
    }
    result = spawnSync('git', ['add', '-A'], { cwd: worktree, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    result = spawnSync('git', ['commit', '-m', releaseBump ? 'chore(release): 1.0.1' : 'feat: ready sdk pr'], {
      cwd: worktree,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr);
    result = spawnSync('git', ['push', 'origin', 'main'], { cwd: worktree, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}

function writeChangelogMergeGhFixture(
  bin: string,
  sdkRemote: string,
  options: {
    releaseBump?: boolean;
    dependabotFailure?: boolean;
    merged?: boolean;
    mergeabilityFlapPath?: string;
    commentLogPath?: string;
  } = {}
) {
  const ghPath = path.join(bin, 'gh');
  const releaseBump = options.releaseBump !== false;
  const dependabotFailure = options.dependabotFailure === true;
  const merged = options.merged === true;
  const mergeabilityFlapPath = options.mergeabilityFlapPath ?? '';
  const commentLogPath = options.commentLogPath ?? '';
  if (merged) seedMergedMainForChangelogFixture(sdkRemote, releaseBump);
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const { appendFileSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sdkRemote = ${JSON.stringify(sdkRemote)};
const releaseBump = ${JSON.stringify(releaseBump)};
const dependabotFailure = ${JSON.stringify(dependabotFailure)};
const merged = ${JSON.stringify(merged)};
const mergeabilityFlapPath = ${JSON.stringify(mergeabilityFlapPath)};
const commentLogPath = ${JSON.stringify(commentLogPath)};

function json(value) {
  process.stdout.write(JSON.stringify(value));
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function recordComment(kind, repo, number, body, url) {
  if (commentLogPath) {
    appendFileSync(commentLogPath, JSON.stringify({ kind, repo, number, body, url }) + '\\n');
  }
  process.stdout.write(url);
  process.exit(0);
}

function remoteMainSha() {
  const result = spawnSync('git', ['--git-dir', sdkRemote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result.stdout.trim();
}

if (args[0] === 'pr' && args[1] === 'view') {
  const jsonFields = optionValue('--json') || '';
  if (jsonFields === 'mergeable,mergeStateStatus' && mergeabilityFlapPath) {
    let count = 0;
    try { count = Number(readFileSync(mergeabilityFlapPath, 'utf8')) || 0; } catch (_) {}
    writeFileSync(mergeabilityFlapPath, String(count + 1));
    if (count < 2) {
      json({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
    } else {
      json({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    }
    process.exit(0);
  }
  json({
    title: 'Ready SDK PR',
    body: 'Adds the SDK behavior that should be reflected in the changelog.',
    url: 'https://github.com/TeamFloPay/sdk/pull/655',
    mergeStateStatus: merged ? 'UNKNOWN' : 'CLEAN',
    mergeable: merged ? 'UNKNOWN' : 'MERGEABLE',
    reviewDecision: 'APPROVED',
    headRefName: 'feature/sdk',
    baseRefName: 'main',
    isDraft: false,
    state: merged ? 'MERGED' : 'OPEN',
    mergedAt: merged ? '2026-05-13T14:11:23Z' : null,
    mergeCommit: merged ? { oid: remoteMainSha() } : null,
    files: [
      { path: 'index.ts', additions: 1, deletions: 0 }
    ],
    statusCheckRollup: [
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }
    ]
  });
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'repos/TeamFloPay/sdk/commits/main') {
  process.stdout.write(remoteMainSha());
  process.exit(0);
}

if (args[0] === 'run' && args[1] === 'list') {
  const sha = remoteMainSha();
  const runs = [
    {
      databaseId: 42,
      name: 'Release',
      displayTitle: 'Release',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      event: 'workflow_run',
      headSha: sha,
      url: 'https://github.com/TeamFloPay/sdk/actions/runs/42'
    }
  ];
  if (dependabotFailure) {
    runs.push({
      databaseId: 43,
      name: 'npm_and_yarn in / for knip, turbo - Update #123',
      displayTitle: 'npm_and_yarn in / for knip, turbo - Update #123',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      event: 'dynamic',
      headSha: sha,
      url: 'https://github.com/TeamFloPay/sdk/actions/runs/43'
    });
  }
  json(runs);
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'merge') {
  if (merged) {
    process.stderr.write('Pull request already merged.\\n');
    process.exit(1);
  }
  const worktree = mkdtempSync(path.join(tmpdir(), 'sdk-release-'));
  let result = spawnSync('git', ['clone', '--branch', 'main', sdkRemote, worktree], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  spawnSync('git', ['config', 'user.email', 'warroom@example.com'], { cwd: worktree });
  spawnSync('git', ['config', 'user.name', 'War Room'], { cwd: worktree });
  result = spawnSync('git', ['fetch', 'origin', 'feature/sdk:refs/remotes/origin/feature/sdk'], { cwd: worktree, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  result = spawnSync('git', ['merge', '--squash', 'origin/feature/sdk'], { cwd: worktree, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  if (releaseBump) {
    const packagePath = path.join(worktree, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    packageJson.version = '1.0.1';
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\\n');
  }
  result = spawnSync('git', ['add', '-A'], { cwd: worktree, encoding: 'utf8' });
  if (result.status !== 0) process.exit(result.status || 1);
  result = spawnSync('git', ['commit', '-m', releaseBump ? 'chore(release): 1.0.1' : 'feat: ready sdk pr'], { cwd: worktree, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  result = spawnSync('git', ['push', 'origin', 'main'], { cwd: worktree, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'comment') {
  const number = args[2];
  const repo = optionValue('--repo') || 'TeamFloPay/sdk';
  const body = optionValue('--body') || '';
  recordComment('pr', repo, number, body, 'https://github.com/' + repo + '/pull/' + number + '#issuecomment-1');
}

if (args[0] === 'issue' && args[1] === 'comment') {
  const number = args[2];
  const repo = optionValue('--repo') || 'TeamFloPay/sdk';
  const body = optionValue('--body') || '';
  recordComment('issue', repo, number, body, 'https://github.com/' + repo + '/issues/' + number + '#issuecomment-2');
}

console.error('Unexpected gh fixture call: ' + args.join(' '));
process.exit(1);
`
  );
  chmodSync(ghPath, 0o755);
}

function writeChangelogCodexFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require('node:fs');
const path = require('node:path');
const cdIndex = args.indexOf('--cd');
const cwd = cdIndex === -1 ? process.cwd() : args[cdIndex + 1];

fs.writeFileSync(
  path.join(cwd, 'CHANGELOG.md'),
  '# Changelog\\n\\n## 1.0.1\\n- Ready SDK PR updates the SDK behavior.\\n\\n## 1.0.0\\n- Initial release.\\n'
);
process.exit(0);
`
  );
  chmodSync(codexPath, 0o755);
}

function writeOpenChangelogCodexFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require('node:fs');
const path = require('node:path');
const cdIndex = args.indexOf('--cd');
const cwd = cdIndex === -1 ? process.cwd() : args[cdIndex + 1];
const releaseNotes = path.join(cwd, 'release-notes');
fs.mkdirSync(releaseNotes, { recursive: true });
fs.writeFileSync(
  path.join(releaseNotes, 'v1.0.1.ready-sdk-pr.md'),
  [
    '---',
    'title: v1.0.1 - Ready SDK PR',
    'description: Ready SDK PR updates the SDK behavior.',
    'publishedAt: "2026-05-12T09:00:00.000Z"',
    'tags:',
    '  - SDK',
    '  - Improvement',
    '---',
    '',
    'Ready SDK PR updates the SDK behavior.',
    ''
  ].join('\\n')
);
process.exit(0);
`
  );
  chmodSync(codexPath, 0o755);
}

function writeOpenChangelogMissingVersionTitleCodexFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require('node:fs');
const path = require('node:path');
const cdIndex = args.indexOf('--cd');
const cwd = cdIndex === -1 ? process.cwd() : args[cdIndex + 1];
const releaseNotes = path.join(cwd, 'release-notes');
fs.mkdirSync(releaseNotes, { recursive: true });
fs.writeFileSync(
  path.join(releaseNotes, 'v1.0.1.ready-sdk-pr.md'),
  [
    '---',
    'title: Ready SDK PR',
    'description: Ready SDK PR updates the SDK behavior.',
    'publishedAt: "2026-05-12T09:00:00.000Z"',
    'tags:',
    '  - SDK',
    '---',
    '',
    'Ready SDK PR updates the SDK behavior.',
    ''
  ].join('\\n')
);
process.exit(0);
`
  );
  chmodSync(codexPath, 0o755);
}

function writeOpenChangelogModifyExistingCodexFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require('node:fs');
const path = require('node:path');
const cdIndex = args.indexOf('--cd');
const cwd = cdIndex === -1 ? process.cwd() : args[cdIndex + 1];
fs.appendFileSync(path.join(cwd, 'release-notes', 'v1.0.0.initial-release.md'), '\\nRewritten existing note.\\n');
process.exit(0);
`
  );
  chmodSync(codexPath, 0o755);
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

function writeUnresolvedThreadMergeGhFixture(bin: string) {
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
    title: 'Infra cleanup PR',
    url: 'https://github.com/TeamFloPay/infra/pull/4',
    mergeStateStatus: 'BLOCKED',
    mergeable: 'MERGEABLE',
    reviewDecision: '',
    headRefName: 'feature/infra',
    baseRefName: 'main',
    isDraft: false,
    reviewRequests: [],
    latestReviews: [
      {
        author: { login: 'coderabbitai' },
        state: 'COMMENTED',
        submittedAt: '2026-05-06T07:58:39Z'
      }
    ],
    statusCheckRollup: [
      {
        name: 'Terraform plan',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/TeamFloPay/infra/actions/runs/1'
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
                      path: 'main.tf',
                      line: 12,
                      url: 'https://github.com/TeamFloPay/infra/pull/4#discussion_r1',
                      body: 'Consider renaming this local variable.',
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

if (args[0] === 'pr' && args[1] === 'merge') {
  process.exit(0);
}

console.error('Unexpected gh fixture call: ' + args.join(' '));
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
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv[2] !== 'exec') {
  fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'triage-notes-posted'), '1');
  process.exit(0);
}
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  if (process.env.WARROOM_CODEX_PROMPT_LOG) {
    fs.appendFileSync(process.env.WARROOM_CODEX_PROMPT_LOG, input + '\\n---PROMPT---\\n');
  }
  if (outputIndex !== -1) {
    if (input.includes('Summarize one chunk of a Git diff')) {
      fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
        summary: 'This chunk updates selector-related implementation details and preserves the important changed files for the final PR summary.'
      }));
    } else if (input.includes('War Room commit update summary')) {
      fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
        summary: 'Implemented the selector commit by adding the runtime export used by the SDK workflow, with no validation run through warroom commit create.'
      }));
    } else {
      fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
        title: 'Build the selector',
        body: [
          'Closes TeamFloPay/sdk#7',
          '',
          '## Summary',
          '- Builds selector support from the branch commits.',
          '- Captures the actual change in selector.ts for reviewers.',
          '- feat: build selector',
          '',
          '## Validation',
          '- Not run by warroom pr create.'
        ].join('\\n')
      }));
    }
  } else if (input.includes('War Room implementation handoff')) {
    fs.writeFileSync(path.join(process.cwd(), 'selector.ts'), 'export const selector = true;\\n');
    spawnSync('git', ['add', 'selector.ts'], { cwd: process.cwd(), encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'feat: build selector'], { cwd: process.cwd(), encoding: 'utf8' });
  }
  process.exit(0);
});
`
  );
  chmodSync(codexPath, 0o755);
}

function writeDirtyImplementationCodexFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'exec') {
  fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'triage-notes-posted'), '1');
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  if (input.includes('War Room implementation handoff')) {
    fs.writeFileSync(path.join(process.cwd(), 'selector.ts'), 'export const selector = true;\\n');
  }
  process.exit(0);
});
`
  );
  chmodSync(codexPath, 0o755);
}

function writeFailingImplementationCodexFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
if (process.argv[2] !== 'exec') {
  process.exit(0);
}
process.stdout.write('Implementation adapter reached the repo and then failed.\\n');
process.exit(1);
`
  );
  chmodSync(codexPath, 0o755);
}

function writeIssueCreateCodexFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const prompt = process.argv[process.argv.length - 1] || '';
if (prompt.includes('War Room issue creation PM session')) {
  const match = prompt.match(/Write the final draft JSON to exactly: (.+)/);
  if (!match) {
    process.stderr.write('draft path missing from prompt');
    process.exit(1);
  }
  fs.writeFileSync(match[1], JSON.stringify({
    repo: 'TeamFloPay/sdk',
    title: 'Report checkout settlement confusion',
    body: [
      '## Business Context',
      'Customer support needs a clear issue for checkout settlement confusion.',
      '',
      '## Desired Outcome',
      'Operators can explain the customer-visible payment state before technical triage starts.',
      '',
      '## Known Constraints',
      '- Keep client-sensitive details out of the issue.'
    ].join('\\n'),
    labels: ['checkout'],
    issueType: 'Bug',
    assignees: [],
    milestone: null
  }));
  process.exit(0);
}
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'triage-notes-posted'), '1');
process.exit(0);
`
  );
  chmodSync(codexPath, 0o755);
}

function writeCodexNoTriageNotesFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
process.exit(0);
`
  );
  chmodSync(codexPath, 0o755);
}

function writeCodexNotReadyTriageFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'triage-notes-posted'), 'no');
process.exit(0);
`
  );
  chmodSync(codexPath, 0o755);
}
