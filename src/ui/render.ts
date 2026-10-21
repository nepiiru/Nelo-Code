import { applyInlineMarkdown, balanceEdgeMarkers } from './inline.js';
import { bold, getActiveTheme, paintToken } from './theme.js';

/**
 * Line-buffered streaming renderer with lightweight markdown styling.
 * Complete lines are styled and written immediately; the trailing partial
 * line is held until more text arrives or flush() is called.
 */
export class StreamRenderer {
  private buffer = '';
  private inCodeFence = false;

  constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}

  push(delta: string): void {
    this.buffer += delta;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.out.write(`${this.styleLine(line)}\n`);
      newline = this.buffer.indexOf('\n');
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    this.out.write(`${this.styleLine(this.buffer)}\n`);
    this.buffer = '';
  }

  private styleLine(line: string): string {
    const trimmed = line.trimStart();
    const theme = getActiveTheme().markdown;

    if (trimmed.startsWith('```')) {
      this.inCodeFence = !this.inCodeFence;
      return paintToken(theme.fence, line);
    }
    if (this.inCodeFence) {
      return paintToken(theme.code, line);
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      return bold(paintToken(theme.heading, line));
    }
    const styled = applyInlineMarkdown(balanceEdgeMarkers(line), theme);
    if (/^\s*[-*]\s+/.test(line)) {
      return styled.replace(
        /^(\s*)[-*]\s+/,
        (_match, indent: string) => `${indent}${paintToken(theme.bullet, '-')} `,
      );
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      return styled.replace(
        /^(\s*)(\d+\.)\s+/,
        (_match, indent: string, number: string) => `${indent}${paintToken(theme.bullet, number)} `,
      );
    }
    return styled;
  }
}
