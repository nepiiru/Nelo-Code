import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyInlineMarkdown, balanceEdgeMarkers } from '../src/ui/inline.js';
import { getActiveTheme } from '../src/ui/theme.js';

const theme = getActiveTheme().markdown;

let previousNoColor: string | undefined;
let previousForceColor: string | undefined;

function withColor<T>(fn: () => T): T {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  try {
    return fn();
  } finally {
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previousForceColor;
    if (previousNoColor !== undefined) process.env.NO_COLOR = previousNoColor;
  }
}

beforeEach(() => {
  previousNoColor = process.env.NO_COLOR;
  previousForceColor = process.env.FORCE_COLOR;
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
});

afterEach(() => {
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previousForceColor;
});

describe('applyInlineMarkdown', () => {
  it('removes markers even when colors are disabled', () => {
    expect(applyInlineMarkdown('**bold** and *soft* and `code`', theme)).toBe(
      'bold and soft and code',
    );
  });

  it('leaves plain prose untouched', () => {
    expect(applyInlineMarkdown('no markup here', theme)).toBe('no markup here');
  });

  it('keeps snake_case and arithmetic asterisks intact', () => {
    expect(applyInlineMarkdown('use some_var_name and 2**3', theme)).toBe(
      'use some_var_name and 2**3',
    );
  });

  it('renders links as label plus dimmed url', () => {
    expect(applyInlineMarkdown('see [docs](https://example.com)', theme)).toBe(
      'see docs<https://example.com>',
    );
  });

  it('collapses links whose label is the url', () => {
    expect(applyInlineMarkdown('[https://example.com](https://example.com)', theme)).toBe(
      'https://example.com',
    );
  });

  it('does not re-parse emphasis inside inline code', () => {
    expect(applyInlineMarkdown('`a * b * c`', theme)).toBe('a * b * c');
  });

  it('emits bold and italic SGR sequences when colors are on', () => {
    const output = withColor(() => applyInlineMarkdown('**bold** *soft*', theme));
    expect(output).toContain('\x1b[1m');
    expect(output).toContain('\x1b[3m');
    expect(output).toContain('bold');
    expect(output).not.toContain('**');
  });

  it('handles underscores for strong and emphasis', () => {
    expect(applyInlineMarkdown('__strong__ and _soft_', theme)).toBe('strong and soft');
  });
});

describe('balanceEdgeMarkers', () => {
  it('drops a marker split at the end of a wrapped line', () => {
    expect(balanceEdgeMarkers('text **')).toBe('text');
  });

  it('drops a marker split at the start of a wrapped line', () => {
    expect(balanceEdgeMarkers('**bold continues')).toBe('bold continues');
  });

  it('keeps balanced markers in place', () => {
    expect(balanceEdgeMarkers('**bold** here')).toBe('**bold** here');
  });

  it('keeps balanced backticks in place', () => {
    expect(balanceEdgeMarkers('run `npm test`')).toBe('run `npm test`');
  });
});
