// A name that begins with two dots is an entry, not traversal; `..` as a component is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { isInside } from './path-scope.mjs';
import { startWorker } from './test/worker-client.mjs';

test('isInside tells traversal from a name that starts with dots', () => {
  const root = path.resolve('scope-root');
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.join(root, '..notes.docx')), true);
  assert.equal(isInside(root, path.join(root, '...', 'x')), true);
  assert.equal(isInside(root, path.join(root, 'a', '..b')), true);
  assert.equal(isInside(root, path.resolve(root, '..', 'x')), false);
  assert.equal(isInside(root, path.resolve(root, '..')), false);
  assert.equal(isInside(root, `${root}-sibling`), false);
});

test('a ..-prefixed file inside the approved directory is served; ../x outside is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-dots-'));
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  const bytes = await doc.save();
  const dotted = path.join(root, '..notes.pdf');
  fs.writeFileSync(dotted, bytes);
  fs.writeFileSync(path.join(path.dirname(root), `${path.basename(root)}-outside.pdf`), bytes);
  const worker = startWorker();
  try {
    await worker.ready;
    // methods.mjs approval (pdf.inspect).
    const inspected = await worker.call('pdf.inspect', { path: dotted }, [root]);
    assert.equal(inspected.result.ok.pageCount, 1, '..notes.pdf is inside the root');
    const outside = await worker.call('pdf.inspect', { path: path.join(root, '..', `${path.basename(root)}-outside.pdf`) }, [root]);
    assert.equal(outside.result.err.code, 'path_not_approved');

    // document.mjs root approval and project-relative resolution.
    const params = { root, cacheRoot: path.join(root, '.cache') };
    const preview = await worker.call('document.preview', { ...params, rel: '..notes.pdf' }, [root]);
    assert.equal(preview.result.ok.path, dotted);
    const escape = await worker.call('document.preview', { ...params, rel: '../x.pdf' }, [root]);
    assert.equal(escape.result.err.code, 'path_outside_project');
    fs.mkdirSync(path.join(root, 'sub'));
    const unapproved = await worker.call('document.preview', { ...params, rel: '..notes.pdf' }, [path.join(root, 'sub')]);
    assert.equal(unapproved.result.err.code, 'path_not_approved');
  } finally {
    await worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(root), `${path.basename(root)}-outside.pdf`), { force: true });
  }
});
