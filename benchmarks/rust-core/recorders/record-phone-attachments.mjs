#!/usr/bin/env node
// What Node's host (b6f10295a) answers the paired phone for its attachment and local-file calls (list 1 unit D: `attachmentOpen`,
// `readAttachmentThumbnail`, `resolveLocalPaths`, `readLocalFile`, `projectRecovery`), recorded from an exact export: the relay's own
// frame executor (`executeRemoteFrame` over `createRemoteMethods`, remote-methods.ts) on top of a real `SessionHost` (project registry,
// attachment store reads) and the real desktop operations (`createDesktopOperations`: local files, recovery), with the relay's one-file
// grants (`createSelectedFileGrants`). The conversations are written by Node's own session store and read back by its stored-session
// reader. Per call the recording holds the params the phone sent and the frame the relay sent back; after the script, the project, the
// files outside it, the staged attachments in the PC's temp folder and the recovery store. The script is lib/phone-attachments-script.mjs.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-attachments.mjs --tree <git archive of b6f10295a with node_modules> [--only]
//
// With `--replay <mixdogd.exe>` the same script runs through the phone's router and adapters (renderer/remote-protocol-attachments.ts,
// and remote-protocol-files.ts for the file calls a grant opens) on a phone paired behind a scripted relay with a built `mixdogd`, over
// the same world (the conversation files Node wrote, converted by the core at its start), and every step and the final state are
// compared with the recording whole.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { attachmentsScript, attachmentsWorld, conversation, FIXED_NOW_MS, play, recoveryRoots, REFS, seedRecovery, WORKTREE_STATES, worldState } from './lib/phone-attachments-script.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-phone-attachments.mjs';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-attachments');
const args = parseArgs();
const REPLAY = args.get('replay') ?? null;
const ONLY = args.has('only');
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const PHONE_ID = '0123456789abcdef0123456789abcdef';

const world = attachmentsWorld();
// Nothing of the signed-in profile is read or written: the registry, the home and the PC's temp folder are the world's.
const STATE = `${world.root}-state`;
rmSync(STATE, { recursive: true, force: true });
mkdirSync(join(STATE, 'home'), { recursive: true });
Object.assign(process.env, { MIXDOG_HOME: join(STATE, 'home'), MIXDOG_DATA_DIR: world.data, MIXDOG_PROJECTS_FILE: join(STATE, 'projects.json'), TEMP: world.temp, TMP: world.temp });

if (REPLAY) process.exit(await replay(REPLAY));

const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
world.build(world.data);
const { saveSessionAsync } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store.mjs');
const { readStoredSessionTranscript } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
const projects = await importFrom(tree, 'src/runtime/shared/projects.mjs');
const recoveryStore = await main('project-recovery-store');
const { SessionHost } = await main('session-host');
const { createDesktopOperations } = await main('desktop-operations');
const { createRemoteMethods, executeRemoteFrame, createSelectedFileGrants } = await main('remote-methods');

// The conversations, as Node's session store writes them; their files are the world the core converts.
for (const [id, messages] of Object.entries(conversation())) {
  await saveSessionAsync({ id, provider: 'openai', model: 'gpt-test', cwd: world.project, generation: 0, closed: false, messages }, { expectedGeneration: 0 });
}
const sessionsDir = join(world.data, 'sessions');
const sessionFiles = readdirSync(sessionsDir).sort().map((name) => ({ name, text: readFileSync(join(sessionsDir, name), 'utf8') }));
const seededRoots = [world.project, ...WORKTREE_STATES.map((state) => world.worktrees[state])];
const records = await seedRecovery(recoveryStore, world.userData, seededRoots);
world.registerWorktrees(world.data);
const worktrees = await importFrom(tree, 'src/runtime/shared/worktrees/manager.mjs');

