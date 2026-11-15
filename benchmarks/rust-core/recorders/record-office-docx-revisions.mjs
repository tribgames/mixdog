#!/usr/bin/env node
// What the portable Word-revision, package-validation and chart-fault modules answer (src/runtime/office/portable:
// docx-revisions, portable-validation-package, portable-chart-faults), run through Node. Rust `mixdog-ooxml` must answer the
// same: the revision tree and the audit, lint and resolve functions, the issue lists of the package checks (the XML parts
// are parsed by jsdom/saxes, whose messages the model sees) and the chart faults
// (crates/mixdog-ooxml/tests/twin_docx_revisions.rs).
//
//   node benchmarks/rust-core/recorders/record-office-docx-revisions.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-docx-revisions/golden.json. The recording holds `pure` (a function name, its
// arguments and its result or error), `packages` (the files of a package, and what validatePortableOoxml answered for it;
// a path inside the work directory is written <work>/...) and `charts` (packages scanned for chart faults).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-docx-revisions');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-docx-revisions.mjs';
const revisions = await importFrom(tree, 'src/runtime/office/portable/docx-revisions.mjs');
const validation = await importFrom(tree, 'src/runtime/office/portable/portable-validation-package.mjs');
const charts = await importFrom(tree, 'src/runtime/office/portable/portable-chart-faults.mjs');
const JSZip = createRequire(join(tree, 'package.json'))('jszip');

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-docx-revisions-'));
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const scrub = (value) => {
  if (typeof value === 'string') return value.split(work).join('<work>').split('<work>\\').join('<work>/');
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return value;
};

// ---- Word markup -------------------------------------------------------------------------------------------------
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DATE = '2026-01-01T00:00:00Z';
const doc = (body) => `<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`;
const para = (...inner) => `<w:p>${inner.join('')}</w:p>`;
const run = (text, preserve = true) => `<w:r><w:t${preserve ? ' xml:space="preserve"' : ''}>${text}</w:t></w:r>`;
const deleted = (text, preserve = true) => `<w:r><w:delText${preserve ? ' xml:space="preserve"' : ''}>${text}</w:delText></w:r>`;
const ins = (id, author, inner, date = DATE, tag = 'ins') => `<w:${tag} w:id="${id}" w:author="${author}" w:date="${date}">${inner}</w:${tag}>`;
const del = (id, author, inner, date = DATE, tag = 'del') => `<w:${tag} w:id="${id}" w:author="${author}" w:date="${date}">${inner}</w:${tag}>`;

const long = '가나다라마바사아자차카타파하'.repeat(20);
const MIXED = [
  para(run('Hello '), del(1, 'Bo', deleted('world')), ins(2, 'Bo', run('there'))),
  para(run('두 번째 문단'), ins(3, 'Eve &amp; Co', run(' 추가'))),
  para(del(4, 'Bo', deleted('gone'), DATE), run(' kept')),
].join('');
const NESTED = para(ins(1, 'A', `${run('keep ')}${del(2, 'B', deleted('struck'))}${run(' tail')}`), ins(3, 'A', del(4, 'B', deleted('x'))));
const MOVES =
  '<w:moveFromRangeStart w:id="10" w:author="Bo"/>' +
  para(del(11, 'Bo', deleted('moved'), DATE, 'moveFrom')) +
  '<w:moveFromRangeEnd w:id="10"/>' +
  '<w:moveToRangeStart w:id="12" w:author="Bo"/>' +
  para(ins(13, 'Bo', run('moved'), DATE, 'moveTo')) +
  '<w:moveToRangeEnd w:id="12"/>';
const MARKERS = '<w:p><w:pPr><w:rPr><w:ins w:id="9" w:author="Bo"/><w:del w:id="8" w:author="Bo"/></w:rPr></w:pPr></w:p>';
const UNCLOSED = `<w:p><w:ins w:id="1" w:author="Bo"><w:r><w:t>never closed</w:t></w:r></w:p>${ins(2, 'Bo', run('closed'))}</w:del>`;

const OWNERS = ['', 'Bo', "O'Neil", 'A & B <x>', 'a.b*c(1)', '가나다', 'Eve &amp; Co'];

// ---- the property changes -----------------------------------------------------------------------------------------
const rPrChange = (id, author, previous) => `<w:rPrChange w:id="${id}" w:author="${author}" w:date="${DATE}">${previous}</w:rPrChange>`;
const PROPS =
  `<w:p><w:pPr><w:pStyle w:val="Body"/><w:rPr><w:b/></w:rPr><w:sectPr><w:pgSz w:w="1"/></w:sectPr>` +
  `<w:pPrChange w:id="1" w:author="Bo" w:date="${DATE}"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>` +
  `<w:r><w:rPr><w:b/>${rPrChange(2, 'Bo', '<w:rPr><w:i/></w:rPr>')}</w:rPr><w:t>x</w:t></w:r>` +
  `<w:r><w:rPr><w:u w:val="single"/>${rPrChange(3, 'Eve', '<w:rPr/>')}</w:rPr><w:t>y</w:t></w:r></w:p>` +
  `<w:tbl><w:tblPr><w:tblW w:w="5"/><w:tblPrChange w:id="4" w:author="Bo" w:date="${DATE}"><w:tblPr/></w:tblPrChange></w:tblPr>` +
  `<w:tblGrid><w:gridCol w:w="1"/><w:tblGridChange w:id="5" w:author="Bo"><w:tblGrid><w:gridCol w:w="2"/></w:tblGrid></w:tblGridChange></w:tblGrid>` +
  `<w:tr><w:trPr><w:cantSplit/><w:trPrChange w:id="6" w:author="Bo"><w:trPr/></w:trPrChange></w:trPr>` +
  `<w:tc><w:tcPr><w:tcW w:w="3"/><w:tcPrChange w:id="7" w:author="Bo"><w:tcPr><w:tcW w:w="4"/></w:tcPr></w:tcPrChange></w:tcPr><w:p/></w:tc></w:tr></w:tbl>` +
  `<w:sectPr><w:pgSz w:w="9"/><w:sectPrChange w:id="8" w:author="Bo"><w:sectPr><w:pgSz w:w="8"/></w:sectPr></w:sectPrChange></w:sectPr>` +
  `<w:numberingChange w:id="9" w:author="Bo" w:original="1"/><w:pPr><w:b/></w:pPr><w:pPr><w:pPrChange w:id="10" w:author="Bo"><w:pPr/></w:pPrChange></w:pPr>`;

