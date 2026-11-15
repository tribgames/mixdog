#!/usr/bin/env node
// What the portable Word snapshot answers (src/runtime/office/portable/portable-snapshot-docx.mjs), run through Node: the read
// model of a Word package at several page requests, the body model, the block append and the small pure helpers the docx
// writers build on. Rust `mixdog-ooxml` must answer the same, the snapshot JSON text exactly (key order included)
// (crates/mixdog-ooxml/tests/twin_snapshot_docx.rs).
//
//   node benchmarks/rust-core/recorders/record-office-snapshot-docx.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-snapshot-docx/golden.json: `snapshots` (the files of a package, the options of the read
// and the JSON text of what snapshotDocx answered, or its error) and `pure` (a function name, its arguments and its result or
// error). Block offsets are UTF-16 units, as Node counts them.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-snapshot-docx');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-snapshot-docx.mjs';
const snapshots = await importFrom(tree, 'src/runtime/office/portable/portable-snapshot-docx.mjs');
const JSZip = createRequire(join(tree, 'package.json'))('jszip');

const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- the markup ---------------------------------------------------------------------------------------------------
const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const part = (root, inner) => `${HEAD}<w:${root} ${NS}>${inner}</w:${root}>`;
const DATE = '2026-03-04T09:30:00Z';
const run = (text, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const styled = (id, inner, extra = '') => para(inner, `<w:pStyle w:val="${id}"/>${extra}`);
const ins = (id, author, inner, tag = 'ins') => `<w:${tag} w:id="${id}" w:author="${author}" w:date="${DATE}">${inner}</w:${tag}>`;
const gone = (text) => `<w:r><w:delText xml:space="preserve">${text}</w:delText></w:r>`;
const cell = (inner, props = '') => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ''}${inner}</w:tc>`;
const row = (...cells) => `<w:tr>${cells.join('')}</w:tr>`;
const table = (rows, style = 'TableGrid') =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="${style}"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows}</w:tbl>`;
const picture = (name, descr, cx, cy) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="${name}" descr="${descr}"/>` +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
const shape = '<w:r><w:drawing><wp:anchor><wp:extent cx="100" cy="100"/><wp:docPr id="2" name="Shape"/></wp:anchor></w:drawing></w:r>';

const STYLES = part(
  'styles',
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="a3"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="60"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia"/><w:b/><w:color w:val="1F3864"/><w:sz w:val="56"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/><w:basedOn w:val="a3"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:caps/><w:spacing w:val="40"/><w:color w:val="auto"/><w:sz w:val="32"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b w:val="0"/><w:sz w:val="36"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="LoopA"><w:name w:val="Loop A"/><w:basedOn w:val="LoopB"/><w:rPr><w:sz w:val="40"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="LoopB"><w:name w:val="Loop B"/><w:basedOn w:val="LoopA"/><w:rPr><w:i/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Orphan"><w:name w:val="Orphan"/><w:basedOn w:val="Missing"/><w:rPr><w:sz w:val="28"/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>'
);

const NUMBERING = part(
  'numbering',
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="●"/></w:lvl>' +
    '<w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>' +
    '<w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2" w:x="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="4"><w:abstractNumId w:val="7"/></w:num>'
);

const listItem = (text, numId, level, extra = '') =>
  para(run(text), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>${extra}`);

