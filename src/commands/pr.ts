import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunArtifact, type RunArtifact } from '../lib/artifacts.js';
import {
  listCampaignIssuesByStatus,
  setCampaignStatus,
  type CampaignProjectIssue,
  type CampaignStatusName,
  type CampaignStatusSetResult,
} from '../lib/campaign.js';
import { getAdapterInvocation, runAdapter } from '../lib/env.js';
import { closingIssueRefFromText, ownerRepoFromText } from '../lib/issue-links.js';
import {
  createUsageCommandRunId,
  summarizeIssueUsage,
  usageEntriesForCommandRun,
  type LlmUsageSummary,
} from '../lib/llm-usage.js';
import { getRepoHealth, loadRepoManifest, runGit } from '../lib/repos.js';
import { buildSpecialistContext } from '../lib/specialist-context.js';
import { parseIssueRef, setIssueWorkflowLabel, type IssueLabelUpdateResult, type IssueRef } from './issues.js';

export type PrTextResult = {
  source: 'adapter' | 'fallback' | 'manual';
  adapterCommand: string | null;
  error: string | null;
};

export type PrOptions = {
  issue?: string;
  pr?: string;
  branch?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  push?: boolean;
  dryRun?: boolean;
  writeArtifact?: boolean;
  confirm?: boolean;
  skipMergeE2E?: boolean;
  base?: string;
  confirmStatus?: boolean;
  summary?: string;
  postSummary?: boolean;
  confirmSummary?: boolean;
  cleanupLocal?: boolean;
  confirmCleanup?: boolean;
  issueComment?: boolean;
  checkInMinutes?: number;
  allowUnresolvedReviewThreads?: boolean;
  issueTitle?: string;
  issueUrl?: string;
  prText?: PrTextResult;
  currentPath?: string;
  waitForInitialCodeRabbit?: boolean;
  e2eStatus?: (message: string) => void;
  e2eOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  mergeStatus?: (message: string) => void;
  reviewStatus?: (message: string) => void;
};

export type MergeE2EResult = {
  status: 'planned' | 'passed' | 'failed' | 'skipped';
  required: boolean;
  skipReason: string | null;
  backendPath: string | null;
  backendHeadSha: string | null;
  demoPath: string | null;
  demoHeadSha: string | null;
  backendCommand: string;
  backendReadyUrl: string;
  demoCommand: string;
  demoBaseUrl: string;
  billingApiUrl: string;
  durationMs: number | null;
  testExitStatus: number | null;
  usedExistingBackend: boolean;
  startedBackend: boolean;
  blocked: string[];
  error: string | null;
};

export type MergeChangelogResult = {
  status: 'planned' | 'passed' | 'failed' | 'skipped';
  required: boolean;
  skipReason: string | null;
  repo: string;
  path: string | null;
  base: string;
  currentBranch: string | null;
  changelogPath: string | null;
  version: string | null;
  actionsHeadSha: string | null;
  actionsRuns: Array<{
    databaseId: number | null;
    name: string;
    status: string;
    conclusion: string | null;
    headSha: string | null;
    url: string | null;
  }>;
  durationMs: number | null;
  committed: boolean;
  pushed: boolean;
  commitSha: string | null;
  blocked: string[];
  error: string | null;
};

export type MergeReadiness = {
  mergeStateStatus: string | null;
  mergeable: string | null;
  reviewDecision: string | null;
  isDraft: boolean | null;
  checks: Array<{
    name: string;
    state: string;
    url: string | null;
  }>;
  blocked: string[];
  details: Array<{
    blocker: string;
    explanation: string;
    resolution: string;
    evidence: string[];
  }>;
  requestedReviewers: string[];
  unresolvedReviewThreads: Array<{
    threadId?: string;
    commentId?: string;
    path: string;
    line: number | null;
    author: string;
    url: string | null;
    isOutdated: boolean;
    excerpt: string;
  }>;
};

export type SummaryPostResult = {
  target: 'pr' | 'issue';
  ref: string;
  applied: boolean;
  url: string | null;
  reason: string | null;
  error: string | null;
};

export type LocalCleanupResult = {
  repo: string;
  path: string | null;
  currentBranch: string | null;
  targetBranch: string | null;
  clean: boolean | null;
  applied: boolean;
  blocked: string[];
  messages: string[];
};

export type PrReviewLoopResult = {
  status: 'planned' | 'passed' | 'failed';
  completed: boolean;
  iterations: Array<{
    iteration: number;
    startHeadSha: string | null;
    endHeadSha: string | null;
    adapterLaunched: boolean;
    adapterError: string | null;
    outstandingCodeRabbitComments: number | null;
    codeRabbitObserved: boolean | null;
    codeRabbitSettled: boolean | null;
  }>;
  blocked: string[];
  error: string | null;
};

export type PrPlanResult = {
  prompt: string;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string | null;
  action: 'issue-start' | 'review' | 'merge';
  issue?: string | null;
  campaignStatus: CampaignStatusSetResult | null;
  labelUpdate?: IssueLabelUpdateResult | null;
  developmentBranch?: DevelopmentBranchResult;
  mergeReadiness?: MergeReadiness;
  summary?: string;
  summaryPosts?: SummaryPostResult[];
  finalIssueComment?: SummaryPostResult | null;
  merged?: boolean;
  localCleanup?: LocalCleanupResult | null;
  mergeE2E?: MergeE2EResult;
  mergeChangelog?: MergeChangelogResult;
  prReviewLoop?: PrReviewLoopResult;
  usageSummary?: LlmUsageSummary | null;
  contextSummary?: {
    promptCharacters: number;
    changedFiles?: number;
    comments?: number;
    reviews?: number;
    checks?: number;
    checkInMinutes?: number;
  };
  adapterCwd?: string | null;
  launchError?: string | null;
};

export type PrCreateResult = {
  action: 'create';
  repo: string;
  path: string;
  branch: string;
  base: string;
  issue: string | null;
  title: string;
  body: string;
  draft: boolean;
  pushed: boolean;
  pushCommand: string | null;
  createCommand: string;
  created: boolean;
  url: string | null;
  blocked: string[];
  campaignStatus: CampaignStatusSetResult | null;
  labelUpdate: IssueLabelUpdateResult | null;
  prText: PrTextResult;
  issueComment: SummaryPostResult | null;
  artifact?: RunArtifact;
};

export type DevelopmentBranchResult = {
  repo: string;
  path: string | null;
  branch: string;
  base: string;
  command: string;
  checkoutRequired: boolean;
  applied: boolean;
  linked: boolean;
  checkedOut: boolean;
  blocked: string[];
  output: string | null;
  error: string | null;
};

export type PrReviewQueueIssue = {
  repo: string;
  number: number;
  title: string;
  url: string;
  status: CampaignStatusName | null;
};

export type PrReviewQueueItem = {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  updatedAt: string | null;
  issues: PrReviewQueueIssue[];
};

export type PrReviewQueueResult = {
  action: 'review';
  source: 'campaign';
  statuses: CampaignStatusName[];
  issues: PrReviewQueueIssue[];
  prs: PrReviewQueueItem[];
};

const REVIEW_QUEUE_STATUSES: CampaignStatusName[] = ['battlefield-active', 'skirmish'];
const DEFAULT_BACKEND_COMMAND = 'npm run start:api';
const DEFAULT_DEMO_E2E_COMMAND = 'npm run test:e2e';
const DEFAULT_BACKEND_BASE_URL = 'https://api.local.flopay.com';
const DEFAULT_DEMO_BASE_URL = 'https://demo.local.flopay.com';
const DEFAULT_BACKEND_READY_PATH = '/v1/health';
const DEFAULT_BACKEND_READY_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_BACKEND_READY_TIMEOUT_MS = 120_000;
const NODE_USE_SYSTEM_CA_FLAG = '--use-system-ca';
const DEFAULT_CHANGELOG_ACTIONS_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_CHANGELOG_ACTIONS_POLL_MS = 15_000;
const DEFAULT_CHANGELOG_ACTIONS_SETTLE_MS = 5_000;
const DEFAULT_PR_REVIEW_MAX_LOOPS = 5;
const DEFAULT_PR_REVIEW_COMMIT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_PR_REVIEW_CODERABBIT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_PR_REVIEW_CODERABBIT_SETTLE_MS = 60_000;
const DEFAULT_PR_REVIEW_POLL_MS = 15_000;
const PR_TEXT_DIRECT_DIFF_LIMIT = 60_000;
const PR_TEXT_DIFF_CHUNK_SIZE = 45_000;

function ghJson<T>(args: string[], fallback: T): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
}

function ghJsonStrict<T>(args: string[]): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}.`);
  }
  if (!result.stdout.trim()) throw new Error(`gh ${args.join(' ')} returned empty output.`);
  return JSON.parse(result.stdout) as T;
}

function ghTextStrict(args: string[]) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}.`);
  }
  return result.stdout.trim();
}

function repoEntryForGitHub(workspaceRoot: string, githubRepo: string) {
  const manifest = loadRepoManifest(workspaceRoot);
  return manifest.repos.find((entry) => entry.github === githubRepo) ?? null;
}

function repoWorkspaceForGitHub(workspaceRoot: string, githubRepo: string) {
  const repo = repoEntryForGitHub(workspaceRoot, githubRepo);
  if (!repo) return workspaceRoot;

  const health = getRepoHealth(workspaceRoot, repo);
  return health.checkedOut ? health.resolvedPath : workspaceRoot;
}

function repoIdForGitHub(workspaceRoot: string, githubRepo: string) {
  return repoEntryForGitHub(workspaceRoot, githubRepo)?.id ?? null;
}

function mergePlaywrightRequirement(workspaceRoot: string, githubRepo: string) {
  const repo = repoEntryForGitHub(workspaceRoot, githubRepo);
  if (!repo) {
    return {
      required: false,
      skipReason: `No mapped repo entry with merge.playwright: true for ${githubRepo}.`,
    };
  }

  return repo.merge.playwright
    ? { required: true, skipReason: null }
    : { required: false, skipReason: `repos.yaml has merge.playwright: false for ${githubRepo}.` };
}

function mergePlaywrightSkipRequirement() {
  return {
    required: false,
    skipReason: 'Skipped by user during interactive merge confirmation.',
  };
}

function mergeChangelogRequirement(workspaceRoot: string, githubRepo: string) {
  const repo = repoEntryForGitHub(workspaceRoot, githubRepo);
  if (!repo) {
    return {
      required: false,
      skipReason: `No mapped repo entry with merge.changelog: true for ${githubRepo}.`,
    };
  }

  return repo.merge.changelog
    ? { required: true, skipReason: null }
    : { required: false, skipReason: `repos.yaml has merge.changelog: false for ${githubRepo}.` };
}

function parsePrRef(value: string) {
  const match = value.match(/^([^#]+)#(\d+)$/);
  if (!match) throw new Error('PR references must use owner/repo#number, for example TeamFloPay/sdk#12.');
  return { repo: match[1], number: Number(match[2]) };
}

function truncateText(value: string | undefined, limit = 6000) {
  if (!value) return '(not available)';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Truncated by War Room to keep the handoff scoped. Re-run with direct GitHub inspection if more context is needed.]`;
}

function fullText(value: string | undefined) {
  return value && value.trim() ? value : '(not available)';
}

function slugBranchPart(value: string | undefined, fallback: string) {
  const slug = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function featureBranchForIssue(ref: { repo: string; number: number }, title: string | undefined) {
  return `warroom/${ref.number}-${slugBranchPart(title, ref.repo.split('/').pop() ?? 'issue')}`;
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

type LinkedBranchSetup = {
  ok: boolean;
  output: string | null;
  error: string | null;
};

type LinkedBranchLookupResponse = {
  issueRepo?: {
    issue?: {
      id?: string;
      linkedBranches?: {
        nodes?: Array<{
          ref?: {
            name?: string;
            repository?: {
              nameWithOwner?: string;
            } | null;
          } | null;
        } | null>;
      } | null;
    } | null;
  } | null;
  implementationRepo?: {
    id?: string;
    ref?: {
      target?: {
        oid?: string;
      } | null;
    } | null;
  } | null;
};

function formatLinkedBranchCommand(ref: IssueRef, implementationRepo: string, branch: string, base: string) {
  return `gh api graphql createLinkedBranch ${ref.repo}#${ref.number} -> ${implementationRepo}:${branch} from ${base}`;
}

function linkedBranchLookup(ref: IssueRef, implementationRepo: string, base: string, branch: string) {
  const issueParts = repoParts(ref.repo);
  const implementationParts = repoParts(implementationRepo);
  if (!issueParts || !implementationParts) {
    return {
      ok: false,
      output: null,
      error: `Invalid repository reference for linked branch: ${ref.repo} -> ${implementationRepo}.`,
      issueId: null,
      implementationRepositoryId: null,
      baseOid: null,
      alreadyLinked: false,
    };
  }

  const query = `
query LinkedBranchInputs($issueOwner: String!, $issueName: String!, $issueNumber: Int!, $implementationOwner: String!, $implementationName: String!, $baseRef: String!) {
  issueRepo: repository(owner: $issueOwner, name: $issueName) {
    issue(number: $issueNumber) {
      id
      linkedBranches(first: 50) {
        nodes {
          ref {
            name
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  }
  implementationRepo: repository(owner: $implementationOwner, name: $implementationName) {
    id
    ref(qualifiedName: $baseRef) {
      target {
        oid
      }
    }
  }
}
`;
  const result = spawnSync(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `issueOwner=${issueParts.owner}`,
      '-f',
      `issueName=${issueParts.name}`,
      '-F',
      `issueNumber=${ref.number}`,
      '-f',
      `implementationOwner=${implementationParts.owner}`,
      '-f',
      `implementationName=${implementationParts.name}`,
      '-f',
      `baseRef=refs/heads/${base}`,
    ],
    { encoding: 'utf8' }
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || null;
  if (result.status !== 0) {
    return {
      ok: false,
      output,
      error: output || `GitHub linked branch lookup failed with exit ${result.status ?? 'unknown'}.`,
      issueId: null,
      implementationRepositoryId: null,
      baseOid: null,
      alreadyLinked: false,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as { data?: LinkedBranchLookupResponse; errors?: unknown[] };
    if (parsed.errors?.length) {
      return {
        ok: false,
        output,
        error: output || 'GitHub linked branch lookup returned GraphQL errors.',
        issueId: null,
        implementationRepositoryId: null,
        baseOid: null,
        alreadyLinked: false,
      };
    }

    const issue = parsed.data?.issueRepo?.issue ?? null;
    const issueId = issue?.id ?? null;
    const implementationRepositoryId = parsed.data?.implementationRepo?.id ?? null;
    const baseOid = parsed.data?.implementationRepo?.ref?.target?.oid ?? null;
    const alreadyLinked = Boolean(
      issue?.linkedBranches?.nodes?.some((node) => node?.ref?.name === branch && node?.ref?.repository?.nameWithOwner === implementationRepo)
    );
    if (!issueId || !implementationRepositoryId || !baseOid) {
      return {
        ok: false,
        output,
        error: `Could not resolve linked branch inputs for ${ref.repo}#${ref.number} -> ${implementationRepo}:${base}.`,
        issueId,
        implementationRepositoryId,
        baseOid,
        alreadyLinked,
      };
    }

    return { ok: true, output, error: null, issueId, implementationRepositoryId, baseOid, alreadyLinked };
  } catch (error) {
    return {
      ok: false,
      output,
      error: `Could not parse GitHub linked branch lookup response: ${error instanceof Error ? error.message : String(error)}`,
      issueId: null,
      implementationRepositoryId: null,
      baseOid: null,
      alreadyLinked: false,
    };
  }
}

function createGitHubLinkedBranch(ref: IssueRef, implementationRepo: string, branch: string, base: string): LinkedBranchSetup {
  const lookup = linkedBranchLookup(ref, implementationRepo, base, branch);
  if (!lookup.ok || !lookup.issueId || !lookup.implementationRepositoryId || !lookup.baseOid) {
    return { ok: false, output: lookup.output, error: lookup.error };
  }
  if (lookup.alreadyLinked) return { ok: true, output: lookup.output, error: null };

  const mutation = `
mutation CreateLinkedBranch($issueId: ID!, $repositoryId: ID!, $name: String!, $oid: GitObjectID!) {
  createLinkedBranch(input: { issueId: $issueId, repositoryId: $repositoryId, name: $name, oid: $oid }) {
    issue {
      number
    }
    linkedBranch {
      id
    }
  }
}
`;
  const result = spawnSync(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${mutation}`,
      '-f',
      `issueId=${lookup.issueId}`,
      '-f',
      `repositoryId=${lookup.implementationRepositoryId}`,
      '-f',
      `name=${branch}`,
      '-f',
      `oid=${lookup.baseOid}`,
    ],
    { encoding: 'utf8' }
  );
  const output = [lookup.output, `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()].filter(Boolean).join('\n') || null;
  if (result.status !== 0) {
    return {
      ok: false,
      output,
      error: output || `GitHub linked branch creation failed with exit ${result.status ?? 'unknown'}.`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as { errors?: unknown[] };
    if (parsed.errors?.length) {
      return {
        ok: false,
        output,
        error: output || 'GitHub linked branch creation returned GraphQL errors.',
      };
    }
  } catch {
    return { ok: false, output, error: 'Could not parse GitHub linked branch creation response.' };
  }

  return { ok: true, output, error: null };
}

function checkoutLinkedBranch(repoPath: string, branch: string) {
  const fetch = runGit(repoPath, ['fetch', 'origin', branch]);
  const branchExistsLocally = branchExists(repoPath, branch);
  const checkout = branchExistsLocally
    ? runGit(repoPath, ['switch', branch])
    : runGit(repoPath, ['switch', '-c', branch, '--track', `origin/${branch}`]);
  const upstream = checkout.status === 0 ? runGit(repoPath, ['branch', '--set-upstream-to', `origin/${branch}`, branch]) : null;
  const output =
    [
      fetch.stdout,
      fetch.stderr,
      checkout.stdout,
      checkout.stderr,
      upstream?.stdout,
      upstream?.stderr,
    ]
      .filter(Boolean)
      .join('\n') || null;

  if (fetch.status !== 0) {
    return {
      ok: false,
      output,
      error: output || `Development branch fetch failed with exit ${fetch.status ?? 'unknown'}.`,
    };
  }
  if (checkout.status !== 0) {
    return {
      ok: false,
      output,
      error: output || `Development branch checkout failed with exit ${checkout.status ?? 'unknown'}.`,
    };
  }
  if (upstream && upstream.status !== 0) {
    return {
      ok: false,
      output,
      error: output || `Development branch upstream setup failed with exit ${upstream.status ?? 'unknown'}.`,
    };
  }

  return { ok: true, output, error: null };
}

function createDevelopmentBranchResult(
  workspaceRoot: string,
  ref: IssueRef,
  title: string | undefined,
  base: string,
  apply: boolean,
  checkoutRequired: boolean,
  implementationRepo = ref.repo
): DevelopmentBranchResult {
  const branch = featureBranchForIssue(ref, title);
  const repoEntry = repoEntryForGitHub(workspaceRoot, implementationRepo);
  const crossRepo = implementationRepo !== ref.repo;
  const commandArgs = crossRepo
    ? []
    : [
        'issue',
        'develop',
        String(ref.number),
        '--repo',
        ref.repo,
        '--base',
        base,
        '--name',
        branch,
      ];
  if (!crossRepo && checkoutRequired) commandArgs.push('--checkout');
  const command = crossRepo ? formatLinkedBranchCommand(ref, implementationRepo, branch, base) : ['gh', ...commandArgs].join(' ');
  const blocked: string[] = [];

  if (!repoEntry) {
    blocked.push(`repos.yaml does not define a mapped checkout for ${implementationRepo}.`);
  }

  const repo = repoEntry ? getRepoHealth(workspaceRoot, repoEntry) : null;
  if (repo && !repo.checkedOut) blocked.push(`Mapped checkout is missing: ${repo.resolvedPath}`);
  if (checkoutRequired && repo?.clean === false) {
    blocked.push(`Mapped checkout has local changes. Commit, stash, or move them before creating ${branch}.`);
  }

  if (!apply || blocked.length > 0 || !repo?.checkedOut) {
    return {
      repo: implementationRepo,
      path: repo?.resolvedPath ?? null,
      branch,
      base,
      command,
      checkoutRequired,
      applied: false,
      linked: false,
      checkedOut: false,
      blocked,
      output: null,
      error: blocked.length > 0 ? blocked.join(' ') : null,
    };
  }

  if (crossRepo) {
    const linkedBranch = createGitHubLinkedBranch(ref, implementationRepo, branch, base);
    const checkout = linkedBranch.ok ? checkoutLinkedBranch(repo.resolvedPath, branch) : null;
    let output = [linkedBranch.output, checkout?.output].filter(Boolean).join('\n') || null;
    if (!linkedBranch.ok || !checkout?.ok) {
      const error = linkedBranch.error ?? checkout?.error ?? 'Development linked branch setup failed.';
      return {
        repo: implementationRepo,
        path: repo.resolvedPath,
        branch,
        base,
        command,
        checkoutRequired,
        applied: false,
        linked: linkedBranch.ok,
        checkedOut: false,
        blocked: [error],
        output,
        error,
      };
    }

    const issueMetadata = runGit(repo.resolvedPath, ['config', `branch.${branch}.warroom-issue`, `${ref.repo}#${ref.number}`]);
    const implementationMetadata = runGit(repo.resolvedPath, ['config', `branch.${branch}.warroom-implementation-repo`, implementationRepo]);
    output =
      [
        output,
        issueMetadata.stdout,
        issueMetadata.stderr,
        implementationMetadata.stdout,
        implementationMetadata.stderr,
      ]
        .filter(Boolean)
        .join('\n') || null;
    if (issueMetadata.status !== 0 || implementationMetadata.status !== 0) {
      return {
        repo: implementationRepo,
        path: repo.resolvedPath,
        branch,
        base,
        command,
        checkoutRequired,
        applied: false,
        linked: false,
        checkedOut: false,
        blocked: ['Development branch metadata setup failed.'],
        output,
        error: output || 'Development branch metadata setup failed.',
      };
    }

    const currentBranch = checkoutRequired ? runGit(repo.resolvedPath, ['branch', '--show-current']) : null;
    const checkedOut = currentBranch ? currentBranch.status === 0 && currentBranch.stdout === branch : false;
    return {
      repo: implementationRepo,
      path: repo.resolvedPath,
      branch,
      base,
      command,
      checkoutRequired,
      applied: true,
      linked: true,
      checkedOut,
      blocked: !checkoutRequired || checkedOut ? [] : [`Created development branch, but local checkout is on ${currentBranch?.stdout || 'unknown'}.`],
      output,
      error: !checkoutRequired || checkedOut ? null : `Expected local checkout on ${branch}, got ${currentBranch?.stdout || 'unknown'}.`,
    };
  }

  const result = spawnSync('gh', commandArgs, { cwd: repo.resolvedPath, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    return {
      repo: ref.repo,
      path: repo.resolvedPath,
      branch,
      base,
      command,
      checkoutRequired,
      applied: false,
      linked: false,
      checkedOut: false,
      blocked: [`Development branch setup failed with exit ${result.status ?? 'unknown'}.`],
      output: output || null,
      error: output || `Development branch setup failed with exit ${result.status ?? 'unknown'}.`,
    };
  }

  runGit(repo.resolvedPath, ['config', `branch.${branch}.warroom-issue`, `${ref.repo}#${ref.number}`]);
  runGit(repo.resolvedPath, ['config', `branch.${branch}.warroom-implementation-repo`, implementationRepo]);

  const currentBranch = checkoutRequired ? runGit(repo.resolvedPath, ['branch', '--show-current']) : null;
  const checkedOut = currentBranch ? currentBranch.status === 0 && currentBranch.stdout === branch : false;
  return {
    repo: ref.repo,
    path: repo.resolvedPath,
    branch,
    base,
    command,
    checkoutRequired,
    applied: true,
    linked: true,
    checkedOut,
    blocked: !checkoutRequired || checkedOut ? [] : [`Created linked development branch, but local checkout is on ${currentBranch?.stdout || 'unknown'}.`],
    output: output || null,
    error: !checkoutRequired || checkedOut ? null : `Expected local checkout on ${branch}, got ${currentBranch?.stdout || 'unknown'}.`,
  };
}

function summarizeList<T>(values: T[] | undefined, map: (value: T) => string, limit = 12) {
  const rows = (values ?? []).slice(0, limit).map(map);
  if ((values ?? []).length > limit) rows.push(`[${(values ?? []).length - limit} more omitted]`);
  return rows.length ? rows.join('\n') : 'none';
}

type LinkedPullRequestNode = {
  __typename?: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  updatedAt?: string;
  repository?: {
    nameWithOwner?: string;
  };
};

type LinkedPullRequestsResponse = {
  data?: {
    repository?: {
      issue?: {
        closedByPullRequestsReferences?: {
          nodes?: LinkedPullRequestNode[];
        };
        timelineItems?: {
          nodes?: Array<{
            source?: LinkedPullRequestNode;
            subject?: LinkedPullRequestNode;
          }>;
        };
      };
    };
  };
};

const LINKED_PULL_REQUESTS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 20) {
        nodes {
          ...PrFields
        }
      }
      timelineItems(last: 100, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest {
                ...PrFields
              }
            }
          }
          ... on ConnectedEvent {
            subject {
              __typename
              ... on PullRequest {
                ...PrFields
              }
            }
          }
        }
      }
    }
  }
}

