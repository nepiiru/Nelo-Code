import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  extractTextToolCalls,
  OpenAIChatClient,
  parseToolArguments,
  toOpenAIMessages,
} from '../src/client-openai.js';
import type { Message } from '../src/types.js';

function sseBody(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

async function withServer(
  handler: (body: string, response: import('node:http').ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => handler(raw, response));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const emptyRequest = {
  model: 'local-model',
  maxTokens: 256,
  system: 'system prompt',
  messages: [] as Message[],
  tools: [],
};

describe('toOpenAIMessages', () => {
  it('converts assistant tool calls and tool results', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'read package.json' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'package.json' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }],
      },
    ];

    const converted = toOpenAIMessages(messages);
    expect(converted).toHaveLength(3);
    expect(converted[0]).toEqual({ role: 'user', content: 'read package.json' });

    const assistant = converted[1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toBe('Sure.');
    expect(assistant?.tool_calls?.[0]?.function.name).toBe('read_file');
    expect(JSON.parse(assistant?.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      path: 'package.json',
    });

    expect(converted[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'file body' });
  });

  it('uses a null content for tool-only assistant turns', () => {
    const converted = toOpenAIMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'grep', input: { pattern: 'x' } }],
      },
    ]);
    expect(converted[0]?.content).toBeNull();
  });
});

describe('parseToolArguments', () => {
  it('parses plain JSON', () => {
    expect(parseToolArguments('{"path":"a.ts"}')).toEqual({ path: 'a.ts' });
  });

  it('repairs trailing commas and single quotes', () => {
    expect(parseToolArguments("{'path': 'a.ts',}")).toEqual({ path: 'a.ts' });
  });

  it('strips a code fence and surrounding prose', () => {
    expect(parseToolArguments('here you go:\n```json\n{"limit": 5}\n```')).toEqual({ limit: 5 });
  });

  it('returns an empty object for garbage', () => {
    expect(parseToolArguments('not json at all')).toEqual({});
  });
});

describe('extractTextToolCalls', () => {
  it('finds a <tool_call> block', () => {
    const calls = extractTextToolCalls(
      'I will look.\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('read_file');
    expect(calls[0]?.input).toEqual({ path: 'a.ts' });
  });

  it('finds a fenced JSON block', () => {
    const calls = extractTextToolCalls('```json\n{"name":"grep","parameters":{"pattern":"todo"}}\n```');
    expect(calls[0]?.name).toBe('grep');
    expect(calls[0]?.input).toEqual({ pattern: 'todo' });
  });

  it('ignores prose that is not a tool call', () => {
    expect(extractTextToolCalls('The file has three functions.')).toEqual([]);
  });
});

describe('OpenAIChatClient.stream', () => {
  it('assembles streamed text and split tool call arguments', async () => {
    const body = sseBody([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking.' } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 11, completion_tokens: 7 } },
    ]);

    await withServer(
      (_raw, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(body);
      },
      async (url) => {
        const client = new OpenAIChatClient({ baseURL: url });
        const streamed: string[] = [];
        const result = await client.stream(emptyRequest, { onText: (delta) => streamed.push(delta) });

        expect(streamed.join('')).toBe('Checking.');
        expect(result.stopReason).toBe('tool_use');
        expect(result.content).toEqual([
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        ]);
        expect(result.usage).toEqual({
          inputTokens: 11,
          outputTokens: 7,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        });
      },
    );
  });

  it('turns a text-written tool call into a real tool call without echoing the tag', async () => {
    const body = sseBody([
      {
        choices: [
          {
            index: 0,
            delta: { content: 'Looking now.\n<tool_call>{"name":"grep","arguments":{"pattern":"todo"}}</tool_call>' },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);

    await withServer(
      (_raw, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(body);
      },
      async (url) => {
        const client = new OpenAIChatClient({ baseURL: url });
        const streamed: string[] = [];
        const result = await client.stream(
          { ...emptyRequest, tools: [{ name: 'grep', description: 'grep', input_schema: { type: 'object', properties: {} } }] },
          { onText: (delta) => streamed.push(delta) },
        );

        expect(streamed.join('')).not.toContain('<tool_call>');
        expect(result.stopReason).toBe('tool_use');
        const toolUse = result.content.find((block) => block.type === 'tool_use');
        expect(toolUse).toMatchObject({ name: 'grep', input: { pattern: 'todo' } });
      },
    );
  });

  it('handles a non-streaming JSON response', async () => {
    await withServer(
      (_raw, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: { content: 'hello', tool_calls: [] },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
        );
      },
      async (url) => {
        const client = new OpenAIChatClient({ baseURL: url });
        const streamed: string[] = [];
        const result = await client.stream(emptyRequest, { onText: (delta) => streamed.push(delta) });

        expect(streamed.join('')).toBe('hello');
        expect(result.stopReason).toBe('end_turn');
        expect(result.usage.inputTokens).toBe(5);
      },
    );
  });

  it('surfaces HTTP errors with their status', async () => {
    await withServer(
      (_raw, response) => {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'bad key' } }));
      },
      async (url) => {
        const client = new OpenAIChatClient({ baseURL: url, apiKey: 'nope' });
        await expect(client.stream(emptyRequest, { onText: () => undefined })).rejects.toThrow('bad key');
      },
    );
  });

  it('lists models from the OpenAI endpoint', async () => {
    await withServer(
      (_raw, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
      },
      async (url) => {
        const client = new OpenAIChatClient({ baseURL: url });
        await expect(client.listModels()).resolves.toEqual(['model-a', 'model-b']);
      },
    );
  });
});
