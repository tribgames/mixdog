#!/usr/bin/env node
// Golden twin of Mixy's (the Lead's) identity files and appearance: what Node's real editor
// API (workflow-agents-api/agent-editor.mjs createLeadIdentityApi: getLeadPersona,
// saveLeadPersona, getLeadAgentBody, saveLeadAgentBody, getLeadStatus, getLeadHomeRoute,
// saveLeadIdentity, setLeadCreated) and the built-in settings API (settings-builtin-tools-api.mjs
// getLeadAppearance / setLeadAppearance) answer over the worlds of agent-definitions-twin.json,
// and the files they leave. After every call the identity folders (agents/lead, bots/mixy) are
// recorded as written, with the number of profile-change publications so far. Run
// record-agent-definitions.mjs first: its worlds are this recorder's starting points.
//
//   node benchmarks/rust-core/recorders/record-lead-identity.mjs --tree <dir>
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, parse, relative } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

// The one clock the recorded code reads: a damaged file is set aside as `<file>.corrupt-<Date.now()>`,
// and a second recovery in the same millisecond takes the next stamp.
export const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

// Every path the recorded code sees is this one, on both sides: Node's error texts name the files
// they failed on, and the recording keeps them as they came. The Rust replay builds the same
// folders at the same place (`pin` of the recording).
export const PIN = join(parse(tmpdir()).root, 'mixdog-twin', 'lead-identity');
rmSync(PIN, { recursive: true, force: true });
const sandbox = join(PIN, 'home');
mkdirSync(sandbox, { recursive: true });
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(PIN, 'backups');
const tree = resolveTree(parseArgs());
const { createConfigPatch, loadConfig, saveConfigPatch } = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');
const { forgetBotStoreCache } = await importFrom(tree, 'src/runtime/shared/agent-store.mjs');
const { createWorkflowAgentsApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api.mjs');
const workflow = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const { subscribeAgentProfileChanges } = await importFrom(tree, 'src/session-runtime/agent-profile-changes.mjs');
const { createBuiltinToolSettings } = await importFrom(tree, 'src/session-runtime/settings-builtin-tools-api.mjs');

const twin = JSON.parse(readFileSync(`${FIXTURES_ROOT}/desktop/settings/agent-definitions-twin.json`, 'utf8'));

const chunk = (type, data) => Buffer.concat([Buffer.from([0, 0, 0, data.length]), Buffer.from(type), data, Buffer.alloc(4)]);
function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IEND', Buffer.alloc(0))];
  return `data:image/png;base64,${Buffer.concat(parts).toString('base64')}`;
}
const MASCOT = { kind: 'mascot', species: 'corgi', accessory: 'bow', expression: 'happy', color: '#F06A5F' };
const AVATARS = [
  MASCOT,
  { kind: 'mascot', variant: 'floppy-happy-collar', color: '#e6e6e6' },
  { kind: 'mascot', species: 'dragon', color: '#e6e6e6' },
  { kind: 'custom', states: { idle: { data: png(16, 16) } } },
  { kind: 'image', data: png(16, 16) },
  { kind: 'custom', states: { idle: { data: png(600, 600) } } },
  { kind: 'custom', states: { idle: 'idle-0123456789ab.png' } },
  { kind: 'nothing' },
  null,
];

