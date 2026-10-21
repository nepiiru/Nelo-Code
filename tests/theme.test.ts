import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_THEMES,
  COLOR_TOKENS,
  GLYPH_TOKENS,
  createThemeAddon,
  getActiveTheme,
  isColorValue,
  loadThemeAddons,
  paintToken,
  resolveTheme,
  setActiveTheme,
  themeAddonTemplate,
} from '../src/ui/theme.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('nelo-theme-');
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeTempDir(dir);
  }
  setActiveTheme(BUILTIN_THEMES.nelo!);
});

async function writeAddon(home: string, name: string, manifest: unknown): Promise<string> {
  const dir = join(home, '.nelo', 'addons', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'addon.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

describe('built-in themes', () => {
  it('defines every color and glyph token for each theme', () => {
    for (const theme of Object.values(BUILTIN_THEMES)) {
      for (const token of COLOR_TOKENS) {
        expect(typeof theme.colors[token], `${theme.name}.colors.${token}`).toBe('string');
        expect(isColorValue(theme.colors[token]), `${theme.name}.colors.${token}`).toBe(true);
      }
      for (const token of GLYPH_TOKENS) {
        expect(typeof theme.glyphs[token], `${theme.name}.glyphs.${token}`).toBe('string');
        expect(theme.glyphs[token].length, `${theme.name}.glyphs.${token}`).toBeGreaterThan(0);
      }
      expect(theme.spinner.length).toBeGreaterThan(0);
    }
  });

  it('resolves a built-in theme by name', async () => {
    const cwd = await tempDir();
    const resolved = resolveTheme('midnight', cwd, cwd);
    expect(resolved.source).toBe('builtin');
    expect(resolved.theme.name).toBe('midnight');
    expect(resolved.errors).toEqual([]);
  });

  it('falls back to the default theme with a warning', async () => {
    const cwd = await tempDir();
    const resolved = resolveTheme('does-not-exist', cwd, cwd);
    expect(resolved.source).toBe('fallback');
    expect(resolved.theme.name).toBe('nelo');
    expect(resolved.errors.join('\n')).toContain('was not found');
  });
});

describe('theme addons', () => {
  it('loads an addon that overrides colors and glyphs', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await writeAddon(home, 'ocean', {
      name: 'ocean',
      type: 'theme',
      apiVersion: 1,
      label: 'Ocean',
      description: 'Blue everything.',
      extends: 'nord',
      colors: { accent: '#00aaff', brand: 'brightCyan' },
      glyphs: { prompt: 'λ' },
      layout: { statusBar: 'plain', separators: false },
    });

    const { themes, errors } = loadThemeAddons(cwd, home);
    expect(errors).toEqual([]);
    expect(themes).toHaveLength(1);

    const theme = themes[0]!;
    expect(theme.name).toBe('ocean');
    expect(theme.label).toBe('Ocean');
    expect(theme.extends).toBe('nord');
    expect(theme.colors.accent).toBe('#00aaff');
    expect(theme.glyphs.prompt).toBe('λ');
    expect(theme.layout.statusBar).toBe('plain');
    expect(theme.layout.separators).toBe(false);
    // Inherited from nord.
    expect(theme.colors.code).toBe('#8fbcbb');
  });

  it('reports unknown tokens instead of throwing', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await writeAddon(home, 'broken', {
      name: 'broken',
      apiVersion: 1,
      colors: { notAToken: 'red', accent: 'not-a-color' },
    });

    const { themes, errors } = loadThemeAddons(cwd, home);
    expect(themes).toHaveLength(1);
    expect(errors.join('\n')).toContain('unknown token "notAToken"');
    expect(errors.join('\n')).toContain('not a color name');
    expect(themes[0]?.colors.accent).toBe(BUILTIN_THEMES.nelo?.colors.accent);
  });

  it('rejects unsupported addon types and api versions', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await writeAddon(home, 'tool-addon', { name: 'tool-addon', type: 'tool' });
    await writeAddon(home, 'future', { name: 'future', apiVersion: 99 });

    const { themes, errors } = loadThemeAddons(cwd, home);
    expect(themes).toHaveLength(0);
    expect(errors.join('\n')).toContain('unsupported addon type');
    expect(errors.join('\n')).toContain('apiVersion 99');
  });

  it('reports invalid JSON', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    const dir = join(home, '.nelo', 'addons', 'garbage');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'addon.json'), '{ not json', 'utf8');

    const { errors } = loadThemeAddons(cwd, home);
    expect(errors.join('\n')).toContain('not valid JSON');
  });

  it('accepts the nested "theme" form', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await writeAddon(home, 'nested', {
      name: 'nested',
      theme: { colors: { accent: 'red' } },
    });

    const { themes } = loadThemeAddons(cwd, home);
    expect(themes[0]?.colors.accent).toBe('red');
  });

  it('scaffolds a valid addon with a single command', async () => {
    const home = await tempDir();
    const cwd = await tempDir();

    const manifestPath = createThemeAddon('my-theme', cwd, home);
    const { themes, errors } = loadThemeAddons(cwd, home);

    expect(errors).toEqual([]);
    expect(themes.map((theme) => theme.name)).toEqual(['my-theme']);
    expect(() => createThemeAddon('my-theme', cwd, home)).toThrow(/already exists/);
    expect(themeAddonTemplate('x')).toContain('"apiVersion": 1');
    expect(manifestPath).toContain('addon.json');
  });
});

describe('active theme', () => {
  it('paints with the active theme colors', () => {
    const previous = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    const previousTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      setActiveTheme(BUILTIN_THEMES.nord!);
      expect(getActiveTheme().name).toBe('nord');
      expect(paintToken('accent', 'x')).toContain('\x1b[38;2;');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: previousTty, configurable: true });
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });

  it('respects NO_COLOR', () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      setActiveTheme(BUILTIN_THEMES.nord!);
      expect(paintToken('accent', 'x')).toBe('x');
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});
