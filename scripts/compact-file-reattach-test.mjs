import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recallFastTrackCompactMessages, semanticCompactMessages } from '../src/runtime/agent/orchestrator/session/compact.mjs';
import { buildPostCompactFileAttachment } from '../src/runtime/agent/orchestrator/session/compact/file-reattach.mjs';
import { sanitizeToolPairs } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';

const dir = mkdtempSync(join(tmpdir(), 'reattach-'));
const fileA = join(dir, 'a.mjs'); writeFileSync(fileA, 'export const A = 1;\n'.repeat(50));
const fileB = join(dir, 'b.mjs'); writeFileSync(fileB, 'export const B = 2;\n'.repeat(50));
const fileHuge = join(dir, 'huge.txt'); writeFileSync(fileHuge, 'h'.repeat(600 * 1024)); // > 512KB cap

const readCall = (id, p) => ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: JSON.stringify({ path: p }) }] });
const toolRes = (id) => ({ role: 'tool', toolCallId: id, content: 'old cached body '.repeat(100) });

function transcript() {
  const msgs = [{ role: 'system', content: 'rules' }];
  msgs.push({ role: 'user', content: 'fix bug in a.mjs' });
  msgs.push(readCall('c1', fileA), toolRes('c1'));
  msgs.push(readCall('c2', fileHuge), toolRes('c2'));
  msgs.push(readCall('c3', join(dir, 'missing.mjs')), toolRes('c3'));
  for (let i = 0; i < 12; i++) { msgs.push({ role: 'user', content: `iterate ${i} ` + 'pad '.repeat(300) }, { role: 'assistant', content: `ok ${i}` }); }
  // newest turn reads fileB — must survive in tail and be skipped
  msgs.push({ role: 'user', content: 'now check b.mjs' });
  msgs.push(readCall('c9', fileB), toolRes('c9'));
  msgs.push({ role: 'assistant', content: 'checked' });
  return msgs;
}

// 1) fasttrack: A re-attached, B (in tail) skipped, huge+missing skipped
{
  const r = recallFastTrackCompactMessages(transcript(), 4000, { force: true, recallText: 'digest', allowEmptyRecall: true, tailTurns: 2, keepTokens: 2000, cwd: dir });
  const ref = r.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Reference files:'));
  assert.ok(ref, 'fasttrack: reference-files message injected');
  assert.ok(ref.content.includes(fileA), 'fileA re-attached');
  assert.ok(ref.content.includes('export const A'), 'fileA fresh content present');
  assert.ok(!ref.content.includes(fileHuge), 'huge file skipped');
  assert.ok(!ref.content.includes('missing.mjs'), 'missing file skipped');
  assert.ok(!ref.content.includes(fileB) || !ref.content.includes('export const B'), 'tail-surviving fileB not re-attached');
  const refIdx = r.messages.indexOf(ref);
  assert.equal(r.messages[refIdx + 1]?.role, 'assistant', 'ack follows reference message');
  assert.equal(JSON.stringify(sanitizeToolPairs(r.messages)), JSON.stringify(r.messages), 'pairing valid');
  assert.equal(r.diagnostics.fileReattached, true, 'diagnostics flag set');
}
// 2) semantic path with fake provider
{
  const provider = { name: 'fake', async send() { return { content: '## Goal\n- g\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- d\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- n\n\n## Critical Context\n- c\n\n## Relevant Files\n- a.mjs' }; } };
  const r = await semanticCompactMessages(provider, transcript(), 'fake-model', 4000, { force: true, tailTurns: 1, cwd: dir });
  const ref = r.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Reference files:'));
  assert.ok(ref, 'semantic: reference-files message injected');
  assert.ok(ref.content.includes('export const A'), 'semantic: fileA fresh content');
  assert.equal(r.diagnostics.fileReattached, true, 'semantic diagnostics flag');
}
// 3) no room -> no injection, still valid compact
{
  const r = recallFastTrackCompactMessages(transcript(), 1500, { force: true, recallText: 'digest', allowEmptyRecall: true, tailTurns: 1, keepTokens: 1200, cwd: dir });
  assert.ok(Array.isArray(r.messages), 'tight budget compact still succeeds');
  const ref = r.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Reference files:'));
  if (ref) assert.ok(r.diagnostics.finalTokens <= r.diagnostics.budgetTokens, 'reattach never exceeds budget');
}
// 4) env off-switch
{
  process.env.MIXDOG_COMPACT_FILE_REATTACH = '0';
  const off = buildPostCompactFileAttachment([readCall('x', fileA)], [], 10000, { cwd: dir });
  assert.equal(off, null, 'env kill-switch disables reattach');
  delete process.env.MIXDOG_COMPACT_FILE_REATTACH;
}
rmSync(dir, { recursive: true, force: true });
console.log('compact file-reattach test passed \u2713');

