import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { recalculateLibreOfficeWorkbook } from './portable/portable-ooxml.mjs';
import { parseXlsxAutofitRange } from './portable/xlsx-contract.mjs';
import { auditDocxRedlining } from './portable/docx-revisions.mjs';
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
  assert.deepEqual(validation.redlining.untrackedEdits.before, ['Original text']);
  assert.deepEqual(validation.redlining.untrackedEdits.after, ['Untracked replacement']);
  assert.equal(validation.redlining.untrackedEdits.paragraph, 1);
  assert.ok(validation.redlining.guidance.length >= 1);
});

test('DOCX redlining audit accepts tracked edits by the named author and reports foreign authors', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'redline-tracked.docx');
  const output = join(cwd, 'redline-tracked-output.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Original text</w:t></w:r></w:p><w:p><w:r><w:t>Keep this paragraph</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell value</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'track_changes', enabled: true },
      { op: 'set_paragraph_text', paragraph: 1, text: 'Tracked replacement', author: 'Reviewer' },
      { op: 'replace_text', find: 'Keep this', replace: 'Retain this', author: 'Reviewer' },
      { op: 'set_table_cell', table: 1, row: 1, col: 1, text: 'Cell revised', author: 'Reviewer' },
    ],
  }, { cwd }));
  assert.equal(edited.results[1].tracked, true);
  assert.equal(edited.results[2].tracked, true);
  assert.equal(edited.results[2].count, 1);
  assert.equal(edited.results[2].granularity, 'run');
  assert.equal(edited.results[3].tracked, true);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.revisionCount, 6);
  assert.deepEqual(snapshot.document.revisionAuthors, [{ author: 'Reviewer', insertions: 3, deletions: 3 }]);
  assert.deepEqual(snapshot.document.paragraphs.map((paragraph) => paragraph.text), ['Tracked replacement', 'Retain this paragraph']);
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].text, 'Cell revised');
  const byReviewer = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
    auditProfile: 'redlining',
    author: 'Reviewer',
  }, { cwd }));
  assert.equal(byReviewer.ok, true);
  assert.equal(byReviewer.redlining.ok, true);
  assert.deepEqual(byReviewer.redlining.newChanges, { insertions: 3, deletions: 3 });
  assert.equal(byReviewer.redlining.untrackedEdits, null);
  const bySomeoneElse = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
    auditProfile: 'redlining',
    author: 'Someone else',
  }, { cwd }));
  assert.equal(bySomeoneElse.redlining.ok, false);
  assert.equal(bySomeoneElse.redlining.foreignAuthors.length, 6);
  assert.match(bySomeoneElse.redlining.reason, /author other than "Someone else"/);
  const zip = await JSZip.loadAsync(await readFile(output));
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /<w:del [^>]*w:author="Reviewer"[^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:delText>Original text<\/w:delText><\/w:r><\/w:del>/);
  assert.match(xml, /<w:ins [^>]*w:author="Reviewer"[^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Tracked replacement<\/w:t><\/w:r><\/w:ins>/);
  // Only the matched characters are redlined; the rest of the paragraph keeps its run.
  assert.match(xml, /<w:del [^>]*><w:r><w:delText xml:space="preserve">Keep this<\/w:delText><\/w:r><\/w:del><w:ins [^>]*><w:r><w:t xml:space="preserve">Retain this<\/w:t><\/w:r><\/w:ins><w:r><w:t xml:space="preserve"> paragraph<\/w:t><\/w:r>/);
});

test('portable DOCX resolve_revisions drops a comment whose anchored text was deleted', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'commented-deletion.docx');
  const output = join(cwd, 'commented-deletion-clean.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Doomed sentence</w:t></w:r></w:p><w:p><w:r><w:t>Survivor</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'add_comment', find: 'Doomed', text: 'Cut this?', author: 'Reviewer' },
      { op: 'add_comment', find: 'Survivor', text: 'Keep', author: 'Reviewer' },
      { op: 'track_changes', enabled: true },
      { op: 'remove_paragraph', paragraph: 1, author: 'Reviewer' },
    ],
  }, { cwd }));
  const resolved = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
  }, { cwd }));
  assert.equal(resolved.results[0].commentsRemoved, 1);
  assert.equal(resolved.results[0].mergedParagraphs, 1);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(snapshot.document.paragraphs.map((paragraph) => paragraph.text), ['Survivor']);
  assert.equal(snapshot.document.commentCount, 1);
  assert.equal(snapshot.document.comments[0].anchoredText, 'Survivor');
  assert.equal(snapshot.document.commentThreadCount, 1);
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.documentLint, []);
  const zip = await JSZip.loadAsync(await readFile(output));
  assert.equal(((await zip.file('word/commentsIds.xml').async('string')).match(/<w16cid:commentId\b/g) || []).length, 1);
});

