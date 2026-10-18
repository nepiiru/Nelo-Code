import type { Config } from './config.js';
import { assessCommand } from './command-safety.js';
import type { Tool } from './types.js';

export type PermissionAnswer = 'yes' | 'no' | 'always';

export interface PermissionRequest {
  tool: Tool;
  input: Record<string, unknown>;
  summary: string;
}

export interface PermissionVerdict {
  allowed: boolean;
  message?: string;
}

export type AskPermission = (request: PermissionRequest) => Promise<PermissionAnswer>;

export function scopeKey(tool: Tool, input: Record<string, unknown>): string {
  if (tool.definition.name === 'run_command' && typeof input.command === 'string') {
    const firstToken = input.command.trim().split(/\s+/)[0] ?? '';
    return `run_command:${firstToken}`;
  }
  return tool.definition.name;
}

function safeSummary(tool: Tool, input: Record<string, unknown>): string {
  try {
    return tool.summarize(input);
  } catch {
    return '';
  }
}

export class PermissionManager {
  private readonly sessionAllows = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly ask: AskPermission,
  ) {}

  async authorize(tool: Tool, input: Record<string, unknown>): Promise<PermissionVerdict> {
    if (tool.definition.name === 'run_command') {
      const command = typeof input.command === 'string' ? input.command : '';
      const assessment = assessCommand(command);
      if (assessment.dangerous) {
        return {
          allowed: false,
          message: assessment.reason ?? 'This command is blocked for safety reasons.',
        };
      }
      for (const pattern of this.config.permissions.denyCommands) {
        try {
          if (new RegExp(pattern).test(command)) {
            return { allowed: false, message: `The command matches a denied pattern: ${pattern}` };
          }
        } catch {
          // Ignore invalid user-supplied patterns.
        }
      }
    }

    if (this.config.permissions.mode === 'readonly') {
      return tool.readOnly
        ? { allowed: true }
        : { allowed: false, message: 'The session is in read-only mode; mutating tools are disabled.' };
    }

    if (this.config.permissions.mode === 'auto') return { allowed: true };
    if (tool.readOnly) return { allowed: true };
    if (this.config.permissions.allow.includes(tool.definition.name)) return { allowed: true };

    const scope = scopeKey(tool, input);
    if (this.sessionAllows.has(scope)) return { allowed: true };

    const answer = await this.ask({ tool, input, summary: safeSummary(tool, input) });
    if (answer === 'yes') return { allowed: true };
    if (answer === 'always') {
      this.sessionAllows.add(scope);
      return { allowed: true };
    }
    return { allowed: false, message: 'The user declined this tool call.' };
  }
}
