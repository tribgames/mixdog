#!/usr/bin/env node
// What the portable Word document operations and tracked edits answer (src/runtime/office/portable: portable-docx-operations and
// docx-tracked-edits), run through Node: the table of contents refresh and its measured pages, notes, the document font, style
// definitions, page setup, table fitting, content controls, paragraph edits, table cells, the resolution of tracked changes and the
// tracked paragraph rewrite, phrase anchor and find-and-replace. The documents are the shapes office-runtime-portable.slow and
// docx-design-tools.slow drive these through. Rust `mixdog-ooxml` must answer the same: the returned values and the text of every
// part, exactly (crates/mixdog-ooxml/tests/twin_docx_operations.rs).
//
//   node benchmarks/rust-core/recorders/record-office-docx-operations.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-docx-operations/golden.json. The recording holds `pure` (a function name, its arguments and
// its result or error) and `sequences` (steps over one package: each step's output, then the package's names and every part's
// text). A time of day in an answer is scrubbed by the replay on both sides.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-docx-operations');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-docx-operations.mjs';
const operations = await importFrom(tree, 'src/runtime/office/portable/portable-docx-operations.mjs');
const tracked = await importFrom(tree, 'src/runtime/office/portable/docx-tracked-edits.mjs');
const JSZip = createRequire(join(tree, 'package.json'))('jszip');

const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- the markup ---------------------------------------------------------------------------------------------------
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DATE = '2026-03-04T09:30:00Z';
const TYPES = (...extra) =>
  `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${extra.join('')}</Types>`;
const RELS = (...entries) =>
  `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`;
const run = (text, rpr = '', attrs = '') => `<w:r${attrs}>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t>${text}</w:t></w:r>`;
const keep = (text, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const SECTION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>';
const doc = (body, tail = SECTION) => `${HEAD}<w:document ${W}><w:body>${body}${tail}</w:body></w:document>`;
const heading = (level, text) => para(run(text), `<w:pStyle w:val="Heading${level}"/>`);
const STYLE = (id, name, extra = '', type = 'paragraph') => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
const STYLES = (...styles) =>
  `${HEAD}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:style>${styles.join('')}</w:styles>`;
const ins = (id, author, inner) => `<w:ins w:id="${id}" w:author="${author}" w:date="${DATE}">${inner}</w:ins>`;
const del = (id, author, text) => `<w:del w:id="${id}" w:author="${author}" w:date="${DATE}"><w:r><w:delText xml:space="preserve">${text}</w:delText></w:r></w:del>`;
const mark = (tag, id, author) => `<w:rPr><w:${tag} w:id="${id}" w:author="${author}" w:date="${DATE}"/></w:rPr>`;
const cell = (inner, props = '') => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ''}${inner}</w:tc>`;
const row = (cells, props = '') => `<w:tr>${props ? `<w:trPr>${props}</w:trPr>` : ''}${cells}</w:tr>`;
const grid = (...widths) => `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
const table = (rows, columns = [3000, 3000], props = '<w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>') =>
  `<w:tbl><w:tblPr>${props}</w:tblPr>${grid(...columns)}${rows}</w:tbl>`;
const BASE = (body, extra = {}) => ({
  '[Content_Types].xml': TYPES(),
  '_rels/.rels': RELS(['rId1', 'officeDocument', 'word/document.xml']),
  'word/document.xml': body,
  'word/_rels/document.xml.rels': RELS(['rId1', 'styles', 'styles.xml']),
  'word/styles.xml': STYLES(STYLE('Heading1', 'heading 1', '<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>'), STYLE('Heading2', 'heading 2'), STYLE('Caption', 'caption')),
  ...extra,
});

// ---- the pure functions -------------------------------------------------------------------------------------------
const PURE = [];
const pure = (fn, args) => PURE.push({ fn, args });

