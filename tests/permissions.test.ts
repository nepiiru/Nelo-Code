import { describe, expect, it } from 'vitest';
import { PermissionManager, scopeKey, type PermissionAnswer } from '../src/permissions.js';
import { dummyTool, testConfig } from './helpers.js';

const readTool = dummyTool('read_file', true);
const writeTool = dummyTool('write_file', false);
const commandTool = dummyTool('run_command', false);

function manager(mode: 'ask' | 'auto' | 'readonly', answers: PermissionAnswer[] = [], overrides = {}) {
  const prompts: string[] = [];
  const config = testConfig({ permissions: { mode, allow: [], denyCommands: [], ...overrides } });
  const permissionManager = new PermissionManager(config, async (request) => {
    prompts.push(request.summary);
    return answers.shift() ?? 'no';
  });
  return { permissionManager, prompts };
}

describe('PermissionManager', () => {
  it('readonly mode allows reads and denies writes', async () => {
    const { permissionManager, prompts } = manager('readonly');
    await expect(permissionManager.authorize(readTool, {})).resolves.toEqual({ allowed: true });
    const denied = await permissionManager.authorize(writeTool, {});
    expect(denied.allowed).toBe(false);
    expect(denied.message).toMatch(/read-only/);
    expect(prompts).toHaveLength(0);
  });

  it('auto mode allows normal tools without prompting', async () => {
    const { permissionManager, prompts } = manager('auto');
    await expect(permissionManager.authorize(writeTool, {})).resolves.toEqual({ allowed: true });
    expect(prompts).toHaveLength(0);
  });

  it('auto mode still blocks catastrophic commands', async () => {
    const { permissionManager } = manager('auto');
    const verdict = await permissionManager.authorize(commandTool, { command: 'rm -rf /' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toMatch(/root|home/i);
  });

  it('ask mode auto-approves read-only tools', async () => {
    const { permissionManager, prompts } = manager('ask');
    await expect(permissionManager.authorize(readTool, {})).resolves.toEqual({ allowed: true });
    expect(prompts).toHaveLength(0);
  });

  it('ask mode prompts for mutating tools and honors the answer', async () => {
    const { permissionManager, prompts } = manager('ask', ['yes']);
    await expect(permissionManager.authorize(writeTool, {})).resolves.toEqual({ allowed: true });
    expect(prompts).toEqual(['write_file']);

    const denied = manager('ask', ['no']);
    const verdict = await denied.permissionManager.authorize(writeTool, {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toMatch(/declined/);
  });

  it('remembers "always" for the rest of the session', async () => {
    const { permissionManager, prompts } = manager('ask', ['always']);
    await expect(permissionManager.authorize(writeTool, {})).resolves.toEqual({ allowed: true });
    await expect(permissionManager.authorize(writeTool, {})).resolves.toEqual({ allowed: true });
    expect(prompts).toHaveLength(1);
  });

  it('scopes run_command "always" to the command name', async () => {
    const { permissionManager, prompts } = manager('ask', ['always']);
    await permissionManager.authorize(commandTool, { command: 'npm test' });
    await permissionManager.authorize(commandTool, { command: 'npm run build' });
    await permissionManager.authorize(commandTool, { command: 'git status' });
    expect(prompts).toHaveLength(2);
    expect(scopeKey(commandTool, { command: 'npm test' })).toBe('run_command:npm');
  });

  it('respects the allow list', async () => {
    const { permissionManager, prompts } = manager('ask', [], { allow: ['write_file'] });
    await expect(permissionManager.authorize(writeTool, {})).resolves.toEqual({ allowed: true });
    expect(prompts).toHaveLength(0);
  });

  it('respects denyCommands patterns', async () => {
    const { permissionManager } = manager('ask', [], { denyCommands: ['\\bcurl\\b'] });
    const verdict = await permissionManager.authorize(commandTool, { command: 'curl example.com' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toMatch(/denied pattern/);
  });
});
