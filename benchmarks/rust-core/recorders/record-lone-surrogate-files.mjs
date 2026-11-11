#!/usr/bin/env node
// Files Node (b6f10295a, an exact export) writes holding a lone UTF-16 surrogate, through Node's own writers, for every
// core reader of such a file that parsed it with plain serde_json (which refuses `\ud83d`). A lone surrogate reaches these
// files without any bad client: Node cuts text by UTF-16 units (an alias at 80, a PC name at 64, a media prompt at 4000, a
// board name at 120, a recovery message at 8000) and keeps half of an emoji; or a phone sends text cut inside an emoji and
// Node stores what it parsed (a Mixy name, a profile title, a branch, a webhook field).
//
// Per case: the files exactly as Node wrote them (`<case>/before/...`), the document Node's `JSON.parse` reads from each,
// through the one mapping at the places the manifest lists (lib/lone-mapping.mjs: a lone surrogate becomes U+FFFD,
// decisions.md "Lone UTF-16 surrogates in client strings"), and for a read-modify-write store one more Node write
// (`<case>/after/...`) with its document, which the core must reproduce from Node's file without losing a field.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs \
//     benchmarks/rust-core/recorders/record-lone-surrogate-files.mjs --tree D:\mixdog-build\tmp\b6f-tree [--only <case>]
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURES_ROOT,
  commitStage,
  exactProductIdentity,
  importFrom,
  parseArgs,
  resolveTree,
  sha256,
  stageSet,
  within,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';
import { installDeterministicWorld } from './lib/deterministic-world.mjs';
import { LONE_MAPPING, lonePlaces, mapAt } from './lib/lone-mapping.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only') ?? null;
const identity = exactProductIdentity(tree, COMMIT);
const SET = join(FIXTURES_ROOT, 'lone-surrogate-files');
const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER_FILES = ['record-lone-surrogate-files.mjs', 'lib/common.mjs', 'lib/deterministic-world.mjs', 'lib/lone-mapping.mjs', 'lib/ts-register.mjs', 'lib/ts-resolve-hooks.mjs'];

// Scratch under the build folder: one fresh data dir per run; the recovery root is a fixed folder kept between runs, so the
// identity (dev/ino) and the path Node writes into its manifest are the same on every run.
const SCRATCH = 'D:\\mixdog-build\\tmp\\w15-lone-surrogate';
mkdirSync(SCRATCH, { recursive: true });
const DATA = mkdtempSync(join(SCRATCH, 'data-'));
const RECOVERY_ROOT = join(SCRATCH, 'recovery-root');
mkdirSync(join(RECOVERY_ROOT, 'src'), { recursive: true });
// Nothing Node writes may reach the real profile: the data dir, Mixdog's home, its backups and the user folders it falls
// back to all point into the run's scratch.
const HOME = join(DATA, 'home');
mkdirSync(HOME, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: DATA,
  MIXDOG_HOME: join(HOME, '.mixdog'),
  MIXDOG_CONFIG_DIR: join(HOME, '.mixdog'),
  MIXDOG_USER_DATA_BACKUP_ROOT: join(DATA, 'user-data-backups'),
  HOME,
  USERPROFILE: HOME,
  APPDATA: join(HOME, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(HOME, 'AppData', 'Local'),
  XDG_CONFIG_HOME: join(HOME, '.config'),
});

const world = installDeterministicWorld({ start: Date.UTC(2026, 10, 11, 0, 0, 0), pid: 4242 });
let seed = 0x2545f491;
Math.random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

const EMOJI = '\u{1F600}';
// `n - 1` letters and an emoji: a cut at `n` UTF-16 units keeps the emoji's high half alone.
const cutAt = (letter, n) => `${letter.repeat(n - 1)}${EMOJI}tail`;

const stage = stageSet(SET, only ? [only] : null);
const cases = only ? JSON.parse(readFileSync(join(SET, 'cases.json'), 'utf8')).filter((c) => c.name !== only) : [];

