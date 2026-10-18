import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyCliOverrides,
  defaultConfig,
  loadConfig,
  maskApiKey,
  mergeConfig,
  parsePermissionMode,
  resolveModelAlias,
} from '../src/config.js';

describe('config', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'nelo-config-'));
    dirs.push(dir);
    return dir;
  }

  it('returns defaults when no config files exist', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    const loaded = loadConfig({ cwd, home, env: {} });

    expect(loaded.config.model).toBe('claude-sonnet-5-5');
    expect(loaded.config.permissions.mode).toBe('ask');
    expect(loaded.config.context.maxTokens).toBe(200000);
    expect(loaded.sources.global).toBeUndefined();
    expect(loaded.sources.project).toBeUndefined();
  });

  it('merges global, then project, then environment', async () => {
    const home = await tempDir();
    const cwd = await tempDir();

    await mkdir(join(home, '.nelo'), { recursive: true });
    await writeFile(
      join(home, '.nelo', 'config.json'),
      JSON.stringify({ model: 'opus', maxTokens: 1000, permissions: { mode: 'readonly' } }),
    );
    await mkdir(join(cwd, '.nelo'), { recursive: true });
    await writeFile(
      join(cwd, '.nelo', 'config.json'),
      JSON.stringify({ model: 'haiku', context: { compactAt: 0.5 } }),
    );

    const loaded = loadConfig({
      cwd,
      home,
      env: { NELO_MODEL: 'fable', ANTHROPIC_API_KEY: 'sk-test-123456789' },
    });

    expect(loaded.config.model).toBe('claude-fable-5-1');
    expect(loaded.config.maxTokens).toBe(1000);
    expect(loaded.config.permissions.mode).toBe('readonly');
    expect(loaded.config.context.compactAt).toBe(0.5);
    expect(loaded.config.apiKey).toBe('sk-test-123456789');
    expect(loaded.sources.env).toContain('NELO_MODEL');
    expect(loaded.sources.env).toContain('ANTHROPIC_API_KEY');
  });

  it('reports malformed config files with their path', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await mkdir(join(home, '.nelo'), { recursive: true });
    await writeFile(join(home, '.nelo', 'config.json'), '{ not json');

    expect(() => loadConfig({ cwd, home, env: {} })).toThrow(/Failed to parse config file/);
  });

  it('rejects invalid permission modes', () => {
    expect(() => parsePermissionMode('yolo')).toThrow(/Invalid permission mode/);
    expect(parsePermissionMode('AUTO')).toBe('auto');
  });

  it('resolves model aliases and leaves custom ids alone', () => {
    expect(resolveModelAlias('opus')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('SONNET')).toBe('claude-sonnet-5-5');
    expect(resolveModelAlias('claude-custom-1')).toBe('claude-custom-1');
  });

  it('masks API keys', () => {
    expect(maskApiKey('sk-ant-1234567890')).toBe('sk-a…7890');
    expect(maskApiKey('short')).toBe('****');
  });

  it('applies CLI overrides', () => {
    const config = defaultConfig();
    applyCliOverrides(config, { model: 'sonnet', maxTokens: 1234, mode: 'auto' });
    expect(config.model).toBe('claude-sonnet-5-5');
    expect(config.maxTokens).toBe(1234);
    expect(config.permissions.mode).toBe('auto');
  });

  it('rejects invalid values from a config file', () => {
    expect(() => mergeConfig(defaultConfig(), { maxTokens: 0 }, 'test')).toThrow(/maxTokens/);
    expect(() => mergeConfig(defaultConfig(), { permissions: { mode: 'nope' } }, 'test')).toThrow(
      /Invalid permission mode/,
    );
  });

  it('rejects invalid environment values', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    expect(() => loadConfig({ cwd, home, env: { NELO_MAX_TOKENS: 'abc' } })).toThrow(
      /NELO_MAX_TOKENS/,
    );
  });
});
