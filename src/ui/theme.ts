import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { colorEnabled } from './ansi.js';

/**
 * Theme + addon system.
 *
 * A theme is a flat set of color tokens, glyphs and layout switches. Addons are
 * JSON files that override any subset of those tokens, so a new look is a few
 * lines of JSON and no code. Functional addons (new tools, hooks) are out of
 * scope for now.
 */

export const COLOR_TOKENS = [
  'brand',
  'accent',
  'accentAlt',
  'text',
  'muted',
  'dim',
  'success',
  'warning',
  'danger',
  'info',
  'user',
  'assistant',
  'tool',
  'toolError',
  'code',
  'heading',
  'border',
  'vitals',
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

export const GLYPH_TOKENS = [
  'brand',
  'prompt',
  'user',
  'tool',
  'toolBranch',
  'separator',
  'warn',
  'error',
  'question',
  'cursor',
  'bullet',
  'scroll',
  'state',
  'boxTopLeft',
  'boxTopRight',
  'boxBottomLeft',
  'boxBottomRight',
  'boxHorizontal',
  'boxVertical',
] as const;

export type GlyphToken = (typeof GLYPH_TOKENS)[number];

export interface ThemeLayout {
  /** Show the header line with model / mode / cwd. */
  header: boolean;
  /** Draw separator rules above and below the transcript. */
  separators: boolean;
  /** How the status bar is drawn. */
  statusBar: 'inverse' | 'plain' | 'accent';
  /** Show the welcome card before the first message. */
  hints: boolean;
}

export interface ThemeMarkdown {
  heading: ColorToken;
  code: ColorToken;
  fence: ColorToken;
  bullet: ColorToken;
  /** Inline `**strong**` text. */
  strong: ColorToken;
  /** Inline `*emphasis*` text. */
  emphasis: ColorToken;
  /** URLs rendered from `[label](url)` links. */
  link: ColorToken;
}

export interface Theme {
  name: string;
  label: string;
  description: string;
  colors: Record<ColorToken, string>;
  glyphs: Record<GlyphToken, string>;
  spinner: string[];
  layout: ThemeLayout;
  markdown: ThemeMarkdown;
}

export interface ThemeSpec {
  colors?: Partial<Record<ColorToken, string>>;
  glyphs?: Partial<Record<GlyphToken, string>>;
  spinner?: string[];
  layout?: Partial<ThemeLayout>;
  markdown?: Partial<ThemeMarkdown>;
}

const ANSI_CODES: Record<string, string> = {
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
  grey: '90',
  brightRed: '91',
  brightGreen: '92',
  brightYellow: '93',
  brightBlue: '94',
  brightMagenta: '95',
  brightCyan: '96',
  brightWhite: '97',
};

function hexToCode(hex: string): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  let digits = match[1] ?? '';
  if (digits.length === 3) {
    digits = digits
      .split('')
      .map((char) => `${char}${char}`)
      .join('');
  }
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);
  return `38;2;${r};${g};${b}`;
}

function colorCode(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none' || trimmed === 'default') return null;
  if (trimmed.startsWith('#')) return hexToCode(trimmed);
  return ANSI_CODES[trimmed] ?? ANSI_CODES[trimmed.toLowerCase()] ?? null;
}

export function isColorValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none' || trimmed === 'default') return true;
  return colorCode(trimmed) !== null;
}