/** Where the one mapping (lib/lone-mapping.mjs) was applied in each recorded case: listed in the manifest. */
const mapped = only ? JSON.parse(readFileSync(join(SET, 'MANIFEST.json'), 'utf8')).mapping.at : {};
/** The document Node's `JSON.parse` reads from `file`, as Node holds it. */
const documentOf = (file) => JSON.parse(readFileSync(file, 'utf8'));
const lone = (file) => /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(readFileSync(file, 'utf8'));

/** Copies Node's files of `phase` and returns their documents keyed by data-relative path. */
function keep(name, phase, root, rels) {
  const out = {};
  for (const rel of rels) {
    const from = join(root, rel);
    const to = join(stage, name, phase, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    out[rel.split('\\').join('/')] = documentOf(from);
  }
  return out;
}

async function record(name, writer, run) {
  if (only && only !== name) return;
  const result = await within(`case ${name}`, run());
  for (const [rel, holds] of Object.entries(result.lone ?? {})) {
    if (!holds) throw new Error(`${name}: ${rel} holds no lone surrogate escape; the input does not reach Node's cut`);
  }
  delete result.lone;
  // The case file is read by serde_json, which holds no lone unit: the one mapping is applied at every place of the case that holds
  // one, each listed in the manifest. The input keeps its lone surrogate as the JSON text Node's `JSON.stringify` makes of it.
  const recorded = { name, writer, ...result, input: JSON.stringify(result.input) };
  mapped[name] = lonePlaces(recorded);
  cases.push(mapAt(recorded, mapped[name]));
}

// ── remote-access settings: a PC name cut at 64 units, a device alias cut at 80 (remote-access-settings.ts:95-96, :109) ──
await record('remote-access-settings', 'apps/desktop/src/main/remote-access-settings.ts:77,:99', async () => {
  const { createRemoteAccessSettingsStore } = await importFrom(tree, 'apps/desktop/src/main/remote-access-settings.ts');
  const dir = join(DATA, 'remote');
  const store = createRemoteAccessSettingsStore(dir, () => 'HOST');
  const input = { name: cutAt('P', 64), alias: cutAt('A', 80), enabled: true };
  await store.setEnabled(true);
  await store.setName(input.name);
  await store.setDeviceAlias('client-a', input.alias);
  const rel = 'remote-access-settings.json';
  const before = keep('remote-access-settings', 'before', dir, [rel]);
  const lonely = lone(join(dir, rel));
  const nodeRead = { settings: await store.read(), deviceAliases: await store.deviceAliases() };
  const op = { setDeviceAlias: ['client-b', 'Second phone'] };
  await store.setDeviceAlias(...op.setDeviceAlias);
  const after = keep('remote-access-settings', 'after', dir, [rel]);
  return { input, file: rel, before, nodeRead, op, after, lone: { [rel]: lonely } };
});

// ── media studio: a prompt cut at 4000 units (store.mjs:219), a board name cut at 120 (store.mjs:292) ──
await record('media-store', 'src/runtime/media/store.mjs:116,:219,:276', async () => {
  const media = await importFrom(tree, 'src/runtime/media/store.mjs');
  const input = { prompt: cutAt('p', 4000), board: cutAt('B', 120) };
  const asset = media.saveMediaAsset({
    kind: 'image',
    lane: 'openai',
    model: 'gpt-image-1',
    prompt: input.prompt,
    options: { size: '1024x1024' },
    mime: 'image/png',
    bytes: Buffer.from('not really a png'),
  });
  world.advance(1000);
  const cut = media.createMediaBoard(input.board);
  world.advance(1000);
  const plain = media.createMediaBoard('Plain board');
  const root = join(DATA, 'media');
  const rels = ['index.json', 'boards.json'];
  const before = keep('media-store', 'before', root, rels);
  const lonely = Object.fromEntries(rels.map((rel) => [rel, lone(join(root, rel))]));
  const nodeRead = { boards: media.listMediaBoards() };
  const op = { setAssetBoard: [[asset.id], cut.id], renameBoard: [plain.id, 'Renamed board'] };
  media.setMediaAssetBoard(...op.setAssetBoard);
  media.renameMediaBoard(...op.renameBoard);
  const after = keep('media-store', 'after', root, rels);
  return { input, files: rels, assetId: asset.id, before, nodeRead, op, after, lone: lonely };
});

// ── worktree registry: a branch a phone sent cut inside an emoji (manager.mjs:1681 requestedBranch), stored by insertRecord ──
await record('worktree-registry', 'src/runtime/shared/worktrees/registry.mjs:80-84', async () => {
  const registry = await importFrom(tree, 'src/runtime/shared/worktrees/registry.mjs');
  const record = (id, branch) => ({
    id,
    txId: `tx-${id}`,
    repoCommonDir: 'C:/repo/.git',
    projectPath: 'C:/repo',
    projectSubdir: '',
    path: `C:/repo/.mixdog/worktrees/${id}`,
    branch,
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    mergeTarget: 'main',
    createdAt: Date.now(),
    ownerSessionId: 'sess_owner',
    state: 'ready',
    disposable: false,
    warnings: [],
    resources: { branch: 'created', worktree: 'created' },
  });
  const input = { branch: `topic-${EMOJI.slice(0, 1)}` };
  await registry.insertRecord(record('topic-one', input.branch));
  const rel = join('worktrees-v1', 'registry.json');
  const before = keep('worktree-registry', 'before', DATA, [rel]);
  const lonely = lone(join(DATA, rel));
  const nodeRead = await registry.readRegistry();
  world.advance(1000);
  const second = record('topic-two', 'topic-two');
  const op = { insert: second };
  await registry.insertRecord(second);
  const after = keep('worktree-registry', 'after', DATA, [rel]);
  return { input, file: rel.split('\\').join('/'), before, nodeRead, op, after, lone: { [rel]: lonely } };
});

// ── project recovery: a failure message cut at 8000 units (project-recovery-store.ts:340) ──
await record('project-recovery', 'apps/desktop/src/main/project-recovery-store.ts:336-352,:497', async () => {
  const recovery = await importFrom(tree, 'apps/desktop/src/main/project-recovery-store.ts');
  const userData = join(DATA, 'desktop');
  mkdirSync(userData, { recursive: true });
  const destination = join(RECOVERY_ROOT, 'src', 'a.txt');
  const file = {
    relPath: 'src/a.txt',
    destination,
    parent: recovery.recoveryIdentity(join(RECOVERY_ROOT, 'src')),
    mode: 0o644,
    before: Buffer.from('before\n'),
    after: Buffer.from('after\n'),
  };
  const { id, directory } = await recovery.beginProjectRecovery(userData, RECOVERY_ROOT, [file]);
  const input = { message: cutAt('m', 8000) };
  await recovery.writeRecoveryState(directory, { phase: 'failed', message: input.message, restored: [] });
  await recovery.releaseRecoveryDirectory(directory);
  const published = join(dirname(directory), id);
  const nodeRead = (await recovery.readRecoveryRecord(published)).state;
  const rels = ['manifest.json', 'state.json', '0.before', '0.after'];
  const before = {};
  for (const rel of rels) {
    const to = join(stage, 'project-recovery', 'before', 'record', rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(published, rel), to);
    if (rel.endsWith('.json')) before[`record/${rel}`] = documentOf(join(published, rel));
  }
  const recordId = published.split(/[\\/]/).at(-1);
  const lonely = lone(join(published, 'state.json'));
  // Node's own rewrite of the state it read (writeRecoveryState, project-recovery-store.ts:336-352): the phase moves on, the
  // message and the restored list are what it read.
  const read = (await recovery.readRecoveryRecord(published)).state;
  const op = { writeRecoveryState: { phase: 'restoring' } };
  await recovery.writeRecoveryState(published, { ...read, ...op.writeRecoveryState });
  const after = { 'record/state.json': documentOf(join(published, 'state.json')) };
  const to = join(stage, 'project-recovery', 'after', 'record', 'state.json');
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(published, 'state.json'), to);
  return { input, recordId, before, nodeRead, op, after, lone: { 'state.json': lonely } };
});

