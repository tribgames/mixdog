#!/usr/bin/env node
// What the portable Word part writers and the run walkers answer (src/runtime/office/portable: portable-docx-parts and
// docx-runs), run through Node: the numbering, note, comment, header, footer, settings and picture parts a Word package is given,
// the section-properties upsert, the tracked-change attributes, the run normaliser and the story settler. Rust `mixdog-ooxml`
// must answer the same: the returned values and the text of every part, exactly (crates/mixdog-ooxml/tests/twin_docx_parts.rs).
//
//   node benchmarks/rust-core/recorders/record-office-docx-parts.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-docx-parts/golden.json. The recording holds `pure` (a function name, its arguments and its
// result or error; a callback argument is written as a small object naming what the callback does) and `sequences` (steps over
// one package: each step's output, then the package's names and every part's text). A time of day in an answer is scrubbed by
// the replay on both sides.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-docx-parts');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-docx-parts.mjs';
const parts = await importFrom(tree, 'src/runtime/office/portable/portable-docx-parts.mjs');
const runs = await importFrom(tree, 'src/runtime/office/portable/docx-runs.mjs');
const JSZip = createRequire(join(tree, 'package.json'))('jszip');
const work = mkdtempSync(join(tmpdir(), 'mixdog-docx-parts-'));

const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const scrub = (text) => String(text).split(work).join('<work>').split('<work>\\').join('<work>/');

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
const para = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const doc = (body, tail = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>') =>
  `${HEAD}<w:document ${W}><w:body>${body}${tail}</w:body></w:document>`;
const STYLES = (...ids) =>
  `${HEAD}<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${ids.join('')}</w:styles>`;
const BASE_DOCUMENT = doc(para(run('Hello')) + para(run('World')));
const BASE = {
  '[Content_Types].xml': TYPES(),
  '_rels/.rels': RELS(['rId1', 'officeDocument', 'word/document.xml']),
  'word/document.xml': BASE_DOCUMENT,
  'word/_rels/document.xml.rels': RELS(['rId1', 'styles', 'styles.xml']),
  'word/styles.xml': STYLES(),
};
const { 'word/_rels/document.xml.rels': _rels, 'word/styles.xml': _styles, ...bare } = BASE;

const ins = (id, author, inner, tag = 'ins') => `<w:${tag} w:id="${id}" w:author="${author}" w:date="${DATE}">${inner}</w:${tag}>`;
const gone = (text) => `<w:r><w:delText xml:space="preserve">${text}</w:delText></w:r>`;
const cell = (inner, props = '') => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ''}${inner}</w:tc>`;
const row = (cells, props = '') => `<w:tr>${props ? `<w:trPr>${props}</w:trPr>` : ''}${cells}</w:tr>`;
const table = (rows) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>${rows}</w:tbl>`;
const mark = (tag, id, author) => `<w:rPr><w:${tag} w:id="${id}" w:author="${author}" w:date="${DATE}"/></w:rPr>`;

const SECTION_ONE =
  '<w:sectPr><w:headerReference w:type="default" r:id="rId5"/><w:footerReference w:type="default" r:id="rId6"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134"/><w:cols w:space="720"/></w:sectPr>';
const SECTION_TWO =
  '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="567" w:bottom="720" w:left="1134"/><w:titlePg/></w:sectPr>';
const SECTIONED = doc(para(run('first')) + para('', SECTION_ONE) + para(run('second')) + para(run('third'), SECTION_TWO.replace(/^<w:sectPr>/, '<w:sectPr w:rsidR="00A1">')), SECTION_TWO);
const SECTIONED_NO_TRAILING = doc(para(run('only')), '');
const NO_BODY = `${HEAD}<w:document ${W}></w:document>`;
const REORDERED = doc(para(run('x')), '<w:sectPr><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>');

const NUMBERED_PART = (...inner) => `${HEAD}<w:numbering ${W}>${inner.join('')}</w:numbering>`;
const LEVEL = (index, format, text) => `<w:lvl w:ilvl="${index}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/></w:lvl>`;
const WORD_BULLETS = `<w:abstractNum w:abstractNumId="0">${LEVEL(0, 'decimal', '•')}${LEVEL(1, 'decimal', '◦')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
const WORD_NUMBERS = `<w:abstractNum w:abstractNumId="1">${LEVEL(0, 'decimal', '%1.')}${LEVEL(1, 'lowerLetter', '%2.')}</w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`;
const WORD_KOREAN = `<w:abstractNum w:abstractNumId="2">${LEVEL(0, 'decimal', '%1.')}${LEVEL(1, 'ganada', '%2.')}</w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>`;
const ITEM = (numId, text) => para(run(text), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`);

