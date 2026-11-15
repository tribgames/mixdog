#!/usr/bin/env node
// What the portable OOXML package modules answer (src/runtime/office/portable: portable-xml, portable-opc,
// portable-package, portable-cells, pptx-relations, placeholder-scan; documentFingerprint of core/office-core.mjs), run
// through Node. Rust `mixdog-ooxml` must answer the same: part lists, content types, every part's text, the fingerprints
// and the values of the pure helpers (crates/mixdog-ooxml/tests/twin_package.rs).
//
//   node benchmarks/rust-core/recorders/record-office-package.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-package/golden.json. The recording holds `pure` (a function name, its arguments
// and its result or error) and `sequences` (steps over one package: each step's output, then the package's names, every
// part's text).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-package');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-package.mjs';
const xml = await importFrom(tree, 'src/runtime/office/portable/portable-xml.mjs');
const opc = await importFrom(tree, 'src/runtime/office/portable/portable-opc.mjs');
const pkg = await importFrom(tree, 'src/runtime/office/portable/portable-package.mjs');
const cells = await importFrom(tree, 'src/runtime/office/portable/portable-cells.mjs');
const relations = await importFrom(tree, 'src/runtime/office/portable/pptx-relations.mjs');
const scan = await importFrom(tree, 'src/runtime/office/portable/placeholder-scan.mjs');
const core = await importFrom(tree, 'src/runtime/office/core/office-core.mjs');

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-package-'));
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

