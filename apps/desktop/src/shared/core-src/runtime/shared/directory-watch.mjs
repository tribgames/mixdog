// One `fs.watch` per directory for the whole process, shared by every
// subscriber that follows entries in it and closed with the last of them. An
// event goes only to the subscribers of the entry it names: one map lookup,
// so a busy directory costs its unrelated events nothing past the native
// delivery. An event without a name (Node does not promise one) goes to every
// subscriber of the directory.
//
// A watch follows the directory it opened, not its path: renamed away, or
// deleted and recreated, it hears nothing more. A subscriber that must hear
// that (`replace`) has the directory's name followed in its parent — one
// shared watch there too, which itself follows no parent. A rename naming
// the directory moves the watch onto the live one and tells every subscriber
// an unnamed event; a directory gone by then ends the watch, as does the
// directory's own deletion where the watch reports it. A parent's watch that
// ends leaves its child untrusted until that parent is watched again — by
// anyone, or on an event naming it in the nearest ancestor that can be
// watched — when the child follows it again, moves its own watch onto the
// live directory (a replacement may have gone unheard) and is trusted again.
import fs from 'node:fs';
import { basename, dirname } from 'node:path';
import { writeStderrBestEffort } from './best-effort-stderr.mjs';

// dir -> { dir, removedName, watcher, subscribers, byName, parent, replacing, waiter }
//
// Callbacks run while holders come and go (a recovery, a watch that ends):
// whoever opens or keeps a watch holds it before any callback can run, and
// lets the old one go only after, so a watch never drops to no holder in
// between; a subscriber hears nothing until its subscription is returned.
const watched = new Map();
// parent dir -> states whose watch of that parent ended, followed again
// once it is watched again.
const orphans = new Map();

const isMissing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

function closeQuietly(watcher) {
  try {
    watcher?.close();
  } catch {}
}

function deliver(state, event, name) {
  const subscribers = name ? state.byName.get(name) : state.subscribers;
  if (subscribers === undefined) {
    // Windows names the watched directory itself, by its full path, once it
    // is deleted, and repeats that without pause while the watch stays open.
    if (name === state.removedName)
      end(state, Object.assign(new Error(`${state.dir} was removed`), { code: 'ENOENT' }));
    return;
  }
  for (const subscriber of [...subscribers]) {
    if (!subscriber.closed && !subscriber.joining) subscriber.onEvent(event, name || null);
  }
}

// Throws what `fs.watch` throws.
function startWatch(state) {
  const watcher = fs.watch(state.dir, { persistent: false }, (event, name) => deliver(state, event, name));
  const lost = (error) => {
    if (state.watcher === watcher) end(state, error);
  };
  watcher.on('error', lost);
  watcher.on('close', () => lost(new Error('watch closed')));
  return watcher;
}

// The watch ended on its own: every subscriber hears it and is closed. The
// parent's watch is released last, so a subscriber that moves there keeps it.
function end(state, error) {
  if (watched.get(state.dir) === state) watched.delete(state.dir);
  const watcher = state.watcher;
  state.watcher = null;
  closeQuietly(watcher);
  const subscribers = [...state.subscribers];
  state.subscribers.clear();
  state.byName.clear();
  for (const subscriber of subscribers) {
    subscriber.closed = true;
    // One still joining is told by watchDirectory throwing this.
    if (subscriber.joining) subscriber.lostError = error;
    else subscriber.onLost?.(error);
  }
  state.parent?.close();
  state.parent = null;
  forgetOrphan(state);
}

function replaced(state) {
  const previous = state.watcher;
  state.watcher = null;
  closeQuietly(previous);
  try {
    state.watcher = startWatch(state);
  } catch (error) {
    end(state, error);
    return;
  }
  deliver(state, 'rename', null);
}

const told = (subscriber) => subscriber.replace && !subscriber.closed && !subscriber.joining;

function distrust(state, error) {
  if (error && !isMissing(error)) {
    writeStderrBestEffort(`[watch] lost the watch on the parent of ${state.dir}: ${error.message || error}\n`);
  }
  for (const subscriber of [...state.subscribers]) {
    if (told(subscriber)) subscriber.onDistrust?.();
  }
}

function followParent(state) {
  const parent = dirname(state.dir);
  // A root is never replaced.
  if (parent === state.dir) return;
  try {
    state.parent = watchDirectory(parent, [basename(state.dir)], {
      // 'change' is the directory's own metadata (a write inside it).
      onEvent: (event) => {
        if (event === 'rename') replaced(state);
      },
      onLost: (error) => {
        state.parent = null;
        distrust(state, error);
        awaitParent(state);
      },
    });
  } catch (error) {
    distrust(state, error);
    awaitParent(state);
  }
}

// `state`'s parent cannot be watched now: it is followed again when the
// parent is watched again (watchDirectory) or named in the nearest ancestor
// above it that can be watched.
function awaitParent(state) {
  const parent = dirname(state.dir);
  let waiting = orphans.get(parent);
  if (!waiting) {
    waiting = new Set();
    orphans.set(parent, waiting);
  }
  waiting.add(state);
  waitAbove(state, parent);
}

