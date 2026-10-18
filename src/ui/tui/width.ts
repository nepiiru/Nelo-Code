const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombining(codePoint)) return 0;
  if (isWide(codePoint)) return 2;
  return 1;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const character of stripAnsi(text)) {
    width += charWidth(character.codePointAt(0) ?? 0);
  }
  return width;
}

export function truncateAnsi(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  let width = 0;
  let index = 0;
  let output = '';
  let sawEscape = false;

  while (index < text.length) {
    if (text.charCodeAt(index) === 0x1b) {
      const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(index));
      if (match) {
        output += match[0];
        sawEscape = true;
        index += match[0].length;
        continue;
      }
    }

    const codePoint = text.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    const characterWidth = charWidth(codePoint);

    if (width + characterWidth > maxWidth) {
      if (sawEscape) output += '\x1b[0m';
      return output;
    }

    output += character;
    width += characterWidth;
    index += character.length;
  }

  return output;
}

export function padToWidth(text: string, width: number): string {
  const current = stringWidth(text);
  if (current >= width) return truncateAnsi(text, width);
  return text + ' '.repeat(width - current);
}
