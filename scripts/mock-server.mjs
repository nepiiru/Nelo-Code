#!/usr/bin/env node
/**
 * A tiny Anthropic Messages API mock used for local development and E2E tests.
 *
 * Behaviour:
 * - First request of a conversation: emits a read_file tool call
 *   (or a write_file call when the user prompt contains "write-demo").
 * - After a tool result: emits a final text response.
 *
 * Usage:
 *   node scripts/mock-server.mjs
 *   ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:8787 node bin/nelo.js "hello"
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8787);
const HOST = process.env.MOCK_HOST || '127.0.0.1';

function splitText(text) {
  return text.match(/.{1,12}/g) ?? [];
}

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
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) continue;
    return message.content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/v1/messages')) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }),
    );
    return;
  }

  let body = {};
  try {
    const raw = await readBody(request);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Invalid JSON' },
      }),
    );
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const hasToolResult = messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block && block.type === 'tool_result'),
  );
  const canRead = tools.some((tool) => tool && tool.name === 'read_file');
  const canWrite = tools.some((tool) => tool && tool.name === 'write_file');
  const wantsWrite = lastUserText(messages).includes('write-demo');

  let toolCall = null;
  if (!hasToolResult && wantsWrite && canWrite) {
    toolCall = {
      name: 'write_file',
      id: 'toolu_mock_write',
      input: { path: 'mock-output.txt', content: 'written by the mock model\n' },
    };
  } else if (!hasToolResult && !wantsWrite && canRead) {
    toolCall = {
      name: 'read_file',
      id: 'toolu_mock_read',
      input: { path: 'package.json', limit: 5 },
    };
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'request-id': 'req_mock',
  });

  const send = (event, data) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: body.model || 'mock-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  });

  let blockIndex = 0;
  const text = hasToolResult
    ? 'The tool call succeeded. This is the mock model finishing the task.'
    : toolCall
      ? 'Let me inspect the workspace first.'
      : 'Hello from the mock model!';

  send('content_block_start', {
    type: 'content_block_start',
    index: blockIndex,
    content_block: { type: 'text', text: '' },
  });
  for (const piece of splitText(text)) {
    send('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text: piece },
    });
  }
  send('content_block_stop', { type: 'content_block_stop', index: blockIndex });

  let stopReason = 'end_turn';

  if (toolCall) {
    blockIndex += 1;
    send('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id: toolCall.id, name: toolCall.name, input: {} },
    });
    send('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolCall.input) },
    });
    send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    stopReason = 'tool_use';
  }

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 24 },
  });
  send('message_stop', { type: 'message_stop' });
  response.end();
});

server.listen(PORT, HOST, () => {
  console.log(`Mock Anthropic API listening on http://${HOST}:${PORT}`);
});
