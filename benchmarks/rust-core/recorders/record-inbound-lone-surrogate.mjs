#!/usr/bin/env node
// What Node (b6f10295a, an exact export) answers a paired phone whose sealed frames hold unpaired UTF-16 surrogate escapes, invalid
// UTF-8, a BOM, or no JSON at all: the frames go over Node's real inbound path, as bytes. A scripted relay (a WebSocket server) carries
// them to Node's real relay (`startRemoteRelay`, remote-relay.ts): the client lifecycle opens each box and parses it
// (`decryptJson`, shared/remote-e2ee.ts:692, a non-fatal TextDecoder and JSON.parse) or closes the client
// (remote-relay-client-lifecycle.ts:94-98), and the call dispatch runs the real method table (`executeRemoteFrame` over
// `createRemoteMethods`) on a real `SessionHost` and the real desktop operations, over a scratch world. The phone is the app's own end
// of the E2EE channel (`createRelayE2EEClientHandshake`); lib/raw-frame-bytes.mjs makes it seal exact bytes.
//
// Per step: the plaintext bytes sealed (hex), and what the phone got: the answer frame for its id, or the relay's `close-client` with
// its reason. After the steps: the bytes of every file in the project folder and the preferences file Node wrote.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-inbound-lone-surrogate.mjs --tree D:\mixdog-build\tmp\b6f-tree [--only <step>]
//   ... --replay <path to mixdogd.exe>     (the same steps against the core, compared whole)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, sha256, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { frame } from './lib/raw-frame-bytes.mjs';
import { PROJECT, loneRefusal, ROOT, STEPS, WORKSPACE, buildWorld } from './lib/inbound-lone-surrogate-cases.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SET = join(FIXTURES_ROOT, 'inbound-lone-surrogate');
const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER_FILES = [
  'record-inbound-lone-surrogate.mjs',
  'lib/inbound-lone-surrogate-cases.mjs',
  'lib/inbound-lone-surrogate-replay.mjs',
  'lib/raw-frame-bytes.mjs',
  'lib/common.mjs',
  'lib/phone-relay-core.mjs',
  'lib/phone-files-replay.mjs',
  'lib/phone-files-script.mjs',
  'lib/core-stop.mjs',
  'lib/process-job.mjs',
];
const args = parseArgs();
const REPLAY = args.get('replay') ?? null;
const ONLY = args.get('only') ?? null;
// One deadline per awaited event; an event that never comes fails the run with what was awaited.
const WAIT_MS = 30_000;
const hex = (bytes) => Buffer.from(bytes).toString('hex');

if (REPLAY) {
  const { replay } = await import('./lib/inbound-lone-surrogate-replay.mjs');
  process.exit(await replay({ exe: REPLAY, golden: JSON.parse(readFileSync(join(SET, 'golden.json'), 'utf8')), only: ONLY }));
}

const tree = resolveTree(args);
const identity = exactProductIdentity(tree, COMMIT);

// Nothing of the signed-in profile is read or written: Node's state lives beside the world.
const STATE = `${ROOT}-node-state`;
rmSync(STATE, { recursive: true, force: true });
const USER_DATA = join(STATE, 'userData');
for (const dir of ['home', 'data', 'userData']) mkdirSync(join(STATE, dir), { recursive: true });
Object.assign(process.env, {
  MIXDOG_HOME: join(STATE, 'home'),
  MIXDOG_DATA_DIR: join(STATE, 'data'),
  MIXDOG_PROJECTS_FILE: join(STATE, 'projects.json'),
  MIXDOG_REMOTE_METER: '0',
});
buildWorld();

const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const { SessionHost } = await main('session-host');
const { createDesktopOperations } = await main('desktop-operations');
const { codeGraphModuleUrl } = await main('desktop-support');
const { startRemoteRelay } = await main('remote-relay');
const e2ee = await importFrom(tree, 'apps/desktop/src/shared/remote-e2ee.ts');
const store = await importFrom(tree, 'src/runtime/shared/projects.mjs');
const { WebSocketServer } = await import(pathToFileURL(join(tree, 'node_modules/ws/wrapper.mjs')).href);

