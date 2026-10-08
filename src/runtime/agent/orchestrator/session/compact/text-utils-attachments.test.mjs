import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-compact-text-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { extractText } = await import('./text-utils.mjs');

function blob(text, { write = true } = {}) {
  const bytes = Buffer.from(text, 'utf8');
  const ref = createHash('sha256').update(bytes).digest('hex');
  const dir = join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2));
  if (write) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ref), bytes);
  }
  return { attachmentRef: ref, sizeBytes: bytes.length };
}

test('extractText resolves text attachment refs, bounded, and tolerates a missing blob', () => {
  const long = blob('the long user request '.repeat(5000));
  const missing = blob('never written', { write: false });
  const text = extractText({
    role: 'user',
    content: [
      { type: 'text', text: 'see below' },
      { type: 'text', ...long },
      { type: 'text', ...missing },
    ],
  });
  assert.match(text, /^see below\nthe long user request/);
  assert.ok(text.length < 30_000, `unbounded: ${text.length}`);
  assert.match(text, /\[attachment unavailable\]$/);
});

test('extractText marks a corrupt blob unavailable but rethrows a transient read error', async (t) => {
  const corrupt = blob('original');
  writeFileSync(join(dataDir, 'prompt-attachments', 'sha256', corrupt.attachmentRef.slice(0, 2), corrupt.attachmentRef), 'tampered!');
  assert.equal(extractText({ role: 'user', content: [{ type: 'text', ...corrupt }] }), '[attachment unavailable]');

  const fine = blob('readable');
  const { default: fs } = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { clearAttachmentBufferCache } = await import('../../../../attachments/store.mjs');
  clearAttachmentBufferCache();
  const realStat = fs.statSync;
  t.mock.method(fs, 'statSync', (path, ...rest) => {
    if (String(path).endsWith(fine.attachmentRef)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realStat(path, ...rest);
  });
  syncBuiltinESMExports();
  assert.throws(() => extractText({ role: 'user', content: [{ type: 'text', ...fine }] }), { code: 'EBUSY' });
  t.mock.restoreAll();
  syncBuiltinESMExports();
});

test('a PDF is recognised by the same kind rule lowering uses, not label or extension alone', () => {
  const pdf = Buffer.from('%PDF-1.4\nrest').toString('base64');
  const marker = (part) => extractText({ role: 'user', content: [part] });
  assert.equal(marker({ type: 'file', data: pdf, mimeType: 'application/octet-stream', filename: 'report' }), '[PDF: report]');
  assert.equal(marker({ type: 'file', attachmentRef: 'e'.repeat(64), mimeType: 'application/pdf', filename: 'scan' }), '[PDF: scan]');
  assert.equal(marker({ type: 'file', data: 'AAAA', mimeType: 'application/zip', filename: 'trick.pdf' }), '[file: trick.pdf]');
});

test('extractText marks media parts so the summarizer knows they existed', () => {
  const text = extractText({
    role: 'user',
    content: [
      { type: 'text', text: 'compare these' },
      { type: 'image', mimeType: 'image/png', attachmentRef: 'a'.repeat(64) },
      { type: 'file', mimeType: 'application/pdf', filename: 'spec.pdf', attachmentRef: 'b'.repeat(64) },
      { type: 'file', mimeType: 'application/zip', filename: 'bundle.zip', attachmentRef: 'c'.repeat(64) },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' }, title: 'read.pdf' },
    ],
  });
  assert.equal(text, 'compare these\n[image]\n[PDF: spec.pdf]\n[file: bundle.zip]\n[PDF: read.pdf]');
});