/** Wraps text in the ANSI code for a color token value (name or #rrggbb). */
export function paintColor(value: string, text: string): string {
  if (!colorEnabled() || !text) return text;
  const code = colorCode(value);
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function bold(text: string): string {
  if (!colorEnabled() || !text) return text;
  return `\x1b[1m${text}\x1b[0m`;
}

export function dim(text: string): string {
  if (!colorEnabled() || !text) return text;
  return `\x1b[2m${text}\x1b[0m`;
}

export function italic(text: string): string {
  if (!colorEnabled() || !text) return text;
  return `\x1b[3m${text}\x1b[0m`;
}

export function inverse(text: string): string {
  if (!colorEnabled() || !text) return text;
  return `\x1b[7m${text}\x1b[0m`;
}

const BASE_COLORS: Record<ColorToken, string> = {
  brand: 'magenta',
  accent: 'green',
  accentAlt: 'cyan',
  text: 'default',
  muted: 'gray',
  dim: 'gray',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  info: 'cyan',
  user: 'magenta',
  assistant: 'default',
  tool: 'green',
  toolError: 'red',
  code: 'cyan',
  heading: 'default',
  border: 'gray',
  vitals: 'gray',
};

const BASE_GLYPHS: Record<GlyphToken, string> = {
  brand: '◆',
  prompt: '❯',
  user: '❯',
  tool: '●',
  toolBranch: '└',
  separator: '─',
  warn: '!',
  error: '✖',
  question: '?',
  cursor: ' ',
  bullet: '-',
  scroll: '↑',
  state: '●',
  boxTopLeft: '╭',
  boxTopRight: '╮',
  boxBottomLeft: '╰',
  boxBottomRight: '╯',
  boxHorizontal: '─',
  boxVertical: '│',
};

const BASE_LAYOUT: ThemeLayout = {
  header: true,
  separators: true,
  statusBar: 'inverse',
  hints: true,
};

const BASE_MARKDOWN: ThemeMarkdown = {
  heading: 'heading',
  code: 'code',
  fence: 'dim',
  bullet: 'accentAlt',
  strong: 'text',
  emphasis: 'muted',
  link: 'dim',
};

const DEFAULT_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function applyThemeSpec(
  base: Theme,
  spec: ThemeSpec,
  meta: { name: string; label?: string; description?: string },
): Theme {
  return {
    name: meta.name,
    label: meta.label ?? base.label,
    description: meta.description ?? base.description,
    colors: { ...base.colors, ...(spec.colors ?? {}) },
    glyphs: { ...base.glyphs, ...(spec.glyphs ?? {}) },
    spinner: spec.spinner && spec.spinner.length > 0 ? [...spec.spinner] : [...base.spinner],
    layout: { ...base.layout, ...(spec.layout ?? {}) },
    markdown: { ...base.markdown, ...(spec.markdown ?? {}) },
  };
}

function makeTheme(
  name: string,
  label: string,
  description: string,
  spec: ThemeSpec,
): Theme {
  const base: Theme = {
    name,
    label,
    description,
    colors: { ...BASE_COLORS },
    glyphs: { ...BASE_GLYPHS },
    spinner: [...DEFAULT_SPINNER],
    layout: { ...BASE_LAYOUT },
    markdown: { ...BASE_MARKDOWN },
  };
  return applyThemeSpec(base, spec, { name, label, description });
}

export const BUILTIN_THEMES: Record<string, Theme> = {
  nelo: makeTheme('nelo', 'Nelo', 'Neon violet and cyan with a boxed prompt.', {
    colors: {
      brand: '#a78bfa',
      accent: '#22d3ee',
      accentAlt: '#f472b6',
      text: '#e2e8f0',
      muted: '#94a3b8',
      dim: '#64748b',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#fb7185',
      info: '#60a5fa',
      user: '#c4b5fd',
      assistant: '#e2e8f0',
      tool: '#22d3ee',
      toolError: '#fb7185',
      code: '#7dd3fc',
      heading: '#f0abfc',
      border: '#3f3f5a',
      vitals: '#94a3b8',
    },
    glyphs: {
      brand: '◆',
      prompt: '❯',
      tool: '▸',
      toolBranch: '╰',
      separator: '─',
      state: '●',
    },
    layout: { statusBar: 'plain' },
  }),
  midnight: makeTheme('midnight', 'Midnight', 'Cool blues and violets for late sessions.', {
    colors: {
      brand: '#8b9dff',
      accent: '#7ee787',
      accentAlt: '#79c0ff',
      muted: '#7d8590',
      dim: '#6e7681',
      info: '#79c0ff',
      user: '#b392f0',
      tool: '#7ee787',
      code: '#a5d6ff',
      heading: '#d2a8ff',
      border: '#30363d',
      vitals: '#7d8590',
    },
    glyphs: { brand: '◈', prompt: '›', user: '›', tool: '◇', toolBranch: '└', separator: '─' },
    layout: { statusBar: 'plain' },
  }),
  nord: makeTheme('nord', 'Nord', 'Muted arctic palette with a plain status bar.', {
    colors: {
      brand: '#88c0d0',
      accent: '#a3be8c',
      accentAlt: '#81a1c1',
      muted: '#616e88',
      dim: '#4c566a',
      info: '#8fbcbb',
      user: '#b48ead',
      tool: '#a3be8c',
      code: '#8fbcbb',
      heading: '#88c0d0',
      border: '#4c566a',
      vitals: '#616e88',
    },
    glyphs: { brand: '❄', prompt: '❯', tool: '•', toolBranch: '└', separator: '─' },
    layout: { statusBar: 'plain' },
  }),
  mono: makeTheme('mono', 'Mono', 'No color at all: glyphs and weight only.', {
    colors: Object.fromEntries(COLOR_TOKENS.map((token) => [token, 'none'])) as Record<
      ColorToken,
      string
    >,
    glyphs: {
      brand: '[nelo]',
      prompt: '>',
      user: '>',
      tool: '*',
      toolBranch: '-',
      separator: '-',
      state: '*',
      boxTopLeft: '+',
      boxTopRight: '+',
      boxBottomLeft: '+',
      boxBottomRight: '+',
      boxHorizontal: '-',
      boxVertical: '|',
    },
    spinner: ['|', '/', '-', '\\'],
    layout: { statusBar: 'plain', separators: true },
  }),
  sakura: makeTheme('sakura', 'Sakura', 'Soft pinks with a rounded prompt.', {
    colors: {
      brand: '#f5a9c8',
      accent: '#f7c6d9',
      accentAlt: '#c3a6ff',
      muted: '#9d8189',
      dim: '#7d6b73',
      info: '#c3a6ff',
      user: '#f5a9c8',
      tool: '#f7c6d9',
      code: '#c3a6ff',
      heading: '#ffd7e8',
      border: '#6b4f5b',
      vitals: '#9d8189',
    },
    glyphs: { brand: '✿', prompt: '❀', user: '❀', tool: '•', toolBranch: '╰', separator: '─' },
    layout: { statusBar: 'plain' },
  }),
};

export const DEFAULT_THEME_NAME = 'nelo';

export function builtinThemeNames(): string[] {
  return Object.keys(BUILTIN_THEMES);
}

export function getBuiltinTheme(name: string): Theme | undefined {
  return BUILTIN_THEMES[name];
}

// ---------------------------------------------------------------- addons

export interface ThemeAddon extends Theme {
  /** Directory the addon was loaded from. */
  path: string;
  version?: string;
  author?: string;
  extends: string;
}

export interface AddonLoadResult {
  themes: ThemeAddon[];
  errors: string[];
  directories: string[];
}

/** `~/.nelo/addons` first, then `./.nelo/addons` (project addons win). */
export function addonDirectories(cwd: string, home: string = homedir()): string[] {
  return [join(home, '.nelo', 'addons'), join(cwd, '.nelo', 'addons')];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown, allowed: readonly string[], label: string, errors: string[]): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      errors.push(`${label} has an unknown token "${key}". Known tokens: ${allowed.join(', ')}.`);
      continue;
    }
    if (typeof raw !== 'string') {
      errors.push(`${label}.${key} must be a string.`);
      continue;
    }
    out[key] = raw;
  }
  return out;
}

