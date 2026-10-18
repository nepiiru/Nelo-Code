import type { Interface } from 'node:readline/promises';
import type { TurnResult } from './agent.js';
import { resetSession, resumeSession, type Runtime } from './app.js';
import { describeApiError } from './client.js';
import { MODEL_ALIASES, parsePermissionMode, resolveModelAlias } from './config.js';
import { ansi, paint } from './ui/ansi.js';
import { runShellCommand } from './utils/exec.js';
import { errorMessage, formatTokenCount, truncate } from './utils/text.js';
import { getVersion } from './version.js';

export async function startRepl(runtime: Runtime, rl: Interface): Promise<void> {
  printBanner(runtime);

  let controller: AbortController | null = null;
  let abortRequested = false;
  let running = false;
  let closed = false;
  let waitingForLine: ((line: string | null) => void) | null = null;
  const queuedLines: string[] = [];

  const promptLine = (): Promise<string | null> => {
    if (queuedLines.length > 0) return Promise.resolve(queuedLines.shift() ?? '');
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waitingForLine = resolve;
      rl.setPrompt(paint('❯ ', ansi.green));
      rl.prompt();
    });
  };

  const onLine = (line: string): void => {
    if (runtime.ui.hasPendingPrompt()) return;
    if (running || !waitingForLine) {
      queuedLines.push(line);
      return;
    }
    const resolve = waitingForLine;
    waitingForLine = null;
    resolve(line);
  };

  const onClose = (): void => {
    closed = true;
    const resolve = waitingForLine;
    waitingForLine = null;
    resolve?.(null);
  };

  const onSigint = (): void => {
    if (controller) {
      if (abortRequested) {
        runtime.ui.warn('Force exiting.');
        process.exit(130);
      }
      abortRequested = true;
      if (runtime.ui.hasPendingPrompt()) rl.write('\n');
      controller.abort();
      runtime.ui.warn('Interrupting… (press Ctrl+C again to force exit)');
      return;
    }
    rl.close();
  };

  rl.on('line', onLine);
  rl.on('close', onClose);
  rl.on('SIGINT', onSigint);

  try {
    while (true) {
      const line = await promptLine();
      if (line === null) break;

      const input = line.trim();
      if (!input) continue;

      if (input === '/exit' || input === '/quit' || input === '/q') break;

      if (input.startsWith('/')) {
        const keepGoing = await handleSlashCommand(runtime, input);
        if (!keepGoing) break;
        continue;
      }

      if (input.startsWith('!')) {
        await runShellEscape(runtime, input.slice(1).trim());
        continue;
      }

      controller = new AbortController();
      abortRequested = false;
      running = true;
      try {
        const result = await runtime.agent.run(input, controller.signal);
        await runtime.saveSession();
        printTurnStats(runtime, result);
      } catch (error) {
        runtime.ui.error(describeApiError(error));
      } finally {
        running = false;
        controller = null;
      }
    }
  } finally {
    rl.off('line', onLine);
    rl.off('close', onClose);
    rl.off('SIGINT', onSigint);
    try {
      await runtime.saveSession();
    } catch {
      // Ignore save failures on exit.
    }
    rl.close();
  }

  runtime.ui.info('Session saved. Bye!');
}

function printBanner(runtime: Runtime): void {
  const { config, ui } = runtime;
  ui.raw('');
  ui.raw(`${paint('◆', ansi.magenta)} ${paint('Nelo Code', ansi.bold)} ${paint(`v${getVersion()}`, ansi.dim)}`);
  ui.raw(
    `${paint('  model', ansi.dim)} ${config.model}  ${paint('·', ansi.dim)} ${paint('mode', ansi.dim)} ${
      config.permissions.mode
    }  ${paint('·', ansi.dim)} ${paint('cwd', ansi.dim)} ${runtime.cwd}`,
  );
  ui.raw(paint('  Type /help for commands. Ctrl+C interrupts the agent.', ansi.dim));
  ui.raw('');
}

function printTurnStats(runtime: Runtime, result: TurnResult): void {
  const parts = [`${(result.durationMs / 1000).toFixed(1)}s`];
  if (result.turns > 1) parts.push(`${result.turns} turns`);
  parts.push(
    `${formatTokenCount(result.usage.inputTokens)} in / ${formatTokenCount(result.usage.outputTokens)} out`,
  );
  runtime.ui.stats(parts.join(' · '));
}

async function handleSlashCommand(runtime: Runtime, input: string): Promise<boolean> {
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
        `Model: ${config.model} · Mode: ${config.permissions.mode} · Messages: ${runtime.agent.messages.length}`,
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

function printHelp(runtime: Runtime): void {
  runtime.ui.raw(
    [
      'Commands:',
      '  /help              Show this help',
      '  /clear             Start a new conversation',
      '  /compact           Summarize older messages to free context',
      '  /model [name]      Show or change the model',
      '  /permissions [m]   Show or set mode: ask | auto | readonly',
      '  /usage             Show token usage for this session',
      '  /status            Show session and context status',
      '  /tools             List available tools',
      '  /sessions          List recent sessions for this project',
      '  /resume <id>       Resume a saved session',
      '  /exit              Exit Nelo Code',
      '  !<command>         Run a shell command directly',
    ].join('\n'),
  );
}

async function runShellEscape(runtime: Runtime, command: string): Promise<void> {
  if (!command) {
    runtime.ui.warn('Usage: !<command>');
    return;
  }

  runtime.ui.toolStart('shell', truncate(command, 60));
  const result = await runShellCommand(command, { cwd: runtime.cwd, timeoutMs: 120000 });

  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
  if (output) runtime.ui.raw(output);

  const failed = result.timedOut || (result.exitCode ?? 1) !== 0;
  runtime.ui.toolEnd(
    'shell',
    result.timedOut ? 'timed out' : `exit ${result.exitCode ?? '?'}`,
    failed,
  );
}
