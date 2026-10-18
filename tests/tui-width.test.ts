import { describe, expect, it } from 'vitest';
import {
  charWidth,
  padToWidth,
  stringWidth,
  stripAnsi,
  truncateAnsi,
} from '../src/ui/tui/width.js';

describe('charWidth', () => {
  it('measures ASCII, wide, and zero-width characters', () => {
    expect(charWidth('a'.codePointAt(0) ?? 0)).toBe(1);
    expect(charWidth('あ'.codePointAt(0) ?? 0)).toBe(2);
    expect(charWidth('😀'.codePointAt(0) ?? 0)).toBe(2);
    expect(charWidth(0x0301)).toBe(0);
    expect(charWidth(0x1b)).toBe(0);
  });
});

describe('stringWidth', () => {
  it('ignores ANSI escapes and counts wide characters as two cells', () => {
    expect(stringWidth('\x1b[31mred\x1b[0m')).toBe(3);
    expect(stringWidth('日本')).toBe(4);
    expect(stringWidth('a日')).toBe(3);
  });
});

describe('truncateAnsi', () => {
  it('keeps escape sequences and resets styles when cutting', () => {
    const result = truncateAnsi('\x1b[31mhello world\x1b[0m', 5);
    expect(result).toContain('\x1b[31m');
    expect(result.endsWith('\x1b[0m')).toBe(true);
    expect(stripAnsi(result)).toBe('hello');
    expect(stringWidth(result)).toBe(5);
  });

  it('does not split wide characters', () => {
    expect(stripAnsi(truncateAnsi('あいう', 3))).toBe('あ');
  });

  it('returns an empty string for non-positive widths', () => {
    expect(truncateAnsi('abc', 0)).toBe('');
  });
});

describe('padToWidth', () => {
  it('pads and truncates by display width', () => {
    expect(padToWidth('ab', 4)).toBe('ab  ');
    expect(padToWidth('日本語', 4)).toBe('日本');
  });
});