const sessionClient = { list: async () => ({ sessions: [] }), close: async () => {} };
const host = await SessionHost.create(
  { userDataPath: USER_DATA, resourcesPath: ROOT, appPath: join(tree, 'apps', 'desktop'), packaged: false },
  {
    attachSessionClient: async () => sessionClient,
    loadProjects: async () => store,
    loadSessionStore: async () => ({ listStoredAgentWorkers: () => [] }),
    loadStatuslineSegments: async () => ({}),
    executeCodeGraphTool: async (name, toolArgs, cwd) => (await import(codeGraphModuleUrl(false, ROOT, join(tree, 'apps', 'desktop')))).executeCodeGraphTool(name, toolArgs, cwd),
  }
);
const operations = createDesktopOperations({ userDataPath: USER_DATA, packaged: false, resourcesPath: '', appPath: join(tree, 'apps', 'desktop'), loadConfig: async () => ({}), loadDocumentPreview: () => importFrom(tree, 'src/runtime/office/pdf/document-preview.mjs'), emit() {} });
host.invokeDesktopOperation = (name, operationArgs) => operations.invoke(name, operationArgs);

// ── the relay: every envelope the PC sends is queued per client; a waiter takes the first one of its client ──
const queues = new Map();
const waiters = new Map();
const deliver = (clientId, envelope) => {
  const waiting = waiters.get(clientId);
  if (waiting) {
    waiters.delete(clientId);
    waiting(envelope);
  } else {
    if (!queues.has(clientId)) queues.set(clientId, []);
    queues.get(clientId).push(envelope);
  }
};
const next = (clientId, what) => {
  const queued = queues.get(clientId);
  if (queued?.length) return Promise.resolve(queued.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(clientId);
      reject(new Error(`no envelope for ${clientId} within ${WAIT_MS} ms: ${what}`));
    }, WAIT_MS);
    waiters.set(clientId, (envelope) => {
      clearTimeout(timer);
      resolve(envelope);
    });
  });
};
/** `event`, or a failure naming `what` at the deadline. */
const within = (event, what) => {
  let timer;
  const deadline = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: nothing within ${WAIT_MS} ms`)), WAIT_MS)));
  return Promise.race([event, deadline]).finally(() => clearTimeout(timer));
};
let socket = null;
let tokenSet = null;
const tokenWritten = new Promise((resolve) => (tokenSet = resolve));
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
wss.on('connection', (ws) => {
  socket = ws;
  ws.on('message', (raw, binary) => {
    if (binary) throw new Error('the PC sent a binary envelope to a relay that declared text frames only');
    const envelope = JSON.parse(String(raw));
    if (envelope.type === 'set-client-token') tokenSet();
    if ((envelope.type === 'frame' || envelope.type === 'close-client') && typeof envelope.clientId === 'string') deliver(envelope.clientId, envelope);
  });
});
await within(new Promise((resolve) => wss.once('listening', resolve)), 'the scripted relay listening');
const send = (envelope) => socket.send(JSON.stringify(envelope));

const handle = await startRemoteRelay({
  relayUrl: `ws://127.0.0.1:${wss.address().port}`,
  userDataPath: USER_DATA,
  host,
  appVersion: '0.0.0-fixture',
  hostName: () => 'FIXTURE-PC',
  onClientClaim: async () => ({ approved: true }),
});
await within(tokenWritten, 'the PC sending set-client-token');
send({ type: 'relay-capabilities', textFrames: 1, maxFrameBytes: 1_048_576 });

