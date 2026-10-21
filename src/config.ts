import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from './utils/text.js';

export type PermissionMode = 'ask' | 'auto' | 'readonly';

export type ProviderId =
  | 'auto'
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'omniroute'
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm'
  | 'custom';

export const PROVIDER_IDS: ReadonlyArray<Exclude<ProviderId, 'auto'>> = [
  'ollama',
  'lmstudio',
  'omniroute',
  'llamacpp',
  'vllm',
  'anthropic',
  'openai',
  'openrouter',
  'custom',
];

export interface PermissionsConfig {
  mode: PermissionMode;
  allow: string[];
  denyCommands: string[];
}

export interface ContextConfig {
  maxTokens: number;
  compactAt: number;
}

export interface WorkspaceConfig {
  allowOutside: boolean;
}

export interface SamplingConfig {
  temperature: number;
  topP: number;
}

export interface RequestConfig {
  timeoutMs: number;
}

export interface UiConfig {
  theme: string;
  resources: boolean;
  resourceIntervalMs: number;
}

export interface Config {
  provider: ProviderId;
  model: string;
  maxTokens: number;
  maxTurns: number;
  apiKey?: string;
  baseURL?: string;
  permissions: PermissionsConfig;
  context: ContextConfig;
  workspace: WorkspaceConfig;
  sampling: SamplingConfig;
  request: RequestConfig;
  ui: UiConfig;
}

export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'readonly'];

