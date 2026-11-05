// Records the office render and OCR goldens against today's Node product, through the real worker
// (the path the Rust office front end will call). LibreOffice runs one process at a time: the
// render calls are sequential, on one worker.
//
//   node src/ext-host/test/record-render-goldens.mjs
//
// Writes native/core/fixtures/tools/office/{render-docx,render-xlsx,render-pptx,ocr-pdf}.json.
// Page images are recorded as mime type and dimensions only; their bytes depend on installed fonts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { startWorker } from './worker-client.mjs';

const outDir = fileURLToPath(new URL('../../../native/core/fixtures/tools/office/', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-golden-'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-golden-data-'));

// The root appears raw, forward-slashed, and JSON-escaped once or twice (a JSON text inside JSON).
const rootForms = [...new Set([JSON.stringify(JSON.stringify(root).slice(1, -1)).slice(1, -1), JSON.stringify(root).slice(1, -1), root, root.replaceAll('\\', '/')])];

const scrubString = (text) => {
  let out = text;
  for (const form of rootForms) out = out.replaceAll(form, '<ROOT>');
  return out
    .replace(/\b(office|sess|session)_[A-Za-z0-9]{6,}\b/g, '$1_<ID>')
    .replace(/(durationMs|elapsedMs)(\\*"):\s*[\d.]+/g, '$1$2:0')
    .replace(/[0-9a-f]{64}/g, '<HASH>');
};

const scrub = (value) => {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
};

const write = (name, record) => {
  fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(scrub(record), null, 2)}\n`);
  console.log('recorded', name);
};

const worker = startWorker();
try {
  await worker.ready;
  const office = async (args) => {
    const { result, chunks } = await worker.call('office.run', { args, cwd: root, dataDir: data }, [root]);
    if (!result.ok) throw new Error(`office.run ${args.action}: ${JSON.stringify(result.err)}`);
    return { value: result.ok, chunks };
  };
  const content = (value) => value.result.content.find((c) => c.type === 'text').text;

  const seeds = {
    docx: [{ op: 'add_paragraph', text: 'Render golden paragraph' }],
    xlsx: [{ op: 'set_range', sheet: 'Sheet1', range: 'A1:B2', values: [['k', 'v'], ['one', 1]] }],
    pptx: [],
  };
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const file = `r.${format}`;
    const created = JSON.parse(content((await office({ action: 'create', path: file, format, mode: 'portable' })).value));
    if (seeds[format].length) await office({ action: 'batch', session: created.session, operations: seeds[format] });
    await office({ action: 'save', session: created.session });
    const input = { action: 'render', session: created.session, output: `r-${format}.pdf` };
    const rendered = await office(input);
    const envelope = rendered.value.result.content.map((block) =>
      block.type === 'image' ? { type: 'image', mimeType: block.source.media_type } : block
    );
    write(`render-${format}`, {
      method: 'office.run',
      input: { ...input, session: 'office_<ID>' },
      isError: false,
      text: JSON.stringify({ content: envelope }),
      chunkCount: rendered.chunks.length,
    });
    await office({ action: 'close', session: created.session });
  }

  const pdf = path.join(root, 'ocr.pdf');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 200]).drawText('Hello exthost page one', { x: 20, y: 100, size: 24, font });
  fs.writeFileSync(pdf, await doc.save());
  const ocr = await worker.call('pdf.ocr', { path: pdf, pages: [1], dataDir: data }, [root]);
  if (!ocr.result.ok) throw new Error(`pdf.ocr: ${JSON.stringify(ocr.result.err)}`);
  write('ocr-pdf', { method: 'pdf.ocr', input: { path: '<ROOT>/ocr.pdf', pages: [1] }, result: ocr.result.ok });
} finally {
  await worker.stop();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
}