fragment PrFields on PullRequest {
  number
  title
  url
  state
  updatedAt
  repository {
    nameWithOwner
  }
}
`;

type PullRequestReviewThread = {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: {
    nodes?: Array<{
      id?: string;
      path?: string;
      line?: number | null;
      url?: string;
      body?: string;
      author?: {
        login?: string;
      };
    }>;
  };
};

type PullRequestReviewThreadsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: PullRequestReviewThread[];
        };
      };
    };
  };
};

type PrReviewSnapshot = {
  title?: string;
  body?: string;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
  headRefOid?: string;
  reviews?: Array<{
    author?: {
      login?: string;
    };
    commit?: {
      oid?: string;
    };
    submittedAt?: string;
    state?: string;
  }>;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
    workflowName?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
};

const PULL_REQUEST_REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 20) {
            nodes {
              id
              path
              line
              url
              body
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}
`;

function queueIssueFromCampaignIssue(issue: CampaignProjectIssue): PrReviewQueueIssue {
  return {
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    status: issue.status as CampaignStatusName | null,
  };
}

function linkedPrFromNode(node: LinkedPullRequestNode | undefined, issue: PrReviewQueueIssue): PrReviewQueueItem | null {
  if (!node) return null;
  if (node.__typename && node.__typename !== 'PullRequest') return null;
  if (node.state?.toUpperCase() !== 'OPEN') return null;
  if (!node.number || !node.repository?.nameWithOwner || !node.url) return null;

  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title ?? 'unknown',
    url: node.url,
    state: node.state,
    updatedAt: node.updatedAt ?? null,
    issues: [issue],
  };
}

function repoParts(repo: string) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return null;
  return { owner, name };
}

function listLinkedOpenPrsForIssue(issue: PrReviewQueueIssue): PrReviewQueueItem[] {
  const parts = repoParts(issue.repo);
  if (!parts) return [];

  const response = ghJson<LinkedPullRequestsResponse>(
    [
      'api',
      'graphql',
      '-f',
      `owner=${parts.owner}`,
      '-f',
      `repo=${parts.name}`,
      '-F',
      `number=${issue.number}`,
      '-f',
      `query=${LINKED_PULL_REQUESTS_QUERY}`,
    ],
    {}
  );
  const issueNode = response.data?.repository?.issue;
  const nodes = [
    ...(issueNode?.closedByPullRequestsReferences?.nodes ?? []),
    ...(issueNode?.timelineItems?.nodes ?? []).map((node) => node.source ?? node.subject).filter(Boolean),
  ];

  return nodes
    .map((node) => linkedPrFromNode(node, issue))
    .filter((pr): pr is PrReviewQueueItem => pr !== null);
}

function updatedTime(value: string | null) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export function runPrReviewQueue(): PrReviewQueueResult {
  const issues = REVIEW_QUEUE_STATUSES.flatMap((status) =>
    listCampaignIssuesByStatus(status).map(queueIssueFromCampaignIssue)
  );
  const prsByRef = new Map<string, PrReviewQueueItem>();

  for (const issue of issues) {
    for (const pr of listLinkedOpenPrsForIssue(issue)) {
      const key = `${pr.repo}#${pr.number}`;
      const existing = prsByRef.get(key);
      if (!existing) {
        prsByRef.set(key, pr);
        continue;
      }

      if (!existing.issues.some((entry) => entry.repo === issue.repo && entry.number === issue.number)) {
        existing.issues.push(issue);
      }
    }
  }

  const prs = [...prsByRef.values()].sort((left, right) => {
    const updated = updatedTime(right.updatedAt) - updatedTime(left.updatedAt);
    if (updated !== 0) return updated;
    const repo = left.repo.localeCompare(right.repo);
    if (repo !== 0) return repo;
    return left.number - right.number;
  });

  return {
    action: 'review',
    source: 'campaign',
    statuses: REVIEW_QUEUE_STATUSES,
    issues,
    prs,
  };
}

function ghComment(args: string[]): { url: string | null; error: string | null } {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    return { url: null, error: result.stderr.trim() || `gh exited ${result.status ?? 'unknown'}` };
  }
  return { url: result.stdout.trim() || null, error: null };
}

function fetchPullRequestReviewThreads(ref: { repo: string; number: number }) {
  const parts = repoParts(ref.repo);
  if (!parts) return [];

  const response = ghJson<PullRequestReviewThreadsResponse>(
    [
      'api',
      'graphql',
      '-f',
      `owner=${parts.owner}`,
      '-f',
      `repo=${parts.name}`,
      '-F',
      `number=${ref.number}`,
      '-f',
      `query=${PULL_REQUEST_REVIEW_THREADS_QUERY}`,
    ],
    {}
  );

  return response.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
}

function listPullRequestReviewThreads(ref: { repo: string; number: number }): MergeReadiness['unresolvedReviewThreads'] {
  return fetchPullRequestReviewThreads(ref)
    .filter((thread) => thread.isResolved === false)
    .map((thread) => {
      const comment = thread.comments?.nodes?.[0];
      return {
        threadId: thread.id,
        commentId: comment?.id,
        path: comment?.path ?? 'unknown',
        line: comment?.line ?? null,
        author: comment?.author?.login ?? 'unknown',
        url: comment?.url ?? null,
        isOutdated: thread.isOutdated === true,
        excerpt: truncateText(comment?.body?.replace(/\s+/g, ' ').trim(), 180),
      };
    });
}

function listOutstandingCodeRabbitThreads(ref: { repo: string; number: number }) {
  return listPullRequestReviewThreads(ref).filter(
    (thread) => !thread.isOutdated && thread.author.toLowerCase().includes('coderabbit')
  );
}

function hasCompletionReply(thread: PullRequestReviewThread) {
  return (thread.comments?.nodes ?? []).some((comment) => {
    const author = comment.author?.login?.toLowerCase() ?? '';
    const body = comment.body?.trim() ?? '';
    return !author.includes('coderabbit') && /^(Change made|Skipped):/i.test(body);
  });
}

function listCodeRabbitThreadsMissingReplies(
  ref: { repo: string; number: number },
  expectedThreads: MergeReadiness['unresolvedReviewThreads']
) {
  const expectedById = new Map(
    expectedThreads
      .filter((thread) => thread.threadId)
      .map((thread) => [thread.threadId as string, thread])
  );
  if (expectedById.size === 0) return [];

  const threadsById = new Map(fetchPullRequestReviewThreads(ref).map((thread) => [thread.id, thread]));
  return [...expectedById.entries()]
    .filter(([threadId]) => {
      const thread = threadsById.get(threadId);
      return !thread || !hasCompletionReply(thread);
    })
    .map(([, thread]) => thread);
}

function prReviewSnapshot(ref: { repo: string; number: number }): PrReviewSnapshot {
  return ghJson<PrReviewSnapshot>(
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      ref.repo,
      '--json',
      'title,body,url,headRefName,baseRefName,headRefOid,reviews,statusCheckRollup',
    ],
    {}
  );
}

function prReviewLoopConfig() {
  const maxLoops = Number(envValue('WARROOM_PR_REVIEW_MAX_LOOPS', String(DEFAULT_PR_REVIEW_MAX_LOOPS)));
  const commitTimeout = Number(envValue('WARROOM_PR_REVIEW_COMMIT_TIMEOUT_MS', String(DEFAULT_PR_REVIEW_COMMIT_TIMEOUT_MS)));
  const codeRabbitTimeout = Number(
    envValue('WARROOM_PR_REVIEW_CODERABBIT_TIMEOUT_MS', String(DEFAULT_PR_REVIEW_CODERABBIT_TIMEOUT_MS))
  );
  const codeRabbitSettle = Number(
    envValue('WARROOM_PR_REVIEW_CODERABBIT_SETTLE_MS', String(DEFAULT_PR_REVIEW_CODERABBIT_SETTLE_MS))
  );
  const poll = Number(envValue('WARROOM_PR_REVIEW_POLL_MS', String(DEFAULT_PR_REVIEW_POLL_MS)));

  return {
    maxLoops: Number.isFinite(maxLoops) && maxLoops > 0 ? Math.floor(maxLoops) : DEFAULT_PR_REVIEW_MAX_LOOPS,
    commitTimeoutMs:
      Number.isFinite(commitTimeout) && commitTimeout >= 0 ? commitTimeout : DEFAULT_PR_REVIEW_COMMIT_TIMEOUT_MS,
    codeRabbitTimeoutMs:
      Number.isFinite(codeRabbitTimeout) && codeRabbitTimeout >= 0
        ? codeRabbitTimeout
        : DEFAULT_PR_REVIEW_CODERABBIT_TIMEOUT_MS,
    codeRabbitSettleMs:
      Number.isFinite(codeRabbitSettle) && codeRabbitSettle >= 0
        ? codeRabbitSettle
        : DEFAULT_PR_REVIEW_CODERABBIT_SETTLE_MS,
    pollMs: Number.isFinite(poll) && poll >= 0 ? poll : DEFAULT_PR_REVIEW_POLL_MS,
  };
}

function shortSha(value: string | null | undefined) {
  return value ? value.slice(0, 12) : 'unknown';
}

function isCodeRabbitCheck(check: { name?: string; context?: string; workflowName?: string }) {
  return [check.name, check.context, check.workflowName].some((value) => value?.toLowerCase().includes('coderabbit'));
}

function isTerminalCheckState(value: string | null | undefined) {
  if (!value) return false;
  return [
    'ACTION_REQUIRED',
    'CANCELLED',
    'COMPLETED',
    'ERROR',
    'FAILURE',
    'NEUTRAL',
    'SKIPPED',
    'STALE',
    'STARTUP_FAILURE',
    'SUCCESS',
    'TIMED_OUT',
  ].includes(value.toUpperCase());
}

function codeRabbitChecks(snapshot: PrReviewSnapshot) {
  return (snapshot.statusCheckRollup ?? []).filter(isCodeRabbitCheck);
}

function codeRabbitChecksRunning(snapshot: PrReviewSnapshot) {
  return codeRabbitChecks(snapshot).some((check) => !isTerminalCheckState(check.conclusion ?? check.state ?? check.status));
}

function codeRabbitReviews(snapshot: PrReviewSnapshot) {
  return (snapshot.reviews ?? []).filter((review) => review.author?.login?.toLowerCase().includes('coderabbit'));
}

function codeRabbitReviewedHead(snapshot: PrReviewSnapshot, headSha: string) {
  return codeRabbitReviews(snapshot).some((review) => review.commit?.oid === headSha);
}

