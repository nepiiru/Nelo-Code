import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newSession, projectSessionDir, SessionStore } from '../src/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

describe('SessionStore', () => {
  let baseDir: string;
  let workspace: string;

  beforeEach(async () => {
    baseDir = await makeTempDir('nelo-sessions-');
    workspace = await makeTempDir('nelo-session-ws-');
  });

  afterEach(async () => {
    await removeTempDir(baseDir);
    await removeTempDir(workspace);
  });

  it('round-trips a session', async () => {
    const store = new SessionStore(workspace, baseDir);
    const session = newSession(workspace, 'claude-sonnet-5-5');
    session.messages.push({ role: 'user', content: [{ type: 'text', text: 'hello' }] });

    await store.save(session);
    const loaded = await store.load(session.id);

    expect(loaded?.id).toBe(session.id);
    expect(loaded?.messages).toEqual(session.messages);
    expect(loaded?.model).toBe('claude-sonnet-5-5');
  });

  it('loads the most recently saved session', async () => {
    const store = new SessionStore(workspace, baseDir);
    const first = newSession(workspace, 'model-a');
    const second = newSession(workspace, 'model-b');
    await store.save(first);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await store.save(second);

    const latest = await store.loadLatest();
    expect(latest?.id).toBe(second.id);
  });

  it('skips corrupted session files', async () => {
    const store = new SessionStore(workspace, baseDir);
    const good = newSession(workspace, 'model-a');
    await store.save(good);
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, 'broken.json'), '{ nope');

    const sessions = await store.list();
    expect(sessions.map((session) => session.id)).toEqual([good.id]);
  });

  it('creates distinct, stable project directories', () => {
    const a = projectSessionDir(workspace, '/home/user');
    const b = projectSessionDir(workspace, '/home/user');
    const c = projectSessionDir(join(workspace, 'other'), '/home/user');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
