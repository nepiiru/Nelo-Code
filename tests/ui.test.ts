import { describe, expect, it } from 'vitest';
import { TerminalUI } from '../src/ui/ui.js';
import { dummyTool } from './helpers.js';

class MemoryStream {
  output = '';
  isTTY = false;

  write(chunk: string | Uint8Array): boolean {
    this.output += chunk.toString();
    return true;
  }
}

const writeTool = dummyTool('write_file', false);
const request = { tool: writeTool, input: { path: 'a.txt' }, summary: 'a.txt' };
const selectRequest = {
  title: 'Select model',
  options: [
    { value: 'a', label: 'alpha' },
    { value: 'b', label: 'beta', description: 'second' },
  ],
  selected: 'a',
};

function buildUI(interactive: boolean, answer = '') {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const ui = new TerminalUI({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    interactive,
    question: interactive ? async () => answer : undefined,
  });
  return { ui, stdout, stderr };
}

describe('TerminalUI.confirm', () => {
  it('denies in non-interactive mode with an explanation', async () => {
    const { ui, stderr } = buildUI(false);
    await expect(ui.confirm(request)).resolves.toBe('no');
    expect(stderr.output).toContain('non-interactively');
    expect(stderr.output).toContain('--yes');
  });

  it('parses yes, always, and no answers', async () => {
    await expect(buildUI(true, 'y').ui.confirm(request)).resolves.toBe('yes');
    await expect(buildUI(true, 'yes').ui.confirm(request)).resolves.toBe('yes');
    await expect(buildUI(true, 'a').ui.confirm(request)).resolves.toBe('always');
    await expect(buildUI(true, 'always').ui.confirm(request)).resolves.toBe('always');
    await expect(buildUI(true, '').ui.confirm(request)).resolves.toBe('no');
    await expect(buildUI(true, 'n').ui.confirm(request)).resolves.toBe('no');
  });

  it('shows the tool name and summary, and clears the pending flag', async () => {
    const { ui, stdout } = buildUI(true, 'n');
    expect(ui.hasPendingPrompt()).toBe(false);
    await ui.confirm(request);
    expect(stdout.output).toContain('write_file');
    expect(stdout.output).toContain('a.txt');
    expect(ui.hasPendingPrompt()).toBe(false);
  });
});

describe('TerminalUI.select', () => {
  it('lists options and cancels in non-interactive mode', async () => {
    const { ui, stderr } = buildUI(false);
    await expect(ui.select(selectRequest)).resolves.toBeNull();
    expect(stderr.output).toContain('Select model');
    expect(stderr.output).toContain('alpha');
    expect(stderr.output).toContain('beta');
    expect(stderr.output).toContain('second');
  });

  it('accepts numbers and labels', async () => {
    await expect(buildUI(true, '2').ui.select(selectRequest)).resolves.toBe('b');
    await expect(buildUI(true, 'alpha').ui.select(selectRequest)).resolves.toBe('a');
    await expect(buildUI(true, '').ui.select(selectRequest)).resolves.toBeNull();
  });

  it('tracks the pending prompt while waiting for an answer', async () => {
    let answer!: (value: string) => void;
    const question = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const ui = new TerminalUI({
      stdout: new MemoryStream() as unknown as NodeJS.WriteStream,
      stderr: new MemoryStream() as unknown as NodeJS.WriteStream,
      interactive: true,
      question: () => question,
    });

    const pending = ui.select(selectRequest);
    expect(ui.hasPendingPrompt()).toBe(true);
    answer('1');
    await expect(pending).resolves.toBe('a');
    expect(ui.hasPendingPrompt()).toBe(false);
  });
});
