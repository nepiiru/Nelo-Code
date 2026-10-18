import type { Config } from './config.js';

export type Role = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  display?: string;
}

export interface ToolContext {
  workspaceRoot: string;
  config: Config;
  signal?: AbortSignal;
}

export interface Tool {
  definition: ToolDefinition;
  readOnly: boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  summarize(input: Record<string, unknown>): string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

export function addUsage(target: UsageTotals, delta: UsageTotals): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadInputTokens += delta.cacheReadInputTokens;
  target.cacheCreationInputTokens += delta.cacheCreationInputTokens;
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}
