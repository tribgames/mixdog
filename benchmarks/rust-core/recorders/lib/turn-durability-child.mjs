// One process of a turn-durability case (record-turn-durability.mjs): a real 1.4.5 `askSession` turn against a scripted provider,
// in its own data dir. `run` drives the turn to the case's point and, for a crash case, kills this process there (SIGKILL: no exit
// handler runs); `reopen` is the next process on the same data dir and reads the session as a desktop or phone read does
// (`projectStoredTranscript`, which recovers a dead owner's turn checkpoint). Each step writes what a client sees and what is on
// disk to the `out` JSON lines file, before any kill.
//   node turn-durability-child.mjs <tree> <case> <run|reopen> <out> <work dir>
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const [tree, caseName, phase, out, workdir] = process.argv.slice(2);
// The case's folder (its work dir and data dir appear in the session's system prompt) is a fresh temp folder per run: it is
// written as `<sandbox>`.
const step = (value) => appendFileSync(out, `${JSON.stringify(value).replaceAll(JSON.stringify(dirname(workdir)).slice(1, -1), '<sandbox>')}\n`);

// ---- determinism: ids from a counter, time virtual --------------------------------------------------------------------------
const crypto = createRequire(import.meta.url)('node:crypto');
let draws = phase === 'run' ? 0 : 1_000_000;
const nextBytes = (n) => {
  const bytes = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) bytes[i] = (draws * 131 + i * 17 + 7) & 0xff;
  draws += 1;
  return bytes;
};
crypto.randomBytes = (n, callback) => {
  const bytes = nextBytes(n);
  if (typeof callback === 'function') {
    callback(null, bytes);
    return undefined;
  }
  return bytes;
};
crypto.randomUUID = () => {
  const hex = nextBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
syncBuiltinESMExports();
// Transcript message ids are drawn from the web crypto (`transcript-metadata.mjs`), in the turn's own order: a sequence of
// their own, apart from the draws of background work.
let webDraws = phase === 'run' ? 0 : 1_000;
globalThis.crypto.randomUUID = () => {
  webDraws += 1;
  return `00000000-0000-4000-8000-${String(webDraws).padStart(12, '0')}`;
};
let NOW = phase === 'run' ? 1_800_000_000_000 : 1_800_000_600_000;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [NOW]));
  }
  static now() {
    return NOW;
  }
};
// The checkpoint's streaming flush throttle is the only timer the script waits on: the timers armed while the provider streams are
// virtual, run in due order then registration order by `advance`; every other timer is Node's own.
const timers = { seq: 0, queue: [], scoped: false };
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
// `crash-queued-while-take`: from the first request on, the store's usage debounce (`SAVE_DEBOUNCE_MS`, 150 ms,
// `store/pending-writes.mjs`) is virtual too, so whether the first request's usage is durable at the kill is the script's choice.
const debounceVirtual = () => timers.debounce && new Error().stack.includes('pending-writes.mjs');
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  if (!timers.scoped && !debounceVirtual()) return realSetTimeout(fn, ms, ...args);
  const timer = { virtual: true, due: NOW + Math.max(0, Number(ms) || 0), seq: timers.seq++, fn, args };
  timers.queue.push(timer);
  return Object.assign(timer, { ref: () => timer, unref: () => timer, hasRef: () => true, refresh: () => timer });
};
globalThis.clearTimeout = (timer) => {
  if (!timer?.virtual) return realClearTimeout(timer);
  const at = timers.queue.indexOf(timer);
  if (at >= 0) timers.queue.splice(at, 1);
};
const scoped = (fn) => {
  timers.scoped = true;
  try {
    return fn();
  } finally {
    timers.scoped = false;
  }
};
function advance(ms) {
  const target = NOW + ms;
  for (;;) {
    const due = [...timers.queue].sort((a, b) => a.due - b.due || a.seq - b.seq).find((t) => t.due <= target);
    if (!due) break;
    timers.queue.splice(timers.queue.indexOf(due), 1);
    NOW = due.due;
    due.fn(...due.args);
  }
  NOW = target;
}