function parseThemeSpec(raw: Record<string, unknown>, label: string, errors: string[]): ThemeSpec {
  const spec: ThemeSpec = {};

  const colors = stringRecord(raw.colors, COLOR_TOKENS, `${label}: colors`, errors);
  for (const [token, value] of Object.entries(colors)) {
    if (!isColorValue(value)) {
      errors.push(
        `${label}: colors.${token} is "${value}", which is not a color name (red, brightCyan, …) or #rrggbb.`,
      );
      delete colors[token];
    }
  }
  if (Object.keys(colors).length > 0) spec.colors = colors;

  const glyphs = stringRecord(raw.glyphs, GLYPH_TOKENS, `${label}: glyphs`, errors);
  if (Object.keys(glyphs).length > 0) spec.glyphs = glyphs;

  if (raw.spinner !== undefined) {
    if (Array.isArray(raw.spinner) && raw.spinner.every((frame) => typeof frame === 'string')) {
      if (raw.spinner.length > 0) spec.spinner = raw.spinner as string[];
    } else {
      errors.push(`${label}: spinner must be an array of strings.`);
    }
  }

  if (raw.layout !== undefined) {
    if (raw.layout && typeof raw.layout === 'object' && !Array.isArray(raw.layout)) {
      const layout: Partial<ThemeLayout> = {};
      const source = raw.layout as Record<string, unknown>;
      if (typeof source.header === 'boolean') layout.header = source.header;
      if (typeof source.separators === 'boolean') layout.separators = source.separators;
      if (typeof source.hints === 'boolean') layout.hints = source.hints;
      if (source.statusBar === 'inverse' || source.statusBar === 'plain' || source.statusBar === 'accent') {
        layout.statusBar = source.statusBar;
      } else if (source.statusBar !== undefined) {
        errors.push(`${label}: layout.statusBar must be "inverse", "plain" or "accent".`);
      }
      spec.layout = layout;
    } else {
      errors.push(`${label}: layout must be an object.`);
    }
  }

  if (raw.markdown !== undefined) {
    if (raw.markdown && typeof raw.markdown === 'object' && !Array.isArray(raw.markdown)) {
      const markdown: Partial<ThemeMarkdown> = {};
      for (const key of ['heading', 'code', 'fence', 'bullet', 'strong', 'emphasis', 'link'] as const) {
        const value = (raw.markdown as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (typeof value === 'string' && COLOR_TOKENS.includes(value as ColorToken)) {
          markdown[key] = value as ColorToken;
        } else {
          errors.push(`${label}: markdown.${key} must be one of the color tokens.`);
        }
      }
      spec.markdown = markdown;
    } else {
      errors.push(`${label}: markdown must be an object.`);
    }
  }

  return spec;
}

/** Reads every theme addon found on disk. Broken addons are reported, never thrown. */
export function loadThemeAddons(cwd: string, home: string = homedir()): AddonLoadResult {
  const directories = addonDirectories(cwd, home);
  const themes: ThemeAddon[] = [];
  const errors: string[] = [];

  for (const directory of directories) {
    if (!existsSync(directory)) continue;

    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      errors.push(`Could not read addon directory ${directory}.`);
      continue;
    }

    for (const entry of entries.sort()) {
      const addonPath = join(directory, entry);
      try {
        if (!statSync(addonPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const manifestPath = existsSync(join(addonPath, 'addon.json'))
        ? join(addonPath, 'addon.json')
        : existsSync(join(addonPath, 'theme.json'))
          ? join(addonPath, 'theme.json')
          : null;

      if (!manifestPath) {
        errors.push(`${addonPath}: no addon.json found.`);
        continue;
      }

      const manifest = readJson(manifestPath);
      if (!manifest) {
        errors.push(`${manifestPath}: not valid JSON.`);
        continue;
      }

      if (manifest.type !== undefined && manifest.type !== 'theme') {
        errors.push(`${manifestPath}: unsupported addon type "${String(manifest.type)}" (only "theme" is supported).`);
        continue;
      }

      if (manifest.apiVersion !== undefined && manifest.apiVersion !== 1) {
        errors.push(`${manifestPath}: apiVersion ${String(manifest.apiVersion)} is not supported (expected 1).`);
        continue;
      }

      const name =
        typeof manifest.name === 'string' && manifest.name.trim()
          ? manifest.name.trim()
          : entry;
      const baseName = typeof manifest.extends === 'string' ? manifest.extends : DEFAULT_THEME_NAME;
      const base = getBuiltinTheme(baseName);
      if (!base) {
        errors.push(`${manifestPath}: extends "${baseName}", which is not a built-in theme.`);
        continue;
      }

      const specSource =
        manifest.theme && typeof manifest.theme === 'object' && !Array.isArray(manifest.theme)
          ? { ...(manifest.theme as Record<string, unknown>), ...stripMeta(manifest) }
          : stripMeta(manifest);

      const spec = parseThemeSpec(specSource, manifestPath, errors);
      const theme = applyThemeSpec(base, spec, {
        name,
        label: typeof manifest.label === 'string' ? manifest.label : name,
        description:
          typeof manifest.description === 'string'
            ? manifest.description
            : `Addon theme from ${addonPath}`,
      });

      themes.push({
        ...theme,
        path: addonPath,
        extends: baseName,
        ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
        ...(typeof manifest.author === 'string' ? { author: manifest.author } : {}),
      });
    }
  }

  return { themes, errors, directories };
}

const META_KEYS = new Set(['name', 'label', 'description', 'type', 'apiVersion', 'version', 'author', 'extends', 'theme', '_hint', '_tokens']);

function stripMeta(manifest: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (!META_KEYS.has(key)) out[key] = value;
  }
  return out;
}

export interface ResolvedTheme {
  theme: Theme;
  errors: string[];
  source: 'builtin' | 'addon' | 'fallback';
}

/** Resolves a theme by name: built-in first, then addons. Falls back to the default. */
export function resolveTheme(
  name: string,
  cwd: string,
  home: string = homedir(),
): ResolvedTheme {
  const builtin = getBuiltinTheme(name);
  if (builtin) return { theme: builtin, errors: [], source: 'builtin' };

  const { themes, errors } = loadThemeAddons(cwd, home);
  const addon = themes.find((candidate) => candidate.name === name);
  if (addon) return { theme: addon, errors, source: 'addon' };

  return {
    theme: BUILTIN_THEMES[DEFAULT_THEME_NAME] ?? Object.values(BUILTIN_THEMES)[0]!,
    errors: [...errors, `Theme "${name}" was not found; using "${DEFAULT_THEME_NAME}".`],
    source: 'fallback',
  };
}

// ------------------------------------------------------- active theme

let activeTheme: Theme = BUILTIN_THEMES[DEFAULT_THEME_NAME] ?? Object.values(BUILTIN_THEMES)[0]!;

export function getActiveTheme(): Theme {
  return activeTheme;
}

export function setActiveTheme(theme: Theme): void {
  activeTheme = theme;
}

/** Paints text with the active theme's color for a token. */
export function paintToken(token: ColorToken, text: string): string {
  return paintColor(activeTheme.colors[token], text);
}

export function glyph(token: GlyphToken): string {
  return activeTheme.glyphs[token];
}

export function spinnerFrames(): string[] {
  return activeTheme.spinner;
}

// ------------------------------------------------------- scaffolding

export function themeAddonTemplate(name: string): string {
  const template = {
    name,
    type: 'theme',
    apiVersion: 1,
    version: '1.0.0',
    author: 'you',
    label: name,
    description: 'My Nelo Code theme.',
    extends: DEFAULT_THEME_NAME,
    _hint: 'Edit colors/glyphs and run /theme reload. Colors accept ANSI names (red, brightCyan, gray) or #rrggbb.',
    _tokens: {
      colors: [...COLOR_TOKENS],
      glyphs: [...GLYPH_TOKENS],
    },
    colors: {
      brand: '#8b9dff',
      accent: '#7ee787',
      accentAlt: '#79c0ff',
      user: '#b392f0',
      tool: '#7ee787',
      code: '#a5d6ff',
      heading: '#d2a8ff',
      border: '#30363d',
      vitals: '#7d8590',
    },
    glyphs: {
      brand: '◆',
      prompt: '❯',
      tool: '●',
      toolBranch: '└',
    },
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    layout: {
      header: true,
      separators: true,
      statusBar: 'plain',
      hints: true,
    },
  };
  return `${JSON.stringify(template, null, 2)}\n`;
}

/** Creates `<addonRoot>/<name>/addon.json` and returns the path. */
export function createThemeAddon(name: string, cwd: string, home: string = homedir()): string {
  const safe = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!safe) throw new Error('Addon name must contain at least one letter, digit, dot, dash or underscore.');

  const target = join(home, '.nelo', 'addons', safe);
  const manifest = join(target, 'addon.json');
  if (existsSync(manifest)) {
    throw new Error(`Addon "${safe}" already exists at ${manifest}.`);
  }

  mkdirSync(target, { recursive: true });
  writeFileSync(manifest, themeAddonTemplate(safe), 'utf8');
  void cwd;
  return manifest;
}