const PARAGRAPHS = {
  oneRun: para(run('Hello brave world')),
  styled: para(`${run('Bold ', '<w:b/><w:sz w:val="28"/>')}${run('then plain')}`, '<w:pStyle w:val="Heading1"/>'),
  split: para(`${keep('The 86억 원', '<w:b/>')}${keep('으로 증가', '<w:i/>')}${keep('했습니다.')}`),
  tabbed: para(`${run('before')}<w:r><w:tab/></w:r>${run('after the tab')}`),
  field: para(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>${run('page number')}`),
  empty: '<w:p/>',
  emptyOpen: '<w:p></w:p>',
  attributes: '<w:p w14:paraId="1A2B"><w:pPr><w:jc w:val="center"/></w:pPr><w:r w:rsidR="00A1"><w:rPr><w:b/></w:rPr><w:t>Marked up</w:t></w:r></w:p>',
  entities: para(run('a &amp; b &lt; c and 100% of it')),
  repeated: para(run('one two one two one')),
  figure: para(run('Growth was 22% in March and 22% in April')),
  hangul: para(`${run('성장했습니다', '<w:rFonts w:eastAsia="Malgun Gothic"/>')}${run(' 그리고 감소했습니다')}`),
  emoji: para(run('a😀b 😀 c')),
  noParagraph: 'plain text without markup',
  trailingSpace: '<w:p><w:r><w:t>x</w:t></w:r></w:p>  \n',
};
for (const xml of Object.values(PARAGRAPHS)) {
  pure('trackedParagraphRewrite', [xml, 'Rewritten text', 10, 'Reviewer']);
  pure('trackedParagraphRewrite', [xml, 'tab\tseparated  ', 3, '']);
}

const ANCHORS = [
  [PARAGRAPHS.oneRun, 'brave', 7, null],
  [PARAGRAPHS.oneRun, 'Hello', 7, null],
  [PARAGRAPHS.oneRun, 'world', 8, null],
  [PARAGRAPHS.oneRun, 'Hello brave world', 9, null],
  [PARAGRAPHS.oneRun, 'absent', 9, null],
  [PARAGRAPHS.oneRun, '', 9, null],
  [PARAGRAPHS.split, '원으로', 4, null],
  [PARAGRAPHS.split, '86억 원으로 증가했습니다', 5, null],
  [PARAGRAPHS.split, '증가', 5, { start: '<w:bookmarkStart w:id="5" w:name="x"/>', end: '<w:bookmarkEnd w:id="5"/>' }],
  [PARAGRAPHS.split, '원으로 증', 6, { start: '<w:hyperlink r:id="rId9">', end: '</w:hyperlink>', replace: true }],
  [PARAGRAPHS.split, '86억 원으로 증가했', 6, { start: '[', end: ']', replace: true }],
  [PARAGRAPHS.split, '으로', 6, { start: '', end: '<w:r><w:footnoteReference w:id="3"/></w:r>' }],
  [PARAGRAPHS.tabbed, 'after', 2, null],
  [PARAGRAPHS.tabbed, 'before', 2, null],
  [PARAGRAPHS.tabbed, 'foreafter', 2, null],
  [PARAGRAPHS.field, 'page', 2, null],
  [PARAGRAPHS.attributes, 'Marked', 11, null],
  [PARAGRAPHS.entities, '&', 12, null],
  [PARAGRAPHS.entities, 'a & b', 12, null],
  [PARAGRAPHS.hangul, '했습니다 그리고', 13, null],
  [PARAGRAPHS.emoji, '😀 c', 14, null],
  [PARAGRAPHS.empty, 'x', 1, null],
];
for (const [xml, find, id, markers] of ANCHORS) pure('anchorPhraseInParagraph', [xml, find, id, markers]);

const REPLACES = [
  [PARAGRAPHS.oneRun, 'brave', 'bold', 20, 'Reviewer'],
  [PARAGRAPHS.oneRun, 'brave', '', 20, 'Reviewer'],
  [PARAGRAPHS.oneRun, 'Hello', 'Hello', 20, 'Reviewer'],
  [PARAGRAPHS.oneRun, 'brave world', 'brave new world', 20, 'Reviewer'],
  [PARAGRAPHS.oneRun, 'absent', 'x', 20, 'Reviewer'],
  [PARAGRAPHS.oneRun, '', 'x', 20, 'Reviewer'],
  [PARAGRAPHS.styled, 'Bold then', 'Plain and', 30, 'A & B'],
  [PARAGRAPHS.split, '86억 원으로', '86억 원(잠정)으로', 40, 'Reviewer'],
  [PARAGRAPHS.split, '원으로 증가', '원으로 감소', 40, 'Reviewer'],
  [PARAGRAPHS.split, '증가했습니다', '증가했습니다', 40, 'Reviewer'],
  [PARAGRAPHS.split, '으로', '으로의', 40, 'Reviewer'],
  [PARAGRAPHS.tabbed, 'after the tab', 'x', 50, 'Reviewer'],
  [PARAGRAPHS.tabbed, 'before', 'x', 50, 'Reviewer'],
  [PARAGRAPHS.tabbed, 'foreafter', 'x', 50, 'Reviewer'],
  [PARAGRAPHS.repeated, 'one', 'ONE', 60, 'Reviewer'],
  [PARAGRAPHS.repeated, 'one two', 'one two', 60, 'Reviewer'],
  [PARAGRAPHS.repeated, 'two one', 'two 1', 60, 'Reviewer'],
  [PARAGRAPHS.figure, '22%', '21.6%', 70, 'Reviewer'],
  [PARAGRAPHS.figure, 'was 22% in', 'was 22% during', 70, 'Reviewer'],
  [PARAGRAPHS.entities, 'a & b', 'c', 80, 'Reviewer'],
  [PARAGRAPHS.entities, '<', '>', 80, 'Reviewer'],
  [PARAGRAPHS.hangul, '성장했습니다 그리고', '성장 그리고', 90, 'Reviewer'],
  [PARAGRAPHS.emoji, '😀', '🙂', 95, 'Reviewer'],
  [PARAGRAPHS.attributes, 'Marked up', 'Changed', 96, ''],
  [PARAGRAPHS.noParagraph, 'plain', 'x', 97, 'Reviewer'],
];
for (const args of REPLACES) pure('trackedParagraphReplace', args);

const BODY = doc(
  para(run('The quick brown fox')) +
    para(`${keep('jumps over ')}<w:r><w:tab/></w:r>${keep('the lazy dog')}`) +
    para(run('The quick brown fox')) +
    table(row(cell(para(run('The quick table cell'))) + cell(para(run('other')))) + row(cell(para(run('x'))) + cell(para(run('y'))))) +
    para(`${run('fox ')}${ins(4, 'Eve', run('fox again'))}${del(5, 'Bo', 'fox gone')}`) +
    para(run('nothing here'))
);
for (const [find, replacement] of [['quick', 'slow'], ['fox', 'cat'], ['fox', ''], ['over the', 'under a'], ['The quick', 'A fast'], ['absent', 'x'], ['', 'x'], ['y', 'z']]) {
  pure('replaceTrackedParagraphs', [BODY, find, replacement, 'Reviewer']);
}
pure('replaceTrackedParagraphs', [`<w:body>${para(`${run('a')}<w:r><w:br/></w:r>${run('b')}`)}</w:body>`, 'a', 'z', 'Reviewer']);
pure('replaceTrackedParagraphs', [`<w:body>${para(`${run('ab')}<w:r><w:tab/></w:r>${run('cd')}`)}</w:body>`, 'bc', 'X', 'Reviewer']);
pure('replaceTrackedParagraphs', [`<w:body>${para(`${run('ab')}<w:r><w:tab/></w:r>${run('cd')}`)}</w:body>`, 'ab', 'ab ', '']);
pure('replaceTrackedParagraphs', ['', 'a', 'b', 'Reviewer']);

// the table of contents entries
const LEVELS = { Titre1: 1, 'a3': 2, Custom: 3 };
const TOC_BODY = doc(heading(1, 'Intro') + heading(2, 'Scope') + para(run('Body text'), '<w:pStyle w:val="Titre1"/>') + para(run(' Spaced  ')) + para(run('Deep'), '<w:pStyle w:val="Custom"/>') + para(run('  '), '<w:pStyle w:val="Heading1"/>') + heading(3, 'Third') + para(run('Out'), '<w:pStyle w:val="Heading0"/>'));
for (const [lower, upper] of [[1, 3], [1, 1], [2, 2], [1, 9], [3, 3], [2, 1]]) pure('docxTocEntries', [TOC_BODY, lower, upper, LEVELS]);
pure('docxTocEntries', [TOC_BODY, 1, 3, {}]);
pure('docxTocEntries', ['', 1, 3, {}]);
pure('docxTocCacheRuns', [[], 1]);
pure('docxTocCacheRuns', [[{ level: 1, text: 'A & B' }, { level: 2, text: 'Sub <x>' }, { level: 3, text: 'Third', page: 4 }, { level: 1, text: 'Zero', page: 0 }], 1]);
pure('docxTocCacheRuns', [[{ level: 2, text: 'Only second', page: 12 }], 2]);

// style definitions
for (const operation of [
  { op: 'define_styles' },
  { op: 'define_styles', styles: {} },
  { op: 'define_styles', styles: [] },
  { op: 'define_styles', styles: 'Heading 1' },
  { op: 'define_styles', styles: null },
  { op: 'define_styles', styles: { 'Heading 1': { size: 15, bold: true } } },
  { op: 'define_styles', styles: { 'Heading 1': { size: 15 }, Title: 'big', Caption: [], Body: { fontSize: 11, color: 'red' }, Other: null } },
  { op: 'define_styles', styles: { 2: { bold: true }, b: { italic: true }, 1: { size: 9 } } },
  { op: 'define_styles', styles: { A: { name: 'x', nameEastAsia: 'y', size: 1, bold: true, italic: false, color: '1F2937', alignment: 'left', spacingBefore: 1, spacingAfter: 2, lineSpacing: 3, lineSpacingRule: 'exact', keepWithNext: true, keepTogether: false } } },
]) pure('docxStyleDefinitions', [operation]);

// ---- the sequences over one package -------------------------------------------------------------------------------
const packageOf = async (files) => {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip;
};
const snapshotOf = async (zip) => {
  const names = Object.keys(zip.files);
  const found = {};
  for (const name of names) if (!zip.files[name].dir) found[name] = (await zip.file(name)?.async('string')) ?? '';
  return { names, parts: found };
};
const storyParts = (zip) =>
  Object.keys(zip.files).filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name));
const runStep = async (zip, step) => {
  switch (step.fn) {
    case 'refreshDocxTableOfContents':
      return await operations.refreshDocxTableOfContents(zip);
    case 'writeDocxTocPages':
      return await operations.writeDocxTocPages(zip, step.pages);
    case 'addDocxNote':
      return await operations.addDocxNote(zip, step.op);
    case 'setDocxDocumentFont':
      return await operations.setDocxDocumentFont(zip, step.op);
    case 'defineDocxStyles':
      return await operations.defineDocxStyles(zip, step.op);
    case 'setDocxPage':
      return await operations.setDocxPage(zip, step.op);
    case 'fitDocxTable':
      return await operations.fitDocxTable(zip, step.op);
    case 'fillDocxContentControl':
      return await operations.fillDocxContentControl(zip, step.op);
    case 'editDocxParagraph':
      return await operations.editDocxParagraph(zip, step.op, step.tracking);
    case 'styleOrMergeDocxTableCell':
      return await operations.styleOrMergeDocxTableCell(zip, step.op);
    case 'resolveDocxRevisions':
      return await operations.resolveDocxRevisions(zip, storyParts(zip), step.op);
    case 'set':
      zip.file(step.name, step.text);
      return null;
    case 'remove':
      zip.remove(step.name);
      return null;
    default:
      throw new Error(`unknown step ${step.fn}`);
  }
};

const SEQUENCES = [];
const sequence = (name, files, steps) => SEQUENCES.push({ name, files, steps });

// the table of contents
const TOC_FIELD = (levels, cache = '<w:r><w:t>old entry</w:t></w:r>') => `<w:p><w:fldSimple w:instr=" TOC \\o &quot;${levels}&quot; \\h \\z \\u ">${cache}</w:fldSimple></w:p>`;
const TOC_DOCUMENT = doc(
  para(run('Contents')) + TOC_FIELD('1-2') + heading(1, 'Intro') + para(run('text')) + heading(2, 'Scope') + heading(3, 'Deep') + heading(1, 'Closing') + para(run('Korean'), '<w:pStyle w:val="a3"/>'),
);
const TOC_STYLES = STYLES(
  STYLE('Heading1', 'heading 1'),
  STYLE('Heading2', 'heading 2'),
  STYLE('Heading3', 'heading 3'),
  STYLE('a3', '제목 2'),
  STYLE('Outlined', 'My outline', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>'),
  STYLE('Plain', 'Plain', '<w:pPr><w:outlineLvl w:val="12"/></w:pPr>'),
);
sequence('table of contents refresh and pages', BASE(TOC_DOCUMENT, { 'word/styles.xml': TOC_STYLES }), [
  { fn: 'refreshDocxTableOfContents' },
  { fn: 'refreshDocxTableOfContents' },
  { fn: 'writeDocxTocPages', pages: ['Contents1Intro2ScopeIntroScopeClosing', 'Intro1Scope2', 'DeepClosing3'] },
  { fn: 'refreshDocxTableOfContents' },
  { fn: 'writeDocxTocPages', pages: ['Contents', 'IntroScope', 'Closing'] },
  { fn: 'writeDocxTocPages', pages: [] },
  { fn: 'writeDocxTocPages', pages: ['nothing relevant'] },
]);
sequence(
  'table of contents of one level with a section',
  BASE(
    doc(
      TOC_FIELD('1-1') + heading(1, 'Alpha') + heading(2, 'Beta') + heading(1, 'Gamma'),
      '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="567" w:bottom="720" w:left="1134"/></w:sectPr>',
    ),
  ),
  [{ fn: 'writeDocxTocPages', pages: ['AlphaBetaGamma'] }, { fn: 'writeDocxTocPages', pages: ['Contents', 'Alpha', 'Gamma'] }, { fn: 'refreshDocxTableOfContents' }],
);
sequence('a document without a table of contents', BASE(doc(heading(1, 'Only'))), [{ fn: 'refreshDocxTableOfContents' }, { fn: 'writeDocxTocPages', pages: ['Only'] }]);
sequence(
  'a table of contents with a cached page and a heading that moved',
  BASE(
    doc(
      TOC_FIELD('1-3', `<w:r><w:t xml:space="preserve">Intro</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>5</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">Gone</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>9</w:t></w:r>`) +
        heading(1, 'Intro') +
        heading(2, 'New heading'),
    ),
  ),
  [{ fn: 'refreshDocxTableOfContents' }],
);
sequence('a contents field without a switch', BASE(doc(`<w:p><w:fldSimple w:instr=" TOC ">${'<w:r><w:t>x</w:t></w:r>'}</w:fldSimple></w:p>${heading(1, 'One')}${heading(2, 'Two')}${heading(3, 'Three')}${heading(4, 'Four')}`)), [
  { fn: 'refreshDocxTableOfContents' },
  { fn: 'writeDocxTocPages', pages: ['OneTwoThree'] },
]);

