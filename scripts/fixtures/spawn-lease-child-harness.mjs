// Child-side gate harness: runs child-spawn-gate acquire() in shard mode so a
// forked test parent can play the pool's role in the lease protocol.
const { acquire } = await import(new URL('../../src/runtime/shared/child-spawn-gate.mjs', import.meta.url));
const release = await acquire(null, 'search', { ownerKey: 'harness' });
process.send({ type: 'harness-event', event: 'granted' });
release();
process.send({ type: 'harness-event', event: 'released' });
setTimeout(() => process.exit(0), 200);
