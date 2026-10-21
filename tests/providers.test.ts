import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from '../src/config.js';
import {
  applyProviderDefaults,
  describeProvider,
  getProviderPreset,
  listProviderPresets,
  normalizeBaseURL,
  probeProvider,
  resolveProvider,
  type ProviderPreset,
} from '../src/providers.js';

function configWith(patch: Partial<Config>): Config {
  return { ...defaultConfig(), ...patch };
}

async function startModelsServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'served-model' }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('provider templates', () => {
  it('lists a template for every documented provider', () => {
    const ids = listProviderPresets().map((preset) => preset.id);
    expect(ids).toEqual([
      'ollama',
      'lmstudio',
      'omniroute',
      'llamacpp',
      'vllm',
      'anthropic',
      'openai',
      'openrouter',
      'custom',
    ]);
  });

  it('ships OmniRoute as a keyless local gateway template', () => {
    const preset = getProviderPreset('omniroute');
    expect(preset.baseURL).toBe('http://127.0.0.1:20128/v1');
    expect(preset.defaultModel).toBe('auto');
    expect(preset.requiresKey).toBe(false);
    expect(preset.local).toBe(true);
    expect(describeProvider(preset)).toContain('20128');
  });

  it('ships LM Studio and Ollama as local templates', () => {
    for (const id of ['ollama', 'lmstudio'] as const) {
      const preset = getProviderPreset(id);
      expect(preset.local).toBe(true);
      expect(preset.kind).toBe('openai');
      expect(preset.requiresKey).toBe(false);
    }
  });

  it('normalizes trailing slashes', () => {
    expect(normalizeBaseURL('http://host:1234/v1///')).toBe('http://host:1234/v1');
  });
});

describe('resolveProvider', () => {
  it('uses preset defaults for an explicit local provider', async () => {
    const config = configWith({ provider: 'ollama' });
    const resolved = await resolveProvider({ config, env: {} });

    expect(resolved.id).toBe('ollama');
    expect(resolved.baseURL).toBe('http://127.0.0.1:11434/v1');
    expect(resolved.model).toBe('qwen2.5-coder:7b');
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.detected).toBe(false);
  });

  it('honours an explicit baseURL override', async () => {
    const config = configWith({ provider: 'lmstudio', baseURL: 'http://127.0.0.1:9999/v1/' });
    const resolved = await resolveProvider({ config, env: {} });
    expect(resolved.baseURL).toBe('http://127.0.0.1:9999/v1');
  });

  it('leaves the model empty when the preset has no default', async () => {
    const config = configWith({ provider: 'lmstudio' });
    const resolved = await resolveProvider({ config, env: {} });
    expect(resolved.model).toBe('');
  });

  it('requires a key for cloud providers', async () => {
    const config = configWith({ provider: 'anthropic' });
    await expect(resolveProvider({ config, env: {} })).rejects.toThrow(/requires an API key/);
  });

  it('picks the key from the provider-specific environment variable', async () => {
    const config = configWith({ provider: 'openai' });
    const resolved = await resolveProvider({ config, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(resolved.apiKey).toBe('sk-test');
    expect(resolved.baseURL).toBe('https://api.openai.com/v1');
  });

  it('auto-detects the first reachable local server', async () => {
    const config = configWith({ provider: 'auto' });
    const resolved = await resolveProvider({
      config,
      env: {},
      probe: async (preset: ProviderPreset) => preset.id === 'lmstudio',
    });

    expect(resolved.id).toBe('lmstudio');
    expect(resolved.detected).toBe(true);
  });

  it('falls back to a cloud provider when nothing local answers', async () => {
    const config = configWith({ provider: 'auto' });
    const resolved = await resolveProvider({
      config,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      probe: async () => false,
    });

    expect(resolved.id).toBe('anthropic');
    expect(resolved.detected).toBe(true);
  });

  it('explains how to fix a missing provider', async () => {
    const config = configWith({ provider: 'auto' });
    await expect(
      resolveProvider({ config, env: {}, probe: async () => false }),
    ).rejects.toThrow(/nelo providers/);
  });

  it('does not leak ANTHROPIC_BASE_URL into another provider', async () => {
    const config = configWith({
      provider: 'ollama',
      baseURL: 'http://proxy.local:8080',
    });
    const resolved = await resolveProvider({
      config,
      env: { ANTHROPIC_BASE_URL: 'http://proxy.local:8080' },
    });
    expect(resolved.baseURL).toBe('http://127.0.0.1:11434/v1');
  });

  it('requires a baseURL for the custom provider', async () => {
    const config = configWith({ provider: 'custom' });
    await expect(resolveProvider({ config, env: {} })).rejects.toThrow(/needs a baseURL/);
  });
});

describe('probeProvider', () => {
  it('returns true when the server exposes /models', async () => {
    const server = await startModelsServer();
    try {
      const preset: ProviderPreset = { ...getProviderPreset('ollama'), baseURL: server.url };
      await expect(probeProvider(preset, 1000)).resolves.toBe(true);
    } finally {
      await server.close();
    }
  });

  it('returns false when nothing is listening', async () => {
    const preset: ProviderPreset = {
      ...getProviderPreset('ollama'),
      baseURL: 'http://127.0.0.1:1/v1',
    };
    await expect(probeProvider(preset, 300)).resolves.toBe(false);
  });
});

describe('applyProviderDefaults', () => {
  it('fills model, context and output budget that the user did not set', async () => {
    const config = configWith({ provider: 'ollama' });
    const resolved = await resolveProvider({ config, env: {} });
    applyProviderDefaults(config, resolved);

    expect(config.model).toBe('qwen2.5-coder:7b');
    expect(config.context.maxTokens).toBe(32768);
    expect(config.maxTokens).toBe(4096);
    expect(config.baseURL).toBe('http://127.0.0.1:11434/v1');
  });

  it('keeps values the user did set', async () => {
    const config = configWith({
      provider: 'ollama',
      model: 'llama3.2:3b',
      maxTokens: 1024,
      context: { maxTokens: 8192, compactAt: 0.8 },
    });
    const resolved = await resolveProvider({ config, env: {} });
    applyProviderDefaults(config, resolved);

    expect(config.model).toBe('llama3.2:3b');
    expect(config.maxTokens).toBe(1024);
    expect(config.context.maxTokens).toBe(8192);
  });
});
