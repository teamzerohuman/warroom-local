import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { llmUsageTaskTitle, recordLlmAdapterUsage, type LlmUsageContext } from './llm-usage.js';

export type EnvStatus = {
  exampleExists: boolean;
  examplePath: string;
  localExists: boolean;
  adapter: string | null;
  adapterSupported: boolean;
  notes: string[];
};

export type AdapterInvocation = {
  command: string;
  args: string[];
  display: string;
  cwd: string;
  mode: 'foreground' | 'interactive';
  adapter: 'codex' | 'claude';
};

export type AdapterReportedUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  model: string | null;
  sessionId: string | null;
};

export type AdapterRunResult = {
  launched: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  stdout: string | null;
  stderr: string | null;
  invocation: AdapterInvocation;
};

export type AdapterRunOptions = {
  cwd?: string;
  outputLastMessagePath?: string;
  captureStdout?: boolean;
  usage?: LlmUsageContext;
};

const PROMPT_VISIBLE_ENV_KEYS = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG'] as const;

function parseEnv(raw: string) {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim().replace(/^export\s+/, '');
    values.set(key, parseEnvValue(trimmed.slice(separator + 1)));
  }
  return values;
}

function parseEnvValue(raw: string) {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    if (quote === '"') return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return inner.replace(/\\'/g, "'");
  }
  return value;
}

function readEnvMap(filePath: string) {
  return existsSync(filePath) ? parseEnv(readFileSync(filePath, 'utf8')) : new Map<string, string>();
}

function localProcessEnv(workspaceRoot: string) {
  const localPath = path.join(workspaceRoot, '.env.local');
  return Object.fromEntries(readEnvMap(localPath));
}

function adapterRuntimePromptNote(workspaceRoot: string) {
  const envValues = localProcessEnv(workspaceRoot);
  const availableKeys = PROMPT_VISIBLE_ENV_KEYS.filter((key) => Boolean(envValues[key]));
  if (availableKeys.length === 0) return null;

  const envPath = path.relative(workspaceRoot, path.join(workspaceRoot, '.env.local')) || '.env.local';
  const lines = [
    'War Room runtime environment:',
    `- The adapter process has variables from workspace \`${envPath}\` exported into its environment.`,
    `- Available integration env vars: ${availableKeys.map((key) => `\`${key}\``).join(', ')}.`,
    '- Use these env vars directly when a matching MCP/plugin/script needs credentials. Do not print, paste, write, or commit their values.',
  ];
  if (availableKeys.includes('SENTRY_AUTH_TOKEN')) {
    lines.push('- If the task references Sentry, use the available Sentry env vars for Sentry MCP/read-only inspection and GitHub-to-Sentry linking.');
  }
  return lines.join('\n');
}

function adapterTaskPromptHeader(context: LlmUsageContext | undefined) {
  if (!context) return null;
  const title = llmUsageTaskTitle(context);
  return [
    title,
    '',
    'War Room task metadata:',
    `- Task title: \`${title}\`.`,
    context.issue ? `- Linked issue: \`${context.issue}\`.` : '- Linked issue: pending or not yet known.',
    context.repo ? `- Repo: \`${context.repo}\`.` : null,
    context.commandRunId ? `- Command run id: \`${context.commandRunId}\`.` : null,
    '- Keep this task title visible in session history, logs, and any audit trail.',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function promptWithAdapterRuntimeNote(workspaceRoot: string, prompt: string, context: LlmUsageContext | undefined) {
  const header = adapterTaskPromptHeader(context);
  const note = adapterRuntimePromptNote(workspaceRoot);
  return [header, prompt, note].filter((section): section is string => Boolean(section)).join('\n\n');
}

