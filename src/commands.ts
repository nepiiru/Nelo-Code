import type { TurnResult } from './agent.js';
import { resetSession, resumeSession, type Runtime } from './app.js';
import {
  MODEL_ALIASES,
  parsePermissionMode,
  resolveModelAlias,
  type ProviderId,
} from './config.js';
import {
  describeProvider,
  isProviderId,
  listProviderPresets,
} from './providers.js';
import { formatResourceReport } from './system/resources.js';
import { formatTokenCount, errorMessage, truncate } from './utils/text.js';
import { runShellCommand } from './utils/exec.js';
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

function describeEndpoint(runtime: Runtime): string {
  return runtime.provider.baseURL ?? '(SDK default)';
}

async function switchProvider(runtime: Runtime, argument: string): Promise<void> {
  const id = argument.trim().toLowerCase();
  if (!isProviderId(id) || id === 'auto') {
    runtime.ui.warn(
      `Unknown provider "${argument}". Use one of: ${listProviderPresets()
        .map((preset) => preset.id)
        .join(', ')}.`,
    );
    return;
  }

  try {
    const resolved = await runtime.switchProvider(id as Exclude<ProviderId, 'auto'>);
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

    case 'compact':
      await runtime.agent.compact();
      await runtime.saveSession();
      return true;

    case 'model': {
      if (!argument) {
        ui.info(`Current model: ${config.model}`);
        ui.info(
          `Aliases: ${Object.entries(MODEL_ALIASES)
            .map(([alias, id]) => `${alias} → ${id}`)
            .join(', ')}`,
        );
        return true;
      }
      config.model = resolveModelAlias(argument);
      await runtime.saveSession();
      ui.info(`Model set to ${config.model}.`);
      return true;
    }

    case 'provider': {
      if (!argument) {
        ui.info(
          `Provider: ${runtime.provider.id} · ${config.model} · ${describeEndpoint(runtime)}`,
        );
        ui.raw(
          listProviderPresets()
            .map((preset) => `  ${preset.id.padEnd(12)} ${describeProvider(preset)}`)
            .join('\n'),
        );
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
        showThemes(runtime);
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
        ui.info(`Permission mode: ${config.permissions.mode}`);
        ui.info(
          'Modes: ask (prompt for each mutating tool), auto (approve everything), readonly (no writes or commands).',
        );
        return true;
      }
      try {
        config.permissions.mode = parsePermissionMode(argument);
      } catch (error) {
        ui.warn(errorMessage(error));
        return true;
      }
      ui.info(`Permission mode set to ${config.permissions.mode}.`);
      if (config.permissions.mode === 'auto') {
        ui.warn('Auto mode approves all tool calls without asking.');
      }
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
        `Provider: ${runtime.provider.id} · Model: ${config.model} · Mode: ${
          config.permissions.mode
        } · Messages: ${runtime.agent.messages.length}`,
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
      '  /model [name]       Show or change the model',
      '  /provider [id]      Show or switch the provider (ollama, lmstudio, …)',
      '  /providers          List provider templates',
      '  /permissions [mode] Show or set mode: ask | auto | readonly',
      '  /theme [name|reload] Show, switch or reload UI themes',
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