const COMMENTS = part(
  'comments',
  `<w:comment w:id="0" w:author="김철수 &amp; Co" w:date="${DATE}" w:initials="김"><w:p w14:paraId="1A2B3C4D"><w:r><w:t>범위를 줄이자</w:t></w:r></w:p><w:p w14:paraId="1A2B3C4E"><w:r><w:t>second paragraph</w:t></w:r></w:p></w:comment>` +
    `<w:comment w:id="1" w:author="Lee" w:date="${DATE}" w:initials="L"><w:p w14:paraId="5E6F7A8B"><w:r><w:t>동의합니다</w:t></w:r></w:p></w:comment>` +
    `<w:comment w:id="2" w:author="Park" w:date="${DATE}" w:initials="P"><w:p w14:paraId="0000aaaa"><w:r><w:t>Resolved root</w:t></w:r></w:p></w:comment>` +
    `<w:comment w:id="3" w:author="Kim" w:date="${DATE}" w:initials="K"><w:p w14:paraId="0000BBBB"><w:r><w:t>reply to the resolved one</w:t></w:r></w:p></w:comment>` +
    `<w:comment w:id="4" w:author="Nobody" w:date="${DATE}"><w:p><w:r><w:t>orphan: no range, no thread</w:t></w:r></w:p></w:comment>`
);
const COMMENTS_EXTENDED = part(
  'commentsEx',
  '<w15:commentEx w15:paraId="1A2B3C4D" w15:done="0"/><w15:commentEx w15:paraId="5E6F7A8B" w15:paraIdParent="1A2B3C4D" w15:done="0"/>' +
    '<w15:commentEx w15:paraId="0000AAAA" w15:done="true"/><w15:commentEx w15:paraId="0000BBBB" w15:paraIdParent="0000AAAA" w15:done="0"/>' +
    '<w15:commentEx w15:paraId="FFFF0000" w15:done="1"/>'
);

const notes = (kind) =>
  part(
    `${kind}s`,
    `<w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}>` +
      `<w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>` +
      `<w:${kind} w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Ref/></w:r><w:r><w:t xml:space="preserve"> 출처: 내부 자료 &amp; 통계</w:t></w:r></w:p></w:${kind}>` +
      `<w:${kind} w:id="2"><w:p><w:r><w:t>Second ${kind}</w:t></w:r>${ins(40, 'Eve', run(' added'))}</w:p></w:${kind}>`
  );

