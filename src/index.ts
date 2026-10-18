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
import { startRepl } from './repl.js';
import { SessionStore, type SessionData } from './session.js';
import { ansi, paint } from './ui/ansi.js';
import { startTui } from './ui/tui/app.js';
import { TuiUI } from './ui/tui/tui.js';
import { TerminalUI } from './ui/ui.js';
import { errorMessage } from './utils/text.js';
import { readAllStdin } from './utils/stdin.js';
import { getVersion } from './version.js';

function printConfig(loaded: LoadedConfig): void {
  const { config, sources } = loaded;
  const apiKey = resolveApiKey(config);

  const rows: Array<[string, string]> = [
    ['model', config.model],
    ['max output tokens', String(config.maxTokens)],
    ['max turns', String(config.maxTurns)],
    ['permission mode', config.permissions.mode],
    [
      'context window',
      `${config.context.maxTokens} tokens (compact at ${Math.round(config.context.compactAt * 100)}%)`,
    ],
    [
      'workspace',
      config.workspace.allowOutside ? 'outside access allowed' : 'confined to the workspace',
    ],
    ['api key', apiKey ? maskApiKey(apiKey) : '(not set)'],
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
    });
  } catch (error) {
    console.error(paint(`✖ ${errorMessage(error)}`, ansi.red));
    process.exitCode = 1;
    return;
  }

  if (args.command === 'config') {
    printConfig(loaded);
    return;
  }

  if (!resolveApiKey(loaded.config)) {
    console.error(paint('✖ Missing API key.', ansi.red));
    console.error('');
    console.error('Set ANTHROPIC_API_KEY in your environment:');
    console.error('  export ANTHROPIC_API_KEY="sk-ant-..."   (macOS / Linux / Git Bash)');
    console.error('  $env:ANTHROPIC_API_KEY = "sk-ant-..."   (PowerShell)');
    console.error('');
    console.error(
      `Or add "apiKey" to ${globalConfigPath()} (not recommended on shared machines).`,
    );
    process.exitCode = 1;
    return;
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

  const isPrintMode = args.print || args.prompt !== undefined;

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
      const runtime = createRuntime({
        config: loaded.config,
        loaded,
        cwd,
        ui: tui,
        session,
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
    const runtime = createRuntime({
      config: loaded.config,
      loaded,
      cwd,
      ui,
      session,
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
