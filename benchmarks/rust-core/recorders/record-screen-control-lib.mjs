// Shared plumbing of the four `record-screen-control-*.mjs` recorders (a library: run one of those, not this).
//
// They record the phone's screen control on the secure desktop (UAC prompt, lock screen) from Node at b6f10295a:
// the source switch (secure-desktop-switch.ts), the input router (screen-input-router.ts), the helper lease
// (secure-desktop-helper.ts) and the install request (secure-desktop/install-request.ts). Every one drives the real
// TypeScript of an exact export of that commit through fakes of the desktop and the helper: a fake input-desktop
// name, a fake helper transport and a fake installer port that only records the request. No desktop is switched,
// nothing is installed, no UAC prompt is raised, nothing is elevated and no input is injected.
//
//   (cd <tree>/apps/desktop && node --import tsx <this repo>/benchmarks/rust-core/recorders/record-screen-control-<switch|router|lease|install>.mjs --tree <tree>)
//
// The four recorders write one fixture set, `native/core/fixtures/screen-control`, each into its own sub-directory.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

export const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SET = 'screen-control';
const LIB = 'benchmarks/rust-core/recorders/record-screen-control-lib.mjs';
const RECORDERS = ['switch', 'router', 'lease', 'install'].map((name) => `benchmarks/rust-core/recorders/record-screen-control-${name}.mjs`);

/** The export of `NODE_COMMIT` named by `--tree`, refused unless it is exactly that commit. */
export function openTree() {
  const tree = resolveTree(parseArgs());
  return { tree, identity: exactProductIdentity(tree, NODE_COMMIT) };
}

export const importTs = (tree, rel) => import(new URL(`file:///${join(tree, rel).replaceAll('\\', '/')}`).href);

/** Writes `files` (name → JSON value) into `screen-control/<sub>`; the other recorders' sub-directories stay. */
export function writeSub(sub, files, identity) {
  const finalDir = join(FIXTURES_ROOT, SET);
  const stage = stageSet(finalDir, [sub]);
  for (const [name, value] of Object.entries(files)) writeJson(join(stage, sub, name), value);
  writeSetManifest(stage, {
    set: SET,
    recorder: LIB,
    command: '(cd <tree>/apps/desktop && node --import tsx benchmarks/rust-core/recorders/record-screen-control-<switch|router|lease|install>.mjs --tree <tree>)',
    extra: { recorders: RECORDERS },
    identity,
  });
  commitStage(stage, finalDir);
}

const realSetImmediate = globalThis.setImmediate;
/** Lets every pending microtask run (Node drains them all before an immediate): the scenario's "nothing more can happen now". */
export const checkpoint = () => new Promise((resolve) => realSetImmediate(resolve));

/**
 * Virtual time: timers wait in one queue ordered by absolute due time, then registration order, and run one callback
 * at a time with the microtasks drained between callbacks (Node's own order). `Date.now` and the timer functions are
 * replaced while it is installed; nothing waits on the wall clock.
 */
export class VirtualTime {
  constructor(start) {
    this.now = start;
    this.start = start;
    this.seq = 0;
    this.queue = [];
    this.real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
  }

  install() {
    const arm = (callback, ms, ...args) => {
      const timer = { due: this.now + Math.max(0, Number(ms) || 0), seq: ++this.seq, callback, args, cleared: false };
      Object.assign(timer, { ref: () => timer, unref: () => timer, hasRef: () => true });
      this.queue.push(timer);
      return timer;
    };
    globalThis.setTimeout = arm;
    globalThis.clearTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
    Date.now = () => this.now;
  }

  restore() {
    Object.assign(globalThis, { setTimeout: this.real.setTimeout, clearTimeout: this.real.clearTimeout });
    Date.now = this.real.now;
  }

  pending() {
    return this.queue.filter((timer) => !timer.cleared).sort((a, b) => a.due - b.due || a.seq - b.seq);
  }

  /** Moves the clock forward by `ms`, running each timer that falls due, in order, one at a time. Returns how many ran. */
  async advance(ms) {
    const until = this.now + ms;
    let ran = 0;
    for (;;) {
      const [timer] = this.pending();
      if (!timer || timer.due > until) break;
      this.queue = this.queue.filter((entry) => entry !== timer);
      this.now = Math.max(this.now, timer.due);
      timer.callback(...timer.args);
      await checkpoint();
      ran += 1;
    }
    this.now = until;
    return ran;
  }

  /** Time elapsed since the start, for the golden. */
  elapsed() {
    return this.now - this.start;
  }
}
