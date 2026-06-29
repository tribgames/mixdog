#!/usr/bin/env node
import { semanticCompactMessages, recallFastTrackCompactMessages, SUMMARY_PREFIX, COMPACT_TYPE_SEMANTIC, COMPACT_TYPE_RECALL_FASTTRACK, normalizeCompactType } from '../src/runtime/agent/orchestrator/session/compact.mjs';
import { agentLoop } from '../src/runtime/agent/orchestrator/session/loop.mjs';
import { estimateMessagesTokens } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import { autoCompactWindowForRoute, summarizeGatewayUsage } from '../src/vendor/statusline/src/gateway/route-meta.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findSummary(messages) {
  return messages.find((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX));
}

const bootstrapContextMessages = [
  { role: 'system', content: 'base rules stay exact' },
  { role: 'system', content: 'role/system rules stay exact' },
  { role: 'system', content: 'project/session memory/meta stay exact', cacheTier: 'tier3' },
  { role: 'user', content: '<system-reminder>\nvolatile cwd C:\\Project\\mixdog stays exact\n</system-reminder>' },
  { role: 'assistant', content: '.' },
  { role: 'user', content: 'fresh real task has no prior compactable history' },
];
let bootstrapSemanticCalls = 0;
try {
  await semanticCompactMessages({ name: 'bootstrap-smoke', async send() { bootstrapSemanticCalls += 1; return { content: 'bad' }; } }, bootstrapContextMessages, 'fake-model', 1_000, { force: true });
} catch (err) {
  assert(/no compactable prior history/.test(String(err?.message || err)), 'semantic compact should reject fresh bootstrap-only history before provider call');
}
assert(bootstrapSemanticCalls === 0, 'semantic compact must not spend a provider call compacting bootstrap reminders');

const statusRoute = {
  provider: 'openai',
  model: 'gpt-5.5',
  contextWindow: 950_000,
  rawContextWindow: 1_000_000,
  autoCompactTokenLimit: 950_000,
};
assert(autoCompactWindowForRoute(statusRoute) === 950_000, 'auto compact window should match the effective compact capacity');
const usageSummary = summarizeGatewayUsage(statusRoute, { usage: { inputTokens: 900_000, outputTokens: 1 } });
assert(usageSummary.contextUsedPct === 94.74, `statusline usage should use effective compact capacity: ${usageSummary.contextUsedPct}`);

