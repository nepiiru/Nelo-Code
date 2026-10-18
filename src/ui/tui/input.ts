function previousIndex(text: string, index: number): number {
  if (index <= 0) return 0;
  const code = text.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && index - 2 >= 0) return index - 2;
  return index - 1;
}

function nextIndex(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff) return Math.min(text.length, index + 2);
  return index + 1;
}

const CONTROL_AND_ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function sanitizeInput(input: string): string {
  return input
    .replace(CONTROL_AND_ANSI, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * Single-line input editor with history, used by the TUI.
 * Cursor positions are code-unit indexes but movement respects surrogate pairs.
 */
export class LineEditor {
  text = '';
  cursor = 0;

  private readonly history: string[] = [];
  private historyIndex = -1;
  private draft = '';

  get historyLength(): number {
    return this.history.length;
  }

  insert(input: string): void {
    const clean = sanitizeInput(input);
    if (!clean) return;
    this.text = this.text.slice(0, this.cursor) + clean + this.text.slice(this.cursor);
    this.cursor += clean.length;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    const previous = previousIndex(this.text, this.cursor);
    this.text = this.text.slice(0, previous) + this.text.slice(this.cursor);
    this.cursor = previous;
  }

  delete(): void {
    if (this.cursor >= this.text.length) return;
    const next = nextIndex(this.text, this.cursor);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(next);
  }

  moveLeft(): void {
    this.cursor = previousIndex(this.text, this.cursor);
  }

  moveRight(): void {
    this.cursor = nextIndex(this.text, this.cursor);
  }

  moveHome(): void {
    this.cursor = 0;
  }

  moveEnd(): void {
    this.cursor = this.text.length;
  }

  deleteToStart(): void {
    this.text = this.text.slice(this.cursor);
    this.cursor = 0;
  }

  deleteToEnd(): void {
    this.text = this.text.slice(0, this.cursor);
  }

  deleteWordBefore(): void {
    let index = this.cursor;
    while (index > 0) {
      const previous = previousIndex(this.text, index);
      if (this.text.slice(previous, index) !== ' ') break;
      index = previous;
    }
    while (index > 0) {
      const previous = previousIndex(this.text, index);
      if (this.text.slice(previous, index) === ' ') break;
      index = previous;
    }
    this.text = this.text.slice(0, index) + this.text.slice(this.cursor);
    this.cursor = index;
  }

  clear(): void {
    this.text = '';
    this.cursor = 0;
    this.historyIndex = -1;
    this.draft = '';
  }

  setText(value: string): void {
    this.text = value;
    this.cursor = value.length;
  }

  historyPrevious(): boolean {
    if (this.history.length === 0) return false;
    if (this.historyIndex === -1) {
      this.draft = this.text;
      this.historyIndex = this.history.length;
    }
    if (this.historyIndex > 0) {
      this.historyIndex -= 1;
      this.setText(this.history[this.historyIndex] ?? '');
      return true;
    }
    return false;
  }

  historyNext(): boolean {
    if (this.historyIndex === -1) return false;
    this.historyIndex += 1;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = -1;
      this.setText(this.draft);
    } else {
      this.setText(this.history[this.historyIndex] ?? '');
    }
    return true;
  }

  submit(): string {
    const value = this.text.trim();
    if (value) {
      this.history.push(value);
      if (this.history.length > 200) this.history.shift();
    }
    this.text = '';
    this.cursor = 0;
    this.historyIndex = -1;
    this.draft = '';
    return value;
  }
}
