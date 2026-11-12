#!/usr/bin/env node
// Records what Node's turn does with the folder after the Lead's own `session set-project` call: each tool call
// of the turn starts from the session's live folder (`prepareToolCall`, `tool-exec/call-prep.mjs:69`), not the folder the
// turn began in. A real `askSession` turn over a scripted provider: the Lead switches Project, then lists `.` and
// creates a file by a relative path, each as its own model step.
//
//   node benchmarks/rust-core/recorders/record-switch-project-turn-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/switch-project-turn-cases/{golden.json,MANIFEST.json}.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-switch-project-turn-cases.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-switch-project-'));
const data = join(root, '.mixdog', 'data');
mkdirSync(data, { recursive: true });
for (const key of ['HOME', 'USERPROFILE']) process.env[key] = root;
for (const [key, sub] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['MIXDOG_DESKTOP_USER_DATA', 'desktop'], ['MIXDOG_CONFIG_DIR', 'config'], ['MIXDOG_RUNTIME_ROOT', 'runtime']]) process.env[key] = join(root, sub);
process.env.MIXDOG_HOME = join(root, '.mixdog');
process.env.MIXDOG_DATA_DIR = data;
for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(tree, 'src/runtime/shared/pristine-execution-contract.json'), 'utf8')).guardEnv)) {
  if (k !== 'MIXDOG_DISABLE_MCP' && k !== 'MIXDOG_DISABLE_SKILLS') process.env[k] = v;
}
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_DISABLE_PROVIDER_WARMUP = '1';
process.env.MIXDOG_DISABLE_MODEL_PREFETCH = '1';
process.env.MIXDOG_DISABLE_MODEL_CATALOG_WARMUP = '1';
const at = (p) => import(pathToFileURL(join(tree, p)).href);

const manager = await at('src/runtime/agent/orchestrator/session/manager.mjs');
const { _withRegisteredProviderForTestAsync } = await at('src/runtime/agent/orchestrator/providers/registry.mjs');

const { setInternalToolsProvider } = await at('src/runtime/agent/orchestrator/internal-tools.mjs');
const { createWorkspaceToolHandlers } = await at('src/session-runtime/internal-tool-executor/workspace-tools.mjs');
// The product's own `session` tool handler. Outside the daemon's boot the caller carries no workspace host, so the call's
// `setCallerCwd` is the loop's fallback: the session's folder is set in place (`dispatch.mjs:98`).
const liveSessions = new Map();
const handlers = createWorkspaceToolHandlers({ rt: { get session() { return [...liveSessions.values()][0]; }, config: {} } });
setInternalToolsProvider({
  tools: [{ name: 'session', description: 'session', inputSchema: { type: 'object', properties: { action: { type: 'string' }, path: { type: 'string' } } } }],
  executor: (_name, args, callerCtx) => handlers.session(args, { name: 'session', callerCtx, callerCwd: callerCtx.callerCwd }),
});

const ROOT = '<root>';
const call = (id, name, args) => ({ id, name, arguments: args });
const switchTo = call('c1', 'session', { action: 'set-project', path: `${ROOT}/b` });
const list = call('c2', 'list', { path: '.' });
const create = call('c3', 'edit', { file_path: 'out.txt', old_string: '', new_string: 'written after the switch\n' });
// One batch holding all three calls is not recorded: Node starts every call of a batch before the first one settles, so the
// list and the file land in whichever folder the session holds then, and what a listing shows beside a write in progress
// (the temporary file of the atomic write) depends on scheduling.
const CASES = [
  { name: 'the switch, the list and the file are three model steps', script: [{ toolCalls: [switchTo] }, { toolCalls: [list] }, { toolCalls: [create] }, { reply: 'done' }] },
];

const fill = (value, dir) => JSON.parse(JSON.stringify(value).replaceAll(ROOT, dir.replaceAll('\\', '/')));
const hide = (text, dir) => String(text).replaceAll(dir.replaceAll('\\', '/'), ROOT).replaceAll(dir, ROOT).replaceAll('\\', '/');
const text = (content) => (typeof content === 'string' ? content : (content ?? []).map((p) => p?.text ?? '').join('\n'));

// The `session` answer is JSON text: its folder is written <root>-relative, the session's own id <session>.
const answer = (message, dir, session) => {
  const body = text(message.content);
  if (message.toolCallId !== 'c1') return hide(body, dir);
  const parsed = JSON.parse(body);
  return JSON.stringify({ ...parsed, cwd: hide(parsed.cwd, dir), sessionId: parsed.sessionId === session.id ? '<session>' : parsed.sessionId }, null, 2);
};

const recorded = [];
for (const [index, c] of CASES.entries()) {
  const dir = join(root, `case${index}`);
  for (const sub of ['a', 'b']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'a', 'old.txt'), 'in a\n');
  writeFileSync(join(dir, 'b', 'new.txt'), 'in b\n');
  const script = fill(c.script, dir);
  let sends = 0;
  const stub = {
    name: 'stub',
    contextWindow: 128000,
    async send() {
      const step = script[sends] ?? {};
      sends += 1;
      return { content: step.reply ?? '', toolCalls: step.toolCalls ?? [], stopReason: step.toolCalls ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  let answered;
  let sessionCwd;
  let leadId;
  await _withRegisteredProviderForTestAsync('stub', stub, async () => {
    const lead = manager.createSession({ provider: 'stub', model: 'stub-model', cwd: join(dir, 'a'), owner: 'user', sourceType: 'lead', agent: 'lead' });
    leadId = lead.id;
    liveSessions.clear();
    liveSessions.set(lead.id, lead);
    const result = await manager.askSession(lead.id, 'go', null, undefined, join(dir, 'a'), undefined, {});
    await manager.flushPendingSessionSaves?.();
    const saved = await manager.loadSession(lead.id);
    sessionCwd = saved?.cwd ?? null;
    answered = { content: result?.content ?? result, messages: saved?.messages ?? [] };
  });
  const names = (sub) => readdirSync(join(dir, sub)).sort();
  recorded.push({
    case: c.name,
    script: c.script,
    recorded: {
      reply: hide(text(answered?.content ?? answered), dir),
      toolResults: (answered?.messages ?? []).filter((m) => m.role === 'tool').map((m) => ({ toolCallId: m.toolCallId, content: answer(m, dir, { id: leadId }) })),
      sessionCwd: sessionCwd === null ? null : hide(sessionCwd, dir),
      files: { a: names('a'), b: names('b') },
      created: existsSync(join(dir, 'b', 'out.txt')) ? readFileSync(join(dir, 'b', 'out.txt'), 'utf8') : null,
    },
  });
}

const finalDir = join(FIXTURES_ROOT, 'switch-project-turn-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's askSession turn at ${NODE_COMMIT}, per case of ${RECORDER}`, cases: recorded });
writeSetManifest(stage, {
  set: 'switch-project-turn-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: "per case: every tool result the turn answered, the final reply, the session's folder after the turn, the names in each Project folder afterwards and the created file's text",
    paths: "the case's temporary folder is written <root> in the script and in every answer",
  },
});
commitStage(stage, finalDir);
console.log(`switch-project-turn-cases: ${recorded.length} case(s)`);
process.exit(0);
