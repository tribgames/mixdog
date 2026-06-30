#!/usr/bin/env node
import { createRequire } from 'node:module'
import {
  normalizeIngestRole,
  sessionMessageContent,
  sessionMessageContentForIngest,
  shouldExcludeIngestMessage,
} from '../src/runtime/memory/lib/session-ingest.mjs'

// cleanMemoryText is the SAME downstream cleaner the real ingest loop applies
// (memory/index.mjs:795). text-utils.cjs is a dependency-free CJS module, so we
// require it directly to mirror the pipeline without booting the MCP server.
const require = createRequire(import.meta.url)
const { cleanMemoryText } = require('../src/lib/text-utils.cjs')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// Mirror memory/index.mjs ingestSessionMessages row handling for one message:
//   role gate → exclusion predicate → ingest shaper → cleanMemoryText → trim.
// Returns the persisted content string, or null when the row is NOT ingested.
function ingestRow(m) {
  const role = normalizeIngestRole(m.role)
  if (!role) return null
  if (shouldExcludeIngestMessage(m)) return null
  const content = cleanMemoryText(sessionMessageContentForIngest(m))
  if (!content || !content.trim()) return null
  return content
}

const SUMMARY_PREFIX = 'A previous model worked on this task and produced the compacted handoff summary below. Build on the work already done and avoid duplicating it; treat the summary as authoritative context for continuing the task. You also retain the preserved recent turns that follow.'

// ── Synthetic session.messages covering every audited case ──────────────────
// (i) assistant prose + an `agent` toolCall (tool-call trace must be stripped).
const asstWithTool = {
  role: 'assistant',
  content: 'Here is my plan for the refactor.',
  toolCalls: [{ id: 'call_42', name: 'agent', arguments: '{"type":"send","text":"go"}' }],
}
// (ii) the real human turn carrying the full manager-style prefix envelope.
const sessionBlock = '# Session\nCwd: C:/Project/mixdog\nModel: GPT-5 · HIGH'
const prefixedUser = {
  role: 'user',
  content:
    `${sessionBlock}\n\n` +
    '# Additional context\nsome context body line one\nline two\n\n' +
    '# Prefetch\nprefetched file snippet\n\n' +
    '# Task\n실제 질문',
}
// (iii) Reference files synthetic row.
const referenceRow = { role: 'user', content: 'Reference files:\n- a.mjs\n- b.mjs' }
// (iv) compaction summary row.
const summaryRow = { role: 'user', content: `${SUMMARY_PREFIX}\nmessages=10 sha256=abcd roles=user:5` }
// (v) protected-context `.` ack assistant row.
const ackRow = { role: 'assistant', content: '.' }
// (vi) internal runtime nudge user row.
const nudgeRow = { role: 'user', content: '[mixdog-runtime] Your previous response was empty. Continue.' }
// (vii) normal human + normal assistant.
const normalUser = { role: 'user', content: '안녕' }
const normalAsst = { role: 'assistant', content: '네 안녕하세요' }

const before = {
  asstWithTool: sessionMessageContent(asstWithTool),
  prefixedUser: prefixedUser.content,
  referenceRow: referenceRow.content,
  summaryRow: summaryRow.content,
  ackRow: ackRow.content,
  nudgeRow: nudgeRow.content,
  normalUser: normalUser.content,
  normalAsst: normalAsst.content,
}

const after = {
  asstWithTool: ingestRow(asstWithTool),
  prefixedUser: ingestRow(prefixedUser),
  referenceRow: ingestRow(referenceRow),
  summaryRow: ingestRow(summaryRow),
  ackRow: ingestRow(ackRow),
  nudgeRow: ingestRow(nudgeRow),
  normalUser: ingestRow(normalUser),
  normalAsst: ingestRow(normalAsst),
}

// (i) tool-call trace gone, prose kept.
assert(before.asstWithTool.includes('[tool_call agent'), 'precondition: structured shaper inlines the tool_call trace')
assert(after.asstWithTool && !after.asstWithTool.includes('[tool_call'), 'ingest must strip the tool_call trace')
assert(after.asstWithTool.includes('Here is my plan for the refactor.'), 'assistant prose must survive')

