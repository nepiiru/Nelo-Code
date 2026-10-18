import type { Tool, ToolContext, ToolResult } from '../types.js';
import { runShellCommand } from '../utils/exec.js';
import { truncate, truncateMiddle } from '../utils/text.js';
import { optionalInteger, requireString } from './shared.js';

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_OUTPUT_CHARS = 20000;

export const runCommandTool: Tool = {
  readOnly: false,
  definition: {
    name: 'run_command',
    description:
      'Run a shell command in the workspace and return its stdout, stderr, and exit code. Use for builds, tests, package managers, git, and other CLI operations. The command runs non-interactively, so avoid commands that wait for user input. On Windows, commands run through Git Bash when it is available.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run.',
        },
        timeout_ms: {
          type: 'integer',
          description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },

  summarize(input: Record<string, unknown>): string {
    return typeof input.command === 'string' ? truncate(input.command.replace(/\s+/g, ' ').trim(), 70) : '';
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = requireString(input.command, 'command');
    const timeoutMs = optionalInteger(input.timeout_ms, 'timeout_ms', DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);

    const result = await runShellCommand(command, {
      cwd: ctx.workspaceRoot,
      timeoutMs,
      signal: ctx.signal,
    });

    const seconds = (result.durationMs / 1000).toFixed(1);
    const status: string[] = [`exit code: ${result.exitCode ?? 'unknown'} (${seconds}s)`];
    if (result.timedOut) status.push('[timed out]');
    if (result.aborted) status.push('[aborted]');
    if (result.truncated) status.push('[output truncated]');

    const parts: string[] = [`$ ${command}`, status.join(' ')];
    if (result.stdout.trim()) {
      parts.push(`stdout:\n${truncateMiddle(result.stdout.trimEnd(), MAX_OUTPUT_CHARS)}`);
    }
    if (result.stderr.trim()) {
      parts.push(`stderr:\n${truncateMiddle(result.stderr.trimEnd(), MAX_OUTPUT_CHARS)}`);
    }
    if (!result.stdout.trim() && !result.stderr.trim()) {
      parts.push('(no output)');
    }

    let display: string;
    if (result.timedOut) display = `timed out after ${seconds}s`;
    else if (result.aborted) display = 'aborted';
    else display = `exit ${result.exitCode ?? '?'} · ${seconds}s`;

    return {
      content: parts.join('\n\n'),
      isError: result.timedOut || result.aborted,
      display,
    };
  },
};
