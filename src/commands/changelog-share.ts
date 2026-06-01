import * as https from 'node:https';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { absolutePath, loadRepoManifest } from '../lib/repos.js';
import { loadAlliesManifest } from '../lib/allies.js';
import { runAdapter, runInteractiveAdapter } from '../lib/env.js';

export type ChangelogPeriod = 'day' | 'week' | 'month';

export type ChangelogEntry = {
  title: string;
  publishedAt: Date;
  repoName: string;
  entryUrl: string;
};

export type ChangelogShareContent = {
  title: string;
  intro: string;
  signoff: string;
};

export type AllyCommsEntry = {
  allyId: string;
  allyName: string;
  type: 'slack';
  channels: string[];
};

export type SlackPostResult = {
  channel: string;
  ok: boolean;
  error: string | null;
  ts: string | null;
};

export type ChangelogShareResult = {
  period: ChangelogPeriod;
  periodLabel: string;
  entries: ChangelogEntry[];
  cutoff: Date;
  cutoffSource: 'last-sent' | 'period-default';
  content: ChangelogShareContent | null;
  blocks: object[] | null;
  fallbackText: string | null;
  alliesWithComms: AllyCommsEntry[];
  error: string | null;
  adapterError: string | null;
  adapterCommand: string | null;
};

const PERIOD_DAYS: Record<ChangelogPeriod, number> = { day: 1, week: 7, month: 30 };
export const PERIOD_LABEL: Record<ChangelogPeriod, string> = {
  day: 'Daily Update',
  week: 'Weekly Update',
  month: 'Monthly Update',
};

function periodCutoff(period: ChangelogPeriod): Date {
  return new Date(Date.now() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000);
}

export type ChangelogShareState = {
  lastSent?: Partial<Record<ChangelogPeriod, string>>;
};

function stateFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.warroom', 'changelog-share-state.json');
}

