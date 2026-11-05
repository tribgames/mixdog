// `ooxml.text` answers exactly as Node's own extraction entry points do.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { extractOoxmlText, tryExtractOoxmlTextFromBuffer } from '../runtime/attachments/office-extract.mjs';
import { startWorker } from './test/worker-client.mjs';

async function docx(file) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello ooxml</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:body></w:document>'
  );
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

test('ooxml.text equals Node extraction, in both entry forms', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-ooxml-'));
  const good = path.join(root, 'a.docx');
  const bad = path.join(root, 'b.docx');
  await docx(good);
  fs.writeFileSync(bad, 'not a zip');
  const worker = startWorker();
  try {
    await worker.ready;
    const ask = async (params) => (await worker.call('ooxml.text', params, [root])).result;

    // The read tool's form: the text, or the "Error: ..." line it shows.
    for (const file of [good, bad]) {
      const got = await ask({ path: file, maxOutputBytes: 1024 });
      assert.equal(got.ok.text, await extractOoxmlText(file, { maxOutputBytes: 1024 }), file);
    }
    assert.match((await ask({ path: good })).ok.text, /Hello ooxml/);

    // Provider lowering's form: the text, or null for an unreadable file.
    const limits = { maxOutputBytes: 1024, maxPartBytes: 8 * 1024 * 1024, maxContainerBytes: 32 * 1024 * 1024 };
    for (const file of [good, bad]) {
      const want = tryExtractOoxmlTextFromBuffer(fs.readFileSync(file), file, limits);
      assert.equal((await ask({ path: file, ...limits })).ok.text, want, file);
    }
    assert.equal((await ask({ path: bad, ...limits })).ok.text, null);
    assert.equal((await ask({ path: path.join(root, 'missing.docx'), ...limits })).ok.text, null);

    const outside = await ask({ path: path.join(os.homedir(), 'x.docx') });
    assert.ok(outside.err, 'a path outside the approved set is refused');
  } finally {
    await worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
