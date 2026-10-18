function escapeRegExpChar(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const [full, inner] = match;
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + full.length);
  const alternatives = (inner ?? '').split(',');
  return alternatives.flatMap((alternative) => expandBraces(before + alternative + after));
}

function patternToSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === '*') {
      if (pattern.charAt(index + 1) === '*') {
        if (pattern.charAt(index + 2) === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExpChar(char);
    }
  }
  return source;
}

export function globToRegExp(glob: string): RegExp {
  const sources = expandBraces(glob.trim()).map(patternToSource);
  return new RegExp(`^(?:${sources.join('|')})$`);
}

export function matchesGlob(relativePath: string, glob: string): boolean {
  const normalized = relativePath.split('\\').join('/');
  const pattern = glob.trim();
  if (!pattern) return true;
  const candidate = pattern.includes('/') ? normalized : normalized.slice(normalized.lastIndexOf('/') + 1);
  return globToRegExp(pattern).test(candidate);
}
