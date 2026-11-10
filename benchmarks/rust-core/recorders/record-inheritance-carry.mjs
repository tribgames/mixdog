#!/usr/bin/env node
// What `inheritFrom` does with an existing heir (session-runtime/lifecycle/inheritance.mjs, `createInheritance`):
// the checks in Node's order and their texts, what travels (the source's non-system messages, whatever their ids),
// what the compactor is asked (the source's whole transcript - system blocks first - on the heir's budget, a
// summarizing pass on a copy whose threshold is the floor) and the measured sentence of a refusal. Each case is the
// real `inheritFrom` over scripted sessions; `fit` and `plan` are Node's own `inheritanceFit` /
// `inheritanceCompactionPlan` of the heir for the conversation it would carry and for the compacted one.
// The `conversation` cases are the two reads that decide a workspace move: `hasUserConversationMessage` of the
// committed messages (`refreshSessionWorkspaceContext`) and the intent view (`worktree-intents.mjs`: committed or live).
//
//   node benchmarks/rust-core/recorders/record-inheritance-carry.mjs --tree <tree>
//
// Output: native/core/fixtures/inheritance-carry/golden.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const tree = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'inheritance-carry-'));
// Every user directory the product reads is a fresh temp directory before any Mixdog module loads.
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  mkdirSync(join(sandbox, key));
  process.env[key] = join(sandbox, key);
}
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MIXDOG_AGENT_COMPACT_') || name.startsWith('MIXDOG_TOKEN_CALIBRATION_')) delete process.env[name];
}
const finalDir = join(FIXTURES_ROOT, 'inheritance-carry');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-inheritance-carry.mjs';
const at = (path) => importFrom(tree, path);
const { createInheritance } = await at('src/session-runtime/lifecycle/inheritance.mjs');
const { inheritanceFit, inheritanceCompactionPlan, inheritableMessages } = await at('src/session-runtime/inheritance-fit.mjs');
const { hasUserConversationMessage } = await at('src/runtime/agent/orchestrator/session/manager/prompt-utils.mjs');
const { sessionHasConversationMessages } = await at('src/runtime/agent/orchestrator/runtime-core/session-text.mjs');

const text = (n, word) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const user = (content, id) => ({ role: 'user', content, ...(id ? { meta: { transcript: { messageId: id } } } : {}) });
const assistant = (content, id) => ({ role: 'assistant', content, ...(id ? { meta: { transcript: { messageId: id } } } : {}) });
const SYSTEM = [
  { role: 'system', content: 'You are the source session. Rules of the source.' },
  { role: 'system', content: '# Core\n\nsource core context', cacheTier: 'tier3' },
  { role: 'system', content: '# Environment\n\nsource environment facts', cacheTier: 'env' },
];
const slim = (message) => ({ role: message.role, content: message.content, ...(message.cacheTier ? { cacheTier: message.cacheTier } : {}) });
const route = (window) => ({
  contextWindow: window,
  rawContextWindow: window,
  effectiveContextWindowPercent: 100,
  autoCompactTokenLimit: null,
  compactBoundaryTokens: window,
});

const source = (extra = {}) => ({
  id: 'sess_source',
  provider: 'custom-harness',
  model: 'harness-model',
  title: 'Source title',
  ...route(200_000),
  compaction: { auto: true },
  tools: [],
  messages: [...SYSTEM, user('hello', 'm1'), assistant('hi', 'm2'), user('one more', 'm3'), assistant('done', 'm4')],
  ...extra,
});
const heir = (extra = {}) => ({
  id: 'sess_heir',
  provider: 'custom-harness',
  model: 'harness-model',
  title: '',
  ...route(200_000),
  compaction: { auto: true },
  tools: [],
  messages: [{ role: 'system', content: 'Rules of the heir.' }],
  liveTurnMessages: [],
  ...extra,
});

const BIG = [user(text(900, 'u'), 'b1'), assistant(text(900, 'a'), 'b2'), user(text(900, 'v'), 'b3'), assistant(text(900, 'b'), 'b4')];
const SUMMARY = [{ role: 'system', content: 'rules' }, user('Summary of the conversation so far.', 's1')];
const STILL_BIG = BIG.slice(0, 3);

