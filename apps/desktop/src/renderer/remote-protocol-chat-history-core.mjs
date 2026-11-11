// The core's replay of A (remote-protocol-chat-history.record.mjs): one case of ABORT_CASES driven through a running mixdogd with the
// phone inputs of Node's recording of that case (remote-protocol-chat-history.node/), in the same order, each one released at the same
// barrier: once the core has published every state Node had published before that input. Node's inputs are its phone's calls, the model
// endpoint's writes and the moves of its clocks; the core runs on a clock this replay holds (a mixdogd built with `--features
// virtual-clock`, mixdog-rt virtual_clock.rs), frozen once it serves and moved by Node's recorded moves. What the core publishes is its state of the
// thread as the phone's client folds it (packages/protocol-client `sessionStateOf`, one fold per frame) and the reply to each phone call,
// through the phone's own stack (protocol client, router, production chat adapter), as remote-protocol-chat-abort-live.mjs drives it.
//
// Compared whole and in order: Node's history (every state, every reply) must be the core's, with the core's states between two of
// Node's left out (one Node publication is one settled step; the core's client folds that step frame by frame, and the states between
// its frames are no publication). A reply is never left out: the core's replies are Node's, in Node's places. After the last input the
// core's state, read again behind one more round trip, is Node's last.
//
// Declared, with their reasons (MANIFEST `normalized`):
//  - Clock readings. Each side's clock froze at its own epoch (Node's recorder's, the core's freeze) and moved by the same moves: a
//    reading is compared as its virtual milliseconds since that side's epoch, exactly. A duration ending at a reading (`elapsedMs` beside
//    `completedAt`) is compared as its two ends, each read so.
//  - Values that are each run's own: the thread's id, the core's and the model endpoint's process ids and ports.
//  - `host.startProject` and `host.deleteSession`: the desktop host's own calls in Node's recorder, not a phone's; the core has no host,
//    so the first is not made and the second is made by the phone's `deleteSession`. Their replies are not compared.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-history-core.mjs --only <case>[,<case>]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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

// HISTORY_NODE_DIR: a folder of recordings not yet installed (a recorder change being tried); the installed fixture otherwise.
const NODE_DIR = process.env.HISTORY_NODE_DIR ? pathToFileURL(`${process.env.HISTORY_NODE_DIR.replace(/[\\/]$/, '')}/`) : new URL('./remote-protocol-chat-history.node/', import.meta.url);
/** Node's recording of `name`. */
export function nodeHistory(name) {
  for (const file of readdirSync(NODE_DIR).filter((f) => /^\d+\.json$/.test(f))) {
    const recording = JSON.parse(readFileSync(new URL(file, NODE_DIR), 'utf8'));
    if (recording.name === name) return { file, ...recording };
  }
  throw new Error(`no Node recording of ${name} in ${NODE_DIR.pathname}`);
}

const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const isPhone = (input) => input.input !== 'provider write' && input.input !== 'clock';

/**
 * The normalizer of one side: `instant(ms)` reads a wall clock reading as virtual milliseconds since the side's epoch; `own` the side's
 * own values. The same rules on both sides.
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

/** A side's clock reading as the virtual milliseconds since its clock froze at `epoch` (null: not a reading of that clock). */
const instantOf = (epoch) => (v) => (v >= epoch && v < epoch + 1e9 ? v - epoch : null);

/** Node's history of a case, normalized: entries `{ kind: 'state', value }` / `{ kind: 'reply', input, value }`, and its phone inputs. */
export function nodeSide(recording) {
  const instant = instantOf(recording.manifest.epoch);
  const norm = normalizer({ instant, own: new Map([[recording.id, '<session>']]) });
  const history = recording.history.map((h, at) => (h.kind === 'reply' ? { at, kind: 'reply', input: h.input, value: norm(h.error !== undefined ? { error: h.error } : { reply: h.reply }) } : { at, kind: 'state', value: norm(h.snapshot) }));
  // The thread list the phone heard (the host's catalog publications), each at its clock.
  const roster = recording.roster.map((p) => ({ clock: p.clock, sessions: norm(p.sessions) }));
  return { history, inputs: recording.inputs, roster };
}

/** Every difference between two normalized values, at its deepest path: `{ path, node, core }` each. */
export function allDifferences(node, core, path = '') {
  if (JSON.stringify(node) === JSON.stringify(core)) return [];
  if (node && core && typeof node === 'object' && typeof core === 'object' && Array.isArray(node) === Array.isArray(core)) {
    return [...new Set([...Object.keys(node), ...Object.keys(core)])].flatMap((key) => allDifferences(node[key], core[key], `${path}.${key}`));
  }
  return [{ path: path || '.', node, core }];
}

/** Every top-level field in which two normalized states differ (for the report of a state the core never reached). */
export function differingFields(node, core) {
  return Object.keys({ ...node, ...core }).filter((k) => JSON.stringify(node?.[k]) !== JSON.stringify(core?.[k])).map((k) => ({ field: k, node: node?.[k], core: core?.[k] }));
}