// ---- the pure functions -------------------------------------------------------------------------------------------
const mutation = (spec) => {
  if (spec.op === 'child') return (xml) => parts.upsertSectionChild(xml, spec.tag, spec.element);
  if (spec.op === 'reference') return (xml) => parts.upsertSectionReference(xml, spec.tag, spec.kind, spec.id);
  throw new Error(`unknown mutation ${spec.op}`);
};
const PURE = [];
const pure = (fn, args) => PURE.push({ fn, args });

// run normalisation
const RUNS = {
  split: para(`${run('Hel', '<w:b/>', ' w:rsidR="00A1" w:rsidRPr="00B2"')}<w:proofErr w:type="spellStart"/>${run('lo ', '<w:b/>', ' w:rsidR="00C3"')}${run('wor', '<w:b/>')}<w:proofErr w:type="spellEnd"/>${run('ld', '<w:b/>')}`),
  differentFormat: para(`${run('a', '<w:b/>')}${run('b', '<w:i/>')}${run('c', '<w:i/>')}${run('d')}`),
  emptyProperties: para(`<w:r><w:rPr/><w:t>one </w:t></w:r><w:r><w:rPr></w:rPr><w:t>two</w:t></w:r><w:r><w:t xml:space="preserve"> three</w:t></w:r>`),
  betweenText: para(`${run('a')}${'<w:bookmarkStart w:id="0" w:name="x"/>'}${run('b')}${run('c')}`),
  wrappers: para(`${run('keep')}${ins(1, 'Bo', run('added'))}${run('keep')}`),
  twoTexts: '<w:p><w:r><w:t>a</w:t><w:t xml:space="preserve"> b</w:t><w:t>c </w:t><w:t>d</w:t></w:r></w:p>',
  deleted: '<w:p><w:r><w:delText>x</w:delText><w:delText xml:space="preserve"> y</w:delText></w:r></w:p>',
  entities: '<w:p><w:r><w:t>a &amp; </w:t><w:t>&lt;b&gt;</w:t></w:r><w:r><w:t>&#x41;</w:t></w:r></w:p>',
  unicode: para(`${run('가나', '<w:rFonts w:eastAsia="Malgun Gothic"/>')}${run('다라', '<w:rFonts w:eastAsia="Malgun Gothic"/>')}${run('😀')}`),
  withTab: para(`${run('a')}<w:r><w:tab/></w:r>${run('b')}<w:r><w:br/></w:r>`),
  selfClosing: '<w:p><w:r w:rsidR="1"/><w:r><w:t>x</w:t></w:r></w:p>',
};
for (const xml of Object.values(RUNS)) pure('normalizeDocxRuns', [xml]);
pure('normalizeDocxRuns', ['']);
pure('normalizeDocxRuns', ['<w:p/>']);

