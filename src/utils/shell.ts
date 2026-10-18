import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type ShellCommand =
  | { kind: 'posix'; command: string; args: string[] }
  | { kind: 'cmd' };

export interface ShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = env.PATH ?? env.Path ?? '';
  const directories = pathValue.split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const full = join(directory, name + extension);
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch {
        // Ignore unreadable PATH entries.
      }
    }
  }
  return null;
}

export function resolveShell(options: ShellOptions = {}): ShellCommand {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (env.NELO_SHELL) {
    return { kind: 'posix', command: env.NELO_SHELL, args: ['-c'] };
  }

  if (platform !== 'win32') {
    const shell = env.SHELL || '/bin/sh';
    return { kind: 'posix', command: shell, args: ['-c'] };
  }

  const candidates: string[] = [];
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  candidates.push(join(programFiles, 'Git', 'bin', 'bash.exe'));
  const programFilesX86 = env['ProgramFiles(x86)'];
  if (programFilesX86) candidates.push(join(programFilesX86, 'Git', 'bin', 'bash.exe'));
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return { kind: 'posix', command: candidate, args: ['-c'] };
  }

  const bashOnPath = findOnPath('bash', env);
  if (bashOnPath) return { kind: 'posix', command: bashOnPath, args: ['-c'] };

  return { kind: 'cmd' };
}
