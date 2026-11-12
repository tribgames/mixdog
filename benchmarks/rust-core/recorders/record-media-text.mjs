#!/usr/bin/env node
// Attached-document text goldens (WP-EXTHOST `DocumentText`): the text Node's provider lowering gives
// an attached office file or PDF, from `officeTextForFile` and `extractPdfText` of
// media-normalization.mjs. Writes native/core/fixtures/tools/media-text/{office,pdf}.json without
// touching the rest of the set, then refreshes the set manifest.
//
//   node benchmarks/rust-core/recorders/record-media-text.mjs --tree <dir>
//
// Each case is the input (filename and base64 bytes) and the text Node produced, `null` where the
// file has no text form. A text too large to keep is recorded as its byte count, SHA-256 and last 80
// characters. The output is byte-stable: zip entries carry a fixed timestamp, the PDFs carry no
// metadata dates, the inputs are generated from constants, and keys are written sorted. The recorder
// builds every input twice and refuses to write if the two builds differ.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const need = createRequire(join(tree, 'package.json'));
const JSZip = need('jszip');
const { PDFDocument, StandardFonts } = need('pdf-lib');
const { extractPdfText, officeTextForFile } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/providers/media-normalization.mjs'
);
const { inspectPdfBuffer, PDF_INTAKE_TIMEOUT_MS } = await importFrom(tree, 'src/runtime/attachments/pdf-extract.mjs');
const { isEnvironmentError } = await importFrom(tree, 'src/runtime/shared/environment-error.mjs');

const outDir = join(FIXTURES_ROOT, 'tools', 'media-text');

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// A fixed timestamp for every entry. JSZip stamps the folder entries it creates implicitly with the
// current time, so none are created (the extractor reads files only).
const ZIP_DATE = new Date(Date.UTC(1980, 0, 1));
const zip = async (files) => {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    archive.file(name, content, { date: ZIP_DATE, createFolders: false });
  }
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
};

const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (text) => `<w:tc>${paragraph(text)}</w:tc>`;
const docxXml = (body) => `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}"><w:body>${body}</w:body></w:document>`;

// PDFs without a producer or dates, so the same pages are the same bytes.
const pdfBytes = async (lines) => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of lines) doc.addPage([400, 200]).drawText(line, { x: 20, y: 100, size: 20, font });
  return Buffer.from(await doc.save());
};