// ---- the pure functions -------------------------------------------------------------------------------------------
const project = (spans, xml) =>
  spans.map((span) => ({
    tag: span.tag,
    kind: span.kind,
    attrs: span.attrs,
    id: span.id,
    author: span.author,
    date: span.date,
    text: span.text,
    outer: xml.slice(span.start, span.end),
    inner: xml.slice(span.innerStart, span.innerEnd),
    children: project(span.children, xml),
  }));
const toMap = (object) => new Map(Object.entries(object));
const chartXml = (body, tail = '') => `<c:chartSpace><c:chart><c:plotArea>${body}</c:plotArea></c:chart>${tail}</c:chartSpace>`;
const axes = (cat, val) =>
  `<c:catAx><c:axId val="${cat}"/><c:crossAx val="${val}"/></c:catAx><c:valAx><c:axId val="${val}"/><c:crossAx val="${cat}"/></c:valAx>`;
const bar = (grouping = 'clustered', label = 'outEnd', ids = ['1', '2']) =>
  `<c:barChart><c:barDir val="col"/><c:grouping val="${grouping}"/><c:ser><c:idx val="0"/><c:dLbls><c:dLblPos val="${label}"/><c:showVal val="1"/></c:dLbls></c:ser>` +
  ids.map((id) => `<c:axId val="${id}"/>`).join('') +
  '</c:barChart>';
const external = (id) => `<c:externalData r:id="${id}"><c:autoUpdate val="0"/></c:externalData>`;

const AUDITS = [
  [doc(MIXED), doc(MIXED), ''],
  [doc(para(run('Hello world'))), doc(para(run('Hello world'))), 'Bo'],
  [doc(para(run('Hello '), del(1, 'Bo', deleted('world')), ins(2, 'Bo', run('there')))), doc(para(run('Hello world'))), 'Bo'],
  [doc(para(run('Hello there'))), doc(para(run('Hello world'))), ''],
  [doc(para(run('Hello '), ins(1, 'Eve', run('there')))), doc(para(run('Hello '))), ' Bo '],
  [doc(para(run('a')) + para(run('b')) + para(run('c'))), doc(para(run('a')) + para(run('c'))), ''],
  [doc(para(run('a'))), doc(para(run('a')) + para(run('b')) + para(run('c'))), ''],
  [doc(para(ins(1, 'Bo', run('ab')), ins(2, 'Bo', run('cd')))), doc(para(ins(1, 'Bo', run('abcd')))), ''],
  [doc(para(ins(1, 'Bo', run('ab')), ins(2, 'Eve', run('cd')))), doc(para(ins(1, 'Bo', run('abcd')))), 'Bo'],
  [doc(para(run(long))), doc(para(run(`${long}x`))), ''],
  [doc(Array.from({ length: 12 }, (_, i) => para(ins(i + 1, `Author ${i}`, run(`text ${i}`)))).join('')), doc(''), 'Bo'],
  [doc(NESTED), doc(para(ins(1, 'A', `${run('keep ')}${run('struck')}${run(' tail')}`))), 'A'],
  [doc(MOVES), doc(''), ''],
  [doc(MOVES), doc(MOVES), 'Bo'],
  ['', '', ''],
  [doc(para(run(' lead '), del(1, 'Bo', deleted(' gone ', false)))), doc(para(run(' lead '))), 'Bo'],
  [doc(para(run(`<![CDATA[x]]> &amp; ${long}`))), doc(para(run('plain'))), ''],
];
const STORY_SOURCE = {
  'word/document.xml': doc(para(run('body'))),
  'word/header1.xml': `<w:hdr xmlns:w="${W_NS}">${para(run('head'))}</w:hdr>`,
  'word/footnotes.xml': `<w:footnotes xmlns:w="${W_NS}">${para(run('note'))}</w:footnotes>`,
};
const STORIES = [
  [STORY_SOURCE, STORY_SOURCE, ''],
  [{ ...STORY_SOURCE, 'word/header1.xml': `<w:hdr xmlns:w="${W_NS}">${para(run('changed'))}</w:hdr>` }, STORY_SOURCE, 'Bo'],
  [
    { ...STORY_SOURCE, 'word/document.xml': doc(para(run('body'), ins(1, 'Eve', run(' more')))), 'word/footer2.xml': `<w:ftr xmlns:w="${W_NS}"/>`, 'word/footer1.xml': '<w:ftr/>' },
    STORY_SOURCE,
    'Bo',
  ],
  [{ 'word/document.xml': doc(para(run('x'))) }, STORY_SOURCE, ''],
  [{}, {}, ''],
  [{ 'WORD/Document.xml': doc(para(run('changed'))) }, { 'WORD/Document.xml': doc(para(run('body'))) }, ''],
];
const COMMENTS =
  `<w:comments xmlns:w="${W_NS}"><w:comment w:id="1"/><w:comment w:id="2"/><w:comment w:id="3"/>${Array.from({ length: 12 }, (_, i) => `<w:comment w:id="${20 + i}"/>`).join('')}</w:comments>`;