// The calls, in order. `args` is what the Node API function takes.
const BIG = 256 * 1024;
const CALLS = [
  ['getLeadPersona'],
  ['getLeadAgentBody'],
  ['getLeadStatus'],
  ['getLeadHomeRoute'],
  ['saveLeadPersona', 'Be kind.'],
  ['getLeadPersona'],
  ['saveLeadPersona', '  padded \n\n'],
  ['saveLeadPersona', ''],
  ['saveLeadPersona', null],
  ['saveLeadPersona', undefined],
  ['saveLeadPersona', 5],
  ['saveLeadPersona', '한글 persona\r\nsecond line'],
  ['saveLeadPersona', 'x'.repeat(BIG)],
  ['saveLeadPersona', 'x'.repeat(BIG + 1)],
  ['saveLeadPersona', '한'.repeat(Math.floor(BIG / 3) + 1)],
  ['saveLeadPersona', 'ok again'],
  ['saveLeadAgentBody', 'Work carefully.\n'],
  ['getLeadAgentBody'],
  ['saveLeadAgentBody', ' \t '],
  ['saveLeadAgentBody', 'y'.repeat(BIG + 1)],
  ['saveLeadAgentBody', 'Body again'],
  ['saveLeadAgentBody', 7],
  ['saveLeadAgentBody', 0],
  ['saveLeadPersona', true],
  ['saveLeadPersona', { a: 1 }],
  ['saveLeadPersona', ['x', 2]],
  ['saveLeadPersona', 1e21],
  ['saveLeadIdentity', {}],
  ['saveLeadIdentity', { name: 'Mixy Two' }],
  ['saveLeadIdentity', { name: '  spaced \n  out  ' }],
  ['saveLeadIdentity', { name: 'n'.repeat(64) }],
  ['saveLeadIdentity', { name: 'n'.repeat(65) }],
  ['saveLeadIdentity', { name: '한'.repeat(64) }],
  ['saveLeadIdentity', { name: '😀'.repeat(33) }],
  ['saveLeadIdentity', { name: 'Keep Me' }],
  ...AVATARS.map((avatar) => ['saveLeadIdentity', { avatar }]),
  ['saveLeadIdentity', { name: 'Both', avatar: AVATARS[3] }],
  ['saveLeadIdentity', { name: '', avatar: null }],
  ['saveLeadIdentity', { other: 1 }],
  ['saveLeadIdentity', undefined],
  ['saveLeadIdentity', 'text'],
  ['saveLeadIdentity', null],
  ['getLeadStatus'],
  ['setLeadCreated', true],
  ['setLeadCreated', false, '  does   things\n'],
  ['setLeadCreated', true, ''],
  ['setLeadCreated', true, 'Handles mail'],
  ['setLeadCreated', 'yes'],
  ['setLeadCreated', 1],
  ['setLeadCreated', undefined],
  ['setLeadCreated', null],
  ['setLeadCreated', 'true'],
  ['setLeadCreated', true, 42],
  ['setLeadCreated', false, { a: 1 }],
  ['setLeadCreated', true, null],
  ['getLeadStatus'],
  ['getLeadHomeRoute'],
];
// Config for the appearance calls: the same sequence runs against an empty and a filled config.
const APPEARANCES = [
  ['getLeadAppearance'],
  ['setLeadAppearance', MASCOT],
  ['getLeadAppearance'],
  ['setLeadAppearance', { kind: 'mascot', variant: 'floppy-happy-collar', color: '#e6e6e6' }],
  ['setLeadAppearance', { kind: 'custom', states: { idle: 'idle-0123456789ab.png' } }],
  ['setLeadAppearance', { kind: 'mascot', species: 'dragon', color: '#e6e6e6' }],
  ['setLeadAppearance', { kind: 'nothing' }],
  ['setLeadAppearance', 'mascot'],
  ['setLeadAppearance', undefined],
  ['getLeadAppearance'],
  ['setLeadAppearance', MASCOT],
  ['setLeadAppearance', null],
  ['getLeadAppearance'],
];
const APPEARANCE_CONFIGS = [
  {},
  { leadAvatar: MASCOT, botOrder: ['a'] },
  { leadAvatar: { kind: 'custom', states: { idle: 'idle-0123456789ab.png' } } },
  { leadAvatar: 'junk' },
];

