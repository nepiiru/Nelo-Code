import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TuiUI } from '../src/ui/tui/tui.js';
import { BUILTIN_THEMES, setActiveTheme } from '../src/ui/theme.js';
import { dummyTool } from './helpers.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;

  setRawMode(value: boolean): this {
    this.rawMode = value;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }
}

class FakeOutput extends EventEmitter {
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

let previousNoColor: string | undefined;

beforeEach(() => {
  previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
});

afterEach(() => {
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;
});

function makeTui(): { tui: TuiUI; stdin: FakeInput; stdout: FakeOutput } {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const tui = new TuiUI({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  return { tui, stdin, stdout };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('TuiUI', () => {
  it('renders the header, transcript, and status bar', async () => {
    const { tui, stdout } = makeTui();
    tui.updateStatus({ model: 'claude-test', mode: 'ask', cwdLabel: 'project' });
    tui.start();

    try {
      tui.addUserMessage('hello');
      tui.text('hi there');
      tui.endText();
      tui.setIdle();

      await wait(60);

      const output = stdout.text();
      expect(output).toContain('Nelo Code');
      expect(output).toContain('claude-test');
      expect(output).toContain('hello');
      expect(output).toContain('hi there');
      expect(output).toContain('Ready');
    } finally {
      tui.stop();
    }
  });

  it('resolves permission prompts from key presses', async () => {
    const { tui, stdin, stdout } = makeTui();
    tui.start();

    try {
      const answerPromise = tui.confirm({
        tool: dummyTool('write_file', false),
        input: {},
        summary: 'demo.txt',
      });

      await wait(40);
      expect(stdout.text()).toContain('Permission required');
      expect(stdout.text()).toContain('write_file');

      stdin.emit('keypress', 'a', { name: 'a' });
      await expect(answerPromise).resolves.toBe('always');
      expect(tui.hasPendingPrompt()).toBe(false);
    } finally {
      tui.stop();
    }
  });

  it('reads an edited input line', async () => {
    const { tui, stdin } = makeTui();
    tui.start();

    try {
      const linePromise = tui.readLine();
      stdin.emit('keypress', 'h', { name: 'h' });
      stdin.emit('keypress', 'i', { name: 'i' });
      stdin.emit('keypress', '\r', { name: 'return' });

      await expect(linePromise).resolves.toBe('hi');
    } finally {
      tui.stop();
    }
  });

  it('exits on a double Ctrl+C when idle', async () => {
    const { tui, stdin } = makeTui();
    tui.start();

    try {
      const linePromise = tui.readLine();
      stdin.emit('keypress', '\x03', { name: 'c', ctrl: true });
      stdin.emit('keypress', '\x03', { name: 'c', ctrl: true });

      await expect(linePromise).resolves.toBeNull();
    } finally {
      tui.stop();
    }
  });

  it('clears the input on a single Ctrl+C and keeps running', async () => {
    const { tui, stdin } = makeTui();
    tui.start();

    try {
      const linePromise = tui.readLine();
      stdin.emit('keypress', 'x', { name: 'x' });
      stdin.emit('keypress', '\x03', { name: 'c', ctrl: true });
      stdin.emit('keypress', 'y', { name: 'y' });
      stdin.emit('keypress', '\r', { name: 'return' });

      await expect(linePromise).resolves.toBe('y');
    } finally {
      tui.stop();
    }
  });

  it('shows resource vitals in the status bar', async () => {
    const { tui, stdout } = makeTui();
    tui.updateStatus({ model: 'local-model', mode: 'ask', cwdLabel: 'project' });
    tui.start();

    try {
      tui.setVitals(['CPU 12%', 'RAM 9.5G/32.0G', 'GPU 71% 4.0G/12.0G']);
      await wait(60);

      const output = stdout.text();
      expect(output).toContain('CPU 12%');
      expect(output).toContain('RAM 9.5G/32.0G');
      expect(output).toContain('GPU 71% 4.0G/12.0G');
    } finally {
      tui.stop();
    }
  });

  it('repaints the transcript after a theme change', async () => {
    const { tui, stdout } = makeTui();
    tui.start();

    try {
      tui.addUserMessage('hello');
      tui.setTheme(BUILTIN_THEMES.mono!);
      await wait(60);

      const output = stdout.text();
      expect(output).toContain('hello');
      expect(output).toContain('[nelo]');
    } finally {
      tui.stop();
      setActiveTheme(BUILTIN_THEMES.nelo!);
    }
  });
});
