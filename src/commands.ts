import type { TurnResult } from './agent.js';
import { connectionHint, connectionProblem, resetSession, resumeSession, type Runtime } from './app.js';
import {
  MODEL_ALIASES,
  PERMISSION_MODES,
  parsePermissionMode,
  resolveModelAlias,
  type ProviderId,
} from './config.js';
import { isProviderId, listProviderPresets } from './providers.js';
import { formatResourceReport } from './system/resources.js';
import { formatTokenCount, errorMessage, truncate } from './utils/text.js';
import { runShellCommand } from './utils/exec.js';
import type { SelectOption } from './ui/ui.js';
import {
  builtinThemeNames,
  getActiveTheme,
  loadThemeAddons,
  resolveTheme,
  setActiveTheme,
} from './ui/theme.js';

export function printTurnStats(runtime: Runtime, result: TurnResult): void {
  const parts = [`${(result.durationMs / 1000).toFixed(1)}s`];
  if (result.turns > 1) parts.push(`${result.turns} turns`);
  parts.push(
    `${formatTokenCount(result.usage.inputTokens)} in / ${formatTokenCount(result.usage.outputTokens)} out`,
  );
  runtime.ui.stats(parts.join(' · '));
}

async function switchProvider(runtime: Runtime, argument: string): Promise<void> {
  const id = argument.trim().toLowerCase();
  if (!isProviderId(id)) {
    runtime.ui.warn(
      `Unknown provider "${argument}". Use one of: auto, ${listProviderPresets()
        .map((preset) => preset.id)
        .join(', ')}.`,
    );
    return;
  }

  try {
    const resolved = await runtime.switchProvider(id as ProviderId);
    runtime.ui.info(
      `Provider set to ${resolved.id} · ${resolved.model} · ${resolved.baseURL ?? 'SDK default'}`,
    );
    if (resolved.preset.local) {
      runtime.ui.info('Local provider: no API key or network access is required.');
    }
  } catch (error) {
    runtime.ui.warn(`Could not switch provider: ${errorMessage(error)}`);
  }
}

async function discoverModels(runtime: Runtime): Promise<string[]> {
  if (!runtime.client.listModels) return [];
  try {
    return await runtime.client.listModels();
  } catch {
    return [];
  }
}

function buildModelOptions(runtime: Runtime, discovered: string[]): SelectOption[] {
  const current = runtime.config.model;
  const covered = new Set<string>();
  const options: SelectOption[] = [];

  if (current) {
    options.push({ value: current, label: current, description: 'current' });
    covered.add(current);
  }

  for (const id of discovered) {
    if (!id || covered.has(id)) continue;
    covered.add(id);
    options.push({
      value: id,
      label: id,
      description: id === current ? 'current · server' : 'server',
    });
  }

  // Anthropic aliases are only meaningful for Anthropic or before a provider
  // has been chosen. OpenAI-compatible endpoints list their own model ids.
  const includeAliases = !runtime.provider || runtime.provider.preset.kind === 'anthropic';
  if (includeAliases) {
    for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
      if (covered.has(id)) continue;
      covered.add(id);
      options.push({
        value: id,
        label: alias,
        description: id === current ? `${id} · current` : id,
      });
    }
  }

  return options;
}

async function pickModel(runtime: Runtime): Promise<void> {
  const { ui, config } = runtime;
  ui.spinner('Loading models…');
  const options = buildModelOptions(runtime, await discoverModels(runtime));
  const choice = await ui.select({
    title: 'Select model',
    options,
    selected: config.model,
  });
  if (!choice) return;

  config.model = resolveModelAlias(choice);
  await runtime.saveSession();
  ui.info(`Model set to ${config.model}.`);
}

