import { readFile, stat } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { resolveWorkspacePath, relativeDisplayPath } from '../utils/paths.js';
import { formatBytes } from '../utils/text.js';
import { optionalInteger, requireString } from './shared.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

export const readFileTool: Tool = {
  readOnly: true,
  definition: {
    name: 'read_file',
    description:
      'Read a text file from the workspace. Returns the content with line numbers so you can reference exact locations. Use offset and limit to page through large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path, relative to the workspace root or absolute.',
        },
        offset: {
          type: 'integer',
          description: '1-based line number to start reading from. Defaults to 1.',
        },
        limit: {
          type: 'integer',
          description: `Maximum number of lines to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },

  summarize(input: Record<string, unknown>): string {
    return typeof input.path === 'string' ? input.path : '';
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = requireString(input.path, 'path');
    const absolute = resolveWorkspacePath(path, ctx.workspaceRoot, ctx.config.workspace.allowOutside);

    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`File not found: ${path}`);
    if (info.isDirectory()) throw new Error(`"${path}" is a directory. Use list_files instead.`);
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(
        `File is too large (${formatBytes(info.size)}). Maximum is ${formatBytes(MAX_FILE_BYTES)}.`,
      );
    }

    const buffer = await readFile(absolute);
    if (buffer.includes(0)) throw new Error(`"${path}" appears to be a binary file.`);

    const content = buffer.toString('utf8');
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;

    if (total === 0) {
      return { content: `(empty file: ${relativeDisplayPath(absolute, ctx.workspaceRoot)})`, display: '0 lines' };
    }

    const offset = optionalInteger(input.offset, 'offset', 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(input.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);

    if (offset > total) {
      throw new Error(`Offset ${offset} is past the end of the file (${total} lines).`);
    }

    const start = offset - 1;
    const end = Math.min(total, start + limit);
    const numbered = lines
      .slice(start, end)
      .map((line, index) => `${String(start + index + 1).padStart(6)}\t${line.replace(/\r$/, '')}`)
      .join('\n');

    const shown = end - start;
    const footer =
      end < total
        ? `\n\n(showing lines ${offset}-${end} of ${total}; call read_file again with offset=${end + 1} to continue)`
        : '';

    return {
      content: numbered + footer,
      display: `${shown} line${shown === 1 ? '' : 's'}`,
    };
  },
};
