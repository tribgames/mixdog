// Characterization of the standalone memory-runtime proxy against a fake
// daemon entry: fork + ready wait + advert discovery, client registration,
// tool RPC wire shape, abort/cancel, transparent respawn after the daemon
// dies, deterministic startup-crash caching, and stop/deregister.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { sleep } from '../runtime/shared/sleep.mjs';
import { projectSessionMessagesForIngest } from '../runtime/memory/lib/session-ingest.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-memproxy-'));
const runtimeRoot = join(root, 'runtime');
const dataDir = join(root, 'data');
const entry = join(root, 'fake-memory-daemon.mjs');
const previousRuntimeRoot = process.env.MIXDOG_RUNTIME_ROOT;
process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
mkdirSync(dataDir, { recursive: true });

const discoveryUrl = new URL('../runtime/shared/service-discovery.mjs', import.meta.url).href;
writeFileSync(
  entry,
  `import http from 'node:http';
import { writeServiceAdvert } from ${JSON.stringify(discoveryUrl)};
const state = { registers: 0, cancels: [], clients: new Set() };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const parsed = body ? JSON.parse(body) : null;
    switch (req.url) {
      case '/health': return json(200, { status: 'ok' });
      case '/debug/state': return json(200, { registers: state.registers, cancels: state.cancels, pid: process.pid });
      case '/client/register': state.registers += 1; state.clients.add(parsed.clientPid); return json(200, { ok: true });
      case '/client/deregister':
        state.clients.delete(parsed.clientPid);
        json(200, { ok: true });
        if (state.clients.size === 0) setTimeout(() => process.exit(0), 50);
        return;
      case '/api/cancel': state.cancels.push(parsed.callId); return json(200, { ok: true });
      case '/api/tool':
        if (parsed.name === 'fail') return json(500, { error: 'boom' });
        if (parsed.name === 'slow') { setTimeout(() => json(200, { late: true }), 5000); return; }
        return json(200, { echo: parsed, callId: req.headers['x-mixdog-call-id'] || null, registers: state.registers });
      case '/session-start/core-memory': return json(200, { core: parsed });
      case '/entry': return json(200, { entry: parsed });
      default: return json(404, { error: 'unknown ' + req.url });
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  writeServiceAdvert('memory', { port, pid: process.pid });
  process.send?.({ ready: true, port });
});
`
);

const { getStandaloneMemoryRuntime, stopStandaloneMemoryRuntimesForProcess } = await import(
  './memory-runtime-proxy.mjs'
);
const runtime = getStandaloneMemoryRuntime({ entry, dataDir, cwd: root });

function daemonState(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: '/debug/state' }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(JSON.parse(data)));
      })
      .on('error', reject);
  });
}

