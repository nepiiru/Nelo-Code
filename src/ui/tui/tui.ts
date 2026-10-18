import { emitKeypressEvents } from 'node:readline';
import type { PermissionAnswer, PermissionRequest } from '../../permissions.js';
import type { UsageTotals } from '../../types.js';
import { emptyUsage } from '../../types.js';
import { formatTokenCount } from '../../utils/text.js';
import { getVersion } from '../../version.js';
import { ansi, paint } from '../ansi.js';
import type { UI } from '../ui.js';
import { LineEditor } from './input.js';
import { formatMarkdown } from './markdown.js';
import { Screen } from './screen.js';
import { charWidth, padToWidth, stripAnsi, stringWidth, truncateAnsi } from './width.js';
import { wrapText } from './wrap.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const SLASH_COMMANDS = [
  '/help',
  '/clear',
  '/compact',
  '/model',
  '/permissions',
  '/usage',
  '/status',
  '/tools',
  '/sessions',
  '/resume',
  '/exit',
];

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

interface ResizableStream extends NodeJS.WriteStream {
  on(event: 'resize', listener: () => void): this;
  off(event: 'resize', listener: () => void): this;
}

interface EntryCache {
  width: number;
  lines: string[];
}

interface UserEntry {
  kind: 'user';
  text: string;
}

interface AssistantEntry {
  kind: 'assistant';
  text: string;
  streaming: boolean;
}

interface ToolEntry {
  kind: 'tool';
  name: string;
  summary: string;
  status: 'running' | 'ok' | 'error';
  detail?: string;
}

interface InfoEntry {
  kind: 'info';
  text: string;
  level: 'info' | 'warn' | 'error' | 'plain';
}

type Entry = (UserEntry | AssistantEntry | ToolEntry | InfoEntry) & { cache?: EntryCache };

interface ModalState {
  request: PermissionRequest;
  resolve: (answer: PermissionAnswer) => void;
}

export interface TuiStatus {
  model: string;
  mode: string;
  sessionId: string;
  usage: UsageTotals;
  cwdLabel: string;
}

export interface TuiUIOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/**
 * Full-screen terminal UI implementing the agent's UI interface.
 *
 * Layout:
 *   header / separator / scrollable transcript / separator / input / status
 *
 * Keys: Enter submits, Up/Down history, PgUp/PgDn scroll, Shift+Up/Down
 * scroll one line, Ctrl+Home/End jump, Ctrl+C interrupts (twice to exit),
 * Ctrl+D exits on an empty prompt, Tab completes slash commands.
 */
export class TuiUI implements UI {
  private readonly stdin: NodeJS.ReadStream;
  private readonly screen: Screen;
  private readonly editor = new LineEditor();
  private readonly entries: Entry[] = [];

  private started = false;
  private disposed = false;
  private currentAssistant: (AssistantEntry & { cache?: EntryCache }) | null = null;
  private runningTool: (ToolEntry & { cache?: EntryCache }) | null = null;
  private modal: ModalState | null = null;

  private stateLabel = 'Ready';
  private busy = false;
  private running = false;
  private scrollOffset = 0;
  private lastTotalLines: number | null = null;
  private lastWidth = 0;

  private lineResolver: ((line: string | null) => void) | null = null;
  private readonly queuedLines: string[] = [];
  private interruptHandler: (() => boolean) | null = null;
  private lastCtrlC = 0;

  private renderScheduled = false;
  private renderTimer: NodeJS.Timeout | null = null;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;

  private status: TuiStatus = {
    model: '',
    mode: 'ask',
    sessionId: '',
    usage: emptyUsage(),
    cwdLabel: '',
  };

  private readonly onKeypress = (str: string | undefined, key: Key): void => {
    this.handleKey(str, key);
  };

  private readonly onResize = (): void => {
    this.lastTotalLines = null;
    this.requestRender();
  };

  private readonly onProcessExit = (): void => {
    this.screen.stop();
  };