function waitAbove(state, failed) {
  for (let step = failed; dirname(step) !== step; step = dirname(step)) {
    try {
      const waiter = watchDirectory(dirname(step), [basename(step)], {
        onEvent: () => {
          if (state.waiter === waiter) refollow(state);
        },
        onLost: () => {
          if (state.waiter !== waiter) return;
          state.waiter = null;
          waitAbove(state, dirname(step));
        },
      });
      state.waiter = waiter;
      return;
    } catch {}
  }
}

// No longer waiting for its parent; returns the waiter, for the caller to close.
function leaveOrphans(state) {
  const parent = dirname(state.dir);
  const waiting = orphans.get(parent);
  waiting?.delete(state);
  if (waiting?.size === 0) orphans.delete(parent);
  const waiter = state.waiter;
  state.waiter = null;
  return waiter;
}

function forgetOrphan(state) {
  leaveOrphans(state)?.close();
}

// The parent may be watched again: follow it, and if that holds, move the
// watch onto the live directory (an unnamed event to every subscriber) and
// tell the subscribers that need it that a replacement is heard again. The
// waiter is let go last: a parent that still cannot be watched has its new
// waiter on the same ancestor watch by then.
function refollow(state) {
  const waiter = leaveOrphans(state);
  if (watched.get(state.dir) === state && state.replacing > 0 && !state.parent) {
    followParent(state);
    if (state.parent) {
      replaced(state);
      if (watched.get(state.dir) === state) {
        for (const subscriber of [...state.subscribers]) {
          if (told(subscriber)) subscriber.onTrust?.();
        }
      }
    }
  }
  waiter?.close();
}

function release(state) {
  if (state.replacing === 0 && state.parent) {
    state.parent.close();
    state.parent = null;
  }
  if (state.replacing === 0) forgetOrphan(state);
  if (state.subscribers.size > 0 || watched.get(state.dir) !== state) return;
  watched.delete(state.dir);
  const watcher = state.watcher;
  state.watcher = null;
  closeQuietly(watcher);
}

/**
 * Follows the entries `names` of `dir`: `onEvent(event, name)` hears every
 * event naming one of them, and every one with no name (`name` null: anything
 * in `dir` may have changed, also what a replacement delivers). `onLost(error)`
 * hears the watch end on its own — an error, a close, or `dir` gone after a
 * replacement (ENOENT) — and the subscription is closed with it. `replace`:
 * a replacement of `dir` must be heard; `onDistrust()` hears the parent's
 * watch end, after which one goes unheard (`trusted` reads false), and
 * `onTrust()` hears it followed again. Throws what `fs.watch` throws when
 * `dir` cannot be watched now, or the error that ended the watch while the
 * subscription was being made.
 */
export function watchDirectory(
  dir,
  names,
  { onEvent, onLost = null, onDistrust = null, onTrust = null, replace = false }
) {
  let state = watched.get(dir);
  const opened = !state;
  if (opened) {
    state = {
      dir,
      removedName: `\\\\?\\${dir}`,
      watcher: null,
      subscribers: new Set(),
      byName: new Map(),
      parent: null,
      replacing: 0,
      waiter: null,
    };
    state.watcher = startWatch(state);
    watched.set(dir, state);
  }
  // Held before the callbacks below run (the parent followed, children
  // recovered): one of them letting go of this watch cannot close it.
  const subscriber = {
    names: [...new Set(names)],
    onEvent,
    onLost,
    onDistrust,
    onTrust,
    replace,
    joining: true,
    closed: false,
    lostError: null,
  };
  state.subscribers.add(subscriber);
  for (const name of subscriber.names) {
    let set = state.byName.get(name);
    if (!set) {
      set = new Set();
      state.byName.set(name, set);
    }
    set.add(subscriber);
  }
  if (replace && state.replacing++ === 0) followParent(state);
  if (opened) {
    // Children whose watch of this directory ended follow it again.
    const waiting = orphans.get(dir);
    if (waiting) for (const child of [...waiting]) refollow(child);
  }
  subscriber.joining = false;
  if (subscriber.closed) throw subscriber.lostError;
  const owner = state;
  return {
    /** True only while a live watch of `dir` backs this subscription and,
     *  for `replace`, a live watch of its parent (none needed for a root). */
    get trusted() {
      if (subscriber.closed || owner.watcher === null) return false;
      if (!replace) return true;
      return owner.parent ? owner.parent.trusted : dirname(owner.dir) === owner.dir;
    },
    close() {
      if (subscriber.closed) return;
      subscriber.closed = true;
      owner.subscribers.delete(subscriber);
      for (const name of subscriber.names) {
        const set = owner.byName.get(name);
        set?.delete(subscriber);
        if (set?.size === 0) owner.byName.delete(name);
      }
      if (replace) owner.replacing -= 1;
      release(owner);
    },
  };
}
