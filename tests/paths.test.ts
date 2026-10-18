import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { relativeDisplayPath, resolveWorkspacePath } from '../src/utils/paths.js';

const root = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';

describe('resolveWorkspacePath', () => {
  it('resolves relative paths inside the workspace', () => {
    expect(resolveWorkspacePath('src/index.ts', root)).toBe(join(root, 'src/index.ts'));
    expect(resolveWorkspacePath('.', root)).toBe(root);
  });

  it('rejects paths that escape the workspace', () => {
    expect(() => resolveWorkspacePath('../secret.txt', root)).toThrow(/outside the workspace/);
    expect(() => resolveWorkspacePath('src/../../secret.txt', root)).toThrow(/outside the workspace/);
  });

  it('rejects absolute paths outside the workspace', () => {
    expect(() => resolveWorkspacePath(outside, root)).toThrow(/outside the workspace/);
  });

  it('allows outside paths when configured', () => {
    expect(resolveWorkspacePath(outside, root, true)).toBe(outside);
  });

  it('expands a leading tilde', () => {
    expect(resolveWorkspacePath('~/notes.txt', root, true)).toBe(join(homedir(), 'notes.txt'));
  });

  it('rejects empty paths', () => {
    expect(() => resolveWorkspacePath('', root)).toThrow(/non-empty/);
  });
});

describe('relativeDisplayPath', () => {
  it('returns workspace-relative paths with forward slashes', () => {
    expect(relativeDisplayPath(join(root, 'a', 'b.ts'), root)).toBe('a/b.ts');
    expect(relativeDisplayPath(root, root)).toBe('.');
  });
});