/** [name, sources, heir, options, what the compactor answers (an array, 'throws' or null for "never asked")] */
const scenarios = [
  ['the source is the heir', () => source({ id: 'sess_heir' }), () => heir(), {}, null],
  ['the heir holds a conversation', () => source(), () => heir({ messages: [{ role: 'system', content: 'r' }, user('already here'), assistant('yes')] }), {}, null],
  ['the heir has a turn in flight', () => source(), () => heir({ liveTurnMessages: [user('typing')] }), {}, null],
  ['the source is missing', () => null, () => heir(), {}, null],
  ['the source has no conversation', () => source({ messages: [...SYSTEM, assistant('only me')] }), () => heir(), {}, null],
  [
    'every message travels, whatever its id',
    () => source({ messages: [...SYSTEM, user('one'), assistant('two'), user('three', 'same'), assistant('four', 'same')] }),
    () => heir(),
    {},
    null,
  ],
  ['the heir keeps its own title', () => source(), () => heir({ title: 'Heir title' }), {}, null],
  ['an explicit compact summarizes', () => source(), () => heir(), { compact: true }, SUMMARY],
  ['an explicit compact that compacts nothing', () => source(), () => heir(), { compact: true }, []],
  ['an explicit compact whose compaction throws', () => source(), () => heir(), { compact: true }, 'throws'],
  ['too large, compacted to fit', () => source({ messages: [...SYSTEM, ...BIG] }), () => heir({ ...route(3_000) }), {}, SUMMARY],
  ['too large, still too large compacted', () => source({ messages: [...SYSTEM, ...BIG] }), () => heir({ ...route(3_000) }), {}, STILL_BIG],
  ['too large, the compaction throws', () => source({ messages: [...SYSTEM, ...BIG] }), () => heir({ ...route(3_000) }), {}, 'throws'],
];

async function run([name, makeSource, makeHeir, options, compacted]) {
  const src = makeSource();
  const target = makeHeir();
  const before = target.messages.length;
  const setup = {
    source: src && { id: src.id, title: src.title, messages: structuredClone(src.messages) },
    heir: { id: target.id, title: target.title, messages: structuredClone(target.messages), liveTurnMessages: structuredClone(target.liveTurnMessages) },
  };
  const calls = [];
  const asked = src ? inheritableMessages(src.messages) : [];
  const fitOf = (messages) => {
    const fit = inheritanceFit(messages, target);
    return { messages: fit.messages, known: fit.known, fits: fit.fits, used: fit.used, limit: fit.limit };
  };
  const plan = inheritanceCompactionPlan(target);
  const inheritance = createInheritance(
    {
      getSession: () => target,
      getRoute: () => ({ provider: target.provider, model: target.model }),
      mgr: { getSession: (id) => (src && id === src.id ? src : null) },
      createCurrentSession: async () => {},
      invalidateContextStatusCache: () => {},
      getReservedSessionId: () => '',
    },
    {
      compactConversation: async (input) => {
        calls.push({
          messages: input.messages.map(slim),
          budgetTokens: input.budgetTokens,
          boundaryTokens: input.boundaryTokens,
          reserveTokens: input.reserveTokens,
          contextWindow: input.contextWindow,
          sessionId: input.sessionId,
          conversationThresholdTokens: input.session?.compaction?.conversationThresholdTokens ?? null,
          sourceItself: input.session === src,
        });
        if (compacted === 'throws') throw new Error('the compactor failed');
        return { messages: compacted };
      },
      saveSession: () => {},
    }
  );
  const sourceId = name === 'the source is missing' ? 'sess_gone' : src.id;
  let outcome;
  try {
    outcome = { ok: await inheritance.inheritFrom(sourceId, options) };
  } catch (error) {
    outcome = { error: error.message };
  }
  const afterCompact = Array.isArray(compacted) ? inheritableMessages(compacted) : null;
  return {
    name,
    setup,
    options,
    sourceId,
    fit: src ? fitOf(asked) : null,
    fitCompacted: afterCompact && afterCompact.length ? fitOf(afterCompact) : null,
    budgetTokens: plan?.budgetTokens ?? null,
    compactorAnswer: compacted === 'throws' ? 'throws' : compacted === null ? null : compacted.map(slim),
    compactorCalls: calls,
    outcome,
    carried: target.messages.slice(before).map(slim),
    title: target.title,
    inheritedFromSessionId: target.inheritedFromSessionId ?? null,
  };
}

const cases = [];
for (const scenario of scenarios) cases.push(JSON.parse(JSON.stringify(await run(scenario))));

// The reads that decide a workspace move, over committed messages and the running turn's.
const rowsets = [
  ['a committed user message and its reply', [user('hello'), assistant('hi')], []],
  ['no committed rows, a user message in the turn', [], [user('typing')]],
  ['no rows anywhere', [], []],
  ['a committed reply only', [assistant('hi')], []],
  ['a committed reply, a user message in the turn', [assistant('hi')], [user('typing')]],
  ['a committed user message, an empty turn', [user('hello')], []],
];
const conversation = rowsets.map(([name, messages, live]) => ({
  name,
  messages,
  liveTurnMessages: live,
  hasUserConversationMessage: hasUserConversationMessage(messages),
  intentView: sessionHasConversationMessages({ messages }) || sessionHasConversationMessages({ messages: live }),
}));

rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
writeJson(join(stage, 'golden.json'), { cases, conversation });
writeSetManifest(stage, { set: 'inheritance-carry', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree, identityRef: NODE_COMMIT });
commitStage(stage, finalDir);
console.log(`recorded ${cases.length} carries and ${conversation.length} conversation reads`);
process.exit(0);
