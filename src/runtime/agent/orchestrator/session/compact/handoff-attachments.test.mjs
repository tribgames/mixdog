// The compaction summarizer must read what the user wrote even when it is
// stored as a text attachment, and must know media existed: both summary paths
// use the same ref-resolving text projection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-handoff-attachments-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { generateFreshHandoffSummary, conversationCompactionInput } = await import('./runner.mjs');

function textRef(text, extra = {}) {
  const bytes = Buffer.from(text, 'utf8');
  const ref = createHash('sha256').update(bytes).digest('hex');
  const dir = join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ref), bytes);
  return { type: 'text', attachmentRef: ref, sizeBytes: bytes.length, ...extra };
}

const LONG = `Requirement ${'the nightly export must keep column order. '.repeat(40)}END-OF-LONG-MESSAGE`;

const messages = () => [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Please review these:' },
      textRef(LONG),
      { type: 'image', attachmentRef: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 3 },
      { type: 'file', attachmentRef: 'b'.repeat(64), mimeType: 'application/pdf', filename: 'spec.pdf', sizeBytes: 9 },
      { type: 'file', attachmentRef: 'c'.repeat(64), mimeType: 'application/zip', filename: 'data.zip', sizeBytes: 9 },
    ],
  },
  { role: 'assistant', content: 'Reviewed; the export keeps column order.' },
  { role: 'user', content: 'Now continue with the migration.' },
];

const SUMMARY = ['Goal', 'Constraints', 'Progress', 'Key Decisions', 'Next Steps', 'Critical Context', 'Relevant Files']
  .map((section) => `## ${section}\n- noted`)
  .join('\n');

test('the real handoff entry (filterOldHistoryForIngest) sends long stored messages and media markers to the summarizer', async () => {
  const prompts = [];
  const provider = {
    name: 'fake',
    async send(sent) {
      prompts.push(sent.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
      return { content: SUMMARY, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const result = await generateFreshHandoffSummary(provider, messages(), 'm', 60_000, {
    filterOldHistoryForIngest: true,
  });
  assert.equal(result.handoffGenerated, true);
  assert.equal(prompts.length >= 1, true);
  const prompt = prompts.join('\n');
  assert.match(prompt, /END-OF-LONG-MESSAGE/);
  assert.match(prompt, /\[image\]/);
  assert.match(prompt, /\[PDF: spec\.pdf\]/);
  assert.match(prompt, /\[file: data\.zip\]/);
  assert.equal(prompt.includes('attachmentRef'), false);
});

test('the rule-first conversation input reads the same projection, and a missing blob does not fail it', () => {
  const gone = textRef('x'.repeat(900), { filename: 'gone.txt' });
  rmSync(join(dataDir, 'prompt-attachments', 'sha256', gone.attachmentRef.slice(0, 2), gone.attachmentRef));
  const input = conversationCompactionInput([
    { role: 'user', content: [textRef(LONG), gone] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'latest request' },
  ]);
  const text = input.map((m) => m.content).join('');
  assert.match(text, /END-OF-LONG-MESSAGE/);
  assert.match(text, /\[attachment unavailable\]/);
});
