import { describe, expect, it } from 'vitest';
import { compactMessages } from '../src/compaction.js';
import type { Message } from '../src/types.js';
import { FakeClient, textResponse } from './helpers.js';

function conversation(): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < 8; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message ${index}` }],
    });
  }
  return messages;
}

describe('compactMessages', () => {
  it('summarizes older messages and keeps the tail', async () => {
    const client = new FakeClient([textResponse('A dense summary of earlier work.')]);
    const messages = conversation();

    const result = await compactMessages({
      client,
      model: 'claude-sonnet-5-5',
      messages,
      keep: 4,
    });

    expect(result.summarizedCount).toBe(4);
    expect(result.summary).toContain('dense summary');
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]?.role).toBe('user');
    expect(result.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('[Summary of earlier conversation]'),
    });
    expect(result.messages[0]?.content[0]).toMatchObject({
      text: expect.stringContaining('message 4'),
    });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.tools).toEqual([]);
    expect(client.requests[0]?.messages[0]?.content[0]).toMatchObject({
      text: expect.stringContaining('USER: message 0'),
    });
  });

  it('does nothing when there is not enough history', async () => {
    const client = new FakeClient([]);
    const result = await compactMessages({
      client,
      model: 'claude-sonnet-5-5',
      messages: conversation().slice(0, 2),
      keep: 6,
    });

    expect(result.summarizedCount).toBe(0);
    expect(result.messages).toHaveLength(2);
    expect(client.requests).toHaveLength(0);
  });

  it('rejects an empty model summary', async () => {
    const client = new FakeClient([textResponse('')]);
    await expect(
      compactMessages({ client, model: 'claude-sonnet-5-5', messages: conversation(), keep: 4 }),
    ).rejects.toThrow(/empty summary/);
  });
});
