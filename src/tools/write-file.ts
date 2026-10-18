import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { resolveWorkspacePath, relativeDisplayPath } from '../utils/paths.js';
import { countLines, formatBytes } from '../utils/text.js';
import { requireString } from './shared.js';

export const writeFileTool: Tool = {
  readOnly: false,
  definition: {
    name: 'write_file',
    description:
      'Write a complete file to the workspace, creating parent directories as needed. Overwrites the file if it already exists. For small changes to existing files, prefer edit_file.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path, relative to the workspace root or absolute.',
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },

  summarize(input: Record<string, unknown>): string {
    return typeof input.path === 'string' ? input.path : '';
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = requireString(input.path, 'path');
    const content = requireString(input.content, 'content');
    const absolute = resolveWorkspacePath(path, ctx.workspaceRoot, ctx.config.workspace.allowOutside);

    const existing = await stat(absolute).catch(() => null);
    if (existing?.isDirectory()) throw new Error(`"${path}" is a directory.`);

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');

    const bytes = Buffer.byteLength(content, 'utf8');
    const displayPath = relativeDisplayPath(absolute, ctx.workspaceRoot);
    const verb = existing ? 'Overwrote' : 'Created';

    return {
      content: `${verb} ${displayPath} (${countLines(content)} lines, ${formatBytes(bytes)}).`,
      display: existing ? 'updated' : 'created',
    };
  },
};
