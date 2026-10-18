import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function resolveWorkspacePath(
  input: string,
  workspaceRoot: string,
  allowOutside = false,
): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('path must be a non-empty string.');
  }

  let target = input.trim();
  if (target === '~') {
    target = homedir();
  } else if (target.startsWith('~/') || target.startsWith('~\\')) {
    target = resolve(homedir(), target.slice(2));
  }

  const absolute = isAbsolute(target) ? resolve(target) : resolve(workspaceRoot, target);

  if (!allowOutside) {
    const rel = relative(workspaceRoot, absolute);
    if (rel === '') return absolute;
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        `Path "${input}" is outside the workspace (${workspaceRoot}). ` +
          'Set "workspace.allowOutside": true in the config to allow access outside the workspace.',
      );
    }
  }

  return absolute;
}

export function relativeDisplayPath(absolute: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, absolute);
  if (rel === '') return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return absolute;
  return rel.split(sep).join('/');
}
