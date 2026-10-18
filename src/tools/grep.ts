import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { matchesGlob } from '../utils/glob.js';
import { resolveWorkspacePath, relativeDisplayPath } from '../utils/paths.js';
import { errorMessage, truncate } from '../utils/text.js';
import {
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  requireString,
} from './shared.js';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  '.turbo',
  'dist',
  'build',
  'coverage',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_SCANNED = 5000;
const MAX_LINE_LENGTH = 300;

interface FoundFile {
  absolute: string;
  relative: string;
}

interface WalkState {
  files: FoundFile[];
  scanned: number;
  capped: boolean;
}

async function collectFiles(
  directory: string,
  relativeBase: string,
  glob: string | undefined,
  includeHidden: boolean,
  state: WalkState,
): Promise<void> {
  if (state.scanned >= MAX_FILES_SCANNED) {
    state.capped = true;
    return;
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (state.scanned >= MAX_FILES_SCANNED) {
      state.capped = true;
      return;
    }
    if (!includeHidden && entry.name.startsWith('.')) continue;

    const relative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await collectFiles(join(directory, entry.name), relative, glob, includeHidden, state);
    } else if (entry.isFile()) {
      state.scanned += 1;
      if (glob && !matchesGlob(relative, glob)) continue;
      state.files.push({ absolute: join(directory, entry.name), relative });
    }
  }
}

export const grepTool: Tool = {
  readOnly: true,
  definition: {
    name: 'grep',
    description:
      'Search file contents with a regular expression. Returns matching lines as path:line: text, or just the list of matching files. Skips binary files, .git, node_modules, and build output.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression to search for (JavaScript syntax).',
        },
        path: {
          type: 'string',
          description: 'File or directory to search. Defaults to the workspace root.',
        },
        glob: {
          type: 'string',
          description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.ts".',
        },
        ignore_case: {
          type: 'boolean',
          description: 'Case-insensitive matching. Defaults to false.',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files'],
          description:
            '"content" returns matching lines; "files" returns only file paths. Defaults to "content".',
        },
        max_results: {
          type: 'integer',
          description: 'Maximum matches (or files) to return. Defaults to 100.',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include dotfiles and dot-directories. Defaults to false.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },

  summarize(input: Record<string, unknown>): string {
    const pattern = typeof input.pattern === 'string' ? input.pattern : '';
    const path = typeof input.path === 'string' ? input.path : '.';
    return truncate(`${pattern} in ${path}`, 60);
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = requireString(input.pattern, 'pattern');
    const path = optionalString(input.path, 'path') ?? '.';
    const glob = optionalString(input.glob, 'glob');
    const ignoreCase = optionalBoolean(input.ignore_case, 'ignore_case', false);
    const outputMode = optionalEnum(
      input.output_mode,
      'output_mode',
      ['content', 'files'] as const,
      'content',
    );
    const maxResults = optionalInteger(input.max_results, 'max_results', 100, 1, 1000);
    const includeHidden = optionalBoolean(input.include_hidden, 'include_hidden', false);

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (error) {
      throw new Error(`Invalid regular expression: ${errorMessage(error)}`);
    }

    const absolute = resolveWorkspacePath(path, ctx.workspaceRoot, ctx.config.workspace.allowOutside);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`Path not found: ${path}`);

    let found: FoundFile[];
    let scanCapped = false;
    if (info.isDirectory()) {
      const state: WalkState = { files: [], scanned: 0, capped: false };
      await collectFiles(absolute, '', glob, includeHidden, state);
      found = state.files;
      scanCapped = state.capped;
    } else {
      found = [{ absolute, relative: basename(absolute) }];
    }

    const matches: string[] = [];
    const matchedFiles = new Set<string>();
    let resultCapped = false;

    outer: for (const file of found) {
      if (matches.length >= maxResults || matchedFiles.size >= maxResults) {
        resultCapped = true;
        break;
      }

      const fileInfo = await stat(file.absolute).catch(() => null);
      if (!fileInfo || !fileInfo.isFile() || fileInfo.size > MAX_FILE_BYTES) continue;

      let buffer: Buffer;
      try {
        buffer = await readFile(file.absolute);
      } catch {
        continue;
      }
      if (buffer.includes(0)) continue;

      const displayPath = relativeDisplayPath(file.absolute, ctx.workspaceRoot);
      const lines = buffer.toString('utf8').split('\n');

      for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? '').replace(/\r$/, '');
        if (!regex.test(line)) continue;

        matchedFiles.add(displayPath);
        if (outputMode === 'content') {
          matches.push(`${displayPath}:${index + 1}: ${truncate(line, MAX_LINE_LENGTH)}`);
          if (matches.length >= maxResults) {
            resultCapped = true;
            break outer;
          }
        } else if (matchedFiles.size >= maxResults) {
          resultCapped = true;
          break outer;
        }
      }
    }

    const modeLabel = ignoreCase ? `/${pattern}/i` : `/${pattern}/`;
    const scope = glob ? ` (glob: ${glob})` : '';
    const notes: string[] = [];
    if (resultCapped) {
      notes.push(`stopped after ${maxResults} result${maxResults === 1 ? '' : 's'}; raise max_results or narrow the search`);
    }
    if (scanCapped) {
      notes.push(`scanned only the first ${MAX_FILES_SCANNED} files`);
    }
    const footer = notes.length > 0 ? `\n\n(${notes.join('; ')})` : '';

    if (outputMode === 'files') {
      const list = [...matchedFiles];
      if (list.length === 0) {
        return { content: `No files matching ${modeLabel}${scope}.`, display: '0 files' };
      }
      return {
        content: `Files containing ${modeLabel}${scope} (${list.length}):\n${list.join('\n')}${footer}`,
        display: `${list.length} file${list.length === 1 ? '' : 's'}`,
      };
    }

    if (matches.length === 0) {
      return { content: `No matches for ${modeLabel}${scope}.`, display: '0 matches' };
    }

    return {
      content: `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} in ${
        matchedFiles.size
      } file${matchedFiles.size === 1 ? '' : 's'} for ${modeLabel}${scope}:\n${matches.join('\n')}${footer}`,
      display: `${matches.length} match${matches.length === 1 ? '' : 'es'}`,
    };
  },
};
