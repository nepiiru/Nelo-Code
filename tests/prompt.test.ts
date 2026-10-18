import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/prompt.js';
import { makeTempDir, removeTempDir } from './helpers.js';

describe('buildSystemPrompt', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir('nelo-prompt-');
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  it('describes the environment and tool guidance', () => {
    const prompt = buildSystemPrompt({
      cwd: workspace,
      platform: 'linux',
      date: new Date('2026-01-02T00:00:00Z'),
    });

    expect(prompt).toContain('You are Nelo Code');
    expect(prompt).toContain(workspace);
    expect(prompt).toContain('Linux');
    expect(prompt).toContain('2026-01-02');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('run_command');
    expect(prompt).toContain('Never commit');
  });

  it('includes project instruction files', async () => {
    await writeFile(join(workspace, 'NELO.md'), 'Always use tabs.\n');
    await writeFile(join(workspace, 'AGENTS.md'), 'Run tests before finishing.\n');

    const prompt = buildSystemPrompt({ cwd: workspace, platform: 'linux' });

    expect(prompt).toContain('Project instructions (NELO.md)');
    expect(prompt).toContain('Always use tabs.');
    expect(prompt).toContain('Project instructions (AGENTS.md)');
    expect(prompt).toContain('Run tests before finishing.');
  });

  it('lists top-level workspace entries without heavy directories', async () => {
    await writeFile(join(workspace, 'index.ts'), '');
    await writeFile(join(workspace, 'README.md'), '');

    const prompt = buildSystemPrompt({ cwd: workspace, platform: 'linux' });

    expect(prompt).toContain('index.ts');
    expect(prompt).toContain('README.md');
    expect(prompt).not.toContain('node_modules');
  });
});
