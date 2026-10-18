import { charWidth } from './width.js';

function expandTabs(line: string): string {
  let output = '';
  let column = 0;
  for (const character of line) {
    if (character === '\t') {
      const spaces = 4 - (column % 4);
      output += ' '.repeat(spaces);
      column += spaces;
    } else {
      output += character;
      column += charWidth(character.codePointAt(0) ?? 0);
    }
  }
  return output;
}

function wrapLine(rawLine: string, width: number): string[] {
  const line = expandTabs(rawLine);
  if (line.length === 0) return [''];

  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  let lastBreak = -1;

  for (const character of line) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32) continue;
    const characterWidth = charWidth(codePoint);

    if (currentWidth + characterWidth > width && current.length > 0) {
      const previousWidth = charWidth(current.codePointAt(current.length - 1) ?? 0);
      const canBreakAtSpace = lastBreak > 0 && characterWidth === 1 && previousWidth === 1;

      if (canBreakAtSpace) {
        const head = current.slice(0, lastBreak).trimEnd();
        const tail = current.slice(lastBreak + 1);
        if (head.length > 0 || lines.length === 0) lines.push(head);
        current = tail;
        currentWidth = 0;
        for (const tailCharacter of tail) {
          currentWidth += charWidth(tailCharacter.codePointAt(0) ?? 0);
        }
        lastBreak = current.lastIndexOf(' ');
      } else {
        // Wide characters (CJK) may break anywhere, so fill the line to the edge
        // instead of retreating to an earlier space.
        const head = current.trimEnd();
        if (head.length > 0 || lines.length === 0) lines.push(head);
        current = '';
        currentWidth = 0;
        lastBreak = -1;
      }
    }

    current += character;
    currentWidth += characterWidth;
    if (character === ' ') lastBreak = current.length - 1;
  }

  if (current.length > 0) {
    const trimmed = current.trimEnd();
    if (trimmed.length > 0 || lines.length === 0) lines.push(trimmed);
  }
  return lines.length > 0 ? lines : [''];
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    lines.push(...wrapLine(rawLine, width));
  }
  return lines;
}