const b64 = (list) => Buffer.from(list).toString('base64');
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 4, 8, 6, 0, 0, 0]);
const GIF = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 5, 0, 0, 0, 0]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 5, 0, 10, 3, 1, 0x11, 0]);
const bytes = (value) => Buffer.from(value.base64, 'base64');
const PURE = [
  ['xmlDecode', ['a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42;&#x1F600; &amp;amp;'], (s) => xml.xmlDecode(s)],
  ['xmlEncode', ['a & b <c> "d" \'e\' 가'], (s) => xml.xmlEncode(s)],
  ['tagPattern', ['w:p.r[0]*'], (s) => xml.tagPattern(s)],
  ['replaceAcrossRuns', ['<w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo wor</w:t></w:r><w:r><w:t>ld</w:t></w:r></w:p>', 'w:t', 'lo wor', 'LO'], (...a) => xml.replaceAcrossRuns(...a)],
  ['replaceAcrossRuns', ['<w:t>a</w:t><w:t xml:space="preserve"> b </w:t><w:t/>', 'w:t', 'b', 'x & y'], (...a) => xml.replaceAcrossRuns(...a)],
  ['replaceAcrossRuns', ['<w:t>aaa</w:t>', 'w:t', 'a', 'bb'], (...a) => xml.replaceAcrossRuns(...a)],
  ['replaceAcrossRuns', ['<w:t>aaa</w:t>', 'w:t', '', 'bb'], (...a) => xml.replaceAcrossRuns(...a)],
  ['replaceAcrossRuns', ['<w:p/>', 'w:t', 'a', 'b'], (...a) => xml.replaceAcrossRuns(...a)],
  ['replaceInParagraphs', ['<a:p><a:r><a:t>올해</a:t></a:r><a:br/><a:r><a:t>상반기에도 성장</a:t></a:r></a:p><a:p><a:r><a:t>성장</a:t></a:r></a:p>', '올해 상반기에도', '내년'], (...a) => xml.replaceInParagraphs(...a)],
  ['replaceInParagraphs', ['<a:p><a:r><a:t>one</a:t></a:r></a:p>', ' ', 'x'], (...a) => xml.replaceInParagraphs(...a)],
  ['replaceInParagraphs', ['<a:p><a:r><a:t>a  b</a:t></a:r></a:p>', 'a b', 'x'], (...a) => xml.replaceInParagraphs(...a)],
  ['blockText', ['<w:p><w:r><w:t>a</w:t></w:r><w:r><w:t>b</w:t></w:r></w:p><w:p><w:r><w:t>c</w:t><w:br/><w:tab/><w:t>d &amp; e</w:t></w:r></w:p><w:p/><w:p></w:p>', 'w:t'], (...a) => xml.blockText(...a)],
  ['topLevelElements', ['<w:p><w:r/></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/>', ['w:p', 'w:tbl']], (...a) => xml.topLevelElements(...a)],
  ['containerInner', ['<a/><b><b>x</b>y</b><b>z</b>', 'b', 0], (...a) => xml.containerInner(...a)],
  ['containerInner', ['<b><b>x</b>y</b><b>z</b>', 'b', 1], (...a) => xml.containerInner(...a)],
  ['containerInner', ['<b>never closed', 'b', 0], (...a) => xml.containerInner(...a)],
  ['elementSpans', ['<w:p a="1"/><w:pPr/><w:p b="2">x</w:p>', 'w:p'], (...a) => xml.elementSpans(...a)],
  ['containerBody', ['<w:p a="1">x<w:r/>y</w:p>', 'w:p'], (...a) => xml.containerBody(...a)],
  ['containerBody', ['<w:p/>', 'w:p'], (...a) => xml.containerBody(...a)],
  ['upsertOrderedChild', ['<w:pPr><w:jc w:val="left"/><w:ind w:left="1"/></w:pPr>', ['w:pStyle', 'w:jc', 'w:ind', 'w:rPr'], 'w:jc', '<w:jc w:val="center"/>'], (...a) => xml.upsertOrderedChild(...a)],
  ['upsertOrderedChild', ['<w:pPr><w:ind w:left="1"/></w:pPr>', ['w:pStyle', 'w:jc', 'w:ind', 'w:rPr'], 'w:jc', '<w:jc w:val="center"/>'], (...a) => xml.upsertOrderedChild(...a)],
  ['upsertOrderedChild', ['<w:pPr></w:pPr>', ['w:pStyle', 'w:jc'], 'w:jc', '<w:jc w:val="center"/>'], (...a) => xml.upsertOrderedChild(...a)],
  ['upsertOrderedChild', ['<w:pPr><w:jc w:val="left"/></w:pPr>', ['w:pStyle', 'w:jc'], 'w:jc', ''], (...a) => xml.upsertOrderedChild(...a)],
  ['setXmlAttribute', [' w:val="1" w:x="2"', 'w:val', '9'], (...a) => xml.setXmlAttribute(...a)],
  ['setXmlAttribute', [' w:x="2"', 'w:val', '9'], (...a) => xml.setXmlAttribute(...a)],
  ['xmlAttribute', [' w:VAL="v" b="c"', 'w:val'], (...a) => xml.xmlAttribute(...a)],
  ['settingsTrackChanges', ['<w:settings><w:trackRevisions/></w:settings>'], (s) => xml.settingsTrackChanges(s)],
  ['settingsTrackChanges', ['<w:settings><w:trackRevisions w:val="False"/></w:settings>'], (s) => xml.settingsTrackChanges(s)],
  ['settingsTrackChanges', ['<w:settings/>'], (s) => xml.settingsTrackChanges(s)],
  ['partRelationshipPath', ['word/document.xml'], (s) => opc.partRelationshipPath(s)],
  ['partRelationshipPath', ['[Content_Types].xml'], (s) => opc.partRelationshipPath(s)],
  ['partFromTarget', ['word', '../media/a.png'], (...a) => opc.partFromTarget(...a)],
  ['partFromTarget', ['word', '/xl/sheet1.xml'], (...a) => opc.partFromTarget(...a)],
  ['relationshipOwner', ['word/_rels/document.xml.rels'], (s) => opc.relationshipOwner(s)],
  ['relationshipOwner', ['_rels/.rels'], (s) => opc.relationshipOwner(s)],
  ['relationshipTarget', ['ppt/slides/_rels/slide1.xml.rels', '../media/image%201.png#frag?x=1'], (...a) => opc.relationshipTarget(...a)],
  ['relationshipTarget', ['ppt/slides/_rels/slide1.xml.rels', '/ppt/media/a%E0%A4%A.png'], (...a) => opc.relationshipTarget(...a)],
  ['nextRelationshipId', ['<Relationship Id="rId3"/><Relationship Id="rId12"/><Relationship Id="x1"/>'], (s) => opc.nextRelationshipId(s)],
  ['nextRelationshipId', [''], (s) => opc.nextRelationshipId(s)],
  ['relationshipTargetByType', ['<Relationship Id="rId1" Type="http://x/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId2" Type="http://x/relationships/styles" Target="styles.xml"/>', 'styles'], (...a) => opc.relationshipTargetByType(...a)],
  ['relationshipTargetByType', ['<Relationship Id="rId1" Type="http://x/relationships/theme" Target="theme/theme1.xml"/>', 'styles'], (...a) => opc.relationshipTargetByType(...a)],
  ['relationshipMap', ['<Relationships><Relationship Id="rId1" Type="t" Target="a.xml"/><Relationship Id="rId2" Target="b.xml"></Relationship><Relationship Id="rId3" Type="t"/><Relationship Id="rId1" Target="c.xml"/></Relationships>'], (s) => [...opc.relationshipMap(s)]],
  ['provenanceCitation', ['분기 보고서'], (s) => opc.provenanceCitation(s)],
  ['provenanceCitation', ['Source: annual report'], (s) => opc.provenanceCitation(s)],
  ['provenanceCitation', [{ document: 'Annual report', target: 'p. 4' }], (s) => opc.provenanceCitation(s)],
  ['provenanceCitation', [{ label: '출처: 내부 자료' }], (s) => opc.provenanceCitation(s)],
  ['provenanceCitation', [{ target: 'only' }], (s) => opc.provenanceCitation(s)],
  ['provenanceCitation', [7], (s) => opc.provenanceCitation(s)],
  ['imagePixelSize', [{ base64: PNG }], (s) => opc.imagePixelSize(bytes(s))],
  ['imagePixelSize', [{ base64: GIF }], (s) => opc.imagePixelSize(bytes(s))],
  ['imagePixelSize', [{ base64: JPEG }], (s) => opc.imagePixelSize(bytes(s))],
  ['imagePixelSize', [{ base64: 'AAECAwQ=' }], (s) => opc.imagePixelSize(bytes(s))],
  ['placeholderTextIssues', ['Lorem ipsum dolor {{ 계약명 }} TODO', 'slide[1]', { slide: 1 }], (...a) => scan.placeholderTextIssues(...a)],
  ['placeholderTextIssues', ['   ', 'slide[1]', {}], (...a) => scan.placeholderTextIssues(...a)],
  ['placeholderTextIssues', ['여기에 입력 [insert name] click to edit', 'p[2]', {}], (...a) => scan.placeholderTextIssues(...a)],
  ['placeholderTextIssues', ['A clean sentence about revenue.', 'p[2]', {}], (...a) => scan.placeholderTextIssues(...a)],
  ['expandRange', ['A10'], (s) => cells.expandRange(s)],
  ['expandRange', [' b2:D5 '], (s) => cells.expandRange(s)],
  ['expandRange', ['A:B'], (s) => cells.expandRange(s)],
  ['formulaReferences', ["SUM(A1:B2)+'Sheet 2'!$C$3+Data!D4+a1", 'Main'], (...a) => cells.formulaReferences(...a)],
  ['setCellInSheet', ['<worksheet><sheetData/></worksheet>', 'B2', 'hi & bye', ''], (...a) => cells.setCellInSheet(...a)],
  ['setCellInSheet', ['<worksheet><sheetData><row r="2"><c r="A2" s="3"><v>1</v></c></row></sheetData></worksheet>', 'A2', 5, ''], (...a) => cells.setCellInSheet(...a)],
  ['setCellInSheet', ['<worksheet><sheetData><row r="2"><c r="A2"><v>1</v></c></row></sheetData></worksheet>', 'C2', 0, 'SUM(A2:B2)'], (...a) => cells.setCellInSheet(...a)],
  ['setCellInSheet', ['<worksheet><sheetData><row r="5"><c r="A5"/></row></sheetData></worksheet>', 'A1', true, ''], (...a) => cells.setCellInSheet(...a)],
  ['setCellInSheet', ['<worksheet/>', 'A1', 1, ''], (...a) => cells.setCellInSheet(...a)],
  ['setCellInSheet', ['<worksheet><sheetData/></worksheet>', 'ZZZZ1', 1, ''], (...a) => cells.setCellInSheet(...a)],
  ['relationOptions', [{ id: 'm1', role: 'value', label: 'l 1' }], (r) => relations.relationOptions(r)],
  ['relationOptions', [{ id: 'm1', role: 'nonsense' }], (r) => relations.relationOptions(r)],
  ['relationOptions', [{ id: 'm1', role: 'label', label: '' }], (r) => relations.relationOptions(r)],
];