// notes
const NOTE_BODY = doc(
  para(run('First paragraph about the growth of revenue.')) +
    para(`${keep('성장', '<w:rFonts w:ascii="Noto Serif KR" w:hAnsi="Noto Serif KR"/>')}${keep('했습니다 라고 한다.')}`) +
    para(`${run('before')}<w:r><w:tab/></w:r>${run('after the tab')}`) +
    para(run('Total 92.8%로 나타났다.')) +
    para(run('Last paragraph here.')),
);
sequence('footnotes and endnotes', BASE(NOTE_BODY), [
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'Source: annual report', find: 'growth' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'A second & <b> note', find: 'revenue.' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'Korean', find: '성장' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'Whole figure', find: '92.8%' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'Across a tab', find: 'before' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'Tab crossing', find: 'beforeafter' } },
  { fn: 'addDocxNote', op: { op: 'add_note', kind: 'endnote', text: 'An endnote', paragraph: 5 } },
  { fn: 'addDocxNote', op: { op: 'add_note', kind: 'endnote', text: 'A second endnote', find: 'Last' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'By paragraph', paragraph: '1' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'No anchor text' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'Missing phrase', find: 'not in the document' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'Missing paragraph', paragraph: 99 } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'Bad paragraph', paragraph: 'x' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: '' } },
  { fn: 'addDocxNote', op: { op: 'add_note' } },
  { fn: 'addDocxNote', op: { op: 'add_note', text: 'Odd kind', kind: 'sidenote', find: 'Last' } },
]);

