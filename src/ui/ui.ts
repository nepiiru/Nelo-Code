import type { PermissionAnswer, PermissionRequest } from '../permissions.js';
import { ansi, colorEnabled, paint } from './ansi.js';
import { StreamRenderer } from './render.js';

export interface UI {
  text(delta: string): void;
  endText(): void;
  toolStart(name: string, summary: string): void;
  toolEnd(name: string, summary: string, isError: boolean): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  raw(text: string): void;
  stats(message: string): void;
  spinner(label: string): void;
  stopSpinner(): void;
  confirm(request: PermissionRequest): Promise<PermissionAnswer>;
  hasPendingPrompt(): boolean;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface TerminalUIOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  interactive?: boolean;
  question?: (prompt: string) => Promise<string>;
}

export class TerminalUI implements UI {
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;
  private readonly interactive: boolean;
  private readonly question?: (prompt: string) => Promise<string>;
  private readonly renderer: StreamRenderer;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private spinnerLabel = '';
  private pendingQuestion = false;

  constructor(options: TerminalUIOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.interactive = options.interactive ?? true;
    this.question = options.question;
    this.renderer = new StreamRenderer(this.stdout);
  }

  text(delta: string): void {
    this.stopSpinner();
    this.renderer.push(delta);
  }

  endText(): void {
    this.renderer.flush();
  }

  toolStart(name: string, summary: string): void {
    this.stopSpinner();
    const suffix = summary ? paint(`(${summary})`, ansi.dim) : '';
    this.activity(`${paint('●', ansi.green)} ${paint(name, ansi.bold)}${suffix}`);
  }

  toolEnd(_name: string, summary: string, isError: boolean): void {
    this.activity(`  ${paint('└', ansi.dim)} ${isError ? paint(summary, ansi.red) : paint(summary, ansi.dim)}`);
  }

  info(message: string): void {
    this.stopSpinner();
    this.activity(paint(message, ansi.dim));
  }

  warn(message: string): void {
    this.stopSpinner();
    this.activity(paint(`! ${message}`, ansi.yellow));
  }

  error(message: string): void {
    this.stopSpinner();
    this.activity(paint(`✖ ${message}`, ansi.red), true);
  }

  raw(text: string): void {
    this.stopSpinner();
    this.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  stats(message: string): void {
    this.activity(paint(`  ${message}`, ansi.gray));
  }

  spinner(label: string): void {
    this.stopSpinner();
    if (!this.interactive || this.stderr.isTTY !== true || !colorEnabled()) return;

    this.spinnerLabel = label;
    this.spinnerFrame = 0;
    const render = (): void => {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] ?? '⠋';
      this.spinnerFrame += 1;
      this.stderr.write(`\r\x1b[K${paint(frame, ansi.dim)} ${paint(this.spinnerLabel, ansi.dim)}`);
    };
    render();
    this.spinnerTimer = setInterval(render, 90);
    this.spinnerTimer.unref?.();
  }

  stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    this.stderr.write('\r\x1b[K');
  }

  async confirm(request: PermissionRequest): Promise<PermissionAnswer> {
    if (!this.interactive || !this.question) {
      this.warn(
        `Permission required for ${request.tool.definition.name}${
          request.summary ? `(${request.summary})` : ''
        }, but Nelo Code is running non-interactively. Denied. ` +
          'Re-run with --yes to auto-approve, or --readonly to allow only read operations.',
      );
      return 'no';
    }

    this.stopSpinner();
    const summary = request.summary ? ` ${paint(request.summary, ansi.dim)}` : '';
    this.activity('');
    this.activity(`${paint('?', ansi.yellow)} ${paint(request.tool.definition.name, ansi.bold)}${summary}`);
    this.activity(paint('  Allow this tool call? [y]es / [n]o / [a]lways (this session)', ansi.dim));

    this.pendingQuestion = true;
    try {
      const answer = (await this.question(paint('  › ', ansi.dim))).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return 'yes';
      if (answer === 'a' || answer === 'always') return 'always';
      return 'no';
    } finally {
      this.pendingQuestion = false;
    }
  }

  hasPendingPrompt(): boolean {
    return this.pendingQuestion;
  }

  private activity(text: string, alwaysStderr = false): void {
    const stream = this.interactive && !alwaysStderr ? this.stdout : this.stderr;
    stream.write(`${text}\n`);
  }
}