const pure = [];
for (const [fn, args, run] of PURE) pure.push({ fn, args, ...(await attempt(() => run(...args))) });

const snapshotOf = async (zip) => {
  const names = Object.keys(zip.files);
  const parts = {};
  for (const name of names) if (!zip.files[name].dir) parts[name] = await opc.zipText(zip, name);
  return { names, parts };
};

const runStep = async (state, step) => {
  switch (step.op) {
    case 'create': {
      const path = join(work, `created.${String(step.kind).toLowerCase()}`);
      const made = await pkg.createPortableOoxmlDocument(path, { fileKind: step.kind, title: step.title, sheetName: step.sheetName });
      state.zip = await opc.loadPackage(path);
      return { format: made.format, fileKind: made.fileKind, parts: made.parts };
    }
    case 'ensureOverride':
      await opc.ensureContentTypeOverride(state.zip, step.part, step.type);
      return null;
    case 'removeOverride':
      await opc.removeContentTypeOverride(state.zip, step.part);
      return null;
    case 'ensureDefault':
      await opc.ensureDefaultContentType(state.zip, step.extension, step.type);
      return null;
    case 'addRel':
      return opc.addPackageRelationship(state.zip, step.rels, step.type, step.target, step.mode);
    case 'removeRel':
      await opc.removePackageRelationship(state.zip, step.rels, step.id);
      return null;
    case 'set':
      state.zip.file(step.name, step.text);
      return null;
    case 'remove':
      state.zip.remove(step.name);
      return null;
    case 'fill':
      return await opc.fillTemplateParts(state.zip, step.parts, step.tag, { tokens: step.tokens, strict: step.strict });
    case 'fingerprint': {
      const path = join(work, `saved.${step.format}`);
      await opc.savePackage(state.zip, path);
      return await core.documentFingerprint(path, step.format);
    }
    case 'flatFingerprint': {
      const path = join(work, `flat.${step.format}`);
      writeFileSync(path, step.text);
      return await core.documentFingerprint(path, step.format);
    }
    case 'load': {
      const path = join(work, 'loaded.bin');
      writeFileSync(path, Buffer.from(step.base64, 'base64'));
      const target = step.missing ? join(work, 'absent.docx') : path;
      try {
        await opc.loadPackage(target);
        return { loaded: true };
      } catch (error) {
        return { error: String(error.message).split(target).join('<path>') };
      }
    }
    case 'chartWorkbook': {
      const data = await pkg.createPortableChartWorkbook(step.rows, { sheetName: step.sheetName });
      const path = join(work, 'chart.xlsx');
      writeFileSync(path, data);
      state.zip = await opc.loadPackage(path);
      return null;
    }
    case 'workbookSheets':
      return await cells.workbookSheets(state.zip);
    default:
      throw new Error(`unknown step ${step.op}`);
  }
};