function codeRabbitFeedbackFingerprint(
  snapshot: PrReviewSnapshot,
  threads: ReturnType<typeof listOutstandingCodeRabbitThreads>,
  headSha: string
) {
  return JSON.stringify({
    headSha: snapshot.headRefOid ?? headSha,
    checks: codeRabbitChecks(snapshot).map((check) => ({
      name: check.name ?? null,
      context: check.context ?? null,
      workflowName: check.workflowName ?? null,
      status: check.status ?? null,
      conclusion: check.conclusion ?? null,
      state: check.state ?? null,
      startedAt: check.startedAt ?? null,
      completedAt: check.completedAt ?? null,
    })),
    reviews: codeRabbitReviews(snapshot).map((review) => ({
      commit: review.commit?.oid ?? null,
      state: review.state ?? null,
      submittedAt: review.submittedAt ?? null,
    })),
    threads: threads.map((thread) => ({
      path: thread.path,
      line: thread.line,
      author: thread.author,
      url: thread.url,
      excerpt: thread.excerpt,
    })),
  });
}

async function waitForPrHeadChange(
  ref: { repo: string; number: number },
  previousHeadSha: string | null,
  timeoutMs: number,
  pollMs: number
) {
  const startedAt = Date.now();
  while (true) {
    const snapshot = prReviewSnapshot(ref);
    if (snapshot.headRefOid && snapshot.headRefOid !== previousHeadSha) {
      return { changed: true, snapshot };
    }
    if (Date.now() - startedAt >= timeoutMs) return { changed: false, snapshot };
    await delay(pollMs);
  }
}

async function waitForCodeRabbitFeedback(
  ref: { repo: string; number: number },
  headSha: string,
  timeoutMs: number,
  settleMs: number,
  pollMs: number
) {
  const startedAt = Date.now();
  let stableSince: number | null = null;
  let stableFingerprint: string | null = null;
  let lastReason = 'CodeRabbit has not been observed on the latest commit yet.';

  while (true) {
    const snapshot = prReviewSnapshot(ref);
    const threads = listOutstandingCodeRabbitThreads(ref);
    const sameHead = !snapshot.headRefOid || snapshot.headRefOid === headSha;
    const checks = codeRabbitChecks(snapshot);
    const observed = threads.length > 0 || checks.length > 0 || codeRabbitReviewedHead(snapshot, headSha);
    const running = codeRabbitChecksRunning(snapshot);

    if (!sameHead) {
      lastReason = `PR head changed while waiting for CodeRabbit feedback (${shortSha(snapshot.headRefOid)} != ${shortSha(headSha)}).`;
      stableSince = null;
      stableFingerprint = null;
    } else if (!observed) {
      lastReason = 'CodeRabbit has not been observed on the latest commit yet.';
      stableSince = null;
      stableFingerprint = null;
    } else if (running) {
      lastReason = 'CodeRabbit is still reviewing the latest commit.';
      stableSince = null;
      stableFingerprint = null;
    } else {
      const fingerprint = codeRabbitFeedbackFingerprint(snapshot, threads, headSha);
      if (stableFingerprint !== fingerprint) {
        stableFingerprint = fingerprint;
        stableSince = Date.now();
      }
      const settledMs = stableSince === null ? 0 : Date.now() - stableSince;
      if (settledMs >= settleMs) {
        return {
          snapshot,
          threads,
          ready: true,
          codeRabbitObserved: observed,
          codeRabbitSettled: true,
          timedOut: false,
          reason: null,
        };
      }
      lastReason = `CodeRabbit feedback is waiting for a ${settleMs}ms quiet window (${settledMs}ms elapsed).`;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      return {
        snapshot,
        threads,
        ready: false,
        codeRabbitObserved: observed,
        codeRabbitSettled: false,
        timedOut: true,
        reason: lastReason,
      };
    }
    await delay(pollMs);
  }
}

function reviewerName(request: { login?: string; name?: string; slug?: string; __typename?: string }) {
  if (request.login) return `@${request.login}`;
  if (request.slug) return request.slug;
  if (request.name) return request.name;
  return request.__typename ?? 'unknown reviewer';
}

function reviewLabel(review: { state?: string; author?: { login?: string }; submittedAt?: string }) {
  const author = review.author?.login ? ` by @${review.author.login}` : '';
  const submitted = review.submittedAt ? ` at ${review.submittedAt}` : '';
  return `${review.state ?? 'UNKNOWN'}${author}${submitted}`;
}

function checkName(check: { name?: string; context?: string; workflowName?: string }) {
  const name = check.name ?? check.context ?? 'unknown';
  return check.workflowName ? `${name} (${check.workflowName})` : name;
}

function checkState(check: { status?: string; conclusion?: string; state?: string }) {
  return check.conclusion ?? check.state ?? check.status ?? 'unknown';
}

function checkUrl(check: { detailsUrl?: string; targetUrl?: string }) {
  return check.detailsUrl ?? check.targetUrl ?? null;
}

