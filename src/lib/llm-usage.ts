import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AdapterInvocation } from './env.js';

export type LlmUsageContext = {
  issue?: string | null;
  command: string;
  stage: string;
  repo?: string | null;
  runDir?: string | null;
  commandRunId?: string | null;
};

export type LlmUsageEntry = {
  id: string;
  timestamp: string;
  issue: string | null;
  command: string;
  stage: string;
  repo: string | null;
  cwd: string | null;
  adapter: string;
  model: string | null;
  reasoningEffort: string | null;
  mode: 'foreground' | 'interactive';
  commandDisplay: string;
  commandRunId: string | null;
  runDir: string | null;
  status: 'succeeded' | 'failed';
  exitStatus: number | null;
  signal: string | null;
  error: string | null;
  promptCharacters: number;
  outputCharacters: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimated: boolean;
  usageSource: 'adapter' | 'estimated' | 'mixed';
  costUsd: number | null;
  costUnavailableReason: string | null;
  migratedFromRunDir?: string | null;
};

export type LlmUsageLedger = {
  schemaVersion: 1;
  issue: string;
  updatedAt: string;
  entries: LlmUsageEntry[];
};

export type LlmRunUsageFile = {
  schemaVersion: 1;
  updatedAt: string;
  entries: LlmUsageEntry[];
};

export type LlmUsageSummary = {
  issue: string;
  ledgerPath: string;
  summaryPath: string;
  entries: number;
  failedEntries: number;
  estimatedEntries: number;
  unknownOutputEntries: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  knownTotalTokens: number;
  totalTokensExact: boolean;
  costUsd: number | null;
  costUnavailableReasons: string[];
  models: string[];
};

type PricingModel = {
  inputPerMillion?: number | null;
  cachedInputPerMillion?: number | null;
  outputPerMillion?: number | null;
  notes?: string;
};

type PricingFile = {
  currency?: string;
  effectiveDate?: string;
  models?: Record<string, PricingModel | undefined>;
};

type ParsedTokenUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  found: boolean;
};

const SCHEMA_VERSION = 1 as const;

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '');
}

export function createUsageCommandRunId(command: string) {
  return `${safeTimestamp()}-${command}-${Math.random().toString(36).slice(2, 8)}`;
}

export function issueUsageKey(issue: string) {
  return issue.replace(/[^A-Za-z0-9]+/g, '__').replace(/^_+|_+$/g, '') || 'unknown';
}

