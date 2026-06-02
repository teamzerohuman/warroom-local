import { buildProgram } from '../src/cli.js';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  configureCampaignStatusField,
  createCampaignProject,
  viewCampaignProject,
  type GhRunner,
} from '../src/lib/project.js';
import { runProjectCreate, runProjectLink } from '../src/commands/project.js';
import {
  readCampaignProjectNumber,
  updateCampaignProjectInManifest,
} from '../src/lib/repos.js';

const CAMPAIGN_STATUSES = ['needs-triage', 'ready-to-engage', 'battlefield-active', 'skirmish', 'blockaded', 'victory'];

const MINIMAL_MANIFEST = `version: 1
defaults:
  owner: acme
  clone_protocol: ssh
  default_branch: main
  local_root: maps/repos
  # Campaign Map board is wired by \`warroom project create\`.
repos: []
`;

function makeWorkspace(manifest: string | null = MINIMAL_MANIFEST): string {
  const root = mkdtempSync(path.join(tmpdir(), 'warroom-project-'));
  mkdirSync(path.join(root, '.warroom'), { recursive: true });
  // isWarRoomWorkspace() requires both manifests for buildProgram to resolve the root.
  writeFileSync(path.join(root, 'resources.yaml'), 'version: 1\nresources: []\n');
  if (manifest !== null) writeFileSync(path.join(root, 'repos.yaml'), manifest);
  return root;
}

type FakeField = { id: string; name: string; type: string; options?: Array<{ id: string; name: string }> };
type FakeProject = { number: number; id: string; url: string; title: string; fields: FakeField[] };

function defaultStatusField(): FakeField {
  return {
    id: 'F_default',
    name: 'Status',
    type: 'ProjectV2SingleSelectField',
    options: ['Todo', 'In Progress', 'Done'].map((name, index) => ({ id: `d${index}`, name })),
  };
}

function statusFieldWith(options: string[]): FakeField {
  return {
    id: 'F_seed',
    name: 'Status',
    type: 'ProjectV2SingleSelectField',
    options: options.map((name, index) => ({ id: `s${index}`, name })),
  };
}

