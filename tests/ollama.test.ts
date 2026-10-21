import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  fetchLlamaCppContextLength,
  fetchOllamaContextLength,
  fetchOllamaPs,
  fetchOllamaTags,
  ollamaBaseURL,
} from '../src/ollama.js';

async function withServer(
  handler: (url: string, body: string, response: import('node:http').ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => handler(request.url ?? '', raw, response));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(response: import('node:http').ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

describe('ollamaBaseURL', () => {
  it('strips the OpenAI-compatible suffix', () => {
    expect(ollamaBaseURL('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(ollamaBaseURL('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434');
    expect(ollamaBaseURL('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(ollamaBaseURL(undefined)).toBeUndefined();
  });
});

describe('Ollama native API', () => {
  it('reads loaded models and their VRAM split', async () => {
    await withServer(
      (url, _body, response) => {
        if (!url.endsWith('/api/ps')) {
          response.writeHead(404);
          response.end();
          return;
        }
        json(response, {
          models: [
            {
              name: 'qwen2.5-coder:7b',
              size: 4_700_000_000,
              size_vram: 4_200_000_000,
              expires_at: '2026-01-01T00:00:00Z',
              details: { parameter_size: '7B', quantization_level: 'Q4_K_M' },
            },
          ],
        });
      },
      async (url) => {
        const models = await fetchOllamaPs(url);
        expect(models).toHaveLength(1);
        expect(models?.[0]?.name).toBe('qwen2.5-coder:7b');
        expect(models?.[0]?.sizeVram).toBe(4_200_000_000);
        expect(models?.[0]?.parameterSize).toBe('7B');
        expect(models?.[0]?.quantization).toBe('Q4_K_M');
      },
    );
  });

  it('returns null when Ollama is not reachable', async () => {
    await expect(fetchOllamaPs('http://127.0.0.1:1', 200)).resolves.toBeNull();
  });

  it('reads the model list', async () => {
    await withServer(
      (url, _body, response) => {
        if (!url.endsWith('/api/tags')) {
          response.writeHead(404);
          response.end();
          return;
        }
        json(response, { models: [{ name: 'llama3.2:3b', size: 2_000_000_000 }] });
      },
      async (url) => {
        const tags = await fetchOllamaTags(url);
        expect(tags).toEqual([{ name: 'llama3.2:3b', size: 2_000_000_000 }]);
      },
    );
  });

  it('reads the context length from /api/show', async () => {
    await withServer(
      (url, _body, response) => {
        if (!url.endsWith('/api/show')) {
          response.writeHead(404);
          response.end();
          return;
        }
        json(response, { model_info: { 'qwen2.context_length': 32768 } });
      },
      async (url) => {
        await expect(fetchOllamaContextLength(url, 'qwen2.5-coder:7b')).resolves.toBe(32768);
      },
    );
  });

  it('reads the context length from llama.cpp /props', async () => {
    await withServer(
      (url, _body, response) => {
        if (!url.endsWith('/props')) {
          response.writeHead(404);
          response.end();
          return;
        }
        json(response, { n_ctx: 16384 });
      },
      async (url) => {
        await expect(fetchLlamaCppContextLength(`${url}/v1`)).resolves.toBe(16384);
      },
    );
  });
});
