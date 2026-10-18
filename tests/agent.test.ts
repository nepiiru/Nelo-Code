import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import type { ModelResponse } from '../src/client.js';
import { PermissionManager } from '../src/permissions.js';
import { createTools } from '../src/tools/index.js';
import type { Message } from '../src/types.js';
import {
  FakeClient,
  makeTempDir,
  removeTempDir,
  TestUI,
  testConfig,
  textResponse,
  toolUseResponse,
} from './helpers.js';

describe('Agent', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir('nelo-agent-');
  });

  afterEach(async () => {
    await removeTempDir(workspace);
  });

  function buildAgent(options: {
    responses: ModelResponse[];
    mode?: 'ask' | 'auto' | 'readonly';
    answers?: Array<'yes' | 'no' | 'always'>;
    maxTurns?: number;
    error?: Error;
  }) {
    const client = new FakeClient(options.responses, options.error);
    const ui = new TestUI(options.answers ?? []);
    const config = testConfig({
      maxTurns: options.maxTurns ?? 40,
      permissions: { mode: options.mode ?? 'auto', allow: [], denyCommands: [] },
    });
    const permissions = new PermissionManager(config, (request) => ui.confirm(request));
    const agent = new Agent({
      client,
      config,
      tools: createTools(),
      permissions,
      ui,
      systemPrompt: 'You are a test agent.',
      workspaceRoot: workspace,
    });
    return { agent, client, ui };
  }

  it('runs a plain text turn', async () => {
    const { agent, ui } = buildAgent({ responses: [textResponse('Hello there!')] });
    const result = await agent.run('hi');

    expect(result.aborted).toBe(false);
    expect(result.turns).toBe(1);
    expect(ui.textBuffer).toBe('Hello there!');
    expect(agent.messages).toHaveLength(2);
    expect(agent.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello there!' }],
    });
    expect(agent.usage.inputTokens).toBe(10);
  });

  it('executes a tool call and feeds the result back', async () => {
    await writeFile(join(workspace, 'note.txt'), 'tool file contents\n');
    const { agent, client, ui } = buildAgent({
      responses: [
        toolUseResponse('read_file', { path: 'note.txt' }, 'toolu_1'),
        textResponse('The file says hello.'),
      ],
    });

    const result = await agent.run('read note.txt');

    expect(result.turns).toBe(2);
    expect(client.requests).toHaveLength(2);
    expect(agent.messages).toHaveLength(4);

    const toolResultMessage = agent.messages[2];
    expect(toolResultMessage?.role).toBe('user');
    const block = toolResultMessage?.content[0];
    expect(block).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    if (block?.type === 'tool_result') {
      expect(block.content).toContain('tool file contents');
      expect(block.is_error).toBeUndefined();
    }
    expect(ui.toolEvents).toEqual([
      'start:read_file:note.txt',
      'end:read_file:1 line:false',
    ]);
    expect(ui.textBuffer).toBe('The file says hello.');
  });

  it('returns an error result for unknown tools', async () => {
    const { agent } = buildAgent({
      responses: [toolUseResponse('nope_tool', {}), textResponse('Recovered.')],
    });

    await agent.run('use a bad tool');

    const resultBlock = agent.messages[2]?.content[0];
    expect(resultBlock).toMatchObject({ type: 'tool_result', is_error: true });
    if (resultBlock?.type === 'tool_result') {
      expect(resultBlock.content).toContain('Unknown tool: nope_tool');
    }
  });

  it('does not run mutating tools when permission is declined', async () => {
    const { agent, ui } = buildAgent({
      responses: [
        toolUseResponse('write_file', { path: 'new.txt', content: 'x' }),
        textResponse('Okay.'),
      ],
      mode: 'ask',
      answers: ['no'],
    });

    await agent.run('write a file');

    const resultBlock = agent.messages[2]?.content[0];
    expect(resultBlock).toMatchObject({ type: 'tool_result', is_error: true });
    if (resultBlock?.type === 'tool_result') {
      expect(resultBlock.content).toContain('Permission denied');
    }
    await expect(readFile(join(workspace, 'new.txt'), 'utf8')).rejects.toThrow();
    expect(ui.confirmRequests).toHaveLength(1);
  });

  it('blocks catastrophic commands even in auto mode', async () => {
    const { agent } = buildAgent({
      responses: [toolUseResponse('run_command', { command: 'rm -rf /' }), textResponse('No.')],
      mode: 'auto',
    });

    await agent.run('delete everything');

    const resultBlock = agent.messages[2]?.content[0];
    expect(resultBlock).toMatchObject({ type: 'tool_result', is_error: true });
    if (resultBlock?.type === 'tool_result') {
      expect(resultBlock.content).toContain('Permission denied');
    }
  });

  it('stops at maxTurns', async () => {
    const { agent, ui } = buildAgent({
      responses: [toolUseResponse('list_files', { path: '.' })],
      maxTurns: 1,
    });

    const result = await agent.run('list files');

    expect(result.turns).toBe(1);
    expect(ui.warnings.join('\n')).toMatch(/maximum of 1 turns/);
    const last = agent.messages[agent.messages.length - 1];
    expect(last?.content[0]).toMatchObject({ type: 'tool_result' });
  });

  it('reports aborted runs', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
    const { agent } = buildAgent({ responses: [], error: abortError });

    const result = await agent.run('hi');
    expect(result.aborted).toBe(true);
  });

  it('preserves conversation state across runs', async () => {
    const { agent } = buildAgent({
      responses: [textResponse('first'), textResponse('second')],
    });

    await agent.run('one');
    await agent.run('two');

    const roles = agent.messages.map((message: Message) => message.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('compacts automatically when the context limit is exceeded', async () => {
    const client = new FakeClient([
      textResponse('summary text'),
      textResponse('after compaction'),
    ]);
    const ui = new TestUI();
    const config = testConfig({
      context: { maxTokens: 1000, compactAt: 0.9 },
      permissions: { mode: 'auto', allow: [], denyCommands: [] },
    });
    const permissions = new PermissionManager(config, (request) => ui.confirm(request));
    const agent = new Agent({
      client,
      config,
      tools: createTools(),
      permissions,
      ui,
      systemPrompt: 'system',
      workspaceRoot: workspace,
    });

    for (let index = 0; index < 10; index += 1) {
      agent.messages.push({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `message ${index} ${'x'.repeat(200)}` }],
      });
    }

    await agent.run('next question');

    expect(client.requests.length).toBeGreaterThanOrEqual(2);
    expect(client.requests[0]?.system).toContain('compacting a conversation');
    expect(ui.infoMessages.join('\n')).toMatch(/Compacted/);
  });
});