const LINTS = [
  [doc(MIXED), ''],
  [[{ part: 'word/document.xml', xml: doc(MIXED) }], ''],
  [doc(`<w:del w:id="1"><w:r><w:t>kept</w:t><w:instrText>x</w:instrText></w:r></w:del><w:ins w:id="2"><w:r><w:delText>y</w:delText></w:r></w:ins>`), ''],
  [doc(ins(1, 'Bo', del(2, 'Bo', deleted('z')))), ''],
  [doc(ins(1, 'Bo', `${del(2, 'Bo', deleted('z'))}${deleted('naked')}`)), ''],
  [doc(`<w:moveFrom w:id="1"><w:r><w:t>x</w:t></w:r></w:moveFrom><w:moveTo w:id="2"><w:r><w:delText>y</w:delText></w:r></w:moveTo>`), ''],
  [doc(`<w:p><w:r><w:t> edge</w:t></w:r><w:r><w:t xml:space="preserve"> kept </w:t></w:r><w:r><w:t>tail\n</w:t></w:r></w:p>`), ''],
  [doc('<w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id="1"/><w:commentReference w:id="1"/>'), `<w:comments xmlns:w="${W_NS}"><w:comment w:id="1"/></w:comments>`],
  [doc('<w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id="2"/><w:commentReference w:id="3"/>'), `<w:comments xmlns:w="${W_NS}"><w:comment w:id="1"/><w:comment w:id="4"/></w:comments>`],
  [doc('<w:commentRangeStart w:id="1"/>'.repeat(3) + '<w:commentRangeEnd w:id="9"/>'.repeat(4)), ''],
  [doc('<w:commentReference w:id="2"/>'), COMMENTS],
  [doc(''), COMMENTS],
  [
    [
      { part: 'word/document.xml', xml: doc('<w:commentRangeStart w:id="1"/>') },
      { part: 'word/footnotes.xml', xml: `<w:footnotes>${del(1, 'Bo', run('t'))}<w:commentRangeEnd w:id="1"/></w:footnotes>` },
      { part: 'word/header1.xml', xml: undefined },
    ],
    '',
  ],
  [[], ''],
];
const RESOLVE_SOURCE = doc(MIXED + NESTED + MOVES + MARKERS);
const RESOLVES = [
  [RESOLVE_SOURCE, {}],
  [RESOLVE_SOURCE, { resolution: 'accept' }],
  [RESOLVE_SOURCE, { resolution: 'reject' }],
  [RESOLVE_SOURCE, { resolution: 'accept', target: 2 }],
  [RESOLVE_SOURCE, { resolution: 'reject', target: 2 }],
  [RESOLVE_SOURCE, { resolution: 'reject', target: 99 }],
  [RESOLVE_SOURCE, { resolution: 'accept', id: '3' }],
  [RESOLVE_SOURCE, { resolution: 'reject', id: '2' }],
  [RESOLVE_SOURCE, { resolution: 'accept', author: 'Bo' }],
  [RESOLVE_SOURCE, { resolution: 'reject', author: 'Eve &amp; Co' }],
  [RESOLVE_SOURCE, { resolution: 'accept', author: 'Nobody' }],
  [RESOLVE_SOURCE, { resolution: 'accept', target: 1, author: 'Bo' }],
  [RESOLVE_SOURCE, { resolution: 'accept', id: '13', author: 'Eve' }],
  [NESTED, { resolution: 'accept' }],
  [NESTED, { resolution: 'reject' }],
  [NESTED, { resolution: 'accept', target: 1 }],
  [NESTED, { resolution: 'reject', target: 2 }],
  [MOVES, { resolution: 'accept', author: 'Bo' }],
  [UNCLOSED, { resolution: 'accept' }],
  ['', {}],
];
const PROPERTY_RESOLVES = [
  [PROPS, 'accept', ''],
  [PROPS, 'reject', ''],
  [PROPS, 'reject', 'Bo'],
  [PROPS, 'accept', 'Eve'],
  [PROPS, 'reject', 'Eve'],
  [PROPS, 'reject', 'Nobody'],
  [doc(para(run('plain'))), 'reject', ''],
  [`<w:pPr><w:rPr><w:b/></w:rPr><w:pPrChange w:id="1" w:author="Bo"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>`, 'reject', ''],
  [`<w:pPr><w:pPrChange w:id="1" w:author="Bo"><w:pPr/></w:pPrChange></w:pPr>`, 'reject', ''],
  [`<w:pPr w:rsid="1"><w:rPr><w:b/></w:rPr><w:sectPr><w:cols/></w:sectPr><w:pPrChange w:id="1" w:author="Bo"><w:pPr w:rsid="2"><w:ind/></w:pPr></w:pPrChange></w:pPr>`, 'reject', ''],
  [`<w:rPr><w:b/></w:rPr><w:rPr><w:rPrChange w:id="1" w:author="Bo"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr>`, 'reject', ''],
  [`<w:rPrChange w:id="1" w:author="O&apos;Neil"><w:rPr/></w:rPrChange><w:numberingChange w:id="2" w:author="O'Neil"/>`, 'accept', "O'Neil"],
];
const DATA_LINKS = [
  ['ppt/charts/chart1.xml', chartXml(bar() + axes('1', '2'), external('rId1')), { rId1: '../embeddings/chartData1.xlsx' }, ['ppt/embeddings/chartData1.xlsx']],
  ['ppt/charts/chart2.xml', chartXml(bar() + axes('1', '2')), {}, []],
  ['ppt/charts/chart3.xml', chartXml(bar() + axes('1', '2'), external('rId1')), { rId1: '../embeddings/chartData7.xlsx' }, []],
  ['ppt/charts/chart4.xml', chartXml(bar() + axes('1', '2'), external('rId9')), {}, []],
  ['ppt/charts/chart5.xml', chartXml('<c:pieChart><c:varyColors val="1"/></c:pieChart>'), {}, []],
  ['ppt/charts/chart6.xml', chartXml(bar() + axes('1', '2'), external('rId1')), { rId1: '/ppt/embeddings/a.xlsx' }, ['ppt/embeddings/a.xlsx']],
  ['ppt/charts/chart7.xml', chartXml(bar() + axes('1', '2'), `<c:extLst><c:ext>${external('rId5')}</c:ext></c:extLst>`), { rId5: 'x.xlsx' }, ['ppt/charts/x.xlsx']],
];
const FAULT_XML = [
  ['ppt/charts/chart1.xml', chartXml(bar() + axes('1', '2'))],
  ['ppt/charts/chart1.xml', chartXml(bar('stacked') + axes('1', '2'))],
  ['ppt/charts/chart2.xml', chartXml(bar('percentStacked', 'ctr') + axes('1', '2'))],
  ['ppt/charts/chart2.xml', chartXml(bar('percentStacked', 'outEnd') + bar('stacked', 'outEnd', ['1', '2']) + axes('1', '2'))],
  ['ppt/charts/chart3.xml', chartXml(`${bar()}<c:lineChart><c:grouping val="standard"/><c:axId val="3"/><c:axId val="4"/></c:lineChart>${axes('1', '2')}`)],
  ['ppt/charts/chart3.xml', chartXml(`${bar('clustered', 'ctr', ['1', '7'])}${axes('1', '2')}`)],
  ['ppt/charts/chart3.xml', chartXml(`${bar('clustered', 'ctr', ['1', '1'])}${axes('1', '2')}`)],
  ['ppt/charts/chart3.xml', chartXml(`${bar('clustered', 'ctr', [])}${axes('1', '2')}`)],
  ['ppt/charts/chart3.xml', chartXml(`<c:line3DChart><c:grouping val="standard"/><c:axId val="1"/><c:axId val="2"/></c:line3DChart>${axes('1', '2')}`)],
  ['ppt/charts/chart3.xml', chartXml(`<c:surface3DChart><c:axId val="1"/><c:axId val="2"/><c:axId val="3"/></c:surface3DChart><c:serAx><c:axId val="3"/></c:serAx>${axes('1', '2')}`)],
  [
    'ppt/charts/chart4.xml',
    chartXml(
      `<c:pieChart><c:varyColors val="1"/></c:pieChart>${bar('stacked', 'ctr')}<c:extLst><c:ext><c:barChart><c:grouping val="stacked"/><c:dLblPos val="outEnd"/><c:axId val="9"/></c:barChart></c:ext></c:extLst><c:extLst/>${axes('1', '2')}`
    ),
  ],
  ['ppt/charts/chart5.xml', chartXml('<c:barChart><c:grouping val="stacked"/><c:dLblPos val="outEnd"/>')],
  ['ppt/charts/chart6.xml', chartXml(`<c:dateAx><c:axId val="5"/></c:dateAx><c:barChart/>${bar('stacked', 'outEnd', ['5', '6'])}`)],
  ['ppt/charts/chart7.xml', ''],
];

