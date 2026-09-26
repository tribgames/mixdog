// A session whose referenced attachment blob is gone from disk must still
// estimate and compact; provider sends keep failing on the missing blob.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-missing-attachment-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const media = await import('../providers/media-normalization.mjs');
const { estimateMessageTokens, estimateMessagesTokens, summarizeContextMessages } = await import('./context-utils.mjs');
const { runSessionCompaction } = await import('./manager/compaction-runner.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const SUMMARY = [
  '## Goal',
  '- continue',
  '',
  '## Constraints & Preferences',
  '- (none)',
  '',
  '## Progress',
  '### Done',
  '- older turns summarized',
  '',
  '### In Progress',
  '- (none)',
  '',
  '### Blocked',
  '- (none)',
  '',
  '## Key Decisions',
  '- (none)',
  '',
  '## Next Steps',
  '- (none)',
  '',
  '## Critical Context',
  '- (none)',
  '',
  '## Relevant Files',
  '- (none)',
].join('\n');

// Content-addressed blobs written straight to disk (never read, so the
// store's buffer cache cannot answer for them after deletion).
function blob(text) {
  const bytes = Buffer.from(text, 'utf8');
  const ref = createHash('sha256').update(bytes).digest('hex');
  const dir = join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ref), bytes);
  return { ref, sizeBytes: bytes.length, path: join(dir, ref) };
}

function attachmentContent(tag) {
  const image = blob(`image bytes ${tag}`);
  const file = blob(`notes file ${tag}`);
  return {
    blobs: [image, file],
    content: [
      { type: 'text', text: `[Image: source: shot-${tag}.png]` },
      { type: 'image', mimeType: 'image/png', attachmentRef: image.ref, sizeBytes: image.sizeBytes },
      { type: 'file', mimeType: 'text/plain', filename: 'notes.txt', attachmentRef: file.ref, sizeBytes: file.sizeBytes },
    ],
  };
}

test('a referenced image estimates the same with or without its blob', () => {
  const { blobs, content } = attachmentContent('same');
  const imageOnly = { role: 'user', content: content.slice(0, 2) };
  const present = estimateMessageTokens(structuredClone(imageOnly));
  for (const { path } of blobs) rmSync(path);
  assert.equal(estimateMessageTokens(structuredClone(imageOnly)), present);
  // Unknown-size image allowance (1,568) + text + per-message overhead.
  const textOnly = estimateMessageTokens({ role: 'user', content: content.slice(0, 1) });
  assert.equal(present - textOnly, 1_568);
});

test('a session referencing deleted attachments estimates and compacts', async () => {
  const old = attachmentContent('old');
  const latest = attachmentContent('latest');
  const messages = [{ role: 'system', content: 'system rules' }];
  messages.push({ role: 'user', content: old.content }, { role: 'assistant', content: 'seen the old image' });
  for (let turn = 0; turn < 20; turn += 1) {
    messages.push(
      { role: 'user', content: `request ${turn} ${'context '.repeat(400)}` },
      { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` }
    );
  }
  messages.push({ role: 'user', content: latest.content });
  for (const { path } of [...old.blobs, ...latest.blobs]) rmSync(path);

  assert.ok(estimateMessagesTokens(messages) > 0);
  assert.ok(summarizeContextMessages(messages).estimatedTokens > 0);

  const session = {
    id: `missing-attachment-${process.pid}`,
    provider: 'anthropic-oauth',
    model: 'fake-model',
    owner: 'agent',
    contextWindow: 60_000,
    compactBoundaryTokens: 60_000,
    messages,
    tools: [],
    compaction: { conversationThresholdTokens: 1 },
  };
  const result = await runSessionCompaction(session, {
    mode: 'manual',
    force: true,
    config: {},
    provider: { name: 'anthropic-oauth', send: async () => ({ content: SUMMARY }) },
    model: 'fake-model',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.changed, true);
  assert.ok(result.afterMessageTokens < result.beforeMessageTokens);
  // The latest request keeps its references verbatim.
  assert.deepEqual(session.messages.find((message) => message.content === latest.content)?.content, latest.content);
});

test('provider sends still fail on a missing attachment blob', () => {
  const { blobs, content } = attachmentContent('send');
  for (const { path } of blobs) rmSync(path);
  const image = [content[1]];
  const file = [content[2]];
  for (const normalize of [
    media.normalizeContentForAnthropic,
    media.normalizeContentForOpenAIChat,
    media.normalizeContentForOpenAIResponses,
    media.normalizeContentForGeminiParts,
  ]) {
    assert.throws(() => normalize(image), { code: 'ENOENT' });
    assert.throws(() => normalize(file), { code: 'ENOENT' });
  }
  assert.throws(() => media.contentToText(file), { code: 'ENOENT' });
});
