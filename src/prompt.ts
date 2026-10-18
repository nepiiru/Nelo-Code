import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { truncate } from './utils/text.js';

export interface SystemPromptOptions {
  cwd: string;
  platform?: NodeJS.Platform;
  date?: Date;
}

const PROJECT_DOC_FILES = ['NELO.md', 'CLAUDE.md', 'AGENTS.md'];
const MAX_PROJECT_DOC_CHARS = 16000;

function platformName(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}

function runGit(args: string[], cwd: string): string | null {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    return typeof result.stdout === 'string' ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function gitSummary(cwd: string): string {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch) return 'not a git repository';
  const status = runGit(['status', '--porcelain'], cwd);
  const changes = status ? status.split('\n').filter(Boolean).length : 0;
  return `branch ${branch}, ${changes === 0 ? 'clean' : `${changes} uncommitted change(s)`}`;
}

function topLevelListing(cwd: string): string {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 40);
    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).join('\n');
  } catch {
    return '';
  }
}

function readProjectDoc(cwd: string, name: string): string | null {
  const path = join(cwd, name);
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const content = readFileSync(path, 'utf8').trim();
    if (!content) return null;
    if (content.length > MAX_PROJECT_DOC_CHARS) {
      return `${truncate(content, MAX_PROJECT_DOC_CHARS)}\n\n(truncated: ${name} is longer than ${MAX_PROJECT_DOC_CHARS} characters)`;
    }
    return content;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const platform = options.platform ?? process.platform;
  const date = (options.date ?? new Date()).toISOString().slice(0, 10);
  const sections: string[] = [];

  sections.push(
    'You are Nelo Code, an autonomous AI coding agent running in the user\'s terminal. ' +
      'You help with software engineering: exploring and explaining codebases, writing and modifying code, ' +
      'running commands, debugging, and answering technical questions.',
  );

  sections.push(
    [
      '# Environment',
      `- Working directory: ${options.cwd}`,
      `- Platform: ${platformName(platform)}`,
      `- Date: ${date}`,
      `- Git: ${gitSummary(options.cwd)}`,
    ].join('\n'),
  );

  const listing = topLevelListing(options.cwd);
  if (listing) sections.push(`# Workspace (top level)\n${listing}`);

  for (const name of PROJECT_DOC_FILES) {
    const content = readProjectDoc(options.cwd, name);
    if (content) sections.push(`# Project instructions (${name})\n${content}`);
  }

  sections.push(
    [
      '# How to work',
      '- Use the dedicated tools to inspect and change the workspace: read_file, list_files, grep, edit_file, write_file, and run_command.',
      '- Always read a file before editing it. Make focused changes that match the existing style; avoid unrelated refactors.',
      '- For non-trivial tasks, briefly state your plan, then execute it step by step.',
      '- After changing code, run the relevant tests, type checks, or build commands when available, and report the real result.',
      '- When searching, prefer grep over reading entire large files. Use read_file with offset and limit for big files.',
      '- Reference code locations as path:line so the user can find them.',
      '- Never fabricate command output or test results. If something fails, show the actual error and work from it.',
      '- When you are done, summarize what changed and any remaining risks or follow-up work.',
    ].join('\n'),
  );

  sections.push(
    [
      '# Tone',
      '- Be concise and direct. Skip preambles like "Sure" or "Great question".',
      '- Use markdown when it helps: short paragraphs, bullet lists, and fenced code blocks with a language tag.',
      '- Explain the "why" behind important decisions, not every line of code.',
      '- If the request is ambiguous and the choice matters, ask one focused question; otherwise make a reasonable assumption and state it.',
    ].join('\n'),
  );

  sections.push(
    [
      '# Safety',
      '- Do not run destructive or irreversible commands unless the user clearly asked for them. Prefer reversible operations.',
      '- Never commit, push, or publish changes unless the user explicitly asks.',
      '- Do not expose secrets from files or environment variables.',
    ].join('\n'),
  );

  return sections.join('\n\n');
}
