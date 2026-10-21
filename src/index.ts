import { createInterface } from 'node:readline/promises';
import { createRuntime, runPrintMode } from './app.js';
import { parseArgs, printHelp } from './cli-args.js';
import {
  applyCliOverrides,
  globalConfigPath,
  loadConfig,
  maskApiKey,
  projectConfigPath,
  resolveApiKey,
  type LoadedConfig,
} from './config.js';
import {
  applyProviderDefaults,
  describeProvider,
  listProviderPresets,
  resolveProvider,
  type ResolvedProvider,
} from './providers.js';
import { startRepl } from './repl.js';
import { SessionStore, type SessionData } from './session.js';
import { ansi, paint } from './ui/ansi.js';
import { startTui } from './ui/tui/app.js';
import { TuiUI } from './ui/tui/tui.js';
import {
  builtinThemeNames,
  createThemeAddon,
  loadThemeAddons,
  resolveTheme,
} from './ui/theme.js';
import { TerminalUI } from './ui/ui.js';
import { errorMessage } from './utils/text.js';
import { readAllStdin } from './utils/stdin.js';
import { getVersion } from './version.js';

function printConfig(
  loaded: LoadedConfig,
  resolved: ResolvedProvider | null,
  providerError: string | null,
): void {
  const { config, sources } = loaded;
  const apiKey = resolveApiKey(config);

  const rows: Array<[string, string]> = [
    [
      'provider',
      resolved
        ? `${resolved.id}${resolved.detected ? ' (auto-detected)' : ''} · ${resolved.preset.label}`
        : '(none available)',
    ],
    ['endpoint', resolved?.baseURL ?? '(SDK default)'],
    ['model', resolved ? resolved.model || '(auto-detect)' : config.model],
    ['max output tokens', String(config.maxTokens)],
    ['max turns', String(config.maxTurns)],
    ['sampling', `temperature ${config.sampling.temperature} · top_p ${config.sampling.topP}`],
    ['permission mode', config.permissions.mode],
    [
      'context window',
      `${config.context.maxTokens} tokens (compact at ${Math.round(config.context.compactAt * 100)}%)`,
    ],
    [
      'workspace',
      config.workspace.allowOutside ? 'outside access allowed' : 'confined to the workspace',
    ],
    ['theme', config.ui.theme],
    ['resource monitor', config.ui.resources ? `on (${config.ui.resourceIntervalMs}ms)` : 'off'],
    ['request timeout', `${Math.round(config.request.timeoutMs / 1000)}s`],
    [
      'api key',
      apiKey
        ? maskApiKey(apiKey)
        : resolved?.preset.requiresKey === false
          ? '(not required)'
          : '(missing)',
    ],
    ['global config', `${globalConfigPath()}${sources.global ? '' : ' (not found)'}`],
    ['project config', `${projectConfigPath(process.cwd())}${sources.project ? '' : ' (not found)'}`],
  ];

  console.log(paint('Nelo Code configuration', ansi.bold));
  for (const [key, value] of rows) {
    console.log(`  ${key.padEnd(20)} ${value}`);
  }
  if (sources.env.length > 0) {
    console.log(`  ${'env overrides'.padEnd(20)} ${sources.env.join(', ')}`);
  }
  if (config.permissions.allow.length > 0) {
    console.log(`  ${'allowed tools'.padEnd(20)} ${config.permissions.allow.join(', ')}`);
  }
  if (config.permissions.denyCommands.length > 0) {
    console.log(`  ${'denied commands'.padEnd(20)} ${config.permissions.denyCommands.join(', ')}`);
  }
  if (providerError !== null) {
    console.log('');
    console.log(paint(`! ${providerError}`, ansi.yellow));
  }
}

function printProviders(): void {
  console.log(paint('Provider templates', ansi.bold));
  for (const preset of listProviderPresets()) {
    console.log(`  ${preset.id.padEnd(12)} ${preset.label}`);
    console.log(`  ${''.padEnd(12)} ${paint(describeProvider(preset), ansi.dim)}`);
    console.log(`  ${''.padEnd(12)} ${paint(preset.note, ansi.dim)}`);
  }
  console.log('');
  console.log(paint('Use --provider <id>, or set "provider" in ~/.nelo/config.json.', ansi.dim));
}

function printThemes(cwd: string): void {
  const { themes, errors, directories } = loadThemeAddons(cwd);
  console.log(paint('Built-in themes', ansi.bold));
  for (const name of builtinThemeNames()) {
    console.log(`  ${name}`);
  }
  console.log('');
  console.log(paint('Addon themes', ansi.bold));
  if (themes.length === 0) {
    console.log(paint('  (none) — scaffold one with: nelo addon new my-theme', ansi.dim));
  }
  for (const theme of themes) {
    console.log(`  ${theme.name.padEnd(16)} ${theme.label}${theme.version ? ` v${theme.version}` : ''}`);
    console.log(`  ${''.padEnd(16)} ${paint(theme.description, ansi.dim)}`);
  }
  console.log('');
  console.log(paint(`Addon directories: ${directories.join(', ')}`, ansi.dim));
  for (const error of errors) {
    console.log(paint(`! ${error}`, ansi.yellow));
  }
}