async function officeInputs() {
  return {
    'docx-paragraphs-and-table': {
      filename: 'report.docx',
      bytes: await zip({
        'word/document.xml': docxXml(
          paragraph('Quarterly report') +
            `<w:tbl><w:tr>${cell('item')}${cell('count')}</w:tr><w:tr>${cell('night shift')}${cell('12')}</w:tr></w:tbl>` +
            paragraph('End')
        ),
      }),
    },
    'xlsx-two-sheets': {
      filename: 'kpi.xlsx',
      bytes: await zip({
        'xl/workbook.xml':
          `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${RELATIONSHIP_NS}"><sheets>` +
          '<sheet name="Output" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels':
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
        'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="${SHEET_NS}"><si><t>hub</t></si><si><t>rate</t></si></sst>`,
        'xl/worksheets/sheet1.xml':
          `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData>` +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>north</t></is></c><c r="B2"><f>1+2</f><v>128400</v></c></row>' +
          '</sheetData></worksheet>',
        'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData/></worksheet>`,
      }),
    },
    'pptx-slides': {
      filename: 'deck.pptx',
      bytes: await zip({
        'ppt/slides/slide2.xml': `<?xml version="1.0"?><p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}" show="0"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Hidden page</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
        'ppt/slides/slide1.xml':
          `<?xml version="1.0"?><p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>` +
          '<p:sp><p:txBody><a:p><a:r><a:t>Hub overview</a:t></a:r></a:p></p:txBody></p:sp>' +
          '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 3" descr="night photo"/></p:nvPicPr></p:pic>' +
          '</p:spTree></p:cSld></p:sld>',
      }),
    },
    'format-from-the-package-when-the-name-says-nothing': {
      filename: 'attachment',
      bytes: await zip({ 'word/document.xml': docxXml(paragraph('Named by its parts')) }),
    },
    'not-a-zip': { filename: 'a.docx', bytes: Buffer.from('not a zip at all, just text bytes') },
    'legacy-ole-file': {
      filename: 'old.docx',
      bytes: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]),
    },
    'zip-without-a-document-part': { filename: 'b.docx', bytes: await zip({ 'other.txt': 'nothing here' }) },
    // The part inflates past the 8 MiB lowering cap, so it has no text form whatever it holds.
    'part-over-the-inflated-cap': {
      filename: 'huge.docx',
      bytes: await zip({ 'word/document.xml': docxXml(paragraph('x'.repeat(9 * 1024 * 1024))) }),
    },
    // The output cap: Korean paragraphs (3 bytes a character, so the 256 KiB cut lands inside one)
    // make a text far over it. The text itself is too large to keep; its size, hash and end are.
    'output-over-256kib-is-cut-and-marked': {
      filename: 'long.docx',
      digest: true,
      bytes: await zip({
        'word/document.xml': docxXml(Array.from({ length: 20000 }, (_, i) => paragraph(`문단 ${i} 번째 줄`)).join('')),
      }),
    },
    // The container cap: every part is within the 8 MiB part cap, but the parts the extractor reads
    // together inflate past 32 MiB.
    'container-over-the-inflated-cap': {
      filename: 'wide.docx',
      bytes: await zip({
        'word/document.xml': docxXml(paragraph('x'.repeat(7 * 1024 * 1024))),
        ...Object.fromEntries(
          [1, 2, 3, 4].map((n) => [`word/header${n}.xml`, docxXml(paragraph('y'.repeat(7 * 1024 * 1024)))])
        ),
      }),
    },
  };
}

async function pdfInputs() {
  // 100 pages of 3000 characters on a line, on pages wide enough to hold the line (text off the page is not read).
  const wide = async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 100; i += 1) {
      doc.addPage([10000, 200]).drawText(`p${i} ${'x'.repeat(2994)}`, { x: 20, y: 100, size: 4, font });
    }
    return Buffer.from(await doc.save());
  };
  return {
    'two-pages': { bytes: await pdfBytes(['Hello media text', 'Second page']) },
    'not-a-pdf': { bytes: Buffer.from('this is not a pdf') },
    'truncated-pdf': { bytes: (await pdfBytes(['Cut short'])).subarray(0, 120) },
    // The page limit: a PDF of 105 pages is read for its first 100 (a longer one is not refused).
    'pages-over-the-100-page-limit': {
      bytes: await pdfBytes(Array.from({ length: 105 }, (_, i) => `Body of page ${i + 1}`)),
    },
    // The output cap: 100 pages of 3000 characters are 300 KB of text, cut at 256 KiB and marked. The text
    // is too large to keep; its size, hash and end are.
    'output-over-256kib-is-cut-and-marked': { bytes: await wide(), digest: true },
  };
}

async function build() {
  const office = Object.entries(await officeInputs()).map(([name, { filename, bytes, digest }]) => {
    const dataBase64 = bytes.toString('base64');
    const text = officeTextForFile({ data: dataBase64, filename });
    if (!digest) return { name, filename, dataBase64, text };
    const utf8 = Buffer.from(text, 'utf8');
    return {
      name,
      filename,
      dataBase64,
      textBytes: utf8.length,
      textSha256: createHash('sha256').update(utf8).digest('hex'),
      textTail: text.slice(-80),
    };
  });
  const pdf = [];
  for (const [name, { bytes, digest }] of Object.entries(await pdfInputs())) {
    const dataBase64 = bytes.toString('base64');
    const text = await extractPdfText(dataBase64);
    if (!digest) {
      pdf.push({ name, dataBase64, text });
      continue;
    }
    const utf8 = Buffer.from(text, 'utf8');
    pdf.push({
      name,
      dataBase64,
      textBytes: utf8.length,
      textSha256: createHash('sha256').update(utf8).digest('hex'),
      textTail: text.slice(-80),
    });
  }
  // The intake's text-layer counts, as `preparePromptSubmissionForProvider` takes them; bytes the
  // parser rejects record the message Node's intake throws (`rejected`).
  const counts = [];
  for (const [name, bytes] of Object.entries(await countInputs())) {
    const dataBase64 = bytes.toString('base64');
    try {
      const { pageCount, textPages, textChars } = await inspectPdfBuffer(bytes, {
        maxPages: Infinity,
        measureText: true,
        timeoutMs: PDF_INTAKE_TIMEOUT_MS,
      });
      counts.push({ name, dataBase64, counts: { pageCount, textChars, textPages } });
    } catch (error) {
      if (error?.code === 'PDF_INSPECTION_TIMEOUT' || isEnvironmentError(error)) throw error;
      counts.push({ name, dataBase64, rejected: error instanceof Error ? error.message : String(error) });
    }
  }
  return { office, pdf, counts };
}

// Pages that are only a drawn rectangle, as a scan is only an image: no text layer.
const scannedPdf = async (pages) => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pages; i += 1) doc.addPage([400, 200]).drawRectangle({ x: 10, y: 10, width: 300, height: 100 });
  return Buffer.from(await doc.save());
};

async function countInputs() {
  const long = 'A text layer with plenty of readable characters';
  const mixed = await PDFDocument.create({ updateMetadata: false });
  const font = await mixed.embedFont(StandardFonts.Helvetica);
  mixed.addPage([400, 200]).drawText(long, { x: 10, y: 100, size: 10, font });
  mixed.addPage([400, 200]).drawText('p. 2', { x: 10, y: 100, size: 10, font }); // a stamped number only
  mixed.addPage([400, 200]).drawRectangle({ x: 10, y: 10, width: 300, height: 100 });
  return {
    'text-pdf': await pdfBytes([long, `${long}, second page`]),
    'scanned-pdf': await scannedPdf(3),
    'text-scan-and-stamped-page': Buffer.from(await mixed.save()),
    'unreadable-not-a-pdf': Buffer.from('this is not a pdf'),
    'unreadable-truncated': (await pdfBytes(['Cut short'])).subarray(0, 120),
  };
}

const { office, pdf, counts } = await build();
const again = await build();
const all = [...office, ...pdf, ...counts];
const other = [...again.office, ...again.pdf, ...again.counts];
const unstable = all.filter((c, i) => JSON.stringify(c) !== JSON.stringify(other[i]));
if (unstable.length) {
  const fields = unstable.map((c) => {
    const twin = other.find((o) => o.name === c.name);
    return `${c.name} [${Object.keys(c).filter((k) => c[k] !== twin[k]).join(',')}]`;
  });
  throw new Error(`not reproducible: ${fields.join('; ')}`);
}

const capped = office.find((c) => c.name === 'output-over-256kib-is-cut-and-marked');
if (!capped.textTail.endsWith('[office text truncated at 262144 bytes]')) throw new Error('the output cap did not apply');
if (office.find((c) => c.name === 'container-over-the-inflated-cap').text !== null) {
  throw new Error('the container cap did not apply');
}

const pdfCapped = pdf.find((c) => c.name === 'output-over-256kib-is-cut-and-marked');
if (!pdfCapped.textTail.endsWith('[PDF text truncated to the prompt input budget]')) throw new Error('the PDF output cap did not apply');
const pdfPaged = pdf.find((c) => c.name === 'pages-over-the-100-page-limit').text;
if (!pdfPaged.includes('Body of page 100') || pdfPaged.includes('page 101')) throw new Error('the PDF page limit did not apply');

writeJson(join(outDir, 'office.json'), office);
writeJson(join(outDir, 'pdf.json'), pdf);
writeJson(join(outDir, 'pdf-counts.json'), counts);
refreshSetManifest(join(FIXTURES_ROOT, 'tools'), tree);
console.log(`recorded ${office.length} office, ${pdf.length} pdf and ${counts.length} pdf-count cases`);