// ---- the product --------------------------------------------------------------------------------------------------------------
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
const S = 'src/runtime/agent/orchestrator/';
const { createSession } = await imp(`${S}session/manager/session-lifecycle.mjs`);
const { askSession } = await imp(`${S}session/manager/ask-session.mjs`);
const { _withRegisteredProviderForTestAsync } = await imp(`${S}providers/registry.mjs`);
const { modelToolSchemaAllowlist } = await imp(`${S}runtime-core/tool-profile.mjs`);
const { readTurnCheckpoint, settleTurnCheckpointWrites } = await imp(`${S}session/manager/turn-checkpoint.mjs`);
const { _setJournalOpGateForTest } = await imp(`${S}session/manager/turn-checkpoint-journal.mjs`);
const { awaitPreviousTurnDurable } = await imp(`${S}session/manager/turn-durability.mjs`);
const { getSessionProgressSnapshot } = await imp(`${S}session/manager/runtime-liveness.mjs`);
const { readDurableSessionRecord } = await imp(`${S}session/store/transcript-durability.mjs`);
const { projectStoredTranscript } = await imp(`${S}session/store-transcript-projection.mjs`);
const sessionLogIo = (await imp(`${S}session/store/session-log-writer.mjs`))._sessionLogIoForTest();
const { getSession } = await imp(`${S}session/manager/session-crud.mjs`);
const { saveSession } = await imp(`${S}session/store.mjs`);
const { settleRecorder } = await imp(`${S}session/store/session-writers.mjs`);
const { createInheritance } = await imp('src/session-runtime/lifecycle/inheritance.mjs');
const { pickDoneVerb } = await imp('src/tui/session/labels.mjs');
const { createTranscriptRouteMetadata } = await imp('src/runtime/shared/transcript-metadata.mjs');
const { rememberSensitiveValues } = await imp(`${S}session/sensitive-values.mjs`);
// `crash-sensitive`: the value the turn streams, then marks sensitive (a browser fill), as `turn-checkpoint-sensitive.test.mjs`.
const SECRET = '731905';
// Which files of the case's data (every folder of the sandbox but the work dir and the steps file) hold the value.
const secretFiles = () => {
  const sandbox = dirname(workdir);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (path === workdir || path === out) continue;
      if (entry.isDirectory()) walk(path);
      else if (readFileSync(path).includes(SECRET)) found.push(relative(sandbox, path).replaceAll('\\', '/'));
    }
  };
  walk(sandbox);
  return found.sort();
};
// The turn's identity as the desktop's turn start stamps it (`beginTurn`, `tui/session/turn.mjs:127-135`): the turn's start
// and the session's route (`createTranscriptRouteMetadata(session)`, as `applyTurnRouteMetadata` stamps it, turn.mjs:120; no
// desktop runtime here, so no workflow agent), the done verb of the session's `index`th turn and a fresh attempt id.
const client = (index, id) => ({
  transcriptMeta: { ...createTranscriptRouteMetadata(getSession(id)), completionVerb: pickDoneVerb(index), attemptId: globalThis.crypto.randomUUID() },
});

