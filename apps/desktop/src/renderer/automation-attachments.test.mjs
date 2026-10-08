import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
const previous = new Map(['window', 'document', 'FileReader'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  FileReader: {
    configurable: true,
    value: class {
      readAsDataURL(blob) {
        void blob.arrayBuffer().then((buffer) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
          this.onload?.();
        });
      }
    },
  },
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { attachmentsFromRecords, readAutomationFiles } = await import('./automation-attachments.tsx');

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('Office files are stored as kind office with the inferred OOXML MIME type', async () => {
  const file = new File(['PK'], 'brief.docx', { type: 'application/octet-stream' });
  const { attachments, error } = await readAutomationFiles([file], []);
  assert.equal(error, '');
  assert.deepEqual(attachments, [{ kind: 'office', name: 'brief.docx', mimeType: DOCX, data: Buffer.from('PK').toString('base64') }]);
});

test('automation intake rejects empty, legacy and fake PDF files and keeps old pdf-kind Office rows', async () => {
  assert.match((await readAutomationFiles([new File([], 'a.docx')], [])).error, /a\.docx: the file is empty/);
  assert.match((await readAutomationFiles([new File(['x'], 'a.doc')], [])).error, /Save it as \.docx/);
  assert.match(
    (await readAutomationFiles([new File(['<html>'], 'a.pdf', { type: 'application/pdf' })], [])).error,
    /not a valid PDF/
  );
  const old = { kind: 'pdf', name: 'old.docx', mimeType: DOCX, data: 'UEs=' };
  assert.deepEqual(attachmentsFromRecords([old, { kind: 'office', name: 'n.xlsx', mimeType: 'x', data: 'UEs=' }]), [
    old,
    { kind: 'office', name: 'n.xlsx', mimeType: 'x', data: 'UEs=' },
  ]);
});