// ── project recovery: a journal of a desktop batch edit whose path held a lone surrogate (project-files.ts:783 → :787,
//    project-recovery-store.ts:490 writes relPath and destination with the escape). Node's fs writes such a path as UTF-8, so
//    the file on disk is named with U+FFFD; Node then inspects the record and restores the file it wrote ──
await record('project-recovery-lone-path', 'apps/desktop/src/main/project-recovery-store.ts:444-497; project-recovery.ts:166-295', async () => {
  const store = await importFrom(tree, 'apps/desktop/src/main/project-recovery-store.ts');
  const { projectRecoveryIn } = await importFrom(tree, 'apps/desktop/src/main/project-recovery.ts');
  const userData = join(DATA, 'desktop-lone-path');
  mkdirSync(userData, { recursive: true });
  const rel = `src/b${EMOJI.slice(0, 1)}.txt`;
  const destination = join(RECOVERY_ROOT, 'src', `b${EMOJI.slice(0, 1)}.txt`);
  // Node's own fs write of the lone-unit path: the name it gets on disk.
  writeFileSync(destination, 'after\n');
  const file = { relPath: rel, destination, parent: store.recoveryIdentity(join(RECOVERY_ROOT, 'src')), mode: 0o644, before: Buffer.from('before\n'), after: Buffer.from('after\n') };
  const { id, directory } = await store.beginProjectRecovery(userData, RECOVERY_ROOT, [file]);
  await store.writeRecoveryState(directory, { phase: 'failed', message: 'interrupted', restored: [] });
  await store.releaseRecoveryDirectory(directory);
  const published = join(dirname(directory), id);
  const before = {};
  for (const name of ['manifest.json', 'state.json', '0.before', '0.after']) {
    const to = join(stage, 'project-recovery-lone-path', 'before', 'record', name);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(published, name), to);
    if (name.endsWith('.json')) before[`record/${name}`] = documentOf(join(published, name));
  }
  const onDisk = (await import('node:fs')).readdirSync(join(RECOVERY_ROOT, 'src')).filter((name) => name.startsWith('b'));
  const inspected = await projectRecoveryIn(userData, RECOVERY_ROOT, { action: 'inspect', id });
  const restored = await projectRecoveryIn(userData, RECOVERY_ROOT, { action: 'restore', id, revision: inspected.detail.revision });
  const view = (detail) => ({ phase: detail.phase, files: detail.files.map(({ relPath, status }) => ({ relPath, status })) });
  const after = {
    namesOnDisk: onDisk.map((name) => Buffer.from(name).toString('hex')),
    inspected: view(inspected.detail),
    restored: view(restored.detail),
    target: readFileSync(join(RECOVERY_ROOT, 'src', onDisk[0]), 'utf8'),
    state: JSON.parse(readFileSync(join(published, 'state.json'), 'utf8')),
  };
  rmSync(join(RECOVERY_ROOT, 'src', onDisk[0]));
  return { input: { relPath: rel }, recordId: id, before, after, lone: { 'manifest.json': lone(join(published, 'manifest.json')) } };
});

