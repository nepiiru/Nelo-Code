import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, Message, ToolDefinition, UsageTotals } from './types.js';

export interface ModelRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
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

export function describeApiError(error: unknown): string {
  if (isAbortError(error)) return 'Request aborted.';

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);

  switch (status) {
    case 401:
      return 'Authentication failed (401). Check that ANTHROPIC_API_KEY is valid.';
    case 403:
      return 'Access denied (403). Your API key may not have access to this model.';
    case 404:
      return `Model or endpoint not found (404). ${message}`;
    case 413:
      return 'The request was too large (413). Try /compact to shrink the conversation.';
    case 429:
      return 'Rate limited (429). Wait a moment and try again.';
    case 500:
      return 'The API had an internal error (500). Try again shortly.';
    case 529:
      return 'The API is overloaded (529). Try again shortly.';
    default:
      return message;
  }
}
