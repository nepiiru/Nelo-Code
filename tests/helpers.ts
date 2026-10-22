import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelClient, ModelRequest, ModelResponse, StreamCallbacks } from '../src/client.js';
import type { Config } from '../src/config.js';
import { defaultConfig } from '../src/config.js';
import type { PermissionAnswer, PermissionRequest } from '../src/permissions.js';
import type { SelectRequest } from '../src/ui/ui.js';
import type { ContentBlock, Tool, ToolContext, UsageTotals } from '../src/types.js';
import type { UI } from '../src/ui/ui.js';

export async function makeTempDir(prefix = 'nelo-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const config = defaultConfig();
  return {
    ...config,
    ...overrides,
    permissions: { ...config.permissions, ...(overrides.permissions ?? {}) },
    context: { ...config.context, ...(overrides.context ?? {}) },
    workspace: { ...config.workspace, ...(overrides.workspace ?? {}) },
  };
}

export function toolContext(workspaceRoot: string, config: Config = testConfig()): ToolContext {
  return { workspaceRoot, config };
}

export function usage(inputTokens = 10, outputTokens = 5): UsageTotals {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

export function textResponse(text: string, stopReason = 'end_turn'): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason,
    usage: usage(),
  };
}

export function toolUseResponse(
  name: string,
  input: Record<string, unknown>,
  id = 'toolu_test_1',
  extraContent: ContentBlock[] = [],
): ModelResponse {
  return {
    content: [...extraContent, { type: 'tool_use', id, name, input }],
    stopReason: 'tool_use',
    usage: usage(),
  };
}

export class FakeClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly responses: ModelResponse[];
  private readonly errorToThrow?: Error;

  constructor(responses: ModelResponse[], errorToThrow?: Error) {
    this.responses = [...responses];
    this.errorToThrow = errorToThrow;
  }

  async stream(
    request: ModelRequest,
    callbacks: StreamCallbacks,
  ): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.errorToThrow) throw this.errorToThrow;
    const response = this.responses.shift();
    if (!response) throw new Error('FakeClient: no scripted response left.');
    for (const block of response.content) {
      if (block.type === 'text') callbacks.onText(block.text);
    }
    return response;
  }
}

export class TestUI implements UI {
  readonly infoMessages: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly toolEvents: string[] = [];
  readonly confirmRequests: PermissionRequest[] = [];
  readonly selectRequests: SelectRequest[] = [];
  textBuffer = '';
  private readonly confirmAnswers: PermissionAnswer[];
  private readonly selectAnswers: Array<string | null>;

  constructor(
    confirmAnswers: PermissionAnswer[] = [],
    selectAnswers: Array<string | null> = [],
  ) {
    this.confirmAnswers = [...confirmAnswers];
    this.selectAnswers = [...selectAnswers];
  }

  text(delta: string): void {
    this.textBuffer += delta;
  }

  endText(): void {}

  toolStart(name: string, summary: string): void {
    this.toolEvents.push(`start:${name}:${summary}`);
  }

  toolEnd(name: string, summary: string, isError: boolean): void {
    this.toolEvents.push(`end:${name}:${summary}:${isError}`);
  }

  info(message: string): void {
    this.infoMessages.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  raw(): void {}

  stats(): void {}

  spinner(): void {}

  stopSpinner(): void {}

  async confirm(request: PermissionRequest): Promise<PermissionAnswer> {
    this.confirmRequests.push(request);
    return this.confirmAnswers.shift() ?? 'no';
  }

  async select(request: SelectRequest): Promise<string | null> {
    this.selectRequests.push(request);
    return this.selectAnswers.shift() ?? null;
  }

  hasPendingPrompt(): boolean {
    return false;
  }

  addUserMessage(): void {}

  resetTranscript(): void {}
}

export function dummyTool(
  name: string,
  readOnly: boolean,
  execute: Tool['execute'] = async () => ({ content: 'ok' }),
): Tool {
  return {
    definition: {
      name,
      description: name,
      input_schema: { type: 'object', properties: {} },
    },
    readOnly,
    execute,
    summarize: (input) => (typeof input.command === 'string' ? input.command : name),
  };
}