const sessionClient = { list: async () => ({ sessions: [] }), close: async () => {} };
const host = await SessionHost.create(
  { userDataPath: world.userData, resourcesPath: world.root, appPath: join(tree, 'apps', 'desktop'), packaged: false },
  {
    attachSessionClient: async () => sessionClient,
    loadProjects: async () => projects,
    loadSessionStore: async () => ({ listStoredAgentWorkers: () => [] }),
    loadStatuslineSegments: async () => ({}),
    loadWorktrees: async () => worktrees,
  }
);
// Every recovery call runs under the worktree manager's store seam, as desktop-service.ts worktreeRecoveryStore (:754-766) hands it to
// createDesktopOperations when the loaded module has withWorktreeRecoveryStore.
const withRecoveryStore = (root, action, run) => worktrees.withWorktreeRecoveryStore(root, recoveryStore.projectRecoveryStorePath(world.userData, root), action, run);
const operations = createDesktopOperations({ userDataPath: world.userData, packaged: false, resourcesPath: '', appPath: join(tree, 'apps', 'desktop'), loadConfig: async () => ({}), withRecoveryStore, emit() {} });
host.invokeDesktopOperation = (name, operationArgs) => operations.invoke(name, operationArgs);
// The PC's transcripts of a conversation no window holds: the session service's cold read of the stored files, and its whole
// stored conversation for the attachment lookup (session-views.mjs `readSession`, `attachmentHistory`).
host.readSessionTranscript = (id) => readStoredSessionTranscript(id);
host.readSessionHistory = async (id) => {
  const stored = await readStoredSessionTranscript(id, { attachmentHistory: true });
  return stored ? { items: stored.items } : null;
};
const methods = createRemoteMethods({ host, userDataPath: world.userData, selectedFileGrants: createSelectedFileGrants(() => false) });
let frameId = 0;
const driver = {
  async call(name, params) {
    const real = Date.now;
    Date.now = () => FIXED_NOW_MS;
    const frame = await executeRemoteFrame(methods, JSON.stringify({ id: ++frameId, method: name, params })).finally(() => {
      Date.now = real;
    });
    const { id: _id, ...answer } = clone(frame);
    return { frame: answer };
  },
};
const { steps } = await play(attachmentsScript(world), driver, records);
await host.dispose();
await operations.dispose();
const state = worldState(world, (root) => recoveryStore.projectRecoveryStorePath(world.userData, root), records, world.data);

