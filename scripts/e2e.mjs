#!/usr/bin/env node
/**
 * End-to-end smoke test against the mock APIs.
 *
 * Anthropic path: streaming text, the tool loop, session persistence,
 * auto-approved writes, and read-only denial.
 * Local path (OpenAI-compatible, Ollama template): model discovery,
 * streaming tool_calls, and the tool loop.
 *
 * Run with: npm run test:e2e   (builds first)
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const port = 8800 + Math.floor(Math.random() * 200);
const localPort = port + 500;
const home = await mkdtemp(join(tmpdir(), 'nelo-e2e-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'nelo-e2e-ws-'));
const readonlyWorkspace = await mkdtemp(join(tmpdir(), 'nelo-e2e-ro-'));
let mock = null;
let localMock = null;

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

function runCliWithInput(args, cwd, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'bin', 'nelo.js'), ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    child.stdin.end(input);
  });
}

async function cleanup() {
  if (mock && !mock.killed) mock.kill();
  if (localMock && !localMock.killed) localMock.kill();
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

  // 5. Local provider: OpenAI-compatible mock served through the Ollama template.
  localMock = spawn(process.execPath, ['scripts/mock-openai.mjs'], {
    cwd: root,
    env: { ...process.env, MOCK_PORT: String(localPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let localOutput = '';
  localMock.stdout.on('data', (chunk) => {
    localOutput += chunk;
  });
  localMock.stderr.on('data', (chunk) => {
    localOutput += chunk;
  });
  await waitFor(() => localOutput.includes('listening'), 8000, 'openai mock did not start');

  const localEnv = { ...env };
  delete localEnv.ANTHROPIC_API_KEY;
  delete localEnv.ANTHROPIC_BASE_URL;

  const localRun = await runCli(
    ['--provider', 'ollama', '--base-url', `http://127.0.0.1:${localPort}/v1`, 'hello local'],
    workspace,
    localEnv,
  );
  assert(localRun.code === 0, `local run exited with ${localRun.code}: ${localRun.stderr}`);
  assert(localRun.stdout.includes('mock local model'), 'local stdout is missing the final text');
  assert(localRun.stderr.includes('read_file'), 'local stderr is missing tool activity');

  // 6. Text-written tool calls are converted instead of being echoed.
  const textToolRun = await runCli(
    [
      '--provider',
      'ollama',
      '--base-url',
      `http://127.0.0.1:${localPort}/v1`,
      '-m',
      'mock-text-tools',
      'hello local',
    ],
    workspace,
    localEnv,
  );
  assert(textToolRun.code === 0, `text-tool run exited with ${textToolRun.code}: ${textToolRun.stderr}`);
  assert(!textToolRun.stdout.includes('<tool_call>'), 'the text tool call leaked into stdout');
  assert(textToolRun.stderr.includes('read_file'), 'the text tool call was not executed');

  // 7. Provider and theme listings work without a network or a key.
  const providersRun = await runCli(['providers'], workspace, localEnv);
  assert(providersRun.code === 0, 'providers command failed');
  assert(providersRun.stdout.includes('omniroute'), 'OmniRoute template is missing');
  assert(providersRun.stdout.includes('lmstudio'), 'LM Studio template is missing');

  const themesRun = await runCli(['themes'], workspace, localEnv);
  assert(themesRun.code === 0, 'themes command failed');
  assert(themesRun.stdout.includes('midnight'), 'built-in themes are missing');

  // 8. Interactive start succeeds without a usable provider and explains how to connect.
  const noProviderRun = await runCliWithInput(
    ['--no-tui', '--provider', 'anthropic'],
    workspace,
    localEnv,
    '/status\n/exit\n',
  );
  assert(
    noProviderRun.code === 0,
    `no-provider run exited with ${noProviderRun.code}: ${noProviderRun.stderr}`,
  );
  assert(
    noProviderRun.stdout.includes('not connected'),
    'the disconnected banner/status is missing',
  );
  assert(
    noProviderRun.stdout.includes('/provider'),
    'the connect hint is missing',
  );
  assert(
    noProviderRun.stdout.includes('requires an API key'),
    'the provider configuration error is missing',
  );

  console.log('✔ E2E passed: tool loop, session persistence, write approval, read-only denial, local provider, text tool calls, disconnected startup');
} catch (error) {
  console.error(`✖ E2E failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
