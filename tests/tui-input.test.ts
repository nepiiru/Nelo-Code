import { describe, expect, it } from 'vitest';
import { LineEditor } from '../src/ui/tui/input.js';

describe('LineEditor', () => {
  it('inserts text at the cursor', () => {
    const editor = new LineEditor();
    editor.insert('hello');
    editor.moveHome();
    editor.insert('> ');
    expect(editor.text).toBe('> hello');
    expect(editor.cursor).toBe(2);
  });

  it('removes a full surrogate pair with backspace', () => {
    const editor = new LineEditor();
    editor.insert('a😀');
    editor.backspace();
    expect(editor.text).toBe('a');
    expect(editor.cursor).toBe(1);
  });

  it('deletes the character after the cursor', () => {
    const editor = new LineEditor();
    editor.insert('abc');
    editor.moveHome();
    editor.delete();
    expect(editor.text).toBe('bc');
    expect(editor.cursor).toBe(0);
  });

  it('supports ctrl-u, ctrl-k, and ctrl-w style edits', () => {
    const editor = new LineEditor();
    editor.insert('one two three');
    editor.moveHome();
    for (let index = 0; index < 7; index += 1) editor.moveRight();
    editor.deleteWordBefore();
    expect(editor.text).toBe('one  three');
    editor.deleteToEnd();
    expect(editor.text).toBe('one ');
    editor.deleteToStart();
    expect(editor.text).toBe('');
  });

  it('navigates history and restores the draft', () => {
    const editor = new LineEditor();
    editor.insert('first');
    expect(editor.submit()).toBe('first');
    editor.insert('second');
    editor.submit();
    editor.insert('draft');

    expect(editor.historyPrevious()).toBe(true);
    expect(editor.text).toBe('second');
    expect(editor.historyPrevious()).toBe(true);
    expect(editor.text).toBe('first');
    expect(editor.historyPrevious()).toBe(false);
    expect(editor.historyNext()).toBe(true);
    expect(editor.text).toBe('second');
    expect(editor.historyNext()).toBe(true);
    expect(editor.text).toBe('draft');
    expect(editor.historyNext()).toBe(false);
  });

  it('trims submissions and clears the editor', () => {
    const editor = new LineEditor();
    editor.insert('  hi  ');
    expect(editor.submit()).toBe('hi');
    expect(editor.text).toBe('');
    expect(editor.cursor).toBe(0);
  });

  it('keeps slash commands out of the recall history', () => {
    const editor = new LineEditor();
    editor.insert('/help');
    expect(editor.submit()).toBe('/help');
    editor.insert('/provider ollama');
    expect(editor.submit()).toBe('/provider ollama');
    editor.insert('hello');
    expect(editor.submit()).toBe('hello');

    expect(editor.historyLength).toBe(1);
    editor.insert('draft');
    expect(editor.historyPrevious()).toBe(true);
    expect(editor.text).toBe('hello');
    expect(editor.historyPrevious()).toBe(false);
  });

  it('inserts newlines and navigates across them', () => {
    const editor = new LineEditor();
    editor.insert('first');
    editor.insertNewline();
    editor.insert('second');
    expect(editor.text).toBe('first\nsecond');
    expect(editor.cursor).toBe(12);
    expect(editor.isMultiline).toBe(true);

    editor.moveHome();
    expect(editor.cursor).toBe(6);
    editor.moveUp();
    expect(editor.cursor).toBe(0);
    editor.moveEnd();
    expect(editor.cursor).toBe(5);
    editor.moveDown();
    expect(editor.cursor).toBe(11);
  });

  it('keeps ctrl-u, ctrl-k, and ctrl-w within the current line', () => {
    const start = new LineEditor();
    start.setText('one\ntwo');
    start.moveHome();
    start.moveRight();
    start.deleteToStart();
    expect(start.text).toBe('one\nwo');

    const end = new LineEditor();
    end.setText('one\ntwo');
    end.moveHome();
    end.moveRight();
    end.deleteToEnd();
    expect(end.text).toBe('one\nt');

    const word = new LineEditor();
    word.setText('one\ntwo');
    word.deleteWordBefore();
    expect(word.text).toBe('one\n');
  });

  it('sanitizes newlines, tabs, ANSI, and control characters', () => {
    const editor = new LineEditor();
    editor.insert('a\nb\tc\x1b[31md\x07');
    expect(editor.text).toBe('a b cd');
  });
});
