import { applyInlineMarkdown, balanceEdgeMarkers } from '../inline.js';
import { bold, getActiveTheme, paintToken } from '../theme.js';
import { stripAnsi, truncateAnsi } from './width.js';
import { wrapText } from './wrap.js';

/**
 * Formats assistant markdown into display lines that fit the given width.
 * Styling is intentionally light: headings, bullets, numbered lists, fenced
 * code blocks and inline spans (code, strong, emphasis, links). Colors come
 * from the active theme.
 */
export function formatMarkdown(text: string, width: number): string[] {
  const lines: string[] = [];
  const theme = getActiveTheme().markdown;
  const inline = (line: string): string => applyInlineMarkdown(balanceEdgeMarkers(line), theme);
  let inFence = false;

  for (const raw of stripAnsi(text).split('\n')) {
    const trimmed = raw.trimStart();

    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      lines.push(paintToken(theme.fence, truncateAnsi(raw, width)));
      continue;
    }

    if (inFence) {
      for (const segment of wrapText(raw, width)) {
        lines.push(paintToken(theme.code, segment));
      }
      continue;
    }

    if (/^#{1,6}\s/.test(trimmed)) {
      for (const segment of wrapText(raw, width)) {
        lines.push(bold(paintToken(theme.heading, inline(segment))));
      }
      continue;
    }

    if (/^\s*[-*]\s+/.test(raw)) {
      wrapText(raw, width).forEach((segment, index) => {
        if (index === 0) {
          lines.push(
            inline(segment).replace(
              /^(\s*)[-*]\s+/,
              (_match, indent: string) => `${indent}${paintToken(theme.bullet, '-')} `,
            ),
          );
        } else {
          lines.push(inline(segment));
        }
      });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(raw)) {
      wrapText(raw, width).forEach((segment, index) => {
        if (index === 0) {
          lines.push(
            inline(segment).replace(
              /^(\s*)(\d+\.)\s+/,
              (_match, indent: string, number: string) =>
                `${indent}${paintToken(theme.bullet, number)} `,
            ),
          );
        } else {
          lines.push(inline(segment));
        }
      });
      continue;
    }

    for (const segment of wrapText(raw, width)) {
      lines.push(inline(segment));
    }
  }

  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
