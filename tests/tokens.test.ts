import { describe, expect, it } from 'vitest';
import {
  estimateMessagesTokens,
  estimateTokens,
  safeCutIndex,
} from '../src/tokens.js';
import type { Message } from '../src/types.js';

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

describe('token estimation', () => {
  it('estimates ASCII and CJK text', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('日本語')).toBeGreaterThan(estimateTokens('abc'));
  });

  it('counts all block types', () => {
    const messages: Message[] = [
      user('hello'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
      },
    ];
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(estimateTokens('hello'));
  });
});

describe('safeCutIndex', () => {
  it('cuts at a plain user turn so tool results are never orphaned', () => {
    const messages: Message[] = [
      user('one'),
      assistant('two'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }],
      },
      assistant('three'),
      user('four'),
      assistant('five'),
      user('six'),
    ];

    const cut = safeCutIndex(messages, 2);
    expect(cut).toBe(5);
    expect(messages[cut]?.role).toBe('user');
    expect(messages[cut]?.content.some((block) => block.type === 'tool_result')).toBe(false);
  });

  it('falls back to summarizing everything when no safe point exists', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }],
      },
      assistant('reply'),
    ];
    expect(safeCutIndex(messages, 1)).toBe(messages.length);
  });
});
