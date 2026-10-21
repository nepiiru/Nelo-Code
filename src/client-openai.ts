import type { ModelClient, ModelRequest, ModelResponse, StreamCallbacks } from './client.js';
import { estimateMessagesTokens, estimateTokens, estimateToolDefinitionsTokens } from './tokens.js';
import type {
  ContentBlock,
  Message,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  UsageTotals,
} from './types.js';
import { emptyUsage } from './types.js';

export interface OpenAIClientOptions {
  baseURL: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/** Converts the internal transcript into OpenAI chat messages. */
export function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const calls = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');

      if (calls.length === 0) {
        if (text) out.push({ role: 'assistant', content: text });
        continue;
      }

      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      });
      continue;
    }

    const texts: string[] = [];
    const results: ToolResultBlock[] = [];
    for (const block of message.content) {
      if (block.type === 'text') texts.push(block.text);
      else if (block.type === 'tool_result') results.push(block);
    }

    if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n') });
    for (const result of results) {
      out.push({ role: 'tool', tool_call_id: result.tool_use_id, content: result.content });
    }
  }

  return out;
}

function stripFence(text: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return match?.[1]?.trim() ?? text;
}

function repairJson(raw: string): string {
  return raw
    .replace(/^[^{[]*/, '')
    .replace(/[^}\]]*$/, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/'/g, '"');
}

/**
 * Parses the argument blob produced by a model.
 * Small local models regularly emit trailing commas, single quotes, or prose
 * around the object, so a repair pass runs before giving up.
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  for (const candidate of [trimmed, stripFence(trimmed), repairJson(stripFence(trimmed))]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

interface TextToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Portion of the text that produced the call, removed from the transcript. */
  matched: string;
}

function coerceTextToolCall(value: unknown): { name: string; input: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : typeof record.tool === 'string' ? record.tool : '';
  if (!name) return null;

  for (const key of ['arguments', 'parameters', 'input', 'args']) {
    const candidate = record[key];
    if (typeof candidate === 'string') {
      return { name, input: parseToolArguments(candidate) };
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return { name, input: candidate as Record<string, unknown> };
    }
  }
  return null;
}

/**
 * Finds tool calls that a model wrote as text instead of using the native
 * `tool_calls` field. This keeps models without function-calling support usable.
 */
export function extractTextToolCalls(text: string): TextToolCall[] {
  const calls: TextToolCall[] = [];
  const patterns = [/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, /```(?:json)?\s*([\s\S]*?)```/g];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const body = match[1] ?? '';
      const parsed = parseToolArguments(body);
      const call = coerceTextToolCall(parsed);
      if (call) calls.push({ ...call, matched: match[0] });
    }
    if (calls.length > 0) return calls;
  }

  const bare = /(\{[\s\S]*\})/.exec(text);
  if (bare?.[1]) {
    const call = coerceTextToolCall(parseToolArguments(bare[1]));
    if (call) calls.push({ ...call, matched: bare[1] });
  }

  return calls;
}

function mapStopReason(value: string | null): string | null {
  if (!value) return null;
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  if (value === 'length' || value === 'max_tokens') return 'max_tokens';
  if (value === 'stop' || value === 'end_turn') return 'end_turn';
  return value;
}

interface AbortBridge {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

function createAbortBridge(external: AbortSignal | undefined, timeoutMs: number): AbortBridge {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function errorWithStatus(message: string, status?: number): Error {
  const error = new Error(message);
  if (status !== undefined) (error as Error & { status?: number }).status = status;
  return error;
}

async function raiseHttpError(response: Response): Promise<never> {
  const body = await response.text().catch(() => '');
  let message = body.trim().slice(0, 2000);

  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === 'string') message = parsed.error;
    else if (parsed.error?.message) message = parsed.error.message;
    else if (parsed.message) message = parsed.message;
  } catch {
    // The body was not JSON (HTML error pages are common on local servers).
  }