  constructor(options: TuiUIOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.screen = new Screen(options.stdout ?? process.stdout);
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;

    this.screen.start();
    emitKeypressEvents(this.stdin);
    (this.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode?.(true);
    this.stdin.resume();
    (this.stdin as NodeJS.EventEmitter).on('keypress', this.onKeypress);
    (this.screen.stream as ResizableStream).on('resize', this.onResize);
    process.on('exit', this.onProcessExit);

    this.pushInfo(
      `Nelo Code v${getVersion()} — AI coding agent. Type /help for commands.`,
      'plain',
    );
    this.pushInfo('PgUp/PgDn scroll · Ctrl+C interrupts · Ctrl+D exits', 'plain');
    this.requestRender();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    (this.stdin as NodeJS.EventEmitter).off('keypress', this.onKeypress);
    (this.screen.stream as ResizableStream).off('resize', this.onResize);
    process.off('exit', this.onProcessExit);

    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.renderScheduled = false;

    try {
      (this.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode?.(false);
    } catch {
      // Ignore terminals that reject raw-mode changes during teardown.
    }
    this.stdin.pause();
    this.screen.stop();
  }

  readLine(): Promise<string | null> {
    if (this.disposed) return Promise.resolve(null);
    const queued = this.queuedLines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string | null>((resolve) => {
      this.lineResolver = resolve;
      this.requestRender();
    });
  }

  setInterruptHandler(handler: (() => boolean) | null): void {
    this.interruptHandler = handler;
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.requestRender();
  }

  setIdle(): void {
    this.setState('Ready', false);
  }

  updateStatus(partial: Partial<TuiStatus>): void {
    this.status = { ...this.status, ...partial };
    this.requestRender();
  }

  addUserMessage(text: string): void {
    this.finishAssistant();
    this.entries.push({ kind: 'user', text });
    this.scrollOffset = 0;
    this.requestRender();
  }

  resetTranscript(): void {
    this.entries.length = 0;
    this.currentAssistant = null;
    this.runningTool = null;
    this.scrollOffset = 0;
    this.lastTotalLines = null;
    this.requestRender();
  }

  // ------------------------------------------------------------------- UI API

  text(delta: string): void {
    if (!this.started || !delta) return;
    if (!this.currentAssistant) {
      const entry: AssistantEntry & { cache?: EntryCache } = {
        kind: 'assistant',
        text: '',
        streaming: true,
      };
      this.entries.push(entry);
      this.currentAssistant = entry;
    }
    this.currentAssistant.text += delta;
    this.currentAssistant.cache = undefined;
    this.setState('Responding', true);
    this.requestRender();
  }

  endText(): void {
    if (this.currentAssistant) {
      this.currentAssistant.streaming = false;
      this.currentAssistant.cache = undefined;
      this.currentAssistant = null;
    }
    this.requestRender();
  }

  toolStart(name: string, summary: string): void {
    if (!this.started) return;
    this.finishAssistant();
    const entry: ToolEntry & { cache?: EntryCache } = {
      kind: 'tool',
      name,
      summary,
      status: 'running',
    };
    this.entries.push(entry);
    this.runningTool = entry;
    this.setState(`Running ${name}`, true);
    this.requestRender();
  }

  toolEnd(_name: string, summary: string, isError: boolean): void {
    if (!this.started) return;
    const entry = this.runningTool;
    if (entry) {
      entry.status = isError ? 'error' : 'ok';
      entry.detail = summary;
      entry.cache = undefined;
    }
    this.runningTool = null;
    this.setState(isError ? 'Tool failed' : 'Working', true);
    this.requestRender();
  }

  info(message: string): void {
    if (!this.started) return;
    this.finishAssistant();
    this.pushInfo(message, 'info');
  }

  warn(message: string): void {
    if (!this.started) return;
    this.finishAssistant();
    this.pushInfo(message, 'warn');
  }

  error(message: string): void {
    if (!this.started) return;
    this.finishAssistant();
    this.pushInfo(message, 'error');
  }

  raw(text: string): void {
    if (!this.started) return;
    this.finishAssistant();
    this.pushInfo(text, 'plain');
  }

  stats(message: string): void {
    if (!this.started) return;
    this.finishAssistant();
    this.pushInfo(message, 'info');
  }

  spinner(label: string): void {
    if (!this.started) return;
    this.setState(label, true);
  }

  stopSpinner(): void {
    // The status bar owns the spinner; busy state ends with setIdle().
  }

  async confirm(request: PermissionRequest): Promise<PermissionAnswer> {
    if (!this.started) return 'no';
    this.finishAssistant();
    return new Promise<PermissionAnswer>((resolve) => {
      this.modal = { request, resolve };
      this.setState('Waiting for approval', false);
      this.requestRender();
    });
  }

  hasPendingPrompt(): boolean {
    return this.modal !== null;
  }

  // -------------------------------------------------------------- key handling

  private handleKey(str: string | undefined, key: Key): void {
    if (!this.started) return;

    if (this.modal) {
      this.handleModalKey(str, key);
      return;
    }

    if (this.handleScrollKey(key)) return;

    if (key.ctrl && key.name === 'c') {
      this.handleCtrlC();
      return;
    }

    if (key.ctrl && key.name === 'l') {
      this.screen.clear();
      this.requestRender();
      return;
    }

    if (key.ctrl && key.name === 'd') {
      if (this.editor.text.length === 0) this.exit();
      else this.editor.delete();
      this.requestRender();
      return;
    }

    if (key.name === 'enter' || key.name === 'return') {
      this.submit();
      return;
    }

    if (key.name === 'escape') return;

    if (key.name === 'tab') {
      this.completeSlashCommand();
      this.requestRender();
      return;
    }

    if (this.handleEditingKey(key)) {
      this.requestRender();
      return;
    }

    if (str && !key.ctrl && !key.meta && (key.name === undefined || key.name.length === 1)) {
      this.editor.insert(str);
      this.requestRender();
    }
  }

  private handleScrollKey(key: Key): boolean {
    if (key.name === 'pageup') {
      this.scrollBy(this.pageSize());
      return true;
    }
    if (key.name === 'pagedown') {
      this.scrollBy(-this.pageSize());
      return true;
    }
    if (key.shift && key.name === 'up') {
      this.scrollBy(1);
      return true;
    }
    if (key.shift && key.name === 'down') {
      this.scrollBy(-1);
      return true;
    }
    if (key.ctrl && key.name === 'home') {
      this.scrollToTop();
      return true;
    }
    if (key.ctrl && key.name === 'end') {
      this.scrollOffset = 0;
      this.requestRender();
      return true;
    }
    return false;
  }

  private handleEditingKey(key: Key): boolean {
    switch (key.name) {
      case 'backspace':
        this.editor.backspace();
        return true;
      case 'delete':
        this.editor.delete();
        return true;
      case 'left':
        this.editor.moveLeft();
        return true;
      case 'right':
        this.editor.moveRight();
        return true;
      case 'home':
        this.editor.moveHome();
        return true;
      case 'end':
        this.editor.moveEnd();
        return true;
      case 'up':
        return this.editor.historyPrevious();
      case 'down':
        return this.editor.historyNext();
      default:
        break;
    }

    if (key.ctrl && key.name === 'a') {
      this.editor.moveHome();
      return true;
    }
    if (key.ctrl && key.name === 'e') {
      this.editor.moveEnd();
      return true;
    }
    if (key.ctrl && key.name === 'u') {
      this.editor.deleteToStart();
      return true;
    }
    if (key.ctrl && key.name === 'k') {
      this.editor.deleteToEnd();
      return true;
    }
    if (key.ctrl && key.name === 'w') {
      this.editor.deleteWordBefore();
      return true;
    }
    return false;
  }

  private handleCtrlC(): void {
    if (this.interruptHandler && this.interruptHandler()) {
      this.requestRender();
      return;
    }

    if (this.editor.text.length > 0) {
      this.editor.clear();
      this.lastCtrlC = 0;
      this.setState('Ready', false);
      this.requestRender();
      return;
    }

    const now = Date.now();
    if (now - this.lastCtrlC < 1200) {
      this.exit();
      return;
    }

    this.lastCtrlC = now;
    this.setState('Press Ctrl+C again to exit', false);
    this.requestRender();
    setTimeout(() => {
      if (this.stateLabel === 'Press Ctrl+C again to exit' && !this.busy) {
        this.setState(this.running ? 'Working' : 'Ready', this.running);
        this.requestRender();
      }
    }, 1600).unref?.();
  }

  private submit(): void {
    const value = this.editor.submit();
    if (!value) {
      this.requestRender();
      return;
    }

    if (this.running || !this.lineResolver) {
      this.queuedLines.push(value);
      this.requestRender();
      return;
    }

    const resolve = this.lineResolver;
    this.lineResolver = null;
    this.scrollOffset = 0;
    this.requestRender();
    resolve(value);
  }

  private completeSlashCommand(): void {
    const text = this.editor.text;
    if (!text.startsWith('/')) return;

    const matches = SLASH_COMMANDS.filter((command) => command.startsWith(text));
    if (matches.length === 1) {
      this.editor.setText(`${matches[0]} `);
      return;
    }
    if (matches.length > 1) {
      let prefix = matches[0] ?? '';
      for (const match of matches) {
        while (prefix.length > 0 && !match.startsWith(prefix)) {
          prefix = prefix.slice(0, -1);
        }
      }
      if (prefix.length > text.length) this.editor.setText(prefix);
    }
  }

  private exit(): void {
    this.disposed = true;
    const resolve = this.lineResolver;
    this.lineResolver = null;
    resolve?.(null);
  }

  private handleModalKey(str: string | undefined, key: Key): void {
    const character = (str ?? '').toLowerCase();
    const name = (key.name ?? '').toLowerCase();

    if (character === 'y' || name === 'y') {
      this.resolveModal('yes');
      return;
    }
    if (character === 'a' || name === 'a') {
      this.resolveModal('always');
      return;
    }
    if (
      character === 'n' ||
      name === 'n' ||
      name === 'escape' ||
      name === 'enter' ||
      name === 'return' ||
      (key.ctrl && name === 'c')
    ) {
      this.resolveModal('no');
    }
  }

  private resolveModal(answer: PermissionAnswer): void {
    const modal = this.modal;
    if (!modal) return;
    this.modal = null;
    this.setState(this.running ? 'Working' : 'Ready', this.running);
    this.requestRender();
    modal.resolve(answer);
  }

  // ------------------------------------------------------------------ helpers

  private finishAssistant(): void {
    if (!this.currentAssistant) return;
    this.currentAssistant.streaming = false;
    this.currentAssistant.cache = undefined;
    this.currentAssistant = null;
  }

  private pushInfo(text: string, level: InfoEntry['level']): void {
    if (!text) return;
    this.entries.push({ kind: 'info', text, level });
    this.requestRender();
  }

  private setState(label: string, busy: boolean): void {
    const changed = this.stateLabel !== label || this.busy !== busy;
    this.stateLabel = label;
    if (this.busy !== busy) {
      this.busy = busy;
      this.updateAnimation();
    }
    if (changed) this.requestRender();
  }

  private updateAnimation(): void {
    if (this.busy && this.started && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame += 1;
        this.requestRender();
      }, 90);
      this.spinnerTimer.unref?.();
      return;
    }
    if (!this.busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private pageSize(): number {
    return Math.max(1, this.screen.rows - 6);
  }

  private scrollBy(lines: number): void {
    const height = Math.max(1, this.screen.rows - 5);
    const total = this.lastTotalLines ?? 0;
    const maxOffset = Math.max(0, total - height);
    this.scrollOffset = Math.min(maxOffset, Math.max(0, this.scrollOffset + lines));
    this.requestRender();
  }

  private scrollToTop(): void {
    const height = Math.max(1, this.screen.rows - 5);
    const total = this.lastTotalLines ?? 0;
    this.scrollOffset = Math.max(0, total - height);
    this.requestRender();
  }

  private requestRender(): void {
    if (!this.started || this.renderScheduled) return;
    this.renderScheduled = true;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderScheduled = false;
      this.render();
    }, 16);
    this.renderTimer.unref?.();
  }