function codexModelArgs(local: Map<string, string>, example: Map<string, string>, prefix = 'CODEX') {
  const model = local.get(`${prefix}_MODEL`) ?? example.get(`${prefix}_MODEL`) ?? local.get('CODEX_MODEL') ?? example.get('CODEX_MODEL') ?? 'gpt-5.5';
  const reasoningEffort =
    local.get(`${prefix}_REASONING_EFFORT`) ?? example.get(`${prefix}_REASONING_EFFORT`) ?? local.get('CODEX_REASONING_EFFORT') ?? example.get('CODEX_REASONING_EFFORT') ?? 'xhigh';
  const fastMode = local.get(`${prefix}_FAST_MODE`) ?? example.get(`${prefix}_FAST_MODE`) ?? local.get('CODEX_FAST_MODE') ?? example.get('CODEX_FAST_MODE') ?? 'false';
  return [
    '--model',
    model,
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`,
    ...(fastMode === 'true' ? [] : ['--disable', 'fast_mode']),
  ];
}

function claudeEnvValue(
  local: Map<string, string>,
  example: Map<string, string>,
  key: string,
  fallback: string
) {
  return local.get(key) ?? example.get(key) ?? fallback;
}

function claudeModel(local: Map<string, string>, example: Map<string, string>) {
  return claudeEnvValue(local, example, 'CLAUDE_MODEL', 'claude-sonnet-4-6');
}

function claudePermissionMode(
  local: Map<string, string>,
  example: Map<string, string>,
  key: 'CLAUDE_PERMISSION_MODE' | 'CLAUDE_INTERACTIVE_PERMISSION_MODE'
) {
  return claudeEnvValue(local, example, key, 'acceptEdits');
}

export function readWorkspaceEnvVar(workspaceRoot: string, key: string): string | null {
  const localPath = path.join(workspaceRoot, '.env.local');
  return readEnvMap(localPath).get(key) ?? null;
}

export function getEnvStatus(workspaceRoot: string): EnvStatus {
  const examplePath = path.join(workspaceRoot, '.env.local.example');
  const localPath = path.join(workspaceRoot, '.env.local');
  const exampleExists = existsSync(examplePath);
  const localExists = existsSync(localPath);
  const notes: string[] = [];
  const example = readEnvMap(examplePath);
  const local = readEnvMap(localPath);
  const adapter = local.get('LLM_ADAPTER') ?? example.get('LLM_ADAPTER') ?? null;
  const adapterSupported = adapter === 'codex' || adapter === 'codex-cloud' || adapter === 'claude';

  if (!localExists) notes.push('.env.local is optional but needed before launching LLM adapters.');
  if (!adapterSupported) notes.push('LLM_ADAPTER should be codex or claude. Legacy codex-cloud is treated as codex.');
  if (adapter === 'codex-cloud') {
    notes.push('LLM_ADAPTER=codex-cloud is deprecated; War Room will run codex locally with codex exec. Set LLM_ADAPTER=codex to remove this note.');
  }

  return {
    exampleExists,
    examplePath,
    localExists,
    adapter,
    adapterSupported,
    notes,
  };
}

export function getAdapterCommand(workspaceRoot: string) {
  return getAdapterInvocation(workspaceRoot, workspaceRoot).display;
}

export function getAdapterInvocation(workspaceRoot: string, cwd = workspaceRoot): AdapterInvocation {
  const examplePath = path.join(workspaceRoot, '.env.local.example');
  const localPath = path.join(workspaceRoot, '.env.local');
  const example = readEnvMap(examplePath);
  const local = readEnvMap(localPath);
  const adapter = local.get('LLM_ADAPTER') ?? example.get('LLM_ADAPTER') ?? 'codex';
  if (adapter === 'claude') {
    const command = local.get('CLAUDE_COMMAND') ?? example.get('CLAUDE_COMMAND') ?? 'claude';
    const model = claudeModel(local, example);
    const permissionMode = claudePermissionMode(local, example, 'CLAUDE_PERMISSION_MODE');
    const args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      model,
      '--permission-mode',
      permissionMode,
    ];
    return {
      command,
      args,
      display: [command, ...args].join(' '),
      cwd,
      mode: 'foreground',
      adapter: 'claude',
    };
  }

  const command = local.get('CODEX_COMMAND') ?? example.get('CODEX_COMMAND') ?? 'codex';
  const modelArgs = codexModelArgs(local, example);
  const args = ['exec', ...modelArgs, '--cd', cwd, '-'];
  return { command, args, display: [command, ...args].join(' '), cwd, mode: 'foreground', adapter: 'codex' };
}

export function getInteractiveAdapterInvocation(workspaceRoot: string, cwd = workspaceRoot, prompt = '<prompt>'): AdapterInvocation {
  const examplePath = path.join(workspaceRoot, '.env.local.example');
  const localPath = path.join(workspaceRoot, '.env.local');
  const example = readEnvMap(examplePath);
  const local = readEnvMap(localPath);
  const adapter = local.get('LLM_ADAPTER') ?? example.get('LLM_ADAPTER') ?? 'codex';
  if (adapter === 'claude') {
    const command = local.get('CLAUDE_COMMAND') ?? example.get('CLAUDE_COMMAND') ?? 'claude';
    const model = claudeModel(local, example);
    const permissionMode = claudePermissionMode(local, example, 'CLAUDE_INTERACTIVE_PERMISSION_MODE');
    const args = ['--model', model, '--permission-mode', permissionMode, prompt];
    return {
      command,
      args,
      display: [command, '--model', model, '--permission-mode', permissionMode, '<prompt>'].join(' '),
      cwd,
      mode: 'interactive',
      adapter: 'claude',
    };
  }

  const command = local.get('CODEX_COMMAND') ?? example.get('CODEX_COMMAND') ?? 'codex';
  const sandbox = local.get('CODEX_INTERACTIVE_SANDBOX') ?? example.get('CODEX_INTERACTIVE_SANDBOX') ?? 'workspace-write';
  const networkAccess = local.get('CODEX_INTERACTIVE_NETWORK_ACCESS') ?? example.get('CODEX_INTERACTIVE_NETWORK_ACCESS') ?? 'true';
  const modelArgs = codexModelArgs(local, example, 'CODEX_INTERACTIVE');
  const networkArgs = networkAccess === 'false' ? [] : ['-c', 'sandbox_workspace_write.network_access=true'];
  const args = [...modelArgs, '--sandbox', sandbox, ...networkArgs, '--cd', cwd, prompt];
  return {
    command,
    args,
    display: [command, ...modelArgs, '--sandbox', sandbox, ...networkArgs, '--cd', cwd, '<prompt>'].join(' '),
    cwd,
    mode: 'interactive',
    adapter: 'codex',
  };
}

function withClaudeOutputFormat(invocation: AdapterInvocation, format: 'json' | 'stream-json'): AdapterInvocation {
  if (invocation.adapter !== 'claude') return invocation;
  const idx = invocation.args.indexOf('--output-format');
  if (idx === -1 || idx + 1 >= invocation.args.length) return invocation;
  const newArgs = [...invocation.args];
  newArgs[idx + 1] = format;
  // stream-json requires --verbose when used with --print
  if (format === 'stream-json' && !newArgs.includes('--verbose')) {
    newArgs.push('--verbose');
  }
  return { ...invocation, args: newArgs, display: [invocation.command, ...newArgs].join(' ') };
}

export function runAdapter(workspaceRoot: string, prompt: string, options: AdapterRunOptions = {}): AdapterRunResult {
  const adapterPrompt = promptWithAdapterRuntimeNote(workspaceRoot, prompt, options.usage);
  const baseInvocation = getAdapterInvocation(workspaceRoot, options.cwd ?? workspaceRoot);
  const captureStdout = options.captureStdout === true;
  const formatInvocation = captureStdout ? baseInvocation : withClaudeOutputFormat(baseInvocation, 'stream-json');
  const invocation = withLastMessageOutput(formatInvocation, options.outputLastMessagePath);
  process.stderr.write(`Launching adapter: ${invocation.display}\n`);
  const result = runForegroundAdapterProcess(invocation, adapterPrompt, {
    captureStdout,
    env: {
      ...process.env,
      ...localProcessEnv(workspaceRoot),
    },
  });
  const error =
    result.error?.message ??
    (result.status === 0 ? null : `Adapter exited with status ${result.status ?? 'unknown'}.`);

  const claudeOutput = invocation.adapter === 'claude' ? extractClaudeJsonOutput(result.stdout) : null;
  if (claudeOutput && options.outputLastMessagePath) {
    writeFileSync(options.outputLastMessagePath, claudeOutput.result);
  }

  const outputText =
    options.outputLastMessagePath && existsSync(options.outputLastMessagePath)
      ? readFileSync(options.outputLastMessagePath, 'utf8')
      : null;
  const usage = recordLlmAdapterUsage(workspaceRoot, options.usage, invocation, adapterPrompt, {
    status: result.status,
    signal: result.signal,
    error,
    stdout: result.stdout,
    stderr: result.stderr,
    outputText,
    adapterReportedUsage: claudeOutput?.usage ?? null,
  });
  if (usage.warning) process.stderr.write(`${usage.warning}\n`);

  return {
    launched: result.status === 0,
    status: result.status,
    signal: result.signal,
    error,
    stdout: captureStdout ? result.stdout ?? '' : null,
    stderr: result.stderr ?? null,
    invocation,
  };
}

type ClaudeJsonEnvelope = {
  result: string;
  usage: AdapterReportedUsage;
};

function parseClaudeJsonObject(parsed: Record<string, unknown>): ClaudeJsonEnvelope {
  const resultField = typeof parsed.result === 'string' ? parsed.result : '';
  const rawUsage = (parsed.usage as Record<string, unknown> | undefined) ?? undefined;
  const inputTokens = numberOrNull(rawUsage?.input_tokens);
  const outputTokens = numberOrNull(rawUsage?.output_tokens);
  const cacheRead = numberOrNull(rawUsage?.cache_read_input_tokens);
  const cacheCreation = numberOrNull(rawUsage?.cache_creation_input_tokens);
  const cachedInputTokens =
    cacheRead !== null || cacheCreation !== null ? (cacheRead ?? 0) + (cacheCreation ?? 0) : null;
  const totalTokens =
    inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens + (cachedInputTokens ?? 0)
      : null;
  const costUsd = numberOrNull(parsed.total_cost_usd);
  const model = typeof parsed.model === 'string' ? parsed.model : null;
  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
  return {
    result: resultField,
    usage: { inputTokens, cachedInputTokens, outputTokens, totalTokens, costUsd, model, sessionId },
  };
}

function extractClaudeJsonOutput(stdout: string | null): ClaudeJsonEnvelope | null {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // stream-json: JSONL lines — find the result line
  const lines = trimmed.split('\n');
  if (lines.length > 1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === 'result') return parseClaudeJsonObject(parsed);
      } catch {
        continue;
      }
    }
    return null;
  }
  // json: single JSON blob
  try {
    return parseClaudeJsonObject(JSON.parse(trimmed) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveCommandPath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (command.includes('/')) return existsSync(command) ? command : null;
  const pathValue = env.PATH ?? process.env.PATH ?? '';
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function adapterCommandNotFoundError(command: string): NodeJS.ErrnoException {
  const error = new Error(
    `Adapter command not found on PATH: \`${command}\`. Install the binary or set the matching *_COMMAND in .env.local to an absolute path.`
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function runForegroundAdapterProcess(
  invocation: AdapterInvocation,
  prompt: string,
  options: { captureStdout: boolean; env: NodeJS.ProcessEnv }
) {
  const resolvedCommand = resolveCommandPath(invocation.command, options.env);
  if (!resolvedCommand) {
    const error = adapterCommandNotFoundError(invocation.command);
    process.stderr.write(`${error.message}\n`);
    return { status: 127, signal: null, error, stdout: '', stderr: error.message };
  }

  if (options.captureStdout) {
    const result = spawnSync(resolvedCommand, invocation.args, {
      cwd: invocation.cwd,
      input: prompt,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: options.env,
    });
    if (result.stderr) process.stderr.write(result.stderr);
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  const outputDir = mkdtempSync(path.join(tmpdir(), 'warroom-adapter-output-'));
  const stdoutPath = path.join(outputDir, 'stdout.log');
  const stderrPath = path.join(outputDir, 'stderr.log');
  const command = [shellQuote(resolvedCommand), ...invocation.args.map(shellQuote)].join(' ');
  const script = [
    'set -o pipefail',
    `${command} 2> >(tee ${shellQuote(stderrPath)} >&2) | tee ${shellQuote(stdoutPath)}`,
    'exit ${PIPESTATUS[0]}',
  ].join('\n');
  try {
    const result = spawnSync('bash', ['-c', script], {
      cwd: invocation.cwd,
      input: prompt,
      stdio: ['pipe', 'inherit', 'inherit'],
      encoding: 'utf8',
      env: options.env,
    });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      stdout: existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '',
      stderr: existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '',
    };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function withLastMessageOutput(invocation: AdapterInvocation, outputPath: string | undefined): AdapterInvocation {
  if (!outputPath || invocation.adapter !== 'codex' || invocation.args[0] !== 'exec') return invocation;

  const args = ['exec', '-o', outputPath, ...invocation.args.slice(1)];
  return {
    ...invocation,
    args,
    display: [invocation.command, ...args].join(' '),
  };
}

function interactiveCaptureScriptCommand() {
  if (process.platform !== 'darwin') return null;
  if (!hasInteractiveTerminal()) return null;
  return existsSync('/usr/bin/script') ? '/usr/bin/script' : null;
}

function hasInteractiveTerminal() {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  try {
    const fd = openSync('/dev/tty', 'r+');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function runInteractiveAdapterProcess(invocation: AdapterInvocation, env: NodeJS.ProcessEnv) {
  const resolvedCommand = resolveCommandPath(invocation.command, env);
  if (!resolvedCommand) {
    const error = adapterCommandNotFoundError(invocation.command);
    process.stderr.write(`${error.message}\n`);
    return { status: 127, signal: null, error, outputText: null as string | null };
  }
  const scriptCommand = interactiveCaptureScriptCommand();
  if (!scriptCommand) {
    const result = spawnSync(resolvedCommand, invocation.args, {
      cwd: invocation.cwd,
      stdio: 'inherit',
      encoding: 'utf8',
      env,
    });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      outputText: null as string | null,
    };
  }

  const outputDir = mkdtempSync(path.join(tmpdir(), 'warroom-interactive-adapter-output-'));
  const outputPath = path.join(outputDir, 'terminal.log');
  try {
    const result = spawnSync(scriptCommand, ['-q', outputPath, resolvedCommand, ...invocation.args], {
      cwd: invocation.cwd,
      stdio: 'inherit',
      encoding: 'utf8',
      env,
    });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      outputText: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null,
    };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

export function runInteractiveAdapter(workspaceRoot: string, prompt: string, options: AdapterRunOptions = {}): AdapterRunResult {
  const adapterPrompt = promptWithAdapterRuntimeNote(workspaceRoot, prompt, options.usage);
  const invocation = getInteractiveAdapterInvocation(workspaceRoot, options.cwd ?? workspaceRoot, adapterPrompt);
  process.stderr.write(`Launching interactive adapter: ${invocation.display}\n`);
  const result = runInteractiveAdapterProcess(invocation, {
    ...process.env,
    ...localProcessEnv(workspaceRoot),
  });
  const error =
    result.error?.message ??
    (result.status === 0 ? null : `Adapter exited with status ${result.status ?? 'unknown'}.`);
  const usage = recordLlmAdapterUsage(workspaceRoot, options.usage, invocation, adapterPrompt, {
    status: result.status,
    signal: result.signal,
    error,
    stdout: null,
    stderr: null,
    outputText: result.outputText,
    adapterReportedUsage: null,
  });
  if (usage.warning) process.stderr.write(`${usage.warning}\n`);

  return {
    launched: result.status === 0,
    status: result.status,
    signal: result.signal,
    error,
    stdout: null,
    stderr: null,
    invocation,
  };
}
