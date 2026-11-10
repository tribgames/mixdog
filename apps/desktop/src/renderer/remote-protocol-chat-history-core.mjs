// The core's replay of A (remote-protocol-chat-history.record.mjs): one case of ABORT_CASES driven through a running mixdogd with the
// phone inputs of Node's recording of that case (remote-protocol-chat-history.node/), in the same order, each one released at the same
// barrier: once the core has published every state Node had published before that input. What the core publishes is its state of the
// thread as the phone's client folds it (packages/protocol-client `sessionStateOf`, one fold per frame) and the reply to each phone call,
// through the phone's own stack (protocol client, router, production chat adapter), as remote-protocol-chat-abort-live.mjs drives it.
//
// Compared whole and in order: Node's history (every state, every reply) must be the core's, with the core's states between two of
// Node's left out (one Node publication is one settled step; the core's client folds that step frame by frame, and the states between
// its frames are no publication). A reply is never left out: the core's replies are Node's, in Node's places. After the last input the
// core's state, read again behind one more round trip, is Node's last.
//
// Declared, with their reasons (MANIFEST `normalized`):
//  - Clock readings. Node's clocks were virtual (moved only by the recorder), the core's is the machine's: a reading on either side is
//    compared as the clock of the input it was taken after (Node: the input's recorded clock at or before the reading; the core: the
//    recorded clock of the last input released at or before it). A duration ending at a reading (`elapsedMs` beside `completedAt`) is
//    compared as the difference of its two ends, each read so.
//  - Values that are each run's own: the thread's id, the core's and the model endpoint's process ids and ports.
//  - `host.startProject` and `host.deleteSession`: the desktop host's own calls in Node's recorder, not a phone's; the core has no host,
//    so the first is not made and the second is made by the phone's `deleteSession`. Their replies are not compared.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-history-core.mjs --only <case>[,<case>]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from '../../../../packages/protocol-client/src/client.ts';
import { sessionReducer, sessionStateOf } from '../../../../packages/protocol-client/src/session-state.ts';
import { parseDiscovery } from '../main/protocol/discovery.ts';
import { createWsConnector } from '../main/protocol/ws-connector.ts';
import { ABORT_CASES, ASKED_PROJECT_FILE, DEVICES, HOOK_RULES, PROJECT_FILE } from './remote-protocol-chat-abort-cases.mjs';
import { builtFrom } from './remote-protocol-chat-abort-live.mjs';
import { endLeftovers } from './remote-protocol-chat-abort-procs.mjs';
import { kindOf, startAbortProvider } from './remote-protocol-chat-abort-provider.mjs';

const NODE_DIR = new URL('./remote-protocol-chat-history.node/', import.meta.url);
/** Node's recording of `name`. */
export function nodeHistory(name) {
  for (const file of readdirSync(NODE_DIR).filter((f) => /^\d+\.json$/.test(f))) {
    const recording = JSON.parse(readFileSync(new URL(file, NODE_DIR), 'utf8'));
    if (recording.name === name) return { file, ...recording };
  }
  throw new Error(`no Node recording of ${name} in ${NODE_DIR.pathname}`);
}

const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const isPhone = (input) => input.input !== 'provider write';

/**
 * The normalizer of one side: `instant(ms)` names the input a clock reading was taken after; `ids` the side's own values. The same rules
 * on both sides; only how a reading finds its input differs (Node: by its virtual clock; the core: by the real release of each input).
 */
