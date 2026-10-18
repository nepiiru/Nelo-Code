import { Agent } from './agent.js';
import { AnthropicModelClient, describeApiError, type ModelClient } from './client.js';
import type { Config, LoadedConfig } from './config.js';
import { resolveApiKey } from './config.js';
import { PermissionManager } from './permissions.js';
import { buildSystemPrompt } from './prompt.js';
import { newSession, SessionStore, type SessionData } from './session.js';
import { createTools } from './tools/index.js';
import type { Tool } from './types.js';
import { TerminalUI, type UI } from './ui/ui.js';

export interface Runtime {
  config: Config;
  loaded: LoadedConfig;
  cwd: string;
  ui: UI;
  client: ModelClient;
  tools: Tool[];
  permissions: PermissionManager;
  agent: Agent;
  store: SessionStore;
  session: SessionData;
  saveSession(): Promise<void>;
}

export function createRuntime(options: {
  config: Config;
  loaded: LoadedConfig;
  cwd: string;
  ui: UI;
  session?: SessionData | null;
}): Runtime {
  const apiKey = resolveApiKey(options.config);
  if (!apiKey) throw new Error('Missing API key.');

  const client = new AnthropicModelClient({
    apiKey,
    ...(options.config.baseURL ? { baseURL: options.config.baseURL } : {}),
  });
  const tools = createTools();
  const permissions = new PermissionManager(options.config, (request) => options.ui.confirm(request));
  const systemPrompt = buildSystemPrompt({ cwd: options.cwd });
  const session = options.session ?? newSession(options.cwd, options.config.model);

  const agent = new Agent({
    client,
    config: options.config,
    tools,
    permissions,
    ui: options.ui,
    systemPrompt,
    workspaceRoot: options.cwd,
    messages: session.messages,
    usage: session.usage,
  });

  const store = new SessionStore(options.cwd);

  const runtime: Runtime = {
    config: options.config,
    loaded: options.loaded,
    cwd: options.cwd,
    ui: options.ui,
    client,
    tools,
    permissions,
    agent,
    store,
    session,
    async saveSession(): Promise<void> {
      runtime.session.messages = agent.messages;
      runtime.session.usage = agent.usage;
      runtime.session.model = options.config.model;
      await store.save(runtime.session);
    },
  };

  return runtime;
}

export function resetSession(runtime: Runtime): void {
  runtime.session = newSession(runtime.cwd, runtime.config.model);
  runtime.agent.clear();
}

export async function resumeSession(runtime: Runtime, id: string): Promise<boolean> {
  const session = await runtime.store.load(id);
  if (!session) return false;
  runtime.session = session;
  runtime.agent.load(session.messages, session.usage);
  return true;
}

export async function runPrintMode(options: {
  config: Config;
  loaded: LoadedConfig;
  cwd: string;
  prompt: string;
  session?: SessionData | null;
  signal?: AbortSignal;
}): Promise<number> {
  const ui = new TerminalUI({ interactive: false });
  try {
    const runtime = createRuntime({
      config: options.config,
      loaded: options.loaded,
      cwd: options.cwd,
      ui,
      session: options.session ?? null,
    });
    const result = await runtime.agent.run(options.prompt, options.signal);
    await runtime.saveSession();
    return result.aborted ? 130 : 0;
  } catch (error) {
    ui.error(describeApiError(error));
    return 1;
  }
}
