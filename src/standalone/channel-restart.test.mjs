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

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function writeIntent(path, {
  sessionId = 'session_restart',
  ownerLeadPid = 2_147_483_000,
  cwd = process.cwd(),
} = {}) {
  const transcriptPath = join(tmpdir(), `${sessionId}.jsonl`);
  writeFileSync(path, JSON.stringify({
    version: 1,
    sessionId,
    transcriptPath,
    ownerLeadPid,
    cwd,
    updatedAt: Date.now(),
  }));
  return transcriptPath;
}

test('dead owner restores only to the same session pin and adopts the new PID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-restart-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  const transcriptPath = writeIntent(intentPath);
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
    await post(endpoint, '/client/register', {
      leadPid: process.pid,
      cwd: process.cwd(),
      passive: true,
      restoreSessionId: 'session_restart',
    });
    await waitFor(() => calls.length === 1, 'session-pinned remote restore');
    assert.deepEqual(calls[0], {
      name: 'activate_channel_bridge',
      args: {
        active: true,
        sessionId: 'session_restart',
        transcriptPath,
        restore: true,
      },
    });
    assert.equal(transport._remoteIntentForTest.ownerLeadPid, process.pid);
    assert.equal(JSON.parse(readFileSync(intentPath, 'utf8')).ownerLeadPid, process.pid);
  } finally {
    await transport.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart restore rejects a different session or cwd', async () => {
  for (const registration of [
    { restoreSessionId: 'session_other', cwd: process.cwd() },
    { restoreSessionId: 'session_restart', cwd: join(process.cwd(), 'other') },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-restart-reject-'));
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
      await post(endpoint, '/client/register', {
        leadPid: process.pid,
        passive: true,
        ...registration,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(calls.length, 0);
      assert.equal(transport._pointerTokenForTest, null);
    } finally {
      await transport.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('daemon replacement drain preserves the session intent without deactivating it', async () => {
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
    assert.equal(JSON.parse(readFileSync(intentPath, 'utf8')).sessionId, 'session_drain');
    assert.equal(calls.filter((call) => call.args?.active === false).length, 0);
  } finally {
    await transport.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