// story settling
const MARKED_BODY = doc(
  [
    para(`${run('Keep ')}${ins(1, 'Bo', gone('gone'), 'del')}`, mark('del', 20, 'Bo')),
    para(run('joined into the one above'), '<w:pStyle w:val="Heading1"/>'),
    para(run('inserted mark'), mark('ins', 21, 'Eve')),
    para(run('last with a deleted mark'), mark('del', 22, 'Bo')),
  ].join(''),
  '',
);
const MARKED_TABLE = doc(
  para(run('before')) +
    table(
      row(cell(para(run('cell one'), mark('del', 30, 'Bo')) + para(run('cell two')))) +
        row(cell(para(run('removed row'))), `<w:del w:id="31" w:author="Bo" w:date="${DATE}"/>`) +
        row(cell(para(run('added row'))), `<w:ins w:id="32" w:author="Eve" w:date="${DATE}"/>`) +
        row(cell(para(run('plain row'))))
    ) +
    para(run('after'), mark('del', 33, 'Bo')) +
    table(row(cell(para(run('ends the document'), mark('del', 34, 'Bo'))))),
  ''
);
const NESTED_TABLE = doc(
  table(row(cell(para(run('outer')) + table(row(cell(para(run('inner'), mark('ins', 40, 'Eve'))), `<w:del w:id="41" w:author="Bo" w:date="${DATE}"/>`)), ''))),
  ''
);
const FORMATTING = doc(
  `<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="50" w:author="Bo" w:date="${DATE}"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>` +
    `<w:r><w:rPr><w:b/><w:rPrChange w:id="51" w:author="Eve" w:date="${DATE}"><w:rPr/></w:rPrChange></w:rPr><w:t>styled</w:t></w:r></w:p>`,
  ''
);
const MIXED = doc(
  para(`${run('a ')}${ins(60, 'Bo', run('b '))}${ins(61, 'Eve', gone('c '), 'del')}${run('d')}`, mark('ins', 62, 'Bo')) + para(run('next'), mark('del', 63, 'Eve')) + para(run('tail')),
  ''
);
const STORY_FOOTER = `${HEAD}<w:ftr ${W}>${para(run('page'), mark('del', 70, 'Bo'))}${para(run('two'))}</w:ftr>`;
const STORY_FOOTNOTES = `${HEAD}<w:footnotes ${W}><w:footnote w:id="1">${para(run('one'), mark('del', 71, 'Bo'))}</w:footnote><w:footnote w:id="2">${para(run('two'))}</w:footnote></w:footnotes>`;
const STORY_ENDNOTES = `${HEAD}<w:endnotes ${W}><w:endnote w:id="1">${para(run('n1'), mark('ins', 72, 'Eve'))}</w:endnote></w:endnotes>`;
const STORY_UNKNOWN = `${HEAD}<w:comments ${W}><w:comment w:id="0">${para(run('c'), mark('del', 73, 'Bo'))}</w:comment></w:comments>`;
const SETTLE_DOCUMENTS = [MARKED_BODY, MARKED_TABLE, NESTED_TABLE, FORMATTING, MIXED, STORY_FOOTER, STORY_FOOTNOTES, STORY_ENDNOTES, STORY_UNKNOWN, BASE_DOCUMENT];
for (const xml of SETTLE_DOCUMENTS) {
  pure('settleDocxStory', [xml, {}]);
  pure('settleDocxStory', [xml, { resolution: 'reject' }]);
}
for (const author of ['Bo', 'Eve', 'Nobody']) {
  pure('settleDocxStory', [MARKED_BODY, { author }]);
  pure('settleDocxStory', [MARKED_TABLE, { resolution: 'reject', author }]);
  pure('settleDocxStory', [MIXED, { author, resolution: 'accept' }]);
}
pure('settleDocxStory', [MIXED, { target: 1 }]);
pure('settleDocxStory', [MIXED, { target: 2, resolution: 'reject' }]);
pure('settleDocxStory', [MIXED, { id: '61' }]);
pure('settleDocxStory', [FORMATTING, { resolution: 'reject', author: 'Bo' }]);
pure('settleDocxStory', ['', {}]);

// sections
pure('trailingSectionProperties', [SECTIONED]);
pure('trailingSectionProperties', [SECTIONED_NO_TRAILING]);
pure('trailingSectionProperties', [NO_BODY]);
pure('documentSectionSpans', [SECTIONED]);
pure('documentSectionSpans', [SECTIONED_NO_TRAILING]);
pure('documentSectionSpans', [NO_BODY]);
const HEADING_CHILD = { op: 'child', tag: 'titlePg', element: '<w:titlePg/>' };
const COLS_CHILD = { op: 'child', tag: 'cols', element: '<w:cols w:num="2" w:space="360"/>' };
const PGSZ_CHILD = { op: 'child', tag: 'pgSz', element: '<w:pgSz w:w="1" w:h="2"/>' };
const FOOTER_REFERENCE = { op: 'reference', tag: 'footerReference', kind: 'default', id: 'rId9' };
const FIRST_REFERENCE = { op: 'reference', tag: 'headerReference', kind: 'first', id: 'rId10' };
for (const document of [SECTIONED, SECTIONED_NO_TRAILING, REORDERED, NO_BODY]) {
  for (const section of [undefined, null, '', 1, '2', 3, 4, 0, -1, 1.5, 'x']) {
    for (const spec of [HEADING_CHILD, FIRST_REFERENCE]) {
      pure('writeSectionPropertiesAt', [document, section ?? null, spec]);
      pure('writeEverySectionProperties', [document, section ?? null, spec]);
    }
  }
}
pure('writeEverySectionProperties', [SECTIONED, null, FOOTER_REFERENCE]);
pure('writeSectionPropertiesAt', [SECTIONED, 2, COLS_CHILD]);
for (const spec of [HEADING_CHILD, COLS_CHILD, PGSZ_CHILD, { op: 'child', tag: 'type', element: '<w:type w:val="nextPage"/>' }, { op: 'child', tag: 'docGrid', element: '<w:docGrid w:linePitch="300"/>' }, { op: 'child', tag: 'unknownTag', element: '<w:unknownTag/>' }, { op: 'child', tag: 'footerReference', element: '<w:footerReference w:type="even" r:id="rId3"/>' }]) {
  for (const section of [SECTION_ONE, SECTION_TWO, '<w:sectPr></w:sectPr>', '<w:sectPr/>', '<w:sectPr><w:titlePg/><w:cols/></w:sectPr>', '<w:sectPr w:rsidR="1"><w:pgMar/><w:cols w:space="1"/><w:titlePg/></w:sectPr>', '<w:sectPr>']) {
    pure('upsertSectionChild', [section, spec.tag, spec.element]);
  }
}
for (const section of [SECTION_ONE, SECTION_TWO, '<w:sectPr/>', '<w:sectPr></w:sectPr>']) {
  pure('upsertSectionReference', [section, 'headerReference', 'default', 'rId7']);
  pure('upsertSectionReference', [section, 'headerReference', 'first', 'rId8']);
  pure('upsertSectionReference', [section, 'footerReference', 'default', 'rId9']);
}

