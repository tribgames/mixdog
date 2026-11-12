import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createChannelTransport } from './channel-transport.mjs';

async function post(endpoint, path, body) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mixdog-daemon-token': endpoint.token,
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
  return value;
}

function writeIntent(path, { sessionId = 'session_restart', cwd = process.cwd() } = {}) {
  const transcriptPath = join(tmpdir(), `${sessionId}.jsonl`);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      sessionId,
      transcriptPath,
      cwd,
      updatedAt: Date.now(),
    })
  );
  return transcriptPath;
}

test('restored binding and manual ON share one ordered binding lifetime', { timeout: 5000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-binding-order-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  writeIntent(intentPath);
  let releaseRestore;
  const restored = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  let enterRestore;
  const entered = new Promise((resolve) => {
    enterRestore = resolve;
  });
  let releaseManual;
  const manuallyActivated = new Promise((resolve) => {
    releaseManual = resolve;
  });
  let activeBinding = null;
  const transport = createChannelTransport({
    remoteIntentPath: intentPath,
    handleCall: async (_name, args) => {
      if (args.restore) {
        enterRestore();
        await restored;
      } else await manuallyActivated;
      activeBinding = args.sessionId;
      return { ok: true };
    },
  });
  t.after(async () => {
    releaseRestore();
    releaseManual();
    await transport.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const endpoint = await transport.start();
  const client = await post(endpoint, '/client/register', { leadPid: process.pid, passive: true });
  const restoring = transport.restoreRemoteIntent();
  await entered;
  const manual = post(endpoint, '/call', {
    token: client.token,
    name: 'activate_channel_bridge',
    args: { active: true, sessionId: 'session_manual', transcriptPath: join(dir, 'session_manual.jsonl') },
  });
  // Wait for the request to enter the transport's active lane, not a wall-clock
  // guess about when the HTTP request will arrive.
  while (transport.activeCount === 0) {
    t.signal.throwIfAborted();
    await setImmediate();
  }
  releaseManual();
  await setImmediate();
  releaseRestore();
  await Promise.all([restoring, manual]);
  assert.equal(activeBinding, 'session_manual');
  assert.equal(transport.remoteSessionId, 'session_manual');
});

test('channel retries reuse results only for the same payload', async (t) => {
  let calls = 0;
  const transport = createChannelTransport({ handleCall: async () => ({ call: ++calls }) });
  t.after(() => transport.stop());
  const endpoint = await transport.start();
  const client = await post(endpoint, '/client/register', { leadPid: process.pid, passive: true });
  const original = { token: client.token, callId: 'same-call', name: 'send_reply', args: { text: 'first' } };
  assert.deepEqual(await post(endpoint, '/call', original), { result: { call: 1 } });
  assert.deepEqual(await post(endpoint, '/call', original), { result: { call: 1 } });
  const conflict = await post(endpoint, '/call', { ...original, args: { text: 'second' } });
  assert.equal(conflict.code, 'ECALLIDCONFLICT');
  assert.match(conflict.error, /reused with a different payload/);
  assert.equal(calls, 1);
});

test('channel call ids belong to the calling process, not the addressed session', async (t) => {
  let calls = 0;
  const transport = createChannelTransport({ handleCall: async () => ({ call: ++calls }) });
  t.after(() => transport.stop());
  const endpoint = await transport.start();
  const first = await post(endpoint, '/client/register', { leadPid: process.pid, passive: true });
  const second = await post(endpoint, '/client/register', { leadPid: process.ppid, passive: true });
  const payload = { callId: 'shared-id', name: 'send_reply', args: { sessionId: 'same_session', text: 'hello' } };
  await post(endpoint, '/call', { ...payload, token: first.token });
  const reply = await post(endpoint, '/call', { ...payload, token: second.token });
  assert.deepEqual(reply, { result: { call: 2 } });
});

test('daemon boot restores the pinned session without a registered client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-restart-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  const statePath = join(dir, 'channel-remote-state.json');
  const transcriptPath = writeIntent(intentPath);
  const calls = [];
  let transport;
  transport = createChannelTransport({
    remoteIntentPath: intentPath,
    remoteStatePath: statePath,
    handleCall: async (name, args) => {
      calls.push({ name, args });
      return { ok: true };
    },
  });
  await transport.start();
  try {
    assert.equal(transport.remoteIntentSessionId, 'session_restart');
    assert.equal(transport.remoteSessionId, null);
    assert.equal(await transport.restoreRemoteIntent(), true);
    assert.deepEqual(calls[0], {
      name: 'activate_channel_bridge',
      args: {
        active: true,
        sessionId: 'session_restart',
        transcriptPath,
        restore: true,
      },
    });
    assert.equal(transport.remoteSessionId, 'session_restart');
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(intentPath, 'utf8')), 'ownerLeadPid'), false);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).enabled, true);
  } finally {
    await transport.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client registration cannot select or replace the pinned session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-session-pin-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  writeIntent(intentPath);
  const calls = [];
  const transport = createChannelTransport({
    remoteIntentPath: intentPath,
    handleCall: async (name, args) => {
      calls.push({ name, args });
      return { ok: true };
    },
  });
  const endpoint = await transport.start();
  try {
    assert.equal(await transport.restoreRemoteIntent(), true);
    await post(endpoint, '/client/register', {
      leadPid: process.pid,
      cwd: join(process.cwd(), 'other'),
      passive: true,
      restoreSessionId: 'session_other',
    });
    assert.equal(calls.length, 1);
    assert.equal(transport.remoteSessionId, 'session_restart');
    assert.equal(transport._pointerTokenForTest, null);
  } finally {
    await transport.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon replacement keeps compatible channel clients live until handoff commits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-drain-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  const transcriptPath = join(dir, 'session_drain.jsonl');
  const calls = [];
  let transport;
  transport = createChannelTransport({
    remoteIntentPath: intentPath,
    handleCall: async (name, args) => {
      calls.push({ name, args });
      if (name === 'activate_channel_bridge' && args.active === true) {
        transport.notify('notifications/mixdog/remote', { state: 'acquired' });
      }
      return { ok: true };
    },
  });
  const endpoint = await transport.start();
  try {
    const registered = await post(endpoint, '/client/register', {
      leadPid: process.pid,
      cwd: process.cwd(),
      passive: true,
      restoreSessionId: 'session_drain',
    });
    await post(endpoint, '/call', {
      token: registered.token,
      name: 'activate_channel_bridge',
      args: {
        active: true,
        sessionId: 'session_drain',
        transcriptPath,
      },
    });
    assert.equal(transport.beginDrain('daemon replacement'), true);
    await post(endpoint, '/call', {
      token: registered.token,
      name: 'read_channel_state',
      args: { sessionId: 'session_drain' },
    });
    const compatibleNewcomer = await post(endpoint, '/client/register', {
      leadPid: process.pid,
      cwd: process.cwd(),
      passive: true,
      restoreSessionId: 'session_drain',
    });
    assert.ok(compatibleNewcomer.token);
    assert.equal(transport.clientCount, 2);
    assert.equal(JSON.parse(readFileSync(intentPath, 'utf8')).sessionId, 'session_drain');
    assert.equal(calls.filter((call) => call.args?.active === false).length, 0);
    assert.equal(transport.commitDrain('daemon replacement commit'), true);
    await assert.rejects(
      post(endpoint, '/call', {
        token: registered.token,
        name: 'must_not_run',
        args: { sessionId: 'session_drain' },
      }),
      /daemon is draining/
    );
    assert.equal(calls.filter((call) => call.name === 'must_not_run').length, 0);
  } finally {
    await transport.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Remote ON survives a hard kill: the replacement restores the same session by itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-crash-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  const transcriptPath = join(dir, 'session_crash.jsonl');
  const first = createChannelTransport({ remoteIntentPath: intentPath, handleCall: async () => ({ ok: true }) });
  const endpoint = await first.start();
  const client = await post(endpoint, '/client/register', { leadPid: process.pid, cwd: dir, passive: true });
  await post(endpoint, '/call', {
    token: client.token,
    name: 'activate_channel_bridge',
    args: { active: true, sessionId: 'session_crash', transcriptPath },
  });
  // No stop(): a hard kill leaves only what is already on disk. The first
  // transport is torn down after the replacement is checked.
  const calls = [];
  const replacement = createChannelTransport({
    remoteIntentPath: intentPath,
    handleCall: async (name, args) => {
      calls.push({ name, args });
      return { ok: true };
    },
  });
  try {
    assert.equal(replacement.remoteIntentSessionId, 'session_crash');
    assert.equal(await replacement.restoreRemoteIntent(), true);
    assert.equal(replacement.remoteSessionId, 'session_crash');
    assert.equal(calls[0].args.transcriptPath, transcriptPath);
  } finally {
    await replacement.stop();
    await first.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Remote OFF stays OFF across a replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-off-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  const transcriptPath = join(dir, 'session_off.jsonl');
  const first = createChannelTransport({ remoteIntentPath: intentPath, handleCall: async () => ({ ok: true }) });
  const endpoint = await first.start();
  const client = await post(endpoint, '/client/register', { leadPid: process.pid, cwd: dir, passive: true });
  const args = { sessionId: 'session_off', transcriptPath };
  await post(endpoint, '/call', { token: client.token, name: 'activate_channel_bridge', args: { active: true, ...args } });
  await post(endpoint, '/call', { token: client.token, name: 'activate_channel_bridge', args: { active: false, ...args } });
  const calls = [];
  const replacement = createChannelTransport({
    remoteIntentPath: intentPath,
    handleCall: async (name) => calls.push(name),
  });
  try {
    assert.equal(replacement.remoteIntentSessionId, null);
    assert.equal(await replacement.restoreRemoteIntent(), false);
    assert.equal(replacement.remoteSessionId, null);
    assert.equal(calls.length, 0);
  } finally {
    await replacement.stop();
    await first.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restore whose session is gone declines once and drops the pin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-gone-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  writeIntent(intentPath, { sessionId: 'session_gone' });
  const calls = [];
  const transport = createChannelTransport({
    remoteIntentPath: intentPath,
    isSessionAvailable: () => false,
    handleCall: async (name) => calls.push(name),
  });
  try {
    assert.equal(await transport.restoreRemoteIntent(), false);
    assert.equal(calls.length, 0);
    assert.equal(transport.remoteSessionId, null);
    assert.equal(createChannelTransport({ remoteIntentPath: intentPath, handleCall: async () => ({}) }).remoteIntentSessionId, null);
  } finally {
    await transport.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