export function normalizer({ instant, own, named = new Map() }) {
  const ownPattern = own.size ? new RegExp(`(?<![0-9A-Za-z_])(${[...own.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![0-9A-Za-z_])`, 'g') : null;
  const reading = (v) => typeof v === 'number' && instant(v) !== null;
  const walk = (value, key, parent) => {
    if (typeof value === 'number') {
      if (own.has(String(value))) return own.get(String(value));
      if (key === 'elapsedMs' && parent && reading(parent.completedAt)) return `<d:${instant(parent.completedAt)}-${instant(parent.completedAt - value) ?? 'before'}>`;
      const at = instant(value);
      return at === null ? value : `<t:${at}>`;
    }
    if (typeof value === 'string') {
      const relabeled = ownPattern ? value.replace(ownPattern, (m) => own.get(m)) : value;
      return relabeled.replace(/(?<![0-9])1[0-9]{12}(?![0-9])/g, (digits) => { const at = instant(Number(digits)); return at === null ? digits : `<t:${at}>`; });
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, undefined, undefined));
    // An object's keys in one order: JSON objects are compared as what they hold, not as the order a writer put them in.
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [ownPattern ? k.replace(ownPattern, (m) => own.get(m)) : k, walk(v, k, value)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return value;
  };
  // Ids made at random (a message's `msg_<32 hex>`), named by their order of first appearance on the side.
  const rename = (value) => {
    if (typeof value === 'string') return value.replace(/msg_[0-9a-f]{32}/g, (id) => { if (!named.has(id)) named.set(id, `<msg:${named.size}>`); return named.get(id); });
    if (Array.isArray(value)) return value.map(rename);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)]));
    return value;
  };
  return Object.assign((value) => rename(walk(plain(value), undefined, undefined)), { named });
}

/** Node's history of a case, normalized: entries `{ kind: 'state', value }` / `{ kind: 'reply', input, value }`, and its phone inputs. */
export function nodeSide(recording) {
  const { epoch } = recording.manifest;
  const clocks = recording.inputs.filter(isPhone).map((i) => i.clock);
  const instant = (v) => {
    if (!(v >= epoch && v < epoch + 1e9)) return null;
    const passed = clocks.filter((c) => c <= v - epoch);
    return passed.length ? passed.at(-1) : 'before';
  };
  const norm = normalizer({ instant, own: new Map([[recording.id, '<session>']]) });
  const history = recording.history.map((h, at) => (h.kind === 'reply' ? { at, kind: 'reply', input: h.input, value: norm(h.error !== undefined ? { error: h.error } : { reply: h.reply }) } : { at, kind: 'state', value: norm(h.snapshot) }));
  return { history, inputs: recording.inputs };
}