// small helpers
for (const id of [0, 1, 255, 4096, 123456, 268435455]) pure('commentParagraphId', [id]);
pure('numberedListScheme', ['가나다', undefined]);
pure('numberedListScheme', ['Plain text', undefined]);
pure('numberedListScheme', ['가나다', 'global']);
pure('numberedListScheme', ['Plain', 'KOREAN']);
pure('numberedListScheme', [undefined, undefined]);
pure('numberedListScheme', ['x', 'roman']);
pure('numberedListScheme', ['x', null]);
pure('numberedListScheme', ['x', 'Global']);
pure('numberedListScheme', ['한글 and English', '']);
for (const args of [
  [{ id: 1, embedId: 'rId4', name: 'image1.png', width: 100, height: 50 }],
  [{ id: 2, embedId: 'rId5', name: 'a "q" & <b>.png', width: 0, height: 0.2, altText: '  A chart & its <legend>  ' }],
  [{ id: 3, embedId: 'rId6', name: '그림.png', width: 72.5, height: 36.25, altText: '   ' }],
  [{ id: 4, embedId: 'rId7', name: 'x.png', width: 1e3, height: 1.5e-9, altText: null }],
  [{ id: 5, embedId: 'rId8', name: 'x.png', width: Number.NaN, height: 10, altText: 'nan' }],
]) pure('wordDrawingXml', args);
for (const xml of [BASE_DOCUMENT, doc(ins(5, 'A', run('x'), 'ins') + ins(9, 'B', run('y'), 'del') + `<w:del w:id="12" w:author="C"/>`), '', '<w:ins w:id="x"/>', doc('<w:ins w:author="z" w:id="7"></w:ins>')]) pure('nextRevisionId', [xml]);
const PARAGRAPHS = [
  '<w:p><w:r><w:t>plain</w:t></w:r></w:p>',
  '<w:p w14:paraId="1"><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>with properties</w:t></w:r></w:p>',
  '<w:p/>',
  '<w:p></w:p>',
  '<w:pPr/>text',
  '<w:p><w:pPr><w:pStyle w:val="A"/></w:pPr></w:p>',
  'no paragraph at all',
];
for (const xml of PARAGRAPHS) {
  pure('anchorDocxComment', [xml, 7]);
  pure('anchorDocxComment', [xml, '12']);
  pure('markRunsDeleted', [xml, 5, 'Reviewer & Co']);
}
pure('markRunsDeleted', ['<w:p><w:r><w:t xml:space="preserve">a </w:t></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:t>b</w:t><w:tab/></w:r></w:p>', 10, '']);
pure('markRunsDeleted', ['<w:p><w:r w:rsidR="1"><w:tbl/></w:r><w:r><w:t>b</w:t></w:r></w:p>', 1, undefined]);
pure('revisionAttributes', [3, 'Ann']);
pure('revisionAttributes', [4, '']);
pure('revisionAttributes', [5, 'A & "B"']);