const KINDS = ['docx', 'dotx', 'xlsx', 'xltx', 'pptx', 'potx'];
const familyOf = (kind) => (['docx', 'dotx'].includes(kind) ? 'docx' : ['xlsx', 'xltx'].includes(kind) ? 'xlsx' : 'pptx');
const SEQUENCES = [];
for (const kind of KINDS) {
  SEQUENCES.push({
    name: `blank ${kind}`,
    steps: [
      { op: 'create', kind, title: '분기 <보고서> & "메모"', sheetName: "Data & 'More' with a name past thirty-one characters" },
      { op: 'fingerprint', format: familyOf(kind) },
    ],
  });
}
SEQUENCES.push({ name: 'blank docx with the defaults', steps: [{ op: 'create', kind: 'DOCX' }, { op: 'fingerprint', format: 'docx' }] });
SEQUENCES.push({ name: 'blank xlsx with the defaults', steps: [{ op: 'create', kind: 'xlsx' }, { op: 'workbookSheets' }, { op: 'fingerprint', format: 'xlsx' }] });
SEQUENCES.push({ name: 'a kind with no portable form', steps: [{ op: 'create', kind: 'doc' }] });
SEQUENCES.push({
  name: 'content types and relationships',
  steps: [
    { op: 'create', kind: 'docx', title: 'Ops' },
    { op: 'ensureOverride', part: '/word/comments.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml' },
    { op: 'ensureOverride', part: '/word/comments.xml', type: 'ignored' },
    { op: 'ensureDefault', extension: 'png', type: 'image/png' },
    { op: 'ensureDefault', extension: 'PNG', type: 'image/png' },
    { op: 'addRel', rels: 'word/_rels/document.xml.rels', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', target: 'comments.xml', mode: '' },
    { op: 'addRel', rels: 'word/_rels/document.xml.rels', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', target: 'https://example.com/?a=1&b=2', mode: 'External' },
    { op: 'addRel', rels: 'word/_rels/footer1.xml.rels', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: 'media/a.png', mode: '' },
    { op: 'removeRel', rels: 'word/_rels/document.xml.rels', id: 'rId1' },
    { op: 'removeRel', rels: 'word/_rels/none.xml.rels', id: 'rId1' },
    { op: 'removeOverride', part: '/word/comments.xml' },
    { op: 'set', name: 'word/media/a.png', text: 'x' },
    { op: 'remove', name: 'docProps/app.xml' },
    { op: 'fingerprint', format: 'docx' },
  ],
});
const RUNS =
  '<w:document><w:body><w:p><w:r><w:t>{{com</w:t></w:r><w:r><w:t>pany}}은 {{ date }} {{item}}을 {{ 계약명 }} {{missing}}</w:t></w:r></w:p></w:body></w:document>';
SEQUENCES.push({
  name: 'template tokens with Korean particles',
  steps: [
    { op: 'create', kind: 'docx' },
    { op: 'set', name: 'word/document.xml', text: RUNS },
    { op: 'fill', parts: ['word/document.xml'], tag: 'w:t', tokens: { company: '모아페이', date: '2026-01-02', item: '사과', 계약명: 'A & B', extra: 1 }, strict: false },
    { op: 'fill', parts: ['word/document.xml', 'word/absent.xml'], tag: 'w:t', tokens: { missing: null }, strict: true },
    { op: 'fingerprint', format: 'docx' },
  ],
});
SEQUENCES.push({
  name: 'template tokens that meet nothing and a strict fill',
  steps: [
    { op: 'create', kind: 'docx' },
    { op: 'set', name: 'word/document.xml', text: RUNS },
    { op: 'fill', parts: ['word/document.xml'], tag: 'w:t', tokens: { other: 'x' }, strict: false },
    { op: 'fill', parts: ['word/document.xml'], tag: 'w:t', tokens: { company: 'Acme' }, strict: true },
    { op: 'fill', parts: ['word/document.xml'], tag: 'w:t', tokens: ['not', 'an', 'object'], strict: false },
    { op: 'fill', parts: ['word/document.xml'], tag: 'w:t', tokens: {}, strict: false },
  ],
});
SEQUENCES.push({
  name: 'a workbook id does not change the fingerprint',
  steps: [
    { op: 'create', kind: 'xlsx' },
    { op: 'set', name: 'xl/workbook.xml', text: '<workbook><workbookPr documentId="{A}"/></workbook>' },
    { op: 'fingerprint', format: 'xlsx' },
    { op: 'set', name: 'xl/workbook.xml', text: '<workbook><workbookPr documentId="{B}"/></workbook>' },
    { op: 'fingerprint', format: 'xlsx' },
    { op: 'set', name: 'docProps/core.xml', text: '<other/>' },
    { op: 'fingerprint', format: 'xlsx' },
    { op: 'set', name: '가.xml', text: '1' },
    { op: 'set', name: '😀.xml', text: '2' },
    { op: 'set', name: '～.xml', text: '3' },
    { op: 'fingerprint', format: 'xlsx' },
  ],
});
SEQUENCES.push({
  name: 'flat files are the hash of their bytes',
  steps: [
    { op: 'flatFingerprint', format: 'csv', text: 'a,b\n1,2\n' },
    { op: 'flatFingerprint', format: 'tsv', text: '가\t나\n' },
    { op: 'flatFingerprint', format: 'pdf', text: '%PDF-1.4' },
  ],
});
SEQUENCES.push({
  name: 'files that are not packages',
  steps: [
    { op: 'load', base64: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]).toString('base64') },
    { op: 'load', base64: Buffer.from('PK nothing here').toString('base64') },
    { op: 'load', base64: Buffer.from('plain text').toString('base64') },
    { op: 'load', base64: '', missing: true },
  ],
});
SEQUENCES.push({
  name: 'the chart data workbook',
  steps: [
    { op: 'chartWorkbook', rows: [['Quarter', 'Sales'], ['Q1 <a>', 12.5], ['Q2', 0], [null, 'x'], ['', 3]], sheetName: 'Data' },
    { op: 'workbookSheets' },
    { op: 'fingerprint', format: 'xlsx' },
  ],
});

const sequences = [];
for (const sequence of SEQUENCES) {
  const state = { zip: null };
  const outputs = [];
  for (const step of sequence.steps) outputs.push(await attempt(() => runStep(state, step)));
  sequences.push({ ...sequence, outputs, snapshot: state.zip ? await snapshotOf(state.zip) : null });
}
rmSync(work, { recursive: true, force: true });

writeJson(join(stage, 'golden.json'), { pure, sequences });
writeSetManifest(stage, { set: 'office-package', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
