#!/usr/bin/env node
// A member's pending approval as its room shows it. For each approval kind this records:
// - `input`: the hook request Node's caller puts to the session's tool-approval queue. ask_user
//   and handoff_user (secret, takeover) are captured from the real callers
//   (`ask-user-tool.mjs` `createAskUserToolHandlers` / `runAskUserHandoff`, with a capturing hook
//   and stubbed page/computer binds). The gate kinds (approval, outbound, connector, permission)
//   are the hook ask the Node funnel builds (`tool-helpers.mjs:222`
//   `ask({ ...request, name, args, cwd, sessionId, toolCallId, reason })`) over a gate request.
// - `toolApproval`: what the queue presents of it (`tool-approval-request.mjs`
//   `normalizeToolApprovalRequest`, the `state.toolApproval` a room reads from its member,
//   `agent-room-turn.ts:278`), at a fixed clock.
// - `roomView`: the room log snapshot decorated with it (`agent-room-views.ts`
//   `decorateRoomSnapshot`), plus decoration-only cases (no state, not speaking, handed-off
//   questions).
//
//   node benchmarks/rust-core/recorders/record-room-approvals.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/room-approvals/golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'room-approvals-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());
const load = (path) => import(pathToFileURL(join(tree, path)).href);

const { normalizeToolApprovalRequest } = await load('src/tui/session/tool-approval-request.mjs');
const askUser = await load('src/session-runtime/internal-tool-executor/ask-user-tool.mjs');
const { validateUserHandoff } = await load('src/runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs');

