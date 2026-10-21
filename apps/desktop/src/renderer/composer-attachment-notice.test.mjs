// Before sending, a large set of attached PDFs shows its page count and token
// estimate and says the files may stay on this computer for the model to read
// page by page.
import assert from 'node:assert/strict';
import test from 'node:test';

import { attachmentContextNotice, pdfPageCount } from './composer-attachments.ts';

const latin1 = (text) => Uint8Array.from(Buffer.from(text, 'latin1'));

test('the page tree states the page count; page objects are the fallback', () => {
  const tree = '<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >> << /Type /Pages /Count 37 /Kids [2 0 R] >>';
  assert.equal(pdfPageCount(latin1(`%PDF-1.7\n${tree}`)), 37);
  const pages = '<< /Type /Page /Parent 2 0 R >> << /Type/Page >> << /Type /Pages >>';
  assert.equal(pdfPageCount(latin1(`%PDF-1.7\n${pages}`)), 2);
  assert.equal(pdfPageCount(latin1('%PDF-1.5\n<< /Type /ObjStm /N 40 >>')), 0, 'a compressed tree is not guessed');
});

const pdf = (id, pageCount) => ({
  id,
  name: `scan-${id}.pdf`,
  kind: 'pdf',
  mimeType: 'application/pdf',
  data: 'JVBERi0=',
  token: `[PDF #${id}: scan-${id}.pdf]`,
  chipOnly: true,
  pageCount,
});

test('eight 37-page scans get a notice with their pages and estimate', () => {
  const notice = attachmentContextNotice(Array.from({ length: 8 }, (_, index) => pdf(index + 1, 37)));
  assert.match(notice, /about 296 pages/);
  assert.match(notice, /~464,128 tokens/);
  assert.match(notice, /reads only the pages it needs/);
});

test('a few short PDFs and unknown page counts raise no notice', () => {
  assert.equal(attachmentContextNotice([pdf(1, 10), pdf(2, 12)]), '');
  assert.equal(attachmentContextNotice([pdf(1, 0)]), '');
  assert.equal(attachmentContextNotice([]), '');
});