/** How many entries of each kind `entries` holds: `{ state, reply }`. */
const kinds = (entries) => ({ state: entries.filter((e) => e.kind === 'state').length, reply: entries.filter((e) => e.kind === 'reply').length });

/**
 * Lists every difference between Node's history and the core's log, so one differing field does not hide the next. Node's entries pair
 * in order with the core's (a state with a state, a reply with a reply to the same input), the pairing that differs least in all (the
 * count of differing leaves); the core's states between two pairs are left out, as an equal state between two of Node's always was.
 * A Node entry the core has nothing for in its place (a state it never published, a reply that came before a state Node published
 * first) is a difference of path `missing`. Each difference: `{ entry: Node's position, kind, input?, path, node, core }`.
 */
export function alignHistory(node, core) {
  const MISSING = 1_000_000;
  const pairs = node.map((want) => core.map((got) => (got.kind !== want.kind || got.input !== want.input ? null : allDifferences(want.value, got.value))));
  // cost[i][j]: the least cost of Node's first i entries against the core's first j.
  const cost = Array.from({ length: node.length + 1 }, (_, i) => Array.from({ length: core.length + 1 }, (_, j) => (i === 0 ? 0 : j === 0 ? i * MISSING : Infinity)));
  const step = Array.from({ length: node.length + 1 }, () => new Array(core.length + 1).fill(''));
  for (let i = 1; i <= node.length; i += 1) {
    for (let j = 1; j <= core.length; j += 1) {
      const options = [['pair', pairs[i - 1][j - 1] ? cost[i - 1][j - 1] + pairs[i - 1][j - 1].length : Infinity], ['skip', cost[i][j - 1]], ['missing', cost[i - 1][j] + MISSING]];
      const [move, value] = options.reduce((best, o) => (o[1] < best[1] ? o : best));
      cost[i][j] = value;
      step[i][j] = move;
    }
  }
  const differences = [];
  for (let i = node.length, j = core.length; i > 0; ) {
    const want = node[i - 1];
    const label = { entry: want.at, kind: want.kind, ...(want.input ? { input: want.input } : {}) };
    const move = j === 0 ? 'missing' : step[i][j];
    if (move === 'skip') j -= 1;
    else if (move === 'missing') {
      differences.unshift({ ...label, path: 'missing', node: want.value, core: null });
      i -= 1;
    } else {
      differences.unshift(...pairs[i - 1][j - 1].map((d) => ({ ...label, ...d })));
      i -= 1;
      j -= 1;
    }
  }
  return differences;
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
    .flatMap((h) => (h === submitReply ? [h, ...beforeReply.slice(-1).map((s) => ({ ...s, at: h.at }))] : [h]));
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
  const roster = [];
  let core;
  let clockServer;
  let clockSocket;
  let clock;
  let watcher;
  let provider;
  const clients = [];
  let failure = null;
  let result = null;
  let hasSeeded = false;
  // `matched`: how many of Node's entries the core has as many entries of each kind for.
  const reached = { matched: 0 };
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
    // The core's clock (mixdog-rt virtual_clock.rs): it connects here as it boots, and moves only when this replay says so.
    clockServer = createServer();
    const clockLine = latch();
    let clockBuffer = '';
    const clockReplies = [];
    clockServer.on('connection', (socket) => {
      clockSocket = socket;
      socket.setEncoding('utf8');
      // The core ending its side (it exited, or its control thread did) fails what waits on its clock, with its own last words.
      const lost = (error) => {
        const why = new Error(`the core's clock connection ended (${error?.message ?? 'closed'}); core: ${core?.tail?.() ?? ''}`);
        clockLine.reject(why);
        for (const reply of clockReplies.splice(0)) reply.reject(why);
      };
      socket.on('error', lost);
      socket.on('close', () => lost());
      socket.on('data', (chunk) => {
        clockBuffer += chunk;
        for (let at = clockBuffer.indexOf('\n'); at >= 0; at = clockBuffer.indexOf('\n')) {
          const line = clockBuffer.slice(0, at).trim();
          clockBuffer = clockBuffer.slice(at + 1);
          if (line.startsWith('hello ')) clockLine.resolve(line);
          else clockReplies.shift()?.resolve(line);
        }
      });
    });
    await new Promise((resolve) => clockServer.listen(0, '127.0.0.1', resolve));
    clock = (command) => {
      const reply = latch();
      clockReplies.push(reply);
      clockSocket.write(`${command}\n`);
      return deadline.race(reply.promise, `the core's clock to answer ${command}`).then((line) => Number(/^now (\d+)$/.exec(line)?.[1]));
    };
    core = launch(bin, ['serve'], { env: daemonEnv(paths, { RUST_LOG: 'warn', MIXDOG_VIRTUAL_CLOCK: `127.0.0.1:${clockServer.address().port}` }), cwd: paths.envRoot });
    await deadline.race(clockLine.promise, 'the core to connect to the replay clock (a mixdogd built with --features virtual-clock)');
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
    // Frozen once the core serves, as Node's clocks froze once its host was attached; from here it moves with Node's recorded moves.
    const frozenAt = await clock('freeze');
    let clockAt = 0;

    // The core's own values, named as Node's recording names its own.
    let threadId = '';
    const own = () => new Map([[String(core.pid), '<pid:daemon>'], [new URL(provider.baseURL).port, '<port:model>'], [String(doc.core.rpc.port), '<port:daemon>'], ...(threadId ? [[threadId, '<session>']] : [])]);
    // The core's clock reads the instant it froze plus what this replay advanced, as Node's reads its epoch plus its virtual time.
    const instant = instantOf(frozenAt);
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
    // Ends the core's current window once it holds as many entries of each kind as Node's: pairs the two and lists their differences.
    // The barrier before one of Node's inputs: the core has published as many entries of each kind as Node had before it (the core's
    // states between two of Node's included). Which of them pair is alignHistory's, once the case is over.
    const owe = async (owed, what) => {
      const want = kinds(owed);
      await until(() => {
        const got = kinds(log);
        return got.state >= want.state && got.reply >= want.reply;
      }, what);
      reached.matched = owed.length;
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
      // What the submitting phone's thread list hears, each at the clock the core stood at.
      const ctx = { phone: { start: async () => undefined }, sessionsCatalog: { publish: (rows) => { if (viewing) roster.push({ clock: clockAt, sessions: norm(rows) }); wake(); } } };
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
      const owed = compared.filter((h) => h.at < input.at);
      await owe(owed, `the core to publish as many entries as Node's ${owed.length} before ${input.input}`);
      // Node's clocks stood at `input.clock` for this input (its own moves, and the recorder's `afterInputMs` after each input): the
      // core's moves as far.
      if (input.clock > clockAt) await clock(`advance ${input.clock - clockAt}`);
      clockAt = Math.max(clockAt, input.clock);
      if (input.input === 'clock') continue;
      // The model endpoint's next write, of the kind Node released here, once the core has asked for it.
      if (!isPhone(input)) {
        // Node's connection warm-up (http-agent.mjs:504-539 `preconnect`): a HEAD whose answer is dumped and whose failure is ignored, so
        // nothing of it reaches the state; the core keeps no such warm-up and has no request to release.
        if (kindOf(input.key).startsWith('HEAD / ')) continue;
        await until(() => provider.release(kindOf(input.key)), `the core to ask the model endpoint for ${kindOf(input.key)} (Node's write ${input.step})`);
        continue;
      }
      if (input.input === 'host.startProject') continue;
      if (input.input === 'phone.abortSession twice') {
        // Both Stops in one tick, as Node's recorder made them; their replies in call order.
        const [phone, method, args] = argsOf('phone.abortSession');
        const settled = await Promise.allSettled([0, 1].map(() => deadline.race(phone.router.call(method, args), `the replies to ${input.input}`)));
        for (const [n, s] of settled.entries()) log.push({ kind: 'reply', input: `${input.input} ${n + 1}`, value: norm(s.status === 'fulfilled' ? { reply: plain(s.value) } : { error: String(s.reason?.message ?? s.reason) }) });
        wake();
        continue;
      }
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
    await owe(compared, `the core to publish as many entries as Node's ${compared.length}`);
    // The core's state behind one more round trip is still Node's last.
    await deadline.race(submitter.client.call('thread/read', { threadId, window: { lastItems: 1 } }), 'the round trip after the case');
    const lastNode = compared.findLast((h) => h.kind === 'state');
    const lastCore = log.findLast((e) => e.kind === 'state');
    const after = allDifferences(lastNode.value, lastCore.value).map((d) => ({ entry: 'after the last input', kind: 'state', ...d }));
    const heard = allDifferences(node.roster, roster).map((d) => ({ entry: 'roster', kind: 'roster', ...d }));
    const differences = [...alignHistory(compared, log), ...after, ...heard];
    const entries = compared.length;
    const coreStates = log.filter((e) => e.kind === 'state').length;
    return (result = differences.length ? { name, pass: false, error: `${differences.length} differences`, differences, matched: reached.matched, log, roster } : { name, pass: true, entries, coreStates });
  } catch (error) {
    failure = error;
    return (result = { name, pass: false, error: String(error?.message ?? error).slice(0, 8000), comparison: error.comparison ?? null, differences: alignHistory(compared.slice(0, reached.matched), log), matched: reached.matched, log, roster });
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
      if (clockServer) {
        clockSocket?.destroy();
        await ending.race(new Promise((resolve) => clockServer.close(resolve)), 'the replay clock to close');
      }
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
  const brief = (v) => (JSON.stringify(v) ?? 'absent').slice(0, 300);
  for (const r of results) {
    console.log(r.pass ? `ok ${r.name} (${r.entries} entries, ${r.coreStates} core states)` : `FAIL ${r.name} at Node's entry ${r.matched}: ${r.error}${r.comparison ? `\n${JSON.stringify(r.comparison).slice(0, 4000)}` : ''}`);
    for (const d of r.differences ?? []) console.log(`  ${d.entry} ${d.kind}${d.input ? ` ${d.input}` : ''} ${d.path}: node ${brief(d.node)} | core ${brief(d.core)}`);
  }
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
