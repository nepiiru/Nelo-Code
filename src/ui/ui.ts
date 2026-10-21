import type { PermissionAnswer, PermissionRequest } from '../permissions.js';
import { colorEnabled } from './ansi.js';
import { StreamRenderer } from './render.js';
import { bold, dim, glyph, paintToken, spinnerFrames } from './theme.js';

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
  /** Records a submitted user message. Line-based UIs already echo the prompt. */
  addUserMessage(text: string): void;
  /** Clears the visible conversation after /clear or /resume. */
  resetTranscript(): void;
  /** Optional: repaint after the active theme changed. */
  refreshTheme?(): void;
}

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
    const suffix = summary ? paintToken('dim', `(${summary})`) : '';
    this.activity(`${paintToken('tool', glyph('tool'))} ${bold(name)}${suffix}`);
  }

  toolEnd(_name: string, summary: string, isError: boolean): void {
    this.activity(
      `  ${paintToken('dim', glyph('toolBranch'))} ${isError ? paintToken('danger', summary) : paintToken('dim', summary)}`,
    );
  }

  info(message: string): void {
    this.stopSpinner();
    this.activity(paintToken('dim', message));
  }

  warn(message: string): void {
    this.stopSpinner();
    this.activity(paintToken('warning', `${glyph('warn')} ${message}`));
  }

  error(message: string): void {
    this.stopSpinner();
    this.activity(paintToken('danger', `${glyph('error')} ${message}`), true);
  }

  raw(text: string): void {
    this.stopSpinner();
    this.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  stats(message: string): void {
    this.activity(paintToken('muted', `  ${message}`));
  }

  spinner(label: string): void {
    this.stopSpinner();
    if (!this.interactive || this.stderr.isTTY !== true || !colorEnabled()) return;

    const frames = spinnerFrames();
    this.spinnerLabel = label;
    this.spinnerFrame = 0;
    const render = (): void => {
      const frame = frames[this.spinnerFrame % frames.length] ?? frames[0] ?? '*';
      this.spinnerFrame += 1;
      this.stderr.write(`\r\x1b[K${paintToken('dim', frame)} ${paintToken('dim', this.spinnerLabel)}`);
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
    const summary = request.summary ? ` ${dim(request.summary)}` : '';
    this.activity('');
    this.activity(
      `${paintToken('warning', glyph('question'))} ${bold(request.tool.definition.name)}${summary}`,
    );
    this.activity(dim('  Allow this tool call? [y]es / [n]o / [a]lways (this session)'));

    this.pendingQuestion = true;
    try {
      const answer = (await this.question(dim('  › '))).trim().toLowerCase();
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

  addUserMessage(_text: string): void {
    // The readline prompt already echoed the line.
  }

  resetTranscript(): void {
    // The line-based REPL keeps no transcript to clear.
  }

  private activity(text: string, alwaysStderr = false): void {
    const stream = this.interactive && !alwaysStderr ? this.stdout : this.stderr;
    stream.write(`${text}\n`);
  }
}
