#!/usr/bin/env node
// Golden twin of the setup tool's dispatcher (`createSetupToolExecutor`): what the real Node
// executor answers (receipt, or the refusal text) for the settings the core serves and for a
// few actions other packages own, from each kind of caller. The runtime facade is a stub that
// echoes its input, so only what the dispatcher itself decides is recorded: the caller-scope
// and heartbeat refusals, the receipt (`saved`, `scope`, `appliesTo`), the desktop-hosted
// requests nobody claims, the voice check and the fields the dispatcher builds.
//
//   node benchmarks/rust-core/recorders/record-setup-dispatch.mjs --tree <dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

// Mixy's display name is read from the data dir: record the unrenamed default, not this PC's.
const sandbox = mkdtempSync(join(tmpdir(), 'setup-dispatch-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const { agentHomeSessionId } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/agent-home.mjs');
const { roomMemberSessionId } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/agent-room.mjs');
const { markUnattendedRun } = await importFrom(tree, 'src/session-runtime/held-requests.mjs');
const { markHeartbeatSession } = await importFrom(tree, 'src/runtime/shared/routine-trigger.mjs');
const { SETUP_ACTION_FIELDS } = await importFrom(tree, 'src/session-runtime/setup-tool/tool-defs.mjs');

const room = roomMemberSessionId('room42ab', 'helper');

// The calling sessions, by kind: [session id, record].
const CALLERS = {
  human: ['sess_human', { id: 'sess_human', sourceType: 'lead' }],
  acting: ['sess_acting', { id: 'sess_acting', sourceType: 'lead', agent: 'writer' }],
  mixy_acting: ['sess_mixy', { id: 'sess_mixy', sourceType: 'lead', agent: 'lead' }],
  agent: [agentHomeSessionId('helper'), { id: agentHomeSessionId('helper'), owner: 'user', agent: 'helper' }],
  unattended: ['sess_run', { id: 'sess_run', sourceType: 'lead' }],
  room: [room, { id: room }],
  headless: ['sess_bg', { id: 'sess_bg', parentSessionId: 'sess_human' }],
  heartbeat: ['sess_hb', { id: 'sess_hb', sourceType: 'lead' }],
  // A session the host cannot open: `getCallerSession` answers nothing.
  open_fails: ['sess_gone', null],
};
markUnattendedRun('sess_run', { kind: 'schedule', agentId: 'helper', name: 'nightly' });
markHeartbeatSession('sess_hb');

function facade(world) {
  const own = {
    setBotOrder: (order) => ({ order }),
    setCacheWarmingEnabled: (enabled) => ({ enabled }),
    setOutputStyle: (style) => ({ configured: style, appliedToCurrentSession: world.reach }),
    setVoiceEnabled: (enabled) => {
      if (world.voice === 'fail') return { status: { enabled: false, installed: false, components: {} }, error: 'download failed' };
      if (world.voice === 'silent') return { status: { enabled: !enabled, installed: false, components: {} } };
      return { status: { enabled, installed: true, busy: false, components: { whisper: true } } };
    },
  };
  return new Proxy({}, {
    get: (_, name) => {
      if (name === 'then' || typeof name === 'symbol') return undefined;
      return (...args) => (own[name] ? own[name](...args) : { stub: name, args });
    },
  });
}

async function run(world) {
  const [id, record] = CALLERS[world.caller];
  const executor = createSetupToolExecutor({
    getApi: () => facade(world),
    getConfig: () => ({}),
    getSessionId: () => id,
    getCallerSession: (sid) => (sid === id ? record : null),
    notifySessionUi: (_sid, _text, event) => (event?.kind === 'ui-open' ? false : false),
    flushSettings: async () => {},
  });
  try {
    const text = await executor.execute(structuredClone(world.args), { callerSessionId: id });
    return { ok: true, answer: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

const ACTIONS = [
  // Served by the core itself.
  { action: 'set_memory_enabled', enabled: true },
  { action: 'set_recap_enabled', enabled: false },
  { action: 'set_web_search_enabled', enabled: true },
  { action: 'set_instruction_files', instructionFiles: 'agents' },
  { action: 'set_auto_effort_base', autoEffortBase: 'high' },
  { action: 'set_builtin_enabled', name: 'git', enabled: true },
  { action: 'set_builtin_enabled', name: 'browser', enabled: true },
  { action: 'set_builtin_enabled', name: 'voice', enabled: true },
  { action: 'set_builtin_enabled', name: 'voice', enabled: false },
  { action: 'install_builtin', name: 'memory' },
  { action: 'install_builtin', name: 'git' },
  { action: 'install_builtin', name: 'computer' },
  { action: 'install_builtin', name: 'voice' },
  { action: 'set_worktree_settings', worktree: { cleanupArchived: true } },
  { action: 'set_bot_order', botOrder: ['b', 'a'] },
  { action: 'set_cache_warming_enabled', enabled: false },
  { action: 'set_output_style', style: 'minimal' },
  { action: 'set_output_style', style: '   ' },
  // Owned by other packages: the dispatcher's part is the gate and the receipt.
  { action: 'set_auto_update', enabled: true },
  { action: 'set_ai_session_titles', enabled: false },
  { action: 'set_heartbeat_enabled', enabled: true },
  { action: 'set_quota_auto_resume', enabled: true },
  { action: 'set_model_preferences', provider: 'openai', model: 'm', hidden: true },
  { action: 'set_system_shell', command: 'pwsh' },
  { action: 'set_reactions_enabled', enabled: true },
  { action: 'set_cache_warming_enabled', enabled: true },
  { action: 'reconnect_mcp' },
  { action: 'set_agent_route', agent: 'helper', route: { provider: 'openai', model: 'm' } },
  { action: 'connect_connector', connector: 'github' },
  // Agent definitions change only from Mixy.
  { action: 'restore_definition', definitionKind: 'agent', name: 'writer' },
  { action: 'delete_definition', definitionKind: 'agent', name: 'writer' },
];
for (const entry of ACTIONS) {
  if (!Object.hasOwn(SETUP_ACTION_FIELDS, entry.action)) throw new Error(`unknown action ${entry.action}`);
}

const entries = [];
for (const args of ACTIONS) {
  for (const caller of Object.keys(CALLERS)) {
    const worlds = [{ caller, args, reach: false, voice: 'ok' }];
    if (caller === 'human' && args.action === 'set_output_style') worlds.push({ caller, args, reach: true, voice: 'ok' });
    if (caller === 'human' && args.name === 'voice') {
      worlds.push({ caller, args, reach: false, voice: 'fail' }, { caller, args, reach: false, voice: 'silent' });
    }
    for (const world of worlds) entries.push({ ...world, result: await run(world) });
  }
}

writeJson(join_fixture(), {
  domain: 'setup-dispatch-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-dispatch.mjs',
  entries,
});
console.log(`recorded ${entries.length} setup dispatches`);

function join_fixture() {
  return `${FIXTURES_ROOT}/desktop/settings/setup-dispatch-twin.json`;
}
