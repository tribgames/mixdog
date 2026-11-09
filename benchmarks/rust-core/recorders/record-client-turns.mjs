#!/usr/bin/env node
// Genuine 1.4.5 client turns whose approval outlives the clients: a real `askSession` turn (the loop, the tool executor, the PreToolUse
// ask, `resolvePreToolAskApproval`) whose `onToolApproval` is the one the client turn installs (tui/session/turn.mjs `toolHandlers`)
// over the session's own approval queue (tui/session/tool-approval.mjs `createToolApproval`, wired as standalone/local-session-runtime.mjs
// wires it: `resolveToolApprovalTimeoutMs()`). Only the provider's `send` is scripted.
//
// What is recorded after each step is what the user's clients can see: the card the queue presents (`toolApproval`), how many wait behind
// it, the outcome of the last card (`toolApprovalResult`), every state patch since the previous step, the held-request count Mixy's
// heartbeat reads (`collectHeartbeatFacts`), and what the model is told about each tool call (the tool messages of the next provider
// request, i.e. the transcript).
//
// Clients are not part of this layer: `detach` and `reattach` are script steps that the recording shows changing nothing, because the
// queue and the turn are owned by the session, not by any client (standalone/session-transport.mjs only reads `clientCount`).
//
// Time: `Date.now` is virtual and moves only with `advance`. The approval queue's expiry timer is the only timer made virtual (the
// ones created while the queue's own functions run); the turn's own machinery keeps real timers, none of which the script waits on.
//
//   node benchmarks/rust-core/recorders/record-client-turns.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/client-turns/golden.json (+ MANIFEST.json). The `script` of each scenario is the recorder's input.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-client-turns.mjs';

const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-client-turns-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(sandbox, name.toLowerCase());
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });

const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);

// ---- virtual time -------------------------------------------------------------------------------------------------------------
const NOW_BASE = 1_800_000_000_000;
let NOW = NOW_BASE;
Date.now = () => NOW;
const timers = { seq: 0, queue: [], registered: 0, scoped: false };
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  if (!timers.scoped) return realSetTimeout(fn, ms, ...args);
  const timer = { virtual: true, due: NOW + Math.max(0, Number(ms) || 0), seq: timers.seq++, fn, args };
  timers.queue.push(timer);
  timers.registered += 1;
  return Object.assign(timer, { ref: () => timer, unref: () => timer, hasRef: () => true, refresh: () => timer });
};
globalThis.clearTimeout = (timer) => {
  if (!timer?.virtual) return realClearTimeout(timer);
  const at = timers.queue.indexOf(timer);
  if (at >= 0) timers.queue.splice(at, 1);
};
const scoped = (fn) => (...args) => {
  timers.scoped = true;
  try {
    return fn(...args);
  } finally {
    timers.scoped = false;
  }
};
function advance(ms) {
  const target = NOW + ms;
  for (;;) {
    // Node runs timers earliest-due first and, at equal due times, in registration order (libuv's timer heap).
    const due = [...timers.queue].sort((a, b) => a.due - b.due || a.seq - b.seq).find((t) => t.due <= target);
    if (!due) break;
    timers.queue.splice(timers.queue.indexOf(due), 1);
    NOW = due.due;
    scoped(due.fn)(...due.args);
  }
  NOW = target;
}

// ---- the product --------------------------------------------------------------------------------------------------------------
const S = 'src/runtime/agent/orchestrator/';
const { createSession } = await imp(`${S}session/manager/session-lifecycle.mjs`);
const { askSession } = await imp(`${S}session/manager/ask-session.mjs`);
const { _withRegisteredProviderForTestAsync } = await imp(`${S}providers/registry.mjs`);
const { modelToolSchemaAllowlist } = await imp(`${S}runtime-core/tool-profile.mjs`);
const { createToolApproval, resolveToolApprovalTimeoutMs } = await imp('src/tui/session/tool-approval.mjs');
const { toolHandlers } = await imp('src/tui/session/turn.mjs');
const { createTurnStream } = await imp('src/tui/session/turn-stream.mjs');
const { collectHeartbeatFacts } = await imp('src/session-runtime/mixy-heartbeat.mjs');
const { roomMemberSessionId } = await imp(`${S}session/agent-room.mjs`);

const workdir = join(sandbox, 'work');
mkdirSync(workdir, { recursive: true });
writeFileSync(join(workdir, 'x.txt'), 'FILE-SENTINEL\n');
// The turns are a room member's own session: the run the held layer recognizes, so that a card shown to a client and a hold are the two outcomes there are.
mkdirSync(join(process.env.MIXDOG_DATA_DIR, 'agents', 'ann'), { recursive: true });
writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'agents', 'ann', 'AGENT.md'), '---\nkind: bot\n---\nHelp the user.\n');
const clone = (value) => JSON.parse(JSON.stringify(value));