// In-memory `gh` that models the project-board subcommands the helpers call, so
// the create/configure/link logic is tested deterministically with no network.
function makeFakeGh(seed: { projects?: FakeProject[]; createNumber?: number } = {}) {
  const calls: string[][] = [];
  const projects = new Map<number, FakeProject>();
  for (const project of seed.projects ?? []) projects.set(project.number, project);
  let nextField = 1;

  const opt = (args: string[], name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const fail = (stderr: string) => ({ status: 1, stdout: '', stderr });

  const runner: GhRunner = (args) => {
    calls.push(args);
    if (args[0] === 'project' && args[1] === 'create') {
      const number = seed.createNumber ?? 5;
      const owner = opt(args, '--owner');
      const project: FakeProject = {
        number,
        id: `PVT_${number}`,
        url: `https://github.com/orgs/${owner}/projects/${number}`,
        title: opt(args, '--title') ?? '',
        fields: [defaultStatusField()],
      };
      projects.set(number, project);
      return ok({ number: project.number, id: project.id, url: project.url, title: project.title });
    }
    if (args[0] === 'project' && args[1] === 'view') {
      const project = projects.get(Number(args[2]));
      if (!project) return fail('Could not resolve to a Project');
      return ok({ number: project.number, id: project.id, url: project.url, title: project.title });
    }
    if (args[0] === 'project' && args[1] === 'field-list') {
      const project = projects.get(Number(args[2]));
      return ok({ fields: project ? project.fields : [] });
    }
    if (args[0] === 'project' && args[1] === 'field-delete') {
      const id = opt(args, '--id');
      for (const project of projects.values()) project.fields = project.fields.filter((field) => field.id !== id);
      return ok({ id });
    }
    if (args[0] === 'project' && args[1] === 'field-create') {
      const project = projects.get(Number(args[2]));
      const names = (opt(args, '--single-select-options') ?? '').split(',').filter(Boolean);
      const field: FakeField = {
        id: `F_${nextField++}`,
        name: opt(args, '--name') ?? '',
        type: 'ProjectV2SingleSelectField',
        options: names.map((name, index) => ({ id: `o${index}`, name })),
      };
      project?.fields.push(field);
      return ok({ id: field.id, name: field.name });
    }
    return fail(`unexpected gh call: ${args.join(' ')}`);
  };

  return { runner, calls, projects };
}

describe('project board lib', () => {
  it('creates a campaign project and parses the result', () => {
    const gh = makeFakeGh({ createNumber: 12 });
    const project = createCampaignProject('acme', 'Campaign Map', gh.runner);
    expect(project).toEqual({
      number: 12,
      id: 'PVT_12',
      url: 'https://github.com/orgs/acme/projects/12',
      title: 'Campaign Map',
    });
  });

  it('replaces a default Status field with the six campaign states', () => {
    const gh = makeFakeGh({
      projects: [{ number: 5, id: 'PVT_5', url: 'u', title: 'Campaign Map', fields: [defaultStatusField()] }],
    });
    const result = configureCampaignStatusField('acme', 5, gh.runner);
    expect(result.replaced).toBe(true);
    expect(result.created).toBe(false);
    // A delete then a create were issued.
    expect(gh.calls.some((c) => c[1] === 'field-delete')).toBe(true);
    const create = gh.calls.find((c) => c[1] === 'field-create');
    expect(create).toBeDefined();
    expect(create).toContain(CAMPAIGN_STATUSES.join(','));
    // The board now carries exactly the six states.
    const options = gh.projects.get(5)?.fields.find((f) => f.name === 'Status')?.options?.map((o) => o.name);
    expect(options).toEqual(CAMPAIGN_STATUSES);
  });

  it('is idempotent when the Status field already matches', () => {
    const gh = makeFakeGh({
      projects: [{ number: 5, id: 'PVT_5', url: 'u', title: 't', fields: [statusFieldWith(CAMPAIGN_STATUSES)] }],
    });
    const result = configureCampaignStatusField('acme', 5, gh.runner);
    expect(result).toMatchObject({ created: false, replaced: false });
    expect(gh.calls.some((c) => c[1] === 'field-delete' || c[1] === 'field-create')).toBe(false);
  });

  it('creates a Status field when none exists', () => {
    const gh = makeFakeGh({ projects: [{ number: 5, id: 'PVT_5', url: 'u', title: 't', fields: [] }] });
    const result = configureCampaignStatusField('acme', 5, gh.runner);
    expect(result).toMatchObject({ created: true, replaced: false });
    expect(gh.calls.some((c) => c[1] === 'field-delete')).toBe(false);
    expect(gh.calls.some((c) => c[1] === 'field-create')).toBe(true);
  });

  it('returns null when viewing a missing project', () => {
    const gh = makeFakeGh();
    expect(viewCampaignProject('acme', 99, gh.runner)).toBeNull();
  });
});

describe('campaign project manifest wiring', () => {
  it('writes campaign owner + number while preserving comments', () => {
    const root = makeWorkspace();
    updateCampaignProjectInManifest(root, 'acme', 7);
    const text = readFileSync(path.join(root, 'repos.yaml'), 'utf8');
    expect(text).toContain('campaign_owner: acme');
    expect(text).toContain('campaign_project_number: 7');
    // Original comment is preserved.
    expect(text).toContain('Campaign Map board is wired');
    expect(readCampaignProjectNumber(root)).toBe(7);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads null when no campaign_project_number is set', () => {
    const root = makeWorkspace();
    expect(readCampaignProjectNumber(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('throws when repos.yaml is missing', () => {
    const root = makeWorkspace(null);
    expect(() => updateCampaignProjectInManifest(root, 'acme', 1)).toThrow(/repos.yaml not found/);
    expect(readCampaignProjectNumber(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('runProjectCreate', () => {
  it('plans without confirm and makes no gh calls', () => {
    const root = makeWorkspace();
    const gh = makeFakeGh();
    const result = runProjectCreate(root, { title: 'Campaign Map', runner: gh.runner });
    expect(result.applied).toBe(false);
    expect(result.manifestUpdated).toBe(false);
    expect(result.owner).toBe('acme');
    expect(gh.calls).toHaveLength(0);
    expect(result.messages.some((m) => m.includes('Re-run with --confirm'))).toBe(true);
    expect(readCampaignProjectNumber(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the board, configures Status, and wires repos.yaml on confirm', () => {
    const root = makeWorkspace();
    const gh = makeFakeGh({ createNumber: 8 });
    const result = runProjectCreate(root, { title: 'Campaign Map', confirm: true, runner: gh.runner });
    expect(result.applied).toBe(true);
    expect(result.project?.number).toBe(8);
    expect(result.statusField?.replaced).toBe(true);
    expect(result.manifestUpdated).toBe(true);
    expect(readCampaignProjectNumber(root)).toBe(8);
    rmSync(root, { recursive: true, force: true });
  });

  it('errors when no owner can be resolved and no repos.yaml exists', () => {
    const root = makeWorkspace(null);
    const gh = makeFakeGh();
    const result = runProjectCreate(root, { title: 'Campaign Map', confirm: true, runner: gh.runner });
    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/campaign owner|repos.yaml/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('runProjectLink', () => {
  it('links an existing board and ensures the Status field on confirm', () => {
    const root = makeWorkspace();
    const gh = makeFakeGh({
      projects: [{ number: 9, id: 'PVT_9', url: 'https://example/9', title: 'Existing', fields: [defaultStatusField()] }],
    });
    const result = runProjectLink(root, { projectNumber: 9, confirm: true, runner: gh.runner });
    expect(result.applied).toBe(true);
    expect(result.project?.number).toBe(9);
    expect(result.statusField?.replaced).toBe(true);
    expect(readCampaignProjectNumber(root)).toBe(9);
    rmSync(root, { recursive: true, force: true });
  });

  it('skips Status reconciliation when ensureStatus is false', () => {
    const root = makeWorkspace();
    const gh = makeFakeGh({
      projects: [{ number: 9, id: 'PVT_9', url: 'u', title: 'Existing', fields: [defaultStatusField()] }],
    });
    const result = runProjectLink(root, { projectNumber: 9, confirm: true, ensureStatus: false, runner: gh.runner });
    expect(result.applied).toBe(true);
    expect(result.statusField).toBeNull();
    expect(gh.calls.some((c) => c[1] === 'field-create' || c[1] === 'field-list')).toBe(false);
    expect(readCampaignProjectNumber(root)).toBe(9);
    rmSync(root, { recursive: true, force: true });
  });

  it('errors when the project does not exist', () => {
    const root = makeWorkspace();
    const gh = makeFakeGh();
    const result = runProjectLink(root, { projectNumber: 404, confirm: true, runner: gh.runner });
    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/Could not find/);
    expect(readCampaignProjectNumber(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

// --- CLI integration: a real PATH-fake `gh` driving buildProgram -------------

function writeProjectGhFixture(bin: string, seed?: { projects?: FakeProject[] }) {
  if (seed) {
    const projects: Record<string, FakeProject> = {};
    for (const project of seed.projects ?? []) projects[String(project.number)] = project;
    writeFileSync(path.join(bin, 'project-state.json'), JSON.stringify({ projects, nextField: 1 }));
  }
  const ghPath = path.join(bin, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const stateFile = path.join(path.dirname(process.argv[1]), 'project-state.json');
function readState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return { projects: {}, nextField: 1 }; } }
function writeState(s) { fs.writeFileSync(stateFile, JSON.stringify(s)); }
function opt(name) { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; }
function out(o) { process.stdout.write(JSON.stringify(o)); }
function defaultStatus() { return { id: 'F_default', name: 'Status', type: 'ProjectV2SingleSelectField', options: [{ id: 'd0', name: 'Todo' }, { id: 'd1', name: 'In Progress' }, { id: 'd2', name: 'Done' }] }; }
const state = readState();
if (args[0] === 'project' && args[1] === 'create') {
  const number = 5;
  const owner = opt('--owner');
  const p = { number: number, id: 'PVT_' + number, url: 'https://github.com/orgs/' + owner + '/projects/' + number, title: opt('--title') || '', fields: [defaultStatus()] };
  state.projects[String(number)] = p; writeState(state);
  out({ number: p.number, id: p.id, url: p.url, title: p.title }); process.exit(0);
}
if (args[0] === 'project' && args[1] === 'view') {
  const p = state.projects[String(Number(args[2]))];
  if (!p) { process.stderr.write('not found'); process.exit(1); }
  out({ number: p.number, id: p.id, url: p.url, title: p.title }); process.exit(0);
}
if (args[0] === 'project' && args[1] === 'field-list') {
  const p = state.projects[String(Number(args[2]))];
  out({ fields: p ? p.fields : [] }); process.exit(0);
}
if (args[0] === 'project' && args[1] === 'field-delete') {
  const id = opt('--id');
  for (const key of Object.keys(state.projects)) { state.projects[key].fields = state.projects[key].fields.filter(function (f) { return f.id !== id; }); }
  writeState(state); out({ id: id }); process.exit(0);
}
if (args[0] === 'project' && args[1] === 'field-create') {
  const p = state.projects[String(Number(args[2]))];
  const raw = opt('--single-select-options') || '';
  const names = raw.split(',').filter(Boolean);
  const fid = 'F_' + (state.nextField || 1); state.nextField = (state.nextField || 1) + 1;
  const field = { id: fid, name: opt('--name'), type: 'ProjectV2SingleSelectField', options: names.map(function (n, i) { return { id: 'o' + i, name: n }; }) };
  if (p) p.fields.push(field);
  writeState(state); out({ id: field.id, name: field.name }); process.exit(0);
}
process.stderr.write('unexpected gh call: ' + args.join(' '));
process.exit(1);
`
  );
  chmodSync(ghPath, 0o755);
}

describe('warroom project CLI', () => {
  it('plans project create non-interactively with --json (no gh needed)', async () => {
    const root = makeWorkspace();
    const lines: string[] = [];
    const program = buildProgram({ cwd: root, output: (line) => lines.push(line), interactive: false });
    await program.parseAsync(['node', 'warroom', 'project', 'create', '--owner', 'acme', '--title', 'Campaign Map', '--json']);
    const payload = JSON.parse(lines.join('\n')) as { applied: boolean; manifestUpdated: boolean };
    expect(payload.applied).toBe(false);
    expect(payload.manifestUpdated).toBe(false);
    expect(readCampaignProjectNumber(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a board end-to-end via the interactive menu', async () => {
    const root = makeWorkspace();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeProjectGhFixture(bin);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });
      const answers = ['create\n', 'Campaign Map\n'];
      const timer = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(timer);
      }, 50);
      try {
        await program.parseAsync(['node', 'warroom', 'project', 'create']);
      } finally {
        clearInterval(timer);
        input.end();
      }
      expect(lines.some((l) => l.startsWith('Campaign Map project create: applied'))).toBe(true);
      expect(lines.some((l) => l.includes('Created Project #5'))).toBe(true);
      expect(readCampaignProjectNumber(root)).toBe(5);
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('links an existing board through the interactive menu', async () => {
    const root = makeWorkspace();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeProjectGhFixture(bin, {
      projects: [{ number: 3, id: 'PVT_3', url: 'https://example/3', title: 'Existing', fields: [statusFieldWith(CAMPAIGN_STATUSES)] }],
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    try {
      const lines: string[] = [];
      const input = new PassThrough();
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });
      const answers = ['existing\n', '3\n'];
      const timer = setInterval(() => {
        const answer = answers.shift();
        if (answer) input.write(answer);
        else clearInterval(timer);
      }, 50);
      try {
        await program.parseAsync(['node', 'warroom', 'project', 'create']);
      } finally {
        clearInterval(timer);
        input.end();
      }
      expect(lines.some((l) => l.startsWith('Campaign Map project link: applied'))).toBe(true);
      expect(lines.some((l) => l.includes('Status field already carried'))).toBe(true);
      expect(readCampaignProjectNumber(root)).toBe(3);
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