if (ONLY) {
  const text = `${JSON.stringify({ steps, state }, null, 2)}\n`;
  await new Promise((written, failed) => process.stdout.write(text, (error) => (error ? failed(error) : written())));
  process.exit(0);
}
const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: "Node host answers to a paired phone for attachmentOpen, readAttachmentThumbnail, resolveLocalPaths, readLocalFile and projectRecovery: per call its relay frame (value, or error with errorCode); the world after the script (the project, the files outside it, the attachments staged in the PC's temp folder, the recovery store). The world's conversations are the files Node's session store wrote (sessionFiles).",
  root: world.root,
  refs: REFS,
  sessionFiles,
  steps,
  state,
});
writeSetManifest(out, {
  set: 'phone-attachments',
  recorder: RECORDER,
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs ${RECORDER} --tree <git archive of ${REF} with node_modules>`,
  identity,
  extra: {
    steps: steps.length,
    ...recorderProvenance(import.meta.url),
    entry: {
      runs: "executeRemoteFrame over createRemoteMethods (remote-methods.ts) with a real SessionHost (project registry, readAttachmentImage over the attachment store, projectRecoveryDirectory with the worktree runtime src/runtime/shared/worktrees/manager.mjs as loadWorktrees), createDesktopOperations (readLocalFileAbs, statLocalEntryAbs, projectRecoveryIn, under manager.mjs withWorktreeRecoveryStore as desktop-service.ts worktreeRecoveryStore hands it) and createSelectedFileGrants",
      notRun:
        "the relay transport (encryption, admission) and the session service process: the host's transcript reads are the service's own stored-session reads (store-summary-reader.mjs readStoredSessionTranscript, the cold read and the attachmentHistory read session-views.mjs makes), since no window holds these conversations",
    },
    worldSetup: {
      conversations: "two conversations saved with Node's saveSessionAsync (session/store.mjs); the files it wrote are the golden's sessionFiles, which the replay puts in the core's data dir before it starts",
      attachments: 'blobs written at <data>/prompt-attachments/sha256/<2>/<ref> (the layout both stores read)',
      recovery: "two interrupted workspace edits in the project and in each managed worktree: beginProjectRecovery then releaseRecoveryDirectory of project-recovery-store.ts (b6f10295a's here, the identical file of this repository in the replay), on Date.now = FIXED_NOW_MS",
      worktrees:
        "a git repository (git init) and four checkout folders, one per registry state (ready, deleting, recovery, creating), written as records of <data>/worktrees-v1/registry.json (one format for Node's registry.mjs and the core's): before the host is made here; in the replay once the core serves, so its startup reconcile (Node's daemon ran one at its start, this recording runs no daemon) meets an empty registry. The replay fails if the core's daemon.log reports a reconcile",
    },
    comparison: {
      placeholders:
        "values one world names by a value of its own are compared by their place (lib/phone-attachments-script.mjs `play`): a grant's random token as $grant<n> in the order first answered, a recovery record's random id as $record<n> in seeding order, an inspected record's revision (a digest over its manifest, which holds that id and the world's file identities) as $revision<n> in the order first answered. Params that reuse them are resolved to the world's own value before the call.",
      fileMtime:
        "a file call's answer (readProjectFile, statProjectFile, previewProjectFileRange) carries the file's mtimeMs, which the OS stamps when a staged attachment or a restore writes it: each side proves the answer equals its own file's mtime on disk right after the call (lib/phone-attachments-script.mjs `play` fails the run otherwise) and the answer holds { $fileMtime: true } in its place",
      heldWhole:'a string over 64 KiB in an answer (limit.bin read whole, the 2 MiB thumbnail) is held as its length and sha256, on both sides',
      recoveryStore: "each recovery folder's store after the script (the project, each worktree, the ready worktree's subfolder) is compared by entry name (record ids as $record<n>) and each payload's size and sha256; manifest.json and state.json by name only (they hold the record id and the world's file identities)",
      worktreeRegistry:
        "the worktree registry after the script, every record whole but `updatedAt` (Node's putRecord stamps it, the core's registry write does not), with each editorRecoveryStores directory as $journal/<digest of its root>: Node keeps the stores in <userData>/editor-recovery, the core in <data>/recovery",
    },
    notRecorded: {
      pathDeadline:
        "resolveLocalPaths's 15 s per-path deadline (remote-methods.ts:646-660) needs a path whose stat does not answer (a stalled network share), which this world cannot make; the adapter keeps the deadline and its sentence",
    },
  },
});
commitStage(out, FIXTURES);
console.log(`phone-attachments: ${steps.length} steps`);
process.exit(0);

// ── the replay: the phone's router and adapters over a built core ──
async function replay(exe) {
  const { startCore, killTree, answered, NoAnswer } = await import('./lib/phone-files-replay.mjs');
  const { startRelay } = await import('./lib/phone-relay-core.mjs');
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8'));
  const provenance = recorderProvenance(import.meta.url);
  if (!isDeepStrictEqual(manifest.inputs, provenance.inputs) || manifest.recorderSha256 !== provenance.recorderSha256) {
    throw new Error('the recording was made by another recorder than this one: record again before comparing');
  }
  world.build(world.data);
  mkdirSync(join(world.data, 'sessions'), { recursive: true });
  for (const { name, text } of golden.sessionFiles) writeFileSync(join(world.data, 'sessions', name), text);
  // The recovery records, written by this repository's copy of the store (the same file as b6f10295a's) and moved where the core keeps
  // its journals (`<data>/recovery/<digest of the root>`).
  const recoveryStore = await here('apps/desktop/src/main/project-recovery-store.ts');
  const seededRoots = [world.project, ...WORKTREE_STATES.map((state) => world.worktrees[state])];
  const records = await seedRecovery(recoveryStore, world.userData, seededRoots);
  const coreJournal = (root) => join(world.data, 'recovery', basename(recoveryStore.projectRecoveryStorePath(world.userData, root)));
  mkdirSync(join(world.data, 'recovery'), { recursive: true });
  for (const root of seededRoots) renameSync(recoveryStore.projectRecoveryStorePath(world.userData, root), coreJournal(root));
  writeFileSync(join(world.data, 'remote-activated.json'), '{"activatedAt":1}');

  const relay = await startRelay({ repoRoot: REPO_ROOT, clients: [], capabilities: { textFrames: 1, maxFrameBytes: 1048576 } });
  const coreRoot = `${world.root}-core`;
  let core = null;
  let client = null;
  try {
    core = await startCore(exe, coreRoot, relay, true, { MIXDOG_DATA_DIR: world.data, TEMP: world.temp, TMP: world.temp });
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    await answered("the core's relay leg", relay.leg());
    const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
    const pairing = relayE2EEPairingMaterial(JSON.parse(readFileSync(join(world.data, 'relay-e2ee.json'), 'utf8')));
    const leg = await answered("the paired phone's relay connection", relay.openPhone('client-attachments', PHONE_ID, pairing));
    // The reason the core gave when it closed the phone goes with the failure.
    let closed = '';
    let inFlight = 'the connection';
    const connector = { open: (target, sink) => leg.open(target, { frame: (text) => sink.frame(text), closed: (code, reason) => ((closed = reason), sink.closed(code, reason)) }) };
    client = await answered("the phone's connection (initialize)", connect({
      target: { id: 'core' },
      connector,
      clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      clock: { sleep: () => Promise.reject(new Error(`the core closed the replay's connection (${closed}) during ${inFlight}`)) },
      random: Math.random,
    }));
    // The worktree registry is written once the core serves: its startup reconcile (which Node's daemon ran at its own start, and the
    // recording, which runs no daemon, did not) has then met an empty registry, so the records are the ones the recording read.
    world.registerWorktrees(world.data);
    globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
    const { adapter: files } = await here('apps/desktop/src/renderer/remote-protocol-files.ts');
    const { adapter: attachments } = await here('apps/desktop/src/renderer/remote-protocol-attachments.ts');
    const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
    const host = { ctx: { browserId: PHONE_ID }, client: () => client, declareLane() {} };
    const router = createProtocolRouter([files, attachments], { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false });
    const driver = {
      async call(name, params) {
        let frame;
        inFlight = `${name} ${JSON.stringify(params).slice(0, 200)}`;
        try {
          const value = await answered(name, router.call(name, params));
          frame = { ok: true, value: value === undefined ? null : clone(value) };
        } catch (error) {
          if (error instanceof NoAnswer) throw error;
          frame = { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) };
        }
        return { frame };
      },
    };
    const { steps } = await play(attachmentsScript(world), driver, records);
    const state = worldState(world, coreJournal, records, world.data);
    const differences = [];
    if (steps.length !== golden.steps.length) differences.push({ label: 'step count', node: golden.steps.length, core: steps.length });
    golden.steps.forEach((node, index) => {
      if (!isDeepStrictEqual(node, steps[index])) differences.push({ label: `#${index} ${node.call} ${JSON.stringify(node.params).slice(0, 140)}`, node: node.frame, core: steps[index]?.frame });
    });
    for (const field of Object.keys(golden.state)) {
      if (!isDeepStrictEqual(golden.state[field], state[field])) differences.push({ label: `state.${field}`, node: golden.state[field], core: state[field] });
    }
    const log = existsSync(join(world.data, 'daemon.log')) ? readFileSync(join(world.data, 'daemon.log'), 'utf8') : '';
    const reconciled = log.split(/\r?\n/u).filter((line) => line.includes('worktree reconcile'));
    if (reconciled.length) differences.push({ label: "the core's startup reconcile ran over the world's worktrees", node: [], core: reconciled });
    console.log(`phone-attachments replay over ${exe}: ${golden.steps.length} steps and ${Object.keys(golden.state).length} state fields compared, ${differences.length} differ`);
    for (const entry of differences) {
      console.log(`DIFF ${entry.label}`);
      console.log(`   node: ${JSON.stringify(entry.node).slice(0, 700)}`);
      console.log(`   core: ${JSON.stringify(entry.core).slice(0, 700)}`);
    }
    return differences.length ? 1 : 0;
  } finally {
    client?.close?.();
    if (core) await killTree(core.child);
    relay.close();
  }
}
