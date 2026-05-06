import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
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
import { getRepoHealth, loadRepoManifest, runGit } from '../lib/repos.js';
import { buildSpecialistContext } from '../lib/specialist-context.js';
import { parseIssueRef } from './issues.js';

export type PrOptions = {
  issue?: string;
  pr?: string;
  dryRun?: boolean;
  writeArtifact?: boolean;
  confirm?: boolean;
  base?: string;
  confirmStatus?: boolean;
  summary?: string;
  postSummary?: boolean;
  confirmSummary?: boolean;
  cleanupLocal?: boolean;
  confirmCleanup?: boolean;
  checkInMinutes?: number;
  issueTitle?: string;
  issueUrl?: string;
  currentPath?: string;
  e2eStatus?: (message: string) => void;
  e2eOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
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

export type PrPlanResult = {
  prompt: string;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string | null;
  action: 'engage' | 'review' | 'merge';
  campaignStatus: CampaignStatusSetResult | null;
  mergeReadiness?: MergeReadiness;
  summary?: string;
  summaryPosts?: SummaryPostResult[];
  merged?: boolean;
  localCleanup?: LocalCleanupResult | null;
  mergeE2E?: MergeE2EResult;
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

function ghJson<T>(args: string[], fallback: T): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
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
      skipReason: `No mapped repo entry with merge_playwright: true for ${githubRepo}.`,
    };
  }

  return repo.merge_playwright
    ? { required: true, skipReason: null }
    : { required: false, skipReason: `repos.yaml has merge_playwright: false for ${githubRepo}.` };
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
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: {
    nodes?: Array<{
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

const PULL_REQUEST_REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          comments(first: 1) {
            nodes {
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

function listPullRequestReviewThreads(ref: { repo: string; number: number }): MergeReadiness['unresolvedReviewThreads'] {
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

  return (response.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [])
    .filter((thread) => thread.isResolved === false)
    .map((thread) => {
      const comment = thread.comments?.nodes?.[0];
      return {
        path: comment?.path ?? 'unknown',
        line: comment?.line ?? null,
        author: comment?.author?.login ?? 'unknown',
        url: comment?.url ?? null,
        isOutdated: thread.isOutdated === true,
        excerpt: truncateText(comment?.body?.replace(/\s+/g, ' ').trim(), 180),
      };
    });
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
}, unresolvedReviewThreads: MergeReadiness['unresolvedReviewThreads'] = []): MergeReadiness {
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
  if (mergeStateStatus && ['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN'].includes(mergeStateStatus)) {
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

  if (currentUnresolvedThreads.length > 0) {
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
  if (options.confirmCleanup && blocked.length === 0 && repo.branch !== targetBranch) {
    const switched = runGit(repo.resolvedPath, ['switch', targetBranch]);
    if (switched.status !== 0) {
      blocked.push(switched.stderr || `git switch ${targetBranch} failed with exit ${switched.status ?? 'unknown'}.`);
    } else {
      applied = true;
      messages.push(`Switched local checkout to ${targetBranch}.`);
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

export function runPrEngage(workspaceRoot: string, options: PrOptions): PrPlanResult {
  if (!options.issue) throw new Error('warroom pr engage requires --issue owner/repo#number.');
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
  const featureBranch = featureBranchForIssue(ref, title);
  const issueComments = summarizeList(issue.comments, (comment) => {
    const author = comment.author?.login ?? 'unknown';
    return `- ${author} at ${comment.createdAt ?? 'unknown'}: ${truncateText(comment.body, 1000)}`;
  });
  const prompt = [
    `War Room implementation handoff for ${options.issue}`,
    '',
    `Title: ${title}`,
    `URL: ${issue.url ?? options.issueUrl ?? `https://github.com/${ref.repo}/issues/${ref.number}`}`,
    `Base branch: ${options.base ?? 'main'} (use stage only as the second target option after validation)`,
    `Feature branch: ${featureBranch}`,
    '',
    buildSpecialistContext(workspaceRoot, ref.repo),
    '',
    'Mission:',
    '- Implement the issue now. Do not stop after writing a plan, preflight, analysis note, or handoff markdown.',
    `- Start from ${options.base ?? 'main'} and create or switch to feature branch ${featureBranch}.`,
    '- Read and follow the repository AGENTS.md plus referenced development/testing instructions before editing.',
    '- Use the existing issue body and GitHub discussion as the accepted triage context.',
    '- Make the required code, test, and product documentation changes in this owning child repo.',
    '- Do not create standalone preflight, plan, or analysis markdown files unless the issue specifically asks for product documentation.',
    '- Run the most relevant validation commands for the changed surface; if the repo defines a full go/check command, run it before finishing when feasible.',
    '- Commit the implementation on the feature branch after validation passes. If validation cannot pass, leave the code changes in place and explain the blocker.',
    '- Do not merge. Do not open a PR unless the repository workflow explicitly requires it after a completed, validated commit.',
    '',
    'Issue body:',
    truncateText(issue.body),
    '',
    'GitHub discussion and triage comments:',
    issueComments,
  ].join('\n');
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-engage', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
      })
    : null;
  const adapterCwd = repoWorkspaceForGitHub(workspaceRoot, ref.repo);
  const adapterRepoId = repoIdForGitHub(workspaceRoot, ref.repo);
  const adapterCommand = getAdapterInvocation(workspaceRoot, adapterCwd, { repoId: adapterRepoId }).display;
  const campaignStatus = setCampaignStatus(options.issue, 'battlefield-active', { confirm: options.confirmStatus });

  const contextSummary = { promptCharacters: prompt.length, comments: issue.comments?.length ?? 0 };
  if (options.dryRun !== false) {
    return { prompt, artifact, launched: false, adapterCommand, action: 'engage', campaignStatus, contextSummary, adapterCwd };
  }
  const launch = runAdapter(workspaceRoot, prompt, { cwd: adapterCwd, repoId: adapterRepoId });
  return {
    prompt,
    artifact,
    launched: launch.launched,
    adapterCommand: launch.invocation.display,
    action: 'engage',
    campaignStatus,
    contextSummary,
    adapterCwd,
    launchError: launch.error,
  };
}

export function runPrReview(workspaceRoot: string, options: PrOptions): PrPlanResult {
  if (!options.pr) throw new Error('warroom pr review requires --pr owner/repo#number.');
  const ref = parsePrRef(options.pr);
  const pr = ghJson<{
    title?: string;
    body?: string;
    url?: string;
    headRefName?: string;
    baseRefName?: string;
    files?: Array<{ path?: string; additions?: number; deletions?: number }>;
    comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
    latestReviews?: Array<{ author?: { login?: string }; state?: string; body?: string; submittedAt?: string }>;
    statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string; workflowName?: string }>;
  }>(
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      ref.repo,
      '--json',
      'title,body,url,headRefName,baseRefName,files,comments,latestReviews,statusCheckRollup',
    ],
    {}
  );
  const files = summarizeList(
    pr.files,
    (file) => `- ${file.path ?? 'unknown'} (+${file.additions ?? 0}/-${file.deletions ?? 0})`
  );
  const comments = summarizeList(pr.comments, (comment) => {
    const author = comment.author?.login ?? 'unknown';
    return `- ${author} at ${comment.createdAt ?? 'unknown'}: ${truncateText(comment.body, 500)}`;
  });
  const reviews = summarizeList(pr.latestReviews, (review) => {
    const author = review.author?.login ?? 'unknown';
    return `- ${review.state ?? 'UNKNOWN'} by ${author} at ${review.submittedAt ?? 'unknown'}: ${truncateText(review.body, 500)}`;
  });
  const checks = summarizeList(pr.statusCheckRollup, (check) => {
    const state = check.conclusion ?? check.status ?? 'unknown';
    const workflow = check.workflowName ? ` (${check.workflowName})` : '';
    return `- ${check.name ?? 'unknown'}${workflow}: ${state}`;
  });
  const checkInMinutes = options.checkInMinutes ?? 60;
  const prompt = [
    `War Room PR review handoff for ${options.pr}`,
    '',
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
    '',
    buildSpecialistContext(workspaceRoot, ref.repo),
    '',
    'Required review loop:',
    '- Gather current GitHub and CodeRabbit feedback before editing.',
    '- Reply to each actionable comment with an outcome marker after handling it.',
    '- Pause on vague, repeated, or circular feedback.',
    '- Keep context scoped to changed files, comments, and repo instructions.',
    '- Use eyes-in-progress replies before starting comment-by-comment feedback work when posting is explicitly confirmed.',
    '- Reply with ✅ for completed feedback and ❌ plus a concise reason when feedback is not actionable.',
    `- Check back every ${checkInMinutes} minutes while the skirmish remains active, then continue or retreat through warroom abort.`,
    '- Use warroom abort for preservation-first recovery if the loop needs to stop.',
    '',
    'Changed files:',
    files,
    '',
    'Latest reviews:',
    reviews,
    '',
    'Comments:',
    comments,
    '',
    'Checks:',
    checks,
    '',
    'PR body:',
    truncateText(pr.body),
  ].join('\n');
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-review', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
      })
    : null;
  const adapterCwd = repoWorkspaceForGitHub(workspaceRoot, ref.repo);
  const adapterRepoId = repoIdForGitHub(workspaceRoot, ref.repo);
  const adapterCommand = getAdapterInvocation(workspaceRoot, adapterCwd, { repoId: adapterRepoId }).display;
  const campaignStatus = options.issue
    ? setCampaignStatus(options.issue, 'skirmish', { confirm: options.confirmStatus })
    : null;
  const contextSummary = {
    promptCharacters: prompt.length,
    changedFiles: pr.files?.length ?? 0,
    comments: pr.comments?.length ?? 0,
    reviews: pr.latestReviews?.length ?? 0,
    checks: pr.statusCheckRollup?.length ?? 0,
    checkInMinutes,
  };

  if (options.dryRun !== false) {
    return { prompt, artifact, launched: false, adapterCommand, action: 'review', campaignStatus, contextSummary, adapterCwd };
  }
  const launch = runAdapter(workspaceRoot, prompt, { cwd: adapterCwd, repoId: adapterRepoId });
  return {
    prompt,
    artifact,
    launched: launch.launched,
    adapterCommand: launch.invocation.display,
    action: 'review',
    campaignStatus,
    contextSummary,
    adapterCwd,
    launchError: launch.error,
  };
}

export async function runPrMerge(workspaceRoot: string, options: PrOptions): Promise<PrPlanResult> {
  if (!options.pr) throw new Error('warroom pr merge requires --pr owner/repo#number.');
  const ref = parsePrRef(options.pr);
  const pr = ghJson<{
    title?: string;
    url?: string;
    mergeStateStatus?: string;
    mergeable?: string;
    reviewDecision?: string;
    headRefName?: string;
    baseRefName?: string;
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
  }>(
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      ref.repo,
      '--json',
      'title,url,mergeStateStatus,mergeable,reviewDecision,headRefName,baseRefName,isDraft,reviewRequests,latestReviews,statusCheckRollup',
    ],
    {}
  );
  const reviewThreads = listPullRequestReviewThreads(ref);
  const readiness = buildMergeReadiness(pr, reviewThreads);
  const mergePlaywright = mergePlaywrightRequirement(workspaceRoot, ref.repo);
  let mergeE2E = createMergeE2EPlan(workspaceRoot, mergePlaywright);
  const summary = buildVictorySummary(options.pr, options.issue, pr, readiness, options.summary);
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
    '- Confirm all review and CodeRabbit feedback loops are resolved.',
    '- Confirm validation status and target branch.',
    mergeE2E.required
      ? `- Run full demo Playwright e2e: start backend with \`${mergeE2E.backendCommand}\`, wait for ${mergeE2E.backendReadyUrl}, then run \`${mergeE2E.demoCommand}\` from the demo repo.`
      : `- Demo Playwright e2e skipped: ${mergeE2E.skipReason ?? 'merge_playwright is not enabled for this repo.'}`,
    mergeE2E.required
      ? '- All demo Playwright e2e tests must pass before merging.'
      : '- Merge may proceed without the demo Playwright e2e gate for this repo.',
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
  }

  const summaryPosts = buildSummaryPostPlan(options, summary, readiness);
  const localCleanup = planLocalCleanup(workspaceRoot, ref.repo, pr.headRefName, pr.baseRefName, options);
  const campaignStatus = options.issue
    ? setCampaignStatus(options.issue, 'victory', { confirm: options.confirmStatus && readiness.blocked.length === 0 })
    : null;
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-merge', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
        'pr.json': JSON.stringify(pr, null, 2),
        'readiness.json': JSON.stringify(readiness, null, 2),
        'merge-e2e.json': JSON.stringify(mergeE2E, null, 2),
        'summary.md': summary,
        'summary-posts.json': JSON.stringify(summaryPosts, null, 2),
        'local-cleanup.json': JSON.stringify(localCleanup, null, 2),
      })
    : null;

  return {
    prompt,
    artifact,
    launched: false,
    adapterCommand: null,
    action: 'merge',
    campaignStatus,
    mergeReadiness: readiness,
    mergeE2E,
    summary,
    summaryPosts,
    merged,
    localCleanup,
    contextSummary: { promptCharacters: prompt.length, checks: readiness.checks.length },
  };
}
