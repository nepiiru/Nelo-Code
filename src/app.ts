import { Agent } from './agent.js';
import { createModelClient, describeApiError, type ModelClient } from './client.js';
import { OpenAIChatClient } from './client-openai.js';
import type { Config, LoadedConfig, ProviderId } from './config.js';
import { fetchLlamaCppContextLength, fetchOllamaContextLength, ollamaBaseURL } from './ollama.js';
import { PermissionManager } from './permissions.js';
import { buildSystemPrompt } from './prompt.js';
import {
  applyProviderDefaults,
  getProviderPreset,
  resolveProvider,
  type ResolvedProvider,
} from './providers.js';
import { newSession, SessionStore, type SessionData } from './session.js';
import { ResourceMonitor } from './system/resources.js';
import { createTools } from './tools/index.js';
import type { Tool } from './types.js';
import { resolveTheme, setActiveTheme } from './ui/theme.js';
import { TerminalUI, type UI } from './ui/ui.js';

export interface Runtime {
  config: Config;
  loaded: LoadedConfig;
  cwd: string;
  ui: UI;
  provider: ResolvedProvider;
  client: ModelClient;
  tools: Tool[];
  permissions: PermissionManager;
  agent: Agent;
  store: SessionStore;
  session: SessionData;
  monitor: ResourceMonitor;
  saveSession(): Promise<void>;
  /** Rebuilds the client for another provider, keeping the conversation. */
  switchProvider(id: Exclude<ProviderId, 'auto'>, options?: { baseURL?: string }): Promise<ResolvedProvider>;
}

function applyTheme(config: Config, cwd: string, ui: UI): void {
  const resolved = resolveTheme(config.ui.theme, cwd);
  setActiveTheme(resolved.theme);
  for (const error of resolved.errors) ui.warn(error);
}

async function detectModel(client: ModelClient, current: string): Promise<string> {
  if (current) return current;
  if (!(client instanceof OpenAIChatClient)) return current;
  try {
    const models = await client.listModels();
    return models[0] ?? '';
  } catch {
    return '';
  }
}

/** Asks the server for the real context window when it exposes one. */
async function detectContextWindow(resolved: ResolvedProvider): Promise<number | null> {
  const baseURL = resolved.baseURL;
  if (!baseURL) return null;

  if (resolved.id === 'ollama') {
    const base = ollamaBaseURL(baseURL);
    if (!base) return null;
    const detected = await fetchOllamaContextLength(base, resolved.model);
    // Never exceed the preset budget: a small model must not be given a big window.
    return detected ? Math.min(detected, resolved.preset.contextWindow) : null;
  }

  if (resolved.id === 'llamacpp') {
    return await fetchLlamaCppContextLength(baseURL);
  }

  return null;
}

export async function createRuntime(options: {
  config: Config;
  loaded: LoadedConfig;
  cwd: string;
  ui: UI;
  session?: SessionData | null;
  provider?: ResolvedProvider;
}): Promise<Runtime> {
  const config = options.config;
  const resolved = options.provider ?? (await resolveProvider({ config }));
  applyProviderDefaults(config, resolved);
  applyTheme(config, options.cwd, options.ui);

  const client = createModelClient(resolved, { timeoutMs: config.request.timeoutMs });

  const model = await detectModel(client, resolved.model);
  if (!model) {
    throw new Error(
      `No model selected for provider "${resolved.id}". Pass -m <model> or pull one first ` +
        '(for Ollama: "ollama pull qwen2.5-coder:7b").',
    );
  }
  if (model !== resolved.model) {
    resolved.model = model;
    config.model = model;
  }

  const detectedContext = await detectContextWindow(resolved);
  if (detectedContext && config.context.maxTokens === resolved.preset.contextWindow) {
    config.context.maxTokens = detectedContext;
  }

  const tools = createTools();
  const permissions = new PermissionManager(config, (request) => options.ui.confirm(request));
  const systemPrompt = buildSystemPrompt({ cwd: options.cwd });
  const session = options.session ?? newSession(options.cwd, config.model);

  const agent = new Agent({
    client,
    config,
    tools,
    permissions,
    ui: options.ui,
    systemPrompt,
    workspaceRoot: options.cwd,
    messages: session.messages,
    usage: session.usage,
  });

  const store = new SessionStore(options.cwd);
  const monitor = new ResourceMonitor({
    ollamaBaseURL: resolved.id === 'ollama' ? ollamaBaseURL(resolved.baseURL) : undefined,
  });

  const runtime: Runtime = {
    config,
    loaded: options.loaded,
    cwd: options.cwd,
    ui: options.ui,
    provider: resolved,
    client,
    tools,
    permissions,
    agent,
    store,
    session,
    monitor,
    async saveSession(): Promise<void> {
      runtime.session.messages = agent.messages;
      runtime.session.usage = agent.usage;
      runtime.session.model = config.model;
      await store.save(runtime.session);
    },
    async switchProvider(id, switchOptions = {}): Promise<ResolvedProvider> {
      const preset = getProviderPreset(id);
      const previous = runtime.provider.preset;

      // Recompute the budgets that were inherited from the previous provider,
      // but keep anything the user set explicitly.
      const next: Config = {
        ...config,
        provider: id,
        context: { ...config.context },
        permissions: config.permissions,
        workspace: config.workspace,
        sampling: config.sampling,
        request: config.request,
        ui: config.ui,
      };
      if (next.context.maxTokens === previous.contextWindow) {
        next.context.maxTokens = preset.contextWindow;
      }
      if (next.maxTokens === previous.maxOutputTokens) {
        next.maxTokens = preset.maxOutputTokens;
      }
      if (preset.defaultModel) next.model = preset.defaultModel;
      if (switchOptions.baseURL) next.baseURL = switchOptions.baseURL;
      else delete next.baseURL;
      delete next.apiKey;

      const nextResolved = await resolveProvider({ config: next });
      applyProviderDefaults(next, nextResolved);

      const nextClient = createModelClient(nextResolved, { timeoutMs: next.request.timeoutMs });
      const nextModel = await detectModel(nextClient, nextResolved.model);
      if (!nextModel) {
        throw new Error(
          `Provider "${id}" reported no models. Pull or load a model first, then pass -m <model>.`,
        );
      }
      nextResolved.model = nextModel;

      config.provider = next.provider;
      config.model = nextModel;
      config.maxTokens = next.maxTokens;
      config.context.maxTokens = next.context.maxTokens;
      if (next.baseURL) config.baseURL = next.baseURL;
      else delete config.baseURL;
      if (next.apiKey) config.apiKey = next.apiKey;
      else delete config.apiKey;

      runtime.provider = nextResolved;
      runtime.client = nextClient;
      agent.setClient(nextClient);
      runtime.monitor.setOllamaBaseURL(
        nextResolved.id === 'ollama' ? ollamaBaseURL(nextResolved.baseURL) : undefined,
      );

      return nextResolved;
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
  provider?: ResolvedProvider;
  signal?: AbortSignal;
}): Promise<number> {
  const ui = new TerminalUI({ interactive: false });
  try {
    const runtime = await createRuntime({
      config: options.config,
      loaded: options.loaded,
      cwd: options.cwd,
      ui,
      session: options.session ?? null,
      ...(options.provider ? { provider: options.provider } : {}),
    });
    const result = await runtime.agent.run(options.prompt, options.signal);
    await runtime.saveSession();
    return result.aborted ? 130 : 0;
  } catch (error) {
    ui.error(describeApiError(error));
    return 1;
  }
}