// ---- the queue cases: the desktop's real session flow (intake, drain, turn, steering mirror) over the real `askSession` ----------
const QUEUED_CASES = ['crash-queued-before-take', 'crash-queued-while-take', 'crash-queued-after-take'];
const { createSessionFlow } = await imp('src/tui/session/session-flow.mjs');
const { createRunTurn } = await imp('src/tui/session/turn.mjs');
const { createAskCallbacks } = await imp('src/session-runtime/turn/turn-run/ask-callbacks.mjs');
const { readTuiSteeringPersist, flushTuiSteeringPersist } = await imp('src/tui/session/tui-steering-persist.mjs');
const { projectSessionState } = await imp('src/standalone/session-state-projection.mjs');
// The text of each user message of every turn request, in order: what the model was given.
const requests = [];
const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join(''));
// The session runtime's ask (`session-runtime/turn/turn-run.mjs`): the TUI turn's options through the real callback bridge
// (`createAskCallbacks`, which stamps the submission ids on the transcript) into `askSession`; workspace preparation, the turn's
// snapshot and timing are left out (none touches the queue or the transcript's identity).
function queueFlow(id) {
  const state = { busy: false, commandBusy: false, queued: [], items: [], promptHistoryList: [], stats: { turns: 0, inputTokens: 0, outputTokens: 0 } };
  const flags = { leadTurnEpoch: 0 };
  // Told on every change of what `idle` waits on: the busy flag (`set`) and the queue's length (a push or splice ends in its
  // `length` write).
  let changed = () => {};
  const pending = new Proxy([], {
    set(target, key, value) {
      target[key] = value;
      if (key === 'length') changed();
      return true;
    },
  });
  let sequence = 0;
  const { askCallbacks, plannedToolCalls } = createAskCallbacks({
    transcript: { appendAssistantText() {} },
    notifyFnForSession: () => null,
    scheduleSearchRuntimeWarmup: null,
    hooks: { emit() {} },
  });
  const runtime = {
    id,
    get session() {
      return getSession(id);
    },
    toolMode: 'auto',
    async ask(content, options) {
      const turn = { timing: {}, emitTiming() {}, armHeavyRuntimeWarmup() {}, snapshot: {}, signal: undefined };
      const session0 = getSession(id);
      const result = await askSession(id, content, options.context || null, plannedToolCalls(session0, options), null, null, askCallbacks(turn, session0, options));
      return { result, session: getSession(id) };
    },
    abort: () => false,
  };
  const bag = {
    runtime,
    flags,
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => {
      Object.assign(state, patch);
      changed();
      return state;
    },
    nextId: () => `${id}-item-${++sequence}`,
    appendItems: (items, extra) => {
      Object.assign(state, { items: [...state.items, ...items] }, extra);
      changed();
      return state;
    },
    pushItem: (item) => state.items.push(item),
    pushUserOrSyntheticItem: (text, itemId, kind, extra) => state.items.push({ text, id: itemId, kind, ...extra }),
    patchItem: (itemId, patch) => Object.assign(state.items.find((item) => item.id === itemId) || {}, patch),
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
  };
  Object.assign(bag, createSessionFlow(bag));
  bag.runTurn = createRunTurn(bag);
  return {
    // A desktop submit (`clientSubmissionId`, its durable mirror awaited).
    async submit({ id: submission, content }) {
      if ((await bag.enqueue(content, { id: submission, awaitPersistence: true })) !== true) throw new Error(`${submission} refused`);
    },
    // Settled: no turn runs and nothing is queued.
    async idle() {
      const settled = () => !state.busy && !pending.length;
      if (!settled()) {
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(() => {
            changed = () => {};
            reject(new Error(`${caseName}: the turn did not end and the queue did not empty within 60 s (busy ${state.busy}, queued ${pending.length})`));
          }, 60_000);
          changed = () => {
            if (!settled()) return;
            clearTimeout(deadline);
            changed = () => {};
            resolve();
          };
        });
      }
      await settleTurnCheckpointWrites(id);
      await flushTuiSteeringPersist();
    },
    restore: () => bag.restoreLeadSteeringFromDisk(),
    // The resume's release hook drains what the restore queued (`session-api/lifecycle/resume.mjs:72`).
    drain: () => bag.drain(),
    // What the user has queued (the composer's queue: id and text, in order), the durable mirror's rows, the requests so far.
    async seen() {
      await flushTuiSteeringPersist();
      return {
        // As the desktop is sent it (`projectSessionState`).
        queued: projectSessionState({}, { queued: state.queued }).queued,
        spool: (await readTuiSteeringPersist(id)).map((row) => ({ id: row.submissionId, text: row.text })),
        requests: requests.slice(),
      };
    },
  };
}

const realWrite = sessionLogIo.writeSync;
const FAULT = 'EIO: injected';
// Every session-log batch write fails while armed, as `turn-durability.test.mjs` arms it.
const fault = (armed) => {
  sessionLogIo.writeSync = armed
    ? () => {
        throw Object.assign(new Error(FAULT), { code: 'EIO' });
      }
    : realWrite;
};
const kill = () => process.kill(process.pid, 'SIGKILL');
// A wait on a write the case's kill point depends on: one deadline, and a message naming what it waits for.
const within = (promise, what) =>
  new Promise((resolve, reject) => {
    const deadline = realSetTimeout(() => reject(new Error(`${caseName}: waited 30 s for ${what}`)), 30_000);
    promise.then(
      (value) => {
        realClearTimeout(deadline);
        resolve(value);
      },
      (error) => {
        realClearTimeout(deadline);
        reject(error);
      }
    );
  });
const idFile = join(workdir, 'session-id');

