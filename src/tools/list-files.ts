import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { resolveWorkspacePath, relativeDisplayPath } from '../utils/paths.js';
import { errorMessage } from '../utils/text.js';
import { optionalBoolean, optionalInteger, optionalString } from './shared.js';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  '.turbo',
]);

interface TreeState {
  lines: string[];
  count: number;
  maxEntries: number;
  truncated: boolean;
}

async function walk(
  directory: string,
  relativeBase: string,
  depth: number,
  maxDepth: number,
  recursive: boolean,
  includeHidden: boolean,
  state: TreeState,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read directory "${relativeBase || '.'}": ${errorMessage(error)}`);
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (state.count >= state.maxEntries) {
      state.truncated = true;
      return;
    }
    if (!includeHidden && entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

    state.count += 1;
    const relative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    state.lines.push(entry.isDirectory() ? `${relative}/` : relative);

    if (entry.isDirectory() && recursive && depth + 1 < maxDepth) {
      await walk(join(directory, entry.name), relative, depth + 1, maxDepth, recursive, includeHidden, state);
    }
  }
}

export const listFilesTool: Tool = {
  readOnly: true,
  definition: {
    name: 'list_files',
    description:
      'List files and directories in the workspace. Set recursive to true to walk subdirectories (skips .git, node_modules, and other heavy directories).',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory (or file) path. Defaults to the workspace root.',
        },
        recursive: {
          type: 'boolean',
          description: 'Walk subdirectories. Defaults to false.',
        },
        max_depth: {
          type: 'integer',
          description: 'Maximum depth when recursive (default 3).',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include dotfiles and dot-directories. Defaults to false.',
        },
        max_entries: {
          type: 'integer',
          description: 'Maximum number of entries to return (default 500).',
        },
      },
      additionalProperties: false,
    },
  },

  summarize(input: Record<string, unknown>): string {
    const path = typeof input.path === 'string' ? input.path : '.';
    return input.recursive === true ? `${path} (recursive)` : path;
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = optionalString(input.path, 'path') ?? '.';
    const recursive = optionalBoolean(input.recursive, 'recursive', false);
    const maxDepth = optionalInteger(input.max_depth, 'max_depth', 3, 1, 20);
    const includeHidden = optionalBoolean(input.include_hidden, 'include_hidden', false);
    const maxEntries = optionalInteger(input.max_entries, 'max_entries', 500, 1, 5000);

    const absolute = resolveWorkspacePath(path, ctx.workspaceRoot, ctx.config.workspace.allowOutside);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`Path not found: ${path}`);

    if (!info.isDirectory()) {
      return {
        content: relativeDisplayPath(absolute, ctx.workspaceRoot),
        display: '1 entry',
      };
    }

    const state: TreeState = { lines: [], count: 0, maxEntries, truncated: false };
    await walk(absolute, '', 0, maxDepth, recursive, includeHidden, state);

    const header = `Listing ${relativeDisplayPath(absolute, ctx.workspaceRoot)}${
      recursive ? ` (recursive, depth ${maxDepth})` : ''
    }:`;
    const footer = state.truncated
      ? `\n\n(listing truncated at ${maxEntries} entries; raise max_entries or narrow the path)`
      : '';

    return {
      content: `${header}\n${state.lines.join('\n')}${footer}`,
      display: `${state.count} entr${state.count === 1 ? 'y' : 'ies'}`,
    };
  },
};
