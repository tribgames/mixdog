#!/usr/bin/env node
// OOXML text goldens (WP-EXTHOST `ooxml.text`, `media.officeText`): what Node's `attachments/office-extract.mjs` makes of
// an Office package, through the three entries the product calls, and what the lowering of an attached file
// (`officeTextForFile` of media-normalization.mjs) makes of the same bytes. Writes
// native/core/fixtures/ooxml-text/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-ooxml-text.mjs --tree <dir>
//
// Each case is the input (file name and base64 bytes), the options of the entries, and what each entry answered:
//   buffer  extractOoxmlTextFromBuffer(bytes, filename, { maxOutputBytes })        (the text or the `Error: ...` line)
//   file    extractOoxmlText(path, { maxOutputBytes }) on a file of that name        (absent when the name is empty)
//   try     tryExtractOoxmlTextFromBuffer(bytes, filename, limits)                  (`null` where the bytes have no text form)
//   lowered officeTextForFile({ data, filename })                                    (the fixed lowering limits)
// A text too large to keep is recorded as its byte count, SHA-256 and last 80 characters. The output is byte-stable: zip
// entries carry a fixed timestamp, the inputs are generated from constants, and keys are written sorted. The recorder
// builds every input twice and refuses to write if the two builds differ.
import { createHash } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, sha256, writeCanonicalJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

// `officeTextForFile` is module-private in the tree; the extension host's worker calls it through an export. The load
// hook appends that export to the module's source in memory, so the tree on disk is the exact recording tree.
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith('/providers/media-normalization.mjs')) return loaded;
    return { ...loaded, source: `${loaded.source}\nexport { officeTextForFile };\n` };
  },
});

const args = parseArgs();
const tree = resolveTree(args);
const JSZip = createRequire(join(tree, 'package.json'))('jszip');
const { extractOoxmlText, extractOoxmlTextFromBuffer, tryExtractOoxmlTextFromBuffer } = await importFrom(
  tree,
  'src/runtime/attachments/office-extract.mjs'
);
const { officeTextForFile } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/media-normalization.mjs');

const outDir = join(FIXTURES_ROOT, 'ooxml-text');
const NODE_MODULES_RECORDED = [
  'src/runtime/attachments/office-extract.mjs',
  'src/runtime/attachments/legacy-office.mjs',
  'src/runtime/attachments/limits.mjs',
  'src/runtime/shared/utf8-cut.mjs',
  'src/runtime/agent/orchestrator/providers/media-normalization.mjs',
];

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

// ---- containers ----

// A fixed timestamp for every entry; no folder entries are created (the extractor reads files only).
const ZIP_DATE = new Date(Date.UTC(1980, 0, 1));
async function zip(files, { store = [] } = {}) {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    archive.file(name, content, {
      date: ZIP_DATE,
      createFolders: false,
      compression: store.includes(name) ? 'STORE' : 'DEFLATE',
    });
  }
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
}

