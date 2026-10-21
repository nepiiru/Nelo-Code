import type { Config, ProviderId } from './config.js';
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from './config.js';

export type { ProviderId };

export type ProviderKind = 'anthropic' | 'openai';

export interface ProviderPreset {
  id: Exclude<ProviderId, 'auto'>;
  label: string;
  kind: ProviderKind;
  /** API root. OpenAI-compatible providers are called at `<baseURL>/chat/completions`. */
  baseURL?: string;
  defaultModel: string;
  keyEnv: string[];
  requiresKey: boolean;
  local: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  note: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'openai',
    baseURL: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    keyEnv: [],
    requiresKey: false,
    local: true,
    contextWindow: 32768,
    maxOutputTokens: 4096,
    note: 'Local models via `ollama serve`. The OpenAI-compatible endpoint is used for chat.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'openai',
    baseURL: 'http://127.0.0.1:1234/v1',
    defaultModel: '',
    keyEnv: [],
    requiresKey: false,
    local: true,
    contextWindow: 32768,
    maxOutputTokens: 4096,
    note: 'Start the LM Studio local server (Developer tab). The loaded model is detected automatically.',
  },
  {
    id: 'omniroute',
    label: 'OmniRoute',
    kind: 'openai',
    baseURL: 'http://127.0.0.1:20128/v1',
    defaultModel: 'auto',
    keyEnv: ['OMNIROUTE_API_KEY'],
    requiresKey: false,
    local: true,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    note: 'Self-hosted AI gateway (`npm i -g omniroute`). Model "auto" picks a route; set OMNIROUTE_API_KEY when the gateway requires auth.',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server',
    kind: 'openai',
    baseURL: 'http://127.0.0.1:8080/v1',
    defaultModel: '',
    keyEnv: [],
    requiresKey: false,
    local: true,
    contextWindow: 16384,
    maxOutputTokens: 4096,
    note: 'llama-server with the OpenAI-compatible API. Context length is read from /props.',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    kind: 'openai',
    baseURL: 'http://127.0.0.1:8000/v1',
    defaultModel: '',
    keyEnv: [],
    requiresKey: false,
    local: true,
    contextWindow: 32768,
    maxOutputTokens: 4096,
    note: 'vLLM OpenAI-compatible server. Pass the served model name with -m.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    defaultModel: DEFAULT_MODEL,
    keyEnv: ['ANTHROPIC_API_KEY'],
    requiresKey: true,
    local: false,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    note: 'Cloud. Uses ANTHROPIC_API_KEY and the official SDK.',
  },
  {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1',
    keyEnv: ['OPENAI_API_KEY'],
    requiresKey: true,
    local: false,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    note: 'Cloud. Uses OPENAI_API_KEY.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    keyEnv: ['OPENROUTER_API_KEY'],
    requiresKey: true,
    local: false,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    note: 'Cloud aggregator. Model names look like "anthropic/claude-sonnet-4.5".',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    kind: 'openai',
    defaultModel: '',
    keyEnv: ['NELO_API_KEY'],
    requiresKey: false,
    local: false,
    contextWindow: 32768,
    maxOutputTokens: 4096,
    note: 'Any OpenAI-compatible endpoint. Requires baseURL.',
  },
];

const PRESET_BY_ID = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

/** Order used by `provider: "auto"`: local servers first, then cloud by available key. */
const AUTO_LOCAL_ORDER: ReadonlyArray<Exclude<ProviderId, 'auto'>> = [
  'ollama',
  'lmstudio',
  'omniroute',
  'llamacpp',
  'vllm',
];

const AUTO_CLOUD_ORDER: ReadonlyArray<Exclude<ProviderId, 'auto'>> = [
  'anthropic',
  'openai',
  'openrouter',
];

export function isProviderId(value: string): value is ProviderId {
  return value === 'auto' || PRESET_BY_ID.has(value as Exclude<ProviderId, 'auto'>);
}

export function getProviderPreset(id: Exclude<ProviderId, 'auto'>): ProviderPreset {
  const preset = PRESET_BY_ID.get(id);
  if (!preset) throw new Error(`Unknown provider "${id}".`);
  return preset;
}

export function listProviderPresets(): ProviderPreset[] {
  return [...PROVIDER_PRESETS];
}

export function normalizeBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export interface ResolvedProvider {
  id: Exclude<ProviderId, 'auto'>;
  preset: ProviderPreset;
  baseURL?: string;
  apiKey?: string;
  model: string;
  contextWindow: number;
  detected: boolean;
}

export interface ResolveProviderOptions {
  config: Config;
  env?: NodeJS.ProcessEnv;
  /** Probe timeout for auto-detection, in milliseconds. */
  probeTimeoutMs?: number;
  /** Injection point for tests: decides whether a preset is reachable. */
  probe?: (preset: ProviderPreset) => Promise<boolean>;
}

