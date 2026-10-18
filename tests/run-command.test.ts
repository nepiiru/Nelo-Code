import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assessCommand } from '../src/command-safety.js';
import { runCommandTool } from '../src/tools/run-command.js';
import { runShellCommand } from '../src/utils/exec.js';
import { makeTempDir, removeTempDir, toolContext } from './helpers.js';

describe('runShellCommand', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir('nelo-exec-');
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  it('captures stdout and a zero exit code', async () => {
    const result = await runShellCommand('echo hello', { cwd: workspace });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr and non-zero exit codes', async () => {
    const result = await runShellCommand('node -e "console.error(\'boom\'); process.exit(3)"', {
      cwd: workspace,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('kills commands that exceed the timeout', async () => {
    const started = Date.now();
    const result = await runShellCommand('node -e "setTimeout(() => {}, 5000)"', {
      cwd: workspace,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('supports aborting a running command', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runShellCommand('node -e "setTimeout(() => {}, 5000)"', {
      cwd: workspace,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  });
});

describe('run_command tool', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir('nelo-exec-tool-');
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  it('returns formatted output with a display summary', async () => {
    const result = await runCommandTool.execute(
      { command: 'echo tool-output' },
      toolContext(workspace),
    );
    expect(result.content).toContain('$ echo tool-output');
    expect(result.content).toContain('tool-output');
    expect(result.display).toMatch(/^exit 0/);
    expect(result.isError).toBeFalsy();
  });

  it('marks timeouts as errors', async () => {
    const result = await runCommandTool.execute(
      { command: 'node -e "setTimeout(() => {}, 5000)"', timeout_ms: 300 },
      toolContext(workspace),
    );
    expect(result.isError).toBe(true);
    expect(result.display).toContain('timed out');
  });
});

describe('assessCommand', () => {
  it('blocks catastrophic commands', () => {
    expect(assessCommand('rm -rf /').dangerous).toBe(true);
    expect(assessCommand('sudo rm -rf /').dangerous).toBe(true);
    expect(assessCommand('rm -rf ~/').dangerous).toBe(true);
    expect(assessCommand('mkfs.ext4 /dev/sda1').dangerous).toBe(true);
    expect(assessCommand('dd if=/dev/zero of=/dev/sda').dangerous).toBe(true);
    expect(assessCommand('shutdown -h now').dangerous).toBe(true);
    expect(assessCommand(':(){ :|:& };:').dangerous).toBe(true);
  });

  it('allows ordinary development commands', () => {
    expect(assessCommand('npm test').dangerous).toBe(false);
    expect(assessCommand('rm -rf node_modules').dangerous).toBe(false);
    expect(assessCommand('rm -rf ./dist').dangerous).toBe(false);
    expect(assessCommand('git status').dangerous).toBe(false);
  });
});
