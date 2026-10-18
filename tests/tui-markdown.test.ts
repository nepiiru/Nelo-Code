import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatMarkdown } from '../src/ui/tui/markdown.js';
import { stripAnsi } from '../src/ui/tui/width.js';

let previousNoColor: string | undefined;

beforeEach(() => {
  previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
});

afterEach(() => {
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;
});

describe('formatMarkdown', () => {
  it('keeps headings and bullet text intact when colors are disabled', () => {
    expect(formatMarkdown('# Title\n- one\n- two', 40)).toEqual(['# Title', '- one', '- two']);
  });

  it('renders fenced code blocks and drops a trailing blank line', () => {
    expect(formatMarkdown('```ts\nconst x = 1;\n```\n', 40)).toEqual([
      '```ts',
      'const x = 1;',
      '```',
    ]);
  });

  it('wraps long prose to the available width', () => {
    const lines = formatMarkdown('word '.repeat(10), 12);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(12);
    }
  });

  it('wraps CJK text by display width', () => {
    const lines = formatMarkdown('日本語テスト', 4);
    expect(lines.map(stripAnsi)).toEqual(['日本', '語テ', 'スト']);
  });

  it('styles numbered list markers', () => {
    expect(formatMarkdown('1. first\n2. second', 40)).toEqual(['1. first', '2. second']);
  });
});
