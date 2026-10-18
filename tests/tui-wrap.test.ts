import { describe, expect, it } from 'vitest';
import { wrapText } from '../src/ui/tui/wrap.js';

describe('wrapText', () => {
  it('wraps at word boundaries', () => {
    expect(wrapText('hello world foo', 10)).toEqual(['hello', 'world foo']);
  });

  it('breaks words that are longer than the width', () => {
    expect(wrapText('abcdefgh', 5)).toEqual(['abcde', 'fgh']);
  });

  it('wraps CJK text by display width', () => {
    expect(wrapText('日本語テスト', 6)).toEqual(['日本語', 'テスト']);
  });

  it('preserves explicit newlines and blank lines', () => {
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });

  it('expands tabs to four-column stops', () => {
    expect(wrapText('\tx', 8)).toEqual(['    x']);
  });

  it('does not emit a trailing blank line for trailing spaces', () => {
    expect(wrapText('hello ', 5)).toEqual(['hello']);
  });

  it('returns no lines for non-positive widths', () => {
    expect(wrapText('a', 0)).toEqual([]);
  });
});
