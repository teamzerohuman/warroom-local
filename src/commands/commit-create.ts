import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunArtifact, type RunArtifact } from '../lib/artifacts.js';
import { getAdapterInvocation, runAdapter } from '../lib/env.js';
import { createUsageCommandRunId, usageEntriesForCommandRun } from '../lib/llm-usage.js';
import { parseRepoRef } from '../lib/refs.js';
import { getRepoById, getRepoHealth, loadRepoManifest, runGit, type RepoHealth } from '../lib/repos.js';

export type CommitCreateOptions = {
  repo?: string;
  issue?: string;
  message?: string;
  confirm?: boolean;
  all?: boolean;
  push?: boolean;
  issueComment?: boolean;
  validate?: string[];
  writeArtifact?: boolean;
  currentPath?: string;
};

export type CommitFileChange = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
};

export type CommitValidationResult = {
  command: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
};

export type CommitCreateResult = {
  repo: string;
  githubRepo: string;
  path: string;
  branch: string | null;
  headSha: string | null;
  upstream: string | null;
  issue: string | null;
  clean: boolean | null;
  statusLines: string[];
  changes: CommitFileChange[];
  validation: CommitValidationResult[];
  suggestedMessage: string;
  committed: boolean;
  committedSha: string | null;
  pushed: boolean;
  pushCommand: string | null;
  pushSkippedReason: string | null;
  issueComment: IssueProgressCommentResult | null;
  warnings: string[];
  blocked: string[];
  artifact?: RunArtifact;
};

export type IssueProgressCommentResult = {
  issue: string;
  applied: boolean;
  url: string | null;
  reason: string | null;
  error: string | null;
};

type PushPlan = {
  args: string[] | null;
  command: string | null;
  blocker: string | null;
  skippedReason: string | null;
};

function parseStatusLine(line: string): CommitFileChange {
  const indexStatus = line[0] ?? ' ';
  const worktreeStatus = line[1] ?? ' ';
  const rawPath = line.slice(3);
  const renamedPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) ?? rawPath : rawPath;

  return {
    path: renamedPath,
    indexStatus,
    worktreeStatus,
    staged: indexStatus !== ' ' && indexStatus !== '?',
    unstaged: worktreeStatus !== ' ' || indexStatus === '?',
  };
}

function trimCommandOutput(value: string) {
  const trimmed = value.trim();
  const maxLength = 12_000;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}\n[output truncated to ${maxLength} characters]`;
}

function runValidation(repoPath: string, command: string): CommitValidationResult {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd: repoPath,
    encoding: 'utf8',
    shell: true,
  });

  return {
    command,
    status: result.status,
    ok: result.status === 0,
    durationMs: Date.now() - startedAt,
    stdout: trimCommandOutput(result.stdout ?? ''),
    stderr: trimCommandOutput(result.stderr ?? ''),
  };
}

function isDocsPath(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    normalized === 'readme.md' ||
    normalized.endsWith('/readme.md') ||
    normalized.startsWith('docs/') ||
    normalized.endsWith('.md')
  );
}

function suggestMessage(repoId: string, changes: CommitFileChange[]) {
  const docsOnly = changes.length > 0 && changes.every((change) => isDocsPath(change.path));
  const prefix = docsOnly ? 'docs' : 'chore';
  return `${prefix}(${repoId}): update war room workflow`;
}

function containsPath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function inferRepoFromPath(repos: RepoHealth[], currentPath: string) {
  const resolved = path.resolve(currentPath);
  return repos
    .filter((repo) => repo.checkedOut && containsPath(repo.resolvedPath, resolved))
    .sort((left, right) => right.resolvedPath.length - left.resolvedPath.length)[0]?.id;
}

function gitConfig(repoPath: string, key: string) {
  const result = runGit(repoPath, ['config', key]);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function configuredBranchIssueRef(repoPath: string, branch: string | null) {
  if (!branch) return null;
  const configured = gitConfig(repoPath, `branch.${branch}.warroom-issue`);
  if (configured?.match(/^[^#]+#\d+$/)) return configured;
  return null;
}

function currentBranchIssueRef(repo: string, branch: string | null, repoPath: string) {
  const configured = configuredBranchIssueRef(repoPath, branch);
  if (configured) return configured;

  const match = branch?.match(/^warroom\/(\d+)-/);
  return match ? `${repo}#${match[1]}` : null;
}

