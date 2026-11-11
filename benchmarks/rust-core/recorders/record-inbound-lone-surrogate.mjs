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
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, sha256, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { frame } from './lib/raw-frame-bytes.mjs';
import { PROJECT, ROOT, STEPS, buildWorld } from './lib/inbound-lone-surrogate-cases.mjs';

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

let phone = await openPhone();
let frameId = 0;
const steps = [];
for (const step of STEPS) {
  if (ONLY && step.name !== ONLY && step.name !== 'register-project') continue;
  const id = step.raw === undefined ? (step.id ?? ++frameId) : null;
  // Input no shipped client sends (lib/inbound-lone-surrogate-cases.mjs `refused`): not recorded; its frame id is still taken, so
  // the later steps keep their bytes.
  if (step.refused) continue;
  const text = step.raw ?? (step.json !== undefined ? `{"id":${id},"method":${JSON.stringify(step.call)},"params":${step.json}}` : JSON.stringify({ id, method: step.call, params: step.params }));
  const token = frame(text);
  const sealed = await phone.channel.encryptJson(token);
  send({ type: 'frame', clientId: phone.clientId, data: sealed });
  const got = await outcome(phone, id);
  steps.push({ name: step.name, plaintext: hex(new TextEncoder().encode(JSON.stringify(token))), ...got });
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
        what: 'json steps: Node gets the params as these exact JSON bytes; the phone adapter writes the core\'s frame from the string Node parsed',
        where: 'lib/inbound-lone-surrogate-cases.mjs `json`; the escape forms themselves reach the core\'s decoder only from the adapter\'s JSON.stringify',
        why: 'the phone sends what its adapter serializes; the decoder\'s reading of each escape form is covered by mixdog-js json_well_formed tests',
        allowedBy: 'not a value change: both sides get the same string',
      },
    ],
    // Steps Node never got: a lone surrogate where no shipped client sends one (decisions.md "frame-lone-surrogate": refused whole
    // before any service runs, mixdog-app-protocol free_text.rs).
    refusedByRule: {
      steps: STEPS.filter((step) => step.refused).map((step) => step.name),
      check:
        "the phone's call fails with the core's invalidParams refusal of a lone surrogate outside free text (its message names the field and says 'text without unpaired surrogates'), the connection stays open; no effect: the project folder and preferences compared at the end with Node's, which never ran these steps",
      why: 'input no shipped client can send only has to be refused with no side effect, with no recording (AGENT-RULES.md)',
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
