import type { Message, ToolDefinition } from './types.js';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 1.5);
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += 4;
    for (const block of message.content) {
      if (block.type === 'text') {
        total += estimateTokens(block.text);
      } else if (block.type === 'tool_use') {
        total += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input)) + 8;
      } else {
        total += estimateTokens(block.content) + 8;
      }
    }
  }
  return total;
}

export function estimateToolDefinitionsTokens(tools: ToolDefinition[]): number {
  return estimateTokens(JSON.stringify(tools));
}

/**
 * Returns an index at which the conversation can safely be cut so that the tail
 * begins with a plain user turn (never an orphaned tool_result block).
 * If no safe cut point exists, returns messages.length (nothing can be kept).
 */
export function safeCutIndex(messages: Message[], keep: number): number {
  const target = Math.max(0, messages.length - keep);
  for (let index = target; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    if (message.content.some((block) => block.type === 'tool_result')) continue;
    return index;
  }
  return messages.length;
}