const pure_cases = [];
for (const entry of PURE) {
  const call = {
    normalizeDocxRuns: (xml) => runs.normalizeDocxRuns(xml),
    settleDocxStory: (xml, options) => runs.settleDocxStory(xml, options),
    trailingSectionProperties: (xml) => {
      const found = parts.trailingSectionProperties(xml);
      return { index: found.match?.index ?? null, text: found.match?.[0] ?? null, bodyStart: found.model.body.start, bodyEnd: found.model.body.end };
    },
    documentSectionSpans: (xml) => parts.documentSectionSpans(xml).spans,
    writeSectionPropertiesAt: (xml, section, spec) => parts.writeSectionPropertiesAt(xml, section ?? undefined, mutation(spec)),
    writeEverySectionProperties: (xml, section, spec) => parts.writeEverySectionProperties(xml, section ?? undefined, mutation(spec)),
    upsertSectionChild: (...args) => parts.upsertSectionChild(...args),
    upsertSectionReference: (...args) => parts.upsertSectionReference(...args),
    commentParagraphId: (id) => parts.commentParagraphId(id),
    numberedListScheme: (...args) => parts.numberedListScheme(...args),
    wordDrawingXml: (spec) => parts.wordDrawingXml(spec),
    nextRevisionId: (xml) => parts.nextRevisionId(xml),
    anchorDocxComment: (...args) => parts.anchorDocxComment(...args),
    markRunsDeleted: (...args) => parts.markRunsDeleted(...args),
    revisionAttributes: (...args) => parts.revisionAttributes(...args),
  }[entry.fn];
  pure_cases.push({ ...entry, ...(await attempt(async () => call(...entry.args))) });
}

// ---- the sequences over one package -------------------------------------------------------------------------------
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 4, 8, 6, 0, 0, 0]).toString('base64');
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 5, 0, 0, 0, 0]).toString('base64');
const TEXT_FILE = Buffer.from('not a picture').toString('base64');

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
const composer = (spec) => (existing) => {
  if (spec.kind === 'append') return `${existing}${spec.text}`;
  if (spec.kind === 'wrap') return `<w:p>${existing}</w:p>${spec.text}`;
  return spec.text;
};
const runStep = async (state, step) => {
  const zip = state.zip;
  switch (step.op) {
    case 'ensureNotePart': {
      const note = await parts.ensureNotePart(zip, step.kind);
      return { part: note.part, root: note.root, tag: note.tag, reference: note.reference, style: note.style, textStyle: note.textStyle, contentType: note.contentType, relationship: note.relationship, xml: note.xml };
    }
    case 'ensureCommentsPart':
      return await parts.ensureCommentsPart(zip);
    case 'registerCommentThread':
      return await parts.registerCommentThread(zip, step.arg);
    case 'registerCommentIdentity':
      return await parts.registerCommentIdentity(zip, step.arg);
    case 'forgetCommentIdentity':
      return await parts.forgetCommentIdentity(zip, step.xml);
    case 'writeHeaderFooterPart':
      return await parts.writeHeaderFooterPart(zip, { header: step.header, body: composer(step.body), documentXml: step.documentXml, kind: step.kind });
    case 'ensureDocxUpdateFields':
      return await parts.ensureDocxUpdateFields(zip);
    case 'ensureNumbering': {
      const made = await parts.ensureNumbering(zip, step.kind, step.options ?? {});
      return made;
    }
    case 'appendedNumbering':
      return await parts.appendedNumbering(zip, step.documentXml, step.options);
    case 'numberingAfter':
      return await parts.numberingAfter(zip, step.before, step.options);
    case 'documentTracksChanges':
      return await parts.documentTracksChanges(zip);
    case 'addDocumentImage': {
      const path = join(work, step.file);
      writeFileSync(path, Buffer.from(step.base64, 'base64'));
      const added = await parts.addDocumentImage(zip, step.missing ? join(work, 'absent', step.file) : path);
      return { ...added };
    }
    case 'set':
      zip.file(step.name, step.text);
      return null;
    case 'remove':
      zip.remove(step.name);
      return null;
    default:
      throw new Error(`unknown step ${step.op}`);
  }
};

const SEQUENCES = [];
const sequence = (name, files, steps) => SEQUENCES.push({ name, files, steps });

