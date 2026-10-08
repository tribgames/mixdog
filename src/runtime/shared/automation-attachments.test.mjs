import assert from 'node:assert/strict';
import test from 'node:test';
import { automationPromptContent, normalizeAutomationAttachments } from './automation-attachments.mjs';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('office rows are accepted and become file parts like pdf, deterministically', () => {
  const rows = normalizeAutomationAttachments([
    { kind: 'office', name: 'a.docx', mimeType: DOCX, data: 'QUJD' },
    { kind: 'pdf', name: 'b.pdf', data: 'REVG' },
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ['office', 'pdf']);
  assert.equal(rows[1].mimeType, 'application/pdf');
  const parts = automationPromptContent('go', rows);
  assert.deepEqual(parts.slice(1), [
    { type: 'file', data: 'QUJD', mimeType: DOCX, filename: 'a.docx' },
    { type: 'file', data: 'REVG', mimeType: 'application/pdf', filename: 'b.pdf' },
  ]);
  assert.deepEqual(automationPromptContent('go', rows), parts);
});

test('binary total cap is 28M base64 chars across image/pdf/office', () => {
  const row = (kind, n) => ({ kind, name: kind, mimeType: 'x/y', data: 'A'.repeat(n) });
  assert.equal(normalizeAutomationAttachments([row('pdf', 14_000_000), row('office', 14_000_000)]).length, 2);
  assert.throws(
    () => normalizeAutomationAttachments([row('pdf', 14_000_000), row('office', 14_000_001)]),
    /image\/PDF\/Office attachments are too large together \(28 MB max\)/
  );
});