// A key ending in `/` is a folder.
function putFiles(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(base, rel);
    if (rel.endsWith('/')) {
      mkdirSync(file, { recursive: true });
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

// Controlled failures. Each world is a data folder where something in Mixy's identity folder is
// not what a save expects, with the calls that run into it.
const TORN = '{ "created": tru';
const GOOD = `${JSON.stringify({ created: true, name: 'Old', connectors: ['gmail'] }, null, 2)}\n`;
const LEAD = 'agents/lead';
const FAULTS = [
  { name: 'fault-persona-is-a-folder', data: { [`${LEAD}/PERSONA.md/keep.txt`]: 'x', [`${LEAD}/AGENT.md/keep.txt`]: 'x' }, calls: [['getLeadPersona'], ['saveLeadPersona', ''], ['saveLeadAgentBody', '  '], ['getLeadStatus']] },
  { name: 'fault-agents-is-a-file', data: { agents: 'not a folder' }, calls: [['saveLeadPersona', 'x'], ['saveLeadAgentBody', 'x'], ['saveLeadIdentity', { name: 'A' }], ['setLeadCreated', true], ['getLeadStatus']] },
  { name: 'fault-identity-folder-is-a-file', data: { [LEAD]: 'not a folder' }, calls: [['getLeadPersona'], ['saveLeadPersona', 'x'], ['saveLeadIdentity', { name: 'A' }], ['setLeadCreated', true], ['getLeadStatus']] },
  { name: 'fault-avatar-is-a-file', data: { [`${LEAD}/avatar`]: 'not a folder' }, calls: [['saveLeadIdentity', { name: 'A', avatar: { kind: 'custom', states: { idle: { data: png(16, 16) } } } }], ['getLeadStatus']] },
  { name: 'fault-manifest-is-a-folder', data: { [`${LEAD}/agent.json/keep.txt`]: 'x' }, calls: [['saveLeadIdentity', { name: 'A' }], ['setLeadCreated', true], ['getLeadStatus']] },
  { name: 'corrupt-restored-from-backup', data: { [`${LEAD}/agent.json`]: TORN, [`${LEAD}/agent.json.bak`]: GOOD }, calls: [['saveLeadIdentity', { name: 'New' }], ['getLeadStatus']] },
  { name: 'corrupt-recovered-before-the-name-is-refused', data: { [`${LEAD}/agent.json`]: TORN, [`${LEAD}/agent.json.bak`]: GOOD }, calls: [['saveLeadIdentity', { name: 'n'.repeat(65) }], ['getLeadStatus']] },
  { name: 'corrupt-set-aside-name-is-taken', data: { [`${LEAD}/agent.json`]: TORN, [`${LEAD}/agent.json.bak`]: GOOD, [`${LEAD}/agent.json.corrupt-${FIXED_NOW}`]: 'older', [`${LEAD}/agent.json.corrupt-${FIXED_NOW + 1}`]: 'older too' }, calls: [['setLeadCreated', true, 'Keeps mail'], ['getLeadStatus']] },
  { name: 'corrupt-without-a-good-copy', data: { [`${LEAD}/agent.json`]: TORN }, calls: [['saveLeadIdentity', { name: 'X' }], ['setLeadCreated', true], ['getLeadStatus']] },
  { name: 'corrupt-nul-filled', data: { [`${LEAD}/agent.json`]: '\0'.repeat(24), [`${LEAD}/agent.json.bak`]: GOOD }, calls: [['setLeadCreated', false], ['getLeadStatus']] },
  { name: 'corrupt-not-an-object', data: { [`${LEAD}/agent.json`]: '[1, 2]', [`${LEAD}/agent.json.bak`]: GOOD }, calls: [['saveLeadIdentity', { name: 'Obj' }], ['getLeadStatus']] },
];

// Mixy's two identity folders as written, in a stable order. Images are bytes.
function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const file = join(current, name);
      const rel = relative(dir, file).split('\\').join('/');
      if (statSync(file).isDirectory()) {
        // An empty identity folder is part of what a call leaves.
        if (readdirSync(file).length === 0 && /^(agents\/lead|bots\/mixy)(\/|$)/.test(rel)) files[`${rel}/`] = '';
        walk(file);
        continue;
      }
      // `agents` or `bots` that is a file instead of a folder counts too.
      if (!/^(agents|bots)$|^(agents\/lead|bots\/mixy)(\/|$)/.test(rel)) continue;
      const key = rel;
      const text = /(^|\/)avatar\/|\.(png|gif|webp)$/.test(rel) ? `b64:${readFileSync(file).toString('base64')}` : readFileSync(file, 'utf8');
      // The 256 KB saves are pinned by length and digest, not stored whole.
      files[key] = bigText(text);
    }
  };
  walk(dir);
  return files;
}