// ── event queue: a webhook field holding a lone surrogate (the sender's JSON had `\ud83d`), fenced into the prompt ──
await record('event-queue', 'src/runtime/channels/lib/event-pipeline.mjs:32-41,:61-70; event-queue.mjs:143', async () => {
  const { EventPipeline } = await importFrom(tree, 'src/runtime/channels/lib/event-pipeline.mjs');
  const rule = { name: 'pr-opened', source: 'webhook', priority: 'normal', parser: 'generic', execute: 'Review the pull request {{title}}', exec: 'interactive' };
  const pipeline = new EventPipeline({ rules: [rule] });
  const body = '{"title":"Fix the parser \\ud83d"}';
  const handled = pipeline.handleWebhook('pr-opened', JSON.parse(body), {});
  if (handled !== true) throw new Error('the webhook rule did not take the event');
  const queueDir = join(DATA, 'events', 'queue');
  const names = (await import('node:fs')).readdirSync(queueDir);
  if (names.length !== 1) throw new Error(`expected one queued item, found ${names.length}`);
  const rel = join('events', 'queue', names[0]);
  const before = keep('event-queue', 'before', DATA, [rel]);
  const lonely = lone(join(DATA, rel));
  // Node's own rewrite of the record: a failed inject requeues it with its attempt count (event-queue.mjs:277-301).
  const { EventQueue } = await importFrom(tree, 'src/runtime/channels/lib/event-queue.mjs');
  const queue = new EventQueue({});
  const item = queue.readItem(names[0]);
  const claimed = queue.claimFile(names[0]);
  if (!claimed) throw new Error('Node could not claim the queued item');
  const op = { requeueClaimed: 'one failed inject' };
  queue.requeueClaimed(claimed, item);
  const after = keep('event-queue', 'after', DATA, [rel]);
  return { input: { body }, file: rel.split('\\').join('/'), before, op, after, lone: { [rel]: lonely } };
});

