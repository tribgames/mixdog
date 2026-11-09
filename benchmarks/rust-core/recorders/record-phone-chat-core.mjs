#!/usr/bin/env node
// The core side of the phone's Chat calls (PH-2): what Node's session code did for `abortSession`, an idle abort's
// reclaim, a refused `submitToSession`, `readTranscriptHistory`, the room `reset` and the stale-view check. Each case lists
// what was done to the real Node code and everything it left behind.
//
//   MIXDOG_DATA_DIR=<temp> MIXDOG_HOME=<temp> HOME=<temp> USERPROFILE=<temp> APPDATA=<temp> LOCALAPPDATA=<temp> MIXDOG_SKIP_USER_DATA_BACKUP=1 \
//     node --experimental-transform-types benchmarks/rust-core/recorders/record-phone-chat-core.mjs --tree <exact b6f10295a export>
//
// The Node session code runs on a virtual timer queue: `setTimeout` is held, and a timer fires only when the scenario says
// so, in due-time then registration order, with the microtasks drained between callbacks. `Date.now` is that queue's clock.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as realImmediate } from 'node:timers';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'phone-chat-core-'));
process.env.MIXDOG_DATA_DIR = join(dataDir, 'data');
process.env.MIXDOG_HOME = join(dataDir, 'home');
const tree = resolveTree(parseArgs());

// ---- the virtual timer queue --------------------------------------------------------------------------------------
const START = 1_700_000_000_000;
let now = START;
let sequence = 0;
let timers = [];
const realDateNow = Date.now;
Date.now = () => now;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const timer = { id: ++sequence, due: now + Math.max(0, Number(ms) || 0), fn, args, unref: () => timer, ref: () => timer, hasRef: () => false };
  timers.push(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  timers = timers.filter((held) => held !== timer);
};
const microtasks = () => new Promise((resolve) => realImmediate(resolve));
/** Fires every timer due within `ms` of the clock, one at a time. */
async function advance(ms) {
  const until = now + ms;
  await microtasks();
  for (;;) {
    const due = timers.filter((timer) => timer.due <= until).sort((a, b) => a.due - b.due || a.id - b.id)[0];
    if (!due) break;
    timers = timers.filter((held) => held !== due);
    now = Math.max(now, due.due);
    due.fn(...due.args);
    await microtasks();
  }
  now = until;
}

const { createSessionFlow } = await importFrom(tree, 'src/tui/session/session-flow.mjs');
const { createRunTurn } = await importFrom(tree, 'src/tui/session/turn.mjs');
const { createAbortAction } = await importFrom(tree, 'src/tui/session/session-api/intake/abort.mjs');
const { createSubmissionIntake } = await importFrom(tree, 'src/tui/session/session-api/intake/submission.mjs');
const { flushTuiSteeringPersist } = await importFrom(tree, 'src/tui/session/tui-steering-persist.mjs');

const cancelled = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** One session: only the provider request is controlled. Intake, turn ownership and abort are Node's own. */
function boot(sessionId) {
  const state = {
    busy: false,
    commandBusy: false,
    queued: [],
    items: [],
    promptHistoryList: [],
    stats: { turns: 0, inputTokens: 0, outputTokens: 0 },
  };
  const flags = { leadTurnEpoch: 0 };
  const pending = [];
  const requests = [];
  const waiting = new Map();
  const abortReasons = [];
  let active;
  let sequenceId = 0;
  const runtime = {
    id: sessionId,
    session: { id: sessionId, messages: [] },
    toolMode: 'auto',
    async ask(content, options) {
      const result = Promise.withResolvers();
      const request = { id: options.id, content, options, ...result };
      const index = requests.push(request) - 1;
      active = request;
      waiting.get(index)?.resolve(request);
      try {
        return await result.promise;
      } finally {
        active = null;
      }
    },
    abort(reason) {
      abortReasons.push(reason);
      active.reject(cancelled());
      return true;
    },
  };
  const bag = {
    runtime,
    flags,
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `${sessionId}-item-${++sequenceId}`,
    appendItems: (items, extra) => Object.assign(state, { items: [...state.items, ...items] }, extra),
    pushItem: (item) => state.items.push(item),
    pushUserOrSyntheticItem: (text, id, kind, extra) => state.items.push({ text, id, kind, ...extra }),
    patchItem: (id, patch) => Object.assign(state.items.find((item) => item.id === id) || {}, patch),
    replaceItems: (items) => items,
    tuiDebug() {},
    pushNotice() {},
    syncContextStats() {},
    routeState: () => ({}),
    agentStatusState: () => ({}),
    denyAllToolApprovals() {},
    clearActiveToolSummary() {},
    flushDeferredExecutionPendingResumeKick() {},
    flushToolResults() {},
    autoClearBeforeSubmit() {},
  };
  Object.assign(bag, createSessionFlow(bag));
  bag.runTurn = createRunTurn(bag);
  const { abort } = createAbortAction(bag);
  const intake = createSubmissionIntake(bag);
  let draining;
  return {
    state,
    flags,
    pending,
    requests,
    abortReasons,
    flow: bag,
    abort,
    submitAsync: intake.submitAsync,
    start() {
      draining = bag.drain();
      return draining;
    },
    get drained() {
      return draining;
    },
    nextRequest(index = 0) {
      if (requests[index]) return Promise.resolve(requests[index]);
      if (!waiting.has(index)) waiting.set(index, Promise.withResolvers());
      return waiting.get(index).promise;
    },
    async stop() {
      flags.disposed = true;
      flags.admission = 'closing';
      active?.reject(cancelled());
      await draining;
      await flushTuiSteeringPersist();
    },
  };
}