  // ----------------------------------------------------------------- rendering

  private render(): void {
    if (!this.started) return;

    const width = this.screen.columns;
    const height = this.screen.rows;

    if (width < 40 || height < 12) {
      this.screen.render([paint('Terminal too small — resize to continue.', ansi.yellow)]);
      return;
    }

    const transcriptHeight = height - 5;
    const all = this.buildTranscriptLines(width);

    if (this.lastWidth !== width) {
      this.lastWidth = width;
      this.lastTotalLines = null;
    }
    if (this.lastTotalLines !== null && this.scrollOffset > 0) {
      this.scrollOffset += Math.max(0, all.length - this.lastTotalLines);
    }
    this.lastTotalLines = all.length;

    const maxOffset = Math.max(0, all.length - transcriptHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    this.scrollOffset = Math.max(0, this.scrollOffset);

    const end = all.length - this.scrollOffset;
    const start = Math.max(0, end - transcriptHeight);
    let visible = all.slice(start, end);
    while (visible.length < transcriptHeight) visible.unshift('');

    if (this.modal) visible = this.overlayModal(visible, width);

    const separator = paint('─'.repeat(width), ansi.dim);
    const lines = [
      this.renderHeader(width),
      separator,
      ...visible,
      separator,
      this.renderInput(width),
      this.renderStatus(width),
    ];

    this.screen.render(lines.map((line) => truncateAnsi(line, width)));
  }

  private buildTranscriptLines(width: number): string[] {
    const lines: string[] = [];
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (!entry) continue;
      const previous = this.entries[index - 1];
      if (index > 0) {
        const grouped = entry.kind === 'tool' && previous?.kind === 'tool';
        if (!grouped) lines.push('');
      }
      lines.push(...this.entryLines(entry, width));
    }
    return lines;
  }