// the document font
sequence('document font', BASE(doc(para(run('x')))), [
  { fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: { name: 'Noto Serif KR' } } },
  { fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: { nameEastAsia: 'Noto Sans KR', size: 10.5, color: '#1F2937' } } },
  { fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: { size: 12 } } },
  { fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: { color: '222222' } } },
  { fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: {} } },
  { fn: 'setDocxDocumentFont', op: { op: 'set_document_font' } },
  { fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: { size: 'big', name: '  Arial  ' } } },
]);
sequence(
  'document font without defaults',
  { ...BASE(doc(para(run('x')))), 'word/styles.xml': `${HEAD}<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="b"><w:name w:val="Other"/><w:rPr><w:sz w:val="40"/></w:rPr></w:style></w:styles>` },
  [{ fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: { name: 'Arial', size: 9 } } }, { fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: { name: 'Verdana' } } }],
);
sequence(
  'document font with an empty default and a styleless package',
  { ...BASE(doc(para(run('x')))), 'word/styles.xml': `${HEAD}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr/></w:rPrDefault></w:docDefaults></w:styles>` },
  [{ fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: { name: 'Arial' } } }],
);
sequence('document font without a styles part', (({ 'word/styles.xml': _styles, ...rest }) => rest)(BASE(doc(para(run('x'))))), [
  { fn: 'setDocxDocumentFont', op: { op: 'set_document_font', properties: { name: 'Arial' } } },
]);

