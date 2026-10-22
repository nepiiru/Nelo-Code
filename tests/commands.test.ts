import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../src/app.js';
import { handleSlashCommand } from '../src/commands.js';
import { defaultConfig } from '../src/config.js';
import { BUILTIN_THEMES, getActiveTheme, setActiveTheme } from '../src/ui/theme.js';
import { makeTempDir, removeTempDir, TestUI } from './helpers.js';

describe('slash-command selection windows', () => {
  let dir: string | null = null;

  afterEach(async () => {
    setActiveTheme(BUILTIN_THEMES.nelo!);
    if (dir) await removeTempDir(dir);
    dir = null;
  });

  async function setup(selectAnswers: Array<string | null>): Promise<{
    runtime: Awaited<ReturnType<typeof createRuntime>>;
    ui: TestUI;
  }> {
    dir = await makeTempDir();
    const config = defaultConfig();
    const ui = new TestUI([], selectAnswers);
    const runtime = await createRuntime({
      config,
      loaded: { config, sources: { env: [] } },
      cwd: dir,
      ui,
      provider: null,
      providerError: 'No model provider found.',
    });
    return { runtime, ui };
  }

  it('selects a model from the model window', async () => {
    const { runtime, ui } = await setup(['claude-haiku-5-5']);
    await handleSlashCommand(runtime, '/model');

    const request = ui.selectRequests[0];
    expect(request?.title).toBe('Select model');
    expect(request?.selected).toBe(defaultConfig().model);
    expect(request?.options.find((option) => option.label === 'haiku')?.value).toBe(
      'claude-haiku-5-5',
    );
    expect(runtime.config.model).toBe('claude-haiku-5-5');
  });

  it('includes models discovered from the provider endpoint', async () => {
    const { runtime, ui } = await setup(['local-a']);
    runtime.client.listModels = async () => ['local-a'];
    await handleSlashCommand(runtime, '/model');

    expect(ui.selectRequests[0]?.options.map((option) => option.value)).toContain('local-a');
    expect(runtime.config.model).toBe('local-a');
  });

  it('keeps argument-based model switching window-free', async () => {
    const { runtime, ui } = await setup([]);
    await handleSlashCommand(runtime, '/model haiku');

    expect(ui.selectRequests).toHaveLength(0);
    expect(runtime.config.model).toBe('claude-haiku-5-5');
  });

  it('opens the provider window and cancels without connecting', async () => {
    const { runtime, ui } = await setup([null]);
    await handleSlashCommand(runtime, '/provider');

    const request = ui.selectRequests[0];
    expect(request?.title).toBe('Select provider');
    expect(request?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(['auto', 'ollama', 'anthropic']),
    );
    expect(runtime.provider).toBeNull();
  });

  it('selects a permission mode from the permissions window', async () => {
    const { runtime, ui } = await setup(['readonly']);
    await handleSlashCommand(runtime, '/permissions');

    expect(ui.selectRequests[0]?.title).toBe('Select permission mode');
    expect(runtime.config.permissions.mode).toBe('readonly');
  });

  it('selects a theme from the theme window', async () => {
    const { runtime, ui } = await setup(['mono']);
    await handleSlashCommand(runtime, '/theme');

    expect(ui.selectRequests[0]?.title).toBe('Select theme');
    expect(getActiveTheme().name).toBe('mono');
  });
});