async function waitFor(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function ownerPid() {
  try {
    return Number(JSON.parse(readFileSync(join(dataDir, 'memory-runtime-owner.json'), 'utf8'))?.pid) || null;
  } catch {
    return null;
  }
}

test.after(async () => {
  await stopStandaloneMemoryRuntimesForProcess().catch(() => {});
  const pid = ownerPid();
  if (pid && pid !== process.pid && isPidAlive(pid)) {
    try {
      process.kill(pid);
    } catch {}
  }
  if (previousRuntimeRoot === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
  else process.env.MIXDOG_RUNTIME_ROOT = previousRuntimeRoot;
  rmSync(root, { recursive: true, force: true });
});

test('start forks the daemon, hands the singleton owner to it, and status reports the live port', async () => {
  const started = await runtime.start();
  assert.equal(started.running, true);
  assert.equal(started.mode, 'http-proxy');
  assert.ok(Number.isInteger(started.port) && started.port > 0);
  assert.equal(runtime.moduleUrl, pathToFileURL(entry).href);

  const status = await runtime.status();
  assert.deepEqual(status, {
    running: true,
    port: started.port,
    mode: 'http-proxy',
    ownerPid: ownerPid(),
    ownerAlive: true,
  });
  assert.notEqual(status.ownerPid, process.pid, 'the owner claim moved from the launcher to the daemon child');
  assert.equal((await daemonState(started.port)).pid, status.ownerPid);

  const again = await runtime.start();
  assert.equal(again.port, started.port, 'a live daemon is reused, not re-forked');
});

test('handleToolCall registers the client once and posts the tool RPC with a call-id header', async () => {
  const first = await runtime.handleToolCall('recall', { query: 'alpha' });
  assert.deepEqual(first.echo, { name: 'recall', arguments: { query: 'alpha' } });
  assert.match(first.callId, new RegExp(`^mem_${process.pid}_\\d+$`));
  assert.equal(first.registers, 1);

  const second = await runtime.handleToolCall('memory', { action: 'status' });
  assert.equal(second.registers, 1, 'an already-registered client does not re-register');
  assert.notEqual(second.callId, first.callId);

  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ];
  const ingest = await runtime.handleToolCall('memory', { action: 'ingest_session', messages });
  assert.deepEqual(ingest.echo.arguments.messages, projectSessionMessagesForIngest(messages));
});

test('appendEntry, buildSessionCoreMemoryPayload and ingestTranscript hit their daemon routes', async () => {
  assert.deepEqual(await runtime.appendEntry({ kind: 'note', text: 'x' }), { entry: { kind: 'note', text: 'x' } });
  assert.deepEqual(await runtime.buildSessionCoreMemoryPayload('/elsewhere'), { core: { cwd: '/elsewhere' } });
  assert.deepEqual(await runtime.buildSessionCoreMemoryPayload(), { core: { cwd: root } });
  await assert.rejects(runtime.ingestTranscript('/no/such.jsonl', { cwd: '/w' }), /unknown \/ingest-transcript/);
});

test('a daemon-side HTTP error surfaces as an Error carrying the status code', async () => {
  await assert.rejects(runtime.handleToolCall('fail', {}), (err) => {
    assert.equal(err.message, 'boom');
    assert.equal(err.statusCode, 500);
    return true;
  });
});

test('an aborted call rejects with AbortError and cancels the in-flight remote call', async () => {
  const preAborted = AbortSignal.abort('already gone');
  await assert.rejects(runtime.handleToolCall('recall', {}, { signal: preAborted }), (err) => {
    assert.equal(err.name, 'AbortError');
    assert.equal(err.message, 'already gone');
    return true;
  });

  const controller = new AbortController();
  const pending = runtime.handleToolCall('slow', {}, controller.signal);
  await sleep(300);
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  const { port } = await runtime.status();
  await waitFor(async () => (await daemonState(port)).cancels.length === 1, { label: 'remote cancel' });
  assert.match((await daemonState(port)).cancels[0], new RegExp(`^mem_${process.pid}_\\d+$`));
});

test('a daemon that dies underneath the proxy is respawned transparently on the next call', async () => {
  const before = await runtime.status();
  process.kill(before.ownerPid);
  await waitFor(() => !isPidAlive(before.ownerPid), { label: 'daemon exit' });
  const result = await runtime.handleToolCall('recall', { query: 'after-crash' });
  assert.equal(result.registers, 1, 'the client re-registers with the fresh daemon');
  const after = await runtime.status();
  assert.equal(after.running, true);
  assert.notEqual(after.ownerPid, before.ownerPid);
});

test('stop deregisters the client, waits for the daemon exit and leaves status not running', async () => {
  assert.equal(await runtime.stop({ waitForExit: true, timeoutMs: 5000 }), true);
  const status = await runtime.status();
  assert.equal(status.running, false);
  assert.equal(status.port, null);
  assert.equal(status.ownerAlive, false);
});

test('a deterministic startup crash is cached and re-thrown without re-forking', async () => {
  const crashEntry = join(root, 'crashing-daemon.mjs');
  writeFileSync(crashEntry, "import './does-not-exist.mjs';\n");
  const crashDir = join(root, 'data-crash');
  mkdirSync(crashDir, { recursive: true });
  const crashing = getStandaloneMemoryRuntime({ entry: crashEntry, dataDir: crashDir, cwd: root });
  let firstMessage = '';
  await assert.rejects(crashing.start(), (err) => {
    firstMessage = err.message;
    assert.match(err.message, /memory worker exited before ready/);
    assert.match(err.stderrTail, /ERR_MODULE_NOT_FOUND|Cannot find module/);
    return true;
  });
  await assert.rejects(crashing.start(), (err) => err.message === firstMessage);
  await assert.rejects(crashing.handleToolCall('recall', {}), (err) => err.message === firstMessage);
});