// ── the phone: one E2EE channel per client; every frame the PC sends it is opened in order ──
const CREDENTIAL = '0123456789abcdef0123456789abcdef';
let clients = 0;
async function openPhone() {
  const clientId = `phone-${++clients}`;
  send({ type: 'client-open', clientId, browserClientId: CREDENTIAL });
  const challenge = await next(clientId, 'the challenge');
  if (challenge.type !== 'frame') throw new Error(`the PC closed ${clientId} instead of challenging it: ${challenge.reason}`);
  const { hello, channel } = await e2ee.createRelayE2EEClientHandshake(handle.pairing, JSON.parse(challenge.data), {});
  send({ type: 'frame', clientId, data: JSON.stringify(hello) });
  const ready = await channel.decryptJson((await next(clientId, 'e2ee-ready')).data);
  if (ready?.type !== 'e2ee-ready') throw new Error(`the PC answered the hello with ${JSON.stringify(ready)}`);
  return { clientId, channel };
}

/** The answer frame for `id` (frames for other ids are pushes, passed over), or the client's close; one deadline for the whole
 *  wait, so pushes arriving faster than the deadline never extend it. */
function outcome(phone, id) {
  const what = id === null ? 'the close of a refused frame' : `the answer to frame ${id}`;
  let abandoned = false;
  const scan = async () => {
    while (!abandoned) {
      const envelope = await next(phone.clientId, what);
      if (envelope.type === 'close-client') return { closed: envelope.reason };
      const opened = await phone.channel.decryptJson(envelope.data);
      if (id !== null && opened?.id === id) {
        const { id: _id, ...answer } = opened;
        return { answer };
      }
    }
  };
  return within(scan(), `${phone.clientId}: ${what}`).finally(() => {
    abandoned = true;
  });
}

/** The project folder: every entry by its relative path (hex of the UTF-8 name Node's file system gives back; a lone unit in a name
 *  is WTF-8 there, which `Buffer.from` writes as EF BF BD, so the entry is also kept by its own name) with its bytes and mtime. */
function folderState(dir = PROJECT, rel = '', out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const at = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.set(at, { dir: true });
      folderState(path, at, out);
    } else {
      out.set(at, { bytes: readFileSync(path), mtime: statSync(path).mtime });
    }
  }
  return out;
}
const preferencesText = () => {
  const file = join(USER_DATA, 'desktop-projects.json');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};
/** Puts the project folder back as `before` holds it; answers what Node had changed (names as JSON strings, lone units escaped). */
function putBack(before) {
  const after = folderState();
  const effect = { added: [], removed: [], changed: [] };
  for (const [at, entry] of after) {
    const old = before.get(at);
    if (!old) effect.added.push(at);
    else if (!old.dir && (!entry.bytes.equals(old.bytes) || entry.mtime.getTime() !== old.mtime.getTime())) effect.changed.push({ at, bytes: hex(entry.bytes) });
  }
  for (const at of before.keys()) if (!after.has(at)) effect.removed.push(at);
  for (const at of effect.added.sort().reverse()) rmSync(join(PROJECT, at), { recursive: true, force: true });
  for (const at of [...effect.removed.sort(), ...effect.changed.map((change) => change.at)]) {
    const old = before.get(at);
    if (old.dir) mkdirSync(join(PROJECT, at), { recursive: true });
    else {
      writeFileSync(join(PROJECT, at), old.bytes);
      utimesSync(join(PROJECT, at), old.mtime, old.mtime);
    }
  }
  return effect;
}

