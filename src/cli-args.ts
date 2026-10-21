import { PROVIDER_IDS, type PermissionMode, type ProviderId } from './config.js';

export type CommandName = 'config' | 'providers' | 'themes' | 'addon';

export interface CliArgs {
  prompt?: string;
  print: boolean;
  continueSession: boolean;
  resumeId?: string;
  model?: string;
  maxTokens?: number;
  mode?: PermissionMode;
  provider?: ProviderId;
  baseURL?: string;
  noTui: boolean;
  help: boolean;
  version: boolean;
  command?: CommandName;
  commandArgs: string[];
}

const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'readonly'];
const COMMANDS: readonly CommandName[] = ['config', 'providers', 'themes', 'addon'];

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    print: false,
    continueSession: false,
    noTui: false,
    help: false,
    version: false,
    commandArgs: [],
  };
  const positionals: string[] = [];

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? '';

    const valueOf = (name: string): string => {
      const equals = arg.indexOf('=');
      if (equals !== -1) return arg.slice(equals + 1);
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`Missing value for ${name}.`);
      index += 1;
      return next;
    };

    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '-V' || arg === '--version') {
      args.version = true;
    } else if (arg === '-p' || arg === '--print') {
      args.print = true;
    } else if (arg === '-y' || arg === '--yes') {
      args.mode = 'auto';
    } else if (arg === '--readonly') {
      args.mode = 'readonly';
    } else if (arg === '--no-tui') {
      args.noTui = true;
    } else if (arg === '-c' || arg === '--continue') {
      args.continueSession = true;
    } else if (arg === '-r' || arg === '--resume' || arg.startsWith('--resume=')) {
      args.resumeId = valueOf('--resume');
    } else if (arg === '-m' || arg === '--model' || arg.startsWith('--model=')) {
      args.model = valueOf('--model');
    } else if (arg === '--provider' || arg.startsWith('--provider=')) {
      const raw = valueOf('--provider').trim().toLowerCase();
      if (raw !== 'auto' && !PROVIDER_IDS.includes(raw as Exclude<ProviderId, 'auto'>)) {
        throw new Error(`--provider must be one of: auto, ${PROVIDER_IDS.join(', ')}.`);
      }
      args.provider = raw as ProviderId;
    } else if (arg === '--base-url' || arg.startsWith('--base-url=')) {
      args.baseURL = valueOf('--base-url').trim();
    } else if (arg === '--max-tokens' || arg.startsWith('--max-tokens=')) {
      const raw = valueOf('--max-tokens');
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--max-tokens must be a positive integer.');
      }
      args.maxTokens = parsed;
    } else if (arg === '--mode' || arg.startsWith('--mode=')) {
      const raw = valueOf('--mode').toLowerCase();
      if (!PERMISSION_MODES.includes(raw as PermissionMode)) {
        throw new Error(`--mode must be one of: ${PERMISSION_MODES.join(', ')}.`);
      }
      args.mode = raw as PermissionMode;
    } else if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }

    index += 1;
  }

  const first = positionals[0];
  if (first !== undefined && (COMMANDS as readonly string[]).includes(first)) {
    args.command = first as CommandName;
    positionals.shift();
  }

  if (args.command) {
    args.commandArgs = positionals;
  } else if (positionals.length > 0) {
    args.prompt = positionals.join(' ');
  }

  return args;
}

export function printHelp(version: string): void {
  console.log(`Nelo Code v${version} — an AI coding agent for your terminal

Usage:
  nelo                      Start an interactive session
  nelo "prompt"             Run one prompt and exit
  nelo -p "prompt"          Same, explicit print mode
  nelo -p < prompt.txt      Read the prompt from stdin
  nelo config               Show the effective configuration
  nelo providers            List provider templates (Ollama, LM Studio, …)
  nelo themes               List built-in and addon themes
  nelo addon new <name>     Scaffold a theme addon

Options:
  -m, --model <name>        Model ID or alias (opus, sonnet, haiku, fable)
      --provider <id>       auto | ollama | lmstudio | omniroute | llamacpp | vllm |
                            anthropic | openai | openrouter | custom
      --base-url <url>      Override the provider endpoint
  -y, --yes                 Auto-approve all tool calls (dangerous)
      --readonly            Only allow read-only tools
      --mode <mode>         ask | auto | readonly
      --no-tui              Use the plain line-based REPL instead of the TUI
      --max-tokens <n>      Max output tokens per model response
  -c, --continue            Resume the latest session for this project
  -r, --resume <id>         Resume a specific session
  -p, --print               Non-interactive mode (prompt required)
  -h, --help                Show this help
  -V, --version             Show the version

Environment:
  NELO_PROVIDER             auto | ollama | lmstudio | omniroute | … (default: auto)
  NELO_BASE_URL             Override the provider endpoint
  NELO_MODEL                Default model
  NELO_PERMISSION_MODE      ask | auto | readonly
  NELO_MAX_TOKENS           Max output tokens
  NELO_THEME                UI theme name
  ANTHROPIC_API_KEY         Key for the anthropic provider
  OPENAI_API_KEY            Key for the openai provider
  OPENROUTER_API_KEY        Key for the openrouter provider
  OMNIROUTE_API_KEY         Optional key for a secured OmniRoute instance

Configuration files:
  ~/.nelo/config.json       Global settings
  ./.nelo/config.json       Project settings (overrides global)
  ~/.nelo/addons/<name>/    Theme addons`);
}
