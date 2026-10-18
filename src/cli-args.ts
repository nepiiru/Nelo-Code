import type { PermissionMode } from './config.js';

export interface CliArgs {
  prompt?: string;
  print: boolean;
  continueSession: boolean;
  resumeId?: string;
  model?: string;
  maxTokens?: number;
  mode?: PermissionMode;
  help: boolean;
  version: boolean;
  command?: 'config';
}

const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'readonly'];

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    print: false,
    continueSession: false,
    help: false,
    version: false,
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
    } else if (arg === '-c' || arg === '--continue') {
      args.continueSession = true;
    } else if (arg === '-r' || arg === '--resume' || arg.startsWith('--resume=')) {
      args.resumeId = valueOf('--resume');
    } else if (arg === '-m' || arg === '--model' || arg.startsWith('--model=')) {
      args.model = valueOf('--model');
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

  if (positionals[0] === 'config') {
    args.command = 'config';
    positionals.shift();
  }
  if (positionals.length > 0) {
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

Options:
  -m, --model <name>        Model ID or alias (opus, sonnet, haiku, fable)
  -y, --yes                 Auto-approve all tool calls (dangerous)
      --readonly            Only allow read-only tools
      --mode <mode>         ask | auto | readonly
      --max-tokens <n>      Max output tokens per model response
  -c, --continue            Resume the latest session for this project
  -r, --resume <id>         Resume a specific session
  -p, --print               Non-interactive mode (prompt required)
  -h, --help                Show this help
  -V, --version             Show the version

Environment:
  ANTHROPIC_API_KEY         API key (required)
  ANTHROPIC_BASE_URL        Custom API base URL
  NELO_MODEL                Default model
  NELO_PERMISSION_MODE      ask | auto | readonly
  NELO_MAX_TOKENS           Max output tokens

Configuration files:
  ~/.nelo/config.json       Global settings
  ./.nelo/config.json       Project settings (overrides global)`);
}
