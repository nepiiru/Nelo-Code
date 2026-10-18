import { describe, expect, it } from 'vitest';
import { Screen } from '../src/ui/tui/screen.js';

class FakeOutput {
  readonly chunks: string[] = [];
  columns = 80;
  rows = 24;
  isTTY = true;

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  text(): string {
    return this.chunks.join('');
  }
}

function makeScreen(output: FakeOutput): Screen {
  return new Screen(output as unknown as NodeJS.WriteStream);
}

describe('Screen', () => {
  it('enters and leaves the alternate screen buffer', () => {
    const output = new FakeOutput();
    const screen = makeScreen(output);

    screen.start();
    expect(output.text()).toContain('\x1b[?1049h');
    expect(output.text()).toContain('\x1b[?25l');

    screen.stop();
    expect(output.text()).toContain('\x1b[?25h');
    expect(output.text()).toContain('\x1b[?1049l');
  });

  it('redraws every row with absolute cursor addressing', () => {
    const output = new FakeOutput();
    const screen = makeScreen(output);

    screen.render(['alpha', 'beta']);

    const text = output.text();
    expect(text).toContain('\x1b[1;1H');
    expect(text).toContain('\x1b[2;1H');
    expect(text).toContain('\x1b[24;1H');
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text).toContain('\x1b[K');
  });

  it('falls back to 80x24 when the stream has no size', () => {
    const output = new FakeOutput();
    output.columns = undefined as unknown as number;
    output.rows = undefined as unknown as number;
    const screen = makeScreen(output);

    expect(screen.columns).toBe(80);
    expect(screen.rows).toBe(24);
  });
});
