import { afterEach, describe, expect, it } from 'vitest';
import { connectionHint, connectionProblem, createRuntime } from '../src/app.js';
import { defaultConfig } from '../src/config.js';
import { getProviderPreset } from '../src/providers.js';
import { makeTempDir, removeTempDir, TestUI } from './helpers.js';

describe('createRuntime without a usable provider', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await removeTempDir(dir);
    dir = null;
  });

  it('starts in a disconnected state instead of throwing', async () => {
    dir = await makeTempDir();
    const config = defaultConfig();
    const runtime = await createRuntime({
      config,
      loaded: { config, sources: { env: [] } },
      cwd: dir,
      ui: new TestUI(),
      provider: null,
      providerError: 'No model provider found.',
    });

    expect(runtime.provider).toBeNull();
    expect(connectionProblem(runtime)).toContain('No model provider found');
    expect(connectionHint(runtime)).toContain('/provider');

    // The placeholder client fails with the same explanation instead of crashing.
    await expect(
      runtime.client.stream(
        {
          model: '',
          maxTokens: 1,
          system: '',
          messages: [],
          tools: [],
        },
        { onText: () => undefined },
      ),
    ).rejects.toThrow('No model provider found');
  });

  it('starts when a provider is selected but no model is loaded', async () => {
    dir = await makeTempDir();
    const config = defaultConfig();
    const preset = getProviderPreset('anthropic');
    const runtime = await createRuntime({
      config,
      loaded: { config, sources: { env: [] } },
      cwd: dir,
      ui: new TestUI(),
      provider: {
        id: 'anthropic',
        preset,
        apiKey: 'test-key',
        model: '',
        contextWindow: preset.contextWindow,
        detected: false,
      },
    });

    expect(runtime.provider?.id).toBe('anthropic');
    expect(runtime.config.model).toBe('');
    expect(connectionProblem(runtime)).toContain('no model is loaded');
    expect(connectionHint(runtime)).toContain('/provider anthropic');
  });
});