test('portable DOCX resolve_revisions settles tracked table rows and cell paragraph marks', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'table-marks.docx');
  const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const stamp = 'w:author="Editor" w:date="2026-01-01T00:00:00Z"';
  const document = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>'
    + `<w:tr><w:tc><w:p><w:pPr><w:rPr><w:del w:id="1" ${stamp}/></w:rPr></w:pPr><w:r><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>`
    + `<w:tr><w:trPr><w:del w:id="2" ${stamp}/></w:trPr><w:tc><w:p><w:r><w:t>Gone</w:t></w:r></w:p></w:tc></w:tr>`
    + '</w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p></w:body></w:document>';
  await writeZip(source, { '[Content_Types].xml': contentTypes, 'word/document.xml': document });

  const accepting = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'table-marks-accepted.docx'), mode: 'portable' }, { cwd }));
  const accepted = value(await executeOfficeTool({
    action: 'batch',
    session: accepting.session,
    operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
  }, { cwd }));
  assert.equal(accepted.results[0].mergedParagraphs, 1);
  assert.deepEqual(accepted.results[0].tableRows, { removed: 1, cleared: 0 });
  const afterAccept = value(await executeOfficeTool({ action: 'snapshot', session: accepting.session }, { cwd }));
  assert.equal(afterAccept.document.tables[0].rows.length, 1);
  assert.equal(afterAccept.document.tables[0].rows[0].cells[0].text, 'AB');
  const acceptedXml = await (await JSZip.loadAsync(await readFile(join(cwd, 'table-marks-accepted.docx')))).file('word/document.xml').async('string');
  assert.doesNotMatch(acceptedXml, /<w:del\b|Gone/);
  assert.equal((acceptedXml.match(/<w:p>/g) || []).length, 2);

  const rejecting = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'table-marks-rejected.docx'), mode: 'portable' }, { cwd }));
  const rejected = value(await executeOfficeTool({
    action: 'batch',
    session: rejecting.session,
    operations: [{ op: 'resolve_revisions', resolution: 'reject' }],
  }, { cwd }));
  assert.equal(rejected.results[0].mergedParagraphs, 0);
  assert.deepEqual(rejected.results[0].tableRows, { removed: 0, cleared: 1 });
  const afterReject = value(await executeOfficeTool({ action: 'snapshot', session: rejecting.session }, { cwd }));
  assert.equal(afterReject.document.tables[0].rows.length, 2);
  assert.equal(afterReject.document.tables[0].rows[1].cells[0].text, 'Gone');
  const rejectedXml = await (await JSZip.loadAsync(await readFile(join(cwd, 'table-marks-rejected.docx')))).file('word/document.xml').async('string');
  assert.doesNotMatch(rejectedXml, /<w:del\b/);
});