export function issueUsagePaths(workspaceRoot: string, issue: string) {
  const dir = path.join(workspaceRoot, '.warroom', 'runs', 'issues', issueUsageKey(issue));
  return {
    dir,
    ledgerPath: path.join(dir, 'usage-ledger.json'),
    summaryPath: path.join(dir, 'usage-summary.md'),
  };
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseTokenNumber(raw: string) {
  const value = raw.trim().replace(/\s+/g, '');
  if (!value) return null;
  if (/^\d{1,3}([.,]\d{3})+$/.test(value)) {
    return Number(value.replace(/[.,]/g, ''));
  }
  const normalized = value.replace(/,/g, '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function firstTokenNumber(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const parsed = match?.[1] ? parseTokenNumber(match[1]) : null;
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseAdapterUsage(text: string): ParsedTokenUsage {
  const inputTokens = firstTokenNumber(text, [
    /\binput\s+tokens?\b[^0-9]*([\d.,]+)/i,
    /\bprompt\s+tokens?\b[^0-9]*([\d.,]+)/i,
  ]);
  const cachedInputTokens = firstTokenNumber(text, [
    /\bcached\s+input\s+tokens?\b[^0-9]*([\d.,]+)/i,
    /\bcached\s+tokens?\b[^0-9]*([\d.,]+)/i,
  ]);
  const outputTokens = firstTokenNumber(text, [
    /\boutput\s+tokens?\b[^0-9]*([\d.,]+)/i,
    /\bcompletion\s+tokens?\b[^0-9]*([\d.,]+)/i,
  ]);
  const totalTokens = firstTokenNumber(text, [
    /\btotal\s+tokens?\b[^0-9]*([\d.,]+)/i,
    /\btokens\s+used\b[^0-9]*([\d.,]+)/i,
  ]);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    found: [inputTokens, cachedInputTokens, outputTokens, totalTokens].some((value) => value !== null),
  };
}

function estimateTokensFromCharacters(value: string | null | undefined) {
  if (!value) return null;
  return Math.ceil(value.length / 4);
}

function adapterModel(invocation: AdapterInvocation) {
  const index = invocation.args.indexOf('--model');
  return index === -1 ? null : invocation.args[index + 1] ?? null;
}

function adapterReasoningEffort(invocation: AdapterInvocation) {
  const config = invocation.args.find((arg) => arg.startsWith('model_reasoning_effort='));
  return config?.replace(/^model_reasoning_effort=/, '').replace(/^"|"$/g, '') ?? null;
}

function adapterName(invocation: AdapterInvocation) {
  return path.basename(invocation.command);
}

function pricingPath(workspaceRoot: string) {
  return path.join(workspaceRoot, 'config', 'llm-pricing.json');
}

function readPricing(workspaceRoot: string): PricingFile {
  return readJson<PricingFile>(pricingPath(workspaceRoot), { models: {} });
}

function entryCost(workspaceRoot: string, entry: Omit<LlmUsageEntry, 'costUsd' | 'costUnavailableReason'>) {
  const pricing = readPricing(workspaceRoot);
  const model = entry.model;
  if (!model) return { costUsd: null, costUnavailableReason: 'model unknown' };
  const price = pricing.models?.[model];
  if (!price) return { costUsd: null, costUnavailableReason: `pricing missing for ${model}` };
  if (typeof price.inputPerMillion !== 'number') return { costUsd: null, costUnavailableReason: `input pricing missing for ${model}` };
  if (typeof price.outputPerMillion !== 'number') return { costUsd: null, costUnavailableReason: `output pricing missing for ${model}` };
  if (entry.inputTokens === null) return { costUsd: null, costUnavailableReason: 'input token count unknown' };
  if (entry.outputTokens === null) return { costUsd: null, costUnavailableReason: 'output token count unknown' };
  const cachedInputTokens = entry.cachedInputTokens ?? 0;
  const uncachedInputTokens = Math.max(0, entry.inputTokens - cachedInputTokens);
  const cachedRate = typeof price.cachedInputPerMillion === 'number' ? price.cachedInputPerMillion : price.inputPerMillion;
  const cost =
    (uncachedInputTokens / 1_000_000) * price.inputPerMillion +
    (cachedInputTokens / 1_000_000) * cachedRate +
    (entry.outputTokens / 1_000_000) * price.outputPerMillion;
  return { costUsd: Number(cost.toFixed(6)), costUnavailableReason: null };
}

function buildEntry(
  workspaceRoot: string,
  context: LlmUsageContext,
  invocation: AdapterInvocation,
  prompt: string,
  result: {
    status: number | null;
    signal: NodeJS.Signals | null;
    error: string | null;
    stdout: string | null;
    stderr: string | null;
    outputText: string | null;
  }
): LlmUsageEntry {
  const timestamp = new Date().toISOString();
  const outputText = [result.stdout, result.stderr, result.outputText].filter((value): value is string => Boolean(value)).join('\n');
  const parsed = parseAdapterUsage(outputText);
  const estimatedInputTokens = estimateTokensFromCharacters(prompt);
  const estimatedOutputTokens = estimateTokensFromCharacters(outputText || null);
  const inputTokens = parsed.inputTokens ?? estimatedInputTokens;
  const cachedInputTokens = parsed.cachedInputTokens;
  const outputTokens = parsed.outputTokens ?? estimatedOutputTokens;
  const totalTokens =
    parsed.totalTokens ??
    (inputTokens !== null && outputTokens !== null ? inputTokens + (cachedInputTokens ?? 0) + outputTokens : null);
  const estimated =
    !parsed.found ||
    parsed.inputTokens === null ||
    (parsed.outputTokens === null && outputTokens !== null) ||
    (parsed.totalTokens === null && totalTokens !== null);
  const usageSource: LlmUsageEntry['usageSource'] = !parsed.found ? 'estimated' : estimated ? 'mixed' : 'adapter';
  const baseEntry: Omit<LlmUsageEntry, 'costUsd' | 'costUnavailableReason'> = {
    id: `${timestamp}-${context.command}-${context.stage}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    issue: context.issue ?? null,
    command: context.command,
    stage: context.stage,
    repo: context.repo ?? null,
    cwd: invocation.cwd ?? null,
    adapter: adapterName(invocation),
    model: adapterModel(invocation),
    reasoningEffort: adapterReasoningEffort(invocation),
    mode: invocation.mode,
    commandDisplay: invocation.display,
    commandRunId: context.commandRunId ?? null,
    runDir: context.runDir ?? null,
    status: result.status === 0 ? 'succeeded' : 'failed',
    exitStatus: result.status,
    signal: result.signal,
    error: result.error,
    promptCharacters: prompt.length,
    outputCharacters: outputText ? outputText.length : null,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    estimated,
    usageSource,
  };
  return {
    ...baseEntry,
    ...entryCost(workspaceRoot, baseEntry),
  };
}

function readIssueLedger(workspaceRoot: string, issue: string): LlmUsageLedger {
  const paths = issueUsagePaths(workspaceRoot, issue);
  return readJson<LlmUsageLedger>(paths.ledgerPath, {
    schemaVersion: SCHEMA_VERSION,
    issue,
    updatedAt: new Date().toISOString(),
    entries: [],
  });
}

function writeIssueLedger(workspaceRoot: string, ledger: LlmUsageLedger) {
  const paths = issueUsagePaths(workspaceRoot, ledger.issue);
  const updated = { ...ledger, schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  writeJson(paths.ledgerPath, updated);
  writeFileSync(paths.summaryPath, `${formatLlmUsageSummary(summarizeIssueUsage(workspaceRoot, ledger.issue)).join('\n')}\n`);
}

function appendEntriesToIssueLedger(workspaceRoot: string, issue: string, entries: LlmUsageEntry[]) {
  if (entries.length === 0) return;
  const ledger = readIssueLedger(workspaceRoot, issue);
  const existingIds = new Set(ledger.entries.map((entry) => entry.id));
  const nextEntries = [
    ...ledger.entries,
    ...entries
      .filter((entry) => !existingIds.has(entry.id))
      .map((entry) => ({ ...entry, issue })),
  ];
  writeIssueLedger(workspaceRoot, { ...ledger, issue, entries: nextEntries });
}

function runUsagePath(runDir: string) {
  return path.join(runDir, 'usage.json');
}

function readRunUsage(runDir: string): LlmRunUsageFile {
  return readJson<LlmRunUsageFile>(runUsagePath(runDir), {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: [],
  });
}

function writeRunUsage(runDir: string, entries: LlmUsageEntry[]) {
  writeJson(runUsagePath(runDir), {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries,
  } satisfies LlmRunUsageFile);
}

export function recordLlmAdapterUsage(
  workspaceRoot: string,
  context: LlmUsageContext | undefined,
  invocation: AdapterInvocation,
  prompt: string,
  result: {
    status: number | null;
    signal: NodeJS.Signals | null;
    error: string | null;
    stdout: string | null;
    stderr: string | null;
    outputText: string | null;
  }
) {
  if (!context) return { entry: null as LlmUsageEntry | null, warning: null as string | null };
  try {
    const entry = buildEntry(workspaceRoot, context, invocation, prompt, result);
    if (context.runDir) {
      const runUsage = readRunUsage(context.runDir);
      writeRunUsage(context.runDir, [...runUsage.entries, entry]);
    }
    if (context.issue) appendEntriesToIssueLedger(workspaceRoot, context.issue, [entry]);
    return {
      entry,
      warning: context.issue || context.runDir ? null : 'LLM usage: not attached to an issue; pass --issue <owner/repo#number> to include it in lifecycle totals.',
    };
  } catch (error) {
    return { entry: null, warning: `LLM usage tracking failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function attachRunUsageToIssue(workspaceRoot: string, runDir: string | null | undefined, issue: string) {
  if (!runDir) return { attached: 0, warning: null as string | null };
  try {
    const runUsage = readRunUsage(runDir);
    const migrated = runUsage.entries.map((entry) => ({
      ...entry,
      issue,
      migratedFromRunDir: entry.migratedFromRunDir ?? runDir,
    }));
    writeRunUsage(runDir, migrated);
    appendEntriesToIssueLedger(workspaceRoot, issue, migrated);
    return { attached: migrated.length, warning: null };
  } catch (error) {
    return { attached: 0, warning: `LLM usage migration failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function usageEntriesForCommandRun(workspaceRoot: string, issue: string | null | undefined, commandRunId: string) {
  if (!issue) return [];
  return readIssueLedger(workspaceRoot, issue).entries.filter((entry) => entry.commandRunId === commandRunId);
}

export function summarizeIssueUsage(workspaceRoot: string, issue: string): LlmUsageSummary {
  const paths = issueUsagePaths(workspaceRoot, issue);
  const ledger = readIssueLedger(workspaceRoot, issue);
  const inputTokens = ledger.entries.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0);
  const cachedInputTokens = ledger.entries.reduce((sum, entry) => sum + (entry.cachedInputTokens ?? 0), 0);
  const outputTokens = ledger.entries.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0);
  const unknownOutputEntries = ledger.entries.filter((entry) => entry.outputTokens === null).length;
  const knownTotalTokens = ledger.entries.reduce((sum, entry) => {
    if (entry.totalTokens !== null) return sum + entry.totalTokens;
    return sum + (entry.inputTokens ?? 0) + (entry.cachedInputTokens ?? 0) + (entry.outputTokens ?? 0);
  }, 0);
  const costUnavailableReasons = Array.from(
    new Set(ledger.entries.map((entry) => entry.costUnavailableReason).filter((reason): reason is string => Boolean(reason)))
  );
  const costUsd =
    ledger.entries.length > 0 && costUnavailableReasons.length === 0
      ? Number(ledger.entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0).toFixed(6))
      : null;
  return {
    issue,
    ledgerPath: paths.ledgerPath,
    summaryPath: paths.summaryPath,
    entries: ledger.entries.length,
    failedEntries: ledger.entries.filter((entry) => entry.status === 'failed').length,
    estimatedEntries: ledger.entries.filter((entry) => entry.estimated).length,
    unknownOutputEntries,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    knownTotalTokens,
    totalTokensExact: unknownOutputEntries === 0 && ledger.entries.every((entry) => entry.totalTokens !== null),
    costUsd,
    costUnavailableReasons,
    models: Array.from(new Set(ledger.entries.map((entry) => entry.model).filter((model): model is string => Boolean(model)))).sort(),
  };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function estimatedLabel(summary: LlmUsageSummary) {
  return summary.estimatedEntries > 0 ? ' estimated' : '';
}

export function formatLlmUsageSummary(summary: LlmUsageSummary) {
  const outputDetail = summary.unknownOutputEntries
    ? ` (${summary.unknownOutputEntries} entr${summary.unknownOutputEntries === 1 ? 'y has' : 'ies have'} unknown output)`
    : '';
  const totalPrefix = summary.totalTokensExact ? '' : 'at least ';
  const cost =
    summary.costUsd !== null
      ? `Cost: $${summary.costUsd.toFixed(6)}`
      : `Cost: unavailable${
          summary.costUnavailableReasons.length ? `; ${summary.costUnavailableReasons.join('; ')}` : '; no usage recorded'
        }`;
  return [
    `War Room LLM usage for ${summary.issue}:`,
    `- Entries: ${formatNumber(summary.entries)}${summary.failedEntries ? ` (${summary.failedEntries} failed)` : ''}`,
    `- Input tokens: ${formatNumber(summary.inputTokens)}${estimatedLabel(summary)}`,
    summary.cachedInputTokens > 0 ? `- Cached input tokens: ${formatNumber(summary.cachedInputTokens)}${estimatedLabel(summary)}` : null,
    `- Output tokens: ${formatNumber(summary.outputTokens)}${estimatedLabel(summary)}${outputDetail}`,
    `- Total tokens: ${totalPrefix}${formatNumber(summary.knownTotalTokens)}${estimatedLabel(summary)}`,
    `- ${cost}`,
    summary.models.length ? `- Models: ${summary.models.join(', ')}` : '- Models: none recorded',
    `- Ledger: ${summary.ledgerPath}`,
  ].filter((line): line is string => line !== null);
}