// What a client reading the session sees (the desktop's and the phone's transcript read), what the durable record holds, and the
// turn checkpoint left on disk.
// The session's usage books as the durable record holds them (`applyUsageDelta`/`recordUsageMetrics`, session/usage-metrics):
// what a turn's usage moves, and what a failed save must not lose or count twice.
const USAGE_BOOKS = [
  'totalInputTokens', 'totalOutputTokens', 'totalToolCalls', 'tokensCumulative', 'totalCachedReadTokens', 'totalCacheWriteTokens',
  'totalUncachedInputTokens', 'usageReadout', 'lastInputTokens', 'lastOutputTokens', 'lastCachedReadTokens', 'lastCacheWriteTokens',
  'lastUncachedInputTokens', 'lastContextTokens', 'usageMetricsTurnId', 'reasoningUsage', 'lastIterationIndex',
];
const headerOf = (record) => (record ? Object.fromEntries(USAGE_BOOKS.map((key) => [key, record[key] ?? null])) : null);
// The turn checkpoint on disk now: null when none, else its seal and the turn's messages it copies.
const checkpointOf = (id) => {
  const checkpoint = readTurnCheckpoint(id);
  return checkpoint ? { sealed: checkpoint.sealed === true, turnMessages: checkpoint.turnMessages.length } : null;
};
async function observe(id) {
  const disk = readDurableSessionRecord(id);
  const view = await projectStoredTranscript(id, disk, { includeMessages: true, itemLimit: 100 });
  return {
    view: { messages: view.messages ?? null, items: view.items ?? null },
    disk: { messages: readDurableSessionRecord(id)?.messages ?? null, usage: headerOf(readDurableSessionRecord(id)) },
    checkpoint: checkpointOf(id),
    stage: getSessionProgressSnapshot(id)?.stage ?? null,
  };
}

const USAGE = { inputTokens: 10, outputTokens: 2 };
const READ = { id: 'call_read', name: 'read', arguments: { path: 'x.txt' } };
let sends = 0;
let onSend = async () => {};
const provider = {
  name: 'durability-stub',
  contextWindow: 128000,
  async send(messages, _model, _tools, opts) {
    if (opts?.requestKind && opts.requestKind !== 'turn') return { content: 'Title', usage: USAGE };
    sends += 1;
    requests.push(messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)));
    return await onSend(sends, opts);
  },
};
const answer = (opts, text) => {
  // As a provider adapter does when the response starts (`anthropic-oauth.mjs`: `onStageChange('streaming')`): the runtime entry's
  // stage is the adapters' to move, a scripted `send` moves none.
  scoped(() => opts.onStageChange?.('streaming'));
  scoped(() => opts.onTextDelta?.(text));
  return { content: text, stopReason: 'end_turn', usage: USAGE };
};

