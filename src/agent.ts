import type { ModelClient, ModelResponse } from './client.js';
import { isAbortError } from './client.js';
import { compactMessages } from './compaction.js';
import type { Config } from './config.js';
import type { PermissionManager } from './permissions.js';
import { estimateMessagesTokens, estimateToolDefinitionsTokens, estimateTokens } from './tokens.js';
import type {
  Message,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
  UsageTotals,
} from './types.js';
import { addUsage, emptyUsage, isToolUseBlock } from './types.js';
import type { UI } from './ui/ui.js';
import { errorMessage, truncate } from './utils/text.js';

export interface AgentOptions {
  client: ModelClient;
  config: Config;
  tools: Tool[];
  permissions: PermissionManager;
  ui: UI;
  systemPrompt: string;
  workspaceRoot: string;
  messages?: Message[];
  usage?: UsageTotals;
}

export interface TurnResult {
  turns: number;
  aborted: boolean;
  durationMs: number;
  usage: UsageTotals;
}

function diffUsage(total: UsageTotals, before: UsageTotals): UsageTotals {
  return {
    inputTokens: total.inputTokens - before.inputTokens,
    outputTokens: total.outputTokens - before.outputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens - before.cacheReadInputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens - before.cacheCreationInputTokens,
  };
}

export class Agent {
  messages: Message[];
  usage: UsageTotals;

  private readonly client: ModelClient;
  private readonly config: Config;
  private readonly tools: Tool[];
  private readonly permissions: PermissionManager;
  private readonly ui: UI;
  private readonly systemPrompt: string;
  private readonly workspaceRoot: string;

  constructor(options: AgentOptions) {
    this.client = options.client;
    this.config = options.config;
    this.tools = options.tools;
    this.permissions = options.permissions;
    this.ui = options.ui;
    this.systemPrompt = options.systemPrompt;
    this.workspaceRoot = options.workspaceRoot;
    this.messages = options.messages ?? [];
    this.usage = options.usage ?? emptyUsage();
  }

  load(messages: Message[], usage: UsageTotals): void {
    this.messages = messages;
    this.usage = { ...emptyUsage(), ...usage };
  }

  clear(): void {
    this.messages = [];
    this.usage = emptyUsage();
  }

  estimatedContextTokens(): number {
    return (
      estimateMessagesTokens(this.messages) +
      estimateTokens(this.systemPrompt) +
      estimateToolDefinitionsTokens(this.tools.map((tool) => tool.definition))
    );
  }

  async run(userText: string, signal?: AbortSignal): Promise<TurnResult> {
    const started = Date.now();
    const usageBefore = { ...this.usage };
    this.appendUserText(userText);

    let turns = 0;
    let aborted = false;
    let hitTurnLimit = false;

    try {
      while (true) {
        if (turns >= this.config.maxTurns) {
          hitTurnLimit = true;
          break;
        }
        turns += 1;

        await this.maybeCompact(signal);

        const response = await this.callModel(signal);
        addUsage(this.usage, response.usage);

        const assistantContent = response.content.filter(
          (block) => block.type !== 'text' || block.text.length > 0,
        );
        if (assistantContent.length === 0) {
          this.ui.warn('The model returned an empty response.');
          break;
        }

        const toolUses = assistantContent.filter(isToolUseBlock);
        this.messages.push({ role: 'assistant', content: assistantContent });

        if (response.stopReason === 'max_tokens') {
          this.ui.warn(
            `The response hit the max_tokens limit (${this.config.maxTokens}). The answer may be incomplete.`,
          );
        }

        if (toolUses.length === 0) break;

        const results: ToolResultBlock[] = [];
        for (const use of toolUses) {
          if (signal?.aborted) {
            aborted = true;
            results.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: 'Interrupted by the user before this tool ran.',
              is_error: true,
            });
            continue;
          }
          results.push(await this.executeTool(use, signal));
        }
        this.messages.push({ role: 'user', content: results });

        if (aborted) break;
      }