const bigText = (text) => (text.length > 4096 ? `big:${Buffer.byteLength(text)}:${createHash('sha256').update(text).digest('hex')}` : text);
// The answer as JSON, strings kept as they are (only a 256 KB text is pinned by size and digest).
const plain = (value) => JSON.parse(JSON.stringify(value ?? null, (_k, v) => (typeof v === 'string' ? bigText(v) : v)));

async function record(world, index, calls = CALLS) {
  const root = join(PIN, 'world');
  rmSync(root, { recursive: true, force: true });
  const dirs = { shipped: join(root, 'shipped'), data: join(root, 'data') };
  mkdirSync(dirs.shipped, { recursive: true });
  mkdirSync(dirs.data, { recursive: true });
  putFiles(dirs.shipped, world.shipped);
  putFiles(dirs.data, world.data);
  // The data folder has one path in every world, so what this process cached of the last one is dropped.
  workflow.clearAgentDefinitionCache();
  forgetBotStoreCache(dirs.data);
  const state = { config: { workflow: { active: 'default' }, ...world.config } };
  let published = 0;
  const { unsubscribe } = subscribeAgentProfileChanges(() => {
    published += 1;
  });
  try {
    const helpers = workflow.createWorkflowHelpers({ rootDir: dirs.shipped, dataDir: dirs.data, readMarkdownDocument, normalizeAgentPermissionOrNone });
    const { agentRouteFromConfig } = workflow.createWorkflowRouteHelpers({ findPreset: () => null });
    const api = createWorkflowAgentsApi({
      ...helpers,
      rootDir: dirs.shipped,
      getConfig: () => state.config,
      displayConfig: () => state.config,
      cfgMod: { getPluginData: () => dirs.data },
      STANDALONE_DATA_DIR: dirs.data,
      resolveRoute: (_config, requested) => (Object.keys(requested).length ? { ...requested } : world.main ? { ...world.main } : null),
      agentRouteFromConfig,
      saveConfigAndAdopt: (value) => {
        state.config = value;
      },
      setAgentRoute: async () => {},
      lookupModelMeta: async () => ({}),
      ensureProvidersReady: async () => {},
      refreshEmptySessionToolPolicy: async () => ({ appliedToCurrentSession: true }),
      invalidateContextStatusCache() {},
    });
    const steps = [];
    for (const [name, ...args] of calls) {
      let outcome;
      try {
        outcome = { ok: plain(await api[name](...args)) };
      } catch (error) {
        outcome = { error: plain(String(error?.message ?? error)), code: error?.code ?? null, type: error?.constructor?.name };
      }
      // `publishAgentProfileChange` is not awaited by the save: let its listeners run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      steps.push({ name, args: args.map((a) => (a === undefined ? { $undefined: true } : a)), ...outcome, published, files: snapshot(dirs.data) });
    }
    return { name: typeof index === 'number' ? `lead-${index}` : index, world: world.name, shippedDir: dirs.shipped, dataDir: dirs.data, shipped: world.shipped, data: world.data, config: world.config, main: world.main, steps };
  } finally {
    unsubscribe();
    rmSync(root, { recursive: true, force: true });
  }
}