let semanticCalls = 0;
const semanticProvider = {
  name: 'semantic-smoke',
  async send(_messages, _model, _tools, opts) {
    semanticCalls += 1;
    assert(opts?.maxOutputTokens === 4_096, 'semantic compact should request the summary output cap');
    return { content: '## Goal\n- continue compact smoke\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- older turn summarized\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- continue\n\n## Critical Context\n- src/runtime/agent/orchestrator/session/compact.mjs\n\n## Relevant Files\n- src/runtime/agent/orchestrator/session/compact.mjs: compact logic' };
  },
};
const semanticMessages = [
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'older request about src/runtime/agent/orchestrator/session/compact.mjs' },
  { role: 'assistant', content: 'older answer with useful details' },
  { role: 'user', content: 'current request should remain verbatim' },
];
const semanticNoop = await semanticCompactMessages(semanticProvider, semanticMessages, 'fake-model', 5_000, { tailTurns: 1 });
assert(semanticNoop.semantic === false && semanticCalls === 0, 'semantic compact should still no-op below budget unless forced');
const semanticForced = await semanticCompactMessages(semanticProvider, semanticMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
assert(semanticForced.semantic === true && semanticCalls === 1, 'forced semantic compact should run even when the local estimate fits');
assert(semanticForced.compactType === COMPACT_TYPE_SEMANTIC, 'semantic compact should report compact type 1');
assert(findSummary(semanticForced.messages), 'forced semantic compact should insert an anchored summary');

assert(normalizeCompactType('type1') === COMPACT_TYPE_SEMANTIC, 'type1 should resolve to semantic compact');
assert(normalizeCompactType('recall-fasttrack') === COMPACT_TYPE_RECALL_FASTTRACK, 'type2 should resolve to recall fast-track compact');
// Alias parity: snake_case + dash + no-dash spellings of fast-track must all
// resolve to the same recall-fasttrack type, and unknown values fall back.
for (const alias of ['fast-track', 'fast_track', 'fasttrack', 'recall_fasttrack', 'recall-fast-track', 'type-2', '2']) {
  assert(normalizeCompactType(alias) === COMPACT_TYPE_RECALL_FASTTRACK, `alias ${alias} should resolve to recall fast-track`);
}
for (const alias of ['1', 'type-1', 'semantic', 'summary', 'bench1']) {
  assert(normalizeCompactType(alias) === COMPACT_TYPE_SEMANTIC, `alias ${alias} should resolve to semantic`);
}
assert(normalizeCompactType('totally-unknown') === COMPACT_TYPE_SEMANTIC, 'unknown compact type should fall back to the default (semantic)');
assert(normalizeCompactType('totally-unknown', COMPACT_TYPE_RECALL_FASTTRACK) === COMPACT_TYPE_RECALL_FASTTRACK, 'unknown compact type should honor the caller-provided fallback');
const recallFastTrackForced = recallFastTrackCompactMessages(semanticMessages, 5_000, {
  tailTurns: 1,
  force: true,
  recallText: 'recall hit: src/runtime/agent/orchestrator/session/compact.mjs and next steps preserved',
  query: 'compact smoke recall fast-track',
  querySha: 'smoketest',
});
assert(recallFastTrackForced.recallFastTrack === true, 'recall fast-track compact should mark type2 result');
assert(recallFastTrackForced.compactType === COMPACT_TYPE_RECALL_FASTTRACK, 'recall fast-track compact should report compact type 2');
assert(findSummary(recallFastTrackForced.messages), 'recall fast-track compact should insert an anchored summary');

// Recall fast-track must preserve recent STRUCTURED state (assistant + tool +
// developer), not collapse the tail to user-only. The newest turn carries an
// assistant tool_call, its tool_result, and a developer note — all three must
// survive into the compacted tail (older turns are anchored by the recall text).
const structuredTailMessages = [
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'older request that should be summarized away' },
  { role: 'assistant', content: 'older answer' },
  { role: 'user', content: 'apply the edit to src/runtime/agent/orchestrator/session/compact.mjs' },
  { role: 'assistant', content: 'editing now', toolCalls: [{ id: 'call_edit_1', name: 'apply_patch', arguments: '{"file":"compact.mjs"}' }] },
  { role: 'tool', toolCallId: 'call_edit_1', content: 'patch applied: +5 -1' },
  { role: 'developer', content: 'developer steering note: keep tail structured' },
];
const structuredRecall = recallFastTrackCompactMessages(structuredTailMessages, 5_000, {
  tailTurns: 1,
  force: true,
  recallText: 'recall hit: older request summarized',
  query: 'structured tail recall',
  querySha: 'structuredtail',
});
assert(structuredRecall.recallFastTrack === true, 'structured recall fast-track should mark type2 result');
const structuredRoles = structuredRecall.messages.map((m) => m.role);
assert(structuredRoles.includes('assistant'), 'recall fast-track tail should preserve recent assistant turns');
assert(structuredRoles.includes('tool'), 'recall fast-track tail should preserve recent tool results');
assert(structuredRoles.includes('developer'), 'recall fast-track tail should preserve recent developer steering');
const structuredToolMsg = structuredRecall.messages.find((m) => m.role === 'tool');
assert(structuredToolMsg?.toolCallId === 'call_edit_1', 'preserved tool result should keep its tool_call pairing id');
const structuredAssistant = structuredRecall.messages.find((m) => m.role === 'assistant' && Array.isArray(m.toolCalls));
assert(structuredAssistant, 'preserved assistant turn should keep its tool_calls');

