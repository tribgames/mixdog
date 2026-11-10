// One process of a turn-durability case (record-turn-durability.mjs): a real 1.4.5 `askSession` turn against a scripted provider,
// in its own data dir. `run` drives the turn to the case's point and, for a crash case, kills this process there (SIGKILL: no exit
// handler runs); `reopen` is the next process on the same data dir and reads the session as a desktop or phone read does
// (`projectStoredTranscript`, which recovers a dead owner's turn checkpoint). Each step writes what a client sees and what is on
// disk to the `out` JSON lines file, before any kill.
//   node turn-durability-child.mjs <tree> <case> <run|reopen> <out> <work dir>
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
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
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  if (!timers.scoped) return realSetTimeout(fn, ms, ...args);
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
const { pickDoneVerb } = await imp('src/tui/session/labels.mjs');
// The turn's identity as the desktop's turn start stamps it (`beginTurn`, `tui/session/turn.mjs`): the done verb of the
// session's `index`th turn, the turn's start and a fresh attempt id.
const client = (index) => ({ transcriptMeta: { at: Date.now(), completionVerb: pickDoneVerb(index), attemptId: globalThis.crypto.randomUUID() } });

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
const idFile = join(workdir, 'session-id');

// What a client reading the session sees (the desktop's and the phone's transcript read), what the durable record holds, and the
// turn checkpoint left on disk.
async function observe(id) {
  const disk = readDurableSessionRecord(id);
  const view = await projectStoredTranscript(id, disk, { includeMessages: true, itemLimit: 100 });
  const checkpoint = readTurnCheckpoint(id);
  return {
    view: { messages: view.messages ?? null, items: view.items ?? null },
    disk: { messages: readDurableSessionRecord(id)?.messages ?? null },
    checkpoint: checkpoint ? { sealed: checkpoint.sealed === true, turnMessages: checkpoint.turnMessages.length } : null,
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
  async send(_messages, _model, _tools, opts) {
    if (opts?.requestKind && opts.requestKind !== 'turn') return { content: 'Title', usage: USAGE };
    sends += 1;
    return await onSend(sends, opts);
  },
};
const answer = (opts, text) => {
  scoped(() => opts.onTextDelta?.(text));
  return { content: text, stopReason: 'end_turn', usage: USAGE };
};

await _withRegisteredProviderForTestAsync('durability-stub', provider, async () => {
  if (phase === 'reopen') {
    const id = readFileSync(idFile, 'utf8');
    step({ step: 'reopened', ...(await observe(id)) });
    step({ step: 'read again', ...(await observe(id)) });
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
  const settleThenKill = async () => {
    await settleTurnCheckpointWrites(id);
    step({ step: 'killed', sends });
    kill();
  };
  if (caseName === 'save-failure') {
    // Every save after the provider answered fails, the terminal save too; the turn's answer was shown.
    onSend = async (_n, opts) => {
      fault(true);
      return answer(opts, 'answer');
    };
    const first = await askSession(id, 'first task', null, null, null, null, client(0));
    await settleTurnCheckpointWrites(id);
    step({ step: 'first turn answered, its save failed', result: first?.content ?? null, ...(await observe(id)) });
    onSend = async (_n, opts) => answer(opts, 'answer');
    // A refused turn closes no turn: the desktop's next one keeps its index.
    const refused = await askSession(id, 'second task', null, null, null, null, client(1)).then(
      () => ({ refused: false }),
      (error) => ({ refused: true, code: error.code ?? null, name: error.name ?? null, message: error.message })
    );
    step({ step: 'second turn while the save still fails', ...refused, sends, ...(await observe(id)) });
    fault(false);
    const second = await askSession(id, 'second task', null, null, null, null, client(1));
    await awaitPreviousTurnDurable(id);
    await settleTurnCheckpointWrites(id);
    step({ step: 'second turn after the disk recovered', result: second?.content ?? null, sends, ...(await observe(id)) });
    return;
  }
  if (caseName === 'crash-before-output') {
    onSend = async () => settleThenKill();
  } else if (caseName === 'crash-mid-stream') {
    onSend = async (_n, opts) => {
      scoped(() => {
        opts.onTextDelta?.('partial ');
        opts.onTextDelta?.('streamed answer');
      });
      // The checkpoint's streaming flush is due 150 ms after the previous one.
      advance(150);
      await settleThenKill();
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
    onSend = async (_n, opts) => answer(opts, 'answer');
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
      step({ step: 'killed', sends });
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
  await askSession(id, 'do the task', null, null, null, null, client(0));
  if (caseName === 'crash-sealed-unsaved') {
    await settleThenKill();
  }
  await settleTurnCheckpointWrites(id);
  throw new Error(`${caseName}: the turn ended before the case's kill point`);
});
process.exit(0);