// style definitions
sequence('define styles', BASE(doc(para(run('x')))), [
  { fn: 'defineDocxStyles', op: { op: 'define_styles', styles: { 'Heading 1': { size: 15, bold: true, color: '#1F2937' } } } },
  { fn: 'defineDocxStyles', op: { op: 'define_styles', styles: { Heading2: { name: 'Noto Serif KR', nameEastAsia: 'Noto Serif KR', italic: true, alignment: 'center', spacingBefore: 12, spacingAfter: 6, lineSpacing: 1.5, keepWithNext: true } } } },
  { fn: 'defineDocxStyles', op: { op: 'define_styles', styles: { caption: { size: 9, italic: true }, 'No Such Style': { size: 3 } } } },
  { fn: 'defineDocxStyles', op: { op: 'define_styles', styles: { Normal: { size: 10.5 }, Title: { size: 26, bold: true } } } },
  { fn: 'defineDocxStyles', op: { op: 'define_styles', styles: { 'Heading 1': { size: 'x' } } } },
  { fn: 'defineDocxStyles', op: { op: 'define_styles', styles: { 'Heading 1': { weight: 1 } } } },
  { fn: 'defineDocxStyles', op: { op: 'define_styles' } },
]);
sequence('define styles in a package without a styles part', (({ 'word/styles.xml': _styles, ...rest }) => rest)(BASE(doc(para(run('x'))))), [
  { fn: 'defineDocxStyles', op: { op: 'define_styles', styles: { 'Heading 1': { size: 15 } } } },
]);

// page setup
const SECTIONED = doc(
  para(run('first')) +
    para('', '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>') +
    para(run('second')),
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/><w:cols w:num="2" w:space="360"/></w:sectPr>',
);
sequence('page setup', BASE(SECTIONED), [
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { orientation: 'landscape' } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { orientation: 'Portrait' } } },
  { fn: 'setDocxPage', op: { op: 'set_page', section: 1, properties: { orientation: 'landscape', topMargin: 36, leftMargin: 18.25 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', section: 2, properties: { pageWidth: 595.3, pageHeight: 841.9, rightMargin: 0, headerMargin: 10 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { columns: 3, columnSpacing: 18 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { columns: 1 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { columnSpacing: 36.4 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { pageWidth: 842, pageHeight: 595, orientation: 'portrait' } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { topMargin: -10, bottomMargin: 'x' } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { orientation: 'diagonal' } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { columns: 13 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { columns: 2.5 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { columnSpacing: -1 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { pageWidth: 100 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', section: 9, properties: { orientation: 'landscape' } } },
  { fn: 'setDocxPage', op: { op: 'set_page', section: 0, properties: { orientation: 'landscape' } } },
  { fn: 'setDocxPage', op: { op: 'set_page', section: 1.5, properties: { orientation: 'landscape' } } },
  { fn: 'setDocxPage', op: { op: 'set_page' } },
]);
sequence('page setup without a section', BASE(doc(para(run('x')), '')), [
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { orientation: 'landscape', topMargin: 20 } } },
  { fn: 'setDocxPage', op: { op: 'set_page', properties: { columns: 2 } } },
]);
sequence('page setup in a document without a body', BASE(`${HEAD}<w:document ${W}></w:document>`), [{ fn: 'setDocxPage', op: { op: 'set_page', properties: { orientation: 'landscape' } } }]);

// fitting a table
const CELL_BORDER = '<w:tcBorders><w:top w:val="single" w:sz="4"/></w:tcBorders>';
const FIT_BODY = doc(
  para(run('before')) +
    table(
      row(cell(para(run('a')), `<w:tcW w:w="1000" w:type="dxa"/>${CELL_BORDER}<w:shd w:val="clear" w:fill="EEEEEE"/><w:vAlign w:val="bottom"/>`) + cell(para(run('b')), '<w:tcW w:w="2000" w:type="dxa"/><w:tcMar><w:left w:w="0" w:type="dxa"/></w:tcMar>') + cell(para(run('c')))) +
        row(cell(para(run('wide')), '<w:gridSpan w:val="2"/>') + cell(para(run('d')))),
      [1000, 2000, 3000],
    ) +
    para(run('between')) +
    table(row(cell(para(run('lone')))), [5000], '<w:tblW w:w="5000" w:type="dxa"/><w:jc w:val="center"/>') +
    table(row(cell(para(run('nogrid')))), [], '') +
    table(row(cell(para(run('zero'))) + cell(para(run('zero')))), [0, 0], '<w:tblStyle w:val="TableGrid"/>') +
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>raw</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
);
sequence('fit tables', BASE(FIT_BODY), [
  { fn: 'fitDocxTable', op: { op: 'fit_table', table: 1 } },
  { fn: 'fitDocxTable', op: { op: 'fit_table', table: 2 } },
  { fn: 'fitDocxTable', op: { op: 'fit_table', table: 3 } },
  { fn: 'fitDocxTable', op: { op: 'fit_table', table: 4 } },
  { fn: 'fitDocxTable', op: { op: 'fit_table', table: 5 } },
  { fn: 'fitDocxTable', op: { op: 'fit_table', table: '1', properties: { borders: { style: 'single', size: 4, color: '#888888' }, alignment: 'center' } } },
  { fn: 'fitDocxTable', op: { op: 'fit_table', table: 2, properties: { style: 'TableGrid' } } },
  { fn: 'fitDocxTable', op: { op: 'fit_table', table: 9 } },
  { fn: 'fitDocxTable', op: { op: 'fit_table' } },
]);
sequence(
  'fit tables on a landscape page',
  BASE(doc(table(row(cell(para(run('a'))) + cell(para(run('b')))), [100, 300]), '<w:sectPr><w:pgSz w:w="16838" w:h="11906"/><w:pgMar w:left="1000" w:right="1000"/></w:sectPr>')),
  [{ fn: 'fitDocxTable', op: { op: 'fit_table', table: 1 } }],
);
sequence('fit tables without a section', BASE(doc(table(row(cell(para(run('a'))) + cell(para(run('b')))), [100, 300]), '')), [{ fn: 'fitDocxTable', op: { op: 'fit_table', table: 1 } }]);