  private entryLines(entry: Entry, width: number): string[] {
    if (entry.cache && entry.cache.width === width) return entry.cache.lines;

    let lines: string[];

    switch (entry.kind) {
      case 'user': {
        const wrapped = wrapText(stripAnsi(entry.text), Math.max(1, width - 2));
        lines = wrapped.map((line, index) =>
          index === 0 ? `${paint('❯', ansi.magenta)} ${line}` : `  ${line}`,
        );
        break;
      }

      case 'assistant': {
        lines = formatMarkdown(entry.text, width);
        break;
      }

      case 'tool': {
        const icon =
          entry.status === 'running'
            ? paint(SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] ?? '⠋', ansi.yellow)
            : paint('●', entry.status === 'error' ? ansi.red : ansi.green);
        const summary = entry.summary ? paint(`(${stripAnsi(entry.summary)})`, ansi.dim) : '';
        lines = [truncateAnsi(`${icon} ${paint(stripAnsi(entry.name), ansi.bold)}${summary}`, width)];
        if (entry.status !== 'running' && entry.detail) {
          const detail = stripAnsi(entry.detail);
          const painted = entry.status === 'error' ? paint(detail, ansi.red) : paint(detail, ansi.dim);
          lines.push(truncateAnsi(`  ${paint('└', ansi.dim)} ${painted}`, width));
        }
        break;
      }

      case 'info': {
        if (entry.level === 'plain') {
          lines = wrapText(stripAnsi(entry.text), width);
        } else {
          const prefix = entry.level === 'warn' ? '! ' : entry.level === 'error' ? '✖ ' : '';
          const color = entry.level === 'warn' ? ansi.yellow : entry.level === 'error' ? ansi.red : ansi.dim;
          const wrapped = wrapText(stripAnsi(entry.text), Math.max(1, width - 2));
          lines = wrapped.map((line, index) => paint(index === 0 ? `${prefix}${line}` : `  ${line}`, color));
        }
        break;
      }
    }

