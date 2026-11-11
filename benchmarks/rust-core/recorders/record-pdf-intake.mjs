// What a turn's PDF attachment meets when it is added (review of gaps-session-rest item 7): Node's turn intake
// (`session-turns.mjs:112` `submitAdmitted`: `preparePromptSubmissionForProvider(materializePromptSubmission(prompt,
// options), { nativePdf })`, `attachments/store.mjs:784`) stores the attachment, refuses one over 20 MiB
// (`store.mjs:801`, `MAX_PDF_BYTES`), inspects the rest and, for a provider that sends the PDF natively, refuses one over
// 100 pages (`store.mjs:810` -> `pdf-extract.mjs:140`, `MAX_PDF_PAGES`). What the submit answers is the recording: the
// prepared prompt whole (`exact`), or the error it throws (name, message, code).
//
// Cases, each a prompt of one text part and one PDF file part, inline base64 as a composer sends it:
//   size-at-limit      a one-page PDF padded after its end to exactly 20 MiB, native provider
//   size-over-limit    the same plus one byte
//   pages-100          100 text pages, native provider
//   pages-101          101 text pages, native provider
//   pages-101-text     101 text pages, a provider that takes PDFs as text
//   encrypted          a standard-security PDF whose user password is not empty, native provider
//   damaged            a PDF header and nothing a parser can read, native provider
//   scanned-text-only  three pages without a text layer, a provider that takes PDFs as text
//
//   node benchmarks/rust-core/recorders/record-pdf-intake.mjs --tree <b6f10295a export with node_modules>
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RECORDER = 'benchmarks/rust-core/recorders/record-pdf-intake.mjs';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const LIMIT = 20 * 1024 * 1024;
// pdf-lib's documents carry no clock: creation and modification dates are fixed.
const DATE = new Date('2026-03-04T05:06:07.000Z');

async function pdfOf(PDFLib, pages, { text = true } = {}) {
  const doc = await PDFLib.PDFDocument.create();
  doc.setCreationDate(DATE);
  doc.setModificationDate(DATE);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage([200, 200]);
    if (text) page.drawText(`page ${i} of the intake recording`, { x: 10, y: 100, size: 8, font });
    else page.drawRectangle({ x: 20, y: 20, width: 160, height: 160, color: PDFLib.rgb(0.5, 0.5, 0.5) });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// A trailer naming the standard security handler with an owner and user key no empty password opens.
function encryptedPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${'11'.repeat(32)}> /U <${'22'.repeat(32)}> /P -4 >>`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${'33'.repeat(16)}> <${'33'.repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const padTo = (pdf, size) => Buffer.concat([pdf, Buffer.alloc(size - pdf.length, 0x20)]);

async function main() {
  const { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
  const { recorderProvenance } = await import('./lib/provenance.mjs');
  const { exact } = await import('./lib/exact.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
  const home = mkdtempSync(join(tmpdir(), 'pdf-intake-'));
  for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = home;
  process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
  const PDFLib = createRequire(join(tree, 'package.json'))('pdf-lib');
  const { materializePromptSubmission, preparePromptSubmissionForProvider } = await import(pathToFileURL(join(tree, 'src/runtime/attachments/store.mjs')).href);
  const onePage = await pdfOf(PDFLib, 1);
  const cases = [
    ['size-at-limit', padTo(onePage, LIMIT), true],
    ['size-over-limit', padTo(onePage, LIMIT + 1), true],
    ['pages-100', await pdfOf(PDFLib, 100), true],
    ['pages-101', await pdfOf(PDFLib, 101), true],
    ['pages-101-text', await pdfOf(PDFLib, 101), false],
    ['encrypted', encryptedPdf(), true],
    ['damaged', Buffer.from('%PDF-1.7\nthis is not a document\n', 'latin1'), true],
    ['scanned-text-only', await pdfOf(PDFLib, 3, { text: false }), false],
  ];
  const finalDir = join(FIXTURES_ROOT, 'pdf-intake');
  const stage = stageSet(finalDir);
  for (const [name, bytes, nativePdf] of cases) {
    const prompt = [
      { type: 'text', text: 'read the attached document' },
      { type: 'file', mimeType: 'application/pdf', filename: `${name}.pdf`, data: bytes.toString('base64') },
    ];
    let answer;
    try {
      const intake = await preparePromptSubmissionForProvider(materializePromptSubmission(prompt, {}), { nativePdf });
      answer = { prompt: exact(intake.prompt) };
    } catch (error) {
      answer = { error: { name: error?.name ?? null, message: String(error?.message ?? error), code: error?.code ?? null } };
    }
    // The bytes are the case's own, recorded by digest and size (the 20 MiB ones would bloat the set); the replay
    // rebuilds them from this recording's PDFs.
    writeJson(join(stage, `${name}.json`), { scenario: name, nativePdf, pdfBase64: bytes.length > 1024 * 1024 ? null : bytes.toString('base64'), sizeBytes: bytes.length, padFrom: bytes.length > 1024 * 1024 ? onePage.toString('base64') : null, ...answer });
  }
  rmSync(home, { recursive: true, force: true });
  writeSetManifest(stage, {
    set: 'pdf-intake',
    recorder: RECORDER,
    command: `node ${RECORDER} --tree <b6f10295a export with node_modules>`,
    extra: { scenarios: cases.map(([name]) => name), ...recorderProvenance(import.meta.url) },
    identity,
  });
  commitStage(stage, finalDir);
  console.log('recorded pdf-intake');
}
await main();
