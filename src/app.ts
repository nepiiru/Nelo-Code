import { Agent } from './agent.js';
import {
  createModelClient,
  describeApiError,
  type ModelClient,
  type ModelResponse,
} from './client.js';
import { OpenAIChatClient } from './client-openai.js';
import type { Config, LoadedConfig, ProviderId } from './config.js';
import { fetchLlamaCppContextLength, fetchOllamaContextLength, ollamaBaseURL } from './ollama.js';
import { PermissionManager } from './permissions.js';
import { buildSystemPrompt } from './prompt.js';
import {
  applyProviderDefaults,
  resolveProvider,
  type ResolvedProvider,
} from './providers.js';
import { newSession, SessionStore, type SessionData } from './session.js';
import { ResourceMonitor } from './system/resources.js';
import { createTools } from './tools/index.js';
import type { Tool } from './types.js';
import { resolveTheme, setActiveTheme } from './ui/theme.js';
import { TerminalUI, type UI } from './ui/ui.js';
import { errorMessage } from './utils/text.js';

export interface Runtime {
  config: Config;
  loaded: LoadedConfig;
  cwd: string;
  ui: UI;
  /** Null until a provider is resolved; Nelo Code still starts in this state. */
  provider: ResolvedProvider | null;
  /** Why no provider/model is usable, or null when the runtime is ready. */
  connectionIssue: string | null;
  client: ModelClient;
  tools: Tool[];
  permissions: PermissionManager;
  agent: Agent;
  store: SessionStore;
  session: SessionData;
  monitor: ResourceMonitor;
  saveSession(): Promise<void>;
  /** Rebuilds the client for another provider (or re-runs auto-detection). */
  switchProvider(id: ProviderId, options?: { baseURL?: string }): Promise<ResolvedProvider>;
}

/** Model client used while no provider is connected. */
class UnavailableClient implements ModelClient {
  constructor(private readonly reason: string) {}

  async stream(): Promise<ModelResponse> {
    throw new Error(this.reason);
  }
}

/** Returns a user-facing explanation when prompts cannot be sent yet. */
export function connectionProblem(runtime: Runtime): string | null {
  if (!runtime.provider) {
    return runtime.connectionIssue ?? 'No model provider is connected.';
  }
  if (!runtime.config.model) {
    return (
      runtime.connectionIssue ??
      `Provider "${runtime.provider.id}" is selected, but no model is loaded.`
    );
  }
  return null;
}

/** Actionable next step shown next to a connection problem. */
export function connectionHint(runtime: Runtime): string {
  if (runtime.provider) {
    return `Load or pull a model, then run /provider ${runtime.provider.id}, or set one with /model <name>.`;
  }
  return 'Run /provider <id> to connect (see /providers). For Ollama: start "ollama serve", then /provider ollama. Cloud keys require a restart after setting them.';
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
  provider?: ResolvedProvider | null;
  providerError?: string | null;
}): Promise<Runtime> {
  const config = options.config;
  let resolved = options.provider ?? null;
  let providerError = options.providerError ?? null;

  // Starting without a provider is a supported state. Resolve when possible,
  // but keep going so the UI can ask the user to connect when they need it.
  if (resolved === null && providerError === null) {
    try {
      resolved = await resolveProvider({ config });
    } catch (error) {
      providerError = errorMessage(error);
    }
  }

  let connectionIssue: string | null = null;
  let client: ModelClient;
  let ollamaURL: string | undefined;

  if (resolved) {
    applyProviderDefaults(config, resolved);
    client = createModelClient(resolved, { timeoutMs: config.request.timeoutMs });

    const model = await detectModel(client, resolved.model);
    if (!model) {
      config.model = '';
      connectionIssue =
        `Provider "${resolved.id}" is selected, but no model is loaded. ` +
        `Load or pull one, then run /provider ${resolved.id}, or set one with /model <name>.`;
    } else {
      resolved.model = model;
      config.model = model;

      const detectedContext = await detectContextWindow(resolved);
      if (detectedContext && config.context.maxTokens === resolved.preset.contextWindow) {
        config.context.maxTokens = detectedContext;
      }
    }

    ollamaURL = resolved.id === 'ollama' ? ollamaBaseURL(resolved.baseURL) : undefined;
  } else {
    connectionIssue = providerError ?? 'No model provider is connected.';
    client = new UnavailableClient(connectionIssue);
  }

  applyTheme(config, options.cwd, options.ui);

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
  const monitor = new ResourceMonitor({ ollamaBaseURL: ollamaURL });

  const runtime: Runtime = {
    config,
    loaded: options.loaded,
    cwd: options.cwd,
    ui: options.ui,
    provider: resolved,
    connectionIssue,
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
      const previous = runtime.provider?.preset;

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
      if (switchOptions.baseURL) next.baseURL = switchOptions.baseURL;
      else delete next.baseURL;
      delete next.apiKey;

      const nextResolved = await resolveProvider({ config: next });
      const preset = nextResolved.preset;

      // Recompute the budgets that were inherited from the previous provider,
      // but keep anything the user set explicitly.
      if (previous) {
        if (next.context.maxTokens === previous.contextWindow) {
          next.context.maxTokens = preset.contextWindow;
        }
        if (next.maxTokens === previous.maxOutputTokens) {
          next.maxTokens = preset.maxOutputTokens;
        }
      }
      // Switching providers starts from that provider's default model; an empty
      // default means "discover the first model the server reports".
      next.model = preset.defaultModel;
      applyProviderDefaults(next, nextResolved);
      nextResolved.model = next.model;

      const nextClient = createModelClient(nextResolved, { timeoutMs: next.request.timeoutMs });
      const nextModel = await detectModel(nextClient, next.model);
      if (!nextModel) {
        throw new Error(
          `Provider "${nextResolved.id}" did not report any models. Start the server and load one, ` +
            `then run /provider ${nextResolved.id} again, or set a model with /model <name>.`,
        );
      }
      nextResolved.model = nextModel;

      config.provider = id;
      config.model = nextModel;
      config.maxTokens = next.maxTokens;
      config.context.maxTokens = next.context.maxTokens;
      if (next.baseURL) config.baseURL = next.baseURL;
      else delete config.baseURL;
      if (next.apiKey) config.apiKey = next.apiKey;
      else delete config.apiKey;

      runtime.provider = nextResolved;
      runtime.client = nextClient;
      runtime.connectionIssue = null;
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
  provider?: ResolvedProvider | null;
  providerError?: string | null;
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
      provider: options.provider ?? null,
      providerError: options.providerError ?? null,
    });
    const problem = connectionProblem(runtime);
    if (problem) {
      ui.error(problem);
      ui.info(connectionHint(runtime));
      return 1;
    }
    const result = await runtime.agent.run(options.prompt, options.signal);
    await runtime.saveSession();
    return result.aborted ? 130 : 0;
  } catch (error) {
    ui.error(describeApiError(error));
    return 1;
  }
}
