#!/usr/bin/env node
/**
 * End-to-end smoke test against the mock Anthropic API.
 * Verifies: streaming text, the tool loop, session persistence,
 * auto-approved writes, and read-only denial.
 *
 * Run with: npm run test:e2e   (builds first)
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const port = 8800 + Math.floor(Math.random() * 200);
const home = await mkdtemp(join(tmpdir(), 'nelo-e2e-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'nelo-e2e-ws-'));
const readonlyWorkspace = await mkdtemp(join(tmpdir(), 'nelo-e2e-ro-'));
let mock = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function runCli(args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'bin', 'nelo.js'), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function cleanup() {
  if (mock && !mock.killed) mock.kill();
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  await rm(readonlyWorkspace, { recursive: true, force: true });
}

try {
  await writeFile(join(workspace, 'package.json'), '{\n  "name": "e2e-fixture"\n}\n');

  mock = spawn(process.execPath, ['scripts/mock-server.mjs'], {
    cwd: root,
    env: { ...process.env, MOCK_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mockOutput = '';
  mock.stdout.on('data', (chunk) => {
    mockOutput += chunk;
  });
  mock.stderr.on('data', (chunk) => {
    mockOutput += chunk;
  });
  await waitFor(() => mockOutput.includes('listening'), 8000, 'mock server did not start');

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    NO_COLOR: '1',
  };

  // 1. One-shot run: streaming text plus a read_file tool call.
  const oneShot = await runCli(['hello there'], workspace, env);
  assert(oneShot.code === 0, `one-shot exited with ${oneShot.code}: ${oneShot.stderr}`);
  assert(oneShot.stdout.includes('mock model'), 'stdout is missing the final model text');
  assert(oneShot.stderr.includes('read_file'), 'stderr is missing tool activity');

  // 2. Session persistence under the (temporary) home directory.
  const projects = await readdir(join(home, '.nelo', 'projects'));
  assert(projects.length > 0, 'no project session directory was created');

  // 3. Auto-approved write creates the file.
  const writeRun = await runCli(['-y', 'write-demo'], workspace, env);
  assert(writeRun.code === 0, `write run exited with ${writeRun.code}: ${writeRun.stderr}`);
  const written = await readFile(join(workspace, 'mock-output.txt'), 'utf8');
  assert(written.includes('written by the mock model'), 'the write_file tool did not create the file');

  // 4. Read-only mode denies the write.
  const readonlyRun = await runCli(['--readonly', 'write-demo'], readonlyWorkspace, env);
  assert(readonlyRun.code === 0, `readonly run exited with ${readonlyRun.code}: ${readonlyRun.stderr}`);
  const fileExists = await stat(join(readonlyWorkspace, 'mock-output.txt'))
    .then(() => true)
    .catch(() => false);
  assert(!fileExists, 'read-only mode still wrote the file');
  assert(readonlyRun.stderr.includes('read-only'), 'the read-only denial was not reported');

  console.log('✔ E2E passed: tool loop, session persistence, write approval, read-only denial');
} catch (error) {
  console.error(`✖ E2E failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