/** Everything the session shows after a scenario: the transcript, the queue, the restore the composer is handed. */
const left = (f) => ({
  items: f.state.items.map((item) => ({ kind: item.kind, id: item.id, ...(item.status ? { status: item.status } : {}), ...(item.text !== undefined ? { text: item.text } : {}) })),
  queued: f.state.queued.map((entry) => entry.id),
  pending: f.pending.map((entry) => entry.id),
  promptRestore: f.state.promptRestore ?? null,
  promptHistory: f.state.promptHistoryList,
  busy: f.state.busy,
});

const PNG = { 1: { data: 'AAAA', mimeType: 'image/png' } };
const cases = [];

/** A turn running on a prompt `first` (the submit options), then `then(f)` happens, then the abort `options` is made. */
async function aborting(name, { prompt = 'draft', first = {}, steering = null, output = null, outputText = 'partial answer', options = {}, hint = null }) {
  const f = boot(`abort-${cases.length}`);
  const submitOptions = { id: 'sub1', awaitPersistence: true, transcriptMeta: { device: 'PC' }, ...first };
  const accepted = await f.submitAsync(prompt, submitOptions);
  const drained = f.start();
  const request = await f.nextRequest();
  if (steering) await f.submitAsync(steering.text, { id: steering.id, awaitPersistence: true, ...steering.options });
  if (output) request.options[output]?.(outputText);
  const before = left(f);
  const result = f.abort(options);
  await drained;
  await advance(150);
  cases.push({
    name,
    kind: 'abort',
    prompt,
    submit: { ...submitOptions, awaitPersistence: undefined },
    steering,
    output: output ? { callback: output, text: outputText } : null,
    options,
    accepted,
    before,
    result,
    abortReasons: f.abortReasons,
    after: left(f),
    ...(hint ? { hint } : {}),
  });
  await f.stop();
}

await aborting('own device, prompt handed back', {});
await aborting('own device, restorePrompt false keeps the prompt', { options: { restorePrompt: false, device: 'PC' } });
await aborting('own device named, prompt handed back', { options: { device: 'PC' } });
await aborting('another device cancels: the prompt travels through the state', { options: { device: 'Phone' } });
await aborting('another device cancels a prompt with pasted images', { first: { pastedImages: PNG }, prompt: 'see [Image #1]', options: { device: 'Phone' } });
await aborting('own device cancels a prompt with pasted images', { first: { pastedImages: PNG }, prompt: 'see [Image #1]', options: { device: 'PC' } });
await aborting('own device cancels a prompt with pasted texts', { first: { pastedTexts: { 1: { text: 'inline text' } } }, prompt: 'see [Text #1]', options: {} });
await aborting('a queued steering prompt: the turn is only interrupted', { steering: { id: 'sub2', text: 'redirect' }, options: { device: 'PC' } });
await aborting('a queued steering prompt, pasted images discarded', { first: { pastedImages: PNG }, prompt: 'see [Image #1]', steering: { id: 'sub2', text: 'redirect' }, options: {} });
await aborting('output already produced: nothing to hand back', { output: 'onTextDelta', options: { device: 'PC' } });
await aborting('whitespace output is not output', { output: 'onTextDelta', outputText: '  \n', options: { device: 'PC' } });
await aborting('a kickoff prompt is never restorable', { first: { kickoff: true }, options: { device: 'PC' } });
await aborting('a named non-user reason with no restore', { options: { reason: 'agent-watchdog', restorePrompt: false } });
await aborting('no device named by the canceller', { options: {} });
await aborting('a prompt submitted without a device, cancelled from a device', { first: { transcriptMeta: {} }, options: { device: 'Phone' } });

