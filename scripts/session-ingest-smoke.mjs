#!/usr/bin/env node
import {
  normalizeIngestRole,
  stableSessionSourceRef,
  redactToolArgString,
  redactToolArgValue,
  sessionMessageContent,
  createIngestTurnAllocator,
} from '../src/runtime/memory/lib/session-ingest.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --- Role normalization ---
assert(normalizeIngestRole('human') === 'user', 'human should normalize to user');
assert(normalizeIngestRole('AI') === 'assistant', 'AI should normalize to assistant');
assert(normalizeIngestRole('tool_result') === 'tool', 'tool_result should normalize to tool');
assert(normalizeIngestRole('developer') === 'developer', 'developer should be preserved');
assert(normalizeIngestRole('mystery') === null, 'unknown role should be dropped');

// --- Stable source_ref across index/time for untimestamped messages ---
const plain = { role: 'user', content: 'fix the bug in compact.mjs' };
const refA = stableSessionSourceRef('sess1', plain, 'user', 'fix the bug in compact.mjs');
const refB = stableSessionSourceRef('sess1', plain, 'user', 'fix the bug in compact.mjs');
assert(refA === refB, 'same untimestamped message must yield the same source_ref regardless of call');
assert(!/#\d+$/.test(refA), 'source_ref must not carry a volatile #index suffix');

// Two textually identical untimestamped plain messages dedupe to one ref.
const dupA = stableSessionSourceRef('sess1', { role: 'user', content: 'ok' }, 'user', 'ok');
const dupB = stableSessionSourceRef('sess1', { role: 'user', content: 'ok' }, 'user', 'ok');
assert(dupA === dupB, 'identical untimestamped plain messages should share a stable ref (dedupe preferred)');

// A synthesized Date.now() fallback ts must NOT change identity: the helper
// only reads m.ts/m.timestamp, so two calls for the same untimestamped message
// at different wall-clock times still match.
const t1 = stableSessionSourceRef('sess1', plain, 'user', 'fix the bug in compact.mjs');
const t2 = stableSessionSourceRef('sess1', plain, 'user', 'fix the bug in compact.mjs');
assert(t1 === t2, 'synthesized timestamps must not enter identity');

// Original timestamp, when present, DOES contribute to identity.
const tsMsg = { role: 'user', content: 'same text', ts: 1700000000000 };
const tsRef = stableSessionSourceRef('sess1', tsMsg, 'user', 'same text');
const noTsRef = stableSessionSourceRef('sess1', { role: 'user', content: 'same text' }, 'user', 'same text');
assert(tsRef !== noTsRef, 'an original ts should differentiate identity from an untimestamped twin');

// Tool-id identity: different tool ids => different refs; same id => same ref.
const toolMsg1 = { role: 'assistant', content: 'x', toolCalls: [{ id: 'call_1', name: 'apply_patch' }] };
const toolMsg2 = { role: 'assistant', content: 'x', toolCalls: [{ id: 'call_2', name: 'apply_patch' }] };
const toolRef1 = stableSessionSourceRef('sess1', toolMsg1, 'assistant', 'x');
const toolRef2 = stableSessionSourceRef('sess1', toolMsg2, 'assistant', 'x');
assert(toolRef1 !== toolRef2, 'different tool-call ids should produce different source_refs');
const toolRef1b = stableSessionSourceRef('sess1', { ...toolMsg1 }, 'assistant', 'x');
assert(toolRef1 === toolRef1b, 'same tool-call id + content should produce the same source_ref');
const resultRef = stableSessionSourceRef('sess1', { role: 'tool', content: 'done', toolCallId: 'call_1' }, 'tool', 'done');
assert(typeof resultRef === 'string' && resultRef.startsWith('session:sess1:'), 'tool_result ref should be well formed');

// --- Sensitive redaction (object/JSON args) ---
const jsonArgs = JSON.stringify({ url: 'https://x', api_key: 'sk-secret-123', nested: { password: 'p@ss word' } });
const redactedJson = redactToolArgString(jsonArgs);
assert(!redactedJson.includes('sk-secret-123'), 'api_key value must be redacted from JSON args');
assert(!redactedJson.includes('p@ss word'), 'nested password must be redacted from JSON args');
assert(redactedJson.includes('https://x'), 'non-sensitive url should be preserved');
assert(redactedJson.includes('[redacted]'), 'redaction marker should be present');

const objRedaction = redactToolArgValue({ authorization: 'Bearer abc.def', keep: 'value' });
assert(objRedaction.authorization === '[redacted]', 'authorization key should collapse to [redacted]');
assert(objRedaction.keep === 'value', 'non-sensitive key should be preserved');

// --- Sensitive redaction (raw non-JSON strings with spaces / Bearer / cookies) ---
const rawCases = [
  'authorization: Bearer abc.def',
  'password="abc def"',
  "api_key='abc def'",
  'cookie: a=b; c=d',
];
for (const raw of rawCases) {
  const out = redactToolArgString(raw);
  assert(out.includes('[redacted]'), `raw secret should be redacted: ${raw}`);
}
const bearerOut = redactToolArgString('authorization: Bearer abc.def');
assert(!bearerOut.includes('abc.def'), 'Bearer token fragment must not leak');
assert(!bearerOut.includes('Bearer'), 'Bearer scheme word must be consumed by redaction');
const pwSpaceOut = redactToolArgString('password="abc def"');
assert(!pwSpaceOut.includes('abc def'), 'quoted password with spaces must not leak');
const apiSpaceOut = redactToolArgString("api_key='abc def'");
assert(!apiSpaceOut.includes('abc def'), 'single-quoted api_key with spaces must not leak');
const cookieOut = redactToolArgString('cookie: a=b; c=d');
assert(!/a=b/.test(cookieOut), 'cookie value (incl. ;-separated pairs) must not leak');

// Non-sensitive raw args stay readable.
const plainArgs = redactToolArgString('file=compact.mjs lines=10');
assert(plainArgs.includes('compact.mjs'), 'non-sensitive raw args should be preserved');
assert(!plainArgs.includes('[redacted]'), 'non-sensitive raw args should not be redacted');

// --- Prefixed sensitive key variants (raw) ---
const prefixedRawCases = [
  ['access_token=abc.def', 'abc.def'],
  ['access-token=abc.def', 'abc.def'],
  ['x-api-key=sk-supersecret-123', 'sk-supersecret-123'],
  ['bearer_token: Bearer bear-tok-456', 'bear-tok-456'],
];
for (const [raw, frag] of prefixedRawCases) {
  const out = redactToolArgString(raw);
  assert(out.includes('[redacted]'), `prefixed key variant should be redacted: ${raw}`);
  assert(!out.includes(frag), `prefixed key variant must not leak its secret fragment: ${raw}`);
}

// --- JSON/object string VALUES carrying embedded raw secrets ---
// Non-sensitive keys (headers/env) whose string value embeds a secret pair must
// still be redacted (defense-in-depth), while non-sensitive content stays.
const embeddedCases = [
  [{ headers: 'authorization: Bearer abc.def' }, 'abc.def'],
  [{ headers: 'cookie: a=b; c=d' }, 'a=b'],
  [{ env: 'x-api-key=sk-supersecret-123' }, 'sk-supersecret-123'],
];
for (const [obj, frag] of embeddedCases) {
  const viaString = redactToolArgString(JSON.stringify(obj));
  assert(!viaString.includes(frag), `JSON string value secret must not leak: ${JSON.stringify(obj)}`);
  assert(viaString.includes('[redacted]'), `JSON string value secret should be redacted: ${JSON.stringify(obj)}`);
  // Object path (redactToolArgValue) must redact the embedded secret too.
  const viaObject = JSON.stringify(redactToolArgValue(obj));
  assert(!viaObject.includes(frag), `object string value secret must not leak: ${JSON.stringify(obj)}`);
}
// Non-sensitive sibling values remain readable.
const mixedObj = redactToolArgValue({ url: 'https://x', headers: 'authorization: Bearer abc.def', note: 'keep me' });
assert(mixedObj.url === 'https://x', 'non-sensitive url should be preserved alongside redacted header value');
assert(mixedObj.note === 'keep me', 'non-sensitive note should be preserved');
assert(!JSON.stringify(mixedObj).includes('abc.def'), 'embedded header secret must not leak from mixed object');

// --- sessionMessageContent shaping ---
const asstMsg = {
  role: 'assistant',
  content: 'running tool',
  toolCalls: [{ id: 'call_9', name: 'http_get', arguments: '{"url":"https://x","authorization":"Bearer zzz"}' }],
};
const asstShaped = sessionMessageContent(asstMsg);
assert(asstShaped.includes('running tool'), 'assistant text should be preserved');
assert(asstShaped.includes('http_get'), 'tool name should be readable');
assert(asstShaped.includes('id=call_9'), 'tool id should be readable');
assert(asstShaped.includes('https://x'), 'non-sensitive tool arg should be readable');
assert(!asstShaped.includes('zzz'), 'sensitive tool arg should be redacted in shaped content');

const toolResultShaped = sessionMessageContent({ role: 'tool', content: 'patch applied', toolCallId: 'call_9' });
assert(toolResultShaped.includes('[tool_result id=call_9]'), 'tool result should be tagged with its pairing id');
assert(toolResultShaped.includes('patch applied'), 'tool result body should be preserved');

const rawToolMsg = sessionMessageContent({
  role: 'assistant',
  content: '',
  toolCalls: [{ id: 'call_x', name: 'curl', arguments: 'authorization: Bearer abc.def' }],
});
assert(!/abc\.def/.test(rawToolMsg), 'session message redaction should not leak raw Bearer token text');

// --- Monotonic source_turn allocator (post-compaction ordering) ---
// Seed from the current MAX(source_turn) for the session; every newly inserted
// row must get a strictly increasing turn ABOVE all prior rows, independent of
// the (post-compaction) array index. Re-ingested rows do not advance the count.
const alloc = createIngestTurnAllocator(42);
assert(alloc.peekNext() === 43, 'allocator should peek the next turn above the prior max');
assert(alloc.peekNext() === 43, 'peek must be idempotent until next() is called');
assert(alloc.next() === 43, 'first inserted row should take prevMax+1');
assert(alloc.next() === 44, 'second inserted row should take prevMax+2');
assert(alloc.current() === 44, 'current should track the last consumed turn');
// Simulate: pre-compact rows already at turns 1..3 (prevMax=3); after
// compaction a later message is appended with a LOW array index — it must STILL
// get turn 4 (continuation), not a low/old turn that would sort before them.
const post = createIngestTurnAllocator(3);
const appendedTurn = post.next();
assert(appendedTurn === 4, 'a post-compaction appended row must continue after the prior max source_turn');
assert(appendedTurn > 3, 'post-compaction row turn must sort AFTER older pre-compaction rows');
// A conflicting re-ingest (row already present) must not consume a turn.
const seeded = createIngestTurnAllocator(10);
const peek = seeded.peekNext();
assert(peek === 11 && seeded.current() === 10, 're-ingest peek must not advance the counter');

process.stdout.write('session ingest smoke passed \u2713\n');