const pure = [];
const record = async (fn, args, call) => pure.push({ fn, args, ...(await attempt(call)) });
for (const author of OWNERS) await record('revisionOwner', [author], () => revisions.revisionOwner(author));
for (const [attrs, raw] of [
  [' xml:space="preserve"', ' a &amp; b '],
  ['', ' \t a \r\n'],
  ['', '   '],
  [' xml:space="default"', ' &#x41;&#66; '],
  ['', '&lt;x&gt;'],
])
  await record('renderedWordText', [attrs, raw], () => revisions.renderedWordText(attrs, raw));
for (const xml of [doc(MIXED), doc(NESTED), doc(MOVES), doc(MARKERS), UNCLOSED, '', doc(para(run('plain'))), doc(PROPS)])
  await record('docxRevisionTree', [xml], () => project(revisions.docxRevisionTree(xml), xml));
for (const [current, original, author] of AUDITS)
  await record('auditDocxRedlining', [current, original, author], () => revisions.auditDocxRedlining(current, original, { author }));
for (const [current, original, author] of STORIES)
  await record('auditDocxRedliningStories', [current, original, author], () => revisions.auditDocxRedliningStories(toMap(current), toMap(original), { author }));
for (const [parts, comments] of LINTS) await record('lintDocxRevisions', [parts, comments], () => revisions.lintDocxRevisions(parts, comments));
for (const [xml, options] of RESOLVES) await record('resolveDocxRevisions', [xml, options], () => revisions.resolveDocxRevisions(xml, options));
for (const [xml, resolution, author] of PROPERTY_RESOLVES)
  await record('resolveDocxPropertyChanges', [xml, resolution, author], () => revisions.resolveDocxPropertyChanges(xml, { resolution, author }));
for (const xml of [PROPS, doc(MIXED), `<w:numberingChange w:id="1"/><w:rPrChange/><w:tblGridChange/>`, ''])
  await record('countDocxPropertyChanges', [xml], () => revisions.countDocxPropertyChanges(xml));
