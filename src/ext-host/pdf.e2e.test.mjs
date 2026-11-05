// End to end: pdf.inspect, pdf.render and pdf.ocr against the real worker process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { startWorker } from './test/worker-client.mjs';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function samplePdf(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of ['Hello exthost page one', 'Second page text here']) {
    doc.addPage([400, 200]).drawText(text, { x: 20, y: 100, size: 24, font });
  }
  fs.writeFileSync(file, await doc.save());
}

test('pdf methods answer over the worker protocol', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-pdf-'));
  const file = path.join(root, 't.pdf');
  await samplePdf(file);
  const worker = startWorker();
  try {
    await worker.ready;

    const inspected = await worker.call('pdf.inspect', { path: file, extractText: true }, [root]);
    assert.equal(inspected.result.ok.pageCount, 2);
    assert.match(inspected.result.ok.text, /Hello exthost page one/);
    assert.match(inspected.result.ok.text, /Second page text here/);
    assert.equal(inspected.result.pin, false);
    assert.equal(inspected.chunks.length, 0);

    const rendered = await worker.call('pdf.render', { path: file, pages: [1, 2] }, [root]);
    const { images } = rendered.result.ok;
    assert.deepEqual(images.map((i) => i.page), [1, 2]);
    assert.equal(rendered.chunks.length, 2, 'one chunk per page image, in images order');
    images.forEach((image, i) => {
      assert.equal(image.mimeType, 'image/png');
      assert.equal(rendered.chunks[i].length, image.bytes);
      assert.deepEqual(rendered.chunks[i].subarray(0, 4), PNG_MAGIC);
    });
    assert.equal(fs.existsSync(path.join(root, 't-page-1.png')), false, 'images travel as chunks; the worker writes nothing');

    const recognized = await worker.call('pdf.ocr', { path: file, pages: [1], dataDir: path.join(root, 'data') }, [root]);
    assert.equal(recognized.result.ok.length, 1);
    assert.equal(recognized.result.ok[0].page, 1);
    assert.match(recognized.result.ok[0].text, /Hello exthost page one/);

    const outside = await worker.call('pdf.inspect', { path: path.join(os.homedir(), 'x.pdf') }, [root]);
    assert.ok(outside.result.err, 'a path outside the approved set is refused');
  } finally {
    await worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
