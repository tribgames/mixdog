// The channels worker's config hot reload (schedules, webhooks, events, voice).
// It rides the shared config-change subscription: that watches the data
// directory, so the atomic rename of every write never orphans it, it recovers
// from watcher errors, and it carries in-process writes and keychain changes.
// A reload restarts the webhook server and hook tunnel, so only a change of
// the sections the worker reads (channels: webhook, events, …; voice) reloads;
// schedules arrive through the reload_config IPC, never through this watch.
import { readSection, subscribeConfigChange } from '../../shared/config.mjs';

function channelsConfigSnapshot() {
  return JSON.stringify([readSection('channels') ?? null, readSection('voice') ?? null]);
}

export function createConfigReloadWatch(reload, { snapshot = channelsConfigSnapshot } = {}) {
  let unsubscribe = null;
  let applied = null;
  const read = () => {
    try {
      return snapshot();
    } catch {
      return null;
    }
  };
  return {
    start() {
      if (unsubscribe) return;
      applied = read();
      unsubscribe = subscribeConfigChange(() => {
        const next = read();
        if (next !== null && next === applied) return;
        applied = next;
        Promise.resolve()
          .then(reload)
          .catch(() => {});
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
