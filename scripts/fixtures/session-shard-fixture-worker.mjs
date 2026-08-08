// Minimal session-shard stand-in for pool placement tests: acknowledges the
// shard IPC surface (create/call/snapshot/prewarm/workload/shutdown) without
// booting the real session runtime graph, so placement is observable fast.
process.on('message', (message) => {
  if (!message || typeof message !== 'object' || !message.requestId) return;
  process.send({
    type: 'response',
    requestId: message.requestId,
    ok: true,
    value: message.type === 'create' ? { created: true } : { ready: true },
  });
  if (message.type === 'shutdown') setImmediate(() => process.exit(0));
});
