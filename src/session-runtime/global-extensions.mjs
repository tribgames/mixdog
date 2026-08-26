// In-process fan-out for machine-global extension settings. The daemon hosts
// multiple session runtimes in one process; a write from one runtime must make
// every other live runtime reload the same Skills, Plugins, and MCP state.
const subscribers = new Map();
let nextSubscriberId = 0;

export function subscribeGlobalExtensionChanges(listener) {
  if (typeof listener !== 'function') throw new TypeError('global extension listener is required');
  const id = ++nextSubscriberId;
  subscribers.set(id, listener);
  return {
    id,
    unsubscribe() {
      subscribers.delete(id);
    },
  };
}

export async function publishGlobalExtensionChange(kind, originId = null) {
  const jobs = [];
  for (const [id, listener] of subscribers) {
    if (id === originId) continue;
    jobs.push(Promise.resolve().then(() => listener(kind)));
  }
  await Promise.allSettled(jobs);
}