async function pickProvider(runtime: Runtime): Promise<void> {
  const { ui } = runtime;
  const current = runtime.provider?.id ?? 'auto';
  const autoDescription = [
    'Re-run auto-detection',
    current === 'auto' ? 'current' : '',
    runtime.provider ? '' : 'not connected',
  ]
    .filter(Boolean)
    .join(' · ');
  const options: SelectOption[] = [
    { value: 'auto', label: 'auto', description: autoDescription },
    ...listProviderPresets().map((preset) => ({
      value: preset.id,
      label: preset.id,
      description: [
        preset.label,
        preset.local ? 'local' : '',
        preset.id === current ? 'current' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  ];
  const choice = await ui.select({ title: 'Select provider', options, selected: current });
  if (!choice) return;

  ui.spinner(choice === 'auto' ? 'Detecting provider…' : `Connecting to ${choice}…`);
  await switchProvider(runtime, choice);
  await runtime.saveSession();
}

async function pickTheme(runtime: Runtime): Promise<void> {
  const { ui } = runtime;
  const { themes, errors } = loadThemeAddons(runtime.cwd);
  const active = getActiveTheme().name;
  const options: SelectOption[] = [
    ...builtinThemeNames().map((name) => ({
      value: name,
      label: name,
      description: name === active ? 'built-in · current' : 'built-in',
    })),
    ...themes.map((theme) => ({
      value: theme.name,
      label: theme.name,
      description: `${theme.description}${theme.name === active ? ' · current' : ''}`,
    })),
  ];

  for (const error of errors) ui.warn(error);
  const choice = await ui.select({ title: 'Select theme', options, selected: active });
  if (choice) applyTheme(runtime, choice);
}

async function pickPermissionMode(runtime: Runtime): Promise<void> {
  const { ui, config } = runtime;
  const current = config.permissions.mode;
  const options: SelectOption[] = PERMISSION_MODES.map((mode) => {
    const label =
      mode === 'ask'
        ? 'Prompt before writes and commands'
        : mode === 'auto'
          ? 'Approve everything without asking'
          : 'Read-only: no writes or commands';
    return {
      value: mode,
      label: mode,
      description: `${label}${mode === current ? ' · current' : ''}`,
    };
  });

  const choice = await ui.select({
    title: 'Select permission mode',
    options,
    selected: current,
  });
  if (choice) setPermissionMode(runtime, choice);
}

function setPermissionMode(runtime: Runtime, mode: string): void {
  const { ui, config } = runtime;
  try {
    config.permissions.mode = parsePermissionMode(mode);
  } catch (error) {
    ui.warn(errorMessage(error));
    return;
  }
  ui.info(`Permission mode set to ${config.permissions.mode}.`);
  if (config.permissions.mode === 'auto') {
    ui.warn('Auto mode approves all tool calls without asking.');
  }
}

function showThemes(runtime: Runtime): void {
  const { themes, errors } = loadThemeAddons(runtime.cwd);
  const active = getActiveTheme().name;

  runtime.ui.info(`Theme: ${active}`);
  runtime.ui.raw(
    [
      'Built-in:',
      ...builtinThemeNames().map((name) => `  ${name === active ? '*' : ' '} ${name}`),
      '',
      'Addons:',
      ...(themes.length === 0
        ? ['  (none) — run "nelo addon new my-theme" to scaffold one']
        : themes.map((theme) => `  ${theme.name === active ? '*' : ' '} ${theme.name} — ${theme.description}`)),
    ].join('\n'),
  );

  for (const error of errors) runtime.ui.warn(error);
  runtime.ui.info('Switch with /theme <name>, reload edits with /theme reload.');
}

function applyTheme(runtime: Runtime, argument: string): void {
  if (argument === 'reload') {
    const current = getActiveTheme().name;
    const resolved = resolveTheme(current, runtime.cwd);
    setActiveTheme(resolved.theme);
    runtime.ui.refreshTheme?.();
    for (const error of resolved.errors) runtime.ui.warn(error);
    runtime.ui.info(
      resolved.source === 'addon'
        ? `Reloaded theme ${current} from disk.`
        : `Theme ${current} is built in; nothing to reload.`,
    );
    return;
  }

  const resolved = resolveTheme(argument, runtime.cwd);
  setActiveTheme(resolved.theme);
  runtime.ui.refreshTheme?.();
  for (const error of resolved.errors) runtime.ui.warn(error);
  runtime.ui.info(
    `Theme set to ${resolved.theme.name}. Set "ui.theme" in the config or NELO_THEME to keep it.`,
  );
}

function showAddons(runtime: Runtime): void {
  const { themes, errors, directories } = loadThemeAddons(runtime.cwd);
  runtime.ui.raw(
    [
      'Theme addons:',
      ...(themes.length === 0 ? ['  (none)'] : themes.map((theme) => `  ${theme.name} — ${theme.path}`)),
      '',
      'Search paths:',
      ...directories.map((directory) => `  ${directory}`),
      '',
      'Create one: nelo addon new <name>',
      'Then edit addon.json and run /theme reload.',
    ].join('\n'),
  );
  for (const error of errors) runtime.ui.warn(error);
}

async function showResources(runtime: Runtime): Promise<void> {
  const snapshot = await runtime.monitor.sample();
  runtime.ui.raw(
    [`Resources (${new Date(snapshot.at).toLocaleTimeString()})`, ...formatResourceReport(snapshot)].join(
      '\n',
    ),
  );
}

export async function handleSlashCommand(runtime: Runtime, input: string): Promise<boolean> {
  const [rawCommand, ...rest] = input.slice(1).split(/\s+/);
  const command = (rawCommand ?? '').toLowerCase();
  const argument = rest.join(' ').trim();
  const { ui, config } = runtime;

  switch (command) {
    case 'help':
      printHelp(runtime);
      return true;

    case 'clear':
      resetSession(runtime);
      ui.resetTranscript();
      await runtime.saveSession();
      ui.info('Started a new conversation. Context cleared.');
      return true;

    case 'compact': {
      const problem = connectionProblem(runtime);
      if (problem) {
        ui.warn(problem);
        ui.info(connectionHint(runtime));
        return true;
      }
      await runtime.agent.compact();
      await runtime.saveSession();
      return true;
    }

    case 'model': {
      if (!argument) {
        await pickModel(runtime);
        return true;
      }
      config.model = resolveModelAlias(argument);
      await runtime.saveSession();
      ui.info(`Model set to ${config.model}.`);
      return true;
    }

    case 'provider': {
      if (!argument) {
        await pickProvider(runtime);
        return true;
      }
      await switchProvider(runtime, argument);
      await runtime.saveSession();
      return true;
    }

    case 'providers': {
      ui.raw(
        listProviderPresets()
          .map((preset) => `  ${preset.id.padEnd(12)} ${preset.label} — ${preset.note}`)
          .join('\n'),
      );
      return true;
    }

    case 'theme': {
      if (!argument) {
        await pickTheme(runtime);
        return true;
      }
      applyTheme(runtime, argument);
      return true;
    }

    case 'themes': {
      showThemes(runtime);
      return true;
    }

    case 'addons': {
      showAddons(runtime);
      return true;
    }

    case 'resources': {
      await showResources(runtime);
      return true;
    }

    case 'permissions': {
      if (!argument) {
        await pickPermissionMode(runtime);
        return true;
      }
      setPermissionMode(runtime, argument);
      return true;
    }

    case 'usage':
    case 'cost': {
      const usage = runtime.agent.usage;
      ui.info(
        `Session tokens: ${usage.inputTokens.toLocaleString('en-US')} in / ${usage.outputTokens.toLocaleString(
          'en-US',
        )} out`,
      );
      if (usage.cacheReadInputTokens || usage.cacheCreationInputTokens) {
        ui.info(
          `Cache: ${usage.cacheReadInputTokens.toLocaleString('en-US')} read / ${usage.cacheCreationInputTokens.toLocaleString(
            'en-US',
          )} written`,
        );
      }
      return true;
    }

    case 'status': {
      ui.info(`Session: ${runtime.session.id}`);
      ui.info(
        `Provider: ${runtime.provider?.id ?? 'not connected'} · Model: ${
          runtime.provider ? config.model || '(none)' : '(none)'
        } · Mode: ${config.permissions.mode} · Messages: ${runtime.agent.messages.length}`,
      );
      ui.info(
        `Estimated context: ~${formatTokenCount(runtime.agent.estimatedContextTokens())} / ${formatTokenCount(
          config.context.maxTokens,
        )} tokens`,
      );
      return true;
    }

    case 'tools': {
      for (const tool of runtime.tools) {
        ui.info(
          `${tool.definition.name}${tool.readOnly ? ' (read-only)' : ''} — ${
            tool.definition.description.split('\n')[0]
          }`,
        );
      }
      return true;
    }

    case 'sessions': {
      const sessions = await runtime.store.list();
      if (sessions.length === 0) {
        ui.info('No saved sessions for this project.');
        return true;
      }
      for (const session of sessions.slice(0, 10)) {
        const marker = session.id === runtime.session.id ? '*' : ' ';
        ui.info(
          `${marker} ${session.id}  ${session.updatedAt.slice(0, 19).replace('T', ' ')}  ${
            session.messages.length
          } messages`,
        );
      }
      return true;
    }

    case 'resume': {
      if (!argument) {
        ui.warn('Usage: /resume <session-id>');
        return true;
      }
      const resumed = await resumeSession(runtime, argument);
      if (!resumed) {
        ui.warn(`Session not found: ${argument}`);
        return true;
      }
      ui.resetTranscript();
      ui.info(`Resumed session ${argument} (${runtime.agent.messages.length} messages).`);
      return true;
    }

    case 'exit':
    case 'quit':
    case 'q':
      return false;

    default:
      ui.warn(`Unknown command: /${command}. Type /help for the list.`);
      return true;
  }
}

export function printHelp(runtime: Runtime): void {
  runtime.ui.raw(
    [
      'Commands:',
      '  /help               Show this help',
      '  /clear              Start a new conversation',
      '  /compact            Summarize older messages to free context',
      '  /model [name]       Choose a model, or set it by name',
      '  /provider [id]      Choose a provider, or switch by id ("auto" re-detects)',
      '  /providers          List provider templates',
      '  /permissions [mode] Choose or set mode: ask | auto | readonly',
      '  /theme [name|reload] Choose, switch or reload UI themes',
      '  /themes             List built-in and addon themes',
      '  /addons             List addon directories and loaded addons',
      '  /resources          Show CPU, RAM, GPU and VRAM usage',
      '  /usage              Show token usage for this session',
      '  /status             Show session and context status',
      '  /tools              List available tools',
      '  /sessions           List recent sessions for this project',
      '  /resume <id>        Resume a saved session',
      '  /exit               Exit Nelo Code',
      '  !<command>          Run a shell command directly',
    ].join('\n'),
  );
}

export async function runShellEscape(runtime: Runtime, command: string): Promise<void> {
  if (!command) {
    runtime.ui.warn('Usage: !<command>');
    return;
  }

  runtime.ui.toolStart('shell', truncate(command, 60));
  const result = await runShellCommand(command, { cwd: runtime.cwd, timeoutMs: 120000 });

  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
  if (output) runtime.ui.raw(output);

  const failed = result.timedOut || (result.exitCode ?? 1) !== 0;
  runtime.ui.toolEnd('shell', result.timedOut ? 'timed out' : `exit ${result.exitCode ?? '?'}`, failed);
}