function inferRepoFromIssue(repos: RepoHealth[], issue: string | undefined) {
  if (!issue) return null;
  let parts: { repo: string; number: number };
  try {
    parts = parseRepoRef(issue);
  } catch {
    return null;
  }
  return singleRepoId(repos.filter((repo) => repo.github === parts.repo), `issue ${issue}`);
}

function branchHasWarRoomMetadata(repo: RepoHealth) {
  if (!repo.checkedOut || !repo.branch) return false;
  return Boolean(
    gitConfig(repo.resolvedPath, `branch.${repo.branch}.warroom-issue`) ||
      gitConfig(repo.resolvedPath, `branch.${repo.branch}.warroom-implementation-repo`)
  );
}

function isWarRoomBranch(repo: RepoHealth) {
  return Boolean(repo.branch?.match(/^warroom\/\d+-/));
}

function isNonDefaultBranch(repo: RepoHealth, defaultBranch: string) {
  return Boolean(repo.branch && repo.branch !== defaultBranch);
}

function singleRepoId(candidates: RepoHealth[], label: string) {
  const unique = Array.from(new Map(candidates.map((repo) => [repo.id, repo])).values());
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0]!.id;
  throw new Error(
    `warroom commit create could not infer a unique repo from ${label}: ${unique.map((repo) => repo.id).join(', ')}. Pass --repo <id>.`
  );
}

