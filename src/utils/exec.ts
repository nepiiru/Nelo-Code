import { spawn, type ChildProcess } from 'node:child_process';
import { resolveShell } from './shell.js';
import { errorMessage } from './text.js';

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  truncated: boolean;
}

const CAPTURE_LIMIT_BYTES = 5 * 1024 * 1024;

export function runShellCommand(command: string, options: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 120000;
    const shell = resolveShell();

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let truncated = false;
    let capturedBytes = 0;
    let timer: NodeJS.Timeout | undefined;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        truncated,
      });
    };

    let child: ChildProcess;
    try {
      if (shell.kind === 'posix') {
        child = spawn(shell.command, [...shell.args, command], {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } else {
        child = spawn(command, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
          windowsHide: true,
        });
      }
    } catch (error) {
      resolvePromise({
        exitCode: null,
        stdout: '',
        stderr: errorMessage(error),
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - started,
        truncated: false,
      });
      return;
    }

    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      if (capturedBytes >= CAPTURE_LIMIT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = CAPTURE_LIMIT_BYTES - capturedBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (slice.length < chunk.length) truncated = true;
      target.push(Buffer.from(slice));
      capturedBytes += slice.length;
    };

    child.stdout?.on('data', collect(stdoutChunks));
    child.stderr?.on('data', collect(stderrChunks));

    const killTree = (): void => {
      if (child.pid == null) return;
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch {
          // Ignore kill failures.
        }
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore kill failures.
          }
        }
      }
      const fallback = setTimeout(() => finish(null), 5000);
      fallback.unref?.();
    };

    const onAbort = (): void => {
      aborted = true;
      killTree();
    };

    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      stderrChunks.push(Buffer.from(errorMessage(error)));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