sequence('footnote part in a package with styles', BASE, [
  { op: 'ensureNotePart', kind: 'footnote' },
  { op: 'ensureNotePart', kind: 'footnote' },
  { op: 'ensureNotePart', kind: 'endnote' },
  { op: 'ensureNotePart', kind: 'Endnote' },
  { op: 'ensureNotePart', kind: '' },
  { op: 'ensureNotePart', kind: 'sidenote' },
]);
sequence('note part without styles or relationships', bare, [{ op: 'ensureNotePart', kind: 'footnote' }, { op: 'ensureNotePart', kind: 'endnote' }]);
sequence('note styles that exist', { ...BASE, 'word/styles.xml': STYLES('<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/></w:style>', '<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/></w:style>') }, [
  { op: 'ensureNotePart', kind: 'footnote' },
  { op: 'ensureNotePart', kind: 'endnote' },
]);
sequence('a note part that is already there', { ...BASE, 'word/footnotes.xml': `${HEAD}<w:footnotes ${W}><w:footnote w:id="1">${para(run('mine'))}</w:footnote></w:footnotes>` }, [{ op: 'ensureNotePart', kind: 'footnote' }]);
sequence('comments with threads and identities', BASE, [
  { op: 'ensureCommentsPart' },
  { op: 'registerCommentThread', arg: { commentId: 0 } },
  { op: 'registerCommentThread', arg: { commentId: 1, parentId: 0, done: false } },
  { op: 'registerCommentThread', arg: { commentId: 2, parentId: 1, done: true } },
  { op: 'registerCommentThread', arg: { commentId: 2, parentId: 0, done: false } },
  { op: 'registerCommentIdentity', arg: { commentId: 0, date: DATE } },
  { op: 'registerCommentIdentity', arg: { commentId: 1, date: '2026-03-04T10:00:00Z' } },
  { op: 'registerCommentIdentity', arg: { commentId: 1, date: '2026-03-04T10:00:00Z' } },
  { op: 'registerCommentIdentity', arg: { commentId: 77, date: 'a "b" & <c>' } },
  { op: 'registerCommentIdentity', arg: { commentId: 3000000, date: DATE } },
  { op: 'ensureCommentsPart' },
]);
sequence('forgetting a comment', BASE, [
  { op: 'registerCommentThread', arg: { commentId: 4 } },
  { op: 'registerCommentThread', arg: { commentId: 5, parentId: 4 } },
  { op: 'registerCommentIdentity', arg: { commentId: 4, date: DATE } },
  { op: 'registerCommentIdentity', arg: { commentId: 5, date: DATE } },
  { op: 'forgetCommentIdentity', xml: `<w:comment w:id="4"><w:p w14:paraId="${parts.commentParagraphId(4)}"><w:r><w:t>x</w:t></w:r></w:p></w:comment>` },
  { op: 'forgetCommentIdentity', xml: `<w:comment w:id="4"><w:p w14:paraId="${parts.commentParagraphId(4)}"/></w:comment>` },
  { op: 'forgetCommentIdentity', xml: '<w:comment w:id="9"><w:p><w:r><w:t>no id</w:t></w:r></w:p></w:comment>' },
  { op: 'forgetCommentIdentity', xml: '<w:comment><w:p w14:paraId="DEADBEEF"/></w:comment>' },
  { op: 'forgetCommentIdentity', xml: `<w:comment><w:p w14:paraId="${parts.commentParagraphId(5).toLowerCase()}"/></w:comment>` },
]);
sequence('forgetting without sidecars', BASE, [{ op: 'forgetCommentIdentity', xml: '<w:comment><w:p w14:paraId="0000AAAA"/></w:comment>' }]);
sequence('forgetting a comment Word wrote', {
  ...BASE,
  'word/commentsExtended.xml': `${HEAD}<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="1A2B3C4D" w15:done="0"/><w15:commentEx w15:paraId="5E6F7A8B" w15:paraIdParent="1A2B3C4D" w15:done="0"/></w15:commentsEx>`,
  'word/commentsIds.xml': `${HEAD}<w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"><w16cid:commentId w16cid:paraId="1A2B3C4D" w16cid:durableId="0F0F0F0F"/><w16cid:commentId w16cid:paraId="5E6F7A8B" w16cid:durableId="0E0E0E0E"/></w16cid:commentsIds>`,
  'word/commentsExtensible.xml': `${HEAD}<w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"><w16cex:commentExtensible w16cex:durableId="0F0F0F0F" w16cex:dateUtc="${DATE}"/></w16cex:commentsExtensible>`,
}, [
  { op: 'forgetCommentIdentity', xml: '<w:comment><w:p w14:paraId="1A2B3C4D"/></w:comment>' },
  { op: 'forgetCommentIdentity', xml: '<w:comment><w:p w14:paraId="5E6F7A8B"/></w:comment>' },
]);
sequence('headers and footers', { ...BASE, 'word/document.xml': SECTIONED, 'word/_rels/document.xml.rels': RELS(['rId1', 'styles', 'styles.xml'], ['rId5', 'header', 'header7.xml'], ['rId6', 'footer', 'footer7.xml']), 'word/header7.xml': `${HEAD}<w:hdr ${W} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">${para(run('Word header'))}</w:hdr>`, 'word/footer7.xml': 'not a footer' }, [
  { op: 'writeHeaderFooterPart', header: true, body: { kind: 'text', text: para(run('new header')) }, documentXml: '', kind: '' },
  { op: 'writeHeaderFooterPart', header: false, body: { kind: 'text', text: para(run('new footer')) }, documentXml: '', kind: '' },
  { op: 'writeHeaderFooterPart', header: true, body: { kind: 'append', text: para(run(' added')) }, documentXml: SECTIONED, kind: 'default' },
  { op: 'writeHeaderFooterPart', header: false, body: { kind: 'text', text: para(run('replaced')) }, documentXml: SECTIONED, kind: 'default' },
  { op: 'writeHeaderFooterPart', header: true, body: { kind: 'text', text: para(run('first page')) }, documentXml: SECTIONED, kind: 'first' },
  { op: 'writeHeaderFooterPart', header: true, body: { kind: 'text', text: para(run('again')) }, documentXml: SECTIONED, kind: '' },
  { op: 'writeHeaderFooterPart', header: false, body: { kind: 'text', text: para(run('no kind')) }, documentXml: SECTIONED, kind: 'even' },
]);
sequence('a header the section references but the package lacks', { ...BASE, 'word/_rels/document.xml.rels': RELS(['rId5', 'header', 'missing.xml'], ['rId6', 'footer', '/word/footer1.xml']) }, [
  { op: 'writeHeaderFooterPart', header: true, body: { kind: 'text', text: para(run('h')) }, documentXml: SECTIONED, kind: 'default' },
  { op: 'writeHeaderFooterPart', header: false, body: { kind: 'text', text: para(run('f')) }, documentXml: SECTIONED, kind: 'default' },
]);
sequence('update fields and the settings part', BASE, [
  { op: 'documentTracksChanges' },
  { op: 'ensureDocxUpdateFields' },
  { op: 'ensureDocxUpdateFields' },
  { op: 'documentTracksChanges' },
  { op: 'set', name: 'word/settings.xml', text: `${HEAD}<w:settings ${W}><w:zoom w:percent="100"/><w:trackRevisions/><w:compat/></w:settings>` },
  { op: 'documentTracksChanges' },
  { op: 'ensureDocxUpdateFields' },
  { op: 'set', name: 'word/settings.xml', text: `${HEAD}<w:settings ${W}><w:trackRevisions w:val="false"/></w:settings>` },
  { op: 'documentTracksChanges' },
  { op: 'ensureDocxUpdateFields' },
]);
sequence('bullet and numbered lists in a bare package', bare, [
  { op: 'ensureNumbering', kind: 'bullet' },
  { op: 'ensureNumbering', kind: 'bullet' },
  { op: 'ensureNumbering', kind: 'number' },
  { op: 'ensureNumbering', kind: 'number', options: { restart: true } },
  { op: 'ensureNumbering', kind: 'number', options: { restart: true } },
  { op: 'ensureNumbering', kind: 'korean' },
  { op: 'ensureNumbering', kind: 'korean', options: { restart: true } },
  { op: 'ensureNumbering', kind: 'bullet', options: { restart: true } },
  { op: 'ensureNumbering', kind: 'nonsense' },
]);
sequence('lists in a package Word wrote', { ...BASE, 'word/numbering.xml': NUMBERED_PART(WORD_BULLETS, WORD_NUMBERS, WORD_KOREAN) }, [
  { op: 'ensureNumbering', kind: 'bullet' },
  { op: 'ensureNumbering', kind: 'number' },
  { op: 'ensureNumbering', kind: 'korean' },
  { op: 'ensureNumbering', kind: 'number', options: { restart: true } },
  { op: 'ensureNumbering', kind: 'korean', options: { restart: true } },
  { op: 'ensureNumbering', kind: 'bullet', options: { restart: true } },
]);
sequence('a numbering part with no definitions', { ...BASE, 'word/numbering.xml': NUMBERED_PART() }, [{ op: 'ensureNumbering', kind: 'number' }, { op: 'ensureNumbering', kind: 'bullet' }]);
sequence('a numbering part with an unused definition', { ...BASE, 'word/numbering.xml': NUMBERED_PART('<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>') }, [
  { op: 'ensureNumbering', kind: 'number' },
  { op: 'ensureNumbering', kind: 'number', options: { restart: true } },
]);
const LISTED_BODY = (...items) => doc(items.join(''));
sequence('the list an appended item belongs to', { ...BASE, 'word/numbering.xml': NUMBERED_PART(WORD_BULLETS, WORD_NUMBERS, WORD_KOREAN) }, [
  { op: 'appendedNumbering', documentXml: LISTED_BODY(ITEM(2, 'one'), ITEM(2, 'two')), options: {} },
  { op: 'appendedNumbering', documentXml: LISTED_BODY(ITEM(2, 'one'), para(run('heading'))), options: {} },
  { op: 'appendedNumbering', documentXml: LISTED_BODY(ITEM(2, 'one'), para(run('heading'))), options: { continued: true } },
  { op: 'appendedNumbering', documentXml: LISTED_BODY(ITEM(3, '가'), para(run('plain'))), options: { continued: true, scheme: 'korean' } },
  { op: 'appendedNumbering', documentXml: LISTED_BODY(ITEM(1, 'bullet')), options: { continued: true } },
  { op: 'appendedNumbering', documentXml: LISTED_BODY(ITEM(2, 'one'), table(row(cell(para(run('t'))))) ), options: {} },
  { op: 'appendedNumbering', documentXml: LISTED_BODY(ITEM(1, 'a'), ITEM(2, 'b'), ITEM(1, 'c')), options: { scheme: 'korean' } },
  { op: 'appendedNumbering', documentXml: '<w:body><w:p><w:r><w:t>no section</w:t></w:r></w:p></w:body>', options: {} },
  { op: 'appendedNumbering', documentXml: '<w:p/>', options: { continued: true, scheme: 'number' } },
  { op: 'appendedNumbering', documentXml: '', options: {} },
  { op: 'numberingAfter', before: `${ITEM(3, 'x')}${para(run('after'))}`, options: {} },
  { op: 'numberingAfter', before: `${ITEM(2, 'x')}\n  `, options: { scheme: 'korean' } },
  { op: 'numberingAfter', before: `<w:p w:x="1"><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:p>`, options: {} },
  { op: 'numberingAfter', before: '', options: { continued: true } },
  { op: 'numberingAfter', before: '<w:numId w:val="9"/><w:p><w:numPr/>x</w:p><w:numId w:val="3"/>', options: { continued: true } },
]);
sequence('the list of an item in a package without numbering', bare, [
  { op: 'appendedNumbering', documentXml: LISTED_BODY(ITEM(2, 'one')), options: {} },
  { op: 'numberingAfter', before: ITEM(2, 'one'), options: { continued: true, scheme: 'korean' } },
]);
sequence('pictures', BASE, [
  { op: 'addDocumentImage', file: 'one.PNG', base64: PNG },
  { op: 'addDocumentImage', file: 'one.png', base64: PNG },
  { op: 'addDocumentImage', file: 'two.gif', base64: GIF },
  { op: 'addDocumentImage', file: 'three.jpeg', base64: TEXT_FILE },
  { op: 'addDocumentImage', file: 'four.webp', base64: PNG },
  { op: 'addDocumentImage', file: 'noext', base64: PNG },
  { op: 'addDocumentImage', file: 'five.pdf', base64: PNG },
  { op: 'addDocumentImage', file: 'six.png', base64: PNG, missing: true },
  { op: 'addDocumentImage', file: '.png', base64: PNG },
]);
sequence('a picture in a package without relationships', bare, [{ op: 'addDocumentImage', file: 'only.png', base64: PNG }]);
sequence('a part that is already there', BASE, [
  { op: 'set', name: 'word/comments.xml', text: `${HEAD}<w:comments ${W}><w:comment w:id="3"/></w:comments>` },
  { op: 'ensureCommentsPart' },
  { op: 'remove', name: 'word/comments.xml' },
  { op: 'ensureCommentsPart' },
]);

const sequences = [];
for (const entry of SEQUENCES) {
  const state = { zip: await packageOf(entry.files) };
  const outputs = [];
  for (const step of entry.steps) {
    const answered = await attempt(() => runStep(state, step));
    outputs.push(answered.error === undefined ? answered : { error: scrub(answered.error) });
  }
  sequences.push({ ...entry, outputs, snapshot: await snapshotOf(state.zip) });
}
rmSync(work, { recursive: true, force: true });

writeJson(join(stage, 'golden.json'), { pure: pure_cases, sequences });
writeSetManifest(stage, { set: 'office-docx-parts', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
