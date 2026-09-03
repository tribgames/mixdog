import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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

function writeIntent(path, {
  sessionId = 'session_restart',
  cwd = process.cwd(),
} = {}) {
  const transcriptPath = join(tmpdir(), `${sessionId}.jsonl`);
  writeFileSync(path, JSON.stringify({
    version: 1,
    sessionId,
    transcriptPath,
    cwd,
    updatedAt: Date.now(),
  }));
  return transcriptPath;
}

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
      /daemon is draining/,
    );
    assert.equal(calls.filter((call) => call.name === 'must_not_run').length, 0);
  } finally {
    await transport.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
