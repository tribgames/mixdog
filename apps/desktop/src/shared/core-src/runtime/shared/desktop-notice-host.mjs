const KEY = Symbol.for('mixdog.desktopNoticeHost.v1');
/** Undelivered notices kept; the oldest go first. */
const PENDING_LIMIT = 20;

function registry() {
  globalThis[KEY] ??= { raised: new Set(), sinks: [], pending: [], raise: null };
  return globalThis[KEY];
}

/** Whether some sink took `notice`: a sink returns false when nobody was
 *  there to receive it. `replay`: it was offered before and waited. */
function offer(host, notice, replay = false) {
  let delivered = false;
  for (const { sink } of host.sinks) {
    try {
      if (sink(notice, replay) !== false) delivered = true;
    } catch {}
  }
  return delivered;
}

function hold(host, notice) {
  host.pending = host.pending.filter((held) => held.key !== notice.key);
  host.pending.push(notice);
  if (host.pending.length > PENDING_LIMIT) host.pending.shift();
}

/** Raise notice `code` (with string `params`) under `key`. False when that
 *  key is already raised. */
export function raiseDesktopNotice(key, code, params = {}) {
  const host = registry();
  const id = String(key || '');
  if (!id || !code || host.raised.has(id)) return false;
  host.raised.add(id);
  const notice = {
    key: id,
    code: String(code),
    params: Object.fromEntries(Object.entries(params || {}).map(([name, value]) => [name, String(value ?? '')])),
  };
  if (!offer(host, notice)) hold(host, notice);
  return true;
}

/** The condition behind `key` is over: the next raise shows again. */
export function clearDesktopNotice(key) {
  const host = registry();
  const id = String(key || '');
  if (!host.raised.delete(id)) return;
  host.pending = host.pending.filter((notice) => notice.key !== id);
}

/** Offer every waiting notice again (a client just attached); the ones still
 *  undelivered keep waiting. */
export function deliverPendingDesktopNotices() {
  const host = registry();
  const pending = host.pending;
  host.pending = [];
  for (const notice of pending) if (!offer(host, notice, true)) hold(host, notice);
}

/** `sink(notice, replay)` receives every notice from now on, the waiting ones
 *  first (`replay` true); it returns false when it had nobody to deliver to.
 *  Returns the unregister. */
export function registerDesktopNoticeSink(sink) {
  const host = registry();
  const entry = { sink };
  host.sinks.push(entry);
  deliverPendingDesktopNotices();
  return () => {
    const index = host.sinks.indexOf(entry);
    if (index >= 0) host.sinks.splice(index, 1);
  };
}

registry().raise = raiseDesktopNotice;