const esbuild = await importFrom(tree, 'node_modules/esbuild/lib/main.js');
const main = join(tree, 'apps/desktop/src/main');
const outfile = join(sandbox, 'views.mjs');
await esbuild.build({
  stdin: { contents: readFileSync(join(main, 'agent-room-views.ts'), 'utf8'), sourcefile: join(main, 'agent-room-views.ts'), resolveDir: main, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});
const views = await import(pathToFileURL(outfile).href);

const SESSION = 'sess_rmem_room01_gh_bot';
const CALL = 'call_1';
const REQUESTED_AT = 1_700_000_000_000;

/** The hook request a real caller puts to the queue: the first one the capturing hook sees. */
async function captured(run) {
  let seen = null;
  const hook = async (input) => {
    seen ??= JSON.parse(JSON.stringify(input));
    return { approved: false };
  };
  await run(hook);
  if (!seen) throw new Error('the caller asked nothing');
  return seen;
}

const handlers = askUser.createAskUserToolHandlers({ rt: {} });
const callerCtx = (hook) => ({ toolApprovalHook: hook, sessionId: SESSION, toolCallId: CALL });
const handoffInputs = {
  page: async (_session, action) => (action === 'secret_bind' ? { origin: 'https://login.example.com', form: 'login' } : action === 'login_accounts' ? { accounts: [{ id: 'acct-1', label: 'a***@example.com' }] } : { url: 'https://login.example.com/home' }),
  browser: async () => 'entered',
  computer: async () => 'entered',
  computerBind: async () => 'bound',
};
const handoff = (hook, args) => askUser.runAskUserHandoff(validateUserHandoff(args), { hook, sessionId: SESSION, toolCallId: CALL, signal: null, inputs: handoffInputs });

const question = { question: 'Which branch should I merge?', header: 'Branch', options: [{ label: 'main', description: 'The default branch.' }, { label: 'dev', description: 'The work branch.' }] };

/** The gate kinds: the funnel's ask over a gate request. */
const gate = (request, name, args, reason) => ({ ...request, name, args, cwd: 'C:\\work', sessionId: SESSION, toolCallId: CALL, reason });

const kinds = [
  ['ask_user question', await captured((hook) => handlers.ask_user({ questions: [question] }, { callerCtx: callerCtx(hook) }))],
  ['handoff_user browser secret', await captured((hook) => handoff(hook, { handoff: { kind: 'secret', surface: 'browser', target: 'example.com sign-in', field: 'Password', tab: 'p1' } }))],
  ['handoff_user computer secret', await captured((hook) => handoff(hook, { handoff: { kind: 'secret', surface: 'computer', target: 'Mail app', field: 'Passcode', window_id: 'w-7', ref: 'r12', app: 'Mail' } }))],
  ['handoff_user browser takeover', await captured((hook) => handoff(hook, { handoff: { kind: 'takeover', surface: 'browser', target: 'example.com', instructions: 'Solve the captcha, then say done.', tab: 'p1' } }))],
  ['handoff_user login takeover', await captured((hook) => handoff(hook, { handoff: { kind: 'takeover', surface: 'browser', instructions: 'Sign in, then say done.', purpose: 'login', url: 'https://login.example.com/signin' } }))],
  ['handoff_user computer takeover', await captured((hook) => handoff(hook, { handoff: { kind: 'takeover', surface: 'computer', target: 'Mail app', instructions: 'Approve the prompt.', window_id: 'w-7', app: 'Mail' } }))],
  ['shell approval', gate({ kind: 'approval', agentId: 'gh.bot', grantAction: 'tool:shell', remember: ['once', 'session', 'agent', 'always'] }, 'shell', { command: 'npm test' }, '  Runs a command.  ')],
  ['edit approval with an unremembered tool key', gate({ kind: 'approval', agentId: 'gh.bot', grantAction: 'tool:ask_user', remember: ['once', 'session', 'agent'] }, 'apply_patch', { patch: '*** Begin Patch' }, 'Writes a file.')],
  ['bare hook ask', { name: 'mcp__github__create_issue', args: { title: 'x' }, cwd: '', sessionId: SESSION, toolCallId: CALL, reason: '' }],
  ['outbound email', gate({ kind: 'outbound', agentId: 'gh.bot', remember: ['once', 'session', 'always'], account: 'work', outbound: { category: 'email', target: 'boss@example.com', account: 'me@example.com', payload: 'Hello', editable: ['body', 3], details: { to: ' boss@example.com ', subject: 'Status', amount: '', junk: 'x' } } }, 'mcp__gmail__send', { to: 'boss@example.com' }, 'Sends an email.')],
  ['outbound payment', gate({ kind: 'outbound', agentId: 'gh.bot', remember: ['once', 'session', 'agent', 'always'], outbound: { category: 'payment', target: 'shop', account: '', payload: 'Pay 10', editable: [], details: { merchant: 'Shop', amount: '10', currency: 'USD' } } }, 'mcp__pay__charge', {}, 'Pays.')],
  ['connector widen', { name: 'setup', kind: 'connector', agentId: 'gh.bot', connector: { server: 'github', tool: 'create_issue', from: 'disabled', requested: 'auto', choices: ['needs_approval', 'auto', 'bogus'] }, args: { action: 'connector', agent: 'gh.bot', name: 'github', tool: 'create_issue', permission: 'auto' }, reason: 'Wants to create issues.', remember: ['once', 'agent'], sessionId: SESSION, toolCallId: CALL }],
  ['permission', gate({ kind: 'permission', agentId: 'gh.bot', remember: ['once'], permission: { scopes: [{ id: 'allow_once', label: 'Allow once', kind: 'allow_once' }, { id: 'reject', label: '' }, { label: 'no id' }] } }, 'acp_permission', {}, 'Asks.')],
];

const snapshot = { items: [{ kind: 'notice', id: 'n1', text: 'hi' }], busy: false };
const speaking = (approval) => ({ speaking: 'gh.bot', speakingName: 'Git Hub', typingId: 'room-typing-n1', approval });
const cases = kinds.map(([name, input], index) => {
  const id = String(index + 1);
  const realNow = Date.now;
  Date.now = () => REQUESTED_AT;
  const toolApproval = normalizeToolApprovalRequest(input, id, null);
  Date.now = realNow;
  return { name, input, id, requestedAt: REQUESTED_AT, toolApproval, roomView: views.decorateRoomSnapshot(speaking(toolApproval), snapshot) };
});
const asked = [{ id: 'q1', roomMember: 'gh.bot', memberSessionId: SESSION, text: 'Which one?' }];
const decorations = [
  { name: 'no state, no questions', state: null, handoffQuestions: [] },
  { name: 'no state, handed-off questions', state: null, handoffQuestions: asked },
  { name: 'speaking, no approval', state: speaking(null), handoffQuestions: [] },
  { name: 'between speakers', state: { speaking: '', speakingName: '', typingId: '', approval: null }, handoffQuestions: asked },
].map((entry) => ({ ...entry, snapshot, view: views.decorateRoomSnapshot(entry.state ?? undefined, snapshot, entry.handoffQuestions) }));

const finalOut = join(FIXTURES_ROOT, 'room-approvals');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'per approval kind: the hook request the 1.4.5 caller puts to the queue, the toolApproval normalizeToolApprovalRequest presents (clock fixed at requestedAt, no default wait limit), and the room view decorateRoomSnapshot makes of it; plus decoration-only cases',
  session: SESSION,
  toolCallId: CALL,
  cases,
  decorations,
});
writeSetManifest(out, {
  set: 'room-approvals',
  recorder: 'benchmarks/rust-core/recorders/record-room-approvals.mjs',
  command: 'node benchmarks/rust-core/recorders/record-room-approvals.mjs --tree <tree>',
  extra: { cases: cases.length, decorations: decorations.length },
});
commitStage(out, finalOut);
console.log(`cases=${cases.length} decorations=${decorations.length}`);
