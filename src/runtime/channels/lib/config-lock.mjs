let pending = Promise.resolve();
function withConfigLock(fn) {
  const next = pending.then(() => fn());
  pending = next.then(() => {
  }, (e) => {
    process.stderr.write(`[config-lock] Error: ${e}
`);
  });
  return next;
}
export {
  withConfigLock
};
