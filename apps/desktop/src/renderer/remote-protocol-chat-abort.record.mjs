// Records what Node's phone gets back from a Stop (`abortSession`), for every case Node's abort distinguishes (abort.mjs:112-221): Node's own
// daemon and SessionHost from the exact export of b6f10295a, run unchanged, with a model endpoint that holds the turn open
// (remote-protocol-chat-abort-provider.mjs). Each case runs in its own world (a fresh environment, its own daemon and host) on a fresh thread: the first prompt starts a turn the endpoint holds, the phone's Stop
// (`host.abortSession`) is sent once the turn is in the state the case names, and the host's whole reply and the thread's stored row after the
// turn ended are recorded.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-abort.record.mjs <export dir> <out file> <real-turn-harness dir> [--only <case name>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ABORT_CASES, ASKED_PROJECT_FILE, DEVICES, HOOK_RULES, PROJECT_FILE } from './remote-protocol-chat-abort-cases.mjs';
import { endLeftovers, leftBy } from './remote-protocol-chat-abort-procs.mjs';
import { startAbortProvider } from './remote-protocol-chat-abort-provider.mjs';

const [exportDir, outFile, harness, flag, only] = process.argv.slice(2);
if (!harness || (flag !== undefined && (flag !== '--only' || !only))) throw new Error('usage: <export dir> <out file> <real-turn-harness dir> [--only <case name>]');
// `--only` records one case into <out file> (for working on that case); the committed recording is the full run.
const CASES = only === undefined ? ABORT_CASES : ABORT_CASES.filter((c) => only.split(',').includes(c.name));
if (!CASES.length) throw new Error(`--only names no abort case: ${JSON.stringify(only)}`);
const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const NODE_CHECKOUT = 'C:/Project/mixdog';

