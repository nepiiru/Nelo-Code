import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesGlob } from '../src/utils/glob.js';

describe('glob matching', () => {
  it('matches simple star patterns against the basename', () => {
    expect(matchesGlob('src/a.ts', '*.ts')).toBe(true);
    expect(matchesGlob('src/a.js', '*.ts')).toBe(false);
    expect(matchesGlob('a.test.ts', '*.test.ts')).toBe(true);
  });

  it('matches ** across directories', () => {
    expect(matchesGlob('src/deep/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('lib/a.ts', 'src/**/*.ts')).toBe(false);
  });

  it('supports braces and question marks', () => {
    expect(matchesGlob('a.test.ts', '*.{test,spec}.ts')).toBe(true);
    expect(matchesGlob('a.spec.ts', '*.{test,spec}.ts')).toBe(true);
    expect(matchesGlob('a.ts', '?.ts')).toBe(true);
    expect(matchesGlob('ab.ts', '?.ts')).toBe(false);
  });

  it('anchors the whole path', () => {
    expect(globToRegExp('*.ts').test('a.ts.bak')).toBe(false);
  });
});
