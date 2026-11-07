#!/usr/bin/env node
// What the cache warm replays after a restart (WP-AI-CORE): the REAL `lastSentMainRequest`
// (session/side-question.mjs), which rebuilds the session's next request from the stored record
// (`nextMainRequest`: no tail reminder; `cacheWarmSend` adds it at warm time) and cuts off the
// reply the last request produced. Each case stores a session record and records the answer: null,
// or the kept messages (role, content, source), the send time, the model and the tool names.
//
//   node benchmarks/rust-core/recorders/record-last-sent.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/last-sent/golden.json. `decidedBy` says which rule answered:
// `trim` (the transcript's tail and the send time: the rule this port adds) or `next` (the
// rebuild itself: a closed, agent-owned or conversation-less session, an unknown provider; Rust
// has those in `next_request`). Every user directory is a fresh temp one BEFORE any product module
// loads.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'last-sent-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'last-sent');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-last-sent.mjs';
const S = 'src/runtime/agent/orchestrator/session';
const { lastSentMainRequest } = await importFrom(tree, `${S}/side-question.mjs`);
const { loadSession } = await importFrom(tree, `${S}/store.mjs`);
const { setLiveSession } = await importFrom(tree, `${S}/store/live-state.mjs`);
const { _withRegisteredProviderForTestAsync } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');

const TOOLS = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }];
const SYSTEM = { role: 'system', content: 'You are the Lead.' };
const USER = (text) => ({ role: 'user', content: text });
const ASSISTANT = (text) => ({ role: 'assistant', content: text });
const CALL = { id: 'call_1', name: 'read', arguments: { path: 'a.mjs' } };
const SENT = 1_700_000_000_000;

// `decidedBy` is stated by hand: what the case is about.
const CASES = [
  { name: 'ends_with_the_reply', decidedBy: 'trim', messages: [SYSTEM, USER('Refactor.'), ASSISTANT('Reading first.')], sent: SENT },
  { name: 'two_trailing_replies', decidedBy: 'trim', messages: [SYSTEM, USER('Refactor.'), ASSISTANT('One.'), ASSISTANT('Two.')], sent: SENT },
  { name: 'a_later_turn', decidedBy: 'trim', messages: [SYSTEM, USER('a'), ASSISTANT('b'), USER('c'), ASSISTANT('d')], sent: SENT },
  { name: 'a_tool_round_keeps_everything_before_the_last_reply', decidedBy: 'trim', messages: [SYSTEM, USER('a'), { role: 'assistant', content: '', toolCalls: [CALL] }, { role: 'tool', toolCallId: 'call_1', content: 'x' }, ASSISTANT('done')], sent: SENT },
  { name: 'ends_with_a_user_message', decidedBy: 'trim', messages: [SYSTEM, USER('a'), ASSISTANT('b'), USER('c')], sent: SENT },
  { name: 'ends_with_a_tool_result', decidedBy: 'trim', messages: [SYSTEM, USER('a'), { role: 'assistant', content: '', toolCalls: [CALL] }, { role: 'tool', toolCallId: 'call_1', content: 'x' }], sent: SENT },
  { name: 'no_send_time', decidedBy: 'trim', messages: [SYSTEM, USER('a'), ASSISTANT('b')], sent: undefined },
  { name: 'a_zero_send_time', decidedBy: 'trim', messages: [SYSTEM, USER('a'), ASSISTANT('b')], sent: 0 },
  { name: 'a_negative_send_time', decidedBy: 'trim', messages: [SYSTEM, USER('a'), ASSISTANT('b')], sent: -5 },
  { name: 'a_numeric_string_send_time', decidedBy: 'trim', messages: [SYSTEM, USER('a'), ASSISTANT('b')], sent: '1600000000000' },
  { name: 'an_unreadable_send_time', decidedBy: 'trim', messages: [SYSTEM, USER('a'), ASSISTANT('b')], sent: 'soon' },
  { name: 'no_user_conversation', decidedBy: 'next', messages: [SYSTEM, ASSISTANT('b')], sent: SENT },
  { name: 'an_agent_owned_session', decidedBy: 'next', messages: [SYSTEM, USER('a'), ASSISTANT('b')], sent: SENT, overrides: { owner: 'agent' } },
  { name: 'a_closed_session', decidedBy: 'next', messages: [SYSTEM, USER('a'), ASSISTANT('b')], sent: SENT, overrides: { closed: true } },
  { name: 'an_unregistered_provider', decidedBy: 'next', messages: [SYSTEM, USER('a'), ASSISTANT('b')], sent: SENT, overrides: { provider: 'nobody' } },
];

const provider = { name: 'anthropic', async send() { return { usage: {} }; } };
const cases = [];
let n = 0;
await _withRegisteredProviderForTestAsync('anthropic', provider, async () => {
  for (const spec of CASES) {
    n += 1;
    const id = `last-sent-${n}`;
    const session = {
      id,
      provider: 'anthropic',
      model: 'claude-test',
      effort: 'high',
      status: 'idle',
      promptCacheKey: `cache-${id}`,
      tools: TOOLS.map((tool) => ({ ...tool })),
      messages: structuredClone(spec.messages),
      ...(spec.sent === undefined ? {} : { lastProviderSendAt: spec.sent }),
      ...(spec.overrides ?? {}),
    };
    setLiveSession(session);
    loadSession(id);
    const got = lastSentMainRequest(id);
    cases.push({
      name: spec.name,
      decidedBy: spec.decidedBy,
      messages: spec.messages,
      sendTime: spec.sent === undefined ? null : spec.sent,
      overrides: spec.overrides ?? null,
      answer: got
        ? {
            messages: got.messages.map((m) => ({ role: m.role, content: m.content, source: m.meta?.source ?? null })),
            sentAt: got.sentAt,
            model: got.model,
            tools: got.tools.map((t) => t.name),
          }
        : null,
    });
  }
});
writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, { set: 'last-sent', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