      if (hitTurnLimit) {
        this.ui.warn(
          `Stopped after reaching the maximum of ${this.config.maxTurns} turns for one request.`,
        );
      }
    } catch (error) {
      if (isAbortError(error)) {
        aborted = true;
        this.ui.info('Request interrupted.');
      } else {
        throw error;
      }
    } finally {
      this.ui.stopSpinner();
      this.ui.endText();
    }

    return {
      turns,
      aborted,
      durationMs: Date.now() - started,
      usage: diffUsage(this.usage, usageBefore),
    };
  }

  async compact(signal?: AbortSignal): Promise<void> {
    this.ui.spinner('Compacting conversation');
    try {
      const result = await compactMessages({
        client: this.client,
        model: this.config.model,
        messages: this.messages,
        keep: 6,
        signal,
      });
      addUsage(this.usage, result.usage);

      if (result.summarizedCount === 0) {
        this.ui.warn('Nothing to compact yet.');
        return;
      }

      this.messages = result.messages;
      this.ui.info(
        `Compacted ${result.summarizedCount} earlier message${
          result.summarizedCount === 1 ? '' : 's'
        } into a summary.`,
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.ui.warn(`Compaction failed: ${errorMessage(error)}`);
    } finally {
      this.ui.stopSpinner();
    }
  }

  private appendUserText(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user' && last.content.every((block) => block.type === 'text')) {
      last.content.push({ type: 'text', text });
      return;
    }
    this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  private async maybeCompact(signal?: AbortSignal): Promise<void> {
    const limit = this.config.context.maxTokens * this.config.context.compactAt;
    if (this.estimatedContextTokens() < limit) return;
    this.ui.info('Context is getting large; compacting the conversation…');
    await this.compact(signal);
  }

  private async callModel(signal?: AbortSignal): Promise<ModelResponse> {
    this.ui.spinner('Thinking');
    try {
      return await this.client.stream(
        {
          model: this.config.model,
          maxTokens: this.config.maxTokens,
          system: this.systemPrompt,
          messages: this.messages,
          tools: this.tools.map((tool) => tool.definition),
        },
        {
          onText: (delta) => {
            this.ui.stopSpinner();
            this.ui.text(delta);
          },
        },
        signal,
      );
    } finally {
      this.ui.stopSpinner();
      this.ui.endText();
    }
  }

  private async executeTool(use: ToolUseBlock, signal?: AbortSignal): Promise<ToolResultBlock> {
    const tool = this.tools.find((candidate) => candidate.definition.name === use.name);
    if (!tool) {
      this.ui.toolStart(use.name, '');
      this.ui.toolEnd(use.name, 'unknown tool', true);
      return {
        type: 'tool_result',
        tool_use_id: use.id,
        content: `Unknown tool: ${use.name}. Available tools: ${this.tools
          .map((candidate) => candidate.definition.name)
          .join(', ')}.`,
        is_error: true,
      };
    }

    let summary = '';
    try {
      summary = tool.summarize(use.input);
    } catch {
      summary = '';
    }
    this.ui.toolStart(tool.definition.name, summary);

    const verdict = await this.permissions.authorize(tool, use.input);
    if (!verdict.allowed) {
      const reason = verdict.message ?? 'Permission denied.';
      this.ui.toolEnd(tool.definition.name, truncate(reason, 80), true);
      return {
        type: 'tool_result',
        tool_use_id: use.id,
        content: `Permission denied: ${reason}`,
        is_error: true,
      };
    }

    try {
      const result = await tool.execute(use.input, {
        workspaceRoot: this.workspaceRoot,
        config: this.config,
        signal,
      });
      this.ui.toolEnd(
        tool.definition.name,
        result.display ?? (result.isError ? 'error' : 'done'),
        Boolean(result.isError),
      );
      return {
        type: 'tool_result',
        tool_use_id: use.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      };
    } catch (error) {
      const message = errorMessage(error);
      this.ui.toolEnd(tool.definition.name, truncate(message, 80), true);
      return {
        type: 'tool_result',
        tool_use_id: use.id,
        content: `Error: ${message}`,
        is_error: true,
      };
    }
  }
}
