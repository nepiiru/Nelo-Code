import { bold, dim, italic, paintToken, type ThemeMarkdown } from './theme.js';

/**
 * Inline markdown styling shared by the streaming renderer (REPL) and the TUI.
 *
 * Wrapping happens before styling, so a span that straddles a line break leaves
 * a dangling marker behind. `balanceEdgeMarkers` removes those stray markers
 * from the line edges so the raw syntax never leaks into the transcript.
 */

const PLACEHOLDER = '\u0000';

const EDGE_MARKERS = ['**', '__', '`'];

function countOf(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** Drops a marker that has no partner on the same line (split by wrapping). */
export function balanceEdgeMarkers(text: string): string {
  let out = text;
  for (const marker of EDGE_MARKERS) {
    if (countOf(out, marker) % 2 === 0) continue;
    const trimmedEnd = out.replace(/\s+$/, '');
    if (trimmedEnd.endsWith(marker)) {
      out = trimmedEnd.slice(0, -marker.length).replace(/\s+$/, '');
      continue;
    }
    const leading = /^\s*/.exec(out)?.[0] ?? '';
    if (out.slice(leading.length).startsWith(marker)) {
      out = leading + out.slice(leading.length + marker.length).replace(/^\s+/, '');
    }
  }
  return out;
}

/**
 * Applies inline markdown (inline code, links, strong, emphasis) to a single
 * display line. Markers are always removed, even when colors are disabled.
 */
export function applyInlineMarkdown(text: string, theme: ThemeMarkdown): string {
  if (!text) return text;

  const slots: string[] = [];
  const hold = (rendered: string): string => {
    slots.push(rendered);
    return `${PLACEHOLDER}${slots.length - 1}${PLACEHOLDER}`;
  };

  const styled = text
    // `code` first so its content is not re-parsed for emphasis.
    .replace(/`([^`\n]+)`/g, (_match, code: string) => hold(paintToken(theme.code, code)))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
      label === url ? hold(paintToken(theme.link, url)) : `${label}${hold(dim(`<${url}>`))}`,
    )
    .replace(/\*\*([^*\n]+)\*\*/g, (_match, body: string) =>
      hold(bold(paintToken(theme.strong, body))),
    )
    .replace(/__([^_\n]+)__/g, (_match, body: string) => hold(bold(paintToken(theme.strong, body))))
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?![*\w])/g, (_match, lead: string, body: string) =>
      `${lead}${hold(italic(paintToken(theme.emphasis, body)))}`,
    )
    .replace(/(^|[^_\w])_([^_\s][^_\n]*)_(?![_\w])/g, (_match, lead: string, body: string) =>
      `${lead}${hold(italic(paintToken(theme.emphasis, body)))}`,
    );

  return styled.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'),
    (_match, index: string) => slots[Number(index)] ?? '',
  );
}
