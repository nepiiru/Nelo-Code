import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editFileTool } from '../src/tools/edit-file.js';
import { listFilesTool } from '../src/tools/list-files.js';
import { readFileTool } from '../src/tools/read-file.js';
import { writeFileTool } from '../src/tools/write-file.js';
import { makeTempDir, removeTempDir, toolContext } from './helpers.js';

describe('file tools', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir('nelo-files-');
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  describe('read_file', () => {
    it('returns numbered lines', async () => {
      await writeFile(join(workspace, 'a.txt'), 'alpha\nbeta\ngamma\n');
      const result = await readFileTool.execute({ path: 'a.txt' }, toolContext(workspace));

      expect(result.content).toContain('     1\talpha');
      expect(result.content).toContain('     2\tbeta');
      expect(result.content).toContain('     3\tgamma');
      expect(result.display).toBe('3 lines');
    });

    it('supports offset and limit with a continuation footer', async () => {
      await writeFile(join(workspace, 'a.txt'), '1\n2\n3\n4\n5\n');
      const result = await readFileTool.execute(
        { path: 'a.txt', offset: 2, limit: 2 },
        toolContext(workspace),
      );

      expect(result.content).toContain('     2\t2');
      expect(result.content).toContain('     3\t3');
      expect(result.content).not.toContain('\t4');
      expect(result.content).toContain('showing lines 2-3 of 5');
    });

    it('reports empty files', async () => {
      await writeFile(join(workspace, 'empty.txt'), '');
      const result = await readFileTool.execute({ path: 'empty.txt' }, toolContext(workspace));
      expect(result.content).toContain('empty file');
      expect(result.display).toBe('0 lines');
    });

    it('rejects binary files', async () => {
      await writeFile(join(workspace, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
      await expect(
        readFileTool.execute({ path: 'bin.dat' }, toolContext(workspace)),
      ).rejects.toThrow(/binary/);
    });

    it('rejects paths outside the workspace', async () => {
      await expect(
        readFileTool.execute({ path: '../escape.txt' }, toolContext(workspace)),
      ).rejects.toThrow(/outside the workspace/);
    });
  });

  describe('write_file', () => {
    it('creates nested directories and reports created vs updated', async () => {
      const first = await writeFileTool.execute(
        { path: 'deep/nested/file.txt', content: 'hello\n' },
        toolContext(workspace),
      );
      expect(first.content).toContain('Created deep/nested/file.txt');
      expect(first.display).toBe('created');
      expect(await readFile(join(workspace, 'deep', 'nested', 'file.txt'), 'utf8')).toBe('hello\n');

      const second = await writeFileTool.execute(
        { path: 'deep/nested/file.txt', content: 'hello again\n' },
        toolContext(workspace),
      );
      expect(second.display).toBe('updated');
    });
  });

  describe('edit_file', () => {
    it('replaces a unique string and reports the line', async () => {
      await writeFile(join(workspace, 'code.ts'), 'const a = 1;\nconst b = 2;\n');
      const result = await editFileTool.execute(
        { path: 'code.ts', old_string: 'const b = 2;', new_string: 'const b = 3;' },
        toolContext(workspace),
      );

      expect(result.content).toContain('line 2');
      expect(result.display).toBe('1 replacement');
      expect(await readFile(join(workspace, 'code.ts'), 'utf8')).toBe('const a = 1;\nconst b = 3;\n');
    });

    it('refuses ambiguous edits unless replace_all is set', async () => {
      await writeFile(join(workspace, 'dup.txt'), 'foo\nfoo\n');
      await expect(
        editFileTool.execute({ path: 'dup.txt', old_string: 'foo', new_string: 'bar' }, toolContext(workspace)),
      ).rejects.toThrow(/multiple times/);

      const result = await editFileTool.execute(
        { path: 'dup.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
        toolContext(workspace),
      );
      expect(result.content).toContain('2 replacements');
      expect(await readFile(join(workspace, 'dup.txt'), 'utf8')).toBe('bar\nbar\n');
    });

    it('errors when the old string is missing', async () => {
      await writeFile(join(workspace, 'a.txt'), 'hello\n');
      await expect(
        editFileTool.execute({ path: 'a.txt', old_string: 'nope', new_string: 'x' }, toolContext(workspace)),
      ).rejects.toThrow(/not found/);
    });

    it('preserves CRLF line endings', async () => {
      await writeFile(join(workspace, 'crlf.txt'), 'line1\r\nline2\r\n');
      await editFileTool.execute(
        { path: 'crlf.txt', old_string: 'line2', new_string: 'LINE2' },
        toolContext(workspace),
      );
      expect(await readFile(join(workspace, 'crlf.txt'), 'utf8')).toBe('line1\r\nLINE2\r\n');
    });
  });

  describe('list_files', () => {
    beforeEach(async () => {
      await mkdir(join(workspace, 'sub'), { recursive: true });
      await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(workspace, 'a.txt'), 'a');
      await writeFile(join(workspace, 'sub', 'b.ts'), 'b');
      await writeFile(join(workspace, 'node_modules', 'pkg', 'x.js'), 'x');
      await writeFile(join(workspace, '.hidden'), 'h');
    });

    it('lists the top level only by default', async () => {
      const result = await listFilesTool.execute({ path: '.' }, toolContext(workspace));
      expect(result.content).toContain('a.txt');
      expect(result.content).toContain('sub/');
      expect(result.content).not.toContain('b.ts');
      expect(result.content).not.toContain('node_modules/');
      expect(result.content).not.toContain('.hidden');
    });

    it('walks recursively while skipping heavy directories', async () => {
      const result = await listFilesTool.execute(
        { path: '.', recursive: true },
        toolContext(workspace),
      );
      expect(result.content).toContain('sub/b.ts');
      expect(result.content).not.toContain('node_modules');
    });

    it('truncates at max_entries', async () => {
      const result = await listFilesTool.execute(
        { path: '.', recursive: true, max_entries: 1 },
        toolContext(workspace),
      );
      expect(result.content).toContain('listing truncated');
    });
  });
});
