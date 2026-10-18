import { ansi, paint } from '../ansi.js';
import { stripAnsi, truncateAnsi } from './width.js';
import { wrapText } from './wrap.js';

/**
 * Formats assistant markdown into display lines that fit the given width.
 * Styling is intentionally light: headings, bullets, numbered lists, and
 * fenced code blocks. Inline markup is left as-is.
 */
export function formatMarkdown(text: string, width: number): string[] {
  const lines: string[] = [];
  let inFence = false;

  for (const raw of stripAnsi(text).split('\n')) {
    const trimmed = raw.trimStart();

    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      lines.push(paint(truncateAnsi(raw, width), ansi.dim));
      continue;
    }

    if (inFence) {
      for (const segment of wrapText(raw, width)) {
        lines.push(paint(segment, ansi.cyan));
      }
      continue;
    }

    if (/^#{1,6}\s/.test(trimmed)) {
      for (const segment of wrapText(raw, width)) {
        lines.push(paint(segment, ansi.bold));
      }
      continue;
    }

    if (/^\s*[-*]\s+/.test(raw)) {
      wrapText(raw, width).forEach((segment, index) => {
        if (index === 0) {
          lines.push(
            segment.replace(/^(\s*)[-*]\s+/, (_match, indent: string) => `${indent}${paint('-', ansi.cyan)} `),
          );
        } else {
          lines.push(segment);
        }
      });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(raw)) {
      wrapText(raw, width).forEach((segment, index) => {
        if (index === 0) {
          lines.push(
            segment.replace(
              /^(\s*)(\d+\.)\s+/,
              (_match, indent: string, number: string) => `${indent}${paint(number, ansi.cyan)} `,
            ),
          );
        } else {
          lines.push(segment);
        }
      });
      continue;
    }

    for (const segment of wrapText(raw, width)) {
      lines.push(segment);
    }
  }

  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