let phone = await openPhone();
let frameId = 0;
const steps = [];
for (const step of STEPS) {
  if (ONLY && step.name !== ONLY && step.name !== 'register-project') continue;
  const id = step.raw === undefined ? (step.id ?? ++frameId) : null;
  // Input no shipped client sends (lib/inbound-lone-surrogate-cases.mjs `refused`): Node runs it as any step; what it changed in the
  // project folder or the preferences is recorded (`nodeEffect`) and the folder put back, so every later step runs, on both sides,
  // on the world the core leaves (it refuses the step). A preference Node changed cannot be put back under a running Node: it fails
  // the recording.
  const before = step.refused ? { folder: folderState(), preferences: preferencesText() } : null;
  const text = step.raw ?? (step.json !== undefined ? `{"id":${id},"method":${JSON.stringify(step.call)},"params":${step.json}}` : JSON.stringify({ id, method: step.call, params: step.params }));
  const token = frame(text);
  const sealed = await phone.channel.encryptJson(token);
  send({ type: 'frame', clientId: phone.clientId, data: sealed });
  const got = await outcome(phone, id);
  const recorded = { name: step.name, plaintext: hex(new TextEncoder().encode(JSON.stringify(token))), ...got };
  if (before) {
    if (preferencesText() !== before.preferences) throw new Error(`${step.name}: Node changed the preferences, which this recorder cannot put back`);
    recorded.refusedByRule = { field: step.field, nodeEffect: putBack(before.folder) };
  }
  steps.push(recorded);
  if (got.closed !== undefined) phone = await openPhone();
}

await handle.close();
await host.dispose();
await operations.dispose();
for (const client of wss.clients) client.terminate();
await within(new Promise((resolve) => wss.close(resolve)), 'the scripted relay closing');

// What Node left on disk: every entry of the project folder (name and, for a file, its bytes, hex), and the preferences file holding
// the aliases. Sorted by name: the order is the file system's listing, which no Node code chose.
const files = readdirSync(PROJECT, { withFileTypes: true })
  .sort((a, b) => (a.name < b.name ? -1 : 1))
  .map((entry) => ({ name: hex(Buffer.from(entry.name)), ...(entry.isDirectory() ? { dir: true } : { bytes: hex(readFileSync(join(PROJECT, entry.name))) }) }));
const preferences = readFileSync(join(USER_DATA, 'desktop-projects.json'), 'utf8');