// (ii) prefixed user collapses to exactly the human prompt.
assert(after.prefixedUser === '실제 질문', `prefixed user must shape to "실제 질문" (got: ${JSON.stringify(after.prefixedUser)})`)
assert(!/# Session|Cwd:|Model:|Additional context|Prefetch|# Task/.test(after.prefixedUser), 'no prefix residue may remain')

// (iii)-(vi) synthetic rows excluded.
assert(after.referenceRow === null, 'Reference files row must be excluded')
assert(after.summaryRow === null, 'SUMMARY_PREFIX row must be excluded')
assert(after.ackRow === null, '`.` ack row must be excluded')
assert(after.nudgeRow === null, '[mixdog-runtime] nudge row must be excluded')

// (vii) normal conversation survives intact.
assert(after.normalUser === '안녕', 'normal human text must survive intact')
assert(after.normalAsst === '네 안녕하세요', 'normal assistant text must survive intact')

// Zero-loss guard: a human message that merely MENTIONS the markers mid-text is
// NOT stripped (anchors only fire on the leading manager-produced prefix).
const humanMentionsMarkers = { role: 'user', content: 'please write a # Task section and a # Prefetch note' }
assert(ingestRow(humanMentionsMarkers) === 'please write a # Task section and a # Prefetch note', 'mid-text markers must not be stripped')

// ── Edge: field-anchored `# Session` strip (zero-loss for human docs) ────────
// A human doc that legitimately STARTS with a `# Session` heading followed by
// free prose must NOT be wiped. The strip is field-anchored to the EXACT shape
// buildSessionStartBlock emits (`# Session` then only Cwd/Model/Workflow lines).
// Assert on the SHAPER directly so the check isolates the strip rule from
// cleanMemoryText's normal markdown-header cleaning.
const humanSessionDoc = { role: 'user', content: '# Session\n프로젝트 회의록입니다\n다음 안건' }
assert(
  sessionMessageContentForIngest(humanSessionDoc) === '# Session\n프로젝트 회의록입니다\n다음 안건',
  'human doc starting with `# Session` heading must be preserved verbatim (not wiped)',
)
// And through the full ingest row it must still carry the human words (the lone
// `# ` heading marker is stripped by normal markdown cleaning — not data loss).
assert(/프로젝트 회의록입니다/.test(ingestRow(humanSessionDoc) || ''), 'human session-doc words must survive ingest')

// Injected real session block (Cwd/Model) still strips to the human prompt.
const injectedCwdModel = { role: 'user', content: '# Session\nCwd: /x\nModel: Y\n\n실제질문' }
assert(sessionMessageContentForIngest(injectedCwdModel) === '실제질문', 'injected Cwd/Model session block must strip to the human prompt')

// Injected real session block incl. Workflow line still strips.
const injectedWorkflow = { role: 'user', content: '# Session\nCwd: /x\nModel: Y\nWorkflow: Default\n\nq' }
assert(sessionMessageContentForIngest(injectedWorkflow) === 'q', 'injected Cwd/Model/Workflow session block must strip to the human prompt')

const rows = [
  ['(i) assistant + agent toolCall', before.asstWithTool, after.asstWithTool],
  ['(ii) prefixed human turn', before.prefixedUser, after.prefixedUser],
  ['(iii) Reference files', before.referenceRow, after.referenceRow],
  ['(iv) SUMMARY_PREFIX', before.summaryRow, after.summaryRow],
  ['(v) `.` ack', before.ackRow, after.ackRow],
  ['(vi) [mixdog-runtime] nudge', before.nudgeRow, after.nudgeRow],
  ['(vii) normal human', before.normalUser, after.normalUser],
  ['(vii) normal assistant', before.normalAsst, after.normalAsst],
]
process.stdout.write('before/after (EXCLUDED = row not ingested):\n')
for (const [label, b, a] of rows) {
  process.stdout.write(`  ${label}\n`)
  process.stdout.write(`    before: ${JSON.stringify(b)}\n`)
  process.stdout.write(`    after : ${a === null ? 'EXCLUDED' : JSON.stringify(a)}\n`)
}
process.stdout.write('\ningest pure-conversation smoke passed \u2713\n')