// content controls
const CONTROL = (tag, value, extra = '', content = null) =>
  `<w:sdt><w:sdtPr>${tag ? `<w:tag w:val="${tag}"/>` : ''}${extra}</w:sdtPr><w:sdtContent>${content ?? para(run(value, '<w:b/>'))}</w:sdtContent></w:sdt>`;
const CONTROL_BODY = doc(
  CONTROL('title', 'Title here') +
    CONTROL('client &amp; co', 'Client') +
    CONTROL('placeholder', 'Click to enter', '<w:showingPlcHdr/>', para(`${run('Click', '<w:i/>')}${run(' to enter')}`)) +
    CONTROL('locked', 'Locked text', '<w:lock w:val="sdtContentLocked"/>') +
    CONTROL('contentlock', 'Locked too', '<w:lock w:val="contentLocked"/>') +
    CONTROL('unlocked', 'Unlocked', '<w:lock w:val="sdtLocked"/>') +
    CONTROL('inline', '', '', `<w:r><w:t>inline value</w:t></w:r>`) +
    CONTROL('empty', '', '', '') +
    CONTROL('', 'No tag') +
    CONTROL('styled', '', '', `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>one</w:t></w:r><w:r><w:t>two</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p>`),
);
const HEADER_PART = `${HEAD}<w:hdr ${W}>${CONTROL('headerField', 'Header value')}${CONTROL('title', 'Header title')}</w:hdr>`;
const FOOTER_PART = `${HEAD}<w:ftr ${W}>${CONTROL('footerField', 'Footer value')}</w:ftr>`;
sequence('content controls', BASE(CONTROL_BODY, { 'word/header1.xml': HEADER_PART, 'word/footer1.xml': FOOTER_PART, 'word/header10.xml': HEADER_PART, 'word/header2.xml': HEADER_PART.replace('headerField', 'secondHeader') }), [
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'title', text: 'New title' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'client & co', text: 'A & B <c>' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'placeholder', text: '  padded  ' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'unlocked', text: 'ok' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'inline', text: 'inline set' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'empty', text: 'filled' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'styled', text: 'merged' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', control: 9, text: 'ninth' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', control: '1', text: 'first again' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'headerField', text: 'new header' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'footerField', text: 'new footer' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'secondHeader', text: 'second header' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', control: 11, text: 'in a header' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'locked', text: 'x' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', control: 5, text: 'x' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'absent', text: 'x' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', control: 99, text: 'x' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', text: 'x' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'title' } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: 'title', text: null } },
  { fn: 'fillDocxContentControl', op: { op: 'set_content_control', tag: '  title  ', text: 7 } },
]);

// paragraph edits
const EDIT_BODY = doc(
  para(`${run('First ', '<w:b/>')}${run('paragraph')}`) +
    para(`${run('Second paragraph')}`, '<w:pStyle w:val="Heading1"/>') +
    table(row(cell(para(run('t1'))))) +
    para(run('Between tables')) +
    table(row(cell(para(run('t2'))))) +
    para('') +
    para(`${run('Tail one')}<w:r><w:tab/></w:r>${run('tail two')}`, '<w:jc w:val="center"/>') +
    para(`${run('x')}${run('y')}${run('z')}`) +
    '<w:p/>' +
    '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr></w:p>',
);
const editSteps = (tracking) => [
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_paragraph_text', paragraph: 1, text: 'Rewritten first', author: 'Eve' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_paragraph_text', paragraph: 2, text: 'tab\there' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_paragraph_text', paragraph: 5, text: 'into an empty paragraph' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_paragraph_text', paragraph: 7, text: 'self closing' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_paragraph_text', paragraph: 8, text: 'with a style only' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_paragraph_text', paragraph: 6, text: undefined } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_run_text', paragraph: 6, run: 2, text: 'Y & <Z>' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_run_text', paragraph: 6, run: 9, text: 'no' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_run_text', paragraph: 5, run: 1, text: 'no' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_run_text', paragraph: 1, run: 1, text: '' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'remove_paragraph', paragraph: 3, author: 'Eve' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'remove_paragraph', paragraph: 4 } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'remove_paragraph', paragraph: 5 } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'move_paragraph', paragraph: 1, index: 3 } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'move_paragraph', paragraph: 5, index: 1 } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'move_paragraph', paragraph: 2, index: 99 } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'move_paragraph', paragraph: 2, index: 0 } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'move_paragraph', paragraph: 3, index: 'x' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_paragraph_text', paragraph: 99, text: 'x' } },
  { fn: 'editDocxParagraph', tracking, op: { op: 'set_paragraph_text', text: 'x' } },
];
sequence('paragraph edits untracked', BASE(EDIT_BODY), editSteps(false));
sequence('paragraph edits tracked', BASE(EDIT_BODY), editSteps(true));
sequence(
  'tracked removal with paragraph properties',
  BASE(doc(para(run('plain')) + para(run('with props'), '<w:jc w:val="left"/>') + para(`${run('with mark')}`, `<w:rPr><w:ins w:id="3" w:author="Eve" w:date="${DATE}"/><w:b/></w:rPr>`) + para(run('keeps'), '<w:rPr><w:b/></w:rPr>') + '<w:p/>' + para(ins(8, 'Eve', run('inserted run'))))),
  [1, 2, 3, 4, 5, 6].map((paragraph) => ({ fn: 'editDocxParagraph', tracking: true, op: { op: 'remove_paragraph', paragraph, author: 'Bo' } })),
);
sequence('paragraph edit in a document without a body', BASE(`${HEAD}<w:document ${W}></w:document>`), [{ fn: 'editDocxParagraph', tracking: false, op: { op: 'set_paragraph_text', paragraph: 1, text: 'x' } }]);

