import Anthropic from '@anthropic-ai/sdk';
import { OpenAIChatClient } from './client-openai.js';
import type { ResolvedProvider } from './providers.js';
import type { ContentBlock, Message, ToolDefinition, UsageTotals } from './types.js';

export interface ModelRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
}

export interface StreamCallbacks {
  onText: (delta: string) => void;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: string | null;
  usage: UsageTotals;
}

export interface ModelClient {
  stream(request: ModelRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<ModelResponse>;
  /** Optional: list model ids exposed by the endpoint. */
  listModels?(): Promise<string[]>;
}

export interface AnthropicClientOptions {
  apiKey: string;
  baseURL?: string;
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(options: AnthropicClientOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: 2,
    });
  }

  async stream(
    request: ModelRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const stream = this.client.messages.stream(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages as unknown as Anthropic.MessageParam[],
        tools: request.tools as unknown as Anthropic.Tool[],
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      },
      signal ? { signal } : undefined,
    );

    stream.on('text', (delta) => callbacks.onText(delta));

    const final = await stream.finalMessage();
    const content: ContentBlock[] = [];

    for (const block of final.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      stopReason: final.stop_reason ?? null,
      usage: {
        inputTokens: final.usage.input_tokens ?? 0,
        outputTokens: final.usage.output_tokens ?? 0,
        cacheReadInputTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

function connectionCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Builds the client that matches the resolved provider. */
export function createModelClient(
  resolved: ResolvedProvider,
  options: { timeoutMs?: number } = {},
): ModelClient {
  if (resolved.preset.kind === 'anthropic') {
    return new AnthropicModelClient({
      apiKey: resolved.apiKey ?? '',
      ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
    });
  }

  if (!resolved.baseURL) {
    throw new Error(`Provider "${resolved.id}" needs a baseURL.`);
  }

  return new OpenAIChatClient({
    baseURL: resolved.baseURL,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
}

export function describeApiError(error: unknown): string {
  if (isAbortError(error)) return 'Request aborted.';

  const code = connectionCode(error);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
    return (
      'Could not reach the model server. Start it (for example "ollama serve") and check ' +
      'the provider and baseURL. Run "nelo providers" to see the available templates.'
    );
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return 'The model server closed the connection. It may have run out of memory; try a smaller model or context.';
  }

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);

  switch (status) {
    case 401:
      return 'Authentication failed (401). Check that the API key is valid.';
    case 403:
      return 'Access denied (403). Your API key may not have access to this model.';
    case 404:
      return `Model or endpoint not found (404). ${message}`;
    case 413:
      return 'The request was too large (413). Try /compact to shrink the conversation.';
    case 429:
      return 'Rate limited (429). Wait a moment and try again.';
    case 500:
      return 'The model server had an internal error (500). Try again shortly.';
    case 529:
      return 'The API is overloaded (529). Try again shortly.';
    default:
      return message;
  }
}