test('portable DOCX resolve_revisions settles moves and formatting change records so Word shows no revision', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'formatting.docx');
  const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const stamp = 'w:author="Editor" w:date="2026-01-01T00:00:00Z"';
  const document = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr><w:pPrChange w:id="10" ${stamp}><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>`
    + `<w:r><w:rPr><w:i/><w:rPrChange w:id="11" ${stamp}><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>Styled</w:t></w:r></w:p>`
    + `<w:p><w:moveFromRangeStart w:id="20" w:name="move1"/><w:moveFrom w:id="21" ${stamp}><w:r><w:delText>Moved</w:delText></w:r></w:moveFrom><w:moveFromRangeEnd w:id="20"/></w:p>`
    + `<w:p><w:moveToRangeStart w:id="22" w:name="move1"/><w:moveTo w:id="23" ${stamp}><w:r><w:t>Moved</w:t></w:r></w:moveTo><w:moveToRangeEnd w:id="22"/></w:p>`
    + '</w:body></w:document>';
  await writeZip(source, { '[Content_Types].xml': contentTypes, 'word/document.xml': document });

  const accepting = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'formatting-accepted.docx'), mode: 'portable' }, { cwd }));
  assert.deepEqual(accepting.document.revisions.map((revision) => revision.type), ['moved_from', 'moved_to']);
  assert.equal(accepting.document.propertyChangeCount, 2);
  const pending = value(await executeOfficeTool({ action: 'issues', session: accepting.session }, { cwd }));
  assert.match(pending.issues.find((issue) => issue.code === 'unresolved_revisions').message, /2 formatting change record/);
  const accepted = value(await executeOfficeTool({
    action: 'batch',
    session: accepting.session,
    operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
  }, { cwd }));
  assert.equal(accepted.results[0].resolved, 2);
  assert.equal(accepted.results[0].propertyChanges, 2);
  const acceptedXml = await (await JSZip.loadAsync(await readFile(join(cwd, 'formatting-accepted.docx')))).file('word/document.xml').async('string');
  assert.doesNotMatch(acceptedXml, /Change\b|moveFrom|moveTo|Range(?:Start|End)/);
  assert.ok(acceptedXml.includes('<w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>'));
  assert.ok(acceptedXml.includes('<w:r><w:rPr><w:i/></w:rPr><w:t>Styled</w:t></w:r>'));
  const afterAccept = value(await executeOfficeTool({ action: 'snapshot', session: accepting.session }, { cwd }));
  assert.deepEqual(afterAccept.document.paragraphs.map((paragraph) => paragraph.text), ['Styled', '', 'Moved']);
  assert.equal(afterAccept.document.propertyChangeCount, 0);

  const rejecting = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'formatting-rejected.docx'), mode: 'portable' }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: rejecting.session,
    operations: [{ op: 'resolve_revisions', resolution: 'reject' }],
  }, { cwd }));
  const rejectedXml = await (await JSZip.loadAsync(await readFile(join(cwd, 'formatting-rejected.docx')))).file('word/document.xml').async('string');
  assert.doesNotMatch(rejectedXml, /Change\b|moveFrom|moveTo|Range(?:Start|End)/);
  assert.ok(rejectedXml.includes('<w:pPr><w:jc w:val="left"/><w:rPr><w:b/></w:rPr></w:pPr>'));
  assert.ok(rejectedXml.includes('<w:r><w:rPr><w:b/></w:rPr><w:t>Styled</w:t></w:r>'));
  const afterReject = value(await executeOfficeTool({ action: 'snapshot', session: rejecting.session }, { cwd }));
  assert.deepEqual(afterReject.document.paragraphs.map((paragraph) => paragraph.text), ['Styled', 'Moved', '']);
});

test('DOCX redlining audit recognises source revisions a later reviewer split or nested', () => {
  const original = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'
    + '<w:ins w:id="1" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:r><w:t>Alice added this</w:t></w:r></w:ins>'
    + '<w:r><w:t xml:space="preserve"> and more</w:t></w:r></w:p></w:body></w:document>';
  const nested = original.replace(
    '<w:r><w:t>Alice added this</w:t></w:r>',
    '<w:r><w:t xml:space="preserve">Alice added </w:t></w:r><w:del w:id="2" w:author="Bob" w:date="2026-02-01T00:00:00Z"><w:r><w:delText>this</w:delText></w:r></w:del>',
  );
  const nestedAudit = auditDocxRedlining(nested, original, { author: 'Bob' });
  assert.equal(nestedAudit.ok, true, nestedAudit.reason);
  assert.deepEqual(nestedAudit.newChanges, { insertions: 0, deletions: 1 });
  assert.equal(nestedAudit.existingChanges, 1);

  const split = original.replace(
    '<w:ins w:id="1" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:r><w:t>Alice added this</w:t></w:r></w:ins>',
    '<w:ins w:id="1" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">Alice added </w:t></w:r></w:ins>'
    + '<w:ins w:id="5" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:r><w:t>this</w:t></w:r></w:ins>',
  );
  const splitAudit = auditDocxRedlining(split, original, { author: 'Bob' });
  assert.equal(splitAudit.ok, true, splitAudit.reason);
  assert.deepEqual(splitAudit.newChanges, { insertions: 0, deletions: 0 });

  const rewritten = original.replace('Alice added this', 'Alice wrote this');
  const tampered = auditDocxRedlining(rewritten, original, { author: 'Bob' });
  assert.equal(tampered.ok, false);
  assert.deepEqual(tampered.untrackedEdits.before, ['Alice added this and more']);
  assert.deepEqual(tampered.untrackedEdits.after, [' and more']);
  assert.equal(tampered.foreignAuthors[0].author, 'Alice');
});

test('portable DOCX resolve_revisions joins a deleted paragraph mark to the next paragraph like Word', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'marks.docx');
  const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const document = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:rPr><w:del w:id="1" w:author="Editor" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">First </w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>second</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Third </w:t></w:r><w:del w:id="2" w:author="Editor" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del>'
    + '<w:ins w:id="3" w:author="Editor" w:date="2026-01-01T00:00:00Z"><w:r><w:t>kept</w:t></w:r></w:ins></w:p>'
    + '</w:body></w:document>';
  await writeZip(source, { '[Content_Types].xml': contentTypes, 'word/document.xml': document });

  const accepting = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'marks-accepted.docx'), mode: 'portable' }, { cwd }));
  assert.equal(accepting.document.revisionCount, 2);
  const accepted = value(await executeOfficeTool({
    action: 'batch',
    session: accepting.session,
    operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
  }, { cwd }));
  assert.equal(accepted.results[0].resolved, 2);
  assert.equal(accepted.results[0].mergedParagraphs, 1);
  assert.equal(accepted.results[0].note, undefined);
  const afterAccept = value(await executeOfficeTool({ action: 'snapshot', session: accepting.session }, { cwd }));
  assert.deepEqual(
    afterAccept.document.paragraphs.map((paragraph) => [paragraph.text, paragraph.style]),
    [['First second', 'Normal'], ['Third kept', 'Normal']],
  );
  assert.equal(afterAccept.document.revisionCount, 0);

  const rejecting = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'marks-rejected.docx'), mode: 'portable' }, { cwd }));
  const rejected = value(await executeOfficeTool({
    action: 'batch',
    session: rejecting.session,
    operations: [{ op: 'resolve_revisions', resolution: 'reject' }],
  }, { cwd }));
  assert.equal(rejected.results[0].paragraphMarks, 1);
  assert.equal(rejected.results[0].mergedParagraphs, 0);
  const afterReject = value(await executeOfficeTool({ action: 'snapshot', session: rejecting.session }, { cwd }));
  assert.deepEqual(
    afterReject.document.paragraphs.map((paragraph) => [paragraph.text, paragraph.style]),
    [['First ', 'Heading1'], ['second', 'Normal'], ['Third gone', 'Normal']],
  );
  const zip = await JSZip.loadAsync(await readFile(join(cwd, 'marks-rejected.docx')));
  assert.doesNotMatch(await zip.file('word/document.xml').async('string'), /<w:(?:ins|del)\b/);
});

test('portable DOCX resolve_revisions by author settles one reviewer and the snapshot maps revisions to paragraphs', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'reviewers.docx');
  const output = join(cwd, 'reviewers-settled.docx');
  const stamp = 'w:date="2026-01-01T00:00:00Z"';
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + `<w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r><w:ins w:id="1" w:author="Alice" ${stamp}><w:r><w:t>added</w:t></w:r></w:ins></w:p>`
      + `<w:p><w:pPr><w:rPr><w:del w:id="2" w:author="Bob" ${stamp}/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Beta </w:t></w:r><w:del w:id="3" w:author="Bob" ${stamp}><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`
      + `<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="4" w:author="Alice" ${stamp}><w:rPr/></w:rPrChange></w:rPr><w:t>Gamma</w:t></w:r></w:p>`
      + '</w:body></w:document>',
  });

  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const before = opened.document;
  assert.deepEqual(
    before.revisions.map((revision) => [revision.author, revision.at]),
    [['Alice', '/body/p[1]'], ['Bob', '/body/p[2]']],
  );
  assert.deepEqual(
    before.paragraphs.map((paragraph) => [paragraph.tracked, paragraph.revisions, paragraph.deletedText]),
    [[true, [1], undefined], [true, [2], 'gone'], [undefined, undefined, undefined]],
  );
  assert.equal(before.propertyChangeCount, 1);

  const unknown = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'resolve_revisions', resolution: 'accept', author: 'Nobody', allowNoChange: true }],
  }, { cwd }));
  assert.equal(unknown.results[0].changed, false);
  assert.match(unknown.results[0].note, /"Alice", "Bob"/);

  const bob = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'resolve_revisions', resolution: 'accept', author: 'Bob' }],
  }, { cwd }));
  assert.equal(bob.results[0].resolved, 1);
  assert.equal(bob.results[0].mergedParagraphs, 1);
  assert.equal(bob.results[0].propertyChanges, undefined, "Alice's formatting record is not Bob's");
  const afterBob = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(afterBob.document.paragraphs.map((paragraph) => paragraph.text), ['Alpha added', 'Beta Gamma']);
  assert.deepEqual(afterBob.document.revisionAuthors, [{ author: 'Alice', insertions: 1, deletions: 0 }]);
  assert.equal(afterBob.document.propertyChangeCount, 1);

  const alice = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'resolve_revisions', resolution: 'reject', author: 'Alice' }],
  }, { cwd }));
  assert.equal(alice.results[0].resolved, 1);
  assert.equal(alice.results[0].propertyChanges, 1);
  const afterAlice = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(afterAlice.document.paragraphs.map((paragraph) => paragraph.text), ['Alpha ', 'Beta Gamma']);
  assert.equal(afterAlice.document.revisionCount, 0);
  assert.equal(afterAlice.document.propertyChangeCount, 0);
  const zip = await JSZip.loadAsync(await readFile(output));
  const settled = await zip.file('word/document.xml').async('string');
  assert.doesNotMatch(settled, /<w:(?:ins|del|rPrChange)\b/);
  assert.doesNotMatch(settled, /<w:b\/>/, 'rejecting the formatting change restores the previous run properties');
});

test('portable DOCX revisions in a header resolve by snapshot ordinal, by id, and with the rest', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'stories.docx');
  const stamp = 'w:date="2026-01-01T00:00:00Z"';
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + `<w:p><w:r><w:t xml:space="preserve">Body </w:t></w:r><w:del w:id="1" w:author="Bob" ${stamp}><w:r><w:delText>old</w:delText></w:r></w:del></w:p>`
      + '</w:body></w:document>',
    'word/header1.xml': '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:p><w:pPr><w:rPr><w:ins w:id="6" w:author="Alice" ${stamp}/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Draft </w:t></w:r><w:ins w:id="7" w:author="Alice" ${stamp}><w:r><w:t>v2</w:t></w:r></w:ins></w:p>`
      + '<w:p><w:r><w:t>Confidential</w:t></w:r></w:p>'
      + '</w:hdr>',
  });
  const headerText = (document) => document.parts.find((part) => part.part === 'word/header1.xml').text;

  const byOrdinal = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'stories-ordinal.docx'), mode: 'portable' }, { cwd }));
  assert.deepEqual(
    byOrdinal.document.revisions.map((revision) => [revision.author, revision.part, revision.at]),
    [['Bob', 'word/document.xml', '/body/p[1]'], ['Alice', 'word/header1.xml', undefined]],
  );
  const second = value(await executeOfficeTool({
    action: 'batch',
    session: byOrdinal.session,
    operations: [{ op: 'resolve_revision', revision: 2, resolution: 'accept' }],
  }, { cwd }));
  assert.equal(second.results[0].resolved, 1);
  const afterOrdinal = value(await executeOfficeTool({ action: 'snapshot', session: byOrdinal.session }, { cwd }));
  assert.deepEqual(afterOrdinal.document.revisions.map((revision) => revision.author), ['Bob']);
  assert.equal(headerText(afterOrdinal.document), 'Draft v2\nConfidential');
  const rest = value(await executeOfficeTool({
    action: 'batch',
    session: byOrdinal.session,
    operations: [{ op: 'resolve_revisions', resolution: 'reject' }],
  }, { cwd }));
  assert.equal(rest.results[0].resolved, 1);
  assert.equal(rest.results[0].mergedParagraphs, 1, 'rejecting the inserted header paragraph mark joins it to the next paragraph');
  const afterRest = value(await executeOfficeTool({ action: 'snapshot', session: byOrdinal.session }, { cwd }));
  assert.equal(afterRest.document.revisionCount, 0);
  assert.deepEqual(afterRest.document.paragraphs.map((paragraph) => paragraph.text), ['Body old']);
  assert.equal(headerText(afterRest.document), 'Draft v2Confidential');
  const zip = await JSZip.loadAsync(await readFile(join(cwd, 'stories-ordinal.docx')));
  const header = await zip.file('word/header1.xml').async('string');
  assert.doesNotMatch(header, /<w:(?:ins|del)\b/);
  assert.equal((header.match(/<w:p\b/g) || []).length, 1);

  const byId = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'stories-id.docx'), mode: 'portable' }, { cwd }));
  const rejected = value(await executeOfficeTool({
    action: 'batch',
    session: byId.session,
    operations: [{ op: 'resolve_revision', id: '7', resolution: 'reject' }],
  }, { cwd }));
  assert.equal(rejected.results[0].id, '7');
  const afterId = value(await executeOfficeTool({ action: 'snapshot', session: byId.session }, { cwd }));
  assert.equal(headerText(afterId.document), 'Draft \nConfidential');
  assert.deepEqual(afterId.document.revisions.map((revision) => revision.author), ['Bob']);
});