// table cells
const CELL_BODY = doc(
  table(
    row(cell(para(run('H1')), '<w:tcW w:w="2000" w:type="dxa"/><w:shd w:val="clear" w:fill="DDDDDD"/><w:vAlign w:val="bottom"/>') + cell(para(run('H2')), '<w:tcW w:w="2000" w:type="dxa"/>') + cell(para(run('H3')), '<w:tcW w:w="2000" w:type="dxa"/><w:cnfStyle w:val="100000000000"/>')) +
      row(cell(para(run('a1'), '<w:spacing w:line="400" w:lineRule="exact"/>')) + cell(para(run('a2'))) + cell(para(run('a3')))) +
      row(cell(para(run('same'))) + cell(para(run('same'))) + cell(para(run('same')))) +
      row(cell(para(run('same'))) + cell(para(run('same'))) + cell(para(run('same')))) +
      row(cell(para(run('z1')), '<w:gridSpan w:val="2"/>') + cell(para(run('z3')))),
    [2000, 2000, 2000],
  ) + table(row(cell(para(run('second table')))), [3000]),
);
sequence('table cell styles', BASE(CELL_BODY), [
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 1, row: 1, col: 1, properties: { fillColor: 'FFFF00', bold: true, color: '#FF0000', fontSize: 9, fontName: 'Arial', fontNameEastAsia: 'Malgun Gothic' } } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 1, row: 2, col: 1, properties: { fontSize: 22, bold: false, italic: false, horizontalAlignment: 'Center' } } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 1, row: 2, col: 2, properties: { horizontalAlignment: ' RIGHT ', italic: true } } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 1, row: 2, col: 3, properties: { horizontalAlignment: 'diagonal' } } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 1, row: 3, col: 2, properties: { fillColor: null, bold: null } } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 1, row: 3, col: 3, properties: {} } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 2, row: 1, col: 1, properties: { fontSize: 'x', color: '' } } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 1, row: 9, col: 1, properties: {} } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 1, row: 1, col: 9, properties: {} } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'set_table_cell_style', table: 7, row: 1, col: 1, properties: {} } },
]);
sequence('table cell merges', BASE(CELL_BODY), [
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'merge_table_cells', table: 1, row: 1, col: 1, colSpan: 2 } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'merge_table_cells', table: 1, row: 3, col: 1, rowSpan: 2 } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'merge_table_cells', table: 1, row: 4, col: 2, colSpan: 2, rowSpan: 2 } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'merge_table_cells', table: 1, row: 2, col: 1, colSpan: 3, rowSpan: 9 } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'merge_table_cells', table: 1, row: 1, col: 3 } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'merge_table_cells', table: 2, row: 1, col: 1, colSpan: 5, rowSpan: 3 } },
  { fn: 'styleOrMergeDocxTableCell', op: { op: 'merge_table_cells', table: 1, row: 2, col: 9, colSpan: 2 } },
]);