// The face lives in the stored config. The settings API's own functions run over the real config
// store (`createConfigPatch` + `saveConfigPatch`, what `saveConfigAndAdopt` persists through), and
// the config file is recorded as written after every call.
const CONFIG_FILE = join(sandbox, 'mixdog-config.json');
const READ_ONLY = '$makeConfigFileReadOnly';
const WRITABLE = '$makeConfigFileWritable';
const ENABLED_BY_DEFAULT = ['front-worker', 'heavy-worker', 'maintainer', 'reviewer', 'security', 'worker', 'writer'];
function recordAppearance(config, calls = APPEARANCES) {
  rmSync(CONFIG_FILE, { recursive: true, force: true });
  // A profile that has been through its first save: Node's first write of a fresh file adds its
  // defaults marker and the agents on by default, which is the config store's business, not the face's.
  const seed = `${JSON.stringify({ agent: { enabledAgents: ENABLED_BY_DEFAULT, ...config }, defaultsVersion: 2 }, null, 2)}\n`;
  writeFileSync(CONFIG_FILE, seed);
  const settings = createBuiltinToolSettings(
    {
      getConfig: () => loadConfig({ secrets: false }),
      saveConfigAndAdopt: (value) => saveConfigPatch(createConfigPatch(loadConfig({ secrets: false }), value)),
    },
    {}
  );
  const steps = [];
  for (const [name, ...args] of calls) {
    let outcome = {};
    if (name === READ_ONLY || name === WRITABLE) {
      chmodSync(CONFIG_FILE, name === READ_ONLY ? 0o444 : 0o644);
    } else {
      try {
        outcome = { ok: plain(settings[name](...args)) };
      } catch (error) {
        outcome = { error: plain(String(error?.message ?? error)), code: error?.code ?? null, type: error?.constructor?.name };
      }
    }
    const stat = statSync(CONFIG_FILE, { throwIfNoEntry: false });
    const file = !stat ? null : stat.isDirectory() ? { folder: true } : readFileSync(CONFIG_FILE, 'utf8');
    steps.push({ name, args: args.map((a) => (a === undefined ? { $undefined: true } : a)), ...outcome, file });
  }
  return { configFile: CONFIG_FILE, seed, config, steps };
}

const worlds = [];
// Every call costs about half a second in Node's editor, so the worlds are the ones that hold
// an identity folder (or the migration marker), at most 16 of them, and two empty ones.
const holdsIdentity = (w) => Object.keys(w.data).some((k) => /^(agents\/(lead|mixy)|bots\/(mixy|migration))/.test(k));
const picked = [...twin.worlds.entries()].filter(([, w]) => holdsIdentity(w)).slice(0, 16);
picked.push(...[...twin.worlds.entries()].filter(([, w]) => !holdsIdentity(w)).slice(0, 2));
for (const [index, world] of picked) worlds.push(await record({ ...world }, index));
for (const fault of FAULTS) worlds.push(await record({ name: fault.name, shipped: {}, data: fault.data, config: {}, main: null }, fault.name, fault.calls));
const appearances = APPEARANCE_CONFIGS.map((config) => recordAppearance(config));
appearances.push(
  recordAppearance({ leadAvatar: MASCOT }, [['setLeadAppearance', { kind: 'mascot', species: 'dragon', color: '#e6e6e6' }], [READ_ONLY], ['setLeadAppearance', MASCOT], ['setLeadAppearance', null], ['getLeadAppearance'], [WRITABLE], ['setLeadAppearance', MASCOT], ['getLeadAppearance']])
);

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/lead-identity-twin.json`,
  `${JSON.stringify({ domain: 'lead-identity-twin', recorder: 'benchmarks/rust-core/recorders/record-lead-identity.mjs', pin: PIN, clock: FIXED_NOW, worlds, appearances }, null, 1)}\n`
);
console.log(`recorded ${worlds.length} worlds, ${worlds.reduce((n, w) => n + w.steps.length, 0)} calls, ${appearances.length} appearance runs`);
rmSync(PIN, { recursive: true, force: true });
process.exit(0);