test('DOCX redlining audit covers a header edited untracked and passes one edited under tracking', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'header-redline.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Body text</w:t></w:r></w:p></w:body></w:document>',
    'word/header1.xml': '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential draft</w:t></w:r></w:p></w:hdr>',
  });

  const untracked = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'header-untracked.docx'), mode: 'portable' }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: untracked.session,
    operations: [{ op: 'replace_text', find: 'Confidential', replace: 'Public' }],
  }, { cwd }));
  const failed = value(await executeOfficeTool({ action: 'validate', session: untracked.session, auditProfile: 'redlining', author: 'Reviewer' }, { cwd }));
  assert.equal(failed.redlining.ok, false);
  assert.equal(failed.redlining.untrackedEdits.part, 'word/header1.xml');
  assert.deepEqual(failed.redlining.untrackedEdits.before, ['Confidential draft']);
  assert.match(failed.redlining.reason, /header1\.xml/);
  assert.deepEqual(failed.redlining.parts.map((part) => [part.part, part.ok]), [['word/document.xml', true], ['word/header1.xml', false]]);

  const tracked = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'header-tracked.docx'), mode: 'portable' }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: tracked.session,
    operations: [
      { op: 'track_changes', enabled: true },
      { op: 'replace_text', find: 'Confidential', replace: 'Public', author: 'Reviewer' },
    ],
  }, { cwd }));
  const passed = value(await executeOfficeTool({ action: 'validate', session: tracked.session, auditProfile: 'redlining', author: 'Reviewer' }, { cwd }));
  assert.equal(passed.redlining.ok, true, passed.redlining.reason);
  assert.deepEqual(passed.redlining.newChanges, { insertions: 1, deletions: 1 });
  assert.deepEqual(passed.redlining.addedParts, []);
  assert.equal(passed.redlining.untrackedEdits, null);
});

test('portable DOCX snapshot names the table cell a revision sits in and flags the cell', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'cell-revisions.docx');
  const stamp = 'w:date="2026-01-01T00:00:00Z"';
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>'
      + '<w:tr><w:tc><w:p><w:r><w:t>Plain</w:t></w:r></w:p></w:tc>'
      + `<w:tc><w:p><w:r><w:t xml:space="preserve">Price </w:t></w:r><w:del w:id="1" w:author="Bob" ${stamp}><w:r><w:delText>10</w:delText></w:r></w:del><w:ins w:id="2" w:author="Bob" ${stamp}><w:r><w:t>12</w:t></w:r></w:ins></w:p></w:tc></w:tr>`
      + `<w:tr><w:tc><w:p><w:ins w:id="3" w:author="Alice" ${stamp}><w:r><w:t>New</w:t></w:r></w:ins></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>`
      + '</w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'cell-revisions-out.docx'), mode: 'portable' }, { cwd }));
  const { document } = opened;
  assert.deepEqual(
    document.revisions.map((revision) => revision.at),
    ['/body/tbl[1]/row[1]/cell[2]', '/body/tbl[1]/row[1]/cell[2]', '/body/tbl[1]/row[2]/cell[1]'],
  );
  const cells = document.tables[0].rows.flatMap((row) => row.cells);
  assert.deepEqual(
    cells.map((cell) => [cell.text, cell.tracked, cell.deletedText, cell.revisions]),
    [
      ['Plain', undefined, undefined, undefined],
      ['Price 12', true, '10', [1, 2]],
      ['New', true, undefined, [3]],
      ['', undefined, undefined, undefined],
    ],
  );
  assert.equal(document.paragraphs[0].tracked, undefined);
});

test('portable DOCX normalize_runs merges fragmented runs without crossing tracked changes', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'fragmented.docx');
  const output = join(cwd, 'fragmented-normalized.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'
      + '<w:r w:rsidR="00A1"><w:rPr><w:b/></w:rPr><w:t>Hel</w:t></w:r><w:proofErr w:type="spellStart"/>'
      + '<w:r w:rsidRPr="00B2"><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">lo </w:t></w:r>'
      + '<w:r><w:t>wor</w:t></w:r><w:r><w:t>ld</w:t></w:r>'
      + '<w:ins w:id="1" w:author="Editor" w:date="2026-01-01T00:00:00Z"><w:r><w:t>!</w:t></w:r></w:ins>'
      + '<w:r><w:t>?</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const normalized = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'normalize_runs' }],
  }, { cwd }));
  assert.equal(normalized.results[0].merged, 2);
  assert.equal(normalized.results[0].textMerged, 2);
  assert.equal(normalized.results[0].proofErrRemoved, 1);
  assert.equal(normalized.results[0].rsidStripped, 2);
  assert.deepEqual(normalized.results[0].parts, ['word/document.xml']);
  const zip = await JSZip.loadAsync(await readFile(output));
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r><w:ins'));
  assert.ok(xml.includes('</w:ins><w:r><w:t>?</w:t></w:r></w:p>'));
  assert.doesNotMatch(xml, /rsid|proofErr/);
  const replaced = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'replace_text', find: 'Hello world', replace: 'Hi there' },
      { op: 'normalize_runs', allowNoChange: true },
    ],
  }, { cwd }));
  assert.equal(replaced.results[0].count, 1);
  assert.equal(replaced.results[1].changed, false);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.paragraphs[0].text, 'Hi there!?');
});

test('portable DOCX comments carry the cross-linked identity parts and delete cleanly', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'commented.docx');
  const output = join(cwd, 'commented-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Please anch</w:t></w:r><w:r><w:t>or me here</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const commented = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'add_comment', find: 'anchor me', text: 'Needs a source', author: 'Reviewer', initials: 'RV' },
      { op: 'add_comment_reply', comment: 1, text: 'Added below', author: 'Author' },
    ],
  }, { cwd }));
  assert.equal(commented.results[0].anchor, 'phrase');
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, true, JSON.stringify(validation.documentLint));
  const anchored = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  // The comment highlights the phrase, cut out of its two runs, not the paragraph.
  assert.equal(anchored.document.comments[0].anchoredText, 'anchor me');
  assert.equal(anchored.document.paragraphs[0].text, 'Please anchor me here');
  const anchoredXml = await (await JSZip.loadAsync(await readFile(output))).file('word/document.xml').async('string');
  assert.ok(anchoredXml.includes('<w:t xml:space="preserve">Please </w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">anch</w:t></w:r><w:r><w:t xml:space="preserve">or me</w:t></w:r>'));
  // The reply's markers sit inside the parent range; the parent closes before the rest of the run.
  assert.ok(anchoredXml.includes('<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> here</w:t></w:r>'));
  const zip = await JSZip.loadAsync(await readFile(output));
  const ids = await zip.file('word/commentsIds.xml').async('string');
  const extensible = await zip.file('word/commentsExtensible.xml').async('string');
  const extended = await zip.file('word/commentsExtended.xml').async('string');
  assert.equal((ids.match(/<w16cid:commentId\b/g) || []).length, 2);
  assert.equal((extensible.match(/<w16cex:commentExtensible\b/g) || []).length, 2);
  assert.equal((extended.match(/<w15:commentEx\b/g) || []).length, 2);
  const paraId = /w16cid:paraId="([0-9A-F]+)"/.exec(ids)[1];
  const durableId = /w16cid:durableId="([0-9A-F]+)"/.exec(ids)[1];
  assert.ok(extended.includes(`w15:paraId="${paraId}"`));
  assert.ok(extensible.includes(`w16cex:durableId="${durableId}"`));
  assert.ok(Number.parseInt(durableId, 16) < 0x7FFFFFFF);
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  for (const target of ['comments.xml', 'commentsExtended.xml', 'commentsIds.xml', 'commentsExtensible.xml']) {
    assert.ok(rels.includes(`Target="${target}"`), target);
  }
  const types = await zip.file('[Content_Types].xml').async('string');
  assert.ok(types.includes('PartName="/word/commentsIds.xml"'));
  assert.ok(types.includes('PartName="/word/commentsExtensible.xml"'));

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'delete_comment', comment: 2 }],
  }, { cwd }));
  const after = await JSZip.loadAsync(await readFile(output));
  assert.equal(((await after.file('word/commentsIds.xml').async('string')).match(/<w16cid:commentId\b/g) || []).length, 1);
  assert.equal(((await after.file('word/commentsExtensible.xml').async('string')).match(/<w16cex:commentExtensible\b/g) || []).length, 1);
  assert.equal(((await after.file('word/commentsExtended.xml').async('string')).match(/<w15:commentEx\b/g) || []).length, 1);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.commentCount, 1);
  assert.equal(snapshot.document.commentThreadCount, 1);
});

test('DOCX validation reports revision and comment structure faults Word rejects', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'faulty.docx');
  const output = join(cwd, 'faulty-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:commentRangeStart w:id="3"/><w:r><w:t>Anchored</w:t></w:r><w:r><w:commentReference w:id="3"/></w:r></w:p>'
      + '<w:p><w:del w:id="1" w:author="Editor" w:date="2026-01-01T00:00:00Z"><w:r><w:t>wrong</w:t></w:r></w:del><w:r><w:t>trailing </w:t></w:r></w:p>'
      + '</w:body></w:document>',
    'word/footer1.xml': '<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t> footer edge</w:t></w:r></w:p></w:ftr>',
    'word/comments.xml': '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="3" w:author="R"><w:p><w:r><w:t>One</w:t></w:r></w:p></w:comment><w:comment w:id="4" w:author="R"><w:p><w:r><w:t>Two</w:t></w:r></w:p></w:comment></w:comments>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, false);
  const byCode = Object.fromEntries(validation.documentLint.map((finding) => [`${finding.code}@${finding.part || ''}`, finding]));
  assert.equal(byCode['text_in_deletion@word/document.xml'].severity, 'error');
  assert.equal(byCode['text_in_deletion@word/document.xml'].count, 1);
  assert.match(byCode['comment_marker_mismatch@'].message, /commentRangeStart 3 has no commentRangeEnd/);
  assert.deepEqual(byCode['comment_not_anchored@'].ids, ['4']);
  assert.equal(byCode['whitespace_not_preserved@word/document.xml'].count, 1);
  assert.equal(byCode['whitespace_not_preserved@word/footer1.xml'].count, 1);
  const issues = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  const lintIssue = issues.issues.find((issue) => issue.code === 'text_in_deletion');
  assert.equal(lintIssue.severity, 'error');
  assert.equal(lintIssue.source, 'document-lint');
  assert.equal(issues.issues.find((issue) => issue.code === 'whitespace_not_preserved' && issue.path === '/word/footer1.xml').severity, 'warning');
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
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Anchored text</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p><w:p><w:ins w:id="8" w:author="Editor" w:date="2026-08-27T00:00:00Z"><w:r><w:t>Inserted</w:t></w:r></w:ins><w:del w:id="9" w:author="Editor"><w:r><w:delText>Deleted</w:delText></w:r></w:del></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>Listed</w:t></w:r></w:p></w:body></w:document>',
    'word/comments.xml': '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="7" w:author="Reviewer" w:initials="RV" w:date="2026-08-27T00:00:00Z"><w:p><w:r><w:t>Needs source</w:t></w:r></w:p></w:comment></w:comments>',
    'word/numbering.xml': '<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
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
  // A paragraph says whether tracked changes touch it and which list it belongs to.
  assert.equal(opened.document.paragraphs[0].tracked, undefined);
  assert.equal(opened.document.paragraphs[1].tracked, true);
  assert.deepEqual(opened.document.paragraphs[2].list, { numId: 3, level: 1, kind: 'bullet' });
  assert.equal(opened.document.paragraphs[0].list, undefined);
  const byId = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'resolve_revision', id: '9', resolution: 'reject' }],
  }, { cwd }));
  assert.equal(byId.results[0].resolved, 1);
  assert.equal(byId.results[0].id, '9');
  const afterId = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(afterId.document.paragraphs[1].text, 'InsertedDeleted');
  assert.equal(afterId.document.revisionCount, 1);
  const missingId = await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'resolve_revision', id: '404', resolution: 'accept' }],
  }, { cwd });
  assert.equal(missingId.isError, true);
  assert.match(missingId.content[0].text, /revision id 404 not found/);
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

test('portable DOCX fills template tokens as tracked changes when track_changes is on', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'tracked-template.docx');
  const output = join(cwd, 'tracked-template-filled.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">Dear {{ na</w:t></w:r><w:r><w:t>me }}, welcome.</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const filled = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'track_changes', enabled: true },
      { op: 'fill_template', tokens: { name: 'Ada' }, strict: true, author: 'Reviewer' },
    ],
  }, { cwd }));
  assert.equal(filled.results[1].tracked, true);
  assert.deepEqual(filled.results[1].filled, { name: 1 });
  assert.deepEqual(filled.results[1].unfilledTokens, []);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.paragraphs[0].text, 'Dear Ada, welcome.');
  // The token straddled two runs, so each run keeps its own deletion; one insertion carries the value.
  assert.deepEqual(snapshot.document.revisionAuthors, [{ author: 'Reviewer', insertions: 1, deletions: 2 }]);
  const audit = value(await executeOfficeTool({ action: 'validate', session: opened.session, auditProfile: 'redlining', author: 'Reviewer' }, { cwd }));
  assert.equal(audit.redlining.ok, true, audit.redlining.reason);
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