// tracked changes
const MARKED_BODY = doc(
  para(`${run('Keep ')}${del(1, 'Bo', 'gone ')}${ins(2, 'Eve', run('added '))}${run('end')}`) +
    para(run('marked for removal'), mark('del', 3, 'Bo')) +
    para(run('inserted by Eve'), mark('ins', 4, 'Eve')) +
    para(`${ins(5, 'Bo', run('Bo insert'))}${del(6, 'Eve', 'Eve delete')}`) +
    table(row(cell(para(run('row gone'))), `<w:del w:id="7" w:author="Bo" w:date="${DATE}"/>`) + row(cell(para(run('kept row'))))) +
    para(`<w:r><w:rPr><w:b/><w:rPrChange w:id="8" w:author="Eve" w:date="${DATE}"><w:rPr/></w:rPrChange></w:rPr><w:t>reformatted</w:t></w:r>`) +
    para(`${run('Commented ')}<w:commentRangeStart w:id="0"/>${del(9, 'Bo', 'the anchor')}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>`) +
    para(`${run('Kept anchor ')}<w:commentRangeStart w:id="1"/>${run('anchored')}<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>`),
);
const COMMENTS = `${HEAD}<w:comments ${W}><w:comment w:id="0" w:author="Eve" w:date="${DATE}" w:initials="E"><w:p w14:paraId="0000000A"><w:r><w:t>drops with its anchor</w:t></w:r></w:p></w:comment><w:comment w:id="1" w:author="Eve" w:date="${DATE}" w:initials="E"><w:p w14:paraId="0000000B"><w:r><w:t>stays</w:t></w:r></w:p></w:comment><w:comment w:id="2" w:author="Bo" w:date="${DATE}" w:initials="B"><w:p w14:paraId="0000000C"><w:r><w:t>never referenced</w:t></w:r></w:p></w:comment></w:comments>`;
const SIDECARS = {
  'word/commentsExtended.xml': `${HEAD}<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="0000000A" w15:done="0"/><w15:commentEx w15:paraId="0000000B" w15:done="0"/><w15:commentEx w15:paraId="0000000C" w15:paraIdParent="0000000B" w15:done="0"/></w15:commentsEx>`,
  'word/commentsIds.xml': `${HEAD}<w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"><w16cid:commentId w16cid:paraId="0000000A" w16cid:durableId="0F0F0F0A"/><w16cid:commentId w16cid:paraId="0000000C" w16cid:durableId="0F0F0F0C"/></w16cid:commentsIds>`,
  'word/commentsExtensible.xml': `${HEAD}<w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"><w16cex:commentExtensible w16cex:durableId="0F0F0F0A" w16cex:dateUtc="${DATE}"/><w16cex:commentExtensible w16cex:durableId="0F0F0F0C" w16cex:dateUtc="${DATE}"/></w16cex:commentsExtensible>`,
};
const STORY_FOOTER = `${HEAD}<w:ftr ${W}>${para(`${run('footer ')}${ins(20, 'Eve', run('added'))}`)}${para(run('mark'), mark('del', 21, 'Bo'))}</w:ftr>`;
const STORY_FOOTNOTES = `${HEAD}<w:footnotes ${W}><w:footnote w:id="1">${para(`${run('note ')}${del(22, 'Bo', 'old')}`)}</w:footnote></w:footnotes>`;
const REVIEW_FILES = { 'word/comments.xml': COMMENTS, ...SIDECARS, 'word/footer1.xml': STORY_FOOTER, 'word/footnotes.xml': STORY_FOOTNOTES };
const resolve = (op) => ({ fn: 'resolveDocxRevisions', op });
sequence('accept all', BASE(MARKED_BODY, REVIEW_FILES), [resolve({ op: 'resolve_revisions' }), resolve({ op: 'resolve_revisions' })]);
sequence('reject all', BASE(MARKED_BODY, REVIEW_FILES), [resolve({ op: 'resolve_revisions', resolution: 'reject' }), resolve({ op: 'resolve_revisions', resolution: 'Reject' })]);
sequence('settle one reviewer', BASE(MARKED_BODY, REVIEW_FILES), [
  resolve({ op: 'resolve_revisions', author: 'Nobody' }),
  resolve({ op: 'resolve_revisions', author: 'Eve' }),
  resolve({ op: 'resolve_revisions', author: 'Bo', resolution: 'reject' }),
  resolve({ op: 'resolve_revisions', author: 'Eve' }),
]);
sequence('settle one revision', BASE(MARKED_BODY, REVIEW_FILES), [
  resolve({ op: 'resolve_revision', revision: 1 }),
  resolve({ op: 'resolve_revision', revision: 2, resolution: 'reject' }),
  resolve({ op: 'resolve_revision', id: '5' }),
  resolve({ op: 'resolve_revision', id: 6, resolution: 'reject' }),
  resolve({ op: 'resolve_revision', id: '20' }),
  resolve({ op: 'resolve_revision', revision: 99 }),
  resolve({ op: 'resolve_revision', id: '999' }),
  resolve({ op: 'resolve_revision', revision: 1.5 }),
  resolve({ op: 'resolve_revision', revision: 0 }),
  resolve({ op: 'resolve_revision', revision: 'x' }),
  resolve({ op: 'resolve_revision', id: '' }),
  resolve({ op: 'resolve_revision', resolution: 'maybe' }),
  resolve({ op: 'resolve_revisions', resolution: 'maybe' }),
]);
sequence('settle in the footer and the notes', BASE(doc(para(run('body'))), REVIEW_FILES), [
  resolve({ op: 'resolve_revision', revision: 1 }),
  resolve({ op: 'resolve_revisions', author: 'Bo' }),
  resolve({ op: 'resolve_revisions' }),
]);
sequence('no tracked change at all', BASE(doc(para(run('plain')))), [resolve({ op: 'resolve_revisions' }), resolve({ op: 'resolve_revisions', author: 'Eve' }), resolve({ op: 'resolve_revision', revision: 1 })]);
sequence('a deletion that carries a whole anchor', BASE(MARKED_BODY, { 'word/comments.xml': COMMENTS }), [resolve({ op: 'resolve_revisions', author: 'Bo' })]);
sequence(
  'paragraph marks that cannot join',
  BASE(doc(para(run('before table'), mark('del', 1, 'Bo')) + table(row(cell(para(run('cell'))))) + para(run('last'), mark('del', 2, 'Bo')), '')),
  [resolve({ op: 'resolve_revisions' })],
);

const pure_cases = [];
for (const entry of PURE) {
  const call = {
    trackedParagraphRewrite: (...args) => tracked.trackedParagraphRewrite(...args),
    anchorPhraseInParagraph: (xml, find, id, markers) => tracked.anchorPhraseInParagraph(xml, find, id, markers ?? undefined),
    trackedParagraphReplace: (...args) => tracked.trackedParagraphReplace(...args),
    replaceTrackedParagraphs: (...args) => operations.replaceTrackedParagraphs(...args),
    docxTocEntries: (xml, lower, upper, levels) => operations.docxTocEntries(xml, lower, upper, new Map(Object.entries(levels))),
    docxTocCacheRuns: (...args) => operations.docxTocCacheRuns(...args),
    docxStyleDefinitions: (op) => operations.docxStyleDefinitions(op),
  }[entry.fn];
  pure_cases.push({ ...entry, ...(await attempt(async () => call(...entry.args))) });
}

const sequences = [];
for (const entry of SEQUENCES) {
  const zip = await packageOf(entry.files);
  const outputs = [];
  for (const step of entry.steps) outputs.push(await attempt(() => runStep(zip, step)));
  sequences.push({ ...entry, outputs, snapshot: await snapshotOf(zip) });
}

writeJson(join(stage, 'golden.json'), { pure: pure_cases, sequences });
writeSetManifest(stage, { set: 'office-docx-operations', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
