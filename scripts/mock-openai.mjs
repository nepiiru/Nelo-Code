#!/usr/bin/env node
/**
 * OpenAI-compatible mock server for local-provider development and E2E tests.
 *
 * It imitates the three servers Nelo Code talks to:
 *   - `GET  /v1/models`              model discovery (Ollama, LM Studio, llama.cpp, …)
 *   - `POST /v1/chat/completions`    streaming chat with a native `tool_calls` delta
 *   - `GET  /api/tags`, `/api/ps`    Ollama-native model list and VRAM usage
 *   - `POST /api/show`               Ollama-native context length
 *
 * Behaviour:
 *   - First request of a conversation: text + a `read_file` tool call.
 *   - After a tool result: a final text answer.
 *   - Model name containing "text-tools": the tool call is written as text
 *     inside `<tool_call>` tags, exercising the fallback parser.
 *
 * Usage:
 *   node scripts/mock-openai.mjs
 *   node bin/nelo.js --provider ollama --base-url http://127.0.0.1:8799/v1 "hello"
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8799);
const HOST = process.env.MOCK_HOST || '127.0.0.1';
const MODEL = process.env.MOCK_MODEL || 'mock-local';

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => resolve(raw));
    request.on('error', reject);
  });
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    return typeof message.content === 'string' ? message.content : '';
  }
  return '';
}

function hasToolResult(messages) {
  return messages.some((message) => message && message.role === 'tool');
}

function sse(response, chunks) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

function delta(content) {
  return { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: content }] };
}

const server = createServer(async (request, response) => {
  const url = request.url ?? '';

  if (request.method === 'GET' && url.endsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
    return;
  }

  if (request.method === 'GET' && url.endsWith('/api/tags')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        models: [{ name: `${MODEL}:latest`, model: `${MODEL}:latest`, size: 4_500_000_000 }],
      }),
    );
    return;
  }

  if (request.method === 'GET' && url.endsWith('/api/ps')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        models: [
          {
            name: `${MODEL}:latest`,
            model: `${MODEL}:latest`,
            size: 4_500_000_000,
            size_vram: 4_100_000_000,
            expires_at: new Date(Date.now() + 300000).toISOString(),
            details: { parameter_size: '7B', quantization_level: 'Q4_K_M' },
          },
        ],
      }),
    );
    return;
  }

  if (request.method === 'POST' && url.endsWith('/api/show')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model_info: { 'mock.context_length': 8192 } }));
    return;
  }

  if (request.method !== 'POST' || !url.endsWith('/v1/chat/completions')) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Not found' } }));
    return;
  }

  let body = {};
  try {
    const raw = await readBody(request);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = typeof body.model === 'string' ? body.model : MODEL;
  const textTools = model.includes('text-tools');
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const canRead = tools.some((tool) => tool?.function?.name === 'read_file');
  const wantsWrite = lastUserText(messages).includes('write-demo');

  if (hasToolResult(messages)) {
    sse(response, [
      delta({ role: 'assistant', content: 'The tool call succeeded. ' }),
      delta({ content: 'This is the mock local model finishing the task.' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 12 } },
    ]);
    return;
  }

  if (!canRead || textTools) {
    const call = { name: wantsWrite ? 'write_file' : 'read_file', arguments: wantsWrite
      ? { path: 'mock-output.txt', content: 'written by the mock local model\n' }
      : { path: 'package.json', limit: 5 } };
    const text = textTools
      ? `I will inspect the workspace.\n<tool_call>${JSON.stringify(call)}</tool_call>`
      : 'Let me inspect the workspace first.';
    sse(response, [
      delta({ role: 'assistant', content: text }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ]);
    return;
  }

  const args = wantsWrite
    ? { path: 'mock-output.txt', content: 'written by the mock local model\n' }
    : { path: 'package.json', limit: 5 };
  const encoded = JSON.stringify(args);
  const half = Math.floor(encoded.length / 2);

  sse(response, [
    delta({ role: 'assistant', content: 'Let me inspect the workspace first.' }),
    delta({
      tool_calls: [
        {
          index: 0,
          id: 'call_mock_1',
          type: 'function',
          function: { name: wantsWrite ? 'write_file' : 'read_file', arguments: encoded.slice(0, half) },
        },
      ],
    }),
    delta({
      tool_calls: [{ index: 0, function: { arguments: encoded.slice(half) } }],
    }),
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 18 } },
  ]);
});

server.listen(PORT, HOST, () => {
  console.log(`Mock OpenAI-compatible API listening on http://${HOST}:${PORT}/v1`);
});