const RELS = (...entries) =>
  `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/x" Target="${target}"/>`)
    .join('')}</Relationships>`;

const sectionBreak = (inner) => para('', `<w:sectPr>${inner}</w:sectPr>`);
const FIRST_SECTION =
  '<w:headerReference w:type="default" r:id="rId1"/><w:headerReference w:type="first" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/>' +
  '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134" w:header="708" w:footer="708"/><w:titlePg/>';
const LAST_SECTION =
  '<w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId4"/><w:footerReference w:type="even" r:id="rId3"/>' +
  '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720.5" w:right="567" w:bottom="-360" w:left="1134"/><w:cols w:num="2" w:space="720"/>';

const REPORT_BODY = [
  styled('a3', run('분기 보고서 📊 Q3')),
  styled('2', run('개요')),
  para(
    `${run('굵게', '<w:b/><w:sz w:val="26"/>')}${run(' &amp; 일반 &lt;tag&gt;')}<w:r><w:br/></w:r>${run('line two')}<w:r><w:br w:type="page"/></w:r><w:r><w:tab/></w:r>${run('after tab')}<w:r><w:br/></w:r>`,
    '<w:spacing w:before="120" w:after="0"/>'
  ),
  listItem('첫째', 1, 0),
  listItem('둘째 (• 표식)', 2, 1),
  listItem('Numbered', 3, 0),
  listItem('Sub letter', 3, 1),
  listItem('numId 0 means none', 0, 0),
  listItem('No such definition', 9, 0),
  listItem('Abstract missing', 4, 0),
  styled('LoopA', run('circular styles')),
  styled('Orphan', run('based on a missing style')),
  para(`${run('Hello ')}${ins(1, 'Bo', gone('world'), 'del')}${ins(2, 'Bo', run('there'))}${run(' kept')}`),
  para(`${ins(3, 'A &amp; B', `${run('keep ')}${ins(4, 'C', gone('struck'), 'del')}${run(' tail')}`)}`),
  para(`${ins(5, 'Bo', gone('moved away'), 'moveFrom')}${ins(6, 'Bo', run('moved here'), 'moveTo')}`, '<w:rPr><w:ins w:id="9" w:author="Bo"/></w:rPr>'),
  para(
    `${run('visible ')}<w:r><w:rPr><w:vanish/></w:rPr><w:t>secret</w:t></w:r><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t> shown</w:t></w:r><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t> also</w:t></w:r>`
  ),
  table(
    row(
      cell(para(run('Item')), '<w:tcW w:w="3000"/><w:gridSpan w:val="1"/>'),
      cell(para(run('값', '<w:sz w:val="44"/><w:b/>')), '<w:vMerge w:val="restart"/>')
    ) +
      row(
        cell(para(`${run('매출 ')}${ins(7, 'Eve', run('+12'))}`)),
        cell(
          para(`${ins(8, 'Eve', gone('old'), 'del')}`) +
            table(row(cell(para(run('nested')), '<w:vMerge/>'), cell(para(`${ins(10, 'Nest', run('inside'))}`)))),
          '<w:gridSpan w:val="2"/>'
        )
      )
  ),
  para(
    `${run('Body ')}<w:commentRangeStart w:id="0"/>${run('범위 안')}<w:commentRangeStart w:id="1"/>${run(' 겹침')}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>${run(' tail')}<w:commentRangeStart w:id="2"/>${run('resolved span')}<w:commentRangeEnd w:id="2"/><w:commentRangeStart w:id="3"/>${run('reply span')}<w:commentRangeEnd w:id="3"/>`
  ),
  `<w:sdt><w:sdtPr><w:alias w:val="제목 &amp; 이름"/><w:tag w:val="name"/><w:lock w:val="sdtLocked"/></w:sdtPr><w:sdtContent>${para(run('block control text'))}</w:sdtContent></w:sdt>`,
  para(`${run('Inline ')}<w:sdt><w:sdtPr><w:tag w:val="inline"/></w:sdtPr><w:sdtContent>${run('control')}</w:sdtContent></w:sdt>`),
  table(row(cell(para(run('adjacent a'))), cell(para(run('adjacent b')))), 'Missing') + table(row(cell(para(run('second table')))), 'TableGrid'),
  para(`${picture('Picture 1', 'A chart &amp; its caption', 3810000, 1905000)}${shape}${picture('Tiny', '', 1, 126)}`),
  para(`${run('See note')}<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r>`),
  sectionBreak(FIRST_SECTION),
  styled('Heading1', run('둘째 섹션')),
  para(run('A paragraph with 😀 emoji and 한글 before the next block.')),
  `<w:sectPr>${LAST_SECTION}</w:sectPr>`,
].join('');

const REPORT = {
  '[Content_Types].xml': `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
  'word/document.xml': part('document', `<w:body>${REPORT_BODY}</w:body>`),
  'word/_rels/document.xml.rels': RELS(['rId1', 'header1.xml'], ['rId2', 'header2.xml'], ['rId3', 'footer1.xml'], ['rId4', '/word/footer2.xml']),
  'word/styles.xml': STYLES,
  'word/numbering.xml': NUMBERING,
  'word/comments.xml': COMMENTS,
  'word/commentsExtended.xml': COMMENTS_EXTENDED,
  'word/footnotes.xml': notes('footnote'),
  'word/endnotes.xml': notes('endnote'),
  'word/settings.xml': part('settings', '<w:trackRevisions/>'),
  'word/header1.xml': part('hdr', para(run('회사 기밀 &amp; 비공개'))),
  'word/header2.xml': part('hdr', para(run('First page header'))),
  'word/header3.xml': part('hdr', para(`${run('Orphan header ')}${ins(30, 'Hdr', run('edited'))}`)),
  'word/footer1.xml': part('ftr', para(run('Page 1')) + para(run('second footer line'))),
  'word/footer2.xml': part('ftr', para(run('Final footer'))),
  'word/_rels/header1.xml.rels': RELS(['rId1', 'image1.png']),
  'word/media/image1.png': 'not a real image',
};

const portableBody = (inner) => `<w:document ${NS}><w:body>${inner}</w:body></w:document>`;
const SMALL_STYLES = part(
  'styles',
  '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
);
const LONG_BODY =
  Array.from({ length: 8 }, (_, at) => styled(at % 3 === 0 ? 'Heading1' : 'Normal', run(`Paragraph ${at + 1} 한글`))).join('') +
  table(row(cell(para(run('only cell'))))) +
  para(run('after table'));