for (const [part, xml] of FAULT_XML) await record('chartFaultsInXml', [part, xml], () => charts.chartFaultsInXml(part, xml));
for (const [part, xml, relationships, parts] of DATA_LINKS) {
  const available = new Set(parts);
  await record('chartDataLinkFaults', [part, xml, relationships, parts], () =>
    charts.chartDataLinkFaults(part, xml, { relationships: toMap(relationships), hasPart: (name) => available.has(name) })
  );
}
await record('chartDataLinkFaults', ['ppt/charts/chart1.xml', chartXml(bar() + axes('1', '2')), null, null], () =>
  charts.chartDataLinkFaults('ppt/charts/chart1.xml', chartXml(bar() + axes('1', '2')))
);

// ---- packages -----------------------------------------------------------------------------------------------------
const CONTENT_TYPES = (...overrides) =>
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides
    .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join('')}</Types>`;
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const RELS = (...items) =>
  `<Relationships xmlns="${REL_NS}">${items.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`;
const DOC_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const docx = (body = para(run('Hello')), extra = {}) => ({
  '[Content_Types].xml': CONTENT_TYPES(['/word/document.xml', DOC_TYPE]),
  '_rels/.rels': RELS(['rId1', `${OFFICE}/officeDocument`, 'word/document.xml']),
  'word/document.xml': doc(body),
  ...extra,
});
const without = (files, ...names) => Object.fromEntries(Object.entries(files).filter(([name]) => !names.includes(name)));
const xlsx = () => ({
  '[Content_Types].xml': CONTENT_TYPES(['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml']),
  '_rels/.rels': RELS(['rId1', `${OFFICE}/officeDocument`, 'xl/workbook.xml']),
  'xl/workbook.xml': '<workbook xmlns="http://x/s"><sheets/></workbook>',
});
const pptx = (extra = {}) => ({
  '[Content_Types].xml': CONTENT_TYPES(['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml']),
  '_rels/.rels': RELS(['rId1', `${OFFICE}/officeDocument`, 'ppt/presentation.xml']),
  'ppt/presentation.xml': '<p:presentation xmlns:p="http://x/p"><p:sldMasterIdLst/></p:presentation>',
  ...extra,
});
const slideRels = (...items) => RELS(...items.map(([id, kind, target]) => [id, `${OFFICE}/${kind}`, target]));

const XML_CASES = JSON.parse(
  JSON.stringify([
    '<a><b></a>', '<a>&foo;</a>', '<a x=1/>', '', '<a/><b/>', '<?xml version="1.0"?>\n<a>\n  <b></a>', '<a><b>', '<a b="1" b="2"/>', '<p:a/>',
    '<a xmlns:p="u"><p:b p:x="1" p:x="2"/></a>', 'text<a/>', '<a/>text', '<a>]]></a>', '<!-- a -- b --><a/>', '<a><!-- x --></a>', '<a>&#0;</a>',
    '<a>&#x41;&#65;&amp;</a>', '<a>&;</a>', '<a>&a b;</a>', '<a b="<"/>', '<a b/>', '<a b ="1"/>', "<a b='1'c='2'/>",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<a/>', '\n<?xml version="1.0"?><a/>', '<?xml version="2.0"?><a/>',
    '<?xml encoding="UTF-8"?><a/>', '<?xml version="1.0" standalone="maybe"?><a/>', '<?xml version="1.0"?', '<?xml?><a/>', '<a/><?xml version="1.0"?>',
    '<?pi body?><a/>', '<?pi ?', '<!DOCTYPE a [<!ENTITY e "v">]><a>&e;</a>', '<!DOCTYPE a><a/><!DOCTYPE a>', '<a><![CDATA[ x ]]></a>',
    '<![CDATA[x]]><a/>', '<a/><![CDATA[x]]>', '<a>\u0001</a>', '<a>\uFFFE</a>', '<a></b>', '</a>', '<a x:y="1"/>', '<a xmlns:xml="u"/>',
    '<a xmlns:p=""/>', '<a xmlns="http://www.w3.org/2000/xmlns/"/>', '<a xmlns:p="http://www.w3.org/XML/1998/namespace"/>', '<:a/>', '<a:/>', '<a:b:c/>',
    '<a ', '<a b="x', '<a>\r\n<b>\r</a>', '<a>\r', '\uFEFF<a/>', '\uFEFF <a/>', '<a>😀</a>', '<a><b/>&bad;</a>', '< a/>', '<a / >', '<a b="1"/ >', '<1a/>',
    '<a 1b="x"/>', '<a><!- x --></a>', '<a><!DOCTYPE b></a>', '<!DOCTYPE >\n<a/>', '<!DOCTYPE html><html/>', '<a><?pi?></a>', '<a>a&#x110000;</a>',
    '<a>&#xD800;</a>', '<a>&lt;&gt;&quot;&apos;</a>', '<a>\n\n  <b>\n\t</c></a>', "<?xml version='1.0'?><a/>", '<?xml version="1.0" ?><a/>',
    '<?xml version="1.0"encoding="UTF-8"?><a/>', '<?xml version ="1.0"?><a/>', '<?xml version"1.0"?><a/>', '<?xml version=1.0?><a/>',
    '<?xml version="1.0" encoding="1x"?><a/>', '<?xml version="1.0" encoding="_x"?><a/>', '<?xml standalone="yes"?><a/>', '<?xml version="1.0" version="1.0"?><a/>',
    '<a>가나다 &#xAC00; 😀 &#x1F600;</a>', '<w:a xmlns:w="http://x" w:b="1" w:b="2"/>', '<a xmlns:p="u" xmlns:q="u" p:x="1" q:x="2"/>',
    '<a xmlns="u"><b xmlns=""><c/></b></a>', '<a><b xmlns:p="u"><p:c/></b><p:d/></a>', '<a xmlns:p="u"><p:b></p:c></a>', '<a x="a&amp;b&lt;&#x41;&bad;"/>',
    '<a x="1\n2\t3\r4"/>', '<a x="\u0001"/>', '<!DOCTYPE a [<!-- c -- d -->]><a/>', '<!DOCTYPE a [<?pi x?><!ELEMENT a (#PCDATA)>]><a/>',
    '<!DOCTYPE a SYSTEM "a.dtd"><a/>', '<!DOCTYPE a PUBLIC "-//X//Y" "a.dtd"><a/>', '<?xml-stylesheet href="a"?><a/>', '<?XML version="1.0"?><a/>',
    '<? ?><a/>', '<?1x?><a/>', '<?a?b?><a/>', '<!x><a/>', '<!DOCTYP><a/>', '<a><![CDATA[x]]]]><![CDATA[>]]></a>', '<a><![CDATA[x</a>', '<a b=\'"\'/>', '<a>&#x;</a>',
    '<a>&#X41;</a>', '<a>&#12345678901234567890;</a>', '<a b="x"c="y"/>', '<a\tb="1"\n/>', '<a/ >', '<a></a ><b/>', '<a></ a>', '<a></>', '<a>&<</a>',
  ])
);
const PACKAGES = [];
const add = (name, format, files, extra = {}) => PACKAGES.push({ name, format, files, ...extra });
add('a valid document', 'docx', docx());
add('a valid workbook', 'xlsx', xlsx());
add('a valid deck', 'pptx', pptx());
add('an unknown format', 'txt', docx());
add('a document with Korean part names and a flat entry', 'docx', docx(para(run('한글')), { 'word/한글.xml': '<a/>', 'word/media/image1.PNG': 'x', 'word/notes.txt': 'x' }));
add('no document part', 'docx', without(docx(), 'word/document.xml'));
add('no content types part', 'docx', without(docx(), '[Content_Types].xml'));
add('no main content type', 'docx', { ...docx(), '[Content_Types].xml': CONTENT_TYPES() });
add('unsafe entries', 'docx', docx(para(run('x')), { '/abs.xml': '<a/>', 'word/a..b.xml': '<a/>', 'C:/drive.xml': '<a/>' }));
add(
  'relationships that dangle repeat or leave the package',
  'docx',
  docx(para(run('x')), {
    'word/_rels/document.xml.rels': RELS(
      ['rId1', `${OFFICE}/styles`, 'styles.xml'],
      ['rId1', `${OFFICE}/image`, 'media/a%20b.png'],
      ['rId2', `${OFFICE}/hyperlink`, 'https://example.com/?a=1&amp;b=2', 'External'],
      ['rId3', `${OFFICE}/image`, '../../outside.xml'],
      ['rId4', `${OFFICE}/image`, '/word/document.xml#frag?q=1'],
      ['rId5', `${OFFICE}/image`, 'media/%E0%A4%A.png'],
      ['', `${OFFICE}/image`, ''],
      ['rId6', `${OFFICE}/hyperlink`, 'mailto:a@b.c', 'external']
    ),
    '_rels/.rels': RELS(['rId1', `${OFFICE}/officeDocument`, 'word/document.xml'], ['rId1', `${OFFICE}/thumbnail`, 'missing.png']),
  })
);
add('well-formedness of every part', 'docx', {
  ...docx(),
  ...Object.fromEntries(XML_CASES.map((text, at) => [`xml/c${String(at).padStart(3, '0')}.${at % 5 === 0 ? 'rels' : at % 7 === 0 ? 'XML' : 'xml'}`, text])),
  'xml/not.txt': '<a><b></a>',
});
add('tracked changes with structural faults', 'docx', docx(MIXED + `<w:del w:id="9"><w:r><w:t>kept</w:t><w:instrText>x</w:instrText></w:r></w:del>${ins(10, 'Bo', deleted('naked'))}`));
add('tracked changes done properly', 'docx', docx(MIXED + NESTED + MOVES));
add(
  'comments in a document',
  'docx',
  docx('<w:commentRangeStart w:id="1"/>' + run('a') + '<w:commentRangeEnd w:id="1"/><w:commentReference w:id="1"/><w:commentReference w:id="5"/>', {
    'word/comments.xml': `<w:comments xmlns:w="${W_NS}"><w:comment w:id="1"/><w:comment w:id="2"/></w:comments>`,
  })
);
add('a header and a footer', 'docx', docx(para(run('b')), { 'word/header1.xml': `<w:hdr xmlns:w="${W_NS}">${para(run(' head'))}</w:hdr>`, 'word/footer1.xml': `<w:ftr xmlns:w="${W_NS}"/>`, 'word/footnotes.xml': `<w:footnotes xmlns:w="${W_NS}">${para(del(1, 'Bo', run('x')))}</w:footnotes>` }));

const ORIGINAL = docx(para(run('Hello world')) + para(run('Second')), {
  'word/header1.xml': `<w:hdr xmlns:w="${W_NS}">${para(run('head'))}</w:hdr>`,
});
add('redlining without a source', 'docx', ORIGINAL, { options: { auditProfile: 'redlining' } });
add('redlining with a source that is missing', 'docx', ORIGINAL, { options: { auditProfile: 'redlining' }, original: 'missing' });
add('redlining with a source that is not a package', 'docx', ORIGINAL, { options: { auditProfile: 'redlining' }, original: { raw: 'not a zip' } });
add('a tracked edit', 'docx', docx(para(run('Hello '), del(1, 'Bo', deleted('world')), ins(2, 'Bo', run('there'))) + para(run('Second')), { 'word/header1.xml': ORIGINAL['word/header1.xml'] }), {
  options: { auditProfile: 'redlining', author: 'Bo' },
  original: ORIGINAL,
});
add('an untracked edit', 'docx', docx(para(run('Hello there')) + para(run('Second')), { 'word/header1.xml': ORIGINAL['word/header1.xml'] }), {
  options: { auditProfile: 'redlining' },
  original: ORIGINAL,
});
add('an edit by another author', 'docx', docx(para(run('Hello world'), ins(1, 'Eve', run('!'))) + para(run('Second')), { 'word/header1.xml': ORIGINAL['word/header1.xml'] }), {
  options: { auditProfile: 'redlining', author: 'Bo' },
  original: ORIGINAL,
});
add(
  'an untracked header and a new footer',
  'docx',
  docx(para(run('Hello world')) + para(run('Second')), { 'word/header1.xml': `<w:hdr xmlns:w="${W_NS}">${para(run('changed'))}</w:hdr>`, 'word/footer1.xml': `<w:ftr xmlns:w="${W_NS}"/>` }),
  { options: { auditProfile: 'redlining' }, original: ORIGINAL }
);
add('a workbook asked for the redlining audit', 'xlsx', xlsx(), { options: { auditProfile: 'redlining' }, original: xlsx() });
add('a source with no change', 'docx', ORIGINAL, { original: ORIGINAL });
add('a source that is missing', 'docx', ORIGINAL, { original: 'missing' });
add('a file that is not a package', 'docx', { raw: 'plain text' });

const PROTECTED_SOURCE = docx(para(run('x')), {
  'word/vbaProject.bin': 'macro',
  '_xmlsignatures/sig1.xml': '<s/>',
  'word/theme/theme1.xml': '<theme xmlns="u"/>',
  'word/embeddings/ole1.bin': 'ole',
  'customUI/ui.xml': '<u/>',
  'word/externalLinks/e1.xml': '<e/>',
  'xl/connections.xml': '<c/>',
  'docProps/origin.sigs': 's',
  'word/slideMasters/m.xml': '<m/>',
});
add('protected parts unchanged', 'docx', PROTECTED_SOURCE, { original: PROTECTED_SOURCE });
add('a macro and a theme changed and a signature lost', 'docx', { ...without(PROTECTED_SOURCE, '_xmlsignatures/sig1.xml'), 'word/vbaProject.bin': 'changed', 'word/theme/theme1.xml': '<theme xmlns="v"/>', 'word/new.xml': '<n/>' }, { original: PROTECTED_SOURCE });
add('the same saved by the application', 'docx', { ...without(PROTECTED_SOURCE, '_xmlsignatures/sig1.xml', 'word/theme/theme1.xml'), 'word/vbaProject.bin': 'changed', 'word/slideMasters/m.xml': '<m2/>' }, { original: PROTECTED_SOURCE, options: { savedBy: 'microsoft-office-com' } });
add('the same saved by another backend', 'docx', { ...without(PROTECTED_SOURCE, 'word/theme/theme1.xml'), 'word/slideMasters/m.xml': '<m2/>' }, { original: PROTECTED_SOURCE, options: { savedBy: 'portable' } });
add('a body edit only', 'docx', { ...PROTECTED_SOURCE, 'word/document.xml': doc(para(run('y'))) }, { original: PROTECTED_SOURCE });
const CHART_PART = 'ppt/charts/chart1.xml';
const CHART_RELS = (workbook) => RELS(['rId1', `${OFFICE}/package`, `../embeddings/${workbook}`]);
const DECK_WITH_CHART = (workbook, body = chartXml(bar() + axes('1', '2'), external('rId1'))) =>
  pptx({ [CHART_PART]: body, 'ppt/charts/_rels/chart1.xml.rels': CHART_RELS(workbook), [`ppt/embeddings/${workbook}`]: 'wb', 'ppt/embeddings/ole.bin': 'ole' });
add('a chart workbook rewritten', 'pptx', { ...DECK_WITH_CHART('Microsoft_Excel_Worksheet.xlsx'), 'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx': 'rewritten' }, { original: DECK_WITH_CHART('Microsoft_Excel_Worksheet.xlsx') });
add('a chart workbook renumbered by the application', 'pptx', DECK_WITH_CHART('Microsoft_Excel_Worksheet.xlsx'), { original: DECK_WITH_CHART('Microsoft_Excel_Worksheet2.xlsx'), options: { savedBy: 'microsoft-office-com' } });
add('a chart workbook renumbered by another backend', 'pptx', DECK_WITH_CHART('Microsoft_Excel_Worksheet.xlsx'), { original: DECK_WITH_CHART('Microsoft_Excel_Worksheet2.xlsx') });

const MASTER = (layouts) => `<p:sldMaster xmlns:p="http://x/p" xmlns:r="http://x/r"><p:sldLayoutIdLst>${layouts.map(([id, rid]) => `<p:sldLayoutId id="${id}" r:id="${rid}"/>`).join('')}</p:sldLayoutIdLst></p:sldMaster>`;
add('a slide on two layouts and a notes page shared by two slides', 'pptx', pptx({
  'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://x/p"/>',
  'ppt/slides/slide2.xml': '<p:sld xmlns:p="http://x/p"/>',
  'ppt/slides/slide10.xml': '<p:sld xmlns:p="http://x/p"/>',
  'ppt/slides/_rels/slide1.xml.rels': slideRels(['rId1', 'slideLayout', '../slideLayouts/l1.xml'], ['rId2', 'slideLayout', '../slideLayouts/l2.xml'], ['rId3', 'notesSlide', '../notesSlides/n1.xml']),
  'ppt/slides/_rels/slide2.xml.rels': slideRels(['rId1', 'notesSlide', '../notesSlides/n1.xml']),
  'ppt/slides/_rels/slide10.xml.rels': slideRels(['rId1', 'notesSlide', '../notesSlides/n1.xml'], ['rId2', 'notesSlide', 'https://x/n1.xml']),
}));
add('masters sharing a theme and a layout a master does not name', 'pptx', pptx({
  'ppt/slideMasters/slideMaster2.xml': MASTER([['1', 'rId1']]),
  'ppt/slideMasters/slideMaster1.xml': MASTER([['1', 'rId9'], ['2', 'rId1'], ['3', '']]),
  'ppt/slideMasters/_rels/slideMaster1.xml.rels': slideRels(['rId1', 'slideLayout', '../slideLayouts/l1.xml'], ['rId2', 'theme', '../theme/theme1.xml']),
  'ppt/slideMasters/_rels/slideMaster2.xml.rels': slideRels(['rId2', 'theme', '../theme/theme1.xml']),
  'ppt/notesMasters/notesMaster1.xml': '<p:notesMaster xmlns:p="http://x/p"/>',
  'ppt/notesMasters/_rels/notesMaster1.xml.rels': slideRels(['rId1', 'theme', '../theme/theme1.xml']),
  'ppt/handoutMasters/handoutMaster1.xml': '<p:handoutMaster xmlns:p="http://x/p"/>',
  'ppt/handoutMasters/_rels/handoutMaster1.xml.rels': slideRels(['rId1', 'theme', '../theme/theme1.xml']),
  'ppt/theme/theme1.xml': '<theme xmlns="u"/>',
}));
add('a notes master sharing a theme where PowerPoint tolerates it', 'pptx', pptx({
  'ppt/presentation.xml': '<p:presentation xmlns:p="http://x/p"><!-- <p:sldIdLst/> --><p:sldIdLst><p:sldId id="1"/></p:sldIdLst>\n <p:notesMasterIdLst/></p:presentation>',
  'ppt/slideMasters/slideMaster1.xml': MASTER([]),
  'ppt/slideMasters/_rels/slideMaster1.xml.rels': slideRels(['rId2', 'theme', '../theme/theme1.xml']),
  'ppt/notesMasters/notesMaster1.xml': '<p:notesMaster xmlns:p="http://x/p"/>',
  'ppt/notesMasters/_rels/notesMaster1.xml.rels': slideRels(['rId1', 'theme', '../theme/theme1.xml']),
  'ppt/theme/theme1.xml': '<theme xmlns="u"/>',
}));
add('a theme that is not in the package and an external one', 'pptx', pptx({
  'ppt/slideMasters/slideMaster1.xml': MASTER([]),
  'ppt/slideMasters/_rels/slideMaster1.xml.rels': slideRels(['rId2', 'theme', '../theme/absent.xml']),
  'ppt/slideMasters/slideMaster3.xml': MASTER([]),
  'ppt/slideMasters/_rels/slideMaster3.xml.rels': RELS(['rId2', `${OFFICE}/theme`, 'https://x/theme.xml', 'External']),
}));

const packageBytes = async (files) => {
  if (files.raw !== undefined) return Buffer.from(files.raw);
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return await zip.generateAsync({ type: 'nodebuffer' });
};
const packages = [];
for (const entry of PACKAGES) {
  const current = join(work, 'current.pkg');
  writeFileSync(current, await packageBytes(entry.files));
  const options = { ...(entry.options || {}) };
  if (entry.original === 'missing') options.original = join(work, 'absent.pkg');
  else if (entry.original) {
    options.original = join(work, 'original.pkg');
    writeFileSync(options.original, await packageBytes(entry.original));
  }
  const outcome = await attempt(() => validation.validatePortableOoxml(current, entry.format, options));
  packages.push({
    name: entry.name,
    format: entry.format,
    files: entry.files,
    original: entry.original ?? null,
    options: entry.options || {},
    ...scrub(outcome),
  });
}

const chartPackages = [];
const CHART_DECKS = [
  {
    name: 'charts in number order with their own relationships',
    files: {
      'ppt/charts/chart10.xml': chartXml(bar() + axes('1', '2')),
      'ppt/charts/chart2.xml': chartXml(bar() + axes('1', '2'), external('rId1')),
      'ppt/charts/_rels/chart2.xml.rels': CHART_RELS('w.xlsx'),
      'ppt/embeddings/w.xlsx': 'x',
      'ppt/charts/chartstyle.xml': '<c:chartStyle/>',
      'ppt/charts/chart3.xml': '',
      'ppt/charts/chart01.xml': chartXml(bar('stacked') + axes('1', '2'), external('rId1')),
      'ppt/charts/_rels/chart01.xml.rels': CHART_RELS('absent.xlsx'),
      'ppt/charts/sub/chart4.xml': chartXml(bar('stacked') + axes('1', '2')),
    },
  },
  { name: 'no charts', files: pptx() },
];
for (const entry of CHART_DECKS) {
  const zip = await JSZip.loadAsync(await packageBytes(entry.files));
  chartPackages.push({ name: entry.name, files: entry.files, ...(await attempt(() => charts.chartFaultIssues(zip))) });
}
rmSync(work, { recursive: true, force: true });

writeJson(join(stage, 'golden.json'), { pure, packages, charts: chartPackages });
writeSetManifest(stage, { set: 'office-docx-revisions', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
