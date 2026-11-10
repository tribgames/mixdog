// A client the daemon's client grace dropped comes back on its own: the next
// stream attempt answers 404, the attachment pool re-registers, and its views
// recover with no failure surfaced. Real transport, real session client.
import assert from 'node:assert/strict';
import test from 'node:test';
import { attachSession } from './session-client.mjs';
import { SessionAttachmentPool } from './session-attachment-pool.mjs';
import { createSessionTransport } from './session-transport.mjs';

// No process owns this pid on any supported platform's default pid range.
const DEAD_PID = 4_000_000;

async function waitFor(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a client dropped by the client grace re-registers silently through the attachment pool', async (t) => {
  const registered = [];
  const dropped = [];
  const transport = createSessionTransport({
    handleCall: async () => ({}),
    onClientRegistered: (client) => registered.push(client.token),
    onClientDropped: (token, reason) => dropped.push({ token, reason }),
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  const handles = [];
  t.after(async () => {
    for (const handle of handles) await handle.close('test end').catch(() => {});
    await transport.stop();
  });
  const logs = [];
  const pool = new SessionAttachmentPool({
    ensureDaemon: async () => discovery,
    createProtocolClient: (raw) => raw,
    attachSession: async (options) => {
      // The first attachment names a lead that is gone and a short silence
      // deadline: its stream closes, and the daemon's grace drops the client
      // because its lead pid is dead.
      const first = handles.length === 0;
      const handle = await attachSession({
        ...options,
        readDiscovery: () => discovery,
        ...(first
          ? { leadPid: DEAD_PID, streamLivenessTimeoutMs: 50, streamReconnectBaseMs: 5, streamReconnectMaxMs: 5 }
          : {}),
      });
      handles.push(handle);
      return handle;
    },
  });
  const view = {
    detached: [],
    recovered: 0,
    sessionId: () => 'sess_regrace',
    applyFrame() {},
    applyGone() {},
    applyDetached(reason) {
      this.detached.push(reason);
    },
    async recover() {
      this.recovered += 1;
    },
  };
  pool.track(view);
  await pool.ensure({ cwd: process.cwd(), log: (line) => logs.push(line) });
  assert.equal(registered.length, 1);
  await waitFor(() => registered.length === 2 && view.recovered === 2, `no re-registration: ${logs.join(' | ')}`);
  assert.deepEqual(
    dropped.map((entry) => entry.reason),
    ['lead pid gone']
  );
  assert.equal(dropped[0].token, registered[0]);
  assert.notEqual(registered[1], registered[0], 'a fresh registration');
  assert.equal(view.detached.length, 1);
  assert.equal(
    logs.some((line) => /re-attach failed|recovery failed/.test(line)),
    false,
    logs.join('\n')
  );
});