const READ_A = { id: 'call_a', name: 'read', arguments: { path: 'x.txt' } };
const READ_B = { id: 'call_b', name: 'read', arguments: { path: 'x.txt', offset: 0 } };
const TOOL_ROUND = (call) => ({ content: 'reading', toolCalls: [call], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } });
const FINAL = { content: 'all done', usage: { inputTokens: 1, outputTokens: 1 } };
const APPROVE = { approved: true, device: 'Pixel' };
const DENY = { approved: false, reason: 'not now', device: 'Pixel' };
const HUNDRED_YEARS = 100 * 365 * 86_400_000;
const TIMEOUT_ENV = { MIXDOG_TOOL_APPROVAL_TIMEOUT_MS: '600000' };

const SCENARIOS = [
  { name: 'the clients leave before the tool is asked: the card waits, a hundred years later it is still the same card, and a client that returns approves it', env: {}, replies: [TOOL_ROUND(READ_A), FINAL], script: [{ op: 'start' }, { op: 'detach' }, { op: 'release' }, { op: 'facts' }, { op: 'advance', ms: HUNDRED_YEARS }, { op: 'facts' }, { op: 'reattach' }, { op: 'answer', decision: APPROVE }, { op: 'release' }] },
  { name: 'the clients leave before the tool is asked: a client that returns denies it', env: {}, replies: [TOOL_ROUND(READ_A), FINAL], script: [{ op: 'start' }, { op: 'detach' }, { op: 'release' }, { op: 'advance', ms: HUNDRED_YEARS }, { op: 'reattach' }, { op: 'answer', decision: DENY }, { op: 'release' }] },
  { name: 'the clients stay: the card is answered at once', env: {}, replies: [TOOL_ROUND(READ_A), FINAL], script: [{ op: 'start' }, { op: 'release' }, { op: 'facts' }, { op: 'answer', decision: APPROVE }, { op: 'release' }] },
  { name: 'the clients leave after the first tool: the second tool asked later waits on the same queue, and is approved when a client returns', env: {}, replies: [TOOL_ROUND(READ_A), TOOL_ROUND(READ_B), FINAL], script: [{ op: 'start' }, { op: 'release' }, { op: 'answer', decision: APPROVE }, { op: 'detach' }, { op: 'release' }, { op: 'facts' }, { op: 'advance', ms: HUNDRED_YEARS }, { op: 'facts' }, { op: 'reattach' }, { op: 'answer', decision: APPROVE }, { op: 'release' }] },
  // The only expiry there is is opt-in (`MIXDOG_TOOL_APPROVAL_TIMEOUT_MS`, "tests and ops"); the product's default is no limit.
  { name: 'with the opt-in limit: the clients leave and the limit passes, the card expires and the model is told it was denied', env: TIMEOUT_ENV, replies: [TOOL_ROUND(READ_A), FINAL], script: [{ op: 'start' }, { op: 'detach' }, { op: 'release' }, { op: 'advance', ms: 599_999 }, { op: 'facts' }, { op: 'advance', ms: 1 }, { op: 'facts' }, { op: 'release' }] },
  { name: 'with the opt-in limit: a client returns before the limit and approves, and the limit passing later changes nothing', env: TIMEOUT_ENV, replies: [TOOL_ROUND(READ_A), FINAL], script: [{ op: 'start' }, { op: 'detach' }, { op: 'release' }, { op: 'advance', ms: 599_999 }, { op: 'reattach' }, { op: 'answer', decision: APPROVE }, { op: 'advance', ms: 10 }, { op: 'release' }] },
];