export function loadChangelogShareState(workspaceRoot: string): ChangelogShareState {
  const file = stateFilePath(workspaceRoot);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ChangelogShareState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function recordChangelogShareSent(workspaceRoot: string, period: ChangelogPeriod, when: Date = new Date()): void {
  const dir = path.join(workspaceRoot, '.warroom');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = loadChangelogShareState(workspaceRoot);
  const lastSent = { ...(current.lastSent ?? {}), [period]: when.toISOString() };
  writeFileSync(stateFilePath(workspaceRoot), JSON.stringify({ ...current, lastSent }, null, 2));
}

function resolveCutoff(workspaceRoot: string, period: ChangelogPeriod): { cutoff: Date; source: 'last-sent' | 'period-default' } {
  const state = loadChangelogShareState(workspaceRoot);
  const lastSentRaw = state.lastSent?.[period];
  if (lastSentRaw) {
    const parsed = new Date(lastSentRaw);
    if (!isNaN(parsed.getTime())) return { cutoff: parsed, source: 'last-sent' };
  }
  return { cutoff: periodCutoff(period), source: 'period-default' };
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    return (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function openChangelogEntryUrl(baseUrl: string, publishedAt: Date): string {
  return `${baseUrl}/release/${Math.floor(publishedAt.getTime() / 1000)}`;
}

function loadChangelogEntries(workspaceRoot: string, _period: ChangelogPeriod, cutoff: Date): ChangelogEntry[] {
  const manifest = loadRepoManifest(workspaceRoot);
  const entries: ChangelogEntry[] = [];

  for (const repo of manifest.repos) {
    const cl = repo.merge.changelog;
    if (!cl.enabled || cl.format !== 'openchangelog' || !cl.path || !cl.url) continue;

    const releaseNotesDir = absolutePath(workspaceRoot, path.join(repo.local_path, cl.path));
    if (!existsSync(releaseNotesDir)) continue;

    let files: string[];
    try {
      files = readdirSync(releaseNotesDir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const raw = readFileSync(path.join(releaseNotesDir, file), 'utf8');
        const data = parseFrontmatter(raw);
        const title = typeof data.title === 'string' ? data.title : file.replace(/\.md$/, '');
        const publishedAtRaw = typeof data.publishedAt === 'string' ? data.publishedAt : null;
        if (!publishedAtRaw) continue;
        const publishedAt = new Date(publishedAtRaw);
        if (isNaN(publishedAt.getTime()) || publishedAt < cutoff) continue;
        entries.push({ title, publishedAt, repoName: repo.name, entryUrl: openChangelogEntryUrl(cl.url, publishedAt) });
      } catch {
        continue;
      }
    }
  }

  return entries.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

function loadAlliesWithComms(workspaceRoot: string): AllyCommsEntry[] {
  try {
    const manifest = loadAlliesManifest(workspaceRoot);
    const result: AllyCommsEntry[] = [];
    for (const ally of manifest.allies) {
      if (!ally.comms) continue;
      for (const entry of ally.comms) {
        if (entry.type === 'slack') {
          result.push({ allyId: ally.id, allyName: ally.name, type: 'slack', channels: entry.channels });
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

function stripJsonFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

function generateContent(
  workspaceRoot: string,
  entries: ChangelogEntry[],
  periodLabel: string,
  feedback?: { request: string; previous: ChangelogShareContent }
): { content: ChangelogShareContent | null; adapterError: string | null; adapterCommand: string | null } {
  const entryList = entries
    .map((e) => `- ${e.repoName}: "${e.title}" (${e.publishedAt.toDateString()})`)
    .join('\n');

  const revisionBlock = feedback
    ? [
        '',
        'The user reviewed the previous version and requested changes.',
        '',
        'Previous version:',
        `Title: ${feedback.previous.title}`,
        `Intro: ${feedback.previous.intro}`,
        `Signoff: ${feedback.previous.signoff}`,
        '',
        `Requested changes: "${feedback.request}"`,
        '',
        'Generate a revised version that incorporates the requested changes.',
      ].join('\n')
    : '';

  const prompt = [
    'Respond with valid JSON only — no markdown fences, no preamble, no explanation.',
    '',
    feedback ? 'Revise this Slack changelog message based on user feedback.' : 'Generate Slack message copy for a changelog distribution.',
    '',
    `Period: ${periodLabel}`,
    'Changelog entries:',
    entryList,
    revisionBlock,
    '',
    'Return exactly this JSON shape:',
    '{"title":"...","intro":"...","signoff":"..."}',
    '',
    'Rules:',
    `- title: max 8 words, no period at the end, ideally including the name of a notable changes.`,
    '- intro: 2-3 sentences summarising the changes, written for a non-technical product audience',
    '- signoff: 1-2 natural-sounding sentences that close the message without sounding automated; vary the phrasing each run',
  ].join('\n');

  const outputDir = mkdtempSync(path.join(tmpdir(), 'warroom-changelog-share-'));
  const outputPath = path.join(outputDir, 'last-message.txt');
  try {
    const launch = runAdapter(workspaceRoot, prompt, {
      captureStdout: true,
      outputLastMessagePath: outputPath,
    });
    const adapterCommand = launch.invocation.display;
    if (!launch.launched) {
      return { content: null, adapterError: launch.error ?? 'LLM adapter failed.', adapterCommand };
    }
    const raw = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : (launch.stdout?.trim() ?? '');
    try {
      const parsed = JSON.parse(stripJsonFences(raw)) as Record<string, unknown>;
      return {
        content: {
          title: typeof parsed.title === 'string' ? parsed.title : '',
          intro: typeof parsed.intro === 'string' ? parsed.intro : '',
          signoff: typeof parsed.signoff === 'string' ? parsed.signoff : '',
        },
        adapterError: null,
        adapterCommand,
      };
    } catch {
      return {
        content: null,
        adapterError: `Could not parse LLM response as JSON. Raw output: ${raw.slice(0, 300)}`,
        adapterCommand,
      };
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function repoLabel(name: string): string {
  return name.length <= 3 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1);
}

export function buildSlackBlocks(content: ChangelogShareContent, entries: ChangelogEntry[], periodLabel: string): object[] {
  const bulletList = entries.map((e) => `• \`${repoLabel(e.repoName)}\` <${e.entryUrl}|${e.title}>`).join('\n');
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${content.title}`, emoji: false },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: content.intro },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: bulletList },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: content.signoff },
    },
  ];
}

export type ChangelogRevision = {
  content: ChangelogShareContent | null;
  blocks: object[] | null;
  fallbackText: string | null;
  adapterError: string | null;
  adapterCommand: string | null;
};

export function reviseChangelogContent(
  workspaceRoot: string,
  result: ChangelogShareResult,
  feedbackRequest: string
): ChangelogRevision {
  const { content, adapterError, adapterCommand } = generateContent(
    workspaceRoot,
    result.entries,
    result.periodLabel,
    result.content ? { request: feedbackRequest, previous: result.content } : undefined
  );
  const blocks = content ? buildSlackBlocks(content, result.entries, result.periodLabel) : null;
  const fallbackText = content ? `${content.title}` : null;
  return { content, blocks, fallbackText, adapterError, adapterCommand };
}

export type InteractiveEditNotesResult = {
  notes: string | null;
  launched: boolean;
  adapterError: string | null;
};

export function captureInteractiveEditNotes(
  workspaceRoot: string,
  result: ChangelogShareResult
): InteractiveEditNotesResult {
  const dir = path.join(workspaceRoot, '.warroom');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const notesFilename = path.join('.warroom', 'changelog-share-edit-notes.txt');
  const notesPath = path.join(workspaceRoot, notesFilename);
  if (existsSync(notesPath)) {
    try { unlinkSync(notesPath); } catch { /* ignore */ }
  }

  const current = result.content;
  const entryList = result.entries
    .map((e) => `- ${e.repoName}: "${e.title}" (${e.publishedAt.toDateString()})`)
    .join('\n');

  const prompt = [
    'You are an interactive editor helping a teammate revise a Slack changelog message before it ships to ally channels.',
    '',
    `Reporting period: ${result.periodLabel}`,
    '',
    'Current Slack message draft:',
    `- Title: ${current?.title ?? '(empty)'}`,
    `- Intro: ${current?.intro ?? '(empty)'}`,
    `- Signoff: ${current?.signoff ?? '(empty)'}`,
    '',
    'Underlying changelog entries the message describes:',
    entryList,
    '',
    'How to run the session:',
    '- Talk with the user. Ask short clarifying questions about what they want to change.',
    '- Offer concrete suggestions for the title, intro, or signoff when useful.',
    '- Iterate. Do not produce the final Slack copy yourself — your job is to capture clear revision notes.',
    '- When the user signals they are done (e.g. "we are good", "looks right", "exit"), stop the discussion.',
    '',
    `Before you end the session, write the final consolidated revision notes to: ${notesFilename}`,
    'The notes should:',
    '- Be plain prose (not JSON), 1-6 sentences.',
    '- Describe exactly which changes to make to the title, intro, and signoff.',
    '- Reflect the user\'s final intent — not the back-and-forth dialogue.',
    '',
    'If the user changes their mind and wants no edits at all, write an empty file at that path so the caller can detect "no changes".',
    'After writing the file, end the session.',
  ].join('\n');

  const launch = runInteractiveAdapter(workspaceRoot, prompt, { cwd: workspaceRoot });
  if (!launch.launched) {
    return { notes: null, launched: false, adapterError: launch.error ?? 'Interactive adapter failed to launch.' };
  }

  if (!existsSync(notesPath)) {
    return {
      notes: null,
      launched: true,
      adapterError: `Interactive editor ended without writing notes to ${notesFilename}.`,
    };
  }

  const raw = readFileSync(notesPath, 'utf8').trim();
  try { unlinkSync(notesPath); } catch { /* ignore */ }
  return { notes: raw.length > 0 ? raw : null, launched: true, adapterError: null };
}

export function postToSlack(
  token: string,
  channel: string,
  blocks: object[],
  fallbackText: string
): Promise<SlackPostResult> {
  const body = JSON.stringify({ channel, text: fallbackText, blocks, unfurl_links: false, unfurl_media: false });
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'slack.com',
        path: '/api/chat.postMessage',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { ok: boolean; error?: string; ts?: string };
            resolve({ channel, ok: parsed.ok, error: parsed.error ?? null, ts: parsed.ts ?? null });
          } catch {
            resolve({ channel, ok: false, error: 'Failed to parse Slack API response', ts: null });
          }
        });
      }
    );
    req.on('error', (err: Error) => resolve({ channel, ok: false, error: err.message, ts: null }));
    req.write(body);
    req.end();
  });
}

export type ChangelogDraft = {
  period: ChangelogPeriod;
  periodLabel: string;
  entries: Array<{ title: string; publishedAt: string; repoName: string; entryUrl: string }>;
  content: ChangelogShareContent;
  cutoff?: string;
  cutoffSource?: 'last-sent' | 'period-default';
  createdAt: string;
  updatedAt: string;
};

function draftFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.warroom', 'changelog-share-draft.json');
}

export function loadChangelogDraft(workspaceRoot: string): ChangelogDraft | null {
  const file = draftFilePath(workspaceRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ChangelogDraft;
    if (!parsed.period || !parsed.content || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveChangelogDraft(
  workspaceRoot: string,
  period: ChangelogPeriod,
  periodLabel: string,
  entries: ChangelogEntry[],
  content: ChangelogShareContent,
  meta: { cutoff: Date; cutoffSource: 'last-sent' | 'period-default' },
  existing?: ChangelogDraft | null
): void {
  const dir = path.join(workspaceRoot, '.warroom');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const draft: ChangelogDraft = {
    period,
    periodLabel,
    entries: entries.map((e) => ({
      title: e.title,
      publishedAt: e.publishedAt.toISOString(),
      repoName: e.repoName,
      entryUrl: e.entryUrl,
    })),
    content,
    cutoff: meta.cutoff.toISOString(),
    cutoffSource: meta.cutoffSource,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeFileSync(draftFilePath(workspaceRoot), JSON.stringify(draft, null, 2));
}

export function clearChangelogDraft(workspaceRoot: string): void {
  const file = draftFilePath(workspaceRoot);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {
    // ignore
  }
}

export function resumeChangelogShare(workspaceRoot: string, draft: ChangelogDraft): ChangelogShareResult {
  const entries: ChangelogEntry[] = draft.entries.map((e) => ({
    title: e.title,
    publishedAt: new Date(e.publishedAt),
    repoName: e.repoName,
    entryUrl: e.entryUrl,
  }));
  const alliesWithComms = loadAlliesWithComms(workspaceRoot);
  const blocks = buildSlackBlocks(draft.content, entries, draft.periodLabel);
  const fallbackText = draft.content.title;
  const cutoff = draft.cutoff ? new Date(draft.cutoff) : periodCutoff(draft.period);
  const cutoffSource: 'last-sent' | 'period-default' = draft.cutoffSource ?? 'period-default';
  return {
    period: draft.period,
    periodLabel: draft.periodLabel,
    entries,
    cutoff,
    cutoffSource,
    content: draft.content,
    blocks,
    fallbackText,
    alliesWithComms,
    error: null,
    adapterError: null,
    adapterCommand: null,
  };
}

export function runChangelogShare(workspaceRoot: string, period: ChangelogPeriod): ChangelogShareResult {
  const periodLabel = PERIOD_LABEL[period];
  const { cutoff, source: cutoffSource } = resolveCutoff(workspaceRoot, period);
  const entries = loadChangelogEntries(workspaceRoot, period, cutoff);
  const alliesWithComms = loadAlliesWithComms(workspaceRoot);

  if (entries.length === 0) {
    const cutoffLabel = cutoffSource === 'last-sent' ? `since the last send (${cutoff.toISOString()})` : `in the last ${PERIOD_DAYS[period]} day${PERIOD_DAYS[period] === 1 ? '' : 's'}`;
    return {
      period,
      periodLabel,
      entries: [],
      cutoff,
      cutoffSource,
      content: null,
      blocks: null,
      fallbackText: null,
      alliesWithComms,
      error: `No changelog entries found ${cutoffLabel}.`,
      adapterError: null,
      adapterCommand: null,
    };
  }

  const { content, adapterError, adapterCommand } = generateContent(workspaceRoot, entries, periodLabel);
  const blocks = content ? buildSlackBlocks(content, entries, periodLabel) : null;
  const fallbackText = content ? content.title : null;

  return {
    period,
    periodLabel,
    entries,
    cutoff,
    cutoffSource,
    content,
    blocks,
    fallbackText,
    alliesWithComms,
    error: null,
    adapterError,
    adapterCommand,
  };
}