// Semantic malformed-summary repair: a non-empty but unstructured provider
// response must be deterministically repaired into the anchored template shape
// instead of being injected verbatim as the only summary.
let malformedCalls = 0;
const malformedProvider = {
  name: 'malformed-smoke',
  async send() {
    malformedCalls += 1;
    return { content: 'just a freeform blob with no template sections at all' };
  },
};
const malformedResult = await semanticCompactMessages(malformedProvider, semanticMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
assert(malformedCalls === 1, 'malformed semantic compact should still call the provider once');
assert(malformedResult.summaryRepaired === true, 'malformed semantic summary should be flagged repaired');
const malformedSummaryMsg = findSummary(malformedResult.messages);
assert(malformedSummaryMsg, 'repaired semantic compact should still insert an anchored summary');
for (const section of ['## Goal', '## Progress', '## Next Steps', '## Critical Context', '## Relevant Files']) {
  assert(malformedSummaryMsg.content.includes(section), `repaired summary should contain required section ${section}`);
}
assert(malformedSummaryMsg.content.includes('freeform blob'), 'repaired summary should retain the original provider content (routed into Critical Context)');
// A well-formed provider summary must NOT be flagged as repaired.
assert(semanticForced.summaryRepaired !== true, 'well-formed semantic summary should not be repaired');

const REQUIRED_SECTIONS = ['## Goal', '## Constraints', '## Progress', '## Key Decisions', '## Next Steps', '## Critical Context', '## Relevant Files'];

// Partial malformed summary: present some sections but omit Critical Context /
// Relevant Files. Schema enforcement must now require ALL sections, so a
// partial summary is repaired (not passed through) and every anchor is present.
let partialCalls = 0;
const partialProvider = {
  name: 'partial-smoke',
  async send() {
    partialCalls += 1;
    return { content: '## Goal\n- partial goal\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- did a thing\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- finish' };
  },
};
const partialResult = await semanticCompactMessages(partialProvider, semanticMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
assert(partialCalls === 1, 'partial semantic compact should still call the provider once');
assert(partialResult.summaryRepaired === true, 'partial semantic summary (missing sections) should be flagged repaired');
const partialSummaryMsg = findSummary(partialResult.messages);
assert(partialSummaryMsg, 'repaired partial semantic compact should still insert an anchored summary');
for (const section of REQUIRED_SECTIONS) {
  assert(partialSummaryMsg.content.includes(section), `repaired partial summary must contain required section ${section}`);
}
assert(partialSummaryMsg.content.includes('partial goal'), 'repaired partial summary should preserve the provider-supplied Goal body');
assert(partialSummaryMsg.content.includes('did a thing'), 'repaired partial summary should preserve the provider-supplied Progress body');

// Low-budget post-fit schema preservation: even when token pressure forces the
// fitter to shrink section bodies, the final injected SUMMARY_PREFIX message
// must still carry EVERY required section anchor (no trailing section dropped).
let lowBudgetCalls = 0;
const lowBudgetProvider = {
  name: 'low-budget-smoke',
  async send() {
    lowBudgetCalls += 1;
    const longBody = 'detail '.repeat(400);
    return { content: `## Goal\n- ${longBody}\n\n## Constraints & Preferences\n- ${longBody}\n\n## Progress\n### Done\n- ${longBody}\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- ${longBody}\n\n## Next Steps\n- ${longBody}\n\n## Critical Context\n- ${longBody}\n\n## Relevant Files\n- src/runtime/agent/orchestrator/session/compact.mjs: ${longBody}` };
  },
};
const lowBudgetResult = await semanticCompactMessages(lowBudgetProvider, semanticMessages, 'fake-model', 4_500, { tailTurns: 1, force: true });
assert(lowBudgetCalls === 1, 'low-budget semantic compact should call the provider once');
const lowBudgetSummaryMsg = findSummary(lowBudgetResult.messages);
assert(lowBudgetSummaryMsg, 'low-budget semantic compact should still insert an anchored summary');
for (const section of REQUIRED_SECTIONS) {
  assert(lowBudgetSummaryMsg.content.includes(section), `all required summary anchors should survive low-budget fitting: missing ${section}`);
}

// Heading-anchor validation: a summary where a required anchor (## Relevant
// Files) appears only as inline prose inside a body — never as a real heading —
// must be treated as malformed and repaired, not passed through. Also confirm
// `## Constraints & Preferences` satisfies the `## Constraints` anchor (no
// false repair) when every other heading is a real heading.
let proseAnchorCalls = 0;
const proseAnchorProvider = {
  name: 'prose-anchor-smoke',
  async send() {
    proseAnchorCalls += 1;
    // All 7 real headings present, including `## Constraints & Preferences`.
    // A bullet mentions `## Relevant Files` as prose — substring matching would
    // wrongly double-count, but heading-based validation still sees the real
    // heading, so this is well-formed and must NOT be repaired.
    return { content: '## Goal\n- ship it\n\n## Constraints & Preferences\n- mention of ## Relevant Files in prose\n\n## Progress\n### Done\n- x\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- go\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- compact.mjs' };
  },
};
const proseAnchorResult = await semanticCompactMessages(proseAnchorProvider, semanticMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
assert(proseAnchorCalls === 1, 'prose-anchor semantic compact should call the provider once');
assert(proseAnchorResult.summaryRepaired !== true, 'well-formed summary using "## Constraints & Preferences" heading should NOT be repaired');

// Now drop the real `## Relevant Files` heading but keep an inline prose
// mention of it; substring validation would pass, heading validation repairs.
let missingHeadingCalls = 0;
const missingHeadingProvider = {
  name: 'missing-heading-smoke',
  async send() {
    missingHeadingCalls += 1;
    return { content: '## Goal\n- ship it\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- x\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- see ## Relevant Files below\n\n## Critical Context\n- (none)' };
  },
};
const missingHeadingResult = await semanticCompactMessages(missingHeadingProvider, semanticMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
assert(missingHeadingCalls === 1, 'missing-heading semantic compact should call the provider once');
assert(missingHeadingResult.summaryRepaired === true, 'a summary missing the real ## Relevant Files heading (only inline prose) must be repaired');

// Semantic compaction must redact RAW (non-JSON) tool-call argument strings so
// secrets never reach preserved facts or the compaction prompt transcript
// metadata. The compaction provider here echoes the prompt it receives, so any
// leaked secret fragment would surface in the prompt and the output.
const SECRET_FRAGMENTS = ['abc.def', 'abc def', 'sk-supersecret-123', 's3cr3tcookie', 'xtok-prefixed-789', 'bear-tok-456'];
let secretSeenPrompt = '';
const secretProvider = {
  name: 'secret-redaction-smoke',
  async send(sentMessages) {
    // Capture the exact user prompt the compaction call receives so the test
    // can assert no raw secret fragment reached the transcript metadata.
    secretSeenPrompt = sentMessages.map((mm) => (typeof mm?.content === 'string' ? mm.content : JSON.stringify(mm?.content ?? ''))).join('\n');
    return { content: '## Goal\n- redact secrets\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- (none)\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)' };
  },
};
const secretMessages = [
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'older request that calls a tool with secret args' },
  { role: 'assistant', content: 'calling curl', toolCalls: [
    { id: 'call_secret_1', name: 'curl', arguments: 'authorization: Bearer abc.def' },
    { id: 'call_secret_2', name: 'login', arguments: 'password="abc def"' },
    { id: 'call_secret_3', name: 'http', arguments: '{"url":"https://x","api_key":"sk-supersecret-123"}' },
    { id: 'call_secret_4', name: 'fetch', arguments: 'cookie: session=s3cr3tcookie; path=/' },
    // Prefixed sensitive key variants must be caught by the raw redactor too.
    { id: 'call_secret_5', name: 'a', arguments: 'access_token=abc.def' },
    { id: 'call_secret_6', name: 'b', arguments: 'access-token=abc.def' },
    { id: 'call_secret_7', name: 'c', arguments: 'x-api-key=xtok-prefixed-789' },
    { id: 'call_secret_8', name: 'd', arguments: 'bearer_token: Bearer bear-tok-456' },
  ] },
  { role: 'tool', toolCallId: 'call_secret_1', content: 'ok' },
  { role: 'tool', toolCallId: 'call_secret_2', content: 'ok' },
  { role: 'tool', toolCallId: 'call_secret_3', content: 'ok' },
  { role: 'tool', toolCallId: 'call_secret_4', content: 'ok' },
  { role: 'tool', toolCallId: 'call_secret_5', content: 'ok' },
  { role: 'tool', toolCallId: 'call_secret_6', content: 'ok' },
  { role: 'tool', toolCallId: 'call_secret_7', content: 'ok' },
  { role: 'tool', toolCallId: 'call_secret_8', content: 'ok' },
  { role: 'user', content: 'current request stays verbatim' },
];
const secretResult = await semanticCompactMessages(secretProvider, secretMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
// 1) No secret fragment may appear in the compaction prompt (preserved facts +
//    conversation-history tool_calls metadata are both built from the head).
for (const frag of SECRET_FRAGMENTS) {
  assert(!secretSeenPrompt.includes(frag), `compaction prompt must not leak secret fragment: ${frag}`);
}
// Tool names must still be readable in the prompt (redaction is value-only).
assert(/curl|login|http|fetch/.test(secretSeenPrompt), 'tool names should remain readable in the compaction prompt');
// 2) No secret fragment may appear anywhere in the compacted output messages.
const secretSerialized = JSON.stringify(secretResult.messages);
for (const frag of SECRET_FRAGMENTS) {
  assert(!secretSerialized.includes(frag), `compacted output must not leak secret fragment: ${frag}`);
}

// CRITICAL: a sensitive assistant tool call in the PRESERVED RECENT TAIL (not
// the compacted head) is appended verbatim — its toolCalls[].arguments must be
// scrubbed too, or a recent `authorization: Bearer ...` survives in the output.
// Build a transcript whose newest turn carries the secret tool call so it lands
// in the preserved tail; assert the returned messages JSON has no secret
// fragments while tool names/ids remain present.
const tailSecretFragments = ['tail.secret.abc', 'tail-cookie-xyz', 'sk-tail-987'];
const tailSecretMessages = [
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'older request to be summarized away' },
  { role: 'assistant', content: 'older answer' },
  { role: 'user', content: 'current request with a fresh tool call' },
  { role: 'assistant', content: 'invoking tools now', toolCalls: [
    { id: 'call_tail_1', name: 'curl', arguments: 'authorization: Bearer tail.secret.abc' },
    { id: 'call_tail_2', name: 'fetch', arguments: 'cookie: session=tail-cookie-xyz; path=/' },
    { id: 'call_tail_3', name: 'http', arguments: '{"url":"https://y","x-api-key":"sk-tail-987"}' },
  ] },
  { role: 'tool', toolCallId: 'call_tail_1', content: 'ok1' },
  { role: 'tool', toolCallId: 'call_tail_2', content: 'ok2' },
  { role: 'tool', toolCallId: 'call_tail_3', content: 'ok3' },
];
// Semantic: tailTurns 1 keeps the newest user turn (and the secret assistant
// turn that follows it) in the preserved tail, while the older turn stays in
// the compacted head.
const tailSemantic = await semanticCompactMessages(semanticProvider, tailSecretMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
const tailSemanticJson = JSON.stringify(tailSemantic.messages);
for (const frag of tailSecretFragments) {
  assert(!tailSemanticJson.includes(frag), `semantic preserved-tail must not leak secret fragment: ${frag}`);
}
// Tool names + ids must remain in the preserved-tail assistant message.
for (const token of ['curl', 'fetch', 'http', 'call_tail_1', 'call_tail_2', 'call_tail_3']) {
  assert(tailSemanticJson.includes(token), `semantic preserved tail should retain tool name/id: ${token}`);
}
// The preserved assistant turn must still carry its toolCalls structure.
const tailSemanticAsst = tailSemantic.messages.find((m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length === 3);
assert(tailSemanticAsst, 'semantic preserved tail should keep the assistant toolCalls structure intact');

// Recall fast-track: same transcript; the secret tool call lands in the
// structured preserved tail and must be scrubbed in the returned messages.
const tailRecall = recallFastTrackCompactMessages(tailSecretMessages, 5_000, {
  tailTurns: 1,
  force: true,
  recallText: 'recall hit: older request summarized',
  query: 'tail secret recall',
  querySha: 'tailsecret',
});
const tailRecallJson = JSON.stringify(tailRecall.messages);
for (const frag of tailSecretFragments) {
  assert(!tailRecallJson.includes(frag), `recall-fasttrack preserved-tail must not leak secret fragment: ${frag}`);
}
for (const token of ['curl', 'fetch', 'http', 'call_tail_1', 'call_tail_2', 'call_tail_3']) {
  assert(tailRecallJson.includes(token), `recall-fasttrack preserved tail should retain tool name/id: ${token}`);
}
const tailRecallAsst = tailRecall.messages.find((m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length === 3);
assert(tailRecallAsst, 'recall-fasttrack preserved tail should keep the assistant toolCalls structure intact');

// Preserved-tail redaction must be REDACTION-ONLY: non-sensitive args (incl. a
// long string and a deep, key-ordered object/array) must survive byte- and
// structure-identical (no truncation / summarization / key sorting / caps),
// the string-vs-object `arguments` shape must be preserved, and
// `toolCalls[].function.arguments` must be redacted in both paths.
const LONG_NON_SENSITIVE = `keep ${'x'.repeat(900)} end`; // > any TOOL_ARG cap
const fnSecretFragments = ['fn.secret.aaa', 'fn-cookie-bbb'];
const onlyTailMessages = [
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'older request to summarize away' },
  { role: 'assistant', content: 'older answer' },
  { role: 'user', content: 'current request with mixed tool calls' },
  { role: 'assistant', content: 'invoking', toolCalls: [
    // Non-sensitive long string arg — must be preserved EXACTLY.
    { id: 'call_keep_str', name: 'echo', arguments: LONG_NON_SENSITIVE },
    // Object-shape args: provider passes a real object. Non-sensitive nested
    // values + key order must survive; only the sensitive key is redacted.
    { id: 'call_keep_obj', name: 'cfg', arguments: { zeta: 1, alpha: 'aval', nested: { keepArr: [3, 2, 1], note: 'n' }, password: 'should-vanish-pw' } },
    // function.arguments (string JSON) carrying a sensitive key — must redact.
    { id: 'call_fn_1', name: 'h', function: { name: 'h', arguments: '{"url":"https://z","authorization":"Bearer fn.secret.aaa"}' } },
    // function.arguments (raw string) carrying a cookie secret — must redact.
    { id: 'call_fn_2', name: 'g', function: { name: 'g', arguments: 'cookie: sid=fn-cookie-bbb; path=/' } },
  ] },
  { role: 'tool', toolCallId: 'call_keep_str', content: 'o1' },
  { role: 'tool', toolCallId: 'call_keep_obj', content: 'o2' },
  { role: 'tool', toolCallId: 'call_fn_1', content: 'o3' },
  { role: 'tool', toolCallId: 'call_fn_2', content: 'o4' },
];

function checkRedactionOnly(messages, label) {
  const asst = messages.find((m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length === 4);
  assert(asst, `${label}: preserved tail should keep the 4-call assistant turn`);
  const byId = Object.fromEntries(asst.toolCalls.map((tc) => [tc.id, tc]));
  // 1) Non-sensitive long string arg unchanged (no truncation/middle-cut).
  const strCall = byId.call_keep_str;
  assert(typeof strCall.arguments === 'string', `${label}: string arg must stay a string`);
  assert(strCall.arguments === LONG_NON_SENSITIVE, `${label}: non-sensitive long string arg must be byte-identical (no truncation)`);
  // 2) Object arg keeps shape, insertion order, nested array order/values;
  //    only the sensitive key value is redacted.
  const objCall = byId.call_keep_obj;
  assert(objCall.arguments && typeof objCall.arguments === 'object' && !Array.isArray(objCall.arguments), `${label}: object arg must stay an object`);
  assert(Object.keys(objCall.arguments).join(',') === 'zeta,alpha,nested,password', `${label}: object key insertion order must be preserved (no sorting)`);
  assert(objCall.arguments.zeta === 1 && objCall.arguments.alpha === 'aval', `${label}: non-sensitive primitive/string values preserved`);
  assert(JSON.stringify(objCall.arguments.nested.keepArr) === '[3,2,1]', `${label}: nested array order/values preserved (no caps/sort)`);
  assert(objCall.arguments.nested.note === 'n', `${label}: deep non-sensitive value preserved`);
  assert(objCall.arguments.password === '[redacted]', `${label}: sensitive object key value must be redacted`);
  // 3) function.arguments redacted (string-vs-object shape preserved).
  const fn1 = byId.call_fn_1;
  assert(typeof fn1.function.arguments === 'string', `${label}: function.arguments (JSON string) shape preserved`);
  const fn2 = byId.call_fn_2;
  assert(typeof fn2.function.arguments === 'string', `${label}: function.arguments (raw string) shape preserved`);
  const json = JSON.stringify(messages);
  for (const frag of fnSecretFragments) {
    assert(!json.includes(frag), `${label}: function.arguments secret must not leak: ${frag}`);
  }
  assert(!json.includes('should-vanish-pw'), `${label}: object sensitive value must not leak`);
}

const onlyTailSemantic = await semanticCompactMessages(semanticProvider, onlyTailMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
checkRedactionOnly(onlyTailSemantic.messages, 'semantic');

const onlyTailRecall = recallFastTrackCompactMessages(onlyTailMessages, 5_000, {
  tailTurns: 1,
  force: true,
  recallText: 'recall hit: older request summarized',
  query: 'redaction-only recall',
  querySha: 'redactonly',
});
checkRedactionOnly(onlyTailRecall.messages, 'recall-fasttrack');

// A non-sensitive JSON-string `arguments` payload must be returned BYTE-EXACT
// (no parse/JSON.stringify reformatting) when the redaction-only walk changes
// nothing — whitespace/key-order/number formatting must survive untouched.
const UNTOUCHED_JSON_ARG = '{ "url":"https://keep",  "n": 1.50, "list":[3,2,1] }';
const jsonShapeMessages = [
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'older request to summarize away' },
  { role: 'assistant', content: 'older answer' },
  { role: 'user', content: 'current request with a non-sensitive json arg' },
  { role: 'assistant', content: 'invoking', toolCalls: [
    { id: 'call_json_keep', name: 'req', arguments: UNTOUCHED_JSON_ARG },
  ] },
  { role: 'tool', toolCallId: 'call_json_keep', content: 'ok' },
];
function checkJsonByteExact(messages, label) {
  const asst = messages.find((m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.id === 'call_json_keep'));
  assert(asst, `${label}: preserved tail should keep the json-arg assistant turn`);
  const tc = asst.toolCalls.find((c) => c.id === 'call_json_keep');
  assert(tc.arguments === UNTOUCHED_JSON_ARG, `${label}: non-sensitive JSON-string arg must be byte-exact (no reserialization)`);
}
const jsonSemantic = await semanticCompactMessages(semanticProvider, jsonShapeMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
checkJsonByteExact(jsonSemantic.messages, 'semantic');
const jsonRecall = recallFastTrackCompactMessages(jsonShapeMessages, 5_000, {
  tailTurns: 1, force: true, recallText: 'recall hit', query: 'json byte exact', querySha: 'jsonexact',
});
checkJsonByteExact(jsonRecall.messages, 'recall-fasttrack');

// No-op fast path: when the transcript already fits and force !== true, the
// returned messages must be the ORIGINAL sanitized transcript UNCHANGED — no
// preserved-tail redaction is applied (prior no-compaction semantics). Here the
// tool arg carries a secret but, because we are under budget and not forced,
// the secret is preserved verbatim (redaction only runs when compaction runs).
const noopMessages = [
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'tiny request' },
  { role: 'assistant', content: 'tiny', toolCalls: [
    { id: 'call_noop', name: 'curl', arguments: 'authorization: Bearer noop-secret-xyz' },
  ] },
  { role: 'tool', toolCallId: 'call_noop', content: 'ok' },
];
const noopSemantic = await semanticCompactMessages(semanticProvider, noopMessages, 'fake-model', 1_000_000);
assert(noopSemantic.semantic === false, 'under-budget unforced semantic compact should no-op');
assert(JSON.stringify(noopSemantic.messages).includes('noop-secret-xyz'), 'semantic no-op path must return the original transcript unchanged (no redaction applied)');
const noopRecall = recallFastTrackCompactMessages(noopMessages, 1_000_000, { recallText: 'unused' });
assert(noopRecall.recallFastTrack === false, 'under-budget unforced recall-fasttrack should no-op');
assert(JSON.stringify(noopRecall.messages).includes('noop-secret-xyz'), 'recall-fasttrack no-op path must return the original transcript unchanged (no redaction applied)');

// Context overflow on send triggers ONE reactive compact-retry: the loop
// marks the session over-threshold and re-enters the pre-send auto-compact
// path, which runs a single semantic compaction (one compact-provider send)
// and re-sends once. If the retry still overflows, the deterministic
// AGENT_CONTEXT_OVERFLOW error is surfaced (main send count 2, compact
// provider send count 1).
const overflowRetryMessages = [{ role: 'system', content: 'system rules stay mandatory' }];
let overflowIndex = 0;
while (estimateMessagesTokens(overflowRetryMessages) + 512 < 8_800) {
  overflowRetryMessages.push({ role: 'user', content: `older overflow request ${overflowIndex}: ${'important detail '.repeat(90)}` });
  overflowRetryMessages.push({ role: 'assistant', content: `older overflow answer ${overflowIndex}: ${'implementation note '.repeat(90)}` });
  overflowIndex += 1;
}
overflowRetryMessages.push({ role: 'user', content: 'current overflow task must stay verbatim' });
let overflowSendCount = 0;
let overflowCompactSendCount = 0;
const overflowProvider = {
  name: 'overflow-smoke',
  async send(_sentMessages, _model, _tools, opts = {}) {
    if (String(opts?.sessionId || '').endsWith(':compact')) {
      overflowCompactSendCount += 1;
      return { content: 'unexpected compact call' };
    }
    overflowSendCount += 1;
    throw new Error('input tokens exceeds the context window');
  },
};
const overflowSession = {
  id: 'compact-smoke-overflow',
  owner: 'agent',
  provider: 'overflow-smoke',
  model: 'fake-model',
  contextWindow: 12_000,
  rawContextWindow: 12_000,
  compactBoundaryTokens: 12_000,
  compaction: { auto: true, semantic: true },
};
let overflowError = null;
try {
  await agentLoop(overflowProvider, overflowRetryMessages, 'fake-model', [], null, process.cwd(), { session: overflowSession, sessionId: overflowSession.id });
} catch (err) {
  overflowError = err;
}
assert(overflowError, 'context overflow on send should surface an error, not be silently recovered');
assert(overflowError?.code === 'AGENT_CONTEXT_OVERFLOW', `overflow should surface AGENT_CONTEXT_OVERFLOW, got ${overflowError?.code || overflowError?.message}`);
assert(overflowSendCount === 2, `overflow should send twice (original + one reactive compact-retry), sent=${overflowSendCount}`);
assert(overflowCompactSendCount === 1, `reactive compact-retry should run exactly one in-loop semantic compaction, compactSends=${overflowCompactSendCount}`);

process.stdout.write('compact smoke passed ✓\n');