async function runScenario(index, scenario) {
  NOW = NOW_BASE + index * 1_000_000_000;
  timers.queue.length = 0;
  timers.registered = 0;
  // ---- the session's approval queue, as the local session runtime wires it ----
  let state = { toolApproval: null, toolApprovalResult: null };
  let patches = [];
  let seq = 0;
  let requests = 0;
  const watchers = new Set();
  const poke = () => {
    for (const watcher of [...watchers]) watcher();
  };
  const queue = createToolApproval({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      patches.push(clone(patch));
    },
    nextId: () => `req-${++seq}`,
    getDisposed: () => false,
    timeoutMs: resolveToolApprovalTimeoutMs(scenario.env),
  });
  const requestToolApproval = scoped((input) => {
    requests += 1;
    const answer = queue.requestToolApproval(input);
    poke();
    return answer;
  });
  const finishToolApproval = scoped(queue.finishToolApproval);
  // ---- the client turn's own handler over it ----
  const ctx = { isCurrentTurn: () => true, getState: () => state, set: (patch) => {
    state = { ...state, ...patch };
    patches.push(clone(patch));
  }, markPromptCommitted: () => {}, requestToolApproval, cards: {}, options: {} };
  ctx.stream = createTurnStream({ isCurrentTurn: ctx.isCurrentTurn, getState: ctx.getState, set: ctx.set });
  const { onToolApproval } = toolHandlers(ctx);

  // ---- the turn: a real askSession against a scripted provider ----
  const sends = [];
  const gates = [];
  const gate = (i) => (gates[i] ??= (() => {
    let release;
    const promise = new Promise((resolve) => (release = resolve));
    return { promise, release };
  })());
  const sessionId = roomMemberSessionId(`room${String(index).padStart(3, '0')}abc`, 'ann');
  const providerName = `client-turn-${index}`;
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages) {
      const i = sends.length;
      sends.push(messages.map((m) => ({ role: m.role, content: m.content })));
      poke();
      await gate(i).promise;
      return clone(scenario.replies[i]);
    },
  };
  const trace = [];
  let released = 0;
  let turn = null;
  let turnDone = false;
  const waitUntil = (done) =>
    new Promise((resolve) => {
      const check = () => {
        if (!done()) return;
        watchers.delete(check);
        resolve();
      };
      watchers.add(check);
      check();
    });
  const view = () => {
    const out = {
      card: state.toolApproval ? { name: state.toolApproval.name, args: state.toolApproval.args, reason: state.toolApproval.reason, timeoutMs: state.toolApproval.timeoutMs, expiresAt: state.toolApproval.expiresAt } : null,
      waiting: state.toolApprovalsWaiting ?? 0,
      outcome: state.toolApprovalResult ? { approved: state.toolApprovalResult.approved, device: state.toolApprovalResult.device, expired: state.toolApprovalResult.expired === true, interrupted: state.toolApprovalResult.interrupted === true, at: state.toolApprovalResult.at } : null,
      patches: patches.map((p) => Object.keys(p).sort()),
    };
    patches = [];
    return out;
  };
  const presentedId = () => state.toolApproval?.id ?? null;

  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const session = createSession({ id: sessionId, provider: providerName, model: 'fake-model', cwd: workdir, skipSkills: true, schemaAllowedTools: modelToolSchemaAllowlist('headless'), workflow: { id: 'headless', delegatesAgents: false } });
    // The PreToolUse hook every session carries (session-runtime/session-hooks.mjs): this one asks for each tool call.
    session.beforeToolHook = async () => ({ action: 'ask', reason: 'needs approval' });
    for (const op of scenario.script) {
      if (op.op === 'start') {
        turn = askSession(session.id, 'go', null, null, null, null, { onToolApproval }).then((result) => {
          turnDone = true;
          poke();
          return result;
        });
        turn.catch(() => {});
        await waitUntil(() => sends.length === 1);
        trace.push({ op: 'start', sends: sends.length });
      } else if (op.op === 'detach' || op.op === 'reattach') {
        trace.push({ op: op.op, ...view() });
      } else if (op.op === 'release') {
        // The provider answers its next request; the script then waits for the next card, the next request, or the turn's end.
        const requestsBefore = requests;
        const sendsBefore = sends.length;
        gate(released).release();
        released += 1;
        await waitUntil(() => requests > requestsBefore || sends.length > sendsBefore || turnDone);
        trace.push({ op: 'release', sends: sends.length, turnDone, ...view() });
      } else if (op.op === 'facts') {
        const facts = await collectHeartbeatFacts({ since: 0, getSessionService: () => ({ listSessionCatalog: async () => ({ sessions: [], nextCursor: null }), liveSessionAwaitingApproval: () => false }), routines: async () => [], taskWatches: async () => [] });
        trace.push({ op: 'facts', approvals: facts.approvals, ...view() });
      } else if (op.op === 'advance') {
        advance(op.ms);
        // The expiry settles the card and the turn goes on to its next provider request.
        const sendsBefore = sends.length;
        const expired = state.toolApprovalResult?.expired === true;
        trace.push({ op: 'advance', ms: op.ms, now: NOW, ...view() });
        if (!expired && state.toolApprovalResult?.expired === true) await waitUntil(() => sends.length > sendsBefore || turnDone);
      } else if (op.op === 'answer') {
        const sendsBefore = sends.length;
        const id = presentedId();
        const accepted = finishToolApproval(id, op.decision.approved, op.decision.reason ?? '', op.decision.device);
        await waitUntil(() => sends.length > sendsBefore || turnDone);
        trace.push({ op: 'answer', accepted, ...view() });
      } else throw new Error(`unknown op ${op.op}`);
    }
    // ---- the end: the turn's result and what the model was told about each tool call ----
    const result = await turn;
    const toolMessages = sends.slice(1).map((messages) => {
      const tool = [...messages].reverse().find((m) => m.role === 'tool');
      return typeof tool?.content === 'string' ? tool.content : JSON.stringify(tool?.content ?? null);
    });
    trace.push({ op: 'end', answer: result.content, sends: sends.length, toolMessages, ...view() });
  });
  return { name: scenario.name, session: sessionId, now: NOW_BASE + index * 1_000_000_000, env: scenario.env, replies: scenario.replies, script: scenario.script, trace, timers: { registered: timers.registered, pending: timers.queue.length } };
}

const scenarios = [];
for (const [index, scenario] of SCENARIOS.entries()) scenarios.push(await runScenario(index, scenario));

const finalDir = join(FIXTURES_ROOT, 'client-turns');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), {
  note: 'a real askSession turn over the client turn\'s approval queue (turn.mjs toolHandlers over tool-approval.mjs), at b6f10295a',
  scenarios,
});
writeSetManifest(stage, { set: 'client-turns', recorder, command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`, identity, extra: { scenarios: scenarios.length } });
commitStage(stage, finalDir);
console.log(`scenarios=${scenarios.length}`);
process.exit(0);