await _withRegisteredProviderForTestAsync('durability-stub', provider, async () => {
  if (phase === 'reopen') {
    const id = readFileSync(idFile, 'utf8');
    if (QUEUED_CASES.includes(caseName)) {
      // The desktop resumes the session: the read (which recovers a dead owner's turn), the restore of the durable mirror, then
      // the drain of what it restored.
      const view = await observe(id);
      const f = queueFlow(id);
      onSend = async (_n, opts) => answer(opts, 'answer after restart');
      await f.restore();
      step({ step: 'reopened', ...(await f.seen()), ...view });
      await f.drain();
      await f.idle();
      step({ step: 'drained', ...(await f.seen()), ...(await observe(id)) });
      return;
    }
    const secrets = () => (caseName === 'crash-sensitive' ? { secretFiles: secretFiles() } : {});
    step({ step: 'reopened', ...(await observe(id)), ...secrets() });
    step({ step: 'read again', ...(await observe(id)), ...secrets() });
    return;
  }
  // A fixed id: a minted one carries this process's pid.
  const session = createSession({
    id: `sess_1_1800000000000_1800000000000_${crypto.createHash('sha256').update(caseName).digest('hex').slice(0, 32)}`,
    provider: 'durability-stub',
    model: 'stub-model',
    cwd: workdir,
    skipSkills: true,
    schemaAllowedTools: modelToolSchemaAllowlist('headless'),
    workflow: { id: 'headless', delegatesAgents: false },
  });
  const id = session.id;
  writeFileSync(idFile, id);
  // `extra` is read once the checkpoint's writes have settled, so it shows what is on disk at the kill.
  const settleThenKill = async (extra = () => ({})) => {
    await settleTurnCheckpointWrites(id);
    step({ step: 'killed', sends, ...(caseName === 'crash-sensitive' ? { secretFiles: secretFiles() } : {}), ...extra() });
    kill();
  };
  if (caseName === 'save-failure') {
    // Every save after the provider answered fails, the terminal save too; the turn's answer was shown.
    onSend = async (_n, opts) => {
      fault(true);
      return answer(opts, 'answer');
    };
    const first = await askSession(id, 'first task', null, null, null, null, client(0, id));
    await settleTurnCheckpointWrites(id);
    step({ step: 'first turn answered, its save failed', result: first?.content ?? null, ...(await observe(id)) });
    onSend = async (_n, opts) => answer(opts, 'answer');
    // A refused turn closes no turn: the desktop's next one keeps its index.
    const refused = await askSession(id, 'second task', null, null, null, null, client(1, id)).then(
      () => ({ refused: false }),
      (error) => ({ refused: true, code: error.code ?? null, name: error.name ?? null, message: error.message })
    );
    step({ step: 'second turn while the save still fails', ...refused, sends, ...(await observe(id)) });
    fault(false);
    const second = await askSession(id, 'second task', null, null, null, null, client(1, id));
    await awaitPreviousTurnDurable(id);
    await settleTurnCheckpointWrites(id);
    step({ step: 'second turn after the disk recovered', result: second?.content ?? null, sends, ...(await observe(id)) });
    return;
  }
  if (caseName === 'save-failure-tool-rounds') {
    // The saves fail from the first request on while the turn keeps working: two tool rounds, each with streamed text, then the
    // answer. Nothing bounds what the session holds meanwhile (`_unsettled` keeps the session itself, `turn-durability.mjs:15`;
    // each save supersedes the one before, `store.mjs:281`): the next turn is refused, then everything lands with the next save.
    // Another file of the same text: a second read of `x.txt` is answered by the loop's cross-turn dedup, not by the tool.
    const READ2 = { id: 'call_read2', name: 'read', arguments: { path: 'y.txt' } };
    onSend = async (n, opts) => {
      if (n === 1) {
        fault(true);
        scoped(() => opts.onTextDelta?.('reading'));
        return { content: 'reading', toolCalls: [READ], stopReason: 'tool_use', usage: USAGE };
      }
      if (n === 2) {
        scoped(() => opts.onTextDelta?.('reading again'));
        return { content: 'reading again', toolCalls: [READ2], stopReason: 'tool_use', usage: USAGE };
      }
      return answer(opts, 'answer');
    };
    await askSession(id, 'first task', null, null, null, null, client(0, id));
    await settleTurnCheckpointWrites(id);
    step({ step: 'first turn answered after two tool rounds, every save failed', sends, ...(await observe(id)) });
    onSend = async (_n, opts) => answer(opts, 'answer');
    const refused = await askSession(id, 'second task', null, null, null, null, client(1, id)).then(
      () => ({ refused: false }),
      (error) => ({ refused: true, code: error.code ?? null, name: error.name ?? null, message: error.message })
    );
    step({ step: 'second turn while the save still fails', ...refused, sends, ...(await observe(id)) });
    fault(false);
    await askSession(id, 'second task', null, null, null, null, client(1, id));
    await awaitPreviousTurnDurable(id);
    await settleTurnCheckpointWrites(id);
    step({ step: 'second turn after the disk recovered', sends, ...(await observe(id)) });
    return;
  }
  if (caseName === 'fork-held') {
    // A turn held by a failed save, then the desktop's fork (`inheritSession`: a created heir, then `inheritFrom` of the
    // source, read through the session manager), once while the saves still fail and once after they recover.
    onSend = async (_n, opts) => {
      fault(true);
      return answer(opts, 'answer');
    };
    await askSession(id, 'first task', null, null, null, null, client(0, id));
    await settleTurnCheckpointWrites(id);
    step({ step: 'first turn answered, its save failed', sends, ...(await observe(id)) });
    const fork = async (n) => {
      const heirId = `sess_1_1800000000000_1800000000000_${crypto.createHash('sha256').update(`${caseName}-heir-${n}`).digest('hex').slice(0, 32)}`;
      let heir = null;
      const outcome = await (async () => {
        heir = createSession({
          id: heirId,
          provider: 'durability-stub',
          model: 'stub-model',
          cwd: workdir,
          skipSkills: true,
          schemaAllowedTools: modelToolSchemaAllowlist('headless'),
          workflow: { id: 'headless', delegatesAgents: false },
        });
        const deps = {
          getSession: () => heir,
          getRoute: () => null,
          mgr: { getSession },
          createCurrentSession: null,
          invalidateContextStatusCache: () => {},
          getReservedSessionId: () => null,
        };
        const result = await createInheritance(deps, { compactConversation: null, saveSession }).inheritFrom(id, { compact: false });
        return { forked: true, messages: result.messages };
      })().then(
        (value) => value,
        (error) => ({ forked: false, code: error.code ?? null, message: error.message })
      );
      // The heir's save is accepted by its recorder and lands later: read once what was accepted has landed or failed.
      await settleRecorder(heirId);
      const live = heir ? await projectStoredTranscript(heirId, heir, { includeMessages: true, itemLimit: 100 }) : null;
      return {
        ...outcome,
        heir: { live: live ? { items: live.items ?? null } : null, ...(await observe(heirId)) },
        source: await observe(id),
      };
    };
    step({ step: 'fork while the save still fails', ...(await fork(1)) });
    fault(false);
    step({ step: 'fork after the disk recovered', ...(await fork(2)) });
    return;
  }
  if (caseName === 'resume-held') {
    // A turn held by a failed save (as `crash-sealed-unsaved`); a second client resumes the session in the owning process (it
    // is shown the live session, `loadSession` preferring the in-memory copy), then the process dies and the session reopens.
    onSend = async (_n, opts) => {
      fault(true);
      return answer(opts, 'answer');
    };
    await askSession(id, 'do the task', null, null, null, null, client(0, id));
    await settleTurnCheckpointWrites(id);
    const live = await projectStoredTranscript(id, getSession(id), { includeMessages: true, itemLimit: 100 });
    step({ step: 'resumed while held', live: { items: live.items ?? null }, ...(await observe(id)) });
    await settleThenKill();
  }
  if (QUEUED_CASES.includes(caseName)) {
    // A turn runs; two prompts are queued while its request is on the wire (durable in the steering mirror). Killed before the
    // turn takes them, while the turn that took them is on the wire, or after it answered.
    const f = queueFlow(id);
    let release;
    const first = new Promise((resolve) => {
      release = resolve;
    });
    const onWire = Promise.withResolvers();
    onSend = async (n, opts) => {
      onWire.resolve(n);
      if (n === 1) {
        if (caseName === 'crash-queued-while-take') timers.debounce = true;
        await first;
        return answer(opts, 'answer');
      }
      if (caseName === 'crash-queued-while-take') {
        // The first request's usage debounce runs out, and its write lands, before the kill.
        advance(150);
        await settleRecorder(id);
        step({ step: 'taken', ...(await f.seen()), ...(await observe(id)) });
        await settleThenKill();
      }
      return answer(opts, 'answer to the queued');
    };
    await f.submit({ id: 'sub-0', content: 'do the task' });
    await onWire.promise;
    for (const [sub, content] of [['sub-1', 'first queued'], ['sub-2', 'second queued']]) await f.submit({ id: sub, content });
    step({ step: 'queued', ...(await f.seen()), ...(await observe(id)) });
    if (caseName === 'crash-queued-before-take') await settleThenKill();
    release();
    // `crash-queued-while-take` dies on the request that took them (`onSend`).
    if (caseName === 'crash-queued-while-take') await new Promise(() => {});
    await f.idle();
    step({ step: 'answered', ...(await f.seen()), ...(await observe(id)) });
    await settleThenKill();
  }
  if (caseName === 'crash-before-write') {
    // The turn's first write is its checkpoint journal's open: the process dies before it runs.
    _setJournalOpGateForTest(async () => {
      step({ step: 'killed', sends });
      kill();
    });
  } else if (caseName === 'crash-before-output') {
    onSend = async () => settleThenKill();
  } else if (caseName === 'crash-mid-stream') {
    onSend = async (_n, opts) => {
      scoped(() => {
        opts.onTextDelta?.('partial ');
        opts.onTextDelta?.('streamed answer');
      });
      // The checkpoint's streaming flush is due 150 ms after the previous one.
      advance(150);
      // The draft written, the run not ended: the checkpoint is on disk.
      await settleThenKill(() => ({ checkpoint: checkpointOf(id) }));
    };
  } else if (caseName === 'crash-sensitive') {
    // A value streams and is checkpointed, then is marked sensitive (a browser fill); the next flush rewrites the checkpoint
    // redacted (`commitHeader` on a new version), then the process dies. No stored copy of the value is left.
    onSend = async (_n, opts) => {
      scoped(() => opts.onTextDelta?.(`the code is ${SECRET}, `));
      advance(150);
      await settleTurnCheckpointWrites(id);
      // Before the mark the value is in the checkpoint on disk: what makes "no file holds it" after the mark a claim.
      const secretFilesBeforeMark = secretFiles();
      rememberSensitiveValues(id, [{ name: 'browser', arguments: { action: 'fill', input: { ref: 'p1-s1-e3', text: SECRET, sensitive: true } } }]);
      scoped(() => opts.onTextDelta?.('entered.'));
      advance(150);
      await settleThenKill(() => ({ secretFilesBeforeMark }));
    };
  } else if (caseName === 'crash-tool-wire') {
    // A tool round is done and the follow-up request is on the wire.
    onSend = async (n, opts) => {
      if (n === 1) {
        scoped(() => opts.onTextDelta?.('reading'));
        return { content: 'reading', toolCalls: [READ], stopReason: 'tool_use', usage: USAGE };
      }
      await settleThenKill();
    };
  } else if (caseName === 'crash-answer-streamed') {
    // The answer streamed and was checkpointed as streamed text; the finished message and its seal are not written yet (their
    // write is held) when the process dies at the terminal save (the batch recording the turn's coverage), before it writes.
    onSend = async (_n, opts) => {
      const reply = answer(opts, 'answer');
      // The streamed text's journal write, the one this case is about, lands before the turn goes on to its terminal save: the
      // flush throttle runs out and its write is awaited (the held write below comes later).
      advance(150);
      await within(settleTurnCheckpointWrites(id), 'the streamed text reaches the checkpoint journal');
      return reply;
    };
    _setJournalOpGateForTest(async (op) => {
      const data = String(op.data ?? '');
      if (op.kind === 'append' && (data.includes('"t":"m"') || data.includes('"t":"seal"'))) await new Promise(() => {});
    });
    sessionLogIo.writeSync = (fd, buffer, ...rest) => {
      if (Buffer.from(buffer).includes('turnCoverage')) {
        step({ step: 'killed', sends });
        kill();
      }
      return realWrite(fd, buffer, ...rest);
    };
  } else if (caseName === 'crash-sealed-unsaved') {
    // The terminal save fails (the turn stays sealed in its checkpoint), then the process dies.
    onSend = async (_n, opts) => {
      fault(true);
      return answer(opts, 'answer');
    };
  } else if (caseName === 'crash-saved-uncleared') {
    // The terminal save lands (synced), the process dies before the checkpoint is removed.
    // The batch that records the turn's coverage is the terminal save's.
    onSend = async (_n, opts) => answer(opts, 'answer');
    let covered = false;
    sessionLogIo.writeSync = (fd, buffer, ...rest) => {
      if (Buffer.from(buffer).includes('turnCoverage')) covered = true;
      return realWrite(fd, buffer, ...rest);
    };
    const synced = () => {
      if (!covered) return;
      // The end is durable, the checkpoint not yet removed: it is still on disk. Only that it is there is recorded: its seal
      // and message count depend on how far its async journal had flushed (two recordings differed). Node races here too: in
      // about one run of 25 the terminal save is a log rewrite (`writeAllSync`, not the hooked batch write) and the case
      // never reaches this point, so the kill point cannot be made certain either.
      step({ step: 'killed', sends, checkpointPresent: checkpointOf(id) !== null });
      kill();
    };
    const realSync = sessionLogIo.fsyncSync;
    sessionLogIo.fsyncSync = (fd) => {
      realSync(fd);
      synced();
    };
    const realFsync = sessionLogIo.fsync;
    sessionLogIo.fsync = (fd, callback) =>
      realFsync(fd, (error) => {
        if (!error) synced();
        callback(error);
      });
  } else throw new Error(`unknown case ${caseName}`);
  await askSession(id, 'do the task', null, null, null, null, client(0, id));
  if (caseName === 'crash-sealed-unsaved') {
    await settleThenKill();
  }
  await settleTurnCheckpointWrites(id);
  throw new Error(`${caseName}: the turn ended before the case's kill point`);
});
process.exit(0);
