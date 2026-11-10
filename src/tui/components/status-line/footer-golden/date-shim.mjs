// A set clock for the recording child: `Date.now()` and `new Date()` answer FOOTER_T0 until `__footerSetNow` moves it.
let current = Number(process.env.FOOTER_T0);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(current);
    else super(...args);
  }

  static now() {
    return current;
  }
}
globalThis.Date = FixedDate;
globalThis.__footerSetNow = (ms) => {
  current = ms;
};
// The footer defers every cache refresh to a setImmediate (statusline.mjs: "off the render call stack"). The recorder
// waits on those callbacks themselves: `__footerScheduled()` counts them, `__footerIdle()` resolves once all have run.
const realSetImmediate = globalThis.setImmediate;
let scheduled = 0;
let pending = 0;
let idleWaiters = [];
// This identifies, by stack, the single scheduling site in b6f10295a's statusline.mjs:542-571
// (oauthUsageSegmentReady). If that source changes, this exemption must be revisited.
// Node's OAuth arm check (statusline.mjs oauthUsageSegmentReady) is a poll: while the provider stays unarmed every
// render schedules it again ("stay unarmed; next tick retries"). Its outcome depends only on the files and the clock,
// which a stage holds fixed, so once it has run in a stage and been scheduled again it left the provider unarmed and
// a repeat cannot change anything: it is not a new operation. Every other operation counts each time.
const armPollsSeen = new Set();
let armRepeats = 0;
globalThis.__footerNewStage = () => armPollsSeen.clear();
globalThis.setImmediate = (fn, ...rest) => {
  if (new Error().stack.includes('oauthUsageSegmentReady')) {
    if (!armPollsSeen.has('arm-poll')) armPollsSeen.add('arm-poll');
    else armRepeats += 1;
  }
  scheduled += 1;
  pending += 1;
  return realSetImmediate(() => {
    try {
      fn(...rest);
    } finally {
      pending -= 1;
      if (pending === 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  });
};
// The memory-cycle and shell-job segments refresh through fs/promises (readFile/readdir/stat) and publish their cache
// when those settle; the named imports are live bindings, so wrapping the module's functions makes each pending
// operation a tracked one.
const fsPromises = (await import('node:fs/promises')).default;
const { syncBuiltinESMExports } = await import('node:module');
let fsPending = 0;
for (const name of ['readFile', 'readdir', 'stat']) {
  const real = fsPromises[name];
  fsPromises[name] = (...callArgs) => {
    fsPending += 1;
    fsStarted += 1;
    const op = real(...callArgs);
    const done = () => {
      fsPending -= 1;
    };
    op.then(done, done);
    return op;
  };
}
syncBuiltinESMExports();
let fsStarted = 0;
// How many tracked operations (deferred refreshes and fs/promises calls) have started so far.
globalThis.__footerOperations = () => scheduled + fsStarted - armRepeats;
// Idle: no deferred refresh and no fs operation pending, checked again after one more event-loop turn so the
// continuations of the operation that just settled (which publish the cache) have run.
globalThis.__footerIdle = async () => {
  for (;;) {
    if (pending > 0) await new Promise((resolve) => idleWaiters.push(resolve));
    await new Promise((resolve) => realSetImmediate(resolve));
    if (pending === 0 && fsPending === 0) return;
  }
};
Object.defineProperty(process.stdout, 'columns', { value: Number(process.env.FOOTER_COLS), configurable: true });
