import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createChannelTransport } from './channel-transport.mjs';

// Regression: the daemon builds this transport before it publishes its session
// endpoint, and an unreadable pin used to throw out of boot ("fatal boot
// error", exit 2) on every spawn.
test('an unreadable remote intent starts the channel transport unpinned and keeps the file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-channel-intent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const intentPath = join(dir, 'channel-remote-intent.json');
  // A directory reads as EISDIR: the same non-ENOENT failure an ACL or an
  // antivirus lock produces.
  mkdirSync(intentPath);
  const logs = [];
  const transport = createChannelTransport({
    handleCall: async () => ({}),
    remoteIntentPath: intentPath,
    log: (line) => logs.push(line),
  });
  t.after(() => transport.stop());
  assert.equal(transport.remoteIntentSessionId, null);
  assert.ok(
    logs.some((line) => line.startsWith('channel remote intent unreadable, starting unpinned: ')),
    logs.join('\n')
  );
  assert.ok(statSync(intentPath).isDirectory());
  const endpoint = await transport.start();
  assert.ok(endpoint.port > 0);
});
