// Node's runtime notifications for the TUI session view over the Rust core.
//
// Node's TUI subscribes to the runtime's notification bus (`emitRuntimeNotification`,
// `session-runtime/notification-bus.mjs`) through `runtime.onNotification` (`tui/session/agent-job-feed.mjs`
// `subscribeRuntimeNotifications`). The one notification the daemon itself emits there is the updater's
// `update-notice` (`session-runtime/self-update.mjs`, a staged version waits for a restart), which the TUI turns into
// the status notice `mixdog v<ver> ready — restart to apply.` (`tui/session/notification-plan.mjs`).
//
// The Rust core has no such bus. It raises that condition as an entry of the app feed's `notice` section
// (`notice/updated`, key `update-ready`, protocol.md §6.2 "notices"); every protocol client holds the app feed in its
// store (`client.store.sections('notice')`), so the TUI reads it there and hands the listeners the event the bus would.
// The desktop's own notice reader ignores codes it does not know.

export const UPDATE_READY_CODE = 'update-ready';

/** The runtime-notification event of Node's `emitToListeners` for the `update-notice` of `version`. */
export function updateNoticeEvent(version) {
  return { content: 'update ready', meta: { kind: 'update-notice', version, tone: 'info' } };
}

/**
 * `store` is the client's section store (`sections(name)`); `log` writes a diagnostic line. A listener is handed each
 * standing `update-ready` notice once, when it subscribes or when the entry first appears or changes.
 */
export function createRuntimeNotifications({ store, log }) {
  const listeners = new Map();

  function deliver() {
    for (const entry of store.sections('notice')) {
      const notice = entry.value;
      if (!notice || notice.code !== UPDATE_READY_CODE) continue;
      const version = String(notice.params?.version ?? '');
      const stamp = `${entry.key}:${version}`;
      for (const [listener, delivered] of [...listeners]) {
        if (delivered.has(stamp)) continue;
        delivered.add(stamp);
        try {
          listener(updateNoticeEvent(version));
        } catch (error) {
          log(`runtime notification listener threw: ${error?.message || error}`);
        }
      }
    }
  }

  return {
    /** A change of the client's store. */
    onChange(change) {
      if ((change.type === 'section' && change.section === 'notice') || change.type === 'appSnapshot') deliver();
    },
    /** `runtime.onNotification(listener)`: the unsubscribe, or null for a listener that is not a function. */
    onNotification(listener) {
      if (typeof listener !== 'function') return null;
      listeners.set(listener, new Set());
      deliver();
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    },
  };
}