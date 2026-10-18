import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { atomicWriteFile } from './utils/fsx.js';
import type { Message, UsageTotals } from './types.js';
import { emptyUsage } from './types.js';

export interface SessionData {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  messages: Message[];
  usage: UsageTotals;
}

export function createSessionId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${stamp}-${random}`;
}

export function newSession(cwd: string, model: string): SessionData {
  const now = new Date().toISOString();
  return {
    id: createSessionId(),
    createdAt: now,
    updatedAt: now,
    cwd,
    model,
    messages: [],
    usage: emptyUsage(),
  };
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'workspace';
}

export function projectSessionDir(cwd: string, home: string = homedir()): string {
  const hash = createHash('sha1').update(cwd.toLowerCase()).digest('hex').slice(0, 12);
  return join(home, '.nelo', 'projects', `${sanitize(basename(cwd) || 'workspace')}-${hash}`, 'sessions');
}

function parseSession(raw: string): SessionData {
  const parsed = JSON.parse(raw) as SessionData;
  if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.messages)) {
    throw new Error('invalid session file');
  }
  parsed.usage = { ...emptyUsage(), ...(parsed.usage ?? {}) };
  return parsed;
}

export class SessionStore {
  readonly dir: string;

  constructor(
    readonly cwd: string,
    baseDir?: string,
  ) {
    this.dir = baseDir ?? projectSessionDir(cwd);
  }

  pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async save(session: SessionData): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await atomicWriteFile(this.pathFor(session.id), JSON.stringify(session, null, 2));
  }

  async load(id: string): Promise<SessionData | null> {
    try {
      return parseSession(await readFile(this.pathFor(id), 'utf8'));
    } catch {
      return null;
    }
  }

  async loadLatest(): Promise<SessionData | null> {
    const sessions = await this.list();
    return sessions[0] ?? null;
  }

  async list(): Promise<SessionData[]> {
    if (!existsSync(this.dir)) return [];
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }

    const files = entries.filter((name) => name.endsWith('.json'));
    const withStats = await Promise.all(
      files.map(async (name) => {
        try {
          const info = await stat(join(this.dir, name));
          return { name, mtime: info.mtimeMs };
        } catch {
          return null;
        }
      }),
    );

    const ordered = withStats
      .filter((entry): entry is { name: string; mtime: number } => entry !== null)
      .sort((a, b) => b.mtime - a.mtime);

    const sessions: SessionData[] = [];
    for (const entry of ordered.slice(0, 50)) {
      try {
        sessions.push(parseSession(await readFile(join(this.dir, entry.name), 'utf8')));
      } catch {
        // Skip corrupted session files.
      }
      if (sessions.length >= 20) break;
    }
    return sessions;
  }
}