function buildMergeReadiness(pr: {
  mergeStateStatus?: string;
  mergeable?: string;
  reviewDecision?: string;
  isDraft?: boolean;
  reviewRequests?: Array<{ login?: string; name?: string; slug?: string; __typename?: string }>;
  latestReviews?: Array<{ state?: string; author?: { login?: string }; submittedAt?: string }>;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
    workflowName?: string;
    detailsUrl?: string;
    targetUrl?: string;
  }>;
}, unresolvedReviewThreads: MergeReadiness['unresolvedReviewThreads'] = [], options: { allowUnresolvedReviewThreads?: boolean } = {}): MergeReadiness {
  const checks = (pr.statusCheckRollup ?? [])
    .filter((check) => check.name || check.context || check.status || check.conclusion || check.state || check.workflowName)
    .map((check) => ({
      name: checkName(check),
      state: checkState(check),
      url: checkUrl(check),
    }));
  const blocked: string[] = [];
  const details: MergeReadiness['details'] = [];
  const mergeStateStatus = pr.mergeStateStatus ?? null;
  const mergeable = pr.mergeable ?? null;
  const reviewDecision = pr.reviewDecision ?? null;
  const requestedReviewers = (pr.reviewRequests ?? []).map(reviewerName).filter(Boolean);
  const latestReviews = pr.latestReviews ?? [];
  const currentUnresolvedThreads = unresolvedReviewThreads.filter((thread) => !thread.isOutdated);
  const outdatedUnresolvedThreads = unresolvedReviewThreads.filter((thread) => thread.isOutdated);
  const failedChecks = checks.filter((check) =>
    ['ACTION_REQUIRED', 'CANCELLED', 'ERROR', 'FAILURE', 'STARTUP_FAILURE', 'TIMED_OUT'].includes(check.state.toUpperCase())
  );
  const incompleteChecks = checks.filter((check) => {
    const state = check.state.toUpperCase();
    return ![
      'ACTION_REQUIRED',
      'CANCELLED',
      'ERROR',
      'FAILURE',
      'STARTUP_FAILURE',
      'TIMED_OUT',
      'COMPLETED',
      'SUCCESS',
      'SKIPPED',
      'NEUTRAL',
    ].includes(state);
  });

  const addBlocker = (blocker: string, explanation: string, resolution: string, evidence: string[] = []) => {
    blocked.push(blocker);
    details.push({ blocker, explanation, resolution, evidence });
  };

  if (pr.isDraft === true) {
    addBlocker(
      'PR is still marked as draft.',
      'GitHub will not allow a draft PR to merge.',
      'Mark the PR ready for review in GitHub, then rerun `warroom pr merge`.'
    );
  }
  const mergeStateBlockedOnlyByAllowedThreads =
    options.allowUnresolvedReviewThreads === true &&
    mergeStateStatus === 'BLOCKED' &&
    currentUnresolvedThreads.length > 0 &&
    requestedReviewers.length === 0 &&
    !['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes((reviewDecision ?? '').toUpperCase()) &&
    failedChecks.length === 0 &&
    incompleteChecks.length === 0;

  if (
    mergeStateStatus &&
    ['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN'].includes(mergeStateStatus) &&
    !mergeStateBlockedOnlyByAllowedThreads
  ) {
    const evidence: string[] = [];
    if (mergeable) evidence.push(`GitHub mergeable value: ${mergeable}.`);
    if (requestedReviewers.length > 0) evidence.push(`Requested review still pending from: ${requestedReviewers.join(', ')}.`);
    if (reviewDecision) evidence.push(`Review decision: ${reviewDecision}.`);
    if (currentUnresolvedThreads.length > 0) evidence.push(`Unresolved current review threads: ${currentUnresolvedThreads.length}.`);
    if (outdatedUnresolvedThreads.length > 0) evidence.push(`Unresolved outdated review threads: ${outdatedUnresolvedThreads.length}.`);
    if (failedChecks.length > 0) evidence.push(`Failing visible checks: ${failedChecks.map((check) => `${check.name} (${check.state})`).join(', ')}.`);
    if (incompleteChecks.length > 0) evidence.push(`Incomplete visible checks: ${incompleteChecks.map((check) => `${check.name} (${check.state})`).join(', ')}.`);
    if (checks.length > 0 && failedChecks.length === 0 && incompleteChecks.length === 0) {
      evidence.push('All visible status checks returned by GitHub are passing.');
    }
    if (latestReviews.length > 0) evidence.push(`Latest reviews: ${latestReviews.map(reviewLabel).join('; ')}.`);

    const resolution =
      mergeStateStatus === 'BEHIND'
        ? 'Update the PR branch with the latest base branch, push the result, wait for checks, then rerun `warroom pr merge`.'
        : mergeStateStatus === 'DIRTY'
          ? 'Resolve merge conflicts against the base branch, push the result, wait for checks, then rerun `warroom pr merge`.'
          : mergeStateStatus === 'DRAFT'
            ? 'Mark the PR ready for review in GitHub, then rerun `warroom pr merge`.'
            : mergeStateStatus === 'UNKNOWN'
              ? 'Wait for GitHub mergeability to finish computing. If it stays unknown, open the PR merge box in GitHub and inspect branch protection or repository ruleset requirements.'
              : 'Resolve the listed evidence first. If all listed evidence is already resolved, open the PR merge box in GitHub and inspect branch protection or repository ruleset requirements that GitHub does not expose through `gh pr view`, then rerun `warroom pr merge`.';

    addBlocker(
      `Merge state is ${mergeStateStatus}.`,
      mergeStateStatus === 'BLOCKED'
        ? 'GitHub reports that the PR cannot be merged yet because at least one branch protection, ruleset, review, conversation, or required-status condition is not satisfied.'
        : `GitHub reports merge state ${mergeStateStatus}.`,
      resolution,
      evidence
    );
  }
  if (reviewDecision && ['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(reviewDecision)) {
    addBlocker(
      `Review decision is ${reviewDecision}.`,
      reviewDecision === 'CHANGES_REQUESTED'
        ? 'At least one reviewer requested changes on the PR.'
        : 'GitHub says the PR still needs an approving review.',
      reviewDecision === 'CHANGES_REQUESTED'
        ? 'Address the requested changes, reply to the review thread, and request re-review.'
        : `Request approval${requestedReviewers.length ? ` from ${requestedReviewers.join(', ')}` : ''}, then rerun \`warroom pr merge\`.`,
      latestReviews.length ? [`Latest reviews: ${latestReviews.map(reviewLabel).join('; ')}.`] : []
    );
  }

  if (requestedReviewers.length > 0) {
    addBlocker(
      'Requested reviewers are still pending.',
      'The PR still has requested reviewers, so the review loop is not closed.',
      `Get an approval or explicit sign-off from ${requestedReviewers.join(', ')}, or clear the stale review request in GitHub, then rerun \`warroom pr merge\`.`,
      latestReviews.length ? [`Latest reviews: ${latestReviews.map(reviewLabel).join('; ')}.`] : []
    );
  }

  if (currentUnresolvedThreads.length > 0 && !options.allowUnresolvedReviewThreads) {
    addBlocker(
      'Current review threads are unresolved.',
      'At least one non-outdated review conversation is still unresolved.',
      'Resolve each current review thread in GitHub after fixing or explicitly declining the feedback, then rerun `warroom pr merge`.',
      currentUnresolvedThreads.slice(0, 5).map((thread) => {
        const line = thread.line === null ? '' : `:${thread.line}`;
        return `${thread.path}${line} by @${thread.author}${thread.url ? ` ${thread.url}` : ''}.`;
      })
    );
  }

  for (const check of checks) {
    const state = check.state.toUpperCase();
    if (['ACTION_REQUIRED', 'CANCELLED', 'ERROR', 'FAILURE', 'STARTUP_FAILURE', 'TIMED_OUT'].includes(state)) {
      addBlocker(
        `Check failed: ${check.name} (${check.state}).`,
        'GitHub returned a failing status for this check.',
        `Open the check${check.url ? ` at ${check.url}` : ''}, fix the failure, push the fix, and wait for the check to pass.`
      );
    } else if (!['COMPLETED', 'SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(state)) {
      addBlocker(
        `Check is not complete: ${check.name} (${check.state}).`,
        'GitHub has not reported this check as complete yet.',
        `Wait for the check to finish${check.url ? ` or inspect it at ${check.url}` : ''}, then rerun \`warroom pr merge\`.`
      );
    }
  }

  return {
    mergeStateStatus,
    mergeable,
    reviewDecision,
    isDraft: typeof pr.isDraft === 'boolean' ? pr.isDraft : null,
    checks,
    blocked,
    details,
    requestedReviewers,
    unresolvedReviewThreads,
  };
}

function repoHealthById(workspaceRoot: string, id: string) {
  const manifest = loadRepoManifest(workspaceRoot);
  const entry = manifest.repos.find((repo) => repo.id === id);
  return entry ? getRepoHealth(workspaceRoot, entry) : null;
}

function containsPath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function repoHealthForCurrentPath(workspaceRoot: string, currentPath: string) {
  const resolved = path.resolve(currentPath);
  const manifest = loadRepoManifest(workspaceRoot);
  return manifest.repos
    .map((entry) => getRepoHealth(workspaceRoot, entry))
    .filter((repo) => repo.checkedOut && containsPath(repo.resolvedPath, resolved))
    .sort((left, right) => right.resolvedPath.length - left.resolvedPath.length)[0] ?? null;
}

function configuredBranchIssueRef(repoPath: string, branch: string) {
  const configured = gitOutput(repoPath, ['config', `branch.${branch}.warroom-issue`]);
  if (configured?.match(/^[^#]+#\d+$/)) return configured;
  return null;
}

function currentBranchIssueRef(repo: string, branch: string, repoPath?: string) {
  const configured = repoPath ? configuredBranchIssueRef(repoPath, branch) : null;
  if (configured) return configured;

  const match = branch.match(/^warroom\/(\d+)-/);
  return match ? `${repo}#${match[1]}` : null;
}

export function inferIssueRefForCurrentBranch(workspaceRoot: string, currentPath: string) {
  const repo = repoHealthForCurrentPath(workspaceRoot, currentPath);
  if (!repo?.branch) return null;
  return configuredBranchIssueRef(repo.resolvedPath, repo.branch);
}

function gitOutput(repoPath: string, args: string[]) {
  const result = runGit(repoPath, args);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function branchExists(repoPath: string, branch: string) {
  const result = runGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return result.status === 0;
}

function hasOriginRemote(repoPath: string) {
  const result = runGit(repoPath, ['remote', 'get-url', 'origin']);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function defaultPrBase(workspaceRoot: string, repoPath: string, branch: string, optionBase: string | undefined) {
  if (optionBase) return optionBase;
  const configured = gitOutput(repoPath, ['config', `branch.${branch}.gh-merge-base`]);
  return configured ?? loadRepoManifest(workspaceRoot).defaults.default_branch;
}

function commitSummary(repoPath: string, base: string, branch: string) {
  const range = `${base}..${branch}`;
  const result = runGit(repoPath, ['log', '--oneline', '--no-decorate', range]);
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 20) : [];
}

function changedFiles(repoPath: string, base: string, branch: string) {
  const result = runGit(repoPath, ['diff', '--name-only', `${base}...${branch}`]);
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 40) : [];
}

function commitDetails(repoPath: string, base: string, branch: string) {
  const range = `${base}..${branch}`;
  const result = runGit(repoPath, [
    'log',
    '--reverse',
    '--format=commit %H%nsubject: %s%nbody:%n%b%n---',
    range,
  ]);
  return result.status === 0 ? result.stdout : '';
}

function diffStat(repoPath: string, base: string, branch: string) {
  const result = runGit(repoPath, ['diff', '--stat', `${base}...${branch}`]);
  return result.status === 0 ? result.stdout : '';
}

function diffNameStatus(repoPath: string, base: string, branch: string) {
  const result = runGit(repoPath, ['diff', '--name-status', `${base}...${branch}`]);
  return result.status === 0 ? result.stdout : '';
}

function diffPatch(repoPath: string, base: string, branch: string) {
  const result = runGit(repoPath, ['diff', '--find-renames', '--find-copies', '--unified=3', `${base}...${branch}`]);
  return result.status === 0 ? result.stdout : '';
}

function formatPrBody(issueRef: string | null, issueBody: string | undefined, commits: string[], files: string[]) {
  const lines = [
    issueRef ? `Closes ${issueRef}` : null,
    '',
    '## Summary',
    issueBody ? `- Implements the scoped work from ${issueRef}.` : '- Describe the completed branch changes before merging.',
    ...commits.slice(0, 5).map((commit) => `- ${commit.replace(/^[a-f0-9]+\s+/, '')}`),
    '',
    '## Changed files',
    files.length ? files.map((file) => `- \`${file}\``).join('\n') : '- No changed files were detected against the selected base.',
    '',
    '## Validation',
    '- Not run by `warroom pr create`; add the validation commands used for this branch.',
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}

type PrTextPromptOptions = {
  repo: string;
  branch: string;
  base: string;
  issueRef: string | null;
  issueTitle?: string;
  issueBody?: string;
  commits: string[];
  files: string[];
  commitDetails: string;
  diffStat: string;
  diffNameStatus: string;
  diffPatch?: string;
  diffSummaries?: string[];
};

function buildPrTextPrompt(options: PrTextPromptOptions) {
  const diffContext =
    options.diffSummaries && options.diffSummaries.length > 0
      ? [
          `Summarized full diff in ${options.diffSummaries.length} chunk${options.diffSummaries.length === 1 ? '' : 's'}:`,
          options.diffSummaries.map((summary, index) => `### Diff chunk ${index + 1}\n${summary}`).join('\n\n'),
        ]
      : ['Full branch diff:', options.diffPatch || '(no diff detected)'];

  return [
    'Generate GitHub pull request metadata for `warroom pr create`.',
    '',
    'Return only JSON with exactly these string fields:',
    '{"title":"...","body":"..."}',
    '',
    'Rules:',
    '- Base the title and body on the actual branch commits and diff below, not the issue title alone.',
    '- Keep the title under 80 characters and make it useful in a PR list.',
    options.issueRef ? `- The body must include an exact \`Closes ${options.issueRef}\` line.` : '- Do not invent a linked issue.',
    '- Use concise markdown in the body with `## Summary` and `## Validation` sections.',
    '- Do not claim validation was run unless it is evident from the commits or diff.',
    '- Do not include secrets, private env values, or PII from the diff in the PR body.',
    '- Do not wrap the JSON in markdown fences.',
    options.diffSummaries && options.diffSummaries.length > 0
      ? '- The raw diff was too large for one final prompt, so every diff chunk was summarized first. Treat the chunk summaries as full diff coverage.'
      : null,
    '',
    `Repository: ${options.repo}`,
    `Branch: ${options.branch}`,
    `Base: ${options.base}`,
    options.issueRef ? `Linked issue: ${options.issueRef}` : 'Linked issue: none inferred',
    options.issueTitle ? `Issue title: ${options.issueTitle}` : null,
    options.issueBody ? `Issue body:\n${options.issueBody}` : null,
    '',
    'Commit subjects:',
    options.commits.length ? options.commits.join('\n') : '(no commit subjects detected)',
    '',
    'Full branch commit log:',
    options.commitDetails || '(no commit details detected)',
    '',
    'Diff stat:',
    options.diffStat || '(no diff stat detected)',
    '',
    'Diff name-status:',
    options.diffNameStatus || (options.files.length ? options.files.join('\n') : '(no changed files detected)'),
    '',
    ...diffContext,
  ].filter((line): line is string => line !== null).join('\n');
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Adapter output did not contain a JSON object.');
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

function ensureClosingLine(body: string, issueRef: string | null) {
  if (!issueRef) return body.trim();
  if (body.includes(`Closes ${issueRef}`) || body.includes(`Fixes ${issueRef}`) || body.includes(`Resolves ${issueRef}`)) {
    return body.trim();
  }
  return `Closes ${issueRef}\n\n${body.trim()}`;
}

function parsePrTextDraft(raw: string, issueRef: string | null) {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('Adapter output JSON was not an object.');
  const record = parsed as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim().replace(/\s+/g, ' ') : '';
  const body = typeof record.body === 'string' ? ensureClosingLine(record.body, issueRef) : '';
  if (!title) throw new Error('Adapter output did not include a non-empty title.');
  if (!body) throw new Error('Adapter output did not include a non-empty body.');
  return { title, body };
}

function parseDiffChunkSummary(raw: string) {
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
    command: string;
    stage: string;
    repo: string;
    commandRunId: string;
  }
) {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'warroom-adapter-message-'));
  const outputPath = path.join(outputDir, 'last-message.txt');
  try {
    const launch = runAdapter(workspaceRoot, prompt, {
      cwd: repoPath,
      outputLastMessagePath: outputPath,
      captureStdout: true,
      usage: {
        issue: usage.issue,
        command: usage.command,
        stage: usage.stage,
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

function splitTextByLines(value: string, chunkSize: number) {
  const chunks: string[] = [];
  let current = '';
  for (const line of value.split(/\n/)) {
    const next = current ? `${current}\n${line}` : line;
    if (current && next.length > chunkSize) {
      chunks.push(current);
      current = line;
      continue;
    }
    current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLargeFilePatch(value: string, chunkSize: number) {
  const lines = value.split(/\n/);
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  const headerEnd = firstHunk === -1 ? Math.min(lines.length, 6) : firstHunk;
  const header = lines.slice(0, headerEnd).join('\n');
  const body = lines.slice(headerEnd).join('\n');
  const bodyChunkSize = Math.max(10_000, chunkSize - header.length - 80);
  return splitTextByLines(body, bodyChunkSize).map((chunk, index) =>
    [header, index === 0 ? null : '[continued diff for the same file]', chunk]
      .filter((line): line is string => Boolean(line))
      .join('\n')
  );
}

function splitDiffPatch(value: string, chunkSize = PR_TEXT_DIFF_CHUNK_SIZE) {
  if (value.length <= chunkSize) return [value];
  const filePatches = value.split(/\n(?=diff --git )/);
  const chunks: string[] = [];
  let current = '';

  for (const patch of filePatches) {
    if (patch.length > chunkSize) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitLargeFilePatch(patch, chunkSize));
      continue;
    }

    const next = current ? `${current}\n${patch}` : patch;
    if (current && next.length > chunkSize) {
      chunks.push(current);
      current = patch;
      continue;
    }
    current = next;
  }

  if (current) chunks.push(current);
  return chunks;
}

function buildDiffChunkSummaryPrompt(options: PrTextPromptOptions, chunk: string, index: number, total: number) {
  return [
    'Summarize one chunk of a Git diff for later GitHub PR title/body generation.',
    '',
    'Return only JSON with exactly this string field:',
    '{"summary":"..."}',
    '',
    'Rules:',
    '- Summarize concrete behavior, files, tests, migrations, docs, and operational impact visible in this chunk.',
    '- Preserve important names of public APIs, modules, commands, config keys, database columns, and validation evidence.',
    '- Do not include secrets, private env values, PII, or raw customer data.',
    '- Do not claim validation was run unless it is visible in this chunk or commit context.',
    '- Do not wrap the JSON in markdown fences.',
    '',
    `Repository: ${options.repo}`,
    `Branch: ${options.branch}`,
    `Base: ${options.base}`,
    `Diff chunk: ${index + 1} of ${total}`,
    '',
    'Commit subjects:',
    options.commits.length ? options.commits.join('\n') : '(no commit subjects detected)',
    '',
    'Diff stat:',
    options.diffStat || '(no diff stat detected)',
    '',
    'Diff name-status:',
    options.diffNameStatus || (options.files.length ? options.files.join('\n') : '(no changed files detected)'),
    '',
    'Diff chunk content:',
    chunk,
  ].join('\n');
}

function summarizeDiffForPrText(workspaceRoot: string, repoPath: string, options: PrTextPromptOptions, commandRunId: string) {
  const diffPatch = options.diffPatch ?? '';
  if (diffPatch.length <= PR_TEXT_DIRECT_DIFF_LIMIT) {
    return { summaries: null as string[] | null, calls: 0, adapterCommand: null as string | null, error: null as string | null };
  }

  const chunks = splitDiffPatch(diffPatch);
  const summaries: string[] = [];
  let adapterCommand: string | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const result = runAdapterForFinalMessage(
      workspaceRoot,
      repoPath,
      buildDiffChunkSummaryPrompt(options, chunk, index, chunks.length),
      {
        issue: options.issueRef,
        command: 'pr-create',
        stage: `diff-summary-${index + 1}`,
        repo: options.repo,
        commandRunId,
      }
    );
    adapterCommand = result.adapterCommand;
    if (result.error) {
      return {
        summaries: null,
        calls: index + 1,
        adapterCommand,
        error: `LLM adapter failed while summarizing diff chunk ${index + 1}/${chunks.length}: ${result.error}`,
      };
    }
    if (!result.message) {
      return {
        summaries: null,
        calls: index + 1,
        adapterCommand,
        error: `LLM adapter completed diff chunk ${index + 1}/${chunks.length} but did not return a final message.`,
      };
    }

    try {
      summaries.push(parseDiffChunkSummary(result.message));
    } catch (error) {
      return {
        summaries: null,
        calls: index + 1,
        adapterCommand,
        error: `Could not parse diff chunk ${index + 1}/${chunks.length} summary: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { summaries, calls: chunks.length, adapterCommand, error: null };
}

function generatePrText(
  workspaceRoot: string,
  repoPath: string,
  options: PrTextPromptOptions,
  commandRunId: string
): {
  title: string | null;
  body: string | null;
  adapterCommand: string | null;
  error: string | null;
} {
  let adapterCommand: string | null = null;
  try {
    const diffSummary = summarizeDiffForPrText(workspaceRoot, repoPath, options, commandRunId);
    adapterCommand = diffSummary.adapterCommand;
    if (diffSummary.error) {
      return {
        title: null,
        body: null,
        adapterCommand: diffSummary.adapterCommand,
        error: diffSummary.error,
      };
    }

    const promptOptions = diffSummary.summaries
      ? { ...options, diffPatch: undefined, diffSummaries: diffSummary.summaries }
      : options;
    const result = runAdapterForFinalMessage(workspaceRoot, repoPath, buildPrTextPrompt(promptOptions), {
      issue: options.issueRef,
      command: 'pr-create',
      stage: 'pr-text',
      repo: options.repo,
      commandRunId,
    });
    adapterCommand =
      diffSummary.calls > 0
        ? `${result.adapterCommand} (${diffSummary.calls + 1} LLM calls; full diff summarized in ${diffSummary.calls} chunks)`
        : result.adapterCommand;

    if (result.error) {
      return {
        title: null,
        body: null,
        adapterCommand,
        error: `LLM adapter failed while generating PR text: ${result.error}`,
      };
    }
    if (!result.message) {
      return { title: null, body: null, adapterCommand, error: 'LLM adapter completed but did not return a final message.' };
    }

    const draft = parsePrTextDraft(result.message, options.issueRef);
    return {
      title: draft.title,
      body: draft.body,
      adapterCommand,
      error: null,
    };
  } catch (error) {
    return {
      title: null,
      body: null,
      adapterCommand: adapterCommand ?? getAdapterInvocation(workspaceRoot, repoPath).display,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function prCreateMarkdown(result: Omit<PrCreateResult, 'artifact'>) {
  return [
    `# PR Create: ${result.repo}`,
    '',
    `- Branch: ${result.branch}`,
    `- Base: ${result.base}`,
    `- Issue: ${result.issue ?? 'none inferred'}`,
    `- Title: ${result.title}`,
    `- Draft: ${result.draft ? 'yes' : 'no'}`,
    `- PR text: ${result.prText.source}`,
    result.prText.adapterCommand ? `- Adapter: ${result.prText.adapterCommand}` : null,
    result.prText.error ? `- Adapter warning: ${result.prText.error}` : null,
    `- Created: ${result.created ? 'yes' : 'no'}`,
    result.url ? `- URL: ${result.url}` : null,
    result.pushCommand ? `- Push: ${result.pushed ? 'pushed' : 'planned'} ${result.pushCommand}` : '- Push: skipped',
    result.issueComment
      ? `- Issue comment: ${result.issueComment.applied ? `posted ${result.issueComment.url ?? ''}` : result.issueComment.reason ?? result.issueComment.error ?? 'not posted'}`
      : null,
    '',
    '## Blockers',
    result.blocked.length ? result.blocked.map((blocker) => `- ${blocker}`).join('\n') : 'No blockers.',
    '',
    '## Body',
    result.body,
  ].filter((line): line is string => line !== null).join('\n');
}

function buildPrCreateIssueCommentBody(result: Omit<PrCreateResult, 'artifact' | 'issueComment'>) {
  return [
    '## War Room PR opened',
    '',
    `PR: ${result.url ?? 'not created yet'}`,
    `Repo: ${result.repo}`,
    `Branch: ${result.branch} -> ${result.base}`,
    `Title: ${result.title}`,
    `PR text: ${result.prText.source === 'adapter' ? 'generated by LLM adapter' : result.prText.source === 'manual' ? 'supplied by flags' : 'local fallback'}`,
    '',
    'PR description:',
    '',
    result.body,
  ].join('\n');
}

function buildPrCreateIssueCommentResult(
  issue: string | null,
  created: boolean,
  issueCommentEnabled: boolean | undefined,
  body: string | null
): SummaryPostResult | null {
  if (!issue) return null;
  if (issueCommentEnabled === false) {
    return {
      target: 'issue',
      ref: issue,
      applied: false,
      url: null,
      reason: 'Issue progress comments disabled by --no-issue-comment.',
      error: null,
    };
  }
  if (!created || !body) {
    return {
      target: 'issue',
      ref: issue,
      applied: false,
      url: null,
      reason: 'PR not created yet.',
      error: null,
    };
  }

  const ref = parseIssueRef(issue);
  const result = ghComment(['issue', 'comment', String(ref.number), '--repo', ref.repo, '--body', body]);
  return {
    target: 'issue',
    ref: issue,
    applied: result.error === null,
    url: result.url,
    reason: null,
    error: result.error,
  };
}

export function inferPrRefForCurrentBranch(workspaceRoot: string, currentPath: string) {
  const repo = repoHealthForCurrentPath(workspaceRoot, currentPath);
  if (!repo) throw new Error('warroom pr merge requires --pr unless run inside a mapped child repo checkout.');
  if (!repo.branch) throw new Error(`Could not infer current branch for ${repo.github}. Pass --pr owner/repo#number.`);

  const prs = ghJson<Array<{ number?: number; title?: string; url?: string; headRefName?: string }>>(
    [
      'pr',
      'list',
      '--repo',
      repo.github,
      '--state',
      'open',
      '--head',
      repo.branch,
      '--json',
      'number,title,url,headRefName',
      '--limit',
      '10',
    ],
    []
  );

  if (prs.length === 0) {
    throw new Error(`No open PR found for ${repo.github} branch ${repo.branch}. Pass --pr owner/repo#number.`);
  }
  if (prs.length > 1) {
    throw new Error(`Multiple open PRs found for ${repo.github} branch ${repo.branch}. Pass --pr owner/repo#number.`);
  }

  const number = prs[0]?.number;
  if (!number) throw new Error(`Could not read PR number for ${repo.github} branch ${repo.branch}. Pass --pr owner/repo#number.`);
  return `${repo.github}#${number}`;
}

export function runPrCreate(workspaceRoot: string, options: PrOptions): PrCreateResult {
  const commandRunId = createUsageCommandRunId('pr-create');
  const repo = repoHealthForCurrentPath(workspaceRoot, options.currentPath ?? process.cwd());
  if (!repo) throw new Error('warroom pr create must be run inside a mapped child repo checkout.');
  if (!repo.checkedOut) throw new Error(`Mapped checkout is missing: ${repo.resolvedPath}`);

  const branch = options.branch ?? repo.branch;
  if (!branch) throw new Error(`Could not infer current branch for ${repo.github}. Pass --branch <name>.`);

  const base = defaultPrBase(workspaceRoot, repo.resolvedPath, branch, options.base);
  const issueRef = options.issue ?? currentBranchIssueRef(repo.github, branch, repo.resolvedPath);
  const parsedIssue = issueRef ? parseIssueRef(issueRef) : null;
  const issue = issueRef
    ? ghJson<{ title?: string; body?: string; url?: string }>(
        ['issue', 'view', String(parsedIssue!.number), '--repo', parsedIssue!.repo, '--json', 'title,body,url'],
        {}
      )
    : {};
  const commits = commitSummary(repo.resolvedPath, base, branch);
  const files = changedFiles(repo.resolvedPath, base, branch);
  const uncommittedFiles = repo.branch === branch ? gitStatusPaths(repo.resolvedPath) : [];
  const fallbackTitle =
    options.title ??
    issue.title ??
    commits[0]?.replace(/^[a-f0-9]+\s+/, '') ??
    `Publish ${branch}`;
  const fallbackBody = options.body ?? formatPrBody(issueRef, issue.body, commits, files);
  let title = fallbackTitle;
  let body = fallbackBody;
  let prText: PrTextResult =
    options.prText ??
    (options.title && options.body
      ? { source: 'manual', adapterCommand: null, error: null }
      : { source: 'fallback', adapterCommand: null, error: null });
  const draft = options.draft ?? false;
  const blocked: string[] = [];

  if (branch === base) blocked.push(`Refusing to create a PR from base branch ${base}.`);
  if (!branchExists(repo.resolvedPath, branch)) blocked.push(`Local branch does not exist: ${branch}.`);
  if (uncommittedFiles.length > 0) {
    blocked.push(
      `Repo has ${uncommittedFiles.length} uncommitted change${
        uncommittedFiles.length === 1 ? '' : 's'
      }. Run \`warroom commit create\` before creating a PR.`
    );
  }
  if (commits.length === 0) {
    blocked.push(`No commits found on ${branch} ahead of ${base}. Run \`warroom commit create\` before creating a PR.`);
  }

  const existingPrs = ghJson<Array<{ number?: number; url?: string }>>(
    ['pr', 'list', '--repo', repo.github, '--state', 'open', '--head', branch, '--json', 'number,url', '--limit', '10'],
    []
  );
  if (existingPrs.length > 0) {
    blocked.push(`Open PR already exists for ${branch}: ${existingPrs[0]?.url ?? `${repo.github}#${existingPrs[0]?.number}`}.`);
  }

  const shouldPush = options.push !== false;
  const pushArgs = shouldPush
    ? repo.upstream && repo.branch === branch
      ? ['push']
      : ['push', '-u', 'origin', branch]
    : null;
  const pushCommand = pushArgs ? `git ${pushArgs.map(shellQuote).join(' ')}` : null;
  if (shouldPush && !hasOriginRemote(repo.resolvedPath)) {
    blocked.push('Repo has no origin remote for pushing the PR branch.');
  }

  if ((!options.title || !options.body) && blocked.length === 0) {
    const generated = generatePrText(workspaceRoot, repo.resolvedPath, {
      repo: repo.github,
      branch,
      base,
      issueRef,
      issueTitle: issue.title,
      issueBody: issue.body,
      commits,
      files,
      commitDetails: commitDetails(repo.resolvedPath, base, branch),
      diffStat: diffStat(repo.resolvedPath, base, branch),
      diffNameStatus: diffNameStatus(repo.resolvedPath, base, branch),
      diffPatch: diffPatch(repo.resolvedPath, base, branch),
    }, commandRunId);
    prText = {
      source: generated.error ? 'fallback' : 'adapter',
      adapterCommand: generated.adapterCommand,
      error: generated.error,
    };
    if (!options.title && generated.title) title = generated.title;
    if (!options.body && generated.body) body = generated.body;
  }

  const createArgs = [
    'pr',
    'create',
    '--repo',
    repo.github,
    '--base',
    base,
    '--head',
    branch,
    '--title',
    title,
    '--body',
    body,
    ...(draft ? ['--draft'] : []),
  ];
  const createCommand = ['gh', ...createArgs.map(shellQuote)].join(' ');
  let pushed = false;
  let created = false;
  let url: string | null = null;

  if (options.confirm) {
    if (blocked.length > 0) throw new Error(blocked.join(' '));
    if (pushArgs) {
      const push = spawnSync('git', pushArgs, { cwd: repo.resolvedPath, stdio: 'inherit' });
      if (push.status !== 0) throw new Error(`${pushCommand} failed with exit ${push.status ?? 'unknown'}.`);
      pushed = true;
    }

    const createdPr = spawnSync('gh', createArgs, { cwd: repo.resolvedPath, encoding: 'utf8' });
    if (createdPr.status !== 0) {
      throw new Error(createdPr.stderr.trim() || `gh pr create failed with exit ${createdPr.status ?? 'unknown'}.`);
    }
    const createdOutput = createdPr.stdout.trim();
    const createdUrl = createdOutput.match(/https:\/\/github\.com\/\S+/)?.[0] ?? null;
    if (!createdUrl) {
      throw new Error(`gh pr create completed but did not return a PR URL. Output: ${createdOutput || '(empty)'}`);
    }
    created = true;
    url = createdUrl;
  }

  const campaignStatus = issueRef
    ? setCampaignStatus(issueRef, 'skirmish', { confirm: Boolean(options.confirm && options.confirmStatus && created) })
    : null;
  const labelUpdate = issueRef
    ? setIssueWorkflowLabel(issueRef, 'skirmish', Boolean(options.confirm && options.confirmStatus && created))
    : null;
  const baseResult: Omit<PrCreateResult, 'artifact' | 'issueComment'> = {
    action: 'create',
    repo: repo.github,
    path: repo.resolvedPath,
    branch,
    base,
    issue: issueRef,
    title,
    body,
    draft,
    pushed,
    pushCommand,
    createCommand,
    created,
    url,
    blocked,
    campaignStatus,
    labelUpdate,
    prText,
  };
  const issueComment = buildPrCreateIssueCommentResult(
    issueRef,
    created,
    options.issueComment,
    buildPrCreateIssueCommentBody(baseResult)
  );
  const result: Omit<PrCreateResult, 'artifact'> = {
    ...baseResult,
    issueComment,
  };

  if (!options.writeArtifact) return result;

  return {
    ...result,
    artifact: createRunArtifact(workspaceRoot, 'pr-create', {
      'input.json': JSON.stringify(options, null, 2),
      'result.json': JSON.stringify(result, null, 2),
      'summary.md': prCreateMarkdown(result),
      'body.md': body,
      ...(issueComment ? { 'issue-comment.json': JSON.stringify(issueComment, null, 2) } : {}),
      ...(issueComment ? { 'issue-comment.md': buildPrCreateIssueCommentBody(baseResult) } : {}),
      ...(issueRef ? { 'usage.json': JSON.stringify(usageEntriesForCommandRun(workspaceRoot, issueRef, commandRunId), null, 2) } : {}),
    }),
  };
}

function envValue(name: string, fallback: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function baseUrlPort(value: string) {
  try {
    return new URL(value).port || (new URL(value).protocol === 'https:' ? '443' : '80');
  } catch {
    return null;
  }
}

function urlWithPath(baseUrl: string, pathPart: string) {
  try {
    return new URL(pathPart, baseUrl).toString();
  } catch {
    return `${baseUrl.replace(/\/+$/, '')}/${pathPart.replace(/^\/+/, '')}`;
  }
}

function mergeE2EConfig() {
  const billingApiUrl = envValue('WARROOM_MERGE_BACKEND_BASE_URL', DEFAULT_BACKEND_BASE_URL).replace(/\/+$/, '');
  const demoBaseUrl = envValue('WARROOM_MERGE_DEMO_BASE_URL', DEFAULT_DEMO_BASE_URL).replace(/\/+$/, '');
  const readyPath = envValue('WARROOM_MERGE_BACKEND_READY_PATH', DEFAULT_BACKEND_READY_PATH);
  const timeout = Number(envValue('WARROOM_MERGE_BACKEND_READY_TIMEOUT_MS', String(DEFAULT_BACKEND_READY_TIMEOUT_MS)));
  const probeTimeout = Number(
    envValue('WARROOM_MERGE_BACKEND_READY_PROBE_TIMEOUT_MS', String(DEFAULT_BACKEND_READY_PROBE_TIMEOUT_MS))
  );

  return {
    backendCommand: envValue('WARROOM_MERGE_BACKEND_COMMAND', DEFAULT_BACKEND_COMMAND),
    demoCommand: envValue('WARROOM_MERGE_DEMO_E2E_COMMAND', DEFAULT_DEMO_E2E_COMMAND),
    billingApiUrl,
    demoBaseUrl,
    backendReadyUrl: envValue('WARROOM_MERGE_BACKEND_READY_URL', urlWithPath(billingApiUrl, readyPath)),
    backendReadyProbeTimeoutMs:
      Number.isFinite(probeTimeout) && probeTimeout > 0 ? probeTimeout : DEFAULT_BACKEND_READY_PROBE_TIMEOUT_MS,
    backendReadyTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_BACKEND_READY_TIMEOUT_MS,
  };
}

function createMergeE2EPlan(
  workspaceRoot: string,
  requirement: { required: boolean; skipReason: string | null }
): MergeE2EResult {
  const config = mergeE2EConfig();
  if (!requirement.required) {
    return {
      status: 'skipped',
      required: false,
      skipReason: requirement.skipReason,
      backendPath: null,
      backendHeadSha: null,
      demoPath: null,
      demoHeadSha: null,
      backendCommand: config.backendCommand,
      backendReadyUrl: config.backendReadyUrl,
      demoCommand: config.demoCommand,
      demoBaseUrl: config.demoBaseUrl,
      billingApiUrl: config.billingApiUrl,
      durationMs: null,
      testExitStatus: null,
      usedExistingBackend: false,
      startedBackend: false,
      blocked: [],
      error: null,
    };
  }

  const backend = repoHealthById(workspaceRoot, 'backend');
  const demo = repoHealthById(workspaceRoot, 'demo');
  const blocked: string[] = [];

  if (!backend) blocked.push('repos.yaml does not define required repo "backend".');
  else if (!backend.checkedOut) blocked.push(`Backend checkout is missing: ${backend.resolvedPath}`);

  if (!demo) blocked.push('repos.yaml does not define required repo "demo".');
  else if (!demo.checkedOut) blocked.push(`Demo checkout is missing: ${demo.resolvedPath}`);

  return {
    status: 'planned',
    required: true,
    skipReason: null,
    backendPath: backend?.resolvedPath ?? null,
    backendHeadSha: backend?.headSha ?? null,
    demoPath: demo?.resolvedPath ?? null,
    demoHeadSha: demo?.headSha ?? null,
    backendCommand: config.backendCommand,
    backendReadyUrl: config.backendReadyUrl,
    demoCommand: config.demoCommand,
    demoBaseUrl: config.demoBaseUrl,
    billingApiUrl: config.billingApiUrl,
    durationMs: null,
    testExitStatus: null,
    usedExistingBackend: false,
    startedBackend: false,
    blocked,
    error: null,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectStream(stream: NodeJS.ReadableStream | null, limit = 12_000) {
  let buffer = '';
  stream?.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    if (buffer.length > limit) buffer = buffer.slice(-limit);
  });
  return () => buffer.trim();
}

async function waitForProcessExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs),
  ]);
}

async function stopProcessGroup(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }

  await waitForProcessExit(child, 5_000);
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await waitForProcessExit(child, 1_000);
}

type BackendHealthProbeResult = {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
};

function booleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function isLocalHealthHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === 'local.flopay.com' ||
    normalized.endsWith('.local.flopay.com')
  );
}

function shouldAllowInsecureLocalTls(url: URL) {
  return (
    url.protocol === 'https:' &&
    isLocalHealthHostname(url.hostname) &&
    booleanEnv('WARROOM_MERGE_BACKEND_ALLOW_INSECURE_LOCAL_TLS', true) &&
    !booleanEnv('WARROOM_MERGE_BACKEND_STRICT_TLS', false)
  );
}

function shouldUseSystemCaForDemoBackend(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === 'https:' &&
      isLocalHealthHostname(url.hostname) &&
      booleanEnv('WARROOM_MERGE_DEMO_USE_SYSTEM_CA', true) &&
      process.allowedNodeEnvironmentFlags.has(NODE_USE_SYSTEM_CA_FLAG)
    );
  } catch {
    return false;
  }
}

function nodeOptionsWithSystemCa(existing: string | undefined) {
  const values = existing?.trim() ? existing.trim().split(/\s+/) : [];
  return values.includes(NODE_USE_SYSTEM_CA_FLAG) ? values.join(' ') : [...values, NODE_USE_SYSTEM_CA_FLAG].join(' ');
}

function formatProbeFailure(probe: BackendHealthProbeResult | null) {
  if (!probe) return '';
  if (probe.statusCode !== null) return ` Last health probe returned HTTP ${probe.statusCode}.`;
  if (probe.error) return ` Last health probe failed: ${probe.error}.`;
  return '';
}

async function probeBackendHealth(url: string, timeoutMs: number): Promise<BackendHealthProbeResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : String(error) };
  }

  const requestOptions: http.RequestOptions & https.RequestOptions = {
    method: 'GET',
    agent: false,
    headers: {
      accept: 'application/json, text/plain, */*',
      'cache-control': 'no-cache',
      connection: 'close',
    },
  };

  if (shouldAllowInsecureLocalTls(parsedUrl)) {
    requestOptions.rejectUnauthorized = false;
    if (isIP(parsedUrl.hostname) === 0) requestOptions.servername = parsedUrl.hostname;
  }

  const request = parsedUrl.protocol === 'https:' ? https.request : http.request;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BackendHealthProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const requestHandle = request(parsedUrl, requestOptions, (response) => {
      const statusCode = response.statusCode ?? null;
      response.resume();
      response.on('end', () => {
        finish({ ok: statusCode !== null && statusCode >= 200 && statusCode < 300, statusCode, error: null });
      });
    });

    requestHandle.setTimeout(timeoutMs, () => {
      requestHandle.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    requestHandle.on('error', (error) => finish({ ok: false, statusCode: null, error: error.message }));
    requestHandle.end();
  });
}

async function waitForBackendReady(
  url: string,
  timeoutMs: number,
  probeTimeoutMs: number,
  backend: ChildProcess,
  backendOutput: () => string
) {
  const startedAt = Date.now();
  let lastProbe: BackendHealthProbeResult | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (backend.exitCode !== null || backend.signalCode !== null) {
      throw new Error(`Backend exited before becoming ready.${backendOutput() ? `\n${backendOutput()}` : ''}`);
    }

    lastProbe = await probeBackendHealth(url, probeTimeoutMs);
    if (lastProbe.ok) return;

    await delay(1_000);
  }

  throw new Error(
    `Backend did not become ready at ${url} within ${timeoutMs}ms.${formatProbeFailure(lastProbe)}${
      backendOutput() ? `\n${backendOutput()}` : ''
    }`
  );
}

