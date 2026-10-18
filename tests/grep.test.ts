import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grepTool } from '../src/tools/grep.js';
import { makeTempDir, removeTempDir, toolContext } from './helpers.js';

describe('grep', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir('nelo-grep-');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.ts'), 'const foo = 1;\nconst bar = 2;\n');
    await writeFile(join(workspace, 'src', 'b.js'), 'foo();\n');
    await writeFile(join(workspace, 'node_modules', 'pkg', 'x.ts'), 'foo\n');
    await writeFile(join(workspace, '.hidden.ts'), 'foo\n');
    await writeFile(join(workspace, 'binary.bin'), Buffer.from([0x66, 0x6f, 0x6f, 0x00]));
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  it('finds matching lines and skips ignored or hidden paths', async () => {
    const result = await grepTool.execute({ pattern: 'foo' }, toolContext(workspace));

    expect(result.content).toContain('src/a.ts:1');
    expect(result.content).toContain('src/b.js:1');
    expect(result.content).not.toContain('node_modules');
    expect(result.content).not.toContain('.hidden.ts');
    expect(result.content).not.toContain('binary.bin');
    expect(result.display).toBe('2 matches');
  });

  it('filters by glob', async () => {
    const result = await grepTool.execute(
      { pattern: 'foo', glob: '*.ts' },
      toolContext(workspace),
    );
    expect(result.content).toContain('src/a.ts');
    expect(result.content).not.toContain('src/b.js');
  });

  it('supports files output mode', async () => {
    const result = await grepTool.execute(
      { pattern: 'foo', output_mode: 'files' },
      toolContext(workspace),
    );
    expect(result.content).toContain('src/a.ts');
    expect(result.content).toContain('src/b.js');
    expect(result.display).toBe('2 files');
  });

  it('supports case-insensitive search', async () => {
    const result = await grepTool.execute(
      { pattern: 'FOO', ignore_case: true },
      toolContext(workspace),
    );
    expect(result.display).toBe('2 matches');
  });

  it('reports no matches clearly', async () => {
    const result = await grepTool.execute({ pattern: 'zzz' }, toolContext(workspace));
    expect(result.content).toContain('No matches');
    expect(result.display).toBe('0 matches');
  });

  it('caps results and says so', async () => {
    const result = await grepTool.execute(
      { pattern: 'foo', max_results: 1 },
      toolContext(workspace),
    );
    expect(result.display).toBe('1 match');
    expect(result.content).toContain('stopped after 1 result');
  });

  it('rejects invalid regular expressions', async () => {
    await expect(
      grepTool.execute({ pattern: '[unclosed' }, toolContext(workspace)),
    ).rejects.toThrow(/Invalid regular expression/);
  });
});
