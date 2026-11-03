// Counter of this process's own changes to what the agent config is built
// from: config and secret writes, a provider-account selection, an auth
// binding. The config snapshot compares it on every read (no I/O), so a change
// made here is visible to the very next read. Dependency-free so the writers
// can import it without a cycle through shared/config.mjs.
let epoch = 0;

export function configInputEpoch() {
  return epoch;
}

export function bumpConfigInputEpoch() {
  epoch += 1;
}