function backendStartupDiagnostic(message: string, backendPath: string, readyUrl: string) {
  const sentryProfilerFailure =
    message.includes('sentry_cpu_profiler') ||
    message.includes('@sentry-internal/node-cpu-profiler') ||
    message.includes('@sentry/profiling-node') ||
    message.includes('ERR_DLOPEN_FAILED');
  if (!sentryProfilerFailure) return message;

  const nodeVersion = message.match(/Node\.js (v[0-9.]+)/)?.[1];
  const lines = [
    message,
    '',
    'War Room diagnostic:',
    '- The backend crashed while loading the Sentry profiling native addon before the API became ready.',
    '- This is a local backend startup/native module problem, not a Playwright failure.',
    nodeVersion ? `- Backend startup used ${nodeVersion}.` : null,
    `- Start the backend manually from ${backendPath} with a compatible Node/native dependency setup, then rerun \`warroom pr merge\`; War Room will reuse the process once ${readyUrl} is healthy.`,
    '- If manual startup fails the same way, fix the backend local runtime first: use the backend-supported Node version, reinstall or rebuild node_modules for that Node version, or guard/disable Sentry profiling for local startup.',
    '- You can override the War Room startup command with WARROOM_MERGE_BACKEND_COMMAND if the backend needs a repo-specific local command.',
  ];

  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

async function isBackendReady(url: string, timeoutMs = DEFAULT_BACKEND_READY_PROBE_TIMEOUT_MS) {
  return (await probeBackendHealth(url, timeoutMs)).ok;
}

function runShellCommand(
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv,
  output?: (chunk: string, stream: 'stdout' | 'stderr') => void
) {
  const startedAt = Date.now();
  const child = spawn(command, {
    cwd,
    env,
    shell: true,
    stdio: output ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  child.stdout?.on('data', (chunk: Buffer | string) => output?.(chunk.toString(), 'stdout'));
  child.stderr?.on('data', (chunk: Buffer | string) => output?.(chunk.toString(), 'stderr'));

  return new Promise<{ status: number | null; durationMs: number }>((resolve) => {
    child.on('exit', (status) => resolve({ status, durationMs: Date.now() - startedAt }));
  });
}

async function runDemoE2E(
  demoPath: string,
  config: ReturnType<typeof mergeE2EConfig>,
  output: Pick<PrOptions, 'e2eOutput' | 'e2eStatus'>
) {
  output.e2eStatus?.(`Demo Playwright e2e: running \`${config.demoCommand}\` from ${demoPath}`);
  const useSystemCa = shouldUseSystemCaForDemoBackend(config.billingApiUrl);
  if (useSystemCa) {
    output.e2eStatus?.(`Demo Playwright e2e: enabling Node system CA trust for ${config.billingApiUrl}`);
  }
  const result = await runShellCommand(
    demoPath,
    config.demoCommand,
    {
      ...process.env,
      ...(useSystemCa ? { NODE_OPTIONS: nodeOptionsWithSystemCa(process.env.NODE_OPTIONS) } : {}),
      BILLING_API_URL: config.billingApiUrl,
      NEXT_PUBLIC_BILLING_API_URL: config.billingApiUrl,
      NEXT_PUBLIC_CHECKOUT_BASE_URL: config.demoBaseUrl,
      PLAYWRIGHT_LOCAL_BASE_URL: config.demoBaseUrl,
    },
    output.e2eOutput
  );
  output.e2eStatus?.(
    `Demo Playwright e2e: finished with exit ${result.status ?? 'unknown'} after ${result.durationMs}ms`
  );
  return result;
}

async function runMergeE2E(
  workspaceRoot: string,
  requirement: { required: boolean; skipReason: string | null },
  output: Pick<PrOptions, 'e2eOutput' | 'e2eStatus'> = {}
): Promise<MergeE2EResult> {
  const plan = createMergeE2EPlan(workspaceRoot, requirement);
  if (!plan.required) return plan;
  if (plan.blocked.length > 0) return { ...plan, status: 'failed', error: plan.blocked.join(' ') };

  const config = mergeE2EConfig();
  const backendPort = baseUrlPort(config.billingApiUrl);
  const backend = repoHealthById(workspaceRoot, 'backend');
  const demo = repoHealthById(workspaceRoot, 'demo');
  if (!backend?.checkedOut || !demo?.checkedOut) {
    return { ...plan, status: 'failed', error: 'Backend or demo checkout became unavailable before e2e validation.' };
  }

  const startedAt = Date.now();
  output.e2eStatus?.(`Demo Playwright e2e: checking backend readiness at ${config.backendReadyUrl}`);
  const existingBackendReady = await isBackendReady(config.backendReadyUrl, config.backendReadyProbeTimeoutMs);
  if (existingBackendReady) {
    output.e2eStatus?.(`Demo Playwright e2e: reusing existing backend at ${config.backendReadyUrl}`);
    const test = await runDemoE2E(demo.resolvedPath, config, output);
    return {
      ...plan,
      status: test.status === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - startedAt,
      testExitStatus: test.status,
      usedExistingBackend: true,
      startedBackend: false,
      error: test.status === 0 ? null : `${config.demoCommand} failed with exit ${test.status ?? 'unknown'}.`,
    };
  }

  const backendProcess = spawn(config.backendCommand, {
    cwd: backend.resolvedPath,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      APP_PORT: backendPort ?? process.env.APP_PORT ?? '3001',
      PORT: backendPort ?? process.env.PORT ?? '3001',
      APP_BASE_URL: config.billingApiUrl,
    },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  output.e2eStatus?.(`Demo Playwright e2e: starting backend with \`${config.backendCommand}\` from ${backend.resolvedPath}`);
  const backendOutput = collectStream(backendProcess.stdout);
  const backendError = collectStream(backendProcess.stderr);
  const backendLogs = () => [backendOutput(), backendError()].filter(Boolean).join('\n');

  try {
    await waitForBackendReady(
      config.backendReadyUrl,
      config.backendReadyTimeoutMs,
      config.backendReadyProbeTimeoutMs,
      backendProcess,
      backendLogs
    );
    output.e2eStatus?.(`Demo Playwright e2e: backend ready at ${config.backendReadyUrl}`);
    const test = await runDemoE2E(demo.resolvedPath, config, output);

    return {
      ...plan,
      status: test.status === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - startedAt,
      testExitStatus: test.status,
      usedExistingBackend: false,
      startedBackend: true,
      error: test.status === 0 ? null : `${config.demoCommand} failed with exit ${test.status ?? 'unknown'}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...plan,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      usedExistingBackend: false,
      startedBackend: true,
      error: backendStartupDiagnostic(message, backend.resolvedPath, config.backendReadyUrl),
    };
  } finally {
    output.e2eStatus?.('Demo Playwright e2e: stopping backend process started by War Room');
    await stopProcessGroup(backendProcess);
  }
}

function changelogActionsConfig() {
  const timeout = Number(envValue('WARROOM_MERGE_CHANGELOG_ACTIONS_TIMEOUT_MS', String(DEFAULT_CHANGELOG_ACTIONS_TIMEOUT_MS)));
  const poll = Number(envValue('WARROOM_MERGE_CHANGELOG_ACTIONS_POLL_MS', String(DEFAULT_CHANGELOG_ACTIONS_POLL_MS)));
  const settle = Number(envValue('WARROOM_MERGE_CHANGELOG_ACTIONS_SETTLE_MS', String(DEFAULT_CHANGELOG_ACTIONS_SETTLE_MS)));

  return {
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CHANGELOG_ACTIONS_TIMEOUT_MS,
    pollMs: Number.isFinite(poll) && poll >= 0 ? poll : DEFAULT_CHANGELOG_ACTIONS_POLL_MS,
    settleMs: Number.isFinite(settle) && settle >= 0 ? settle : DEFAULT_CHANGELOG_ACTIONS_SETTLE_MS,
  };
}

function createMergeChangelogPlan(
  workspaceRoot: string,
  githubRepo: string,
  base: string,
  requirement: { required: boolean; skipReason: string | null }
): MergeChangelogResult {
  const repoEntry = repoEntryForGitHub(workspaceRoot, githubRepo);
  const repo = repoEntry ? getRepoHealth(workspaceRoot, repoEntry) : null;
  const changelogPath = repo?.checkedOut ? path.join(repo.resolvedPath, 'CHANGELOG.md') : null;
  const blocked: string[] = [];

  if (!requirement.required) {
    return {
      status: 'skipped',
      required: false,
      skipReason: requirement.skipReason,
      repo: githubRepo,
      path: repo?.resolvedPath ?? null,
      base,
      currentBranch: repo?.branch ?? null,
      changelogPath: null,
      version: null,
      actionsHeadSha: null,
      actionsRuns: [],
      durationMs: null,
      committed: false,
      pushed: false,
      commitSha: null,
      blocked,
      error: null,
    };
  }

  if (!repoEntry) blocked.push(`repos.yaml does not define a mapped checkout for ${githubRepo}.`);
  if (repo && !repo.checkedOut) blocked.push(`Mapped checkout is missing: ${repo.resolvedPath}`);
  if (repo?.clean === false) blocked.push(`Mapped checkout has local changes: ${repo.resolvedPath}`);
  if (changelogPath && !existsSync(changelogPath)) blocked.push(`CHANGELOG.md is missing: ${changelogPath}`);

  return {
    status: 'planned',
    required: true,
    skipReason: null,
    repo: githubRepo,
    path: repo?.resolvedPath ?? null,
    base,
    currentBranch: repo?.branch ?? null,
    changelogPath,
    version: null,
    actionsHeadSha: null,
    actionsRuns: [],
    durationMs: null,
    committed: false,
    pushed: false,
    commitSha: null,
    blocked,
    error: null,
  };
}

type WorkflowRun = {
  databaseId?: number;
  name?: string;
  displayTitle?: string;
  status?: string;
  conclusion?: string | null;
  headSha?: string;
  url?: string;
};

function normalizeWorkflowRun(run: WorkflowRun): MergeChangelogResult['actionsRuns'][number] {
  return {
    databaseId: typeof run.databaseId === 'number' ? run.databaseId : null,
    name: run.name ?? run.displayTitle ?? 'unknown workflow',
    status: run.status ?? 'unknown',
    conclusion: run.conclusion ?? null,
    headSha: run.headSha ?? null,
    url: run.url ?? null,
  };
}

function successfulRunConclusion(run: WorkflowRun) {
  const conclusion = (run.conclusion ?? '').toUpperCase();
  return ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(conclusion);
}

function completedRun(run: WorkflowRun) {
  return (run.status ?? '').toUpperCase() === 'COMPLETED';
}

function branchHeadSha(repo: string, branch: string) {
  return ghTextStrict(['api', `repos/${repo}/commits/${encodeURIComponent(branch)}`, '--jq', '.sha']);
}

function listWorkflowRuns(repo: string, branch: string, headSha: string) {
  const runs = ghJsonStrict<WorkflowRun[]>([
    'run',
    'list',
    '--repo',
    repo,
    '--branch',
    branch,
    '--limit',
    '20',
    '--json',
    'databaseId,name,displayTitle,status,conclusion,headSha,url',
  ]);
  return runs.filter((run) => run.headSha === headSha);
}

async function waitForActionsForCurrentHead(
  repo: string,
  branch: string,
  config: ReturnType<typeof changelogActionsConfig>,
  startedAt: number,
  output?: (message: string) => void
) {
  let lastHeadSha: string | null = null;
  while (Date.now() - startedAt < config.timeoutMs) {
    const headSha = branchHeadSha(repo, branch);
    if (headSha !== lastHeadSha) {
      output?.(`Changelog: waiting for GitHub Actions on ${repo}@${branch} (${headSha.slice(0, 12)})`);
      lastHeadSha = headSha;
    }

    const runs = listWorkflowRuns(repo, branch, headSha);
    if (runs.length > 0) {
      const failed = runs.filter((run) => completedRun(run) && !successfulRunConclusion(run));
      if (failed.length > 0) {
        throw new Error(`GitHub Actions failed for ${repo}@${branch}: ${failed.map((run) => `${run.name ?? run.displayTitle ?? 'workflow'} (${run.conclusion ?? 'unknown'})`).join(', ')}.`);
      }

      if (runs.every(completedRun)) {
        output?.(`Changelog: GitHub Actions passed for ${repo}@${branch} (${headSha.slice(0, 12)})`);
        return { headSha, runs: runs.map(normalizeWorkflowRun) };
      }
    }

    await delay(config.pollMs);
  }

  throw new Error(`Timed out waiting for GitHub Actions to complete successfully on ${repo}@${branch}.`);
}

async function waitForSettledBranchActions(
  repo: string,
  branch: string,
  output?: (message: string) => void
) {
  const config = changelogActionsConfig();
  const startedAt = Date.now();
  let latest = await waitForActionsForCurrentHead(repo, branch, config, startedAt, output);

  while (Date.now() - startedAt < config.timeoutMs) {
    if (config.settleMs > 0) await delay(config.settleMs);
    const nextHeadSha = branchHeadSha(repo, branch);
    if (nextHeadSha === latest.headSha) return { ...latest, durationMs: Date.now() - startedAt };
    output?.(`Changelog: ${repo}@${branch} advanced to ${nextHeadSha.slice(0, 12)}; waiting for the new actions run`);
    latest = await waitForActionsForCurrentHead(repo, branch, config, startedAt, output);
  }

  throw new Error(`Timed out waiting for ${repo}@${branch} actions to settle after branch updates.`);
}

function prepareChangelogCheckout(repoPath: string, base: string) {
  const fetch = runGit(repoPath, ['fetch', 'origin', base]);
  if (fetch.status !== 0) throw new Error(fetch.stderr || `git fetch origin ${base} failed with exit ${fetch.status ?? 'unknown'}.`);

  const switched = runGit(repoPath, ['switch', base]);
  if (switched.status !== 0) {
    const tracked = runGit(repoPath, ['switch', '-c', base, '--track', `origin/${base}`]);
    if (tracked.status !== 0) throw new Error(tracked.stderr || switched.stderr || `git switch ${base} failed.`);
  }

  const pull = runGit(repoPath, ['pull', '--ff-only', 'origin', base]);
  if (pull.status !== 0) throw new Error(pull.stderr || `git pull --ff-only origin ${base} failed with exit ${pull.status ?? 'unknown'}.`);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readPackageVersions(repoPath: string) {
  const versions: Array<{ file: string; name: string; version: string }> = [];
  const addPackage = (filePath: string) => {
    const packageJson = readJsonFile<{ name?: unknown; version?: unknown }>(filePath);
    if (typeof packageJson?.version !== 'string') return;
    versions.push({
      file: path.relative(repoPath, filePath),
      name: typeof packageJson.name === 'string' ? packageJson.name : path.basename(path.dirname(filePath)),
      version: packageJson.version,
    });
  };

  addPackage(path.join(repoPath, 'package.json'));
  const packagesPath = path.join(repoPath, 'packages');
  if (existsSync(packagesPath)) {
    for (const entry of readdirSync(packagesPath, { withFileTypes: true })) {
      if (entry.isDirectory()) addPackage(path.join(packagesPath, entry.name, 'package.json'));
    }
  }

  return versions;
}

function buildChangelogPrompt(options: {
  prRef: string;
  issueRef: string | undefined;
  pr: {
    title?: string;
    url?: string;
    body?: string;
    files?: Array<{ path?: string; additions?: number; deletions?: number }>;
  };
  versions: Array<{ file: string; name: string; version: string }>;
  changelog: string;
}) {
  const versions = options.versions.length
    ? options.versions.map((version) => `- ${version.name}@${version.version} (${version.file})`).join('\n')
    : '- No package versions were detected.';
  const files = options.pr.files?.length
    ? options.pr.files.map((file) => `- ${file.path ?? 'unknown'} (+${file.additions ?? 0}/-${file.deletions ?? 0})`).join('\n')
    : '- No PR files were returned by GitHub.';

  return [
    `Update CHANGELOG.md for ${options.prRef}.`,
    '',
    'Rules:',
    '- Edit CHANGELOG.md only.',
    '- Add one new top entry for the latest released version detected below.',
    '- Match the existing changelog style and keep the entry concise.',
    '- Mention the PR and linked issue when useful, but do not include operational War Room details.',
    '- Do not commit or push; War Room will do that after verifying the file change.',
    '',
    `PR title: ${options.pr.title ?? 'unknown'}`,
    `PR URL: ${options.pr.url ?? 'unknown'}`,
    options.issueRef ? `Linked issue: ${options.issueRef}` : 'Linked issue: none supplied',
    '',
    'Detected package versions after release actions:',
    versions,
    '',
    'Changed files:',
    files,
    '',
    'PR body:',
    truncateText(options.pr.body, 4000),
    '',
    'Current CHANGELOG.md:',
    truncateText(options.changelog, 8000),
  ].join('\n');
}

function gitStatusPaths(repoPath: string) {
  const status = spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: repoPath, encoding: 'utf8' });
  if (status.status !== 0) {
    throw new Error(status.stderr.trim() || `git status failed with exit ${status.status ?? 'unknown'}.`);
  }
  return status.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''));
}

function gitHeadSha(repoPath: string) {
  const head = runGit(repoPath, ['rev-parse', 'HEAD']);
  if (head.status !== 0) throw new Error(head.stderr || 'Could not read local git HEAD.');
  return head.stdout;
}

function gitHeadShaOrNull(repoPath: string) {
  const head = runGit(repoPath, ['rev-parse', 'HEAD']);
  return head.status === 0 && head.stdout ? head.stdout : null;
}

function gitCurrentBranch(repoPath: string) {
  const branch = runGit(repoPath, ['branch', '--show-current']);
  if (branch.status !== 0) throw new Error(branch.stderr || 'Could not read local git branch.');
  return branch.stdout || null;
}

function publishAdapterReviewChanges(
  repoPath: string,
  branchName: string | null,
  previousHeadSha: string,
  previousLocalHeadSha: string | null,
  reviewStatus: ((message: string) => void) | undefined
) {
  if (!previousLocalHeadSha) return { changed: false, error: null };
  const branch = branchName || gitCurrentBranch(repoPath);
  if (!branch) return { changed: false, error: 'Could not determine PR branch name for review changes.' };

  const dirtyFiles = gitStatusPaths(repoPath);
  let committedDirtyFiles = false;
  if (dirtyFiles.length > 0) {
    reviewStatus?.(
      `PR review loop: adapter left ${dirtyFiles.length} changed file${
        dirtyFiles.length === 1 ? '' : 's'
      }; committing them before waiting for CodeRabbit.`
    );
    const add = runGit(repoPath, ['add', '-A']);
    if (add.status !== 0) {
      return { changed: false, error: add.stderr || `git add -A failed with exit ${add.status ?? 'unknown'}.` };
    }

    const commit = runGit(repoPath, ['commit', '-m', 'fix: address CodeRabbit review feedback']);
    if (commit.status !== 0) {
      return { changed: false, error: commit.stderr || `git commit failed with exit ${commit.status ?? 'unknown'}.` };
    }
    committedDirtyFiles = true;
  }

  const headSha = gitHeadSha(repoPath);
  if (!committedDirtyFiles && headSha === previousLocalHeadSha) return { changed: false, error: null };
  if (headSha === previousHeadSha) return { changed: false, error: null };

  reviewStatus?.(`PR review loop: pushing review commit ${shortSha(headSha)} to ${branch}.`);
  const push = runGit(repoPath, ['push', 'origin', `HEAD:${branch}`]);
  if (push.status !== 0) {
    return { changed: false, error: push.stderr || `git push origin HEAD:${branch} failed with exit ${push.status ?? 'unknown'}.` };
  }
  return { changed: true, error: null };
}

async function runMergeChangelog(
  workspaceRoot: string,
  plan: MergeChangelogResult,
  options: PrOptions,
  pr: {
    title?: string;
    url?: string;
    body?: string;
    files?: Array<{ path?: string; additions?: number; deletions?: number }>;
  },
  usage: { commandRunId: string }
): Promise<MergeChangelogResult> {
  if (!plan.required) return plan;
  if (plan.blocked.length > 0) return { ...plan, status: 'failed', error: plan.blocked.join(' ') };
  if (!plan.path || !plan.changelogPath) return { ...plan, status: 'failed', error: 'Changelog checkout plan is incomplete.' };

  const startedAt = Date.now();
  let actionsHeadSha: string | null = null;
  let actionsRuns: MergeChangelogResult['actionsRuns'] = [];
  try {
    const actions = await waitForSettledBranchActions(plan.repo, plan.base, options.mergeStatus);
    actionsHeadSha = actions.headSha;
    actionsRuns = actions.runs;
    options.mergeStatus?.(`Changelog: pulling latest ${plan.base} in ${plan.path}`);
    prepareChangelogCheckout(plan.path, plan.base);

    const versions = readPackageVersions(plan.path);
    const version = versions[0]?.version ?? null;
    const prompt = buildChangelogPrompt({
      prRef: options.pr ?? plan.repo,
      issueRef: options.issue,
      pr,
      versions,
      changelog: readFileSync(plan.changelogPath, 'utf8'),
    });
    options.mergeStatus?.('Changelog: asking the LLM to update CHANGELOG.md');
    const adapter = runAdapter(workspaceRoot, prompt, {
      cwd: plan.path,
      usage: {
        issue: options.issue ?? null,
        command: 'pr-merge',
        stage: 'changelog',
        repo: plan.repo,
        commandRunId: usage.commandRunId,
      },
    });
    if (!adapter.launched) throw new Error(adapter.error ?? 'LLM adapter failed to update CHANGELOG.md.');

    const changed = gitStatusPaths(plan.path);
    if (!changed.includes('CHANGELOG.md')) {
      throw new Error('LLM adapter completed but did not modify CHANGELOG.md.');
    }
    const unexpected = changed.filter((file) => file !== 'CHANGELOG.md');
    if (unexpected.length > 0) {
      throw new Error(`LLM adapter modified files outside CHANGELOG.md: ${unexpected.join(', ')}.`);
    }

    const add = runGit(plan.path, ['add', 'CHANGELOG.md']);
    if (add.status !== 0) throw new Error(add.stderr || `git add CHANGELOG.md failed with exit ${add.status ?? 'unknown'}.`);

    const message = version
      ? `docs(changelog): update for ${version} [skip-ci]`
      : 'docs(changelog): update changelog [skip-ci]';
    const commit = runGit(plan.path, ['commit', '-m', message]);
    if (commit.status !== 0) throw new Error(commit.stderr || `git commit failed with exit ${commit.status ?? 'unknown'}.`);

    const commitSha = runGit(plan.path, ['rev-parse', '--short', 'HEAD']);
    if (commitSha.status !== 0) throw new Error(commitSha.stderr || 'Could not read changelog commit sha.');

    const push = runGit(plan.path, ['push', 'origin', plan.base]);
    if (push.status !== 0) throw new Error(push.stderr || `git push origin ${plan.base} failed with exit ${push.status ?? 'unknown'}.`);

    options.mergeStatus?.(`Changelog: pushed ${commitSha.stdout} to ${plan.repo}@${plan.base} with [skip-ci]`);
    return {
      ...plan,
      status: 'passed',
      version,
      actionsHeadSha,
      actionsRuns,
      durationMs: Date.now() - startedAt,
      committed: true,
      pushed: true,
      commitSha: commitSha.stdout,
      currentBranch: plan.base,
      error: null,
    };
  } catch (error) {
    return {
      ...plan,
      status: 'failed',
      actionsHeadSha,
      actionsRuns,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildVictorySummary(
  prRef: string,
  issueRef: string | undefined,
  pr: { title?: string; url?: string; headRefName?: string; baseRefName?: string },
  readiness: MergeReadiness,
  operatorSummary: string | undefined
) {
  const defaultOutcome =
    readiness.blocked.length === 0
      ? 'Ready for final merge and cleanup through `warroom pr merge`.'
      : 'Preflight is blocked. Resolve merge-readiness blockers before marking victory.';
  const lines = [
    '## Victory summary',
    '',
    `PR: ${prRef}`,
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? 'unknown'}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
  ];

  if (issueRef) lines.push(`Linked issue: ${issueRef}`);

  lines.push(
    '',
    'Outcome:',
    operatorSummary ?? defaultOutcome,
    '',
    'Merge readiness:',
    readiness.blocked.length === 0 ? 'No blockers detected by War Room preflight.' : readiness.blocked.map((blocker) => `- ${blocker}`).join('\n'),
    '',
    'Merge blocker details:',
    readiness.details.length === 0
      ? 'none'
      : readiness.details
          .map((detail) => [
            `- ${detail.blocker}`,
            `  Why: ${detail.explanation}`,
            detail.evidence.length ? `  Evidence: ${detail.evidence.join(' ')}` : null,
            `  Resolve: ${detail.resolution}`,
          ].filter(Boolean).join('\n'))
          .join('\n'),
    '',
    'Checks:',
    readiness.checks.length === 0
      ? 'No status checks were returned by GitHub.'
      : readiness.checks.map((check) => `- ${check.name}: ${check.state}${check.url ? ` (${check.url})` : ''}`).join('\n')
  );

  return lines.join('\n');
}

function buildSummaryPostPlan(options: PrOptions, summary: string, readiness: MergeReadiness): SummaryPostResult[] {
  if (!options.pr || !options.postSummary) return [];

  const targets: Array<{ target: 'pr' | 'issue'; ref: string }> = [{ target: 'pr', ref: options.pr }];
  if (options.issue) targets.push({ target: 'issue', ref: options.issue });

  if (!options.confirmSummary) {
    return targets.map((target) => ({
      ...target,
      applied: false,
      url: null,
      reason: 'Pass --confirm-summary to post victory summary comments.',
      error: null,
    }));
  }

  if (readiness.blocked.length > 0) {
    return targets.map((target) => ({
      ...target,
      applied: false,
      url: null,
      reason: 'Merge readiness blockers are present.',
      error: null,
    }));
  }

  return targets.map((target) => {
    if (target.target === 'pr') {
      const ref = parsePrRef(target.ref);
      const result = ghComment(['pr', 'comment', String(ref.number), '--repo', ref.repo, '--body', summary]);
      return {
        ...target,
        applied: result.error === null,
        url: result.url,
        reason: null,
        error: result.error,
      };
    }

    const ref = parseIssueRef(target.ref);
    const result = ghComment(['issue', 'comment', String(ref.number), '--repo', ref.repo, '--body', summary]);
    return {
      ...target,
      applied: result.error === null,
      url: result.url,
      reason: null,
      error: result.error,
    };
  });
}

function buildFinalVictoryComment(
  prRef: string,
  pr: { title?: string; url?: string; headRefName?: string; baseRefName?: string },
  mergeE2E: MergeE2EResult,
  mergeChangelog: MergeChangelogResult
) {
  return [
    '## War Room victory update',
    '',
    `PR merged: ${pr.url ?? `https://github.com/${prRef.replace('#', '/pull/')}`}`,
    `Title: ${pr.title ?? 'unknown'}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
    '',
    'Outcome: the implementation PR has merged and this issue is ready for victory closeout.',
    '',
    'Final checks:',
    `- Merge gate: passed`,
    `- Demo e2e: ${mergeE2E.status}${mergeE2E.skipReason ? ` (${mergeE2E.skipReason})` : ''}`,
    `- Changelog: ${mergeChangelog.status}${mergeChangelog.skipReason ? ` (${mergeChangelog.skipReason})` : ''}`,
  ].join('\n');
}

function buildFinalIssueCommentPlan(
  issueRef: string | null,
  prRef: string,
  pr: { title?: string; url?: string; headRefName?: string; baseRefName?: string },
  merged: boolean,
  readiness: MergeReadiness,
  mergeE2E: MergeE2EResult,
  mergeChangelog: MergeChangelogResult,
  issueCommentEnabled: boolean | undefined
): SummaryPostResult | null {
  if (!issueRef) return null;
  if (issueCommentEnabled === false) {
    return {
      target: 'issue',
      ref: issueRef,
      applied: false,
      url: null,
      reason: 'Issue progress comments disabled by --no-issue-comment.',
      error: null,
    };
  }
  if (!merged) return null;
  if (readiness.blocked.length > 0) {
    return {
      target: 'issue',
      ref: issueRef,
      applied: false,
      url: null,
      reason: 'Merge readiness blockers are present.',
      error: null,
    };
  }

  const ref = parseIssueRef(issueRef);
  const result = ghComment([
    'issue',
    'comment',
    String(ref.number),
    '--repo',
    ref.repo,
    '--body',
    buildFinalVictoryComment(prRef, pr, mergeE2E, mergeChangelog),
  ]);
  return {
    target: 'issue',
    ref: issueRef,
    applied: result.error === null,
    url: result.url,
    reason: null,
    error: result.error,
  };
}

function planLocalCleanup(
  workspaceRoot: string,
  prRepo: string,
  headRefName: string | undefined,
  baseRefName: string | undefined,
  options: PrOptions
): LocalCleanupResult | null {
  if (!options.cleanupLocal) return null;

  const manifest = loadRepoManifest(workspaceRoot);
  const repoEntry = manifest.repos.find((entry) => entry.github === prRepo);
  const targetBranch = baseRefName ?? manifest.defaults.default_branch;

  if (!repoEntry) {
    return {
      repo: prRepo,
      path: null,
      currentBranch: null,
      targetBranch,
      clean: null,
      applied: false,
      blocked: [`No mapped child repo found for ${prRepo}.`],
      messages: [],
    };
  }

  const repo = getRepoHealth(workspaceRoot, repoEntry);
  const blocked: string[] = [];
  const messages: string[] = [];

  if (!repo.checkedOut) blocked.push(`Repo checkout is missing: ${repo.resolvedPath}`);
  if (repo.clean === false) blocked.push(`Repo checkout is dirty: ${repo.resolvedPath}`);
  if (!repo.branch) blocked.push('Repo current branch is unknown.');
  if (repo.branch && headRefName && repo.branch !== headRefName && repo.branch !== targetBranch) {
    blocked.push(`Repo is on ${repo.branch}, not PR branch ${headRefName} or target branch ${targetBranch}.`);
  }
  if (repo.branch === targetBranch) messages.push(`Already on ${targetBranch}.`);

  let applied = false;
  if (options.confirmCleanup && blocked.length === 0) {
    let onTargetBranch = repo.branch === targetBranch;
    if (!onTargetBranch) {
      const switched = runGit(repo.resolvedPath, ['switch', targetBranch]);
      if (switched.status !== 0) {
        blocked.push(switched.stderr || `git switch ${targetBranch} failed with exit ${switched.status ?? 'unknown'}.`);
      } else {
        onTargetBranch = true;
        messages.push(`Switched local checkout to ${targetBranch}.`);
      }
    }

    if (onTargetBranch && blocked.length === 0) {
      const pulled = runGit(repo.resolvedPath, ['pull', '--ff-only']);
      if (pulled.status !== 0) {
        blocked.push(pulled.stderr || `git pull --ff-only failed with exit ${pulled.status ?? 'unknown'}.`);
      } else {
        applied = true;
        messages.push(`Pulled latest ${targetBranch} with git pull --ff-only.`);
      }
    }
  } else if (!options.confirmCleanup && repo.branch !== targetBranch) {
    messages.push('Pass --confirm-cleanup to switch the local checkout when the preflight is clear.');
  }

  return {
    repo: repo.github,
    path: repo.resolvedPath,
    currentBranch: repo.branch,
    targetBranch,
    clean: repo.clean,
    applied,
    blocked,
    messages,
  };
}

function inferImplementationRepo(
  workspaceRoot: string,
  issueRepo: string,
  issue: { body?: string; comments?: Array<{ body?: string }> }
) {
  const candidates = [
    ...(issue.comments ?? []).slice().reverse().map((comment) => ownerRepoFromText(comment.body)),
    ownerRepoFromText(issue.body),
  ].filter((repo): repo is string => Boolean(repo));

  const mapped = candidates.find((repo) => repoEntryForGitHub(workspaceRoot, repo));
  return mapped ?? candidates[0] ?? issueRepo;
}

export function runIssueStart(workspaceRoot: string, options: PrOptions): PrPlanResult {
  const commandRunId = createUsageCommandRunId('issue-next');
  if (!options.issue) throw new Error('warroom issue next requires --issue owner/repo#number for direct starts.');
  const ref = parseIssueRef(options.issue);
  const issue = ghJson<{
    title?: string;
    body?: string;
    url?: string;
    comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
  }>(
    ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'title,body,url,comments'],
    {}
  );
  const title = issue.title ?? options.issueTitle ?? 'unknown';
  const base = options.base ?? 'main';
  const implementationRepo = inferImplementationRepo(workspaceRoot, ref.repo, issue);
  const crossRepoImplementation = implementationRepo !== ref.repo;
  const featureBranch = featureBranchForIssue(ref, title);
  const adapterCwd = repoWorkspaceForGitHub(workspaceRoot, implementationRepo);
  const adapterInvocation = getAdapterInvocation(workspaceRoot, adapterCwd);
  const developmentBranch = createDevelopmentBranchResult(
    workspaceRoot,
    ref,
    title,
    base,
    options.dryRun === false,
    true,
    implementationRepo
  );
  const issueCommentRows = (issue.comments ?? []).map((comment, index) => {
    const author = comment.author?.login ?? 'unknown';
    return `## Comment ${index + 1} by @${author} at ${comment.createdAt ?? 'unknown'}\n${fullText(comment.body)}`;
  });
  const issueComments = issueCommentRows.length === 0 ? '(none)' : issueCommentRows.join('\n\n');
  const prompt = [
    `War Room implementation handoff for ${options.issue}`,
    '',
    `Title: ${title}`,
    `URL: ${issue.url ?? options.issueUrl ?? `https://github.com/${ref.repo}/issues/${ref.number}`}`,
    crossRepoImplementation ? `Source issue: ${options.issue}` : null,
    `Implementation repo: ${implementationRepo}`,
    `Base branch: ${base} (use stage only as the second target option after validation)`,
    `Feature branch: ${featureBranch}`,
    crossRepoImplementation
      ? `Development branch link: ${developmentBranch.applied ? 'created' : 'planned'} in ${implementationRepo} with \`${developmentBranch.command}\``
      : `Development branch link: ${developmentBranch.applied ? 'created' : 'planned'} with \`${developmentBranch.command}\``,
    '',
    buildSpecialistContext(workspaceRoot, implementationRepo),
    crossRepoImplementation
      ? [
          '',
          `Source issue context for ${options.issue}:`,
          buildSpecialistContext(workspaceRoot, ref.repo),
          '- Keep the client-facing issue in the ally repo; implement code only in the implementation repo above.',
        ].join('\n')
      : null,
    '',
    'Mission:',
    '- Implement the issue now. Do not stop after writing a plan, preflight, analysis note, or handoff markdown.',
    crossRepoImplementation
      ? `- Use the already prepared development branch ${featureBranch} in ${implementationRepo}. It is intentionally not created in the ally issue repo.`
      : `- Use the already prepared GitHub-linked development branch ${featureBranch}.`,
    crossRepoImplementation
      ? `- Before editing, verify the current branch. War Room should have checked the ${implementationRepo} checkout out to ${featureBranch}; if it is not already on that branch, run \`git switch ${featureBranch}\` before editing.`
      : `- Before editing, verify the current branch. War Room should have checked this checkout out to ${featureBranch}; if it is not already on that branch, run \`git fetch origin ${featureBranch}\`, then \`git switch ${featureBranch}\` or \`git switch -c ${featureBranch} --track origin/${featureBranch}\` before editing.`,
    '- Read and follow the repository AGENTS.md plus referenced development/testing instructions before editing.',
    '- Use the existing issue body and GitHub discussion as the accepted triage context.',
    `- Make the required code, test, and product documentation changes in ${implementationRepo}.`,
    '- Do not create standalone preflight, plan, or analysis markdown files unless the issue specifically asks for product documentation.',
    '- Run the most relevant validation commands for the changed surface; if the repo defines a full go/check command, run it before finishing when feasible.',
    '- Commit the implementation on the feature branch after validation passes. If validation cannot pass, leave the code changes in place and explain the blocker.',
    `- When publishing the PR, include \`Closes ${options.issue}\` in the PR body so GitHub links the PR and closes the issue on merge.`,
    '- Do not merge.',
    '',
    'Complete issue body:',
    fullText(issue.body),
    '',
    'Complete GitHub discussion and triage comments:',
    issueComments,
  ].filter((line): line is string => line !== null).join('\n');
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'issue-start', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
        'issue.json': JSON.stringify(issue, null, 2),
      })
    : null;
  const adapterCommand = adapterInvocation.display;
  if (
    options.dryRun === false &&
    (developmentBranch.blocked.length > 0 ||
      !developmentBranch.applied ||
      (developmentBranch.checkoutRequired && !developmentBranch.checkedOut))
  ) {
    return {
      prompt,
      artifact,
      launched: false,
      adapterCommand,
      action: 'issue-start',
      issue: options.issue,
      campaignStatus: null,
      labelUpdate: null,
      developmentBranch,
      contextSummary: { promptCharacters: prompt.length, comments: issue.comments?.length ?? 0 },
      adapterCwd,
      launchError: developmentBranch.error ?? developmentBranch.blocked.join(' '),
    };
  }
  const campaignStatus = setCampaignStatus(options.issue, 'battlefield-active', { confirm: options.confirmStatus });
  const labelUpdate = setIssueWorkflowLabel(options.issue, 'battlefield-active', options.confirmStatus === true);

  const contextSummary = { promptCharacters: prompt.length, comments: issue.comments?.length ?? 0 };
  if (options.dryRun !== false) {
    return { prompt, artifact, launched: false, adapterCommand, action: 'issue-start', issue: options.issue, campaignStatus, labelUpdate, developmentBranch, contextSummary, adapterCwd };
  }
  if (labelUpdate.error) {
    return {
      prompt,
      artifact,
      launched: false,
      adapterCommand,
      action: 'issue-start',
      issue: options.issue,
      campaignStatus,
      labelUpdate,
      developmentBranch,
      contextSummary,
      adapterCwd,
      launchError: labelUpdate.error,
    };
  }
  const launch = runAdapter(workspaceRoot, prompt, {
    cwd: adapterCwd,
    usage: {
      issue: options.issue,
      command: 'issue-next',
      stage: 'implementation-handoff',
      repo: implementationRepo,
      runDir: artifact?.runDir ?? null,
      commandRunId,
    },
  });
  return {
    prompt,
    artifact,
    launched: launch.launched,
    adapterCommand: launch.invocation.display,
    action: 'issue-start',
    issue: options.issue,
    campaignStatus,
    labelUpdate,
    developmentBranch,
    contextSummary,
    adapterCwd,
    launchError: launch.error,
  };
}

function buildCodeRabbitThreadContext(threads: MergeReadiness['unresolvedReviewThreads']) {
  if (threads.length === 0) {
    return 'No current unresolved CodeRabbit review threads were visible before launch. Inspect the latest PR review state directly, and if new CodeRabbit feedback appears, handle it with the same reply rules below.';
  }

  return threads
    .map((thread, index) => {
      const line = thread.line === null ? '' : `:${thread.line}`;
      return [
        `${index + 1}. ${thread.path}${line}`,
        `   Thread ID: ${thread.threadId ?? '(not returned by GitHub)'}`,
        `   Review comment ID: ${thread.commentId ?? '(not returned by GitHub)'}`,
        `   URL: ${thread.url ?? '(not returned by GitHub)'}`,
        `   Excerpt: ${thread.excerpt}`,
      ].join('\n');
    })
    .join('\n');
}

function buildCodeRabbitPrReviewPrompt(
  prUrl: string,
  ref: { repo: string; number: number },
  threads: MergeReadiness['unresolvedReviewThreads'],
  issueRef: string | null = null
) {
  return `Please analyze the latest [@coderabbit](plugin://coderabbit@openai-curated)
 feedback for the latest commit on the [@github](plugin://github@openai-curated)
 PR ${prUrl}

Repository: ${ref.repo}
PR number: ${ref.number}
Linked issue: ${issueRef ?? 'none inferred'}

Outstanding CodeRabbit review threads captured by War Room:
${buildCodeRabbitThreadContext(threads)}

Please loop over each CodeRabbit review thread one by one.

As an optional progress marker, add the eyes (👀) reaction to the original review comment when GitHub exposes a review comment ID:

\`gh api -X POST repos/${ref.repo}/pulls/comments/<COMMENT_ID>/reactions -f content=eyes -H "Accept: application/vnd.github+json"\`

If adding the reaction is blocked, cancelled, unsupported, or unauthenticated, skip the reaction and continue. Do not stop before code changes only because the reaction could not be added.

Next, review the feedback and grill-me for additional context to complete the work. If a code change is required, implement the update in the checked-out PR branch.

Finally, you must post one final reply on every listed thread. Do not only commit code and do not rely on CodeRabbit auto-resolving the thread.

Use this thread-reply mutation with each listed Thread ID:

\`gh api graphql -f threadId=<THREAD_ID> -f body='Change made: ...' -f query='mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { url } } }'\`

Reply format:
- Change made: explain the code or test change and include the commit SHA after the commit exists.
- Skipped: explain why the feedback is not valid or why no implementation is required.

Before finishing, verify every listed Thread ID has a non-CodeRabbit reply starting with either "Change made:" or "Skipped:". If GitHub will not let you reply, stop and report the blocker instead of claiming the review loop is complete.

Once all comments are complete and you've looped through all outstanding feedback, commit the code into the PR branch.`;
}

async function runCodeRabbitPrReviewLoop(
  workspaceRoot: string,
  ref: { repo: string; number: number },
  prUrl: string,
  adapterCwd: string,
  initialSnapshot: PrReviewSnapshot,
  options: PrOptions,
  usage: { runDir: string | null; commandRunId: string }
): Promise<{ loop: PrReviewLoopResult; launched: boolean; adapterCommand: string | null; launchError: string | null }> {
  const config = prReviewLoopConfig();
  const iterations: PrReviewLoopResult['iterations'] = [];
  const blocked: string[] = [];
  const expectedReplyThreads = new Map<string, MergeReadiness['unresolvedReviewThreads'][number]>();
  let currentHeadSha = initialSnapshot.headRefOid ?? null;
  let adapterCommand: string | null = null;

  if (!currentHeadSha) {
    blocked.push('Could not read the PR head commit before launching the review loop.');
    return {
      loop: { status: 'failed', completed: false, iterations, blocked, error: blocked.join(' ') },
      launched: false,
      adapterCommand,
      launchError: blocked.join(' '),
    };
  }

  if (options.waitForInitialCodeRabbit) {
    options.reviewStatus?.(`PR review loop: waiting for CodeRabbit feedback on the initial PR commit ${shortSha(currentHeadSha)}.`);
    const feedback = await waitForCodeRabbitFeedback(
      ref,
      currentHeadSha,
      config.codeRabbitTimeoutMs,
      config.codeRabbitSettleMs,
      config.pollMs
    );
    if (!feedback.ready) {
      const error = `CodeRabbit feedback did not settle on the initial PR commit ${shortSha(currentHeadSha)} within ${
        config.codeRabbitTimeoutMs
      }ms: ${feedback.reason ?? 'unknown wait state'}`;
      return {
        loop: { status: 'failed', completed: false, iterations, blocked: [error], error },
        launched: false,
        adapterCommand,
        launchError: error,
      };
    }

    if (feedback.threads.length === 0) {
      options.reviewStatus?.('PR review loop: no outstanding CodeRabbit feedback remains on the initial PR commit.');
      return {
        loop: { status: 'passed', completed: true, iterations, blocked: [], error: null },
        launched: false,
        adapterCommand,
        launchError: null,
      };
    }

    options.reviewStatus?.(
      `PR review loop: ${feedback.threads.length} outstanding CodeRabbit comment${
        feedback.threads.length === 1 ? ' is' : 's are'
      } ready on the initial PR commit.`
    );
  }

  for (let index = 1; index <= config.maxLoops; index += 1) {
    const threadsForPrompt = listOutstandingCodeRabbitThreads(ref);
    for (const thread of threadsForPrompt) {
      if (thread.threadId) expectedReplyThreads.set(thread.threadId, thread);
    }
    const prompt = buildCodeRabbitPrReviewPrompt(prUrl, ref, threadsForPrompt, options.issue ?? null);
    options.reviewStatus?.(`PR review loop ${index}: launching adapter for ${ref.repo}#${ref.number}.`);
    const localHeadBeforeAdapter = gitHeadShaOrNull(adapterCwd);
    const launch = runAdapter(workspaceRoot, prompt, {
      cwd: adapterCwd,
      usage: {
        issue: options.issue ?? null,
        command: 'pr-review',
        stage: `coderabbit-loop-${index}`,
        repo: ref.repo,
        runDir: usage.runDir,
        commandRunId: usage.commandRunId,
      },
    });
    adapterCommand = launch.invocation.display;
    const iteration: PrReviewLoopResult['iterations'][number] = {
      iteration: index,
      startHeadSha: currentHeadSha,
      endHeadSha: null,
      adapterLaunched: launch.launched,
      adapterError: launch.error,
      outstandingCodeRabbitComments: null,
      codeRabbitObserved: null,
      codeRabbitSettled: null,
    };

    if (!launch.launched) {
      iterations.push(iteration);
      const error = launch.error ?? 'LLM adapter failed.';
      const launchedAny = iterations.some((entry) => entry.adapterLaunched);
      return {
        loop: { status: 'failed', completed: false, iterations, blocked: [error], error },
        launched: launchedAny,
        adapterCommand,
        launchError: error,
      };
    }

    const published = publishAdapterReviewChanges(
      adapterCwd,
      initialSnapshot.headRefName ?? null,
      currentHeadSha,
      localHeadBeforeAdapter,
      options.reviewStatus
    );
    if (published.error) {
      iteration.endHeadSha = currentHeadSha;
      iterations.push(iteration);
      return {
        loop: { status: 'failed', completed: false, iterations, blocked: [published.error], error: published.error },
        launched: true,
        adapterCommand,
        launchError: published.error,
      };
    }

    options.reviewStatus?.(
      `PR review loop ${index}: waiting for a new commit on ${initialSnapshot.headRefName ?? 'the PR branch'} after ${shortSha(currentHeadSha)}.`
    );
    const commit = await waitForPrHeadChange(ref, currentHeadSha, config.commitTimeoutMs, config.pollMs);
    if (!commit.changed || !commit.snapshot.headRefOid) {
      iteration.endHeadSha = commit.snapshot.headRefOid ?? currentHeadSha;
      iterations.push(iteration);
      const error = `No new PR commit was detected within ${config.commitTimeoutMs}ms after adapter completion.`;
      return {
        loop: { status: 'failed', completed: false, iterations, blocked: [error], error },
        launched: true,
        adapterCommand,
        launchError: error,
      };
    }

    currentHeadSha = commit.snapshot.headRefOid;
    iteration.endHeadSha = currentHeadSha;
    options.reviewStatus?.(`PR review loop ${index}: detected PR commit ${shortSha(currentHeadSha)}.`);
    options.reviewStatus?.(`PR review loop ${index}: waiting for CodeRabbit feedback on the latest commit.`);
    const feedback = await waitForCodeRabbitFeedback(
      ref,
      currentHeadSha,
      config.codeRabbitTimeoutMs,
      config.codeRabbitSettleMs,
      config.pollMs
    );
    const outstanding = feedback.threads.length;
    iteration.outstandingCodeRabbitComments = outstanding;
    iteration.codeRabbitObserved = feedback.codeRabbitObserved;
    iteration.codeRabbitSettled = feedback.codeRabbitSettled;
    iterations.push(iteration);

    if (!feedback.ready) {
      const error = `CodeRabbit feedback did not settle within ${config.codeRabbitTimeoutMs}ms after commit ${shortSha(
        currentHeadSha
      )}: ${feedback.reason ?? 'unknown wait state'}`;
      return {
        loop: { status: 'failed', completed: false, iterations, blocked: [error], error },
        launched: true,
        adapterCommand,
        launchError: error,
      };
    }

    if (outstanding === 0) {
      const missingReplies = listCodeRabbitThreadsMissingReplies(ref, [...expectedReplyThreads.values()]);
      if (missingReplies.length > 0) {
        const error = `LLM adapter did not post final replies to ${missingReplies.length} CodeRabbit review thread${
          missingReplies.length === 1 ? '' : 's'
        }: ${missingReplies.map((thread) => thread.url ?? thread.threadId ?? thread.path).join(', ')}`;
        return {
          loop: { status: 'failed', completed: false, iterations, blocked: [error], error },
          launched: true,
          adapterCommand,
          launchError: error,
        };
      }
      options.reviewStatus?.(`PR review loop ${index}: no outstanding CodeRabbit feedback remains.`);
      return {
        loop: { status: 'passed', completed: true, iterations, blocked: [], error: null },
        launched: true,
        adapterCommand,
        launchError: null,
      };
    }

    options.reviewStatus?.(
      `PR review loop ${index}: ${outstanding} outstanding CodeRabbit comment${outstanding === 1 ? ' remains' : 's remain'}; starting another adapter loop.`
    );
  }

  const error = `CodeRabbit feedback still requires work after ${config.maxLoops} adapter loop${config.maxLoops === 1 ? '' : 's'}.`;
  return {
    loop: { status: 'failed', completed: false, iterations, blocked: [error], error },
    launched: true,
    adapterCommand,
    launchError: error,
  };
}

export async function runPrReview(workspaceRoot: string, options: PrOptions): Promise<PrPlanResult> {
  const commandRunId = createUsageCommandRunId('pr-review');
  if (!options.pr) throw new Error('warroom pr review requires --pr owner/repo#number.');
  const ref = parsePrRef(options.pr);
  const pr = prReviewSnapshot(ref);
  const issueRef = options.issue ?? closingIssueRefFromText(ref.repo, pr.body);
  const resolvedOptions = { ...options, issue: issueRef ?? undefined };
  const prUrl = pr.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`;
  const initialCodeRabbitThreads = listOutstandingCodeRabbitThreads(ref);
  const prompt = buildCodeRabbitPrReviewPrompt(prUrl, ref, initialCodeRabbitThreads, issueRef);
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-review', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(resolvedOptions, null, 2),
        'pr.json': JSON.stringify(pr, null, 2),
      })
    : null;
  const adapterCwd = repoWorkspaceForGitHub(workspaceRoot, ref.repo);
  const adapterCommand = getAdapterInvocation(workspaceRoot, adapterCwd).display;
  const campaignStatus = issueRef
    ? setCampaignStatus(issueRef, 'skirmish', { confirm: options.confirmStatus })
    : null;
  const labelUpdate = issueRef ? setIssueWorkflowLabel(issueRef, 'skirmish', options.confirmStatus === true) : null;
  const contextSummary = {
    promptCharacters: prompt.length,
    comments: initialCodeRabbitThreads.length,
    checks: pr.statusCheckRollup?.length ?? 0,
  };

  if (options.dryRun !== false) {
    return {
      prompt,
      artifact,
      launched: false,
      adapterCommand,
      action: 'review',
      issue: issueRef,
      campaignStatus,
      labelUpdate,
      contextSummary,
      adapterCwd,
      prReviewLoop: { status: 'planned', completed: false, iterations: [], blocked: [], error: null },
    };
  }

  const loop = await runCodeRabbitPrReviewLoop(workspaceRoot, ref, prUrl, adapterCwd, pr, resolvedOptions, {
    runDir: artifact?.runDir ?? null,
    commandRunId,
  });
  return {
    prompt,
    artifact,
    launched: loop.launched,
    adapterCommand: loop.adapterCommand ?? adapterCommand,
    action: 'review',
    issue: issueRef,
    campaignStatus,
    labelUpdate,
    contextSummary,
    adapterCwd,
    prReviewLoop: loop.loop,
    launchError: loop.launchError,
  };
}

export async function runPrMerge(workspaceRoot: string, options: PrOptions): Promise<PrPlanResult> {
  const commandRunId = createUsageCommandRunId('pr-merge');
  if (!options.pr) throw new Error('warroom pr merge requires --pr owner/repo#number.');
  const ref = parsePrRef(options.pr);
  const pr = ghJson<{
    title?: string;
    body?: string;
    url?: string;
    mergeStateStatus?: string;
    mergeable?: string;
    reviewDecision?: string;
    headRefName?: string;
    baseRefName?: string;
    isDraft?: boolean;
    files?: Array<{ path?: string; additions?: number; deletions?: number }>;
    reviewRequests?: Array<{ login?: string; name?: string; slug?: string; __typename?: string }>;
    latestReviews?: Array<{ state?: string; author?: { login?: string }; submittedAt?: string }>;
    statusCheckRollup?: Array<{
      name?: string;
      context?: string;
      status?: string;
      conclusion?: string;
      state?: string;
      workflowName?: string;
      detailsUrl?: string;
      targetUrl?: string;
    }>;
  }>(
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      ref.repo,
      '--json',
      'title,body,url,mergeStateStatus,mergeable,reviewDecision,headRefName,baseRefName,isDraft,files,reviewRequests,latestReviews,statusCheckRollup',
    ],
    {}
  );
  const issueRef = options.issue ?? closingIssueRefFromText(ref.repo, pr.body);
  const resolvedOptions = { ...options, issue: issueRef ?? undefined };
  const reviewThreads = listPullRequestReviewThreads(ref);
  const readiness = buildMergeReadiness(pr, reviewThreads, {
    allowUnresolvedReviewThreads: options.allowUnresolvedReviewThreads,
  });
  const targetBase = pr.baseRefName ?? loadRepoManifest(workspaceRoot).defaults.default_branch;
  const configuredMergePlaywright = mergePlaywrightRequirement(workspaceRoot, ref.repo);
  const mergePlaywright = options.skipMergeE2E ? mergePlaywrightSkipRequirement() : configuredMergePlaywright;
  const mergeChangelogRequirementResult = mergeChangelogRequirement(workspaceRoot, ref.repo);
  let mergeE2E = createMergeE2EPlan(workspaceRoot, mergePlaywright);
  let mergeChangelog = createMergeChangelogPlan(workspaceRoot, ref.repo, targetBase, mergeChangelogRequirementResult);
  const summary = buildVictorySummary(options.pr, issueRef ?? undefined, pr, readiness, options.summary);
  const blockerDetails = readiness.details.length
    ? readiness.details
        .map((detail) => [
          `- ${detail.blocker}`,
          `  Why: ${detail.explanation}`,
          detail.evidence.length ? `  Evidence: ${detail.evidence.join(' ')}` : null,
          `  Resolve: ${detail.resolution}`,
        ].filter(Boolean).join('\n'))
        .join('\n')
    : 'none';
  const unresolvedThreads = readiness.unresolvedReviewThreads.length
    ? readiness.unresolvedReviewThreads
        .map((thread) => {
          const line = thread.line === null ? '' : `:${thread.line}`;
          const state = thread.isOutdated ? 'outdated unresolved' : 'unresolved';
          return `- ${thread.path}${line} by @${thread.author} (${state})${thread.url ? ` ${thread.url}` : ''}: ${thread.excerpt}`;
        })
        .join('\n')
    : 'none';
  const requiredMergeChecks = [
    options.allowUnresolvedReviewThreads
      ? '- Unresolved review threads were explicitly allowed for this merge attempt.'
      : '- Confirm all review and CodeRabbit feedback loops are resolved.',
    '- Confirm validation status and target branch.',
    mergeE2E.required
      ? `- Run full demo Playwright e2e: start backend with \`${mergeE2E.backendCommand}\`, wait for ${mergeE2E.backendReadyUrl}, then run \`${mergeE2E.demoCommand}\` from the demo repo.`
      : `- Demo Playwright e2e skipped: ${mergeE2E.skipReason ?? 'merge.playwright is not enabled for this repo.'}`,
    mergeE2E.required
      ? '- All demo Playwright e2e tests must pass before merging.'
      : '- Merge may proceed without the demo Playwright e2e gate for this repo.',
    mergeChangelog.required
      ? `- After merge, wait for GitHub Actions on ${targetBase}, pull the latest ${targetBase}, update CHANGELOG.md with the LLM, and push a [skip-ci] changelog commit.`
      : `- CHANGELOG.md update skipped: ${mergeChangelog.skipReason ?? 'merge.changelog is not enabled for this repo.'}`,
    '- Merge only after explicit confirmation.',
    '- Post issue/PR summary and return local checkout to the default branch safely.',
  ];
  const prompt = [
    `War Room PR merge preflight for ${options.pr}`,
    '',
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
    `Merge state: ${pr.mergeStateStatus ?? 'unknown'}`,
    `GitHub mergeable: ${pr.mergeable ?? 'unknown'}`,
    `Review decision: ${pr.reviewDecision ?? 'unknown'}`,
    `Draft: ${pr.isDraft === undefined ? 'unknown' : pr.isDraft ? 'yes' : 'no'}`,
    `Requested reviewers: ${readiness.requestedReviewers.length ? readiness.requestedReviewers.join(', ') : 'none'}`,
    '',
    buildSpecialistContext(workspaceRoot, ref.repo),
    '',
    'Readiness blockers:',
    readiness.blocked.length ? readiness.blocked.map((blocker) => `- ${blocker}`).join('\n') : 'none',
    '',
    'Readiness blocker details:',
    blockerDetails,
    '',
    'Unresolved review threads:',
    unresolvedThreads,
    '',
    'Checks:',
    readiness.checks.length ? readiness.checks.map((check) => `- ${check.name}: ${check.state}${check.url ? ` (${check.url})` : ''}`).join('\n') : 'none',
    '',
    'Required merge checks:',
    requiredMergeChecks.join('\n'),
    '',
    'Victory summary:',
    summary,
  ].join('\n');
  let merged = false;

  if (options.confirm) {
    if (readiness.blocked.length > 0) throw new Error(`PR is not merge-ready: ${readiness.blocked.join(' ')}`);
    if (mergeChangelog.required && mergeChangelog.blocked.length > 0) {
      throw new Error(`PR cannot be merged until the changelog gate is ready. ${mergeChangelog.blocked.join(' ')}`);
    }
    mergeE2E = await runMergeE2E(workspaceRoot, mergePlaywright, options);
    if (mergeE2E.required && mergeE2E.status !== 'passed') {
      const blockers = [...mergeE2E.blocked, mergeE2E.error].filter(Boolean).join(' ');
      throw new Error(`PR cannot be merged until demo Playwright e2e passes. ${blockers}`.trim());
    }
    const result = spawnSync(
      'gh',
      ['pr', 'merge', String(ref.number), '--repo', ref.repo, '--squash', '--delete-branch'],
      { stdio: 'inherit' }
    );
    if (result.status !== 0) throw new Error(`gh pr merge failed with exit ${result.status ?? 'unknown'}.`);
    merged = true;
    mergeChangelog = await runMergeChangelog(workspaceRoot, mergeChangelog, resolvedOptions, pr, { commandRunId });
  }

  const completionReadiness =
    mergeChangelog.required && mergeChangelog.status === 'failed'
      ? { ...readiness, blocked: [...readiness.blocked, 'Required CHANGELOG.md update failed.'] }
      : readiness;
  const summaryPosts = buildSummaryPostPlan(resolvedOptions, summary, completionReadiness);
  const finalIssueComment = buildFinalIssueCommentPlan(
    issueRef ?? null,
    options.pr,
    pr,
    merged,
    completionReadiness,
    mergeE2E,
    mergeChangelog,
    options.issueComment
  );
  const localCleanup = planLocalCleanup(workspaceRoot, ref.repo, pr.headRefName, pr.baseRefName, options);
  const applyVictoryCloseout = (merged || options.confirmStatus === true) && completionReadiness.blocked.length === 0;
  const campaignStatus = issueRef
    ? setCampaignStatus(issueRef, 'victory', { confirm: applyVictoryCloseout })
    : null;
  const labelUpdate = issueRef
    ? setIssueWorkflowLabel(issueRef, 'victory', applyVictoryCloseout)
    : null;
  const usageSummary = merged && issueRef ? summarizeIssueUsage(workspaceRoot, issueRef) : null;
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-merge', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(resolvedOptions, null, 2),
        'pr.json': JSON.stringify(pr, null, 2),
        'readiness.json': JSON.stringify(readiness, null, 2),
        'merge-e2e.json': JSON.stringify(mergeE2E, null, 2),
        'merge-changelog.json': JSON.stringify(mergeChangelog, null, 2),
        'summary.md': summary,
        'summary-posts.json': JSON.stringify(summaryPosts, null, 2),
        ...(finalIssueComment ? { 'final-issue-comment.json': JSON.stringify(finalIssueComment, null, 2) } : {}),
        ...(finalIssueComment
          ? { 'final-issue-comment.md': buildFinalVictoryComment(options.pr, pr, mergeE2E, mergeChangelog) }
          : {}),
        ...(usageSummary ? { 'final-usage-summary.json': JSON.stringify(usageSummary, null, 2) } : {}),
        ...(issueRef ? { 'usage.json': JSON.stringify(usageEntriesForCommandRun(workspaceRoot, issueRef, commandRunId), null, 2) } : {}),
        'local-cleanup.json': JSON.stringify(localCleanup, null, 2),
      })
    : null;

  return {
    prompt,
    artifact,
    launched: false,
    adapterCommand: null,
    action: 'merge',
    issue: issueRef,
    campaignStatus,
    labelUpdate,
    mergeReadiness: readiness,
    mergeE2E,
    mergeChangelog,
    usageSummary,
    summary,
    summaryPosts,
    finalIssueComment,
    merged,
    localCleanup,
    contextSummary: { promptCharacters: prompt.length, checks: readiness.checks.length },
  };
}