function keyFor(preset: ProviderPreset, env: NodeJS.ProcessEnv): string | undefined {
  for (const name of preset.keyEnv) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/** Returns true when something answers the OpenAI-compatible `/models` endpoint. */
export async function probeProvider(
  preset: ProviderPreset,
  timeoutMs = 400,
): Promise<boolean> {
  if (!preset.baseURL) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${normalizeBaseURL(preset.baseURL)}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function detectLocalProvider(
  probe: (preset: ProviderPreset) => Promise<boolean>,
): Promise<Exclude<ProviderId, 'auto'> | null> {
  const candidates = AUTO_LOCAL_ORDER.map((id) => getProviderPreset(id)).filter(
    (preset) => preset.baseURL !== undefined,
  );
  const results = await Promise.all(
    candidates.map(async (preset) => ({ preset, ok: await probe(preset) })),
  );
  for (const id of AUTO_LOCAL_ORDER) {
    const hit = results.find((entry) => entry.preset.id === id && entry.ok);
    if (hit) return hit.preset.id;
  }
  return null;
}

/**
 * Chooses a provider, endpoint, key, model and context window.
 *
 * Resolution order:
 *   1. Explicit `provider` in the config / `--provider` flag.
 *   2. `auto`: probe local servers (Ollama, LM Studio, OmniRoute, llama.cpp, vLLM).
 *   3. `auto`: fall back to the first cloud provider with an API key.
 */
export async function resolveProvider(
  options: ResolveProviderOptions,
): Promise<ResolvedProvider> {
  const env = options.env ?? process.env;
  const config = options.config;
  const timeoutMs = options.probeTimeoutMs ?? 400;
  const probe = options.probe ?? ((preset: ProviderPreset) => probeProvider(preset, timeoutMs));

  let id: Exclude<ProviderId, 'auto'>;
  let detected = false;

  if (config.provider !== 'auto') {
    id = config.provider;
  } else {
    const local = await detectLocalProvider(probe);
    if (local) {
      id = local;
      detected = true;
    } else {
      const cloud = AUTO_CLOUD_ORDER.find((candidate) => {
        const preset = getProviderPreset(candidate);
        return keyFor(preset, env) !== undefined;
      });
      if (!cloud) {
        throw new Error(
          'No model provider found. Start Ollama (or LM Studio / OmniRoute), ' +
            'or set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY. ' +
            'Run "nelo providers" to see every template.',
        );
      }
      id = cloud;
      detected = true;
    }
  }

  const preset = getProviderPreset(id);
  // ANTHROPIC_BASE_URL must not leak into an unrelated provider's endpoint.
  const configBaseURL =
    config.baseURL && !(preset.id !== 'anthropic' && env.ANTHROPIC_BASE_URL === config.baseURL)
      ? config.baseURL
      : undefined;
  const baseURL =
    normalizeBaseURL(configBaseURL ?? env.NELO_BASE_URL ?? preset.baseURL ?? '') || undefined;

  if (preset.id === 'custom' && !baseURL) {
    throw new Error('The "custom" provider needs a baseURL (set "baseURL" in the config or --base-url).');
  }

  const apiKey = config.apiKey?.trim() || keyFor(preset, env);
  if (preset.requiresKey && !apiKey) {
    throw new Error(
      `Provider "${preset.id}" requires an API key. Set ${preset.keyEnv.join(' or ') || 'an API key'}.`,
    );
  }

  const model = config.model === DEFAULT_MODEL && preset.defaultModel
    ? preset.defaultModel
    : config.model;

  const contextWindow = config.context.maxTokens === DEFAULT_CONTEXT_TOKENS
    ? preset.contextWindow
    : config.context.maxTokens;

  return {
    id: preset.id,
    preset,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    model,
    contextWindow,
    detected,
  };
}

/**
 * Applies provider defaults to a config that the user has not customised.
 * Called once at startup so that `--provider ollama` behaves sensibly even
 * when the config file still holds cloud-oriented values.
 */
export function applyProviderDefaults(config: Config, resolved: ResolvedProvider): void {
  if (config.model === DEFAULT_MODEL && resolved.preset.defaultModel) {
    config.model = resolved.preset.defaultModel;
  }
  if (config.context.maxTokens === DEFAULT_CONTEXT_TOKENS) {
    config.context.maxTokens = resolved.preset.contextWindow;
  }
  if (config.maxTokens === DEFAULT_MAX_TOKENS) {
    config.maxTokens = resolved.preset.maxOutputTokens;
  }
  if (resolved.baseURL) config.baseURL = resolved.baseURL;
  if (resolved.apiKey) config.apiKey = resolved.apiKey;
}

/** Short human-readable description used by `nelo providers` and `/provider`. */
export function describeProvider(preset: ProviderPreset): string {
  const parts = [preset.local ? 'local' : 'cloud', preset.kind === 'anthropic' ? 'anthropic api' : 'openai-compatible'];
  if (preset.baseURL) parts.push(preset.baseURL);
  if (preset.keyEnv.length > 0) parts.push(`key: ${preset.keyEnv[0]}`);
  return parts.join(' · ');
}