const CASES = [
  {
    name: 'a Word-saved report',
    files: REPORT,
    options: [
      {},
      { paged: true },
      { paged: true, offset: 3, limit: 4 },
      { paged: true, limit: 2 },
      { paged: true, target: '/body/p[14]' },
      { paged: true, target: '/body/tbl[1]' },
      { paged: true, target: '/body/tbl[9]/row[1]' },
      { paged: true, offset: 5000 },
      { paged: true, offset: '2', limit: '3' },
      { paged: true, offset: 1.5, limit: 2.5 },
      { paged: true, offset: -4, limit: 0 },
      { paged: 'true', offset: 3 },
    ],
  },
  {
    name: 'a portable-created document',
    files: { 'word/document.xml': portableBody(LONG_BODY), 'word/styles.xml': SMALL_STYLES },
    options: [{}, { paged: true, limit: 3 }, { paged: true, offset: 6, limit: 3 }, { paged: true, target: '/body/p[2]' }, { paged: true, limit: 100 }],
  },
  {
    name: 'a blank document',
    files: { 'word/document.xml': portableBody('<w:p/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>') },
    options: [{}],
  },
  {
    name: 'a document with no body',
    files: { 'word/document.xml': `<w:document ${NS}/>`, 'word/footer1.xml': part('ftr', para(run('Footer only'))) },
    options: [{}, { paged: true }],
  },
  { name: 'an empty package', files: {}, options: [{}, { paged: true }] },
  {
    name: 'tracked changes in cells and headers',
    files: {
      'word/document.xml': portableBody(
        table(row(cell(para(`${run('a')}${ins(1, 'Z', run('b'))}`)), cell(para(ins(2, 'Z', gone('c'), 'del'))))) + para(ins(3, 'Y', run('tail'))) + '<w:sectPr/>'
      ),
      'word/header1.xml': part('hdr', para(ins(4, 'Y', run('head')))),
      'word/settings.xml': part('settings', '<w:trackRevisions w:val="off"/>'),
    },
    options: [{}],
  },
  {
    name: 'comments without threads and sections without references',
    files: {
      'word/document.xml': portableBody(
        para(`<w:commentRangeStart w:id="7"/>${run('x')}<w:commentRangeEnd w:id="7"/>`) +
          '<w:sectPr><w:cols w:space="360"/></w:sectPr>' +
          para(run('y')) +
          '<w:sectPr><w:cols w:num="3"/></w:sectPr>'
      ),
      'word/comments.xml': part(
        'comments',
        '<w:comment w:id="7" w:author="A"><w:p><w:r><w:t>one</w:t></w:r></w:p></w:comment><w:comment w:id="8" w:author="B"><w:p w14:paraId="0A0A0A0A"><w:r><w:t>two</w:t></w:r></w:p></w:comment>'
      ),
      'word/commentsExtended.xml': part('commentsEx', '<w15:commentEx w15:paraId="0a0a0a0a" w15:paraIdParent="0A0A0A0A" w15:done="1"/>'),
    },
    options: [{}],
  },
];

const toZip = (files) => {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip;
};

const snapshotCases = [];
for (const entry of CASES) {
  for (const options of entry.options) {
    const answer = await attempt(async () => JSON.stringify(await snapshots.snapshotDocx(toZip(entry.files), options)));
    snapshotCases.push({ name: entry.name, files: entry.files, options, ...answer });
  }
}

// ---- the pure functions -------------------------------------------------------------------------------------------
const pure = [];
const record = async (fn, args, call) => pure.push({ fn, args, ...(await attempt(call)) });
const project = (model) => ({
  paragraphs: model.paragraphs,
  tables: model.tables,
  blocks: model.blocks.map((block) => ({ name: block.name, start: block.start, end: block.end, xml: block.xml, logicalIndex: block.logicalIndex })),
  body: model.body ? { start: model.body.start, end: model.body.end } : null,
});

const BODIES = [
  REPORT['word/document.xml'],
  portableBody(LONG_BODY),
  `<w:document ${NS}/>`,
  '',
  portableBody('<w:p><w:r><w:t>한글 😀</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/><w:sectPr/>'),
  portableBody('<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:tbl><w:tr/></w:tbl>'),
];
for (const body of BODIES) await record('docxBodyModel', [body], () => project(snapshots.docxBodyModel(body)));