  throw errorWithStatus(message || `HTTP ${response.status}`, response.status);
}

/**
 * Streaming client for any OpenAI-compatible chat completions endpoint:
 * Ollama, LM Studio, llama.cpp, vLLM, OmniRoute, OpenRouter, OpenAI.
 */
export class OpenAIChatClient implements ModelClient {
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAIClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    if (options.apiKey) this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 300000;
  }

  private headers(stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      'x-title': 'Nelo Code',
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async listModels(): Promise<string[]> {
    const bridge = createAbortBridge(undefined, Math.min(this.timeoutMs, 5000));
    try {
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.headers(false),
        signal: bridge.signal,
      });
      if (!response.ok) await raiseHttpError(response);
      const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
      return (payload.data ?? [])
        .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
        .filter((id) => id.length > 0);
    } finally {
      bridge.dispose();
    }
  }

  async stream(
    request: ModelRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const bridge = createAbortBridge(signal, request.timeoutMs ?? this.timeoutMs);

    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        ...toOpenAIMessages(request.messages),
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      top_p: request.topP,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map(toOpenAITool);
      body.tool_choice = 'auto';
    }

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(body),
        signal: bridge.signal,
      });

      if (!response.ok) await raiseHttpError(response);

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream') || !response.body) {
        return await this.readWholeResponse(response, request, callbacks);
      }

      return await this.readStream(response, request, callbacks);
    } catch (error) {
      if (bridge.timedOut()) {
        throw errorWithStatus(
          `The model server did not answer within ${Math.round(
            (request.timeoutMs ?? this.timeoutMs) / 1000,
          )}s (${this.baseURL}). Local prefill can be slow: raise "request.timeoutMs" if needed.`,
        );
      }
      throw error;
    } finally {
      bridge.dispose();
    }
  }

  private async readWholeResponse(
    response: Response,
    request: ModelRequest,
    callbacks: StreamCallbacks,
  ): Promise<ModelResponse> {
    const payload = (await response.json()) as {
      choices?: Array<{
        message?: { content?: unknown; tool_calls?: unknown };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = payload.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (text) callbacks.onText(text);

    const content: ContentBlock[] = [];
    if (text) content.push({ type: 'text', text });

    const rawCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
    rawCalls.forEach((raw, index) => {
      const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const name = typeof call.function?.name === 'string' ? call.function.name : '';
      if (!name) return;
      const args = call.function?.arguments;
      content.push({
        type: 'tool_use',
        id: typeof call.id === 'string' ? call.id : `call_${index}`,
        name,
        input: typeof args === 'string' ? parseToolArguments(args) : {},
      });
    });

    return {
      content,
      stopReason: mapStopReason(choice?.finish_reason ?? null),
      usage: this.usageFrom(
        payload.usage?.prompt_tokens,
        payload.usage?.completion_tokens,
        request,
        text,
      ),
    };
  }

  private async readStream(
    response: Response,
    request: ModelRequest,
    callbacks: StreamCallbacks,
  ): Promise<ModelResponse> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let stopReason: string | null = null;
    let usage: UsageTotals | null = null;
    let sawUsage = false;

    // Streaming text is held back slightly so that a tool call written as text
    // (`<tool_call>…` or a ```json fence) can be turned into a real tool call
    // before it is shown to the user.
    const HOLD_BACK = 48;
    const OPEN_MARKERS = ['<tool_call>', '```json', '```'];
    let emitted = 0;
    let frozenAt: number | null = null;

    const flushText = (limit: number): void => {
      if (limit <= emitted) return;
      const chunk = text.slice(emitted, limit);
      emitted = limit;
      if (chunk) callbacks.onText(chunk);
    };

    const freezeIfMarker = (): void => {
      if (frozenAt !== null) return;
      for (const marker of OPEN_MARKERS) {
        const found = text.indexOf(marker);
        if (found !== -1 && (frozenAt === null || found < frozenAt)) frozenAt = found;
      }
    };

    const slots = new Map<number, { id?: string; name: string; args: string }>();

    const handleChunk = (payload: string): boolean => {
      if (payload === '[DONE]') return true;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return false;
      }

      const rawUsage = json.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | null
        | undefined;
      if (rawUsage) {
        sawUsage = true;
        usage = this.usageFrom(rawUsage.prompt_tokens, rawUsage.completion_tokens, request, text);
      }

      const choices = json.choices as
        | Array<{
            delta?: { content?: unknown; tool_calls?: unknown };
            message?: { content?: unknown; tool_calls?: unknown };
            finish_reason?: string | null;
          }>
        | undefined;
      const choice = choices?.[0];
      if (!choice) return false;

      const delta = choice.delta ?? choice.message;
      const contentDelta = delta?.content;
      if (typeof contentDelta === 'string' && contentDelta) {
        text += contentDelta;
        freezeIfMarker();
        flushText(frozenAt ?? Math.max(0, text.length - HOLD_BACK));
      }

      const rawCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
      for (const raw of rawCalls) {
        const call = raw as {
          index?: unknown;
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        const index = typeof call.index === 'number' ? call.index : 0;
        let slot = slots.get(index);
        if (!slot) {
          slot = { name: '', args: '' };
          slots.set(index, slot);
        }
        if (typeof call.id === 'string' && !slot.id) slot.id = call.id;
        if (typeof call.function?.name === 'string') slot.name += call.function.name;
        if (typeof call.function?.arguments === 'string') slot.args += call.function.arguments;
      }

      if (typeof choice.finish_reason === 'string') stopReason = choice.finish_reason;
      return false;
    };

    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary).replace(/\r/g, '');
        buffer = buffer.slice(boundary + 2);

        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');

        if (data && handleChunk(data)) {
          done = true;
          break;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    const content: ContentBlock[] = [];
    if (text) content.push({ type: 'text', text });

    const ordered = [...slots.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, slot] of ordered) {
      if (!slot.name) continue;
      content.push({
        type: 'tool_use',
        id: slot.id ?? `call_${index}`,
        name: slot.name,
        input: parseToolArguments(slot.args),
      });
    }

    // Models without native tool support write the call as text instead.
    let extractedCount = 0;
    if (request.tools.length > 0 && !content.some((block) => block.type === 'tool_use')) {
      const extracted = extractTextToolCalls(text);
      if (extracted.length > 0) {
        let remaining = text;
        for (const call of extracted) remaining = remaining.replace(call.matched, '');
        remaining = remaining.trim();

        const rebuilt: ContentBlock[] = [];
        if (remaining) rebuilt.push({ type: 'text', text: remaining });
        extracted.forEach((call, index) => {
          rebuilt.push({
            type: 'tool_use',
            id: `text_call_${index}`,
            name: call.name,
            input: call.input,
          });
        });

        content.length = 0;
        content.push(...rebuilt);
        stopReason = 'tool_calls';
        extractedCount = extracted.length;
      }
    }

    if (extractedCount === 0) flushText(text.length);

    return {
      content,
      stopReason: mapStopReason(stopReason),
      usage: sawUsage && usage ? usage : this.usageFrom(undefined, undefined, request, text),
    };
  }

  private usageFrom(
    promptTokens: number | undefined,
    completionTokens: number | undefined,
    request: ModelRequest,
    text: string,
  ): UsageTotals {
    if (typeof promptTokens === 'number' || typeof completionTokens === 'number') {
      return {
        inputTokens: promptTokens ?? 0,
        outputTokens: completionTokens ?? 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
    }

    return {
      ...emptyUsage(),
      inputTokens:
        estimateMessagesTokens(request.messages) +
        estimateTokens(request.system) +
        estimateToolDefinitionsTokens(request.tools),
      outputTokens: estimateTokens(text),
    };
  }
}
