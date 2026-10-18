import type { ModelClient } from './client.js';
import { safeCutIndex } from './tokens.js';
import type { Message, UsageTotals } from './types.js';
import { emptyUsage } from './types.js';
import { truncate } from './utils/text.js';

const SUMMARY_SYSTEM = `You are compacting a conversation between a user and Nelo Code, an AI coding agent, so that work can continue with a smaller context window.

Produce a dense summary that preserves:
- The user's goals, requirements, and stated preferences.
- Important decisions and their rationale.
- Files read, created, or modified, and what changed.
- The current state of the task, including errors, test results, and pending work.
- Concrete identifiers (paths, function names, commands) needed to continue.

Write in the language the user has been using. Do not add commentary, apologies, or new plans. Output only the summary.`;

const MAX_TRANSCRIPT_CHARS = 60000;
const MAX_TEXT_CHARS = 8000;
const MAX_TOOL_INPUT_CHARS = 500;
const MAX_TOOL_RESULT_CHARS = 1000;

export interface CompactOptions {
  client: ModelClient;
  model: string;
  messages: Message[];
  keep?: number;
  signal?: AbortSignal;
}

export interface CompactResult {
  messages: Message[];
  summarizedCount: number;
  summary: string;
  usage: UsageTotals;
}

function renderTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push(`${message.role.toUpperCase()}: ${truncate(block.text, MAX_TEXT_CHARS)}`);
      } else if (block.type === 'tool_use') {
        parts.push(
          `TOOL CALL ${block.name}(${truncate(JSON.stringify(block.input), MAX_TOOL_INPUT_CHARS)})`,
        );
      } else {
        parts.push(`TOOL RESULT: ${truncate(block.content, MAX_TOOL_RESULT_CHARS)}`);
      }
    }
  }
  return truncate(parts.join('\n\n'), MAX_TRANSCRIPT_CHARS);
}

export async function compactMessages(options: CompactOptions): Promise<CompactResult> {
  const keep = options.keep ?? 6;
  const cut = safeCutIndex(options.messages, keep);
  const older = options.messages.slice(0, cut);
  const tail = options.messages.slice(cut);

  if (older.length === 0) {
    return {
      messages: options.messages,
      summarizedCount: 0,
      summary: '',
      usage: emptyUsage(),
    };
  }

  const transcript = renderTranscript(older);
  const response = await options.client.stream(
    {
      model: options.model,
      maxTokens: 4096,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
      tools: [],
    },
    { onText: () => undefined },
    options.signal,
  );

  const summary = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!summary) throw new Error('The model returned an empty summary.');

  const summaryText = `[Summary of earlier conversation]\n${summary}`;
  const summaryBlock = { type: 'text' as const, text: summaryText };

  let merged: Message[];
  const firstTail = tail[0];
  const firstBlock = firstTail?.content[0];

  if (
    firstTail &&
    firstTail.role === 'user' &&
    firstBlock &&
    firstBlock.type === 'text' &&
    !firstTail.content.some((block) => block.type === 'tool_result')
  ) {
    merged = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${summaryText}\n\n${firstBlock.text}` },
          ...firstTail.content.slice(1),
        ],
      },
      ...tail.slice(1),
    ];
  } else {
    merged = [{ role: 'user', content: [summaryBlock] }, ...tail];
  }

  return {
    messages: merged,
    summarizedCount: older.length,
    summary,
    usage: response.usage,
  };
}