const FRESH = portableBody('<w:p/><w:sectPr><w:pgSz w:w="1"/></w:sectPr>');
const FRESH_PLAIN = portableBody('<w:p/>');
const FILLED = portableBody('<w:p><w:r><w:t>한글</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="1"/></w:sectPr>');
const CLOSED = portableBody('<w:tbl><w:tr/></w:tbl><w:p/><w:sectPr/>');
const CLOSED_PLAIN = portableBody('<w:tbl><w:tr/></w:tbl>\n<w:p/>\n');
const DRAWN = portableBody('<w:p><w:r><w:drawing/></w:r></w:p>');
const TABLE_ONLY = portableBody('<w:p/><w:tbl><w:tr/></w:tbl>');
const SECTION_BREAK = portableBody('<w:p><w:pPr><w:sectPr/></w:pPr></w:p><w:sectPr/>');
const BIG = portableBody(`<w:p/>${'<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(80)}`);
const APPENDS = [
  [FRESH, '<w:p><w:r><w:t>new</w:t></w:r></w:p>'],
  [FRESH_PLAIN, '<w:tbl><w:tr/></w:tbl>'],
  [FILLED, '<w:p><w:r><w:t>next</w:t></w:r></w:p>'],
  [FILLED, '<w:tbl><w:tr/></w:tbl>'],
  [CLOSED, '<w:p><w:r><w:t>after table</w:t></w:r></w:p>'],
  [CLOSED, '<w:tbl><w:tr/></w:tbl>'],
  [CLOSED_PLAIN, '<w:p/>'],
  [DRAWN, '<w:p/>'],
  [TABLE_ONLY, '<w:p><w:r><w:t>t</w:t></w:r></w:p>'],
  [SECTION_BREAK, '<w:p><w:r><w:t>z</w:t></w:r></w:p>'],
  [BIG, '<w:p><w:r><w:t>end</w:t></w:r></w:p>'],
  [REPORT['word/document.xml'], '<w:p><w:r><w:t>tail 한글</w:t></w:r></w:p>'],
  [`<w:document ${NS}/>`, '<w:p/>'],
  ['', '<w:p/>'],
];
for (const args of APPENDS) await record('appendDocxBlock', args, () => snapshots.appendDocxBlock(...args));

const TABLE_DOCS = [
  portableBody('<w:tbl><w:tr/></w:tbl><w:tbl><w:tr/></w:tbl>'),
  portableBody('<w:tbl><w:tr/></w:tbl> \n <w:tbl><w:tr/></w:tbl><w:p/><w:tbl/>'),
  portableBody('<w:tbl><w:tr/></w:tbl><w:p/><w:tbl><w:tr/></w:tbl>'),
  portableBody('<w:tbl/><w:tblPr/>'),
  '',
  CLOSED,
  CLOSED_PLAIN,
  TABLE_ONLY,
  portableBody('<w:tbl><w:tr/></w:tbl>\n<w:sectPr><w:pgSz/></w:sectPr>'),
  portableBody('<w:tbl><w:tr/></w:tbl>'),
  `<w:document ${NS}/>`,
];
for (const xml of TABLE_DOCS) {
  await record('hasAdjacentTables', [xml], () => snapshots.hasAdjacentTables(xml));
  await record('separateAdjacentTables', [xml], () => snapshots.separateAdjacentTables(xml));
  await record('closeTrailingTable', [xml], () => snapshots.closeTrailingTable(xml));
}

const LEVELS = [
  '<w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>',
  '<w:numFmt w:val="decimal"/><w:lvlText w:val="•"/>',
  '<w:numFmt w:val="bullet"/>',
  '<w:numFmt w:val="bullet"/><w:lvlText w:val="%1"/>',
  '<w:numFmt w:val="lowerRoman"/>',
  '<w:lvlText w:val=""/>',
  '<w:lvlText w:val="-"/>',
  '',
  '<w:numFmt w:val="ordinal"/><w:lvlText w:val="제%1조"/>',
];
for (const level of LEVELS) await record('numberingLevelFormat', [level], () => snapshots.numberingLevelFormat(level));

writeJson(join(stage, 'golden.json'), { snapshots: snapshotCases, pure });
writeSetManifest(stage, { set: 'office-snapshot-docx', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