// A container written by hand, for the shapes JSZip does not produce: repeated names, a method that is neither stored nor
// deflate, sizes that disagree with the data, a comment after the end record.
function craft(entries, { eocdComment = Buffer.alloc(0), count } = {}) {
  const body = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.nameBytes ?? Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 8;
    const raw = entry.raw ?? (method === 8 ? deflateRawSync(Buffer.from(entry.data)) : Buffer.from(entry.data));
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(Buffer.byteLength(entry.data ?? ''), 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const extra = entry.extra ?? Buffer.alloc(0);
    const comment = entry.comment ?? Buffer.alloc(0);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(entry.compressedSize ?? raw.length, 20);
    head.writeUInt32LE(Buffer.byteLength(entry.data ?? ''), 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(extra.length, 30);
    head.writeUInt16LE(comment.length, 32);
    head.writeUInt32LE(entry.localOffset ?? offset, 42);
    central.push(head, name, extra, comment);
    body.push(local, name, localExtra, raw);
    offset += 30 + name.length + localExtra.length + raw.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count ?? entries.length, 8);
  end.writeUInt16LE(count ?? entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(eocdComment.length, 20);
  return Buffer.concat([...body, centralBytes, end, eocdComment]);
}

// ---- Word ----

const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (text) => `<w:tc>${paragraph(text)}</w:tc>`;
const row = (...cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
const docxXml = (body) => `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
const docxFiles = (body, extra = {}) => ({ 'word/document.xml': docxXml(body), ...extra });
const hiddenRun = (text, val = '') => `<w:r><w:rPr><w:vanish${val ? ` w:val="${val}"` : ''}/></w:rPr><w:t>${text}</w:t></w:r>`;
const plainRun = (text) => `<w:r><w:t>${text}</w:t></w:r>`;
const partXml = (root, body) => `<?xml version="1.0"?><w:${root} xmlns:w="${W}">${body}</w:${root}>`;
const picture = (descr) =>
  `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="${descr}"/><a:graphic><a:graphicData><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x"/></pic:nvPicPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

// ---- PowerPoint ----

const sld = (shapes, attrs = '') =>
  `<?xml version="1.0"?><p:sld xmlns:p="${PML}" xmlns:a="${DML}"${attrs}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
const shape = (text, { hidden = false, id = 2, placeholder = '' } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"${hidden ? ' hidden="1"' : ''}/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const slideRels = (target) =>
  `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="slide" Target="../slides/slide1.xml"/><Relationship Id="rId2" Type="notesSlide" Target="${target}"/></Relationships>`;
const notesPart = (...bodies) =>
  `<?xml version="1.0"?><p:notes xmlns:p="${PML}" xmlns:a="${DML}"><p:cSld><p:spTree>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>THUMBNAIL</a:t></a:r></a:p></p:txBody></p:sp>` +
  bodies.map((body, i) => shape(body, { id: 3 + i, placeholder: '<p:ph type="body" idx="1"/>' })).join('') +
  `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Number"/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld></p:notes>`;
const tableFrame = (rows) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl>${rows
    .map((r) => `<a:tr>${r.map((c) => `<a:tc><a:txBody><a:p><a:r><a:t>${c}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`)
    .join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const chartFrame = (hidden = false, descr = '') =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart"${descr ? ` descr="${descr}"` : ''}${hidden ? ' hidden="1"' : ''}/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="${CHART}"><c:chart xmlns:c="${CHART}" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`;
const diagramFrame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Diagram" descr="org chart &amp; roles"/></p:nvGraphicFramePr><a:graphic><a:graphicData><dgm:relIds xmlns:dgm="x" r:dm="rId1"/></a:graphicData></a:graphic></p:graphicFrame>`;
const pic = (descr, hidden = false) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 3"${descr ? ` descr="${descr}"` : ''}${hidden ? ' hidden="1"' : ''}/></p:nvPicPr></p:pic>`;

// ---- Excel ----

const strings = (...items) => `<?xml version="1.0"?><sst xmlns="${SML}">${items.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`;
const sheetXml = (rows, { cols = '' } = {}) =>
  `<?xml version="1.0"?><worksheet xmlns="${SML}">${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`;
const xrow = (n, cells, attrs = '') => `<row r="${n}"${attrs}>${cells}</row>`;
const c = (ref, value, { t = '', s = '', f = '' } = {}) =>
  `<c r="${ref}"${t ? ` t="${t}"` : ''}${s !== '' ? ` s="${s}"` : ''}>${f ? `<f>${f}</f>` : ''}${value === null ? '' : `<v>${value}</v>`}</c>`;
const inline = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const workbookXml = (sheets) =>
  `<?xml version="1.0"?><workbook xmlns="${SML}" xmlns:r="${REL}"><sheets>${sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="${s.rid ?? `rId${i + 1}`}"/>`)
    .join('')}</sheets></workbook>`;
const relsXml = (items) =>
  `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}">${items.map(([id, target, type = 'worksheet']) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`;
const stylesXml = (formats, customs = []) =>
  `<?xml version="1.0"?><styleSheet xmlns="${SML}">${customs.length ? `<numFmts count="${customs.length}">${customs.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`).join('')}</numFmts>` : ''}<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs><cellXfs count="${formats.length}">${formats.map((id) => `<xf numFmtId="${id}" fontId="0"/>`).join('')}</cellXfs></styleSheet>`;
// A workbook of sheets given as [name, xml, state?], with shared strings and styles as given.
async function workbook(sheets, { shared = null, styles = null, extra = {}, rels = null } = {}) {
  const files = {
    'xl/workbook.xml': workbookXml(sheets.map(([name, , state]) => ({ name, state }))),
    'xl/_rels/workbook.xml.rels': relsXml(rels ?? sheets.map((_, i) => [`rId${i + 1}`, `worksheets/sheet${i + 1}.xml`])),
    ...Object.fromEntries(sheets.map(([, xml], i) => [`xl/worksheets/sheet${i + 1}.xml`, xml])),
    ...extra,
  };
  if (shared) files['xl/sharedStrings.xml'] = shared;
  if (styles) files['xl/styles.xml'] = styles;
  return zip(files);
}

// ---- the cases ----

const KOREAN = Array.from({ length: 40 }, (_, i) => paragraph(`문단 ${i} 번째 줄`)).join('');
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);

async function inputs() {
  const cases = [];
  const add = (name, filename, bytes, options = {}) => cases.push({ name, filename, bytes, options });

  // -- docx --
  add('docx-paragraphs-and-table', 'report.docx', await zip(docxFiles(paragraph('Quarterly report') + `<w:tbl>${row('item', 'count')}${row('night shift', '12')}</w:tbl>` + paragraph('End'))));
  add('docx-empty-document', 'empty.docx', await zip(docxFiles('')));
  add('docx-tabs-and-breaks', 'tabs.docx', await zip(docxFiles(`<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>`)));
  add('docx-entities', 'entities.docx', await zip(docxFiles(paragraph('Tom &amp; Jerry &lt;b&gt; &quot;q&quot; &apos;a&apos; &#65;&#x42;&#x1F600; &amp;lt; &#38;lt;'))));
  add('docx-code-point-out-of-range', 'range.docx', await zip(docxFiles(paragraph('bad &#x110000; reference'))));
  add('docx-code-point-huge', 'huge.docx', await zip(docxFiles(paragraph('bad &#99999999999999999999999; reference'))));
  add('docx-text-with-attributes', 'attrs.docx', await zip(docxFiles(`<w:p><w:r><w:t xml:space="preserve"> kept </w:t></w:r></w:p><w:p><w:r><w:t   >spaced tag</w:t></w:r></w:p><w:p><w:r><w:tx>not text</w:tx></w:r></w:p>`)));
  add('docx-long-attribute-run-is-not-crossed', 'longattr.docx', await zip(docxFiles(`<w:p><w:r><w:t data="${'x'.repeat(5000)}">skipped</w:t></w:r></w:p>${paragraph('after')}`)));
  add('docx-hidden-runs', 'hidden.docx', await zip(docxFiles(`<w:p>${plainRun('visible ')}${hiddenRun('secret')}${plainRun(' tail')}</w:p>`)));
  add('docx-hidden-run-val-false-and-zero', 'hiddenval.docx', await zip(docxFiles(`<w:p>${hiddenRun('shown one', 'false')}${hiddenRun('shown two', '0')}${hiddenRun('hidden one', 'true')}${hiddenRun('hidden two', '1')}</w:p>`)));
  add('docx-hidden-passage-ends-at-paragraph', 'hiddenpar.docx', await zip(docxFiles(`<w:p>${hiddenRun('one')}${hiddenRun('two')}</w:p><w:p>${hiddenRun('three')}</w:p>${paragraph('plain')}`)));
  add('docx-hidden-run-without-text-is-not-marked', 'hiddennotext.docx', await zip(docxFiles(`<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:tab/></w:r>${plainRun('x')}</w:p>`)));
  add('docx-hidden-in-table-and-header', 'hiddentable.docx', await zip(docxFiles(`<w:tbl><w:tr><w:tc><w:p>${hiddenRun('h')}</w:p></w:tc><w:tc>${paragraph('v')}</w:tc></w:tr></w:tbl>`, { 'word/header1.xml': partXml('hdr', `<w:p>${plainRun('Mark ')}${hiddenRun('draft')}</w:p>`) })));
  add('docx-headers-and-footers', 'chrome.docx', await zip(docxFiles(paragraph('Body'), {
    'word/header1.xml': partXml('hdr', paragraph('CONFIDENTIAL') + paragraph('12')),
    'word/header2.xml': partXml('hdr', paragraph('CONFIDENTIAL') + paragraph('Doc 7')),
    'word/header10.xml': partXml('hdr', paragraph('First page')),
    'word/footer1.xml': partXml('ftr', paragraph('Page 3 of 9') + paragraph('1 / 9') + paragraph('— 4 —')),
    'word/footer2.xml': partXml('ftr', paragraph('Rev B')),
    'word/headerx.xml': partXml('hdr', paragraph('not a header part')),
  })));
  add('docx-footnotes-and-endnotes', 'notes.docx', await zip(docxFiles(
    `<w:p><w:r><w:t>Claim</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:t> and more</w:t></w:r><w:r><w:endnoteReference w:id="3"/></w:r><w:r><w:footnoteReference w:id="9"/></w:r></w:p>`,
    {
      'word/footnotes.xml': partXml('footnotes', `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t>---</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Source:</w:t></w:r></w:p><w:p><w:r><w:t>Annual report</w:t></w:r></w:p></w:footnote>`),
      'word/endnotes.xml': partXml('endnotes', `<w:endnote w:id="3"><w:p><w:r><w:t>End source</w:t></w:r></w:p></w:endnote><w:endnote w:id="3"><w:p><w:r><w:t>replaces the first</w:t></w:r></w:p></w:endnote>`),
    }
  )));
  add('docx-notes-without-parts', 'nonotes.docx', await zip(docxFiles(`<w:p><w:r><w:t>x</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`)));
  add('docx-comments-part-is-not-read', 'comments.docx', await zip(docxFiles(paragraph('Body'), { 'word/comments.xml': partXml('comments', `<w:comment w:id="0"><w:p><w:r><w:t>A reviewer remark</w:t></w:r></w:p></w:comment>`) })));
  add('docx-pictures-charts-and-diagrams', 'figures.docx', await zip(docxFiles(
    paragraph('Before') +
      `<w:p>${picture('A night photo &amp; a lamp')}</w:p>` +
      `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="2" name="Chart"/><a:graphic><a:graphicData uri="${CHART}"><c:chart xmlns:c="${CHART}" r:id="rId5"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` +
      `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="3" name="Diagram" descr="Flow"/><a:graphic><a:graphicData><dgm:relIds r:dm="rId1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` +
      paragraph('After')
  )));
  add('docx-text-box-in-drawing', 'textbox.docx', await zip(docxFiles(
    `<w:p><w:r><w:drawing><wp:anchor><wp:docPr id="1" name="Box" descr="callout"/><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent>${paragraph('Inside one')}${paragraph('Inside two')}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>${paragraph('Next')}`
  )));
  add('docx-unclosed-drawing-is-markup', 'unclosed.docx', await zip(docxFiles(`<w:p><w:r><w:drawing><wp:inline>${plainRun('kept')}</w:r></w:p>${paragraph('end')}`)));
  add('docx-table-cell-and-row-boundaries', 'cells.docx', await zip(docxFiles(`<w:tbl><w:tr><w:tc>${paragraph('a')}${paragraph('a2')}</w:tc><w:tc></w:tc><w:tc>${paragraph('c')}</w:tc></w:tr><w:tr><w:tc>${paragraph('d')}</w:tc></w:tr></w:tbl>${paragraph('after table')}`)));
  add('docx-blank-paragraph-runs-collapse', 'blank.docx', await zip(docxFiles('<w:p></w:p>'.repeat(8) + paragraph('x') + '<w:p></w:p>'.repeat(5))));
  add('docx-without-text-content', 'notext.docx', await zip(docxFiles(`<w:p><w:pPr/></w:p>`)));
  add('docx-stored-entry', 'stored.docx', await zip(docxFiles(paragraph('Stored, not deflated')), { store: ['word/document.xml'] }));
  add('docx-invalid-utf8', 'badutf8.docx', await zip({ 'word/document.xml': Buffer.concat([Buffer.from(`<w:document><w:body><w:p><w:r><w:t>ok `), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from(`</w:t></w:r></w:p></w:body></w:document>`)]) }));
  add('docx-two-parts-same-name-later-wins', 'dupe.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('first')) }, { name: 'word/document.xml', data: docxXml(paragraph('second')) }]));
  add('docx-local-header-lengths-differ-from-central', 'localextra.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('Extra field')), localExtra: Buffer.from('padpad'), extra: Buffer.from('x') }]));
  add('docx-end-record-comment', 'comment.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('Comment after EOCD')) }], { eocdComment: Buffer.from('trailing archive comment') }));
  add('docx-korean-body-and-chrome', 'korean.docx', await zip(docxFiles(KOREAN, { 'word/header1.xml': partXml('hdr', paragraph('기밀 문서')) })));
  add('docx-uppercase-extension', 'REPORT.DOCX', await zip(docxFiles(paragraph('upper'))));
  add('docx-extension-not-in-the-list-is-read-from-the-parts', 'macro.docm', await zip(docxFiles(paragraph('docm'))));
  add('docx-no-extension-is-read-from-the-parts', 'attachment', await zip(docxFiles(paragraph('Named by its parts'))));
  add('docx-empty-file-name', '', await zip(docxFiles(paragraph('no name at all'))));
  add('docx-extension-says-pptx-but-parts-are-word', 'wrong.pptx', await zip(docxFiles(paragraph('mislabelled'))));
  add('docx-missing-document-part', 'nodoc.docx', await zip({ 'other.txt': 'nothing here' }));
  // The output cap lands inside a three-byte character for the Korean body.
  for (const cap of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 40]) {
    add(`docx-output-cap-${cap}-bytes`, 'cap.docx', await zip(docxFiles(KOREAN)), { maxOutputBytes: cap });
  }
  add('docx-output-cap-above-the-text', 'wide.docx', await zip(docxFiles(KOREAN)), { maxOutputBytes: 100000 });
  add('docx-output-cap-default-cuts-a-long-body', 'long.docx', await zip(docxFiles(Array.from({ length: 6000 }, (_, i) => paragraph(`문단 ${i} 번째 줄`)).join(''))), {});

  // -- pptx --
  add('pptx-slides-out-of-file-order', 'deck.pptx', await zip({
    'ppt/slides/slide10.xml': sld(shape('Ten')),
    'ppt/slides/slide2.xml': sld(shape('Two')),
    'ppt/slides/slide1.xml': sld(shape('One')),
    'ppt/slides/slide02.xml': sld(shape('Zero two')),
  }));
  add('pptx-hidden-slide', 'hidden.pptx', await zip({ 'ppt/slides/slide1.xml': sld(shape('Shown')), 'ppt/slides/slide2.xml': sld(shape('Gone'), ' show="0"') }));
  add('pptx-hidden-shapes', 'shapes.pptx', await zip({ 'ppt/slides/slide1.xml': sld(shape('Visible', { id: 2 }) + shape('Superseded draft', { id: 3, hidden: true }) + pic('production &amp; note', true) + pic('', true) + chartFrame(true) + tableFrame([['a', 'b']]).replace('<p:cNvPr id="4"', '<p:cNvPr hidden="true" id="4"')) }));
  add('pptx-hidden-shape-with-markup-characters', 'markup.pptx', await zip({ 'ppt/slides/slide1.xml': sld(shape('1 &lt; 2 &amp; 3', { hidden: true })) }));
  add('pptx-unclosed-hidden-shape', 'unclosedshape.pptx', await zip({ 'ppt/slides/slide1.xml': sld(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="x" hidden="1"/></p:nvSpPr>${shape('after')}`) }));
  add('pptx-grouped-shapes', 'group.pptx', await zip({ 'ppt/slides/slide1.xml': sld(`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/></p:nvGrpSpPr>${shape('Inner one', { id: 10 })}<p:grpSp>${shape('Nested', { id: 11 })}</p:grpSp></p:grpSp>${shape('Outer', { id: 12 })}`) }));
  add('pptx-notes-through-the-relationship', 'notes.pptx', await zip({
    'ppt/slides/slide1.xml': sld(shape('Slide text')),
    'ppt/slides/_rels/slide1.xml.rels': slideRels('../notesSlides/notesSlide1.xml'),
    'ppt/notesSlides/notesSlide1.xml': notesPart('First line', 'Second line'),
  }));
  add('pptx-notes-missing-part', 'nonotes.pptx', await zip({ 'ppt/slides/slide1.xml': sld(shape('Slide text')), 'ppt/slides/_rels/slide1.xml.rels': slideRels('../notesSlides/notesSlide9.xml') }));
  add('pptx-notes-without-body-placeholder', 'emptynotes.pptx', await zip({ 'ppt/slides/slide1.xml': sld(shape('Slide text')), 'ppt/slides/_rels/slide1.xml.rels': slideRels('notesSlide1.xml'), 'ppt/notesSlide1.xml': notesPart() }));
  add('pptx-relationship-without-notes-target', 'othrels.pptx', await zip({ 'ppt/slides/slide1.xml': sld(shape('Slide text')), 'ppt/slides/_rels/slide1.xml.rels': slideRels('../slideLayouts/slideLayout1.xml') }));
  add('pptx-table', 'table.pptx', await zip({ 'ppt/slides/slide1.xml': sld(shape('Title') + tableFrame([['h1', 'h2'], ['v1', 'v2']]) + shape('Footer')) }));
  add('pptx-chart-and-diagram-frames', 'frames.pptx', await zip({ 'ppt/slides/slide1.xml': sld(chartFrame(false, 'Sales by hub') + diagramFrame + shape('after')) }));
  add('pptx-pictures', 'pictures.pptx', await zip({ 'ppt/slides/slide1.xml': sld(pic('night photo') + pic('') + shape('caption')) }));
  add('pptx-line-breaks-and-tabs', 'breaks.pptx', await zip({ 'ppt/slides/slide1.xml': sld(`<p:sp><p:txBody><a:p><a:r><a:t>a</a:t></a:r><a:br/><a:r><a:t>b</a:t></a:r></a:p><a:p><a:r><a:t>c</a:t></a:r></a:p></p:txBody></p:sp>`) }));
  add('pptx-slide-without-text', 'empty.pptx', await zip({ 'ppt/slides/slide1.xml': sld('') }));
  add('pptx-slide-numbers-past-safe-integers', 'big.pptx', await zip({ 'ppt/slides/slide99999999999999999999999.xml': sld(shape('Huge')), 'ppt/slides/slide3.xml': sld(shape('Three')) }));
  add('pptx-no-slide-parts', 'noslides.pptx', await zip({ 'ppt/presentation.xml': '<p:presentation/>' }));
  add('pptx-no-extension-no-known-part-falls-to-slides', 'attachment', await zip({ 'ppt/slides/slide1.xml': sld(shape('Named by default')) }));
  add('pptx-output-cap', 'cap.pptx', await zip({ 'ppt/slides/slide1.xml': sld(shape('가'.repeat(200))), 'ppt/slides/slide2.xml': sld(shape('나'.repeat(200))) }), { maxOutputBytes: 100 });
  add('pptx-slide-name-not-a-slide', 'slides.pptx', await zip({ 'ppt/slides/slide1a.xml': sld(shape('skip')), 'ppt/slides/slide.xml': sld(shape('skip')), 'ppt/slides/slide7.xml': sld(shape('seven')) }));

  // -- xlsx --
  const sharedWords = strings('hub', 'rate', 'north &amp; south', '', '<b>');
  add('xlsx-shared-and-inline-strings', 'kpi.xlsx', await workbook([['Output', sheetXml(xrow(1, c('A1', 0, { t: 's' }) + c('B1', 1, { t: 's' })) + xrow(2, inline('A2', 'north') + c('B2', '128400', { f: '1+2' })))], ['Notes', sheetXml('')]], { shared: sharedWords }));
  add('xlsx-shared-string-indexes', 'indexes.xlsx', await workbook([['S', sheetXml(xrow(1, [0, 2, 3, 99, -1, 1.5, '0x1', '', ' 1 ', '1e0', ' '].map((v, i) => c(`${String.fromCharCode(65 + i)}1`, v, { t: 's' })).join('')))]], { shared: sharedWords }));
  add('xlsx-inline-rich-strings', 'rich.xlsx', await workbook([['S', sheetXml(xrow(1, `<c r="A1" t="inlineStr"><is><r><t>bold </t></r><r><t>plain &amp; more</t></r></is></c>${c('B1', 'text', { t: 'str', f: 'A1' })}`))]]));
  add('xlsx-cell-types', 'types.xlsx', await workbook([['T', sheetXml(xrow(1, c('A1', '1', { t: 'b' }) + c('B1', '#DIV/0!', { t: 'e' }) + c('C1', '2026-10-15T00:00:00Z', { t: 'd' }) + c('D1', 'cached &amp; text', { t: 'str', f: 'A1&amp;B1' }) + c('E1', null) + c('F1', '', {})))]]));
  add('xlsx-values-are-entity-decoded', 'entities.xlsx', await workbook([['E', sheetXml(xrow(1, c('A1', '1 &lt; 2 &amp; &#65;')))]]));
  add('xlsx-columns-fill-gaps-and-clamp', 'columns.xlsx', await workbook([['C', sheetXml(xrow(1, c('A1', 'a') + c('C1', 'c') + c('AA1', 'aa') + c('b1', 'lower') + `<c><v>no-ref</v></c>`) + xrow(2, c('B2', 'x') + c('B2', 'overwritten')) + xrow(3, c('A3', 'x') + c('ßA3', 'sharp') + c('1', 'digits')))]]));
  add('xlsx-far-right-column-clamps-to-xfd', 'xfd.xlsx', await workbook([['C', sheetXml(xrow(1, c('XFD1', 'last') + c('XFE1', 'beyond') + c('ZZZZZZ1', 'far'))) ]]));
  add('xlsx-trailing-empty-cells-and-rows-are-dropped', 'trailing.xlsx', await workbook([['C', sheetXml(xrow(1, c('A1', 'a') + c('B1', '') + c('C1', '')) + xrow(2, '') + xrow(3, c('A3', 'b')) + xrow(4, '') + xrow(5, c('A5', '')))]]));
  add('xlsx-self-closing-rows-and-cells', 'selfclosing.xlsx', await workbook([['C', `<?xml version="1.0"?><worksheet xmlns="${SML}"><sheetData><row r="1"/><row r="2"><c r="A2"/><c r="B2"><v>1</v></c></row></sheetData></worksheet>`]]));
  add('xlsx-hidden-rows', 'hiddenrows.xlsx', await workbook([['C', sheetXml(xrow(1, c('A1', 'head')) + xrow(2, c('A2', 'secret'), ' hidden="1"') + xrow(3, c('A3', 'secret2'), ' hidden="true"') + xrow(4, '', ' hidden="1"') + xrow(5, c('A5', 'shown'), ' hidden="0"'))]]));
  add('xlsx-hidden-columns', 'hiddencols.xlsx', await workbook([['C', sheetXml(xrow(1, c('A1', 'id') + c('B1', ' cost ') + c('C1', 'note') + c('D1', '')) + xrow(2, c('A2', '1') + c('B2', '2')), { cols: '<col min="2" max="3" hidden="1"/><col min="4" max="4" hidden="true"/><col min="5" max="5" hidden="0"/><col min="10" max="200" hidden="1"/><col max="9" hidden="1"/><col min="0" max="1" hidden="1"/>' })]]));
  add('xlsx-hidden-header-row-label', 'hiddenheader.xlsx', await workbook([['C', sheetXml(xrow(1, c('A1', 'secret') + c('B1', 'cost'), ' hidden="1"') + xrow(2, c('A2', '1')), { cols: '<col min="1" max="2" hidden="1"/>' })]]));
  add('xlsx-hidden-and-very-hidden-sheets', 'states.xlsx', await workbook([['Shown', sheetXml(xrow(1, c('A1', 'a')))], ['Hid', sheetXml(xrow(1, c('A1', 'b'))), 'hidden'], ['Very', sheetXml(xrow(1, c('A1', 'c'))), 'veryHidden'], ['Mixed', sheetXml(xrow(1, c('A1', 'd'))), 'HIDDEN'], ['Odd', sheetXml(xrow(1, c('A1', 'e'))), 'visible'], ['Ctor', sheetXml(xrow(1, c('A1', 'f'))), 'constructor'], ['Proto', sheetXml(xrow(1, c('A1', 'g'))), '__proto__']]));
  add('xlsx-sheet-name-entities', 'names.xlsx', await workbook([['Q&amp;A &lt;1&gt;', sheetXml(xrow(1, c('A1', 'a')))]]));
  add('xlsx-sheet-part-missing', 'missing.xlsx', await zip({ 'xl/workbook.xml': workbookXml([{ name: 'Gone' }, { name: 'NoRel', rid: 'rId7' }, { name: 'Here' }]), 'xl/_rels/workbook.xml.rels': relsXml([['rId1', 'worksheets/none.xml'], ['rId3', 'worksheets/sheet3.xml']]), 'xl/worksheets/sheet3.xml': sheetXml(xrow(1, c('A1', 'here'))) }));
  add('xlsx-no-sheets', 'nosheets.xlsx', await zip({ 'xl/workbook.xml': workbookXml([]) }));
  add('xlsx-no-workbook-part', 'noworkbook.xlsx', await zip({ 'other.xml': '<x/>' }));
  add('xlsx-empty-sheet', 'emptysheet.xlsx', await workbook([['E', sheetXml('')]]));
  for (const [i, target] of ['/xl/worksheets/sheet1.xml', 'worksheets/sheet1.xml', './worksheets/sheet1.xml', 'xl/worksheets/sheet1.xml'].entries()) {
    add(`xlsx-relationship-target-form-${i + 1}`, 'rel.xlsx', await workbook([['S', sheetXml(xrow(1, c('A1', `form ${i + 1}`)))]], { rels: [['rId1', target]] }));
  }
  add('xlsx-relationship-attribute-order-and-extra', 'relorder.xlsx', await zip({
    'xl/workbook.xml': workbookXml([{ name: 'S' }]),
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}"><Relationship Target="worksheets/sheet1.xml" Type="worksheet" Id="rId1"></Relationship><Relationship Id="rId2"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheetXml(xrow(1, c('A1', 'reordered'))),
  }));
  add('xlsx-xlsm-extension', 'macro.xlsm', await workbook([['S', sheetXml(xrow(1, c('A1', 'macro')))]]));
  add('xlsx-no-extension-is-read-from-the-parts', 'attachment', await workbook([['S', sheetXml(xrow(1, c('A1', 'by parts')))]]));
  add('xlsx-extension-says-docx-but-parts-are-excel', 'wrong.docx', await workbook([['S', sheetXml(xrow(1, c('A1', 'mislabelled')))]]));

  // number formats
  const formatIds = [0, 1, 2, 9, 10, 14, 15, 16, 17, 18, 19, 20, 21, 22, 37, 45, 46, 47, 49];
  for (const id of formatIds) {
    add(`xlsx-builtin-format-${id}`, 'fmt.xlsx', await workbook([['F', sheetXml(xrow(1, c('A1', '45123.7525', { s: 0 }) + c('B1', '0.928', { s: 0 }) + c('C1', '1', { s: 0 }) + c('D1', '-3.5', { s: 0 })))]], { styles: stylesXml([id]) }));
  }
  const customs = [
    [164, '0.000%'], [165, '0.0%;[Red]-0.0%'], [166, '&quot;day&quot; 0'], [167, '\\d 0.0'], [168, '[$-409]m/d/yyyy'], [169, '[h]:mm:ss'], [170, 'General'],
    [171, 'hh:mm:ss.000'], [172, 'yyyy-mm-dd hh:mm'], [173, '&quot;y&quot;0%'], [174, '#,##0.00'], [175, '0.00E+00'], [176, 'mmm d, yyyy'],
    [178, '0.' + '0'.repeat(100) + '%'], [179, 'd/m/y'], [180, '[Red]0'], [181, '@'], [182, '0\\%'], [14, 'yyyy/mm/dd'], [183, ''],
  ];
  const customStyles = customs.map(([id]) => id);
  for (const [value, label] of [['45123.7525', 'serial'], ['0.928', 'fraction'], ['1', 'one'], ['-1', 'negative'], ['2958466', 'past-9999'], ['1e12', 'beyond-the-date-range'], ['abc', 'text'], ['', 'empty'], ['NaN', 'nan'], ['0x10', 'hex'], ['  45123  ', 'padded'], ['1e3', 'exponent'], ['12345678901234567890', 'long'], ['-0.0004', 'tiny-negative']]) {
    const cells = customs.map(([id], i) => c(`${columnLetter(i + 1)}1`, value, { s: i })).join('');
    add(`xlsx-custom-formats-on-${label}`, 'custom.xlsx', await workbook([['F', sheetXml(xrow(1, cells))]], { styles: stylesXml(customStyles, customs) }));
  }
  for (const decimals of [100, 101]) {
    add(`xlsx-percent-with-${decimals}-decimals`, 'decimals.xlsx', await workbook([['F', sheetXml(xrow(1, c('A1', '0.5', { s: 0 })))]], { styles: stylesXml([164], [[164, `0.${'0'.repeat(decimals)}%`]]) }));
  }
  add('xlsx-style-index-out-of-range-or-odd', 'badstyle.xlsx', await workbook([['F', sheetXml(xrow(1, c('A1', '45123', { s: 5 }) + c('B1', '45123', { s: 99999999999999999999 }) + `<c r="C1" s="x"><v>45123</v></c>` + `<c r="D1" s="-1"><v>45123</v></c>`))]], { styles: stylesXml([14]) }));
  add('xlsx-no-styles-part', 'nostyles.xlsx', await workbook([['F', sheetXml(xrow(1, c('A1', '45123', { s: 0 })))]]));
  add('xlsx-custom-format-id-overrides-builtin', 'override.xlsx', await workbook([['F', sheetXml(xrow(1, c('A1', '45123.5', { s: 0 }) + c('B1', '45123.5', { s: 1 })))]], { styles: stylesXml([14, 14], [[14, '0%']]) }));

  // charts and drawings
  const drawingSheet = (anchors) => ({
    'xl/drawings/drawing1.xml': `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${DML}" xmlns:c="${CHART}" xmlns:r="${REL}">${anchors}</xdr:wsDr>`,
    'xl/drawings/_rels/drawing1.xml.rels': relsXml([['rId1', '../charts/chart1.xml', 'chart'], ['rId2', '/xl/charts/chart2.xml', 'chart'], ['rId3', '../media/image1.png', 'image'], ['rId4', '../charts/missing.xml', 'chart']]),
    'xl/worksheets/_rels/sheet1.xml.rels': relsXml([['rId1', '../drawings/drawing1.xml', 'drawing']]),
    'xl/charts/chart1.xml': `<?xml version="1.0"?><c:chartSpace xmlns:c="${CHART}" xmlns:a="${DML}"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue &amp; cost</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>`,
    'xl/charts/chart2.xml': `<?xml version="1.0"?><c:chartSpace xmlns:c="${CHART}"><c:chart><c:plotArea/></c:chart></c:chartSpace>`,
  });
  const chartAnchor = (tag, rid) => `<xdr:${tag}><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart"/></xdr:nvGraphicFramePr><a:graphic><a:graphicData><c:chart r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:${tag}>`;
  const picAnchor = (tag, descr) => `<xdr:${tag}><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Pic"${descr ? ` descr="${descr}"` : ''}/></xdr:nvPicPr></xdr:pic></xdr:${tag}>`;
  add('xlsx-charts-and-pictures-after-the-grid', 'dash.xlsx', await workbook([['D', sheetXml(xrow(1, c('A1', 'grid')))]], { extra: drawingSheet(chartAnchor('twoCellAnchor', 'rId1') + picAnchor('oneCellAnchor', 'logo &amp; mark') + chartAnchor('absoluteAnchor', 'rId2') + picAnchor('twoCellAnchor', '') + chartAnchor('oneCellAnchor', 'rId4') + chartAnchor('twoCellAnchor', 'rId9') + `<xdr:twoCellAnchor/>`) }));
  add('xlsx-dashboard-sheet-without-cells', 'dashonly.xlsx', await workbook([['D', sheetXml('')]], { extra: drawingSheet(chartAnchor('twoCellAnchor', 'rId1')) }));
  add('xlsx-drawing-part-missing', 'nodrawing.xlsx', await workbook([['D', sheetXml(xrow(1, c('A1', 'x')))]], { extra: { 'xl/worksheets/_rels/sheet1.xml.rels': relsXml([['rId1', '../drawings/drawing1.xml', 'drawing']]) } }));
  add('xlsx-sheet-relationship-not-a-drawing', 'otherrel.xlsx', await workbook([['D', sheetXml(xrow(1, c('A1', 'x')))]], { extra: { 'xl/worksheets/_rels/sheet1.xml.rels': relsXml([['rId1', '../comments1.xml', 'comments']]) } }));

  // limits of the grid
  add('xlsx-more-than-5000-rows', 'many.xlsx', await workbook([['M', sheetXml(Array.from({ length: 5100 }, (_, i) => xrow(i + 1, c(`A${i + 1}`, i + 1))).join(''))]]));
  add('xlsx-exactly-5000-rows', 'exact.xlsx', await workbook([['M', sheetXml(Array.from({ length: 5000 }, (_, i) => xrow(i + 1, c(`A${i + 1}`, i + 1))).join(''))]]));
  add('xlsx-wide-cells-stop-the-grid-early', 'wide.xlsx', await workbook([['W', sheetXml(Array.from({ length: 300 }, (_, i) => xrow(i + 1, c(`XFD${i + 1}`, 'v'))).join(''))], ['After', sheetXml(xrow(1, c('A1', 'never read')))]]));
  add('xlsx-output-cap-cuts-in-the-second-sheet', 'twosheets.xlsx', await workbook([['One', sheetXml(Array.from({ length: 40 }, (_, i) => xrow(i + 1, inline(`A${i + 1}`, '가나다라마바사'))).join(''))], ['Two', sheetXml(xrow(1, c('A1', 'x')))]]), { maxOutputBytes: 200 });
  add('xlsx-output-cap-skips-sheets-past-the-cap', 'threesheets.xlsx', await workbook([['One', sheetXml(Array.from({ length: 30 }, (_, i) => xrow(i + 1, c(`A${i + 1}`, 'abcdefghij'))).join(''))], ['Two', sheetXml(xrow(1, c('A1', 'second')))], ['Three', sheetXml(xrow(1, c('A1', 'third')))]]), { maxOutputBytes: 120 });
  add('xlsx-output-cap-multibyte-header-labels', 'korean.xlsx', await workbook([['시트', sheetXml(xrow(1, inline('A1', '이름') + inline('B1', '값')) + xrow(2, inline('A2', '가') + c('B2', '1')), { cols: '<col min="2" max="2" hidden="1"/>' })]]), { maxOutputBytes: 40 });
  add('xlsx-lowering-input-over-the-output-cap', 'lowering.xlsx', await workbook([['L', sheetXml(Array.from({ length: 4000 }, (_, i) => xrow(i + 1, inline(`A${i + 1}`, `행 ${i} 번째 값입니다`))).join(''))]]));

  // -- containers that fail --
  add('zip-not-a-zip', 'a.docx', Buffer.from('not a zip at all, just text bytes'));
  add('zip-empty-buffer', 'a.docx', Buffer.alloc(0));
  add('zip-shorter-than-an-end-record', 'a.xlsx', Buffer.from('PK\x05\x06'));
  add('zip-ole-file-named-docx', 'old.docx', OLE);
  add('zip-ole-file-named-doc', 'old.doc', OLE);
  add('zip-ole-file-named-xls', 'old.xls', OLE);
  add('zip-ole-file-named-ppt', 'old.ppt', OLE);
  add('zip-ole-signature-only', 'sig.xlsx', OLE.subarray(0, 8));
  add('zip-ole-signature-too-short', 'sig.xlsx', OLE.subarray(0, 7));
  const good = await zip(docxFiles(paragraph('Truncated body that is long enough to deflate') + KOREAN));
  add('zip-truncated-before-the-end-record', 'cut.docx', good.subarray(0, good.length - 30));
  add('zip-truncated-to-the-local-header', 'cut2.docx', good.subarray(0, 40));
  add('zip-trailing-garbage-after-the-end-record', 'garbage.docx', Buffer.concat([good, Buffer.from('garbage')]));
  add('zip-leading-garbage-shifts-the-offsets', 'lead.docx', Buffer.concat([Buffer.from('junk'), good]));
  add('zip-end-record-with-count-beyond-the-directory', 'count.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('only entry')) }], { count: 9 }));
  add('zip-end-record-with-count-zero', 'zero.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('hidden by count')) }], { count: 0 }));
  add('zip-local-offset-outside-the-buffer', 'offset.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('x')), localOffset: 999999 }]));
  add('zip-local-signature-wrong', 'sig.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('x')), localOffset: 1 }]));
  add('zip-compressed-size-beyond-the-buffer', 'size.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('size lies')), compressedSize: 4000000 }]));
  add('zip-unsupported-method', 'method.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('bzip')), method: 12 }]));
  add('zip-deflate-invalid-block', 'block.docx', craft([{ name: 'word/document.xml', data: 'x', method: 8, raw: Buffer.from([0x07, 0x01, 0x02, 0x03]) }]));
  add('zip-deflate-stored-block-lengths', 'lengths.docx', craft([{ name: 'word/document.xml', data: 'x', method: 8, raw: Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00]) }]));
  add('zip-deflate-truncated-stream', 'short.docx', craft([{ name: 'word/document.xml', data: 'x', method: 8, raw: deflateRawSync(Buffer.from(docxXml(KOREAN))).subarray(0, 40) }]));
  add('zip-deflate-empty-data', 'nodata.docx', craft([{ name: 'word/document.xml', data: 'x', method: 8, raw: Buffer.alloc(0) }]));
  add('zip-deflate-data-with-trailing-bytes', 'tail.docx', craft([{ name: 'word/document.xml', data: 'x', method: 8, raw: Buffer.concat([deflateRawSync(Buffer.from(docxXml(paragraph('tail ignored')))), Buffer.from('trailing')]) }]));
  add('zip-entry-name-invalid-utf8', 'name.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('named')) }, { name: 'x', nameBytes: Buffer.from([0x61, 0xff, 0x62]), data: 'x' }]));
  add('zip-stored-entry-with-short-data', 'stored.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('stored by hand')), method: 0 }]));

  // -- limits --
  const zeros = (mib) => Buffer.alloc(mib * 1024 * 1024, 0x20);
  add('limit-part-over-the-part-cap', 'bomb.docx', await zip(docxFiles(`<w:p><w:r><w:t>${zeros(33).toString('latin1')}</w:t></w:r></w:p>`)));
  const edgeHead = Buffer.from('<w:p><w:r><w:t>x</w:t></w:r></w:p>');
  add('limit-part-at-the-part-cap-is-read', 'edge.docx', craft([{ name: 'word/document.xml', data: Buffer.concat([edgeHead, Buffer.alloc(32 * 1024 * 1024 - edgeHead.length, 0x20)]) }]));
  add('limit-part-one-byte-over-the-part-cap', 'edge1.docx', craft([{ name: 'word/document.xml', data: Buffer.concat([edgeHead, Buffer.alloc(32 * 1024 * 1024 - edgeHead.length + 1, 0x20)]) }]));
  add('limit-container-over-the-container-cap', 'wide.docx', await zip(docxFiles(paragraph('y'.repeat(2 * 1024 * 1024)), Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`word/header${n}.xml`, partXml('hdr', `<w:p><w:r><w:t>${'z'.repeat(30 * 1024 * 1024)}</w:t></w:r></w:p>`)])))));
  add('limit-lowering-part-cap-8mib', 'huge.docx', await zip(docxFiles(paragraph('x'.repeat(9 * 1024 * 1024)))), {});
  add('limit-lowering-container-cap-32mib', 'wide.docx', await zip(docxFiles(paragraph('x'.repeat(7 * 1024 * 1024)), Object.fromEntries([1, 2, 3, 4].map((n) => [`word/header${n}.xml`, partXml('hdr', paragraph('y'.repeat(7 * 1024 * 1024)))])))));
  add('limit-caller-part-cap', 'cap.docx', await zip(docxFiles(paragraph('x'.repeat(3000)))), { maxPartBytes: 2000 });
  add('limit-caller-part-cap-met-exactly', 'exact.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('x'.repeat(100))) }]), { maxPartBytes: docxXml(paragraph('x'.repeat(100))).length });
  add('limit-caller-part-cap-one-byte-short', 'short.docx', craft([{ name: 'word/document.xml', data: docxXml(paragraph('x'.repeat(100))) }]), { maxPartBytes: docxXml(paragraph('x'.repeat(100))).length - 1 });
  add('limit-caller-container-cap', 'cont.docx', await zip(docxFiles(paragraph('a'.repeat(1500)), { 'word/header1.xml': partXml('hdr', paragraph('b'.repeat(1500))) })), { maxContainerBytes: 2500 });
  add('limit-caller-caps-leave-a-stored-part-alone-in-the-budget', 'storedcap.docx', await zip(docxFiles(paragraph('s'.repeat(400)), { 'word/header1.xml': partXml('hdr', paragraph('h'.repeat(400))), 'word/header2.xml': partXml('hdr', paragraph('g'.repeat(900))) }), { store: ['word/header2.xml'] }), { maxContainerBytes: 1500 });
  add('limit-caller-caps-larger-than-the-built-in-ones', 'bigcaps.docx', await zip(docxFiles(paragraph('z'.repeat(100)))), { maxPartBytes: 1e12, maxContainerBytes: 1e12 });
  add('limit-caller-output-cap-zero-bytes-for-an-error', 'errcap.docx', Buffer.from('not a zip'), { maxOutputBytes: 0 });
  return cases;
}

function columnLetter(index) {
  let name = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// ---- recording ----

// A text too large to keep is recorded as its size, hash and end.
const KEEP_BYTES = 20000;
function keep(value) {
  if (typeof value !== 'string') return value;
  const utf8 = Buffer.from(value, 'utf8');
  if (utf8.length <= KEEP_BYTES) return value;
  return { bytes: utf8.length, sha256: createHash('sha256').update(utf8).digest('hex'), tail: Array.from(value).slice(-80).join('') };
}

function record(input, scratch) {
  const { name, filename, bytes, options } = input;
  const maxOutputBytes = options.maxOutputBytes ?? 100 * 1024;
  const limits = { maxOutputBytes, maxPartBytes: options.maxPartBytes ?? 0, maxContainerBytes: options.maxContainerBytes ?? 0 };
  const dataBase64 = bytes.toString('base64');
  const answer = {
    name,
    filename,
    dataBase64,
    options: { maxContainerBytes: limits.maxContainerBytes, maxOutputBytes, maxPartBytes: limits.maxPartBytes },
    buffer: keep(extractOoxmlTextFromBuffer(bytes, filename, { maxOutputBytes })),
    try: keep(tryExtractOoxmlTextFromBuffer(bytes, filename, limits)),
    lowered: keep(officeTextForFile({ data: dataBase64, filename })),
  };
  if (filename) {
    const path = join(scratch, filename);
    writeFileSync(path, bytes);
    answer.file = null; // set below, once the file exists
    return { answer, path, maxOutputBytes };
  }
  return { answer };
}

async function build() {
  const scratch = mkdtempSync(join(tmpdir(), 'mixdog-ooxml-text-'));
  try {
    const out = [];
    for (const input of await inputs()) {
      const { answer, path, maxOutputBytes } = record(input, scratch);
      if (path) answer.file = keep(await extractOoxmlText(path, { maxOutputBytes }));
      else delete answer.file;
      out.push(answer);
    }
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const cases = await build();
const again = await build();
const unstable = cases.filter((entry, i) => JSON.stringify(entry) !== JSON.stringify(again[i]));
if (unstable.length || cases.length !== again.length) {
  throw new Error(`not reproducible: ${unstable.map((entry) => entry.name).join(', ')}`);
}
const names = new Set(cases.map((entry) => entry.name));
if (names.size !== cases.length) throw new Error('two cases share a name');
if (cases.length < 120) throw new Error(`only ${cases.length} cases`);
const byName = new Map(cases.map((entry) => [entry.name, entry]));
// Facts the recording must show, so a drifted input cannot silently record nothing.
const expectText = (name, key, test, what) => {
  const value = byName.get(name)?.[key];
  if (!(typeof value === 'string' ? test(value) : false)) throw new Error(`${name}.${key}: ${what}`);
};
expectText('docx-hidden-runs', 'buffer', (t) => t.includes('[hidden: secret]'), 'the hidden run is marked');
expectText('docx-footnotes-and-endnotes', 'buffer', (t) => t.includes('--- notes ---') && t.includes('(note text missing)'), 'notes are listed');
expectText('docx-headers-and-footers', 'buffer', (t) => t.includes('--- header ---') && t.includes('--- footer ---'), 'chrome is listed');
expectText('pptx-hidden-slide', 'buffer', (t) => t.includes('slide 2 (hidden)'), 'a hidden slide is named');
expectText('pptx-notes-through-the-relationship', 'buffer', (t) => t.includes('[notes] First line'), 'notes follow the slide');
expectText('xlsx-hidden-columns', 'buffer', (t) => t.includes('[hidden columns:'), 'hidden columns are named');
expectText('xlsx-charts-and-pictures-after-the-grid', 'buffer', (t) => t.includes('[chart: Revenue & cost]'), 'a chart is named');
expectText('xlsx-builtin-format-14', 'buffer', (t) => t.includes('2023-07-'), 'a date format shows a date');
expectText('docx-code-point-out-of-range', 'buffer', (t) => t.includes('Invalid code point 1114112'), 'a bad code point fails');
expectText('zip-ole-file-named-docx', 'buffer', (t) => t.includes('legacy Office file'), 'an OLE file is refused');
expectText('zip-not-a-zip', 'buffer', (t) => t.includes('not a ZIP container'), 'a non-zip is refused');
if (byName.get('limit-part-over-the-part-cap').try !== null) throw new Error('the part cap did not apply');
if (byName.get('limit-container-over-the-container-cap').try !== null) throw new Error('the container cap did not apply');
if (byName.get('xlsx-more-than-5000-rows').buffer.tail === undefined) throw new Error('the 5000-row case is too small to digest');

writeCanonicalJson(join(outDir, 'golden.json'), cases);

const hashOf = (path) => sha256(readFileSync(join(tree, path)));
const provenance = recorderProvenance(import.meta.url);
writeSetManifest(outDir, {
  set: 'ooxml-text',
  recorder: provenance.recorder,
  command: 'node benchmarks/rust-core/recorders/record-ooxml-text.mjs --tree <tree of the Node product>',
  identity: {
    tree: 'the Node modules the recorder loaded, by sha256 (the tree is read only; no file of it changes)',
    modules: Object.fromEntries(NODE_MODULES_RECORDED.map((path) => [path, hashOf(path)])),
  },
  extra: {
    recorderSha256: provenance.recorderSha256,
    nodeVersion: provenance.nodeVersion,
    inputs: provenance.inputs,
    entries: {
      buffer: 'extractOoxmlTextFromBuffer(bytes, filename, { maxOutputBytes })',
      file: 'extractOoxmlText(path of a file named filename, { maxOutputBytes })',
      lowered: 'officeTextForFile({ data, filename }) of media-normalization.mjs (256 KiB output, 8 MiB part and 32 MiB container caps)',
      try: 'tryExtractOoxmlTextFromBuffer(bytes, filename, { maxOutputBytes, maxPartBytes, maxContainerBytes }); null where the bytes have no text form',
    },
    exclusions: [
      'a lone surrogate written as a numeric reference (&#xD800;): Node keeps it in the JavaScript string and encodes it as U+FFFD when the text is written out; a Rust string cannot hold one, so the core writes U+FFFD at the reference. Not recorded.',
      'a container of more than 50 MiB (OFFICE_MAX_BYTES) and a stored entry above the 32 MiB part cap: too large to keep as a fixture; the crate tests build them in memory.',
      'extractOoxmlText on a missing or unreadable file: the message names the operating system error and the path of the machine; the crate tests compare its shape.',
    ],
  },
});
console.log(`recorded ${cases.length} ooxml-text cases`);
