import type { Interface } from 'node:readline/promises';
import { handleSlashCommand, printTurnStats, runShellEscape } from './commands.js';
import { connectionHint, connectionProblem, type Runtime } from './app.js';
import { describeApiError } from './client.js';
import { ansi, paint } from './ui/ansi.js';
import { getVersion } from './version.js';

export async function startRepl(runtime: Runtime, rl: Interface): Promise<void> {
  printBanner(runtime);

  const problem = connectionProblem(runtime);
  if (problem) {
    runtime.ui.warn(problem);
    runtime.ui.info(connectionHint(runtime));
  }

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

      const missing = connectionProblem(runtime);
      if (missing) {
        runtime.ui.warn(missing);
        runtime.ui.info(connectionHint(runtime));
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
  const modelLabel = runtime.provider ? config.model || 'no model' : 'not connected';
  ui.raw('');
  ui.raw(`${paint('◆', ansi.magenta)} ${paint('Nelo Code', ansi.bold)} ${paint(`v${getVersion()}`, ansi.dim)}`);
  ui.raw(
    `${paint('  model', ansi.dim)} ${modelLabel}  ${paint('·', ansi.dim)} ${paint('mode', ansi.dim)} ${
      config.permissions.mode
    }  ${paint('·', ansi.dim)} ${paint('cwd', ansi.dim)} ${runtime.cwd}`,
  );
  ui.raw(paint('  Type /help for commands. Ctrl+C interrupts the agent.', ansi.dim));
  ui.raw('');
}