function handleAddonCommand(commandArgs: string[], cwd: string): number {
  const [subcommand, name] = commandArgs;
  if (subcommand !== 'new' || !name) {
    console.error('Usage: nelo addon new <name>');
    return 1;
  }
  try {
    const manifest = createThemeAddon(name, cwd);
    console.log(paint(`✔ Created ${manifest}`, ansi.green));
    console.log('');
    console.log('Next steps:');
    console.log('  1. Edit colors / glyphs in that file.');
    console.log(`  2. Run "nelo" and type /theme ${name} (or /theme reload while editing).`);
    return 0;
  } catch (error) {
    console.error(paint(`✖ ${errorMessage(error)}`, ansi.red));
    return 1;
  }
}

export async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(paint(`✖ ${errorMessage(error)}`, ansi.red));
    console.error('Run "nelo --help" for usage.');
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printHelp(getVersion());
    return;
  }
  if (args.version) {
    console.log(getVersion());
    return;
  }

  const cwd = process.cwd();
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig({ cwd });
    applyCliOverrides(loaded.config, {
      model: args.model,
      maxTokens: args.maxTokens,
      mode: args.mode,
      provider: args.provider,
      baseURL: args.baseURL,
    });
  } catch (error) {
    console.error(paint(`✖ ${errorMessage(error)}`, ansi.red));
    process.exitCode = 1;
    return;
  }

  if (args.command === 'providers') {
    printProviders();
    return;
  }
  if (args.command === 'themes') {
    printThemes(cwd);
    return;
  }
  if (args.command === 'addon') {
    process.exitCode = handleAddonCommand(args.commandArgs, cwd);
    return;
  }

  if (args.command === 'config') {
    // `nelo config` is also a diagnostic: show the resolved settings even when
    // no provider is reachable, so the hint explains what is missing.
    let configProvider: ResolvedProvider | null = null;
    let configError: string | null = null;
    try {
      configProvider = await resolveProvider({ config: loaded.config });
      applyProviderDefaults(loaded.config, configProvider);
    } catch (error) {
      configError = errorMessage(error);
    }
    printConfig(loaded, configProvider, configError);
    return;
  }

  const isPrintMode = args.print || args.prompt !== undefined;

  let resolved: ResolvedProvider | null = null;
  let providerError: string | null = null;
  try {
    resolved = await resolveProvider({ config: loaded.config });
    applyProviderDefaults(loaded.config, resolved);
  } catch (error) {
    providerError = errorMessage(error);
    // Non-interactive runs cannot ask the user to connect later, so fail now.
    if (isPrintMode) {
      console.error(paint(`✖ ${providerError}`, ansi.red));
      console.error('');
      console.error('Run "nelo providers" to see the available templates.');
      process.exitCode = 1;
      return;
    }
  }

  const theme = resolveTheme(loaded.config.ui.theme, cwd);
  for (const warning of theme.errors) {
    console.error(paint(`! ${warning}`, ansi.yellow));
  }

  const store = new SessionStore(cwd);
  let session: SessionData | null = null;
  let notice: string | undefined;
  const useTui = !args.noTui && process.stdin.isTTY === true && process.stdout.isTTY === true;

  if (args.resumeId) {
    session = await store.load(args.resumeId);
    if (!session) {
      console.error(paint(`✖ Session not found: ${args.resumeId}`, ansi.red));
      process.exitCode = 1;
      return;
    }
  } else if (args.continueSession) {
    session = await store.loadLatest();
    if (!session) {
      const message = 'No previous session found for this project; starting a new one.';
      if (useTui) notice = message;
      else console.error(paint(`! ${message}`, ansi.yellow));
    }
  }

  if (isPrintMode) {
    let prompt = args.prompt;
    if (prompt === undefined) {
      if (process.stdin.isTTY) {
        console.error('Error: no prompt provided. Usage: nelo -p "your prompt"');
        process.exitCode = 1;
        return;
      }
      prompt = (await readAllStdin()).trim();
      if (!prompt) {
        console.error('Error: empty prompt.');
        process.exitCode = 1;
        return;
      }
    }

    const controller = new AbortController();
    let interrupts = 0;
    const onSigint = (): void => {
      interrupts += 1;
      if (interrupts > 1) process.exit(130);
      controller.abort();
    };
    process.on('SIGINT', onSigint);

    try {
      process.exitCode = await runPrintMode({
        config: loaded.config,
        loaded,
        cwd,
        prompt,
        session,
        provider: resolved,
        providerError,
        signal: controller.signal,
      });
    } finally {
      process.off('SIGINT', onSigint);
    }
    return;
  }

  if (useTui) {
    const tui = new TuiUI();
    try {
      const runtime = await createRuntime({
        config: loaded.config,
        loaded,
        cwd,
        ui: tui,
        session,
        provider: resolved,
        providerError,
      });
      await startTui(runtime, tui, { notice });
    } catch (error) {
      tui.stop();
      console.error(paint(`✖ ${errorMessage(error)}`, ansi.red));
      process.exitCode = 1;
      return;
    }
    console.log('Session saved. Bye!');
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 200,
  });
  const ui = new TerminalUI({
    interactive: true,
    question: (promptText) => rl.question(promptText),
  });

  try {
    const runtime = await createRuntime({
      config: loaded.config,
      loaded,
      cwd,
      ui,
      session,
      provider: resolved,
      providerError,
    });
    await startRepl(runtime, rl);
  } catch (error) {
    ui.error(errorMessage(error));
    process.exitCode = 1;
    rl.close();
  }
}

main().catch((error) => {
  console.error(paint(`✖ ${errorMessage(error)}`, ansi.red));
  process.exit(1);
});