// ── mixdog-config.json: a profile title a phone sent cut inside an emoji (setProfile, written by updateConfig) ──
await record('config-profile', 'src/runtime/shared/config.mjs:919-929', async () => {
  const config = await importFrom(tree, 'src/runtime/shared/config.mjs');
  const input = { title: `Backend lead ${EMOJI.slice(0, 1)}`, language: 'ko' };
  config.updateConfig((current) => ({ ...current, agent: { ...(current.agent ?? {}), profile: { title: input.title, language: input.language } } }));
  const rel = 'mixdog-config.json';
  const before = keep('config-profile', 'before', DATA, [rel]);
  const lonely = lone(join(DATA, rel));
  // Node's own rewrite of the document it holds: one more key set (the key the profile migration sets, desktop.retentionState).
  const op = { setPath: { key: 'desktop.retentionState', value: { restored: {} } } };
  config.updateConfig((current) => ({ ...current, desktop: { ...(current.desktop ?? {}), retentionState: op.setPath.value } }));
  const after = keep('config-profile', 'after', DATA, [rel]);
  return { input, file: rel, before, op, after, lone: { [rel]: lonely } };
});

// ── Mixy's agent.json: a name a phone sent cut inside an emoji (saveLeadIdentity, agent-editor.mjs:540-553) ──
await record('mixy-identity', 'src/session-runtime/workflow-agents-api/agent-editor.mjs:540-553', async () => {
  const { createAgentEditorApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api/agent-editor.mjs');
  const editor = createAgentEditorApi({
    cfgMod: { getPluginData: () => DATA },
    STANDALONE_DATA_DIR: DATA,
    getConfig: () => ({}),
    resolveRoute: () => null,
  });
  const input = { name: `Momo ${EMOJI.slice(0, 1)}` };
  editor.saveLeadIdentity({ name: input.name });
  const rel = join('agents', 'lead', 'agent.json');
  const before = keep('mixy-identity', 'before', DATA, [rel]);
  const { mixyDisplayName } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/mixy-name.mjs');
  const nodeRead = { mixyDisplayName: mixyDisplayName() };
  return { input, file: rel.split('\\').join('/'), before, nodeRead, lone: { [rel]: lone(join(DATA, rel)) } };
});

// ── a custom agent's agent.json: a name and a job a phone sent cut inside an emoji (saveAgentDefinition → writeAgentFiles,
//    agent-editor.mjs:363-371), read by the agent-mode identity line (role-instructions.mjs:325, :373-381) ──
await record('agent-definition', 'src/session-runtime/workflow-agents-api/agent-editor.mjs:363-371', async () => {
  const { createAgentEditorApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api/agent-editor.mjs');
  const { workflowHelpers } = await importFrom(tree, 'src/session-runtime/boot/shared.mjs');
  const { loadAgentDefinition, listCustomAgentIds } = workflowHelpers;
  const editor = createAgentEditorApi({
    cfgMod: { getPluginData: () => DATA },
    STANDALONE_DATA_DIR: DATA,
    rootDir: join(tree, 'src'),
    getConfig: () => ({}),
    loadAgentDefinition,
    listCustomAgentIds,
    saveConfigAndAdopt: () => undefined,
    setAgentRoute: () => undefined,
    agentRouteFromConfig: () => null,
    resolveRoute: () => null,
  });
  const input = { id: 'helper', name: `Helper ${EMOJI.slice(0, 1)}`, description: `Drafts replies ${EMOJI.slice(0, 1)}`, body: 'Draft replies to the mail you are given.' };
  await editor.saveAgentDefinition(input);
  const rel = join('agents', 'helper', 'agent.json');
  const before = keep('agent-definition', 'before', DATA, [rel, join('agents', 'helper', 'AGENT.md')].filter((r) => r.endsWith('.json')));
  const agentMd = join(stage, 'agent-definition', 'before', 'agents', 'helper', 'AGENT.md');
  cpSync(join(DATA, 'agents', 'helper', 'AGENT.md'), agentMd);
  const { agentModeIdentityLine } = await importFrom(tree, 'src/runtime/agent/orchestrator/context/role-instructions.mjs');
  const nodeRead = { identityLine: agentModeIdentityLine('helper') };
  return { input, file: rel.split('\\').join('/'), before, nodeRead, lone: { [rel]: lone(join(DATA, rel)) } };
});

// ── editor backup: an unsaved draft holding half of an emoji (the editor's text is UTF-16; writeEditorBackup stores it as
//    JSON.stringify writes it), read back by readEditorBackup, which deletes a backup it cannot parse ──
await record('editor-backup', 'apps/desktop/src/main/editor-backups.ts:97-117', async () => {
  const backups = await importFrom(tree, 'apps/desktop/src/main/editor-backups.ts');
  const userData = join(DATA, 'desktop');
  // A fixed source path: the backup's file name is its hash, the same on every run.
  const source = join(SCRATCH, 'project', 'notes.md');
  const input = { content: `Draft reply ${EMOJI.slice(0, 1)}`, expectedContent: 'Draft reply\n' };
  await backups.writeEditorBackup(userData, source, input.content, input.expectedContent);
  const dir = join(userData, 'editor-backups');
  const names = (await import('node:fs')).readdirSync(dir);
  if (names.length !== 1) throw new Error(`expected one backup, found ${names.length}`);
  const rel = names[0];
  const before = keep('editor-backup', 'before', dir, [rel]);
  const lonely = lone(join(dir, rel));
  const read = await backups.readEditorBackup(userData, source);
  const nodeRead = read;
  // Node's own rewrite: the editor backs the draft it read up again, one character longer (writeEditorBackup).
  const op = { writeEditorBackup: { content: `${read.content}!`, expectedContent: read.expectedContent } };
  world.advance(1000);
  await backups.writeEditorBackup(userData, source, op.writeEditorBackup.content, op.writeEditorBackup.expectedContent);
  const after = keep('editor-backup', 'after', dir, [rel]);
  return { input, file: rel, before, nodeRead, op, after, lone: { [rel]: lonely } };
});

world.advance(0);
rmSync(DATA, { recursive: true, force: true });
const order = ['remote-access-settings', 'media-store', 'worktree-registry', 'project-recovery', 'project-recovery-lone-path', 'event-queue', 'config-profile', 'mixy-identity', 'agent-definition', 'editor-backup'];
cases.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
writeJson(join(stage, 'cases.json'), cases);
const recorderFiles = RECORDER_FILES.map((path) => ({ path: `benchmarks/rust-core/recorders/${path}`, sha256: sha256(readFileSync(join(HERE, path))) }));
writeSetManifest(stage, {
  set: 'lone-surrogate-files',
  recorder: 'benchmarks/rust-core/recorders/record-lone-surrogate-files.mjs',
  command: 'node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-lone-surrogate-files.mjs --tree D:\\mixdog-build\\tmp\\b6f-tree',
  identity,
  extra: {
    exact: true,
    nodeVersion: process.version,
    recorderFiles,
    inputs: Object.fromEntries(cases.map((c) => [c.name, c.input])),
    // The only change made to recorded values before a test compares with them: at each listed place (a JSON pointer into the
    // case in cases.json) Node holds a lone unit where the core holds U+FFFD; cases.json is read by serde_json, which holds none.
    // The files under `<case>/before|after/` are Node's bytes, unchanged; each case keeps its input as the JSON text Node wrote
    // of it (`input`), escape included.
    mapping: { ...LONE_MAPPING, at: Object.fromEntries(order.filter((name) => mapped[name]).map((name) => [name, mapped[name]])) },
  },
});
commitStage(stage, SET);
console.log(`recorded ${cases.length} case(s) into ${SET}`);
