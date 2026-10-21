import { basename } from 'node:path';
import { connectionHint, connectionProblem, type Runtime } from '../../app.js';
import { describeApiError } from '../../client.js';
import { handleSlashCommand, printTurnStats, runShellEscape } from '../../commands.js';
import { vitalsSegments } from '../../system/resources.js';
import type { TuiUI } from './tui.js';

export async function startTui(
  runtime: Runtime,
  tui: TuiUI,
  options: { notice?: string } = {},
): Promise<void> {
  tui.start();
  if (options.notice) tui.warn(options.notice);

  const problem = connectionProblem(runtime);
  if (problem) {
    tui.warn(problem);
    tui.info(connectionHint(runtime));
  }

  let controller: AbortController | null = null;
  let abortRequested = false;

  const updateStatus = (): void => {
    tui.updateStatus({
      model: runtime.provider
        ? runtime.config.model || 'no model'
        : 'not connected',
      mode: runtime.config.permissions.mode,
      sessionId: runtime.session.id,
      usage: runtime.agent.usage,
      cwdLabel: basename(runtime.cwd),
    });
  };

  updateStatus();

  if (runtime.config.ui.resources) {
    runtime.monitor.start(runtime.config.ui.resourceIntervalMs, (snapshot) => {
      tui.setVitals(vitalsSegments(snapshot));
    });
  }

  if (runtime.agent.messages.length > 0) {
    tui.info(
      `Resumed session ${runtime.session.id} (${runtime.agent.messages.length} messages, ${
        runtime.agent.messages.filter((message) => message.role === 'user').length
      } from you).`,
    );
  }

  tui.setInterruptHandler(() => {
    if (!controller) return false;
    if (abortRequested) {
      tui.stop();
      void runtime
        .saveSession()
        .catch(() => undefined)
        .finally(() => process.exit(130));
      return true;
    }
    abortRequested = true;
    controller.abort();
    tui.warn('Interrupting… (press Ctrl+C again to force exit)');
    return true;
  });

  try {
    while (true) {
      const line = await tui.readLine();
      if (line === null) break;

      const input = line.trim();
      if (!input) continue;

      if (input === '/exit' || input === '/quit' || input === '/q') break;

      if (input.startsWith('/')) {
        const keepGoing = await handleSlashCommand(runtime, input);
        tui.setIdle();
        updateStatus();
        if (!keepGoing) break;
        continue;
      }

      if (input.startsWith('!')) {
        await runShellEscape(runtime, input.slice(1).trim());
        tui.setIdle();
        continue;
      }

      const missing = connectionProblem(runtime);
      if (missing) {
        tui.warn(missing);
        tui.info(connectionHint(runtime));
        tui.setIdle();
        updateStatus();
        continue;
      }

      tui.addUserMessage(input);
      tui.setRunning(true);
      controller = new AbortController();
      abortRequested = false;

      try {
        const result = await runtime.agent.run(input, controller.signal);
        await runtime.saveSession();
        printTurnStats(runtime, result);
      } catch (error) {
        runtime.ui.error(describeApiError(error));
      } finally {
        controller = null;
        tui.setRunning(false);
        tui.setIdle();
        updateStatus();
      }
    }
  } finally {
    runtime.monitor.stop();
    tui.setInterruptHandler(null);
    try {
      await runtime.saveSession();
    } catch {
      // Ignore save failures on exit.
    }
    tui.stop();
  }
}