/** An abort while nothing runs: the daemon's `abort` reply is the object the session returned, or `{aborted}` for a boolean. */
const daemonReply = (raw) => (raw && typeof raw === 'object' ? raw : { aborted: raw === true });

async function idle(name, { queue, abortOptions }) {
  const f = boot(`idle-${cases.length}`);
  // A command is running: submissions queue and nothing starts.
  f.state.commandBusy = true;
  const accepted = [];
  for (const entry of queue) accepted.push(await f.submitAsync(entry.text, { id: entry.id, awaitPersistence: true, ...entry.options }));
  const before = left(f);
  const raw = f.abort(abortOptions);
  await advance(150);
  cases.push({ name, kind: 'idle', queue, abortOptions, accepted, before, raw: raw === undefined ? null : raw, reply: daemonReply(raw), after: left(f) });
  f.flags.disposed = true;
  await flushTuiSteeringPersist();
}

await idle('a queued submission is handed back by its id', { queue: [{ id: 'sub1', text: 'queued one' }, { id: 'sub2', text: 'queued two' }], abortOptions: { submissionId: 'sub1' } });
await idle('an id that is not queued', { queue: [{ id: 'sub1', text: 'queued one' }], abortOptions: { submissionId: 'zz' } });
await idle('no id names nothing', { queue: [{ id: 'sub1', text: 'queued one' }], abortOptions: {} });
await idle('nothing queued', { queue: [], abortOptions: { submissionId: 'sub1' } });
await idle('a queued prompt with pasted images', {
  queue: [{ id: 'sub1', text: 'see [Image #1]', options: { pastedImages: PNG } }],
  abortOptions: { submissionId: 'sub1' },
});

/** `submitAsync` of the daemon (`session-turns.mjs`): whether the prompt was accepted, and what the session holds after. */
async function submitting(name, { prompt, options = {}, admission, repeat = 1, busy = false }) {
  const f = boot(`submit-${cases.length}`);
  if (admission) f.flags.admission = admission;
  f.state.commandBusy = busy;
  const answers = [];
  for (let i = 0; i < repeat; i += 1) answers.push(await f.submitAsync(prompt, { id: 'sub1', awaitPersistence: true, ...options }));
  cases.push({ name, kind: 'submit', prompt, options, admission: admission ?? 'open', repeat, busy, answers, after: left(f) });
  f.flags.disposed = true;
  await flushTuiSteeringPersist();
}

await submitting('a prompt of blank text parts is refused', { prompt: [{ type: 'text', text: ' \n ' }] });
await submitting('a prompt whose display text is blank is refused', { prompt: [{ type: 'text', text: '' }], options: { displayText: '  ' } });
await submitting('a blank display text is replaced by the one given', { prompt: [{ type: 'text', text: ' ' }], options: { displayText: 'shown' } });
await submitting('a prompt of text is accepted and queued', { prompt: 'hello', busy: true });
await submitting('a closing session still takes a user prompt', { prompt: 'hello', admission: 'closing', busy: true });
await submitting('a closed session takes nothing', { prompt: 'hello', admission: 'terminal', busy: true });
await submitting('a repeated submission id is one prompt', { prompt: 'hello', repeat: 2, busy: true });

const out = join(FIXTURES_ROOT, 'desktop', 'phone-chat', 'phone-chat-core.json');
mkdirSync(join(FIXTURES_ROOT, 'desktop', 'phone-chat'), { recursive: true });
writeFileSync(out, `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-phone-chat-core.mjs', epoch: START, cases }, null, 2)}\n`);
console.log(`${cases.length} cases -> ${out}`);
Date.now = realDateNow;
process.exit(0);
