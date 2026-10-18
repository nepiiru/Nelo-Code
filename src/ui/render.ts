import { ansi, paint } from './ansi.js';

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

    if (trimmed.startsWith('```')) {
      this.inCodeFence = !this.inCodeFence;
      return paint(line, ansi.dim);
    }
    if (this.inCodeFence) {
      return paint(line, ansi.cyan);
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      return paint(line, ansi.bold);
    }
    if (/^\s*[-*]\s+/.test(line)) {
      return line.replace(/^(\s*)[-*]\s+/, (_match, indent: string) => `${indent}${paint('-', ansi.cyan)} `);
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      return line.replace(
        /^(\s*)(\d+\.)\s+/,
        (_match, indent: string, number: string) => `${indent}${paint(number, ansi.cyan)} `,
      );
    }
    return line;
  }
}
