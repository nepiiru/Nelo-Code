import { emitKeypressEvents } from 'node:readline';
import type { PermissionAnswer, PermissionRequest } from '../../permissions.js';
import type { UsageTotals } from '../../types.js';
import { emptyUsage } from '../../types.js';
import { formatTokenCount } from '../../utils/text.js';
import { getVersion } from '../../version.js';
import {
  bold,
  dim,
  getActiveTheme,
  glyph,
  inverse,
  paintToken,
  setActiveTheme,
  type Theme,
} from '../theme.js';
import type { UI } from '../ui.js';
import { LineEditor } from './input.js';
import { formatMarkdown } from './markdown.js';
import { Screen } from './screen.js';
import { charWidth, padToWidth, stripAnsi, stringWidth, truncateAnsi } from './width.js';
import { wrapText } from './wrap.js';

const SLASH_COMMANDS = [
  '/help',
  '/clear',
  '/compact',
  '/model',
  '/provider',
  '/providers',
  '/permissions',
  '/theme',
  '/themes',
  '/addons',
  '/resources',
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
 *   header / separator / scrollable transcript / separator / boxed input / status
 *
 * Keys: Enter submits, Up/Down history (or menu selection), PgUp/PgDn scroll,
 * Shift+Up/Down scroll one line, Ctrl+Home/End jump, Ctrl+C interrupts
 * (twice to exit), Ctrl+D exits on an empty prompt. Typing "/" opens slash
 * command completion; Tab completes and Enter runs the selection.
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
  private vitals: string[] = [];

  private lineResolver: ((line: string | null) => void) | null = null;
  private readonly queuedLines: string[] = [];
  private interruptHandler: (() => boolean) | null = null;
  private lastCtrlC = 0;

  private slashIndex = 0;
  private slashDismissed = false;

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

  /** Segments shown in the status bar (CPU / RAM / GPU / VRAM). */
  setVitals(segments: string[]): void {
    const changed =
      segments.length !== this.vitals.length ||
      segments.some((segment, index) => segment !== this.vitals[index]);
    if (!changed) return;
    this.vitals = segments;
    this.requestRender();
  }

  /** Applies a theme at runtime and repaints the transcript with it. */
  setTheme(theme: Theme): void {
    setActiveTheme(theme);
    for (const entry of this.entries) entry.cache = undefined;
    this.lastTotalLines = null;
    this.requestRender();
  }

  /** Re-reads the active theme (already applied) and repaints. */
  refreshTheme(): void {
    this.setTheme(getActiveTheme());
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

    // While the slash-command menu is open, arrows move the selection.
    if (this.slashMatches().length > 0) {
      if (key.name === 'up') {
        this.moveSlashSelection(-1);
        return;
      }
      if (key.name === 'down') {
        this.moveSlashSelection(1);
        return;
      }
      if (key.name === 'tab') {
        this.acceptSlashCompletion(false);
        return;
      }
      if (key.name === 'escape') {
        this.slashDismissed = true;
        this.requestRender();
        return;
      }
      if (key.name === 'enter' || key.name === 'return') {
        this.acceptSlashCompletion(true);
        return;
      }
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

    // readline reports printable keys with a one-character `name`, except for
    // space, whose name is "space". Accept that too so spaces can be typed.
    const printable =
      key.name === undefined || key.name.length === 1 || key.name === 'space';
    if (str && !key.ctrl && !key.meta && printable) {
      this.slashIndex = 0;
      this.slashDismissed = false;
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
        this.resetSlashState();
        this.editor.backspace();
        return true;
      case 'delete':
        this.resetSlashState();
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
        this.resetSlashState();
        return this.editor.historyPrevious();
      case 'down':
        this.resetSlashState();
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
      this.resetSlashState();
      this.editor.deleteToStart();
      return true;
    }
    if (key.ctrl && key.name === 'k') {
      this.resetSlashState();
      this.editor.deleteToEnd();
      return true;
    }
    if (key.ctrl && key.name === 'w') {
      this.resetSlashState();
      this.editor.deleteWordBefore();
      return true;
    }
    return false;
  }

  private resetSlashState(): void {
    this.slashIndex = 0;
    this.slashDismissed = false;
  }

  /** Commands matching the current input, or none while it is not a command prefix. */
  private slashMatches(includeDismissed = false): string[] {
    if (!includeDismissed && this.slashDismissed) return [];
    if (this.modal) return [];
    const text = this.editor.text;
    if (!text.startsWith('/') || text.includes(' ')) return [];
    if (this.editor.cursor !== text.length) return [];
    return SLASH_COMMANDS.filter((command) => command.startsWith(text));
  }

  private moveSlashSelection(delta: number): void {
    const matches = this.slashMatches();
    if (matches.length === 0) return;
    const current = Math.min(this.slashIndex, matches.length - 1);
    this.slashIndex = (current + delta + matches.length) % matches.length;
    this.requestRender();
  }

  /** Completes the highlighted command; Enter also submits it. */
  private acceptSlashCompletion(submit: boolean): void {
    const matches = this.slashMatches(true);
    const selected = matches[Math.min(this.slashIndex, matches.length - 1)];
    if (!selected) return;

    this.slashIndex = 0;
    this.slashDismissed = false;
    if (submit) {
      this.editor.setText(selected);
      this.submit();
      return;
    }
    this.editor.setText(`${selected} `);
    this.requestRender();
  }

  private handleCtrlC(): void {
    if (this.interruptHandler && this.interruptHandler()) {
      this.requestRender();
      return;
    }

    if (this.editor.text.length > 0) {
      this.editor.clear();
      this.resetSlashState();
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
    this.resetSlashState();
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
    this.acceptSlashCompletion(false);
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

  /** Rows used by the header, rules, input box and status bar. */
  private chromeRows(): number {
    const theme = getActiveTheme();
    let rows = 4; // boxed input (3 rows) + status
    if (theme.layout.header) rows += 1;
    if (theme.layout.separators) rows += 2;
    if (this.modal) rows += 5;
    rows += Math.min(this.slashMatches().length, 6);
    return rows;
  }

  private transcriptHeight(): number {
    return Math.max(1, this.screen.rows - this.chromeRows());
  }

  private pageSize(): number {
    return Math.max(1, this.transcriptHeight() - 1);
  }

  private scrollBy(lines: number): void {
    const height = this.transcriptHeight();
    const total = this.lastTotalLines ?? 0;
    const maxOffset = Math.max(0, total - height);
    this.scrollOffset = Math.min(maxOffset, Math.max(0, this.scrollOffset + lines));
    this.requestRender();
  }

  private scrollToTop(): void {
    const height = this.transcriptHeight();
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

    const theme = getActiveTheme();
    const width = this.screen.columns;
    const height = this.screen.rows;

    if (width < 40 || height < 12) {
      this.screen.render([paintToken('warning', 'Terminal too small — resize to continue.')]);
      return;
    }

    const transcriptHeight = this.transcriptHeight();
    const all =
      this.entries.length === 0
        ? this.renderWelcome(transcriptHeight, width)
        : this.buildTranscriptLines(width);

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

    const separator = paintToken('border', glyph('separator').repeat(width));
    const lines: string[] = [];

    if (theme.layout.header) lines.push(this.renderHeader(width));
    if (theme.layout.separators) lines.push(separator);
    lines.push(...visible);
    if (theme.layout.separators) lines.push(separator);
    if (this.modal) lines.push(...this.renderModal(width));
    lines.push(...this.renderCompletions(width));
    lines.push(...this.renderInput(width));
    lines.push(this.renderStatus(width));

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

  private renderWelcome(height: number, width: number): string[] {
    if (height <= 0) return [];
    const theme = getActiveTheme();
    if (!theme.layout.hints) return Array.from({ length: height }, () => '');

    const title = `${paintToken('brand', glyph('brand'))}  ${bold(
      paintToken('brand', 'N E L O   C O D E'),
    )}`;
    const subtitle = `${dim('AI coding agent')} ${paintToken('border', '·')} ${dim(
      `v${getVersion()}`,
    )}`;
    const hints = [
      `${paintToken('accent', '/')} ${dim('commands')}`,
      `${paintToken('accentAlt', 'Enter')} ${dim('send')}`,
      `${paintToken('accentAlt', 'Tab')} ${dim('complete')}`,
    ].join(dim('   ·   '));
    const card = ['', title, subtitle, '', hints, ''];

    const top = Math.max(0, Math.floor((height - card.length) / 2));
    const lines = Array.from({ length: top }, () => '');
    lines.push(...card.map((line) => this.centerLine(line, width)));
    while (lines.length < height) lines.push('');
    return lines.slice(0, height);
  }

  private centerLine(line: string, width: number): string {
    if (!line) return '';
    const lineWidth = stringWidth(line);
    if (lineWidth >= width) return truncateAnsi(line, width);
    return `${' '.repeat(Math.floor((width - lineWidth) / 2))}${line}`;
  }

  private entryLines(entry: Entry, width: number): string[] {
    if (entry.cache && entry.cache.width === width) return entry.cache.lines;

    let lines: string[];

    switch (entry.kind) {
      case 'user': {
        const wrapped = wrapText(stripAnsi(entry.text), Math.max(1, width - 2));
        lines = wrapped.map((line, index) =>
          index === 0
            ? `${paintToken('accentAlt', glyph('user'))} ${paintToken('user', line)}`
            : `  ${paintToken('user', line)}`,
        );
        break;
      }

      case 'assistant': {
        lines = formatMarkdown(entry.text, width);
        break;
      }

      case 'tool': {
        const frames = getActiveTheme().spinner;
        const tone = entry.status === 'error' ? 'toolError' : 'tool';
        const icon =
          entry.status === 'running'
            ? paintToken('warning', frames[this.spinnerFrame % frames.length] ?? frames[0] ?? '*')
            : paintToken(tone, glyph('tool'));
        const name = bold(paintToken(tone, stripAnsi(entry.name)));
        const summary = entry.summary
          ? `  ${paintToken('muted', stripAnsi(entry.summary))}`
          : '';
        lines = [truncateAnsi(`${icon} ${name}${summary}`, width)];
        if (entry.status !== 'running' && entry.detail) {
          const detail = stripAnsi(entry.detail);
          const painted =
            entry.status === 'error' ? paintToken('danger', detail) : paintToken('muted', detail);
          lines.push(
            truncateAnsi(`  ${paintToken('border', glyph('toolBranch'))} ${painted}`, width),
          );
        }
        break;
      }

      case 'info': {
        if (entry.level === 'plain') {
          lines = wrapText(stripAnsi(entry.text), width);
        } else {
          const prefix =
            entry.level === 'warn'
              ? `${glyph('warn')} `
              : entry.level === 'error'
                ? `${glyph('error')} `
                : '';
          const token = entry.level === 'warn' ? 'warning' : entry.level === 'error' ? 'danger' : 'dim';
          const wrapped = wrapText(stripAnsi(entry.text), Math.max(1, width - 2));
          lines = wrapped.map((line, index) =>
            paintToken(token, index === 0 ? `${prefix}${line}` : `  ${line}`),
          );
        }
        break;
      }
    }

    const stable = entry.kind === 'tool' ? entry.status !== 'running' : entry.kind !== 'assistant' || !entry.streaming;
    if (stable) entry.cache = { width, lines };
    return lines;
  }

  private renderHeader(width: number): string {
    const left = `${paintToken('brand', glyph('brand'))} ${bold(
      paintToken('brand', 'Nelo Code'),
    )} ${paintToken('dim', `v${getVersion()}`)}`;
    const modeToken: 'danger' | 'info' | 'warning' =
      this.status.mode === 'auto' ? 'danger' : this.status.mode === 'readonly' ? 'info' : 'warning';
    const right = [
      this.status.model ? paintToken('accentAlt', this.status.model) : '',
      this.status.mode ? paintToken(modeToken, this.status.mode) : '',
      this.status.cwdLabel ? paintToken('dim', this.status.cwdLabel) : '',
    ]
      .filter(Boolean)
      .join(paintToken('border', ' · '));
    const leftWidth = stringWidth(left);
    const rightWidth = stringWidth(right);

    if (right && leftWidth + rightWidth + 2 <= width) {
      return `${left}${' '.repeat(width - leftWidth - rightWidth)}${right}`;
    }
    return truncateAnsi(left, width);
  }

  private renderCompletions(width: number): string[] {
    const matches = this.slashMatches();
    if (matches.length === 0) return [];

    const maxVisible = 6;
    const selected = Math.min(this.slashIndex, matches.length - 1);
    const offset = Math.max(
      0,
      Math.min(selected - maxVisible + 1, Math.max(0, matches.length - maxVisible)),
    );
    const labelWidth = Math.max(1, Math.min(28, width - 6));

    return matches.slice(offset, offset + maxVisible).map((command, position) => {
      const isSelected = offset + position === selected;
      const marker = isSelected ? paintToken('accent', glyph('prompt')) : ' ';
      const label = command.padEnd(labelWidth).slice(0, labelWidth);
      return `  ${marker} ${isSelected ? inverse(label) : dim(label)}`;
    });
  }

  private renderInput(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const prompt = `${paintToken('accent', glyph('prompt'))} `;
    let content: string;

    if (this.modal) {
      content = `${prompt}${dim('Waiting for approval…')}`;
    } else if (this.editor.text.length === 0) {
      const hint = this.running ? 'Type to queue the next message…' : 'Ask Nelo Code to do something…';
      content = `${prompt}${dim(hint)}`;
    } else {
      content = `${prompt}${this.renderEditorText(Math.max(1, inner - 3))}`;
    }

    const horizontal = glyph('boxHorizontal').repeat(Math.max(0, width - 2));
    const top = paintToken(
      'border',
      `${glyph('boxTopLeft')}${horizontal}${glyph('boxTopRight')}`,
    );
    const bottom = paintToken(
      'border',
      `${glyph('boxBottomLeft')}${horizontal}${glyph('boxBottomRight')}`,
    );
    const vertical = paintToken('border', glyph('boxVertical'));
    const row = `${vertical} ${padToWidth(truncateAnsi(content, inner), inner)} ${vertical}`;
    return [top, row, bottom];
  }

  private renderEditorText(available: number): string {
    const width = Math.max(1, available);
    const text = this.editor.text;
    const cursor = this.editor.cursor;

    let start = 0;
    while (start < cursor && stringWidth(text.slice(start, cursor)) > width - 1) {
      const code = text.charCodeAt(start);
      start += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    }

    let end = start;
    let used = 0;
    while (end < text.length) {
      const codePoint = text.codePointAt(end) ?? 0;
      const characterWidth = charWidth(codePoint);
      if (used + characterWidth > width) break;
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
        output += inverse(character);
        cursorRendered = true;
      } else {
        output += character;
      }
      index += character.length;
    }
    if (!cursorRendered) output += inverse(glyph('cursor'));
    return output;
  }

  private renderStatus(width: number): string {
    const theme = getActiveTheme();
    const frames = theme.spinner;
    const indicator = this.busy
      ? frames[this.spinnerFrame % frames.length] ?? frames[0] ?? '*'
      : glyph('state');
    const stateColor: 'accent' | 'success' | 'warning' = this.busy
      ? 'warning'
      : this.running
        ? 'accent'
        : 'success';
    const left = ` ${paintToken(stateColor, indicator)} ${paintToken(
      this.busy ? 'warning' : 'muted',
      this.stateLabel,
    )}`;

    const candidates: string[] = [];
    if (this.scrollOffset > 0) {
      candidates.push(
        `${paintToken('accentAlt', glyph('scroll'))}${paintToken('dim', String(this.scrollOffset))}`,
      );
    }
    candidates.push(...this.vitals.map((vital) => paintToken('vitals', vital)));
    candidates.push(
      paintToken(
        'dim',
        `${formatTokenCount(this.status.usage.inputTokens)} in / ${formatTokenCount(
          this.status.usage.outputTokens,
        )} out`,
      ),
    );

    const leftWidth = stringWidth(left);
    const parts = [...candidates];
    const build = (): string => parts.join(paintToken('border', ' · '));
    while (parts.length > 0 && leftWidth + stringWidth(build()) + 2 > width) {
      parts.pop();
    }

    const right = build();
    let content: string;
    if (right && leftWidth + stringWidth(right) + 2 <= width) {
      content = `${left}${' '.repeat(width - leftWidth - stringWidth(right))}${right}`;
    } else {
      content = truncateAnsi(left, width);
    }

    const padded = padToWidth(content, width);
    if (theme.layout.statusBar === 'inverse') return inverse(padded);
    if (theme.layout.statusBar === 'accent') return paintToken('accent', padded);
    return padded;
  }

  private renderModal(width: number): string[] {
    const modal = this.modal;
    if (!modal) return [];

    const boxWidth = Math.min(width - 4, 76);
    const inner = boxWidth - 4;
    const horizontal = glyph('boxHorizontal');
    const vertical = paintToken('border', glyph('boxVertical'));
    const name = bold(paintToken('warning', stripAnsi(modal.request.tool.definition.name)));
    const summaryText = stripAnsi(modal.request.summary);
    const summary = summaryText ? ` ${paintToken('muted', summaryText)}` : '';
    const title = ' Permission required ';
    const top = `${paintToken('border', `${glyph('boxTopLeft')}${horizontal}`)}${paintToken(
      'warning',
      title,
    )}${paintToken(
      'border',
      `${horizontal.repeat(Math.max(0, boxWidth - title.length - 3))}${glyph('boxTopRight')}`,
    )}`;
    const bottom = paintToken(
      'border',
      `${glyph('boxBottomLeft')}${horizontal.repeat(Math.max(0, boxWidth - 2))}${glyph(
        'boxBottomRight',
      )}`,
    );
    const row = (text: string): string =>
      `${vertical} ${padToWidth(truncateAnsi(text, inner), inner)} ${vertical}`;
    const keys = [
      `${paintToken('success', '[y]')} ${dim('Yes')}`,
      `${paintToken('danger', '[n]')} ${dim('No')}`,
      `${paintToken('info', '[a]')} ${dim('Always (session)')}`,
    ].join('   ');

    const box = [
      top,
      row(`${name}${summary}`),
      row(paintToken('text', 'Allow this tool call?')),
      row(keys),
      bottom,
    ].map((line) => truncateAnsi(line, boxWidth));

    const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
    const prefix = ' '.repeat(leftPad);
    return box.map((line) => truncateAnsi(`${prefix}${line}`, width));
  }
}
