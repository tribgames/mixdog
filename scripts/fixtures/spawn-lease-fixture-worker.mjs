// Minimal shard stand-in for the machine spawn-budget protocol test. Replies
// ok to any requestId message (prewarm/shutdown) and drives the lease
// protocol on a fixed clock; grants are recorded as marker files so the test
// can observe ordering without extra IPC surface.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.env.SPAWN_LEASE_FIXTURE_DIR || process.cwd();
const record = (name) => {
  try { writeFileSync(join(outDir, name), String(Date.now())); } catch { /* test observes absence */ }
};

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'spawn-lease-result') {
    record(`${message.leaseId}-${message.ok === true ? 'granted' : 'rejected'}`);
    return;
  }
  if (message.requestId) {
    process.send({ type: 'response', requestId: message.requestId, ok: true, value: { ready: true } });
    if (message.type === 'shutdown') setImmediate(() => process.exit(0));
  }
});

process.send({ type: 'spawn-lease', leaseId: 'lease-a', lane: 'search', ownerKey: 'fixture-a' });
setTimeout(() => {
  process.send({ type: 'spawn-lease', leaseId: 'lease-b', lane: 'search', ownerKey: 'fixture-b' });
}, 150);
// Release A well after the test has observed that B stays queued behind the
// machine cap of 1.
setTimeout(() => {
  process.send({ type: 'spawn-release', leaseId: 'lease-a' });
}, 1_800);
