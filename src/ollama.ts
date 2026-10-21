/**
 * Minimal client for the Ollama-native API.
 *
 * Chat traffic goes through the OpenAI-compatible endpoint, but `/api/ps`,
 * `/api/tags` and `/api/show` expose information that the OpenAI surface does
 * not: which model is loaded in VRAM, and the context length the model was
 * trained with.
 */

export interface OllamaLoadedModel {
  name: string;
  size: number;
  sizeVram: number;
  expiresAt?: string;
  parameterSize?: string;
  quantization?: string;
}

export interface OllamaTag {
  name: string;
  size: number;
}

function trimBase(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '');
}

/** `http://host:11434/v1` -> `http://host:11434` */
export function ollamaBaseURL(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined;
  const trimmed = trimBase(baseURL);
  if (!trimmed) return undefined;
  return trimmed.replace(/\/v1$/, '');
}

async function getJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Models currently held in memory, including how much of them is in VRAM. */
export async function fetchOllamaPs(
  baseURL: string,
  timeoutMs = 1500,
): Promise<OllamaLoadedModel[] | null> {
  const payload = await getJson(`${trimBase(baseURL)}/api/ps`, timeoutMs);
  if (!payload || typeof payload !== 'object') return null;

  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  return models.flatMap((entry): OllamaLoadedModel[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const name = asString(record.name) ?? asString(record.model);
    if (!name) return [];
    const details = (record.details ?? {}) as Record<string, unknown>;
    return [
      {
        name,
        size: asNumber(record.size),
        sizeVram: asNumber(record.size_vram),
        ...(asString(record.expires_at) ? { expiresAt: asString(record.expires_at) as string } : {}),
        ...(asString(details.parameter_size) ? { parameterSize: asString(details.parameter_size) as string } : {}),
        ...(asString(details.quantization_level)
          ? { quantization: asString(details.quantization_level) as string }
          : {}),
      },
    ];
  });
}

/** Every model pulled into the local Ollama store. */
export async function fetchOllamaTags(
  baseURL: string,
  timeoutMs = 2000,
): Promise<OllamaTag[] | null> {
  const payload = await getJson(`${trimBase(baseURL)}/api/tags`, timeoutMs);
  if (!payload || typeof payload !== 'object') return null;

  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  return models.flatMap((entry): OllamaTag[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const name = asString(record.name) ?? asString(record.model);
    return name ? [{ name, size: asNumber(record.size) }] : [];
  });
}

/** Reads `*.context_length` from `/api/show`, falling back to null. */
export async function fetchOllamaContextLength(
  baseURL: string,
  model: string,
  timeoutMs = 2500,
): Promise<number | null> {
  const payload = await getJson(`${trimBase(baseURL)}/api/show`, timeoutMs, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!payload || typeof payload !== 'object') return null;

  const info = (payload as { model_info?: unknown }).model_info;
  if (!info || typeof info !== 'object') return null;

  for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
      return value;
    }
  }
  return null;
}

/** Context length reported by llama.cpp's `/props` endpoint. */
export async function fetchLlamaCppContextLength(
  baseURL: string,
  timeoutMs = 2000,
): Promise<number | null> {
  const base = trimBase(baseURL).replace(/\/v1$/, '');
  const payload = await getJson(`${base}/props`, timeoutMs);
  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  const candidates = [record.n_ctx, record.n_ctx_train, record.context_length];
  for (const value of candidates) {
    if (typeof value === 'number' && value > 0) return value;
  }
  const defaults = record.default_generation_settings;
  if (defaults && typeof defaults === 'object') {
    const nested = (defaults as Record<string, unknown>).n_ctx;
    if (typeof nested === 'number' && nested > 0) return nested;
  }
  return null;
}