if (ONLY) {
  process.stdout.write(`${JSON.stringify({ steps, files }, null, 2)}\n`);
  process.exit(0);
}
const stage = stageSet(SET);
writeJson(join(stage, 'golden.json'), {
  note: 'What Node b6f10295a answered a paired phone, step by step, for sealed frames holding lone surrogate escapes, invalid UTF-8, a BOM, or no JSON; and the project folder it left.',
  root: ROOT,
  project: PROJECT,
  steps,
  files,
  preferences,
});
writeSetManifest(stage, {
  set: 'inbound-lone-surrogate',
  recorder: 'benchmarks/rust-core/recorders/record-inbound-lone-surrogate.mjs',
  command: 'node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-inbound-lone-surrogate.mjs --tree D:\\mixdog-build\\tmp\\b6f-tree',
  identity,
  extra: {
    exact: true,
    nodeVersion: process.version,
    recorderFiles: RECORDER_FILES.map((path) => ({ path: `benchmarks/rust-core/recorders/${path}`, sha256: sha256(readFileSync(join(HERE, path))) })),
    inputs: Object.fromEntries(steps.map((step) => [step.name, step.plaintext])),
    // A step whose answer differs from Node's under a decision: the core's answer is compared whole with Node's own answer to the
    // stand-in step instead; any other answer fails the replay.
    // What the replay changes in Node's values, or compares otherwise, before comparing.
    normalisations: [
      {
        what: "every string and object key of Node's answers (wellFormed): a lone surrogate becomes U+FFFD; two keys of one object that become one fail the replay",
        where: 'benchmarks/rust-core/recorders/lib/inbound-lone-surrogate-replay.mjs:38 wellFormed(), applied at :172 (answers) and :200 (preferences)',
        why: 'the core reads an unpaired surrogate escape as U+FFFD, so what it echoes holds U+FFFD where Node echoed the lone unit',
        allowedBy: 'decisions.md "frame-lone-surrogate" (a)',
      },
      {
        what: 'golden.preferences (desktop-projects.json) is compared as {aliases, hidden} with the core\'s `projects` rows (state/core.sqlite), after wellFormed',
        where: 'benchmarks/rust-core/recorders/lib/inbound-lone-surrogate-replay.mjs, after the project folder',
        why: 'the core keeps project preferences in that table (DS §4.1), not in a JSON file; `version` is the file format\'s, not state',
        allowedBy: 'decisions.md "frame-lone-surrogate" (a); FORMAT.md `projects` table',
      },
      {
        what: `the bytes of ${WORKSPACE} in golden.files: each six-byte \\udXXX escape JSON.stringify wrote (it escapes only lone surrogates; an escaped backslash before \`ud\` is left) becomes the UTF-8 of U+FFFD; nothing else changes`,
        where: 'benchmarks/rust-core/recorders/lib/inbound-lone-surrogate-replay.mjs jsonEscapesRead(), applied to the project folder comparison',
        why: 'the core writes JSON files with EF BF BD where Node wrote the escape',
        allowedBy: 'decisions.md "frame-lone-surrogate": "JSON files the core writes hold EF BF BD where Node wrote the six-byte escape"',
      },
      {
        what: 'json steps: Node gets the params as these exact JSON bytes; the phone adapter writes the core\'s frame from the string Node parsed',
        where: 'lib/inbound-lone-surrogate-cases.mjs `json`; the escape forms themselves reach the core\'s decoder only from the adapter\'s JSON.stringify',
        why: 'the phone sends what its adapter serializes; the decoder\'s reading of each escape form is covered by mixdog-js json_well_formed tests',
        allowedBy: 'not a value change: both sides get the same string',
      },
    ],
    // Steps the core refuses by decision: a lone surrogate in a field of the class `refused` (mixdog-app-protocol
    // tests/it/free_text_fields.json: an id, a path or a name compared with disk, a selector, a key), which no shipped client
    // sends. Node ran them and its answer and effect are recorded (golden.json steps[].answer, steps[].refusedByRule.nodeEffect):
    // the difference is shown, not hidden.
    refusedByRule: {
      decision: 'decisions.md "frame-lone-surrogate": substitution only in the free-text fields (mixdog-app-protocol free_text.rs FREE_TEXT); a lone surrogate anywhere else refuses the frame whole before any service runs',
      steps: STEPS.filter((step) => step.refused).map((step) => ({
        step: step.name,
        field: step.field,
        nodeAnswered: steps.find((recorded) => recorded.name === step.name).answer,
        nodeEffect: steps.find((recorded) => recorded.name === step.name).refusedByRule.nodeEffect,
        coreMustAnswer: loneRefusal(step.field),
      })),
      check:
        "the phone's outcome equals, whole, coreMustAnswer: the TypeError of the core's sentence naming the field, and its cause, the core's JSON-RPC error (code, reason, message, data with the field's path); the connection stays open; no effect: Node's effect was put back after each of these steps, so the project folder and preferences compared at the end are the world the core must leave",
    },
    // Steps with no Node counterpart: compared with the core's own answer to a stand-in, whole.
    coreOnly: STEPS.filter((step) => step.coreStandIn).map((step) => ({
      step: step.name,
      nodeAnswered: steps.find((recorded) => recorded.name === step.name)?.answer,
      comparedWith: `the core's own refusal of ${step.coreStandIn.raw} (a method name that does not exist), whole; and ${step.coreNext.raw} answered on the same connection`,
      why: "the core's method names are its own; a method name holding a lone unit is no name a shipped client sends",
    })),
    accepted: STEPS.filter((step) => step.accepted).map((step) => ({
      step: step.name,
      nodeAnswered: steps.find((recorded) => recorded.name === step.name).answer,
      comparedWith: `Node's recorded answer to ${step.accepted.standIn}, whole`,
      decision: step.accepted.decision,
    })),
  },
});
commitStage(stage, SET);
console.log(`inbound-lone-surrogate: ${steps.length} steps`);
process.exit(0);
