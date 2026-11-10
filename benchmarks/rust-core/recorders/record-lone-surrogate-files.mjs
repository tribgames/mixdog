#!/usr/bin/env node
// Files Node (b6f10295a, an exact export) writes holding a lone UTF-16 surrogate, through Node's own writers, for every
// core reader of such a file that parsed it with plain serde_json (which refuses `\ud83d`). A lone surrogate reaches these
// files without any bad client: Node cuts text by UTF-16 units (an alias at 80, a PC name at 64, a media prompt at 4000, a
// board name at 120, a recovery message at 8000) and keeps half of an emoji; or a phone sends text cut inside an emoji and
// Node stores what it parsed (a Mixy name, a profile title, a branch, a webhook field).
//
// Per case: the files exactly as Node wrote them (`<case>/before/...`), the document Node's `JSON.parse` reads from each,
// made well-formed by Node's own outgoing sanitizer (`sanitizeSurrogates`, src/runtime/shared/llm/well-formed.mjs: a lone
// surrogate becomes U+FFFD, decisions.md "frame-lone-surrogate"), and for a read-modify-write store one more Node write
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

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only') ?? null;
const identity = exactProductIdentity(tree, COMMIT);
const SET = join(FIXTURES_ROOT, 'lone-surrogate-files');
const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER_FILES = ['record-lone-surrogate-files.mjs', 'lib/common.mjs', 'lib/deterministic-world.mjs', 'lib/ts-register.mjs', 'lib/ts-resolve-hooks.mjs'];

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

const { sanitizeSurrogates } = await importFrom(tree, 'src/runtime/shared/llm/well-formed.mjs');
const EMOJI = '\u{1F600}';
// `n - 1` letters and an emoji: a cut at `n` UTF-16 units keeps the emoji's high half alone.
const cutAt = (letter, n) => `${letter.repeat(n - 1)}${EMOJI}tail`;

const stage = stageSet(SET, only ? [only] : null);
const cases = only ? JSON.parse(readFileSync(join(SET, 'cases.json'), 'utf8')).filter((c) => c.name !== only) : [];

/** The document Node's `JSON.parse` reads from `file`, well-formed by Node's own sanitizer. */
const documentOf = (file) => sanitizeSurrogates(JSON.parse(readFileSync(file, 'utf8')));
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
  // The case file is read by serde_json too: everything in it is well-formed; the input keeps its lone surrogate as the
  // JSON text Node's `JSON.stringify` makes of it.
  cases.push(sanitizeSurrogates({ name, writer, ...result, input: JSON.stringify(result.input) }));
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
  const nodeRead = sanitizeSurrogates({ settings: await store.read(), deviceAliases: await store.deviceAliases() });
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
  const nodeRead = sanitizeSurrogates({ boards: media.listMediaBoards() });
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
  const nodeRead = sanitizeSurrogates(await registry.readRegistry());
  world.advance(1000);
  const second = record('topic-two', 'topic-two');
  const op = { insert: second };
  await registry.insertRecord(second);
  const after = keep('worktree-registry', 'after', DATA, [rel]);
  return { input, file: rel.split('\\').join('/'), before, nodeRead, op: sanitizeSurrogates(op), after, lone: { [rel]: lonely } };
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
  const nodeRead = sanitizeSurrogates((await recovery.readRecoveryRecord(published)).state);
  const rels = ['manifest.json', 'state.json', '0.before', '0.after'];
  const before = {};
  for (const rel of rels) {
    const to = join(stage, 'project-recovery', 'before', 'record', rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(published, rel), to);
    if (rel.endsWith('.json')) before[`record/${rel}`] = documentOf(join(published, rel));
  }
  const recordId = published.split(/[\\/]/).at(-1);
  return { input, recordId, before, nodeRead, lone: { 'state.json': lone(join(published, 'state.json')) } };
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
  return { input: { body }, file: rel.split('\\').join('/'), before, lone: { [rel]: lone(join(DATA, rel)) } };
});

// ── mixdog-config.json: a profile title a phone sent cut inside an emoji (setProfile, written by updateConfig) ──
await record('config-profile', 'src/runtime/shared/config.mjs:919-929', async () => {
  const config = await importFrom(tree, 'src/runtime/shared/config.mjs');
  const input = { title: `Backend lead ${EMOJI.slice(0, 1)}`, language: 'ko' };
  config.updateConfig((current) => ({ ...current, agent: { ...(current.agent ?? {}), profile: { title: input.title, language: input.language } } }));
  const rel = 'mixdog-config.json';
  const before = keep('config-profile', 'before', DATA, [rel]);
  return { input, file: rel, before, lone: { [rel]: lone(join(DATA, rel)) } };
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
  const nodeRead = sanitizeSurrogates({ mixyDisplayName: mixyDisplayName() });
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
  const nodeRead = sanitizeSurrogates({ identityLine: agentModeIdentityLine('helper') });
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
  const nodeRead = sanitizeSurrogates(await backups.readEditorBackup(userData, source));
  return { input, file: rel, before, nodeRead, lone: { [rel]: lonely } };
});

world.advance(0);
rmSync(DATA, { recursive: true, force: true });
const order = ['remote-access-settings', 'media-store', 'worktree-registry', 'project-recovery', 'event-queue', 'config-profile', 'mixy-identity', 'agent-definition', 'editor-backup'];
cases.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
writeJson(join(stage, 'cases.json'), cases);
const recorderFiles = RECORDER_FILES.map((path) => ({ path: `benchmarks/rust-core/recorders/${path}`, sha256: sha256(readFileSync(join(HERE, path))) }));
writeSetManifest(stage, {
  set: 'lone-surrogate-files',
  recorder: 'benchmarks/rust-core/recorders/record-lone-surrogate-files.mjs',
  command: 'node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-lone-surrogate-files.mjs --tree D:\\mixdog-build\\tmp\\b6f-tree',
  identity,
  extra: { exact: true, nodeVersion: process.version, recorderFiles, inputs: Object.fromEntries(cases.map((c) => [c.name, c.input])) },
});
commitStage(stage, SET);
console.log(`recorded ${cases.length} case(s) into ${SET}`);
