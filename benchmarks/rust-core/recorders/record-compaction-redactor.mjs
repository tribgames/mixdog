#!/usr/bin/env node
// What Node stores of a session's messages once the session has sensitive values: the real
// `rememberSensitiveValues` marks the session from the recorded tool calls and the real
// `_messagesForDisk` (session/store/serialize.mjs) projects the rows, nothing masked. Rust
// `mixdog-core` `run_host::compaction_redactor::SensitiveRedactor` (compaction's redaction of the
// rows it writes) and the sensitive store every stored transcript goes through must equal it.
//
//   node benchmarks/rust-core/recorders/record-compaction-redactor.mjs [--tree <dir>]
//
// Output: native/core/fixtures/compaction-redactor/golden.json.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'compaction-redactor');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-compaction-redactor.mjs';
const at = (path) => importFrom(tree, path);
const { rememberSensitiveValues } = await at('src/runtime/agent/orchestrator/session/sensitive-values.mjs');
const { _messagesForDisk } = await at('src/runtime/agent/orchestrator/session/store/serialize.mjs');

// A reference is what `String(attachmentRef || '')` spells as 64 lowercase hex digits: a one-element
// array spells it, a two-element array, a number, an uppercase string or a falsy value do not.
const ref = (attachmentRef) => ({ role: 'user', content: [{ type: 'text', text: 'code 682419', attachmentRef }] });
const rows = [
  {"role":"user","content":"My code is 682419","ts":1,"meta":{"transcript":{"messageId":"m1"}}},
  {"role":"user","content":[{"type":"text","text":"hunter2 and hunter22"},{"type":"image","attachmentRef":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mimeType":"image/png"}]},
  {"role":"user","content":[{"type":"text","text":"[Pasted text #1: 682419]","attachmentRef":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]},
  {"role":"user","content":[{"type":"text","text":"[Image omitted from stored history: 682419]"}]},
  {"role":"user","content":[{"type":"file","attachmentRef":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mimeType":"application/pdf","filename":"682419.pdf"}]},
  {"role":"assistant","content":"plain reply","reasoning":"opaque"},
  {"role":"assistant","content":"code 682419","reasoning":"opaque","providerReplay":{"id":"r"},"toolCalls":[{"id":"c1","name":"x","arguments":{"a":682419},"thoughtSignature":"sig"}]},
  {"role":"assistant","content":"clean","toolCalls":[{"id":"c2","name":"x","arguments":"{\"k\":\"682419\",\"n\":[682419,1],\"o\":{\"p\":\"hunter2\"}}","thought_signature":"sig"}]},
  {"role":"assistant","content":"","toolCalls":[{"id":"c3","name":"x","arguments":{"list":["p@ss\"word","코드123",5],"deep":{"v":"hunter2"}}},{"id":"c4","name":"y"}]},
  {"role":"assistant","content":"carries state","reasoning":"has 682419 inside"},
  {"role":"assistant","content":"opaque holds","providerMetadata":{"note":"hunter2"},"toolCalls":[{"id":"c5","name":"x","arguments":{},"thoughtSignature":"p@ss\"word"}]},
  {"role":"tool","toolCallId":"c1","content":"{\"typed\":\"682419\",\"n\":682419,\"keep\":\"yes\"}"},
  {"role":"tool","toolCallId":"c2","content":"[\"hunter2\",1,{\"a\":\"코드123\"}]"},
  {"role":"tool","toolCallId":"c3","content":"\"682419\""},
  {"role":"tool","toolCallId":"c4","content":" {\"a\":\"x\"}"},
  {"role":"tool","toolCallId":"c5","content":"{broken 682419"},
  {"role":"tool","toolCallId":"c6","content":[{"type":"text","text":"{\"typed\":\"hunter2\"}"},{"type":"tool_result","content":"out 682419"},{"type":"tool_result","content":[{"type":"text","text":"nested 682419"},{"type":"image","attachmentRef":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}]},
  {"role":"tool","toolCallId":"c7","content":{"content":[{"type":"text","text":"wrapped 682419"}]}},
  {"role":"tool","toolCallId":"c8","content":{"type":"text","text":"single 682419"}},
  {"role":"tool","toolCallId":"c9","content":["682419","bare strings hunter2",7,null]},
  {"role":"user","content":"already [redacted] and [saved login] and 682419"},
  {"role":"user"},
  {"role":"system","content":"no change here","ts":2},
  null,
  "a bare string row 682419",
  7,
  ref(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']),
  ref(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']),
  ref('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.toUpperCase()),
  ref(0),
  ref(false),
  ref(null),
  ref(true),
  ref({}),
];
const sessions = [
  { id: 'sess-none', calls: [] },
  { id: 'sess-marks', calls: [{ name: 'browser', arguments: { action: 'fill', input: { ref: 'e1', text: '682419', sensitive: true, fields: [{ text: 'hunter2' }, { text: 'hunter22' }, { text: 'p@ss"word' }, { text: '코드123' }] } } }] },
  { id: 'sess-short', calls: [{ name: 'browser', arguments: { action: 'fill', input: { ref: 'e1', text: 'e', sensitive: true, fields: [{ value: 'red' }] } } }] },
];
const recorded = sessions.map(({ id, calls }) => {
  const marked = rememberSensitiveValues(id, calls);
  const stored = JSON.parse(JSON.stringify(_messagesForDisk(structuredClone(rows), id)));
  return { id, calls, marked, same: JSON.stringify(stored) === JSON.stringify(rows), stored };
});
writeJson(join(stage, 'golden.json'), { rows, sessions: recorded });
writeSetManifest(stage, { set: 'compaction-redactor', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
console.log(`compaction redactor: ${rows.length} rows, ${recorded.length} sessions`);