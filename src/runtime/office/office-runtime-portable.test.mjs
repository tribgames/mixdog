import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { recalculateLibreOfficeWorkbook } from './portable/portable-ooxml.mjs';
import { parseXlsxAutofitRange } from './portable/xlsx-contract.mjs';
import { value, workspace, writeZip } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

test('XLSX autofit accepts bounded cell, whole-column, and whole-row selectors', () => {
  assert.equal(parseXlsxAutofitRange('A1:D5').type, 'cells');
  assert.deepEqual(parseXlsxAutofitRange('A:D'), { type: 'columns', start: 1, end: 4 });
  assert.deepEqual(parseXlsxAutofitRange('2:8'), { type: 'rows', start: 2, end: 8 });
  assert.throws(() => parseXlsxAutofitRange('D:A'), /Invalid XLSX column range/);
});

test('create initial operations and finalize collapse a portable workflow into one call', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'workflow.csv');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'csv',
    operations: [
      { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], ['alpha', 1]] },
    ],
    finalize: true,
  }, { cwd }));
  assert.equal(created.document, undefined);
  assert.equal(created.batch.changeSummary.changed, 1);
  assert.equal(created.finalized, true);
  assert.equal(created.failOn, 'warning');
  assert.equal(created.saved, true);
  assert.equal(created.saveSkipped, true);
  assert.equal(created.closed, true);
});

test('batch with finalize completes an inspected portable workflow in one remaining call', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'inspected.csv');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'csv',
  }, { cwd }));
  const completed = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], ['alpha', 1]] },
    ],
    finalize: true,
  }, { cwd }));
  assert.equal(completed.batch.changeSummary.changed, 1);
  assert.equal(completed.finalized, true);
  assert.equal(completed.saveSkipped, true);
  assert.equal(completed.closed, true);
});

test('portable workbook recalculation is skipped without formulas and blocks unsafe containers', async (t) => {
  const cwd = await workspace(t);
  const plain = join(cwd, 'plain.xlsx');
  await writeZip(plain, {
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
  });
  const skipped = await recalculateLibreOfficeWorkbook(plain, { force: true });
  assert.deepEqual(skipped, {
    needed: false,
    recalculated: false,
    formulaCount: 0,
    missingCachedValues: 0,
  });

  const macro = join(cwd, 'formula.xlsm');
  await writeZip(macro, {
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData></worksheet>',
  });
  const blocked = await recalculateLibreOfficeWorkbook(macro, { force: true });
  assert.equal(blocked.needed, true);
  assert.equal(blocked.recalculated, false);
  assert.match(blocked.reason, /supports \.xlsx only/);
});

test('portable XLSM edits preserve VBA payload and strict package relationships', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'macro.xlsm');
  const output = join(cwd, 'macro-copy.xlsm');
  const vba = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 1, 2, 3, 4]);
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="vbaProject" Target="vbaProject.bin"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
    'xl/vbaProject.bin': vba,
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  assert.equal(opened.fileKind, 'xlsm');
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'macro-safe' }],
  }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.macros, ['xl/vbaProject.bin']);
  assert.deepEqual(validation.baseline.lostProtectedParts, []);
  const zip = await JSZip.loadAsync(await readFile(output));
  assert.deepEqual(await zip.file('xl/vbaProject.bin').async('nodebuffer'), vba);
});

test('portable DOCX preserves the package while replacing split runs and appending text', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.docx');
  const output = join(cwd, 'edited.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    'word/media/untouched.bin': Buffer.from([1, 2, 3, 4]),
  });

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  assert.equal(opened.mode, 'portable');
  assert.equal(opened.backend, 'mixdog-ooxml');
  const described = value(await executeOfficeTool({
    action: 'describe',
    session: opened.session,
  }, { cwd }));
  assert.ok(described.operations.includes('set_paragraph_style'));
  assert.ok(described.operations.includes('fill_template'));
  assert.ok(!described.unsupportedInBackend.includes('set_paragraph_style'));
  assert.deepEqual(described.unsupportedInBackend, []);

  const begun = value(await executeOfficeTool({
    action: 'begin',
    session: opened.session,
  }, { cwd }));
  assert.equal(begun.transaction.diff.summary.total, 0);
  const temporary = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Temporary transaction text' }],
  }, { cwd }));
  assert.ok(temporary.transaction.diff.summary.modified > 0);
  const blockedSave = await executeOfficeTool({ action: 'save', session: opened.session }, { cwd });
  assert.equal(blockedSave.isError, true);
  assert.match(blockedSave.content[0].text, /Commit or roll back/);
  const blockedClose = await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
  assert.equal(blockedClose.isError, true);
  const transactionDiff = value(await executeOfficeTool({
    action: 'diff',
    session: opened.session,
  }, { cwd }));
  assert.ok(transactionDiff.transaction.diff.changes.some((change) => change.path === '/body/p[1]'));
  resetOfficeSessionsForTest();
  const pending = value(await executeOfficeTool({ action: 'transactions' }, { cwd }));
  assert.equal(pending.transactions[0].id, begun.transaction.id);
  assert.equal(pending.transactions[0].phase, 'active');
  const rolledBack = value(await executeOfficeTool({
    action: 'recover',
    transaction: begun.transaction.id,
    strategy: 'rollback',
  }, { cwd }));
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(rolledBack.remainingDiff.summary.total, 0);
  assert.equal(value(await executeOfficeTool({ action: 'transactions' }, { cwd })).transactions.length, 0);

  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'replace_text', find: 'Hello World', replace: '안녕하세요' },
      { op: 'append_text', text: 'Tail paragraph' },
      { op: 'set_table_cell', table: 1, row: 1, col: 1, text: 'Path cell' },
    ],
  }, { cwd }));
  assert.equal(edited.atomic, true);
  assert.equal(edited.results[0].count, 1);

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  const text = JSON.stringify(snapshot.document);
  assert.match(text, /안녕하세요/);
  assert.match(text, /Tail paragraph/);
  assert.equal(snapshot.document.paragraphs[0].path, '/body/p[1]');
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].path, '/body/tbl[1]/row[1]/cell[1]');
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].text, 'Path cell');

  const firstParagraph = value(await executeOfficeTool({
    action: 'get',
    session: opened.session,
    target: '/body/p[1]',
  }, { cwd }));
  assert.equal(firstParagraph.element.text, '안녕하세요');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_paragraph_text', paragraph: 1, text: 'Path edited' },
      { op: 'set_paragraph_style', paragraph: 1, style: 'Heading1' },
    ],
  }, { cwd }));
  const queried = value(await executeOfficeTool({
    action: 'query',
    session: opened.session,
    query: 'Path edited',
  }, { cwd }));
  assert.equal(queried.matches[0].path, '/body/p[1]');

  const validation = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
  }, { cwd }));
  assert.equal(validation.ok, true);
  assert.equal(validation.validation, 'opc-relationships-content-types-xml');
  assert.deepEqual(validation.missingRelationships, []);
  assert.deepEqual(validation.malformedXml, []);

  const zip = await JSZip.loadAsync(await readFile(output));
  assert.match(await zip.file('word/document.xml').async('string'), /<w:pStyle w:val="Heading1"\/>/);
  assert.deepEqual(await zip.file('word/media/untouched.bin').async('nodebuffer'), Buffer.from([1, 2, 3, 4]));

  const beforeExternalEdit = await readFile(output);
  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  const externalZip = await JSZip.loadAsync(beforeExternalEdit);
  externalZip.file('word/document.xml', (await externalZip.file('word/document.xml').async('string')).replace('Path edited', 'Outside edit'));
  await writeFile(output, await externalZip.generateAsync({ type: 'nodebuffer' }));
  const conflicted = await executeOfficeTool({ action: 'diff', session: opened.session }, { cwd });
  assert.equal(conflicted.isError, true);
  const conflictValue = JSON.parse(conflicted.content[0].text);
  assert.equal(conflictValue.code, 'transaction_conflict');
  assert.ok(conflictValue.externalDiff.summary.modified > 0);
  await writeFile(output, beforeExternalEdit);
  value(await executeOfficeTool({ action: 'rollback', session: opened.session }, { cwd }));
});

test('portable DOCX set creates editable runs in empty paragraphs', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'empty-paragraphs.docx');
  const output = join(cwd, 'edited-empty-paragraphs.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Self-closing paragraph' }],
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 2, text: 'Styled empty paragraph' }],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.equal(snapshot.document.paragraphs[0].text, 'Self-closing paragraph');
  assert.equal(snapshot.document.paragraphs[1].text, 'Styled empty paragraph');
  assert.equal(snapshot.document.paragraphs[1].style, 'Normal');
});

test('portable DOCX authors professional tables and paragraph layout', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'professional.docx');
  const output = join(cwd, 'professional-output.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Summary</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      {
        op: 'add_table',
        values: [['Metric', 'Value'], ['Revenue', '120']],
        properties: {
          style: 'TableGrid',
          columnWidths: [120, 60],
          borders: { style: 'single', color: '808080', size: 4 },
        },
      },
      { op: 'set_table_cell_style', table: 1, row: 1, col: 1, properties: { fillColor: 'D9EAF7', bold: true } },
      { op: 'merge_table_cells', table: 1, row: 2, col: 1, colSpan: 2 },
      {
        op: 'set_paragraph_format',
        paragraph: 1,
        properties: {
          alignment: 'center',
          spacingAfter: 120,
          border: { side: 'bottom', style: 'single', color: '2F5597', size: 8 },
          tabStops: [{ position: 360, alignment: 'right', leader: 'dot' }],
        },
      },
    ],
  }, { cwd }));
  assert.equal(edited.changeSummary.changed, 4);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.tables.length, 1);
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].text, 'Metric');
  const xml = await (await JSZip.loadAsync(await readFile(output))).file('word/document.xml').async('string');
  assert.match(xml, /<w:tblStyle w:val="TableGrid"\/>/);
  assert.match(xml, /<w:gridSpan w:val="2"\/>/);
  assert.match(xml, /<w:gridCol w:w="2400"\/><w:gridCol w:w="1200"\/>/, 'point widths convert to twips');
  assert.match(xml, /<w:tab w:val="right" w:pos="7200" w:leader="dot"\/>/, '360pt lands on the 5in tab stop');
});

test('DOCX redlining audit rejects untracked text edits', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'redline-source.docx');
  const output = join(cwd, 'redline-output.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Original text</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Untracked replacement' }],
  }, { cwd }));
  const validation = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
    auditProfile: 'redlining',
  }, { cwd }));
  assert.equal(validation.ok, false);
  assert.equal(validation.redlining.ok, false);
  assert.match(validation.redlining.reason, /untracked/i);
});

test('strict OOXML validation rejects missing relationship targets', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'broken.docx');
  const output = join(cwd, 'broken-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="image" Target="media/missing.png"/></Relationships>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, false);
  assert.equal(validation.missingRelationships[0].resolved, 'word/media/missing.png');
});

test('portable DOCX snapshots structured comments and revisions', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'review.docx');
  const output = join(cwd, 'review-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Anchored text</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p><w:p><w:ins w:id="8" w:author="Editor" w:date="2026-08-27T00:00:00Z"><w:r><w:t>Inserted</w:t></w:r></w:ins><w:del w:id="9" w:author="Editor"><w:r><w:delText>Deleted</w:delText></w:r></w:del></w:p></w:body></w:document>',
    'word/comments.xml': '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="7" w:author="Reviewer" w:initials="RV" w:date="2026-08-27T00:00:00Z"><w:p><w:r><w:t>Needs source</w:t></w:r></w:p></w:comment></w:comments>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  assert.equal(opened.document.commentCount, 1);
  assert.deepEqual(opened.document.comments[0], {
    path: '/body/comment[1]',
    index: 1,
    id: '7',
    author: 'Reviewer',
    initials: 'RV',
    date: '2026-08-27T00:00:00Z',
    text: 'Needs source',
    anchoredText: 'Anchored text',
    part: 'word/document.xml',
  });
  assert.equal(opened.document.revisionCount, 2);
  assert.equal(opened.document.revisions[0].type, 'insertion');
  assert.equal(opened.document.revisions[0].text, 'Inserted');
  assert.equal(opened.document.revisions[1].type, 'deletion');
  assert.equal(opened.document.revisions[1].text, 'Deleted');
  const issues = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  assert.ok(issues.issues.some((issue) => issue.code === 'unresolved_comments'));
  assert.ok(issues.issues.some((issue) => issue.code === 'unresolved_revisions'));
});

test('portable DOCX fills split template tokens across stories and rolls back strict failures', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'template.docx');
  const output = join(cwd, 'filled.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{ na</w:t></w:r><w:r><w:t>me }}</w:t></w:r></w:p><w:p><w:r><w:t>{{missing}}</w:t></w:r></w:p></w:body></w:document>',
    'word/header1.xml': '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Owner: {{ owner }}</w:t></w:r></w:p></w:hdr>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const rejected = await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_template', tokens: { name: 'Ada', owner: 'Team' }, strict: true }],
  }, { cwd });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /missing/);
  const beforeFill = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.match(JSON.stringify(beforeFill.document), /\{\{ name }}/);

  const filled = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_template', tokens: { name: 'Ada', owner: 'Team', missing: 'Done' }, strict: true }],
  }, { cwd }));
  assert.deepEqual(filled.results[0].unfilledTokens, []);
  assert.deepEqual(filled.results[0].filled, { name: 1, missing: 1, owner: 1 });
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.match(JSON.stringify(snapshot.document), /Ada/);
  assert.match(JSON.stringify(snapshot.document), /Owner: Team/);
  assert.doesNotMatch(JSON.stringify(snapshot.document), /\{\{/);
});

test('portable XLSX edits cells, ranges, formulas, and appended rows', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.xlsx');
  const output = join(cwd, 'edited.xlsx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="InputRange">Data!$B$1:$C$2</definedName></definedNames></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Old</t></is></c></row></sheetData><dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="E1:E3"><formula1>"Yes,No"</formula1></dataValidation></dataValidations></worksheet>',
  });

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'New' },
      { op: 'set_range', sheet: 'Data', range: 'B1:C2', values: [[1, 2], [3, 4]] },
      { op: 'set_formula', sheet: 'Data', cell: 'D1', formula: '=SUM(B1:C2)' },
      { op: 'append_row', sheet: 'Data', values: ['tail', 5] },
    ],
  }, { cwd }));

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  const cells = snapshot.document.sheets[0].cells;
  assert.equal(cells.find((cell) => cell.ref === 'A1').value, 'New');
  assert.equal(cells.find((cell) => cell.ref === 'C2').value, '4');
  assert.equal(cells.find((cell) => cell.ref === 'D1').formula, 'SUM(B1:C2)');
  assert.equal(cells.find((cell) => cell.ref === 'D1').cachedValue, null);
  assert.equal(cells.find((cell) => cell.ref === 'D1').cacheState, 'missing');
  assert.equal(cells.find((cell) => cell.value === 'tail').ref, 'A3');
  assert.equal(cells.find((cell) => cell.ref === 'A1').path, '/sheet[Data]/cell[A1]');
  assert.equal(snapshot.document.formulaCount, 1);
  assert.equal(snapshot.document.formulaCacheMissing, 1);
  assert.equal(snapshot.document.needsRecalculation, true);
  assert.deepEqual(snapshot.document.calculation, {
    mode: 'auto',
    fullCalcOnLoad: true,
    forceFullCalc: true,
  });
  assert.equal(snapshot.document.definedNameCount, 1);
  assert.equal(snapshot.document.definedNames[0].name, 'InputRange');
  assert.equal(snapshot.document.definedNames[0].refersTo, 'Data!$B$1:$C$2');
  assert.equal(snapshot.document.sheets[0].validationCount, 1);
  assert.deepEqual(snapshot.document.sheets[0].validations[0].ranges, ['E1:E3']);
  assert.equal(snapshot.document.sheets[0].validations[0].formula1, '"Yes,No"');

  for (const operation of [
    { op: 'set_range', sheet: 'Data', range: 'A1:XFD1048576', values: [] },
    { op: 'set_range', sheet: 'Data', range: 'C2:B1', values: [] },
    { op: 'set_range', sheet: 'Data', range: 'B5:C6', values: [[1, 2]] },
    { op: 'set_cell', sheet: 'Data', cell: 'XFE1', value: 'outside' },
  ]) {
    const rejected = await executeOfficeTool({
      action: 'batch',
      session: opened.session,
      operations: [operation],
    }, { cwd });
    assert.equal(rejected.isError, true);
  }

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'Path set' }],
  }, { cwd }));
  const cell = value(await executeOfficeTool({
    action: 'get',
    session: opened.session,
    target: '/sheet[Data]/cell[A1]',
  }, { cwd }));
  assert.equal(cell.element.value, 'Path set');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'E1', value: '#REF!' }],
  }, { cwd }));
  const issues = value(await executeOfficeTool({
    action: 'issues',
    session: opened.session,
  }, { cwd }));
  assert.equal(issues.ok, false);
  assert.ok(issues.issues.some((issue) => issue.code === 'formula_cache_missing' && issue.path === '/sheet[Data]/cell[D1]'));
  assert.ok(issues.issues.some((issue) => issue.code === 'formula_error' && issue.path === '/sheet[Data]/cell[E1]'));

  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'F1', value: 'Committed' }],
  }, { cwd }));
  const committed = value(await executeOfficeTool(
    { action: 'commit', session: opened.session },
    { cwd },
  ));
  assert.equal(committed.committed, true);
  assert.ok(committed.transaction.diff.summary.added > 0);
});

test('XLSX finalize assertions prove values, formulas, tie-outs, and errors', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'assertions-source.xlsx');
  const output = join(cwd, 'assertions.xlsx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
  });
  const created = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'set_range', sheet: 'Sheet1', range: 'A1:B2', values: [['Actual', 'Plan'], [120, 120]] },
      { op: 'set_formula', sheet: 'Sheet1', cell: 'C2', formula: '=A2-B2' },
    ],
  }, { cwd }));
  const passed = value(await executeOfficeTool({
    action: 'validate',
    session: created.session,
    assertions: [
      { kind: 'cell-value', sheet: 'Sheet1', cell: 'A2', equals: 120 },
      { kind: 'cell-formula', sheet: 'Sheet1', cell: 'C2', equals: '=A2-B2' },
      { kind: 'tie-out', sheet: 'Sheet1', left: 'A2', right: 'B2', tolerance: 0 },
      { kind: 'no-errors', sheet: 'Sheet1' },
    ],
  }, { cwd }));
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.equal(passed.assertions.passed, 4);
  const failed = value(await executeOfficeTool({
    action: 'validate',
    session: created.session,
    assertions: [{ kind: 'cell-value', sheet: 'Sheet1', cell: 'A2', equals: 999 }],
  }, { cwd }));
  assert.equal(failed.ok, false);
  assert.equal(failed.assertions.issues[0].code, 'assertion_value_mismatch');
});

test('portable PPTX fills template tokens while preserving masters and layouts', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.pptx');
  const output = join(cwd, 'edited.pptx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{{ti</a:t></a:r><a:r><a:t>tle}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/notesSlides/notesSlide1.xml': '<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Owner {{owner}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    'ppt/slideMasters/slideMaster1.xml': '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Master"/></p:sldMaster>',
    'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Layout"/></p:sldLayout>',
  });

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'fill_template', tokens: { title: 'Mixdog', owner: '재영' }, strict: true },
      { op: 'add_textbox', slide: 1, text: 'Second box', left: 20, top: 40, width: 200, height: 50 },
    ],
  }, { cwd }));

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.deepEqual(snapshot.document.slides[0].text, ['Mixdog', 'Second box']);
  assert.equal(snapshot.document.slides[0].shapes[0].path, '/slide[1]/shape[1]');
  assert.equal(snapshot.document.layoutCount, 1);
  assert.equal(snapshot.document.layouts[0].name, 'Brand Layout');
  const packageAfterFill = await JSZip.loadAsync(await readFile(output));
  assert.equal(await packageAfterFill.file('ppt/slideMasters/slideMaster1.xml').async('string'), '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Master"/></p:sldMaster>');
  assert.match(await packageAfterFill.file('ppt/notesSlides/notesSlide1.xml').async('string'), /Owner 재영/);

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_text', slide: 1, shape: 1, text: 'Path shape' },
      { op: 'delete_shape', slide: 1, shape: 2 },
    ],
  }, { cwd }));
  const updated = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.equal(updated.document.slides[0].shapes[0].text, 'Path shape');
  assert.equal(updated.document.slides[0].shapes.length, 1);
});

test('macro and digital-signature containers expose security inventory and fail invalidated signatures', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'signed.xlsm');
  const output = join(cwd, 'signed-copy.xlsm');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Default Extension="sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="vbaProject" Target="vbaProject.bin"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
    'xl/vbaProject.bin': Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 1, 2, 3, 4]),
    '_xmlsignatures/origin.sigs': Buffer.from([1, 2, 3]),
    '_xmlsignatures/sig1.xml': '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'edited' }],
  }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, false);
  assert.equal(validation.security.macroExecution, 'disabled');
  assert.equal(validation.security.macros.length, 1);
  assert.equal(validation.security.signatures.length, 2);
  assert.equal(validation.security.digitalSignatureInvalidated, true);
});
