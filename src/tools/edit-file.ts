import { readFile, stat, writeFile } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { resolveWorkspacePath, relativeDisplayPath } from '../utils/paths.js';
import { optionalBoolean, requireString } from './shared.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < content.length; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

export const editFileTool: Tool = {
  readOnly: false,
  definition: {
    name: 'edit_file',
    description:
      'Replace an exact string in an existing file. The old_string must match the file contents exactly, including indentation. If old_string appears more than once, include more surrounding context to make it unique, or set replace_all to true. Always read the file before editing it.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path, relative to the workspace root or absolute.',
        },
        old_string: {
          type: 'string',
          description: 'The exact text to replace. Must be unique unless replace_all is true.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence of old_string. Defaults to false.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },

  summarize(input: Record<string, unknown>): string {
    return typeof input.path === 'string' ? input.path : '';
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = requireString(input.path, 'path');
    const oldString = requireString(input.old_string, 'old_string');
    const newString = requireString(input.new_string, 'new_string');
    const replaceAll = optionalBoolean(input.replace_all, 'replace_all', false);

    if (oldString.length === 0) throw new Error('"old_string" must not be empty.');

    const absolute = resolveWorkspacePath(path, ctx.workspaceRoot, ctx.config.workspace.allowOutside);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`File not found: ${path}`);
    if (info.isDirectory()) throw new Error(`"${path}" is a directory.`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`File is too large to edit (${path}).`);

    const raw = await readFile(absolute, 'utf8');
    const usesCrlf = raw.includes('\r\n');
    const content = usesCrlf ? raw.replace(/\r\n/g, '\n') : raw;
    const search = oldString.replace(/\r\n/g, '\n');
    const replacement = newString.replace(/\r\n/g, '\n');

    const firstIndex = content.indexOf(search);
    if (firstIndex === -1) {
      throw new Error(
        `old_string was not found in ${relativeDisplayPath(absolute, ctx.workspaceRoot)}. ` +
          'Read the file again and copy the exact text, including whitespace.',
      );
    }

    let count: number;
    let updated: string;
    if (replaceAll) {
      count = content.split(search).length - 1;
      updated = content.split(search).join(replacement);
    } else {
      const secondIndex = content.indexOf(search, firstIndex + search.length);
      if (secondIndex !== -1) {
        const firstLine = lineNumberAt(content, firstIndex);
        const secondLine = lineNumberAt(content, secondIndex);
        throw new Error(
          `old_string appears multiple times in ${relativeDisplayPath(absolute, ctx.workspaceRoot)} ` +
            `(at least at lines ${firstLine} and ${secondLine}). Include more surrounding context ` +
            'to make it unique, or set replace_all to true.',
        );
      }
      count = 1;
      updated = content.slice(0, firstIndex) + replacement + content.slice(firstIndex + search.length);
    }

    const output = usesCrlf ? updated.replace(/\n/g, '\r\n') : updated;
    await writeFile(absolute, output, 'utf8');

    const line = lineNumberAt(content, firstIndex);
    return {
      content: `Applied ${count} replacement${count === 1 ? '' : 's'} to ${relativeDisplayPath(
        absolute,
        ctx.workspaceRoot,
      )}${replaceAll ? '' : ` at line ${line}`}.`,
      display: `${count} replacement${count === 1 ? '' : 's'}`,
    };
  },
};