/** Defaults used to detect "the user did not override this", so providers can fill it in. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_CONTEXT_TOKENS = 200000;
export const DEFAULT_THEME = 'nelo';

export function defaultConfig(): Config {
  return {
    provider: 'auto',
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    maxTurns: 40,
    permissions: {
      mode: 'ask',
      allow: [],
      denyCommands: [],
    },
    context: {
      maxTokens: DEFAULT_CONTEXT_TOKENS,
      compactAt: 0.8,
    },
    workspace: {
      allowOutside: false,
    },
    sampling: {
      temperature: 0.2,
      topP: 0.9,
    },
    request: {
      timeoutMs: 300000,
    },
    ui: {
      theme: DEFAULT_THEME,
      resources: true,
      resourceIntervalMs: 1000,
    },
  };
}

export function resolveModelAlias(model: string): string {
  const trimmed = model.trim();
  return MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function parsePermissionMode(value: string): PermissionMode {
  const mode = value.trim().toLowerCase();
  if (!PERMISSION_MODES.includes(mode as PermissionMode)) {
    throw new Error(`Invalid permission mode "${value}". Expected one of: ${PERMISSION_MODES.join(', ')}.`);
  }
  return mode as PermissionMode;
}

export interface ConfigSources {
  global?: string;
  project?: string;
  env: string[];
}

export interface LoadedConfig {
  config: Config;
  sources: ConfigSources;
}

export interface LoadConfigOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  globalPath?: string;
  projectPath?: string;
  home?: string;
}

export function globalConfigPath(home: string = homedir()): string {
  return join(home, '.nelo', 'config.json');
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, '.nelo', 'config.json');
}

function readJsonConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read config file ${path}: ${errorMessage(error)}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object at the top level');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to parse config file ${path}: ${errorMessage(error)}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function requireInteger(value: unknown, label: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer >= ${min}.`);
  }
  return value;
}

function requireNumberInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= min || value > max) {
    throw new Error(`${label} must be a number greater than ${min} and at most ${max}.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return [...value] as string[];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function mergeConfig(base: Config, patch: Record<string, unknown>, source: string): Config {
  const next: Config = {
    ...base,
    permissions: {
      ...base.permissions,
      allow: [...base.permissions.allow],
      denyCommands: [...base.permissions.denyCommands],
    },
    context: { ...base.context },
    workspace: { ...base.workspace },
    sampling: { ...base.sampling },
    request: { ...base.request },
    ui: { ...base.ui },
  };

  const label = (key: string): string => `${source}: "${key}"`;

  if (patch.provider !== undefined) {
    const value = requireString(patch.provider, label('provider')).trim().toLowerCase();
    if (value !== 'auto' && !PROVIDER_IDS.includes(value as Exclude<ProviderId, 'auto'>)) {
      throw new Error(
        `${source}: "provider" must be one of: auto, ${PROVIDER_IDS.join(', ')}.`,
      );
    }
    next.provider = value as ProviderId;
  }
  if (patch.model !== undefined) {
    next.model = resolveModelAlias(requireString(patch.model, label('model')));
  }
  if (patch.maxTokens !== undefined) {
    next.maxTokens = requireInteger(patch.maxTokens, label('maxTokens'), 1);
  }
  if (patch.maxTurns !== undefined) {
    next.maxTurns = requireInteger(patch.maxTurns, label('maxTurns'), 1);
  }
  if (patch.apiKey !== undefined) {
    next.apiKey = requireString(patch.apiKey, label('apiKey'));
  }
  if (patch.baseURL !== undefined) {
    next.baseURL = requireString(patch.baseURL, label('baseURL'));
  }
  if (patch.permissions !== undefined) {
    const permissions = requireObject(patch.permissions, label('permissions'));
    if (permissions.mode !== undefined) {
      next.permissions.mode = parsePermissionMode(
        requireString(permissions.mode, `${source}: "permissions.mode"`),
      );
    }
    if (permissions.allow !== undefined) {
      next.permissions.allow = requireStringArray(permissions.allow, `${source}: "permissions.allow"`);
    }
    if (permissions.denyCommands !== undefined) {
      next.permissions.denyCommands = requireStringArray(
        permissions.denyCommands,
        `${source}: "permissions.denyCommands"`,
      );
    }
  }
  if (patch.context !== undefined) {
    const context = requireObject(patch.context, label('context'));
    if (context.maxTokens !== undefined) {
      next.context.maxTokens = requireInteger(context.maxTokens, `${source}: "context.maxTokens"`, 1000);
    }
    if (context.compactAt !== undefined) {
      next.context.compactAt = requireNumberInRange(context.compactAt, `${source}: "context.compactAt"`, 0, 1);
    }
  }
  if (patch.workspace !== undefined) {
    const workspace = requireObject(patch.workspace, label('workspace'));
    if (workspace.allowOutside !== undefined) {
      next.workspace.allowOutside = requireBoolean(workspace.allowOutside, `${source}: "workspace.allowOutside"`);
    }
  }
  if (patch.sampling !== undefined) {
    const sampling = requireObject(patch.sampling, label('sampling'));
    if (sampling.temperature !== undefined) {
      next.sampling.temperature = requireNumberInRange(
        sampling.temperature,
        `${source}: "sampling.temperature"`,
        0,
        2,
      );
    }
    if (sampling.topP !== undefined) {
      next.sampling.topP = requireNumberInRange(sampling.topP, `${source}: "sampling.topP"`, 0, 1);
    }
  }
  if (patch.request !== undefined) {
    const request = requireObject(patch.request, label('request'));
    if (request.timeoutMs !== undefined) {
      next.request.timeoutMs = requireInteger(request.timeoutMs, `${source}: "request.timeoutMs"`, 1000);
    }
  }
  if (patch.ui !== undefined) {
    const ui = requireObject(patch.ui, label('ui'));
    if (ui.theme !== undefined) {
      next.ui.theme = requireString(ui.theme, `${source}: "ui.theme"`).trim() || DEFAULT_THEME;
    }
    if (ui.resources !== undefined) {
      next.ui.resources = requireBoolean(ui.resources, `${source}: "ui.resources"`);
    }
    if (ui.resourceIntervalMs !== undefined) {
      next.ui.resourceIntervalMs = requireInteger(
        ui.resourceIntervalMs,
        `${source}: "ui.resourceIntervalMs"`,
        250,
      );
    }
  }

  return next;
}

function applyEnv(config: Config, env: NodeJS.ProcessEnv): string[] {
  const applied: string[] = [];

  if (env.ANTHROPIC_API_KEY) {
    config.apiKey = env.ANTHROPIC_API_KEY;
    applied.push('ANTHROPIC_API_KEY');
  }
  if (env.ANTHROPIC_BASE_URL) {
    config.baseURL = env.ANTHROPIC_BASE_URL;
    applied.push('ANTHROPIC_BASE_URL');
  }
  if (env.NELO_MODEL) {
    config.model = resolveModelAlias(env.NELO_MODEL);
    applied.push('NELO_MODEL');
  }
  if (env.NELO_MAX_TOKENS) {
    const value = Number(env.NELO_MAX_TOKENS);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error('NELO_MAX_TOKENS must be a positive integer.');
    }
    config.maxTokens = value;
    applied.push('NELO_MAX_TOKENS');
  }
  if (env.NELO_MAX_TURNS) {
    const value = Number(env.NELO_MAX_TURNS);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error('NELO_MAX_TURNS must be a positive integer.');
    }
    config.maxTurns = value;
    applied.push('NELO_MAX_TURNS');
  }
  if (env.NELO_PERMISSION_MODE) {
    config.permissions.mode = parsePermissionMode(env.NELO_PERMISSION_MODE);
    applied.push('NELO_PERMISSION_MODE');
  }
  if (env.NELO_PROVIDER) {
    const value = env.NELO_PROVIDER.trim().toLowerCase();
    if (value !== 'auto' && !PROVIDER_IDS.includes(value as Exclude<ProviderId, 'auto'>)) {
      throw new Error(`NELO_PROVIDER must be one of: auto, ${PROVIDER_IDS.join(', ')}.`);
    }
    config.provider = value as ProviderId;
    applied.push('NELO_PROVIDER');
  }
  if (env.NELO_BASE_URL) {
    config.baseURL = env.NELO_BASE_URL;
    applied.push('NELO_BASE_URL');
  }
  if (env.NELO_THEME) {
    config.ui.theme = env.NELO_THEME.trim() || DEFAULT_THEME;
    applied.push('NELO_THEME');
  }

  return applied;
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const globalPath = options.globalPath ?? globalConfigPath(home);
  const projectPath = options.projectPath ?? projectConfigPath(options.cwd);

  let config = defaultConfig();
  const sources: ConfigSources = { env: [] };

  const globalRaw = readJsonConfig(globalPath);
  if (globalRaw) {
    config = mergeConfig(config, globalRaw, globalPath);
    sources.global = globalPath;
  }

  const projectRaw = readJsonConfig(projectPath);
  if (projectRaw) {
    config = mergeConfig(config, projectRaw, projectPath);
    sources.project = projectPath;
  }

  sources.env = applyEnv(config, env);

  return { config, sources };
}

export interface CliOverrides {
  model?: string;
  maxTokens?: number;
  mode?: PermissionMode;
  provider?: ProviderId;
  baseURL?: string;
}

export function applyCliOverrides(config: Config, overrides: CliOverrides): void {
  if (overrides.provider !== undefined) {
    config.provider = overrides.provider;
  }
  if (overrides.baseURL !== undefined) {
    config.baseURL = overrides.baseURL;
  }
  if (overrides.model !== undefined) {
    config.model = resolveModelAlias(overrides.model);
  }
  if (overrides.maxTokens !== undefined) {
    if (!Number.isInteger(overrides.maxTokens) || overrides.maxTokens < 1) {
      throw new Error('--max-tokens must be a positive integer.');
    }
    config.maxTokens = overrides.maxTokens;
  }
  if (overrides.mode !== undefined) {
    config.permissions.mode = overrides.mode;
  }
}

export function resolveApiKey(config: Config): string | undefined {
  const key = config.apiKey?.trim();
  return key ? key : undefined;
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
