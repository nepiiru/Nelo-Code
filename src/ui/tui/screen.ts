/**
 * Low-level terminal screen management: alternate screen buffer, cursor
 * visibility, and flicker-free full redraws using absolute cursor addressing.
 */
export class Screen {
  private started = false;

  constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}

  get stream(): NodeJS.WriteStream {
    return this.out;
  }

  get columns(): number {
    return this.out.columns ?? 80;
  }

  get rows(): number {
    return this.out.rows ?? 24;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[0m');
    this.clear();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }

  clear(): void {
    this.out.write('\x1b[2J\x1b[H');
  }

  render(lines: string[]): void {
    const rows = this.rows;
    const chunks: string[] = ['\x1b[?2026h'];

    for (let row = 0; row < rows; row += 1) {
      chunks.push(`\x1b[${row + 1};1H\x1b[K`, lines[row] ?? '');
    }

    chunks.push('\x1b[?2026l');
    this.out.write(chunks.join(''));
  }
}
