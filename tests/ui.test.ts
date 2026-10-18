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