// The export is exact only if every file of the commit's tree is in it: byte for byte (git blob ids), or, for a text file the archive wrote
// with CRLF (* text=auto), the same bytes once CRLF is read as the LF the repository stores.
const listing = execFileSync('git', ['-C', NODE_CHECKOUT, 'ls-tree', '-r', COMMIT], { maxBuffer: 1 << 28 }).toString().trim().split('\n');
const blobId = (b) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const mismatched = [];
let checked = 0;
for (const line of listing) {
  const [meta, path] = line.split('\t');
  const [mode, , sha] = meta.split(' ');
  if (mode === '160000' || mode === '120000') continue;
  let body;
  try { body = readFileSync(join(exportDir, path)); } catch { mismatched.push(`${path} (missing)`); continue; }
  checked += 1;
  if (blobId(body) !== sha && blobId(Buffer.from(body.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')) !== sha) mismatched.push(path);
}
if (mismatched.length) throw new Error(`the export is not b6f10295a: ${mismatched.length} files differ, e.g. ${mismatched.slice(0, 3).join(', ')}`);

const load = (path) => import(pathToFileURL(join(exportDir, 'apps/desktop/src', path)).href);
const hload = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
process.env.HARNESS_ENV_ROOT = join(harness, 'run', 'env-ph2-chat-abort-node');
const { daemonEnv, isolatedPaths } = await hload('env.mjs');
const { createDeadline, latch } = await hload('deadline.mjs');
const envPaths = isolatedPaths();
const project = join(envPaths.workspace, 'a');
/** Every case starts in the same declared environment, clean: the env folder removed and made again (data, runtime, app data, temp,
 *  the project with its two files, the hook rules and the provider config), so nothing one case leaves (the prompt history, the stored
 *  threads, the daemon) is seen by the next. */
const freshEnvironment = (baseURL) => {
  try {
    rmSync(envPaths.envRoot, { recursive: true, force: true });
  } catch (error) {
    // Who holds the folder is named with the failure (no daemon tree is left by then: -1 walks none).
    throw new Error(`${error.message}; processes naming the folder: ${JSON.stringify(leftBy(-1, envPaths.envRoot).map((p) => [p.ProcessId, p.Name, p.CommandLine]))}`);
  }
  for (const d of [envPaths.dataDir, envPaths.runtimeRoot, envPaths.appData, envPaths.localAppData, envPaths.tmp, envPaths.workspace]) mkdirSync(d, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, PROJECT_FILE.name), PROJECT_FILE.text);
  writeFileSync(join(project, ASKED_PROJECT_FILE.name), ASKED_PROJECT_FILE.text);
  writeFileSync(join(envPaths.dataDir, 'hooks.json'), JSON.stringify(HOOK_RULES));
  writeFileSync(join(envPaths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
};
const route = { provider: 'custom-harness', model: 'harness-model' };
const plain = (value) => JSON.parse(JSON.stringify(value));
/** A state's content regardless of key order (the phone's decoder writes keys in its own order). */
const contentKey = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
for (const key of Object.keys(process.env)) if (/^MIXDOG_/i.test(key)) delete process.env[key];
Object.assign(process.env, daemonEnv(envPaths));
// The daemon is forked with this process's flags; it runs as a plain script.
process.execArgv = [];
const { SessionHost } = await load('main/session-host.ts');
const sessionClient = await import(pathToFileURL(join(exportDir, 'src/standalone/session-client.mjs')).href);
const { createSessionProtocolClient } = await import(pathToFileURL(join(exportDir, 'src/standalone/session-protocol.mjs')).href);
const { createDesktopRuntime } = await import(pathToFileURL(join(exportDir, 'src/standalone/daemon-desktop-runtime.mjs')).href);
const { createPushNotifier } = await load('main/push-notifier.ts');
const { sessionRemoteMethods } = await load('main/remote-session-methods.ts');
const { createRelaySessionStateFanout } = await load('main/remote-relay-session-state.ts');
const { createSnapshotDeltaDecoder } = await load('main/state-delta.ts');

/** One case in its own world: a fresh environment, Node's daemon and SessionHost started for it and ended after it. */
async function recordCase(c, provider) {
  freshEnvironment(provider.baseURL);
  let discovery;
  let host;
  let frames = [];
  let lastId = '';
  const deadline = createDeadline(240_000, () => `node abort recording of ${c.name}; frames seen: ${frames.length}; last frame: ${frames.at(-1)?.slice(0, 600)}; snapshot: ${JSON.stringify(Object.keys(host?.getSnapshot(lastId) ?? {}))} ${host?.getSnapshot(lastId)?.status}; provider requests: ${JSON.stringify(provider.requests.map((r) => [r.held, r.prompt.slice(0, 40)]))}`);
  // Each step ends whether or not the one before it did: a host that fails to dispose still has its daemon shut down.
  let ending;
  const end = () => (ending ??= endWorld());
  const endWorld = async () => {
    deadline.clear();
    const ended = createDeadline(90_000, () => `ending the world of ${c.name}`);
    try {
      try {
        try {
          if (host) await ended.race(host.dispose(), 'the host to dispose');
        } finally {
          // Node's own bounded wait for the daemon to exit, under this deadline too.
          if (discovery) await ended.race(sessionClient.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 60_000 }), `the Node daemon of ${c.name} to exit`);
        }
      } finally {
        // Whatever the case started that is still running is ended, and proved ended, before the next case's folder is made again.
        const left = endLeftovers(Number(discovery?.pid) || 0, envPaths.envRoot);
        if (left.length) {
          leftovers.push({ case: c.name, left });
          process.stderr.write(`${c.name}: left running after the daemon's shutdown: ${JSON.stringify(left)}\n`);
        }
      }
    } finally {
      ended.clear();
    }
  };
  try {
    discovery = await deadline.race(sessionClient.ensureDaemon({ cwd: envPaths.workspace, attempts: 1, readyTimeoutMs: 60_000 }), 'the Node daemon');
    const waiters = new Set();
    const wake = () => waiters.forEach((check) => check());
    const until = (ready, what) => {
      const done = latch();
      const check = () => { if (ready()) { waiters.delete(check); done.resolve(); } };
      waiters.add(check);
      check();
      return deadline.race(done.promise, what);
    };
    const runtime = {
      ...createDesktopRuntime({ getLocalSessionBridge: () => null }),
      attachSessionClient: async (options) => {
        const attached = await sessionClient.attachSession({
          discovery,
          cwd: envPaths.workspace,
          onFrame: (frame) => { frames.push(JSON.stringify(frame)); options.onFrame(frame); wake(); },
          onFatal: options.onFatal,
        });
        return createSessionProtocolClient({ call: (name, args, callOptions) => attached.call(name, args, callOptions), close: (reason) => attached.close(reason) });
      },
    };
    host = await deadline.race(SessionHost.create({ userDataPath: envPaths.appData, resourcesPath: envPaths.workspace, appPath: envPaths.workspace, packaged: false }, runtime), 'the session host');
    // Everything the phone is told of a thread, in the order the host told it: each session state the host published for it
    // (`subscribeSessionStates`, what remote-relay-session-wiring.ts:203-207 hands the phone's fanout), each change of its list row in a
    // roster the host published (`subscribeSessions`, what the phone's catalog is sent), and each reply to the phone's own calls. A state or
    // row equal to the one before it is no change and not kept.
    const told = [];
    // What the phone received, as delivered: the replies, the state frames its fanout leg decoded, the roster rows.
    const phoneTold = [];
    const lastState = new Map();
    const lastPhoneState = new Map();
    const lastRow = new Map();
    let published = [];
    host.subscribeSessions((rows) => {
      published = rows;
      const listed = new Map(rows.map((row) => [row.id, row]));
      for (const id of new Set([...lastRow.keys(), ...listed.keys()])) {
        const row = listed.has(id) ? plain(listed.get(id)) : null;
        if (JSON.stringify(row) === JSON.stringify(lastRow.get(id) ?? null)) continue;
        lastRow.set(id, row);
        told.push({ sessionId: id, kind: 'row', row });
        phoneTold.push({ sessionId: id, kind: 'row', row });
      }
      wake();
    });
    host.subscribeSessionStates((update) => {
      const snapshot = plain(update.snapshot ?? null);
      const key = contentKey(snapshot);
      if (lastState.get(update.sessionId) === key) return;
      lastState.set(update.sessionId, key);
      told.push({ sessionId: update.sessionId, kind: 'state', frameSource: update.frameSource ?? null, snapshot });
      wake();
    });
    // The approvals a notification's Allow may answer: Node's push notifier, fed the host's session states as remote-relay-session-wiring.ts:148,203-204
    // feeds it, handed to the phone's table as remote-relay.ts:468-472 hands it. It is created disabled: it sends no push (nothing here could
    // receive one); the shown approvals it keeps do not depend on that (push-notifier.ts onSessionState sets them first).
    const notifier = createPushNotifier({ store: {}, isEnabled: () => false, readFinalAnswer: async () => null, isClientForeground: () => false });
    host.subscribeSessionStates((update) => notifier.onSessionState(update));
    // What the phone receives: the host's session states through Node's own fanout (remote-relay-session-state.ts
    // `createRelaySessionStateFanout`, fed as remote-relay-session-wiring.ts:203-207 feeds it), to one attached phone leg whose state is a
    // relay client's (remote-relay-clients.ts:284-310) with the wire a current phone negotiates in its hello (remote-relay-client-lifecycle.ts:
    // 123-125 paging and prepend, remote-shim-socket.ts:424 promptHistoryPatch) in the plain envelope, decoded as the phone decodes it
    // (remote-shim-dispatch.ts:228-254, `createSnapshotDeltaDecoder`). The leg shows no session until the phone learns one from a reply;
    // then the session is made visible and the newest state re-sent, as the phone's view sync does (remote-view-sync.ts:152, a baseline of
    // the newest state). A frame's send settles on the next turn of the event loop, as a socket write does; the mailbox drains then.
    const phoneLeg = {
      channel: {}, syncing: false, visibleSessionIds: new Set(), requestedReads: new Set(), sessionStateEncoders: new Map(),
      compactWire: false, transcriptPaging: true, transcriptPrepend: true, promptHistoryPatch: true,
      sessionHandles: new Map(), openedAt: Date.now(), firstTranscriptReported: false,
    };
    const decoders = new Map();
    const fanout = createRelaySessionStateFanout({
      clients: new Map([['phone', phoneLeg]]),
      sendEncryptedFrame: (_clientId, payload) => {
        const { sessionId, wire } = payload.payload;
        if (!decoders.has(sessionId)) decoders.set(sessionId, createSnapshotDeltaDecoder());
        const decoded = decoders.get(sessionId).decode(wire);
        if (!decoded.ok) throw new Error(`the phone could not decode a state frame of ${sessionId}`);
        const snapshot = plain(decoded.snapshot ?? null);
        phoneTold.push({ sessionId, kind: 'state', snapshot });
        lastPhoneState.set(sessionId, contentKey(snapshot));
        if (decoded.snapshot === null) decoders.delete(sessionId);
        wake();
        return new Promise((resolve) => setImmediate(resolve));
      },
    });
    host.subscribeSessionStates((update) => fanout.publish(update));
    const showOnPhone = (sessionId) => {
      if (!sessionId || phoneLeg.visibleSessionIds.has(sessionId)) return;
      phoneLeg.visibleSessionIds.add(sessionId);
      fanout.refresh(sessionId);
    };
    const approvalNotifications = {
      approvalAllowDecision: (sessionId, approvalId) => notifier.approvalAllowDecision(sessionId, approvalId),
      approvalPointerOnly: (sessionId, approvalId) => notifier.approvalPointerOnly(sessionId, approvalId),
    };
    /** The session state the host holds for a thread (the daemon's session-state frames folded: session-host-publication.ts projections). */
    const sessionState = (id) => host.publication.projections.get(id)?.snapshot;
    const idle = (id) => host.getSnapshot(id)?.busy === false;
    // The phone's entry into the host: remote-session-methods.ts `sessionRemoteMethods`, one table per paired device (its `deviceName` is what the
    // relay names the connection after). It validates the options as the phone's call is validated (`requiredSubmitOptions`, `requiredAbortOptions`),
    // stamps the connection's device on the submission and on the Stop, and calls `host.submitNewTask` / `submitToSession` / `abortSession`
    // (remote-session-methods.ts:149-167); nothing between the phone's frame and the host is skipped.
    const phones = new Map();
    const phone = (device) => {
      if (!phones.has(device)) {
        const methods = sessionRemoteMethods(host, { deviceName: async () => device }, undefined, approvalNotifications);
        // Each call's reply is told to the phone in its place among the pushes.
        phones.set(device, new Proxy(methods, {
          get: (table, method) => async (args) => {
            // Every call of the table but submitNewTask names its thread first; a new task's thread is the one its reply names.
            const sessionId = method === 'submitNewTask' ? undefined : args?.[0];
            let reply;
            try {
              reply = plain((await table[method](args)) ?? null);
            } catch (error) {
              const failed = { sessionId, kind: 'reply', method, device, error: String(error?.message ?? error) };
              told.push(failed);
              phoneTold.push(failed);
              throw error;
            }
            const answered = { sessionId: sessionId ?? reply?.sessionId, kind: 'reply', method, device, reply };
            told.push(answered);
            phoneTold.push(answered);
            // The phone opens the thread its reply names (the new task's), which makes it visible to its leg.
            showOnPhone(answered.sessionId);
            return reply;
          },
        }));
      }
      return phones.get(device);
    };
    const since0 = Date.now();
    const submitter = phone(c.submitter ?? DEVICES.a);
    const canceller = phone(c.canceller ?? c.submitter ?? DEVICES.a);
    const at = (what) => process.stderr.write(`${c.name}: ${what}\n`);
    at('startProject');
    await deadline.race(host.startProject(project), 'startProject');
    const submit = { id: `sub-${c.name}`, ...(c.pasted ? { pastedTexts: c.pasted } : {}), ...(c.submit ?? {}) };
    at('submitNewTask');
    const accepted = await deadline.race(submitter.submitNewTask([c.prompt, submit, { projectPath: project, route }]), 'submitNewTask of '+c.name);
    const id = accepted.sessionId;
    lastId = id;
    const turns = c.then ? 2 : 1;
    const closed = () => frames.some((f) => f.includes(id) && f.includes(`"turns":${turns}`)) && idle(id);
    if (c.ready === 'completed') await until(closed, `the turn of ${c.name} to end on its own`);
    else if (c.ready === 'approval' || c.ready === 'ask') {
      await deadline.race(provider.asked(c.prompt), `the model endpoint to receive the tool-calling turn of ${c.name}`);
      // The Stop comes while the person sees the call's card and its question: the card is opened by the turn's tool batch
      // (`openToolBatch`, turn-tool-cards.mjs) independently of the approval the eager run raises, so both are waited for.
      await until(() => sessionState(id)?.toolApproval && sessionState(id)?.items?.some((item) => item?.kind === 'tool'), `the tool approval of ${c.name} to be pending in the host with its card shown`);
    } else await deadline.race(provider.held(c.prompt), `the model endpoint to receive the held turn of ${c.name}`);
    if (c.output) await until(() => frames.some((f) => f.includes(c.output)), `the streamed text of ${c.name} to reach the host`);
    if (c.then) {
      await deadline.race(submitter.submitToSession([id, c.then, { id: `sub-${c.name}-2` }]), `submitToSession of the queued prompt of ${c.name}`);
      await until(() => frames.some((f) => f.includes(c.then)), `the queued prompt of ${c.name} to reach the host`);
    }
    // A notification's answers, in order, each to the approval the phone was shown (the host's state) or to an id it was not.
    const answers = [];
    let shownId;
    for (const [n, step] of (c.notify ?? []).entries()) {
      // 'shown' is the approval the phone was shown when it first answered one: a later answer goes to the same approval.
      const approvalId = step.id === 'shown' ? (shownId ??= String(sessionState(id)?.toolApproval?.id ?? '')) : step.id;
      if (!approvalId) throw new Error(`${c.name}: no approval is shown for notification answer ${n}`);
      at(`notify ${n} ${step.action}`);
      answers.push(await deadline.race(submitter.answerApprovalNotification([id, approvalId, step.action]), `answerApprovalNotification ${n} of ${c.name}`));
    }
    const stopAt = Date.now();
    let reply = null;
    if (c.stop) {
      at('abort');
      reply = plain(await deadline.race(canceller.abortSession([id, c.stop]), 'abortSession of '+c.name));
    }
    await until(closed, `the turn(s) of ${c.name} to close${c.stop ? ' after its Stop' : ''}`);
    if (c.requeued) await deadline.race(provider.held(c.prompt, 2), `the model endpoint to receive the second, requeued turn of ${c.name}`);
    const second = c.again ? plain(await deadline.race(canceller.abortSession([id, c.again]), `the second abortSession of ${c.name}`)) : undefined;
    // What the stopped turn left in the stored thread, whole: the transcript rows the host holds and the thread's list row.
    // Node publishes a thread's row to subscribers (`subscribeSessions`) when the daemon's session-summary for it reaches the host
    // (session-host-catalog.ts:228-240 `publishCatalogs`, called from the daemon's summary handler, session-host-lifecycle.ts:949-950);
    // `listSessions` answers from those rows. The row is read once the host holds the one the turn's close stamped (`updatedAt` not before the
    // Stop; for a turn that ended on its own, not before the prompt): an earlier publication of the same thread is a row the Stop has not reached.
    const stampedAfter = c.ready === 'completed' || !c.stop ? since0 : stopAt;
    // The recording ends where Node settles, not at the first sign of the close: the row the daemon's summary sends once the turn's
    // close reached it (no `working` flag: session-host-catalog.ts:228-240, a summary still marking the turn is an earlier one) unless
    // a requeued turn runs on; the turn's close's context sync (turn.mjs:350,366 `syncContextStats` → context-state.mjs:116-134 sets
    // `displayContextWindow` from the window the route resolved); and the phone's fanout drained to the host's newest state.
    const rowSettled = () => {
      const r = published.find((x) => x.id === id);
      return (r?.updatedAt ?? 0) >= stampedAfter && (c.requeued || (!r.working && !r.leadWorking));
    };
    await until(rowSettled, `the thread row of ${c.name} stamped by its close to be published`);
    const contextSynced = () => !(Number(sessionState(id)?.contextWindow) > 0) || Number(sessionState(id)?.displayContextWindow) > 0;
    await until(contextSynced, `the context sync of ${c.name}'s close to reach the host`);
    await until(() => lastPhoneState.get(id) === lastState.get(id), `the phone's leg of ${c.name} to receive the host's newest state`);
    const row = plain((await deadline.race(host.listSessions(), `listSessions after ${c.name}`)).find((r) => r.id === id) ?? null);
    const items = plain((await deadline.race(host.readSessionTranscript(id), `readSessionTranscript after ${c.name}`)).items);
    // What the composer of the device that sent the prompt is told: the session state's `promptRestore`.
    const promptRestore = plain(sessionState(id)?.promptRestore ?? null);
    // A requeued turn runs on; the thread is deleted once recorded so the daemon has no turn left when it is shut down.
    if (c.requeued) await deadline.race(host.deleteSession(id), `deleteSession of ${c.name}`);
    const ofThread = (events) => events.filter((event) => event.sessionId === id).map(({ sessionId: _id, ...event }) => event);
    // `stream`: what the phone received, in order; `hostStream`: every state the host published (and the rows and replies), for reference.
    const recorded = { name: c.name, id, stop: c.stop ?? null, ...(c.again ? { again: c.again } : {}), node: { reply, ...(second ? { second } : {}), ...(c.notify ? { answers } : {}), items, row, promptRestore, stream: ofThread(phoneTold), hostStream: ofThread(told) } };
    await end();
    return recorded;
  } catch (error) {
    // The failure that stopped the recording is the one reported; a failure to end what was started is printed beside it.
    await end().catch((ending) => process.stderr.write(`ending the world of ${c.name} failed too: ${ending?.stack ?? ending}\n`));
    throw error;
  }
}

// The model endpoint answers by prompt (each case's prompt is its own) and is shared by the cases; it is closed on every path.
const provider = await startAbortProvider();
const cases = [];
const leftovers = [];
try {
  for (const c of CASES) cases.push(await recordCase(c, provider));
} finally {
  const closing = createDeadline(60_000, () => 'the model endpoint to close');
  try { await closing.race(provider.close(), 'the model endpoint to close'); } finally { closing.clear(); }
}
writeFileSync(outFile, `${JSON.stringify({
  manifest: { exact: true, commit: COMMIT, filesVerified: checked, environment: 'one fresh environment per case (freshEnvironment): its own data, runtime, app data, temp and project folders, hook rules and provider config; its own Node daemon and SessionHost', leftovers, source: 'Node daemon + SessionHost from the exact export, run unchanged; model endpoint remote-protocol-chat-abort-provider.mjs' },
  cases,
}, null, 2)}\n`);
console.log(`recorded ${cases.length} abort cases`);
process.exit(0);