function inferRepoFromMappedBranches(repos: RepoHealth[], defaultBranch: string) {
  const checkedOut = repos.filter((repo) => repo.checkedOut && repo.branch);
  const tiers: Array<[string, (repo: RepoHealth) => boolean]> = [
    ['dirty War Room branch metadata', (repo) => repo.clean === false && branchHasWarRoomMetadata(repo)],
    ['dirty warroom/* branch', (repo) => repo.clean === false && isWarRoomBranch(repo)],
    ['dirty non-default branch', (repo) => repo.clean === false && isNonDefaultBranch(repo, defaultBranch)],
    ['War Room branch metadata', branchHasWarRoomMetadata],
    ['warroom/* branch', isWarRoomBranch],
  ];

  for (const [label, predicate] of tiers) {
    const repoId = singleRepoId(checkedOut.filter(predicate), label);
    if (repoId) return repoId;
  }

  return null;
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function hasOriginRemote(repoPath: string) {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function upstreamMatchesCurrentBranch(repo: RepoHealth) {
  if (!repo.branch || !repo.upstream) return false;
  const remoteBranch = repo.upstream.replace(/^[^/]+\//, '');
  return remoteBranch === repo.branch;
}

function buildPushPlan(repo: RepoHealth, shouldPush: boolean): PushPlan {
  if (!shouldPush) {
    return {
      args: null,
      command: null,
      blocker: null,
      skippedReason: 'Push disabled by --no-push.',
    };
  }

  if (!repo.checkedOut) {
    return {
      args: null,
      command: null,
      blocker: 'Repo checkout is missing; cannot push.',
      skippedReason: null,
    };
  }

  if (repo.upstream && upstreamMatchesCurrentBranch(repo)) {
    return {
      args: ['push'],
      command: 'git push',
      blocker: null,
      skippedReason: null,
    };
  }

  if (!repo.branch) {
    return {
      args: null,
      command: null,
      blocker: 'Repo current branch is unknown; cannot push.',
      skippedReason: null,
    };
  }

  if (!hasOriginRemote(repo.resolvedPath)) {
    return {
      args: null,
      command: null,
      blocker: repo.upstream
        ? `Repo upstream ${repo.upstream} does not match branch ${repo.branch}, and no origin remote is configured for push.`
        : 'Repo has no upstream and no origin remote for push.',
      skippedReason: null,
    };
  }

  return {
    args: ['push', '-u', 'origin', 'HEAD'],
    command: 'git push -u origin HEAD',
    blocker: null,
    skippedReason: null,
  };
}

function markdownSummary(result: Omit<CommitCreateResult, 'artifact'>) {
  const lines = [
    `# Commit Create: ${result.repo}`,
    '',
    `- Path: ${result.path}`,
    `- Branch: ${result.branch ?? 'unknown'}`,
    `- Head: ${result.headSha ?? 'unknown'}`,
    `- Upstream: ${result.upstream ?? 'none'}`,
    `- Issue: ${result.issue ?? 'none inferred'}`,
    `- Suggested message: ${result.suggestedMessage}`,
    `- Committed: ${result.committed ? 'yes' : 'no'}`,
    `- Push: ${result.pushSkippedReason ? `skipped (${result.pushSkippedReason})` : result.pushCommand ? `${result.pushed ? 'pushed' : 'planned'} ${result.pushCommand}` : 'none'}`,
  ];

  if (result.committedSha) lines.push(`- Commit SHA: ${result.committedSha}`);

  lines.push('', '## Changes');
  if (result.changes.length === 0) {
    lines.push('', 'No changed files detected.');
  } else {
    for (const change of result.changes) {
      const state = change.staged && change.unstaged ? 'staged+unstaged' : change.staged ? 'staged' : 'unstaged';
      lines.push(`- ${change.indexStatus}${change.worktreeStatus} ${change.path} (${state})`);
    }
  }

  lines.push('', '## Validation');
  if (result.validation.length === 0) {
    lines.push('', 'No validation commands were requested.');
  } else {
    for (const validation of result.validation) {
      lines.push(`- ${validation.ok ? 'ok' : 'failed'} ${validation.command} (${validation.durationMs}ms, exit ${validation.status ?? 'unknown'})`);
    }
  }

  lines.push('', '## Warnings');
  if (result.warnings.length === 0) {
    lines.push('', 'No warnings.');
  } else {
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push('', '## Blockers');
  if (result.blocked.length === 0) {
    lines.push('', 'No blockers.');
  } else {
    for (const blocker of result.blocked) lines.push(`- ${blocker}`);
  }

  return lines.join('\n');
}

function postIssueProgressComment(issue: string, body: string): IssueProgressCommentResult {
  let ref: { repo: string; number: number };
  try {
    ref = parseRepoRef(issue);
  } catch (error) {
    return {
      issue,
      applied: false,
      url: null,
      reason: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const result = spawnSync('gh', ['issue', 'comment', String(ref.number), '--repo', ref.repo, '--body', body], { encoding: 'utf8' });
  if (result.status !== 0) {
    return {
      issue,
      applied: false,
      url: null,
      reason: null,
      error: result.stderr.trim() || `gh issue comment failed with exit ${result.status ?? 'unknown'}.`,
    };
  }

  return {
    issue,
    applied: true,
    url: result.stdout.trim() || null,
    reason: null,
    error: null,
  };
}

function parseJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Adapter output did not contain a JSON object.');
    return JSON.parse(raw.slice(start, end + 1));
  }
}

function parseCommitSummary(raw: string) {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('Adapter output JSON was not an object.');
  const summary = (parsed as Record<string, unknown>).summary;
  if (typeof summary !== 'string' || !summary.trim()) {
    throw new Error('Adapter output did not include a non-empty summary.');
  }
  return summary.trim();
}

function runAdapterForFinalMessage(
  workspaceRoot: string,
  repoPath: string,
  prompt: string,
  usage: {
    issue: string | null;
    repo: string;
    commandRunId: string;
  }
) {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'warroom-commit-summary-'));
  const outputPath = path.join(outputDir, 'last-message.txt');
  try {
    const launch = runAdapter(workspaceRoot, prompt, {
      cwd: repoPath,
      outputLastMessagePath: outputPath,
      captureStdout: true,
      usage: {
        issue: usage.issue,
        command: 'commit-create',
        stage: 'commit-summary',
        repo: usage.repo,
        commandRunId: usage.commandRunId,
      },
    });
    const message = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : (launch.stdout?.trim() ?? '');
    return {
      message,
      adapterCommand: launch.invocation.display,
      error: launch.launched ? null : launch.error ?? 'LLM adapter failed.',
    };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function gitShow(repoPath: string, sha: string | null) {
  if (!sha) return '';
  const result = runGit(repoPath, ['show', '--stat', '--patch', '--find-renames', '--find-copies', '--unified=3', '--no-ext-diff', sha]);
  return result.status === 0 ? result.stdout : '';
}

function trimPromptSection(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated ${value.length - maxLength} characters by warroom]`;
}

function buildCommitSummaryPrompt(result: Omit<CommitCreateResult, 'artifact' | 'issueComment'>, diff: string) {
  return [
    'War Room commit update summary.',
    '',
    'Return only JSON with exactly this string field:',
    '{"summary":"..."}',
    '',
    'Rules:',
    '- Summarize what changed in this commit for the GitHub issue audience.',
    '- Prefer business or implementation impact over listing files.',
    '- Mention tests, docs, validation, migrations, public APIs, or operational risk only when visible below.',
    '- Do not include secrets, private env values, PII, or raw customer data.',
    '- Do not wrap the JSON in markdown fences.',
    '',
    `Repository: ${result.githubRepo}`,
    `Branch: ${result.branch ?? 'unknown'}`,
    result.committedSha ? `Commit: ${result.committedSha}` : 'Commit: unknown',
    `Commit title: ${result.suggestedMessage}`,
    '',
    'Validation requested:',
    result.validation.length
      ? result.validation
          .map((validation) => `- ${validation.ok ? 'passed' : 'failed'}: ${validation.command} (exit ${validation.status ?? 'unknown'})`)
          .join('\n')
      : '- none requested through warroom commit create',
    '',
    'Committed diff:',
    trimPromptSection(diff || '(diff unavailable)', 60_000),
  ].join('\n');
}

function fallbackCommitSummary(result: Omit<CommitCreateResult, 'artifact' | 'issueComment'>) {
  const changed = result.changes.length;
  const validation = result.validation.length
    ? ` Validation ${result.validation.every((entry) => entry.ok) ? 'passed' : 'had failures'} for ${result.validation
        .map((entry) => `\`${entry.command}\``)
        .join(', ')}.`
    : '';
  return `Committed \`${result.suggestedMessage}\` with ${changed} changed file${changed === 1 ? '' : 's'}.${validation}`.trim();
}

function generateCommitSummary(
  workspaceRoot: string,
  result: Omit<CommitCreateResult, 'artifact' | 'issueComment'>,
  commandRunId: string
) {
  if (!result.committed || !result.committedSha) {
    return { summary: fallbackCommitSummary(result), adapterCommand: null as string | null, error: null as string | null };
  }

  let adapterCommand: string | null = null;
  try {
    const diff = gitShow(result.path, result.committedSha);
    const adapter = runAdapterForFinalMessage(workspaceRoot, result.path, buildCommitSummaryPrompt(result, diff), {
      issue: result.issue,
      repo: result.githubRepo,
      commandRunId,
    });
    adapterCommand = adapter.adapterCommand;
    if (adapter.error) {
      return { summary: fallbackCommitSummary(result), adapterCommand, error: adapter.error };
    }
    if (!adapter.message) {
      return { summary: fallbackCommitSummary(result), adapterCommand, error: 'LLM adapter completed but did not return a final message.' };
    }
    return { summary: parseCommitSummary(adapter.message), adapterCommand, error: null };
  } catch (error) {
    return {
      summary: fallbackCommitSummary(result),
      adapterCommand: adapterCommand ?? getAdapterInvocation(workspaceRoot, result.path).display,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function commitIssueCommentBody(
  workspaceRoot: string,
  result: Omit<CommitCreateResult, 'artifact' | 'issueComment'>,
  commandRunId: string,
  summaryResult = generateCommitSummary(workspaceRoot, result, commandRunId)
) {
  const lines = [
    '## War Room commit update',
    '',
    `Repo: ${result.githubRepo}`,
    `Branch: ${result.branch ?? 'unknown'}`,
    result.committedSha ? `Commit: ${result.committedSha}` : null,
    `Title: ${result.suggestedMessage}`,
    `Pushed: ${result.pushed ? 'yes' : result.pushSkippedReason ? `no (${result.pushSkippedReason})` : 'no'}`,
    '',
    'Summary:',
    summaryResult.summary,
  ].filter((line): line is string => line !== null);

  lines.push('', 'Validation:');
  if (result.validation.length === 0) {
    lines.push('- not run by `warroom commit create`');
  } else {
    for (const validation of result.validation) {
      lines.push(`- ${validation.ok ? 'passed' : 'failed'}: ${validation.command} (exit ${validation.status ?? 'unknown'})`);
    }
  }

  return lines.join('\n');
}

function buildIssueCommentResult(
  issue: string | null,
  confirm: boolean | undefined,
  issueCommentEnabled: boolean | undefined,
  committed: boolean,
  body: string | null
) {
  if (!issue) return null;
  if (issueCommentEnabled === false) {
    return { issue, applied: false, url: null, reason: 'Issue progress comments disabled by --no-issue-comment.', error: null };
  }
  if (!confirm || !committed || !body) {
    return { issue, applied: false, url: null, reason: 'Commit not created yet.', error: null };
  }
  return postIssueProgressComment(issue, body);
}

export function runCommitCreate(workspaceRoot: string, options: CommitCreateOptions = {}): CommitCreateResult {
  const commandRunId = createUsageCommandRunId('commit-create');
  const manifest = loadRepoManifest(workspaceRoot);
  const repoHealth = manifest.repos.map((entry) => getRepoHealth(workspaceRoot, entry));
  const repoId =
    options.repo ??
    inferRepoFromPath(repoHealth, options.currentPath ?? process.cwd()) ??
    inferRepoFromIssue(repoHealth, options.issue) ??
    inferRepoFromMappedBranches(repoHealth, manifest.defaults.default_branch);
  if (!repoId) {
    throw new Error(
      'warroom commit create requires --repo <id> unless run inside a mapped child repo or on a single active mapped development branch.'
    );
  }
  const repoEntry = getRepoById(workspaceRoot, repoId);
  const repo = getRepoHealth(workspaceRoot, repoEntry);
  const issueRef = options.issue ?? currentBranchIssueRef(repo.github, repo.branch, repo.resolvedPath);
  const dirtyRepos = repoHealth
    .filter((entry) => entry.id !== repo.id && entry.clean === false);
  const warnings = dirtyRepos.length > 0 ? [`Other child repos are dirty: ${dirtyRepos.map((entry) => entry.id).join(', ')}`] : [];
  const blocked: string[] = [];

  if (!repo.checkedOut) blocked.push(`Repo checkout is missing: ${repo.resolvedPath}`);
  if (repo.clean !== false) blocked.push('Repo has no changes to commit.');

  const changes = repo.clean === false ? repo.statusLines.map(parseStatusLine) : [];
  const stagedChanges = changes.filter((change) => change.staged);
  const unstagedChanges = changes.filter((change) => change.unstaged);
  const pushPlan = buildPushPlan(repo, options.push !== false);

  if (options.confirm && !options.all && stagedChanges.length === 0) {
    blocked.push('No staged changes are ready to commit. Stage files first or pass --all.');
  }
  if (options.confirm && !options.all && unstagedChanges.length > 0) {
    blocked.push('Unstaged changes are present. Commit staged changes manually or pass --all.');
  }
  if (pushPlan.blocker) {
    blocked.push(pushPlan.blocker);
  }

  const validation = blocked.length === 0 ? (options.validate ?? []).map((command) => runValidation(repo.resolvedPath, command)) : [];
  for (const failed of validation.filter((result) => !result.ok)) {
    blocked.push(`Validation failed: ${failed.command}`);
  }

  const suggestedMessage = options.message ?? suggestMessage(repo.id, changes);
  let committed = false;
  let committedSha: string | null = null;
  let pushed = false;

  if (options.confirm) {
    if (blocked.length > 0) throw new Error(blocked.join(' '));
    if (options.all) {
      const add = spawnSync('git', ['add', '-A'], { cwd: repo.resolvedPath, stdio: 'inherit' });
      if (add.status !== 0) throw new Error(`git add failed with exit ${add.status ?? 'unknown'}.`);
    }
    const commit = spawnSync('git', ['commit', '-m', suggestedMessage], { cwd: repo.resolvedPath, stdio: 'inherit' });
    if (commit.status !== 0) throw new Error(`git commit failed with exit ${commit.status ?? 'unknown'}.`);
    committed = true;
    const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo.resolvedPath, encoding: 'utf8' });
    committedSha = sha.status === 0 ? sha.stdout.trim() : null;

    if (pushPlan.args) {
      const push = spawnSync('git', pushPlan.args, { cwd: repo.resolvedPath, stdio: 'inherit' });
      if (push.status !== 0) {
        throw new Error(`${pushPlan.command ?? `git ${pushPlan.args.map(shellQuote).join(' ')}`} failed with exit ${push.status ?? 'unknown'}.`);
      }
      pushed = true;
    }
  }

  const baseResult: Omit<CommitCreateResult, 'artifact' | 'issueComment'> = {
    repo: repo.id,
    githubRepo: repo.github,
    path: repo.resolvedPath,
    branch: repo.branch,
    headSha: repo.headSha,
    upstream: repo.upstream,
    issue: issueRef,
    clean: repo.clean,
    statusLines: repo.statusLines,
    changes,
    validation,
    suggestedMessage,
    committed,
    committedSha,
    pushed,
    pushCommand: pushPlan.command,
    pushSkippedReason: pushPlan.skippedReason,
    warnings,
    blocked,
  };
  const issueCommentBody =
    issueRef && options.issueComment !== false ? commitIssueCommentBody(workspaceRoot, baseResult, commandRunId) : null;
  const issueComment = buildIssueCommentResult(
    issueRef,
    options.confirm,
    options.issueComment,
    committed,
    issueCommentBody
  );
  const result: Omit<CommitCreateResult, 'artifact'> = {
    ...baseResult,
    issueComment,
  };

  if (!options.writeArtifact) return result;

  return {
    ...result,
    artifact: createRunArtifact(workspaceRoot, 'commit-create', {
      'input.json': JSON.stringify(
        {
          repo: repoId,
          issue: options.issue ?? null,
          message: options.message ?? null,
          confirm: options.confirm ?? false,
          all: options.all ?? false,
          push: options.push ?? true,
          issueComment: options.issueComment ?? true,
          validate: options.validate ?? [],
          writeArtifact: true,
        },
        null,
        2
      ),
      'result.json': JSON.stringify(result, null, 2),
      'summary.md': markdownSummary(result),
      ...(issueComment ? { 'issue-comment.json': JSON.stringify(issueComment, null, 2) } : {}),
      ...(issueCommentBody ? { 'issue-comment.md': issueCommentBody } : {}),
      ...(issueRef ? { 'usage.json': JSON.stringify(usageEntriesForCommandRun(workspaceRoot, issueRef, commandRunId), null, 2) } : {}),
      'status.txt': repo.statusLines.join('\n'),
      'validation.json': JSON.stringify(validation, null, 2),
    }),
  };
}
