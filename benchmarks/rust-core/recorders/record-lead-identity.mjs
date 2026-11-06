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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

// The one clock the recorded code reads: a damaged file is set aside as `<file>.corrupt-<Date.now()>`,
// and a second recovery in the same millisecond takes the next stamp.
export const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

const sandbox = mkdtempSync(join(tmpdir(), 'lead-identity-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
const tree = resolveTree(parseArgs());
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

function putFiles(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(base, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

// Mixy's two identity folders as written, in a stable order. Images are bytes.
function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const file = join(current, name);
      if (statSync(file).isDirectory()) {
        walk(file);
        continue;
      }
      const rel = relative(dir, file).split('\\').join('/');
      if (!/^(agents\/lead|bots\/mixy)\//.test(rel)) continue;
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
const mask = (value, dir) => JSON.parse(JSON.stringify(value ?? null, (_k, v) => (typeof v === 'string' ? bigText(v.split(dir).join('<data>')) : v)));

async function record(world, index) {
  const root = mkdtempSync(join(tmpdir(), 'lead-identity-world-'));
  const dirs = { shipped: join(root, 'shipped'), data: join(root, 'data') };
  mkdirSync(dirs.shipped, { recursive: true });
  mkdirSync(dirs.data, { recursive: true });
  putFiles(dirs.shipped, world.shipped);
  putFiles(dirs.data, world.data);
  workflow.clearAgentDefinitionCache();
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
    for (const [name, ...args] of CALLS) {
      let outcome;
      try {
        outcome = { ok: mask(await api[name](...args), dirs.data) };
      } catch (error) {
        outcome = { error: mask(String(error?.message ?? error), dirs.data), type: error?.constructor?.name };
      }
      // `publishAgentProfileChange` is not awaited by the save: let its listeners run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      steps.push({ name, args: args.map((a) => (a === undefined ? { $undefined: true } : a)), ...outcome, published, files: snapshot(dirs.data) });
    }
    return { name: `lead-${index}`, world: world.name, shipped: world.shipped, data: world.data, config: world.config, main: world.main, steps };
  } finally {
    unsubscribe();
    rmSync(root, { recursive: true, force: true });
  }
}

function recordAppearance(config) {
  const state = { config: structuredClone(config) };
  const settings = createBuiltinToolSettings({ getConfig: () => state.config, saveConfigAndAdopt: (value) => { state.config = value; } }, {});
  const steps = [];
  for (const [name, ...args] of APPEARANCES) {
    let outcome;
    try {
      outcome = { ok: settings[name](...args) ?? null };
    } catch (error) {
      outcome = { error: String(error?.message ?? error) };
    }
    steps.push({ name, args: args.map((a) => (a === undefined ? { $undefined: true } : a)), ...outcome, config: JSON.parse(JSON.stringify(state.config)) });
  }
  return { config, steps };
}

const worlds = [];
// Every call costs about half a second in Node's editor, so the worlds are the ones that hold
// an identity folder (or the migration marker), at most 16 of them, and two empty ones.
const holdsIdentity = (w) => Object.keys(w.data).some((k) => /^(agents\/(lead|mixy)|bots\/(mixy|migration))/.test(k));
const picked = [...twin.worlds.entries()].filter(([, w]) => holdsIdentity(w)).slice(0, 16);
picked.push(...[...twin.worlds.entries()].filter(([, w]) => !holdsIdentity(w)).slice(0, 2));
for (const [index, world] of picked) worlds.push(await record({ ...world }, index));
const appearances = APPEARANCE_CONFIGS.map(recordAppearance);

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/lead-identity-twin.json`,
  `${JSON.stringify({ domain: 'lead-identity-twin', recorder: 'benchmarks/rust-core/recorders/record-lead-identity.mjs', worlds, appearances }, null, 1)}\n`
);
console.log(`recorded ${worlds.length} worlds, ${worlds.reduce((n, w) => n + w.steps.length, 0)} calls, ${appearances.length} appearance runs`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