    const stable = entry.kind === 'tool' ? entry.status !== 'running' : entry.kind !== 'assistant' || !entry.streaming;
    if (stable) entry.cache = { width, lines };
    return lines;
  }

  private renderHeader(width: number): string {
    const left = `${paint('◆', ansi.magenta)} ${paint('Nelo Code', ansi.bold)} ${paint(
      `v${getVersion()}`,
      ansi.dim,
    )}`;
    const rightText = [this.status.model, this.status.mode, this.status.cwdLabel].filter(Boolean).join(' · ');
    const right = rightText ? paint(rightText, ansi.dim) : '';
    const leftWidth = stringWidth(left);
    const rightWidth = stringWidth(right);

    if (leftWidth + rightWidth + 2 <= width) {
      return `${left}${' '.repeat(width - leftWidth - rightWidth)}${right}`;
    }
    return truncateAnsi(left, width);
  }

  private renderInput(width: number): string {
    const prompt = paint('❯ ', ansi.green);

    if (this.modal) {
      return truncateAnsi(
        `${prompt}${paint('Respond to the permission prompt (y / n / a)', ansi.dim)}`,
        width,
      );
    }

    if (this.editor.text.length === 0) {
      const hint = this.running ? 'Type to queue the next message…' : 'Ask Nelo Code to do something…';
      return truncateAnsi(`${prompt}${paint(hint, ansi.dim)}`, width);
    }

    const available = Math.max(1, width - 2);
    const text = this.editor.text;
    const cursor = this.editor.cursor;

    let start = 0;
    while (start < cursor && stringWidth(text.slice(start, cursor)) > available - 1) {
      const code = text.charCodeAt(start);
      start += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    }

    let end = start;
    let used = 0;
    while (end < text.length) {
      const codePoint = text.codePointAt(end) ?? 0;
      const characterWidth = charWidth(codePoint);
      if (used + characterWidth > available) break;
      used += characterWidth;
      const code = text.charCodeAt(end);
      end += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    }

    let output = '';
    let cursorRendered = false;
    for (let index = start; index < end; ) {
      const codePoint = text.codePointAt(index) ?? 0;
      const character = String.fromCodePoint(codePoint);
      if (index === cursor) {
        output += `${ansi.inverse}${character}${ansi.reset}`;
        cursorRendered = true;
      } else {
        output += character;
      }
      index += character.length;
    }
    if (!cursorRendered) output += `${ansi.inverse} ${ansi.reset}`;

    return truncateAnsi(`${prompt}${output}`, width);
  }

  private renderStatus(width: number): string {
    const spinner = this.busy ? `${SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] ?? '⠋'} ` : '';
    const left = `${spinner}${this.stateLabel}`;
    const usage = this.status.usage;
    const rightParts: string[] = [];
    if (this.scrollOffset > 0) rightParts.push(`↑${this.scrollOffset}`);
    rightParts.push(
      `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out`,
    );
    const right = rightParts.join(' · ');

    const leftWidth = stringWidth(left);
    const rightWidth = stringWidth(right);
    let content: string;
    if (leftWidth + rightWidth + 2 <= width) {
      content = `${left}${' '.repeat(width - leftWidth - rightWidth)}${right}`;
    } else {
      content = truncateAnsi(left, width);
    }

    return paint(padToWidth(content, width), ansi.inverse);
  }

  private overlayModal(visible: string[], width: number): string[] {
    const modal = this.modal;
    if (!modal) return visible;

    const boxWidth = Math.min(width - 4, 76);
    const inner = boxWidth - 4;
    const name = stripAnsi(modal.request.tool.definition.name);
    const summary = stripAnsi(modal.request.summary);
    const title = ' Permission required ';
    const top = `┌${title}${'─'.repeat(Math.max(0, boxWidth - title.length - 2))}┐`;
    const bottom = `└${'─'.repeat(boxWidth - 2)}┘`;
    const row = (text: string): string => `│ ${padToWidth(text, inner)} │`;

    const box = [
      top,
      row(`${name}${summary ? `(${summary})` : ''}`),
      row('Allow this tool call?'),
      row('[y] Yes   [n] No   [a] Always (session)'),
      bottom,
    ].map((line) => paint(truncateAnsi(line, boxWidth), ansi.yellow));

    const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
    const prefix = ' '.repeat(leftPad);
    const result = [...visible];
    const start = Math.max(0, result.length - box.length);
    for (let index = 0; index < box.length; index += 1) {
      result[start + index] = truncateAnsi(`${prefix}${box[index] ?? ''}`, width);
    }
    return result;
  }
}