/** The first difference between two normalized values: path, Node's, the core's. */
export function firstDifference(node, core, path = '') {
  if (JSON.stringify(node) === JSON.stringify(core)) return null;
  if (node && core && typeof node === 'object' && typeof core === 'object' && Array.isArray(node) === Array.isArray(core)) {
    for (const key of new Set([...Object.keys(node), ...Object.keys(core)])) {
      const found = firstDifference(node[key], core[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  return { path: path || '.', node, core };
}

/** Every top-level field in which two normalized states differ (for the report of a state the core never reached). */
export function differingFields(node, core) {
  return Object.keys({ ...node, ...core }).filter((k) => JSON.stringify(node?.[k]) !== JSON.stringify(core?.[k])).map((k) => ({ field: k, node: node?.[k], core: core?.[k] }));
}

/**
 * Matches the core's log against Node's history: each Node state must be one of the core's states after the previous match, each Node
 * reply the core's next reply (no core reply skipped). Returns how far it matched (`matched` Node entries) and, when the core's log has
 * gone past a point it can no longer match, the failure.
 */
export function matchHistory(node, core) {
  let at = 0;
  let matched = 0;
  for (const want of node) {
    if (want.kind === 'reply') {
      // The core's next reply, with no reply skipped; states before it are between two of Node's (left out).
      let next = at;
      while (next < core.length && core[next].kind !== 'reply') next += 1;
      // A Node state still owed before this reply was passed over by the core's reply: the reply came before it.
      if (next >= core.length) return { matched, at };
      const got = core[next];
      if (got.input !== want.input || JSON.stringify(got.value) !== JSON.stringify(want.value)) {
        return { matched, at, failure: { node: want, core: got, difference: got.input === want.input ? firstDifference(want.value, got.value) : { path: 'input', node: want.input, core: got.input } } };
      }
      at = next + 1;
      matched += 1;
      continue;
    }
    const key = JSON.stringify(want.value);
    let next = at;
    // A Node state may not be reached past one of the core's replies: Node published it before that reply.
    while (next < core.length && core[next].kind !== 'reply' && JSON.stringify(core[next].value) !== key) next += 1;
    if (next >= core.length) return { matched, at };
    if (core[next].kind === 'reply') {
      const last = core.slice(at, next).findLast((e) => e.kind === 'state') ?? core.slice(0, at).findLast((e) => e.kind === 'state');
      return { matched, at, failure: { node: want, core: core[next], before: 'the core replied before publishing this state', fields: differingFields(want.value, last?.value) } };
    }
    at = next + 1;
    matched += 1;
  }
  return { matched, at, done: true };
}

/** Runs one case against the core binary `bin`; returns `{ name, pass, failure?, core: log }`. */
export async function replayCase(name, { bin, harness, deadlineMs = 120_000, seeded = async () => undefined }) {
  const c = ABORT_CASES.find((x) => x.name === name);
  if (!c) throw new Error(`no case ${JSON.stringify(name)}`);
  const recording = nodeHistory(name);
  const node = nodeSide(recording);
  // Node's host replies are not compared (declared): left out of what is matched. Of the states Node's host published for the new thread
  // before it answered the phone's submitNewTask, the last is compared, after the reply (declared): the core's phone learns of the thread
  // from the reply and its client subscribes to it then, so the thread's earlier states are not the phone's to fold; which of the reply and
  // the states a phone receives first is the sampler's (B, C).
  const submitAt = node.inputs.find((i) => i.input === 'phone.submitNewTask').at;
  const submitReply = node.history.find((h) => h.kind === 'reply' && h.input === 'phone.submitNewTask');
  const beforeReply = node.history.filter((h) => h.kind === 'state' && h.at >= submitAt && h.at < submitReply.at);
  const compared = node.history
    .filter((h) => !(h.kind === 'reply' && h.input.startsWith('host.')))
    .filter((h) => !(h.kind === 'state' && h.at >= submitAt && h.at < submitReply.at))
    .flatMap((h) => (h === submitReply ? [h, ...beforeReply.slice(-1)] : [h]));
  const load = (file) => import(pathToFileURL(join(harness, 'lib', file)).href);
  const { daemonEnv, isolatedPaths } = await load('env.mjs');
  const { seedPgRuntime } = await load('stage.mjs');
  const { launch } = await load('proc.mjs');
  const { createDeadline, latch } = await load('deadline.mjs');
  // The case's world where Node's recording had it (the same paths reach the states: the project's cwd).
  const paths = isolatedPaths(join(harness, 'run', `env-history-${name}`));
  const project = join(paths.workspace, 'a');
  const route = { provider: 'custom-harness', model: 'harness-model' };
  globalThis.window ??= { setTimeout: () => 0, clearTimeout() {} };
  const { adapter } = await import('./remote-protocol-chat.ts');
  const { createProtocolRouter } = await import('./remote-shim-protocol.ts');

  const log = [];
  const released = [];
  let core;
  let watcher;
  let provider;
  const clients = [];
  let failure = null;
  let result = null;
  let hasSeeded = false;
  let reached = { matched: 0, at: 0 };
  // The case's deadline starts again once every side-by-side case has seeded its world: the seeding copies are synchronous and hold the
  // event loop for every case, whose timers would otherwise fire before their watch events are read.
  const message = () => {
    const want = compared[reached.matched];
    const last = log.findLast((e) => e.kind === 'state');
    return `${name}: Node's entry ${reached.matched} (${want?.kind} ${want?.input ?? ''}) not reached; differing fields of the core's last state: ${JSON.stringify(want?.kind === 'state' ? differingFields(want.value, last?.value) : null).slice(0, 6000)}\ncore: ${core?.tail?.() ?? ''}`;
  };
  let deadline = createDeadline(deadlineMs, message);
  try {
    rmSync(paths.envRoot, { recursive: true, force: true });
    for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace, project]) mkdirSync(d, { recursive: true });
    writeFileSync(join(project, PROJECT_FILE.name), PROJECT_FILE.text);
    writeFileSync(join(project, ASKED_PROJECT_FILE.name), ASKED_PROJECT_FILE.text);
    writeFileSync(join(paths.dataDir, 'hooks.json'), JSON.stringify(HOOK_RULES));
    provider = await deadline.race(startAbortProvider({ gated: true }), 'the model endpoint to listen');
    writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
    seedPgRuntime(paths.dataDir);
    hasSeeded = true;
    await deadline.race(seeded(), 'every side-by-side case to seed its world');
    deadline.clear();
    deadline = createDeadline(deadlineMs, message);
    core = launch(bin, ['serve'], { env: daemonEnv(paths, { RUST_LOG: 'warn' }), cwd: paths.envRoot });
    const daemonDoc = () => {
      const file = join(paths.runtimeRoot, 'daemon.json');
      if (!existsSync(file)) return null;
      try {
        const d = JSON.parse(readFileSync(file, 'utf8'));
        return d?.core?.state === 'serving' && d.core.rpc?.port ? d : null;
      } catch { return null; }
    };
    const served = latch();
    // daemon.json is read on its folder's events and on the data folder's (daemon.log's ready line is written after daemon.json): an event
    // whose read met the file mid-write, or one the OS dropped under many side-by-side cases, is followed by another.
    const check = () => { const d = daemonDoc(); if (d) served.resolve(d); };
    const watchers = [watch(paths.runtimeRoot, check), watch(paths.dataDir, check)];
    watcher = { close: () => { for (const w of watchers) w.close(); } };
    check();
    const doc = await deadline.race(served.promise, 'the core to serve');
    const endpoint = parseDiscovery(readFileSync(join(paths.runtimeRoot, 'daemon.json'), 'utf8'));

    // The core's own values, named as Node's recording names its own.
    let threadId = '';
    const own = () => new Map([[String(core.pid), '<pid:daemon>'], [new URL(provider.baseURL).port, '<port:model>'], [String(doc.core.rpc.port), '<port:daemon>'], ...(threadId ? [[threadId, '<session>']] : [])]);
    const instant = (v) => {
      const from = released[0]?.real;
      if (!(from !== undefined && v >= from - 60_000 && v <= Date.now() + 60_000)) return null;
      const passed = released.filter((r) => r.real <= v);
      return passed.length ? passed.at(-1).clock : 'before';
    };
    // One normalizer per set of own values (the thread's id joins them with the submit's reply), so random ids keep their names.
    let normFor = null;
    let normKey = '';
    const norm = (value) => {
      const values = own();
      const key = JSON.stringify([...values]);
      if (key !== normKey) { normKey = key; normFor = normalizer({ instant, own: values, named: normFor?.named }); }
      return normFor(value);
    };

    const waiters = new Set();
    const wake = () => { for (const check of [...waiters]) check(); };
    provider.onQueued(wake);
    const until = (ready, what) => {
      const done = latch();
      // A difference found while waiting ends the wait with it (thrown out of the client's emit it would be lost).
      const check = () => {
        try {
          if (ready()) { waiters.delete(check); done.resolve(); }
        } catch (error) {
          waiters.delete(check);
          done.reject(error);
        }
      };
      waiters.add(check);
      check();
      return deadline.race(done.promise, what);
    };
    const advance = () => {
      reached = matchHistory(compared, log);
      if (reached.failure) throw Object.assign(new Error(`${name}: the core's history differs from Node's at Node's entry ${reached.matched}`), { comparison: reached.failure });
      return reached;
    };
    let lastKey = null;
    const connectPhone = async (title, viewing) => {
      const client = await deadline.race(connect({
        target: { id: 'core' },
        connector: createWsConnector(async () => endpoint),
        clientInfo: { name: 'mixdog-phone', title, version: '1.4.5', kind: 'tui' },
        capabilities: { optOutNotificationMethods: [], experimentalApi: false },
        threadReducer: sessionReducer,
        clock: { sleep: () => Promise.reject(new Error('the phone dropped its connection')) },
        random: Math.random,
      }), `the client of ${title} to connect`);
      clients.push(client);
      client.store.subscribe((change) => {
        if (viewing && change.type === 'thread' && (change.threadId === threadId || (!threadId && submitting))) {
          threadId ||= change.threadId;
          const value = norm(sessionStateOf(client, change.threadId));
          const key = JSON.stringify(value);
          if (key !== lastKey) {
            lastKey = key;
            log.push({ kind: 'state', value });
          }
        }
        wake();
      });
      const ctx = { phone: { start: async () => undefined }, sessionsCatalog: { publish: () => wake() } };
      const router = createProtocolRouter([adapter], { host: { ctx, client: () => client, declareLane() {} }, started: async () => undefined, synced: async () => undefined, probe() {}, silentSince: () => false });
      router.install();
      await deadline.race(client.subscribeApp(), `the app feed of ${title}`);
      await deadline.race(router.call('listSessions', []), `the first list read of ${title}`);
      return { client, router };
    };
    let submitting = false;
    const submitter = await connectPhone(c.submitter ?? DEVICES.a, true);
    const canceller = (c.canceller ?? c.submitter ?? DEVICES.a) === (c.submitter ?? DEVICES.a) ? submitter : await connectPhone(c.canceller, false);
    const submit = { id: `sub-${c.name}`, ...(c.pasted ? { pastedTexts: c.pasted } : {}), ...(c.submit ?? {}) };
    let shownId;
    const shown = () => (threadId ? sessionStateOf(submitter.client, threadId) : null);
    // Node's phone inputs, in Node's order, each with the arguments Node's recorder gave its phone table.
    const argsOf = (label) => {
      if (label === 'phone.submitNewTask') return [submitter, 'submitNewTask', [c.prompt, submit, { projectPath: project, route }]];
      if (label === 'phone.submitToSession') return [submitter, 'submitToSession', [threadId, c.then, { id: `sub-${c.name}-2` }]];
      if (label === 'phone.abortSession') return [canceller, 'abortSession', [threadId, c.stop]];
      if (label === 'phone.abortSession again') return [canceller, 'abortSession', [threadId, c.again]];
      if (label === 'host.deleteSession') return [submitter, 'deleteSession', [threadId]];
      const notify = /^phone\.answerApprovalNotification (\d+) /.exec(label);
      if (notify) {
        const step = c.notify[Number(notify[1])];
        const approvalId = step.id === 'shown' ? (shownId ??= String(shown()?.toolApproval?.id ?? '')) : step.id;
        return [submitter, 'answerApprovalNotification', [threadId, approvalId, step.action]];
      }
      throw new Error(`${name}: no phone call for Node's input ${label}`);
    };
    for (const input of node.inputs) {
      // The barrier: every entry Node had published before this input is the core's.
      const owed = compared.filter((h) => h.at < input.at).length;
      await until(() => advance().matched >= owed, `the core to publish Node's ${owed} entries before ${input.input}`);
      // The model endpoint's next write, of the kind Node released here, once the core has asked for it.
      if (!isPhone(input)) {
        await until(() => provider.release(kindOf(input.key)), `the core to ask the model endpoint for ${kindOf(input.key)} (Node's write ${input.step})`);
        continue;
      }
      released.push({ clock: input.clock, real: Date.now(), input: input.input });
      if (input.input === 'host.startProject') continue;
      const [phone, method, args] = argsOf(input.input);
      if (method === 'submitNewTask') submitting = true;
      let entry;
      try {
        entry = { reply: plain(await deadline.race(phone.router.call(method, args), `the reply to ${input.input}`)) };
      } catch (error) {
        entry = { error: String(error?.message ?? error) };
      }
      if (method === 'submitNewTask') threadId ||= entry.reply?.sessionId ?? '';
      if (input.input.startsWith('host.')) continue;
      log.push({ kind: 'reply', input: input.input, value: norm(entry) });
      wake();
    }
    await until(() => advance().done, `the core to publish Node's last entries`);
    // The core's state behind one more round trip is still Node's last.
    await deadline.race(submitter.client.call('thread/read', { threadId, window: { lastItems: 1 } }), 'the round trip after the case');
    const lastNode = compared.findLast((h) => h.kind === 'state');
    const lastCore = log.findLast((e) => e.kind === 'state');
    if (JSON.stringify(lastNode.value) !== JSON.stringify(lastCore.value)) throw Object.assign(new Error(`${name}: the core's state moved on after Node's last`), { comparison: { fields: differingFields(lastNode.value, lastCore.value) } });
    return (result = { name, pass: true, entries: compared.length, coreStates: log.filter((e) => e.kind === 'state').length });
  } catch (error) {
    failure = error;
    return (result = { name, pass: false, error: String(error?.message ?? error).slice(0, 8000), comparison: error.comparison ?? null, matched: reached.matched, log });
  } finally {
    // A case that failed before seeding still lets the others past the barrier.
    if (!hasSeeded) void seeded();
    deadline.clear();
    const ending = createDeadline(60_000, () => `ending the world of ${name}; core pid ${core?.pid}`);
    try {
      watcher?.close();
      for (const client of clients) client.close?.();
      if (core) {
        core.kill();
        await ending.race(core.exited, `the core of ${name} (pid ${core.pid}) to exit`);
      }
      if (provider) await ending.race(provider.close(), 'the model endpoint to close');
    } finally {
      ending.clear();
      // A case whose processes do not end fails itself; the side-by-side cases go on and report.
      try {
        endLeftovers(Number(core?.pid) || 0, paths.envRoot);
      } catch (error) {
        if (result) Object.assign(result, { pass: false, error: `${result.pass ? '' : `${result.error}\n`}teardown: ${error.message}` });
      }
    }
    void failure;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = process.argv[process.argv.indexOf('--only') + 1];
  if (!process.argv.includes('--only') || !only) throw new Error('usage: --only <case>[,<case>]');
  const bin = process.env.MIXDOGD_EXE;
  const harness = process.env.REAL_TURN_HARNESS;
  if (!bin || !existsSync(bin)) throw new Error(`MIXDOGD_EXE must name the built mixdogd (got ${JSON.stringify(bin)})`);
  if (!harness) throw new Error('REAL_TURN_HARNESS must name the real-turn harness directory');
  const built = builtFrom(bin);
  const names = only.split(',');
  // The barrier: a case resolves its seeding once its world is seeded (or it failed before), all of them together.
  let left = names.length;
  const all = Promise.withResolvers();
  const seeded = () => { left -= 1; if (left === 0) all.resolve(); return all.promise; };
  const results = await Promise.all(names.map((name) => replayCase(name, { bin, harness, seeded })));
  const out = process.env.HISTORY_CORE_OUT;
  if (out) writeFileSync(out, `${JSON.stringify({ binary: bin, binarySha256: createHash('sha256').update(readFileSync(bin)).digest('hex'), builtFrom: built, results }, null, 1)}\n`);
  for (const r of results) console.log(r.pass ? `ok ${r.name} (${r.entries} entries, ${r.coreStates} core states)` : `FAIL ${r.name} at Node's entry ${r.matched}: ${r.error}\n${JSON.stringify(r.comparison).slice(0, 4000)}`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
