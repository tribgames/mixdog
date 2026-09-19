import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { recalculateLibreOfficeWorkbook } from './portable/portable-ooxml.mjs';
import { parseXlsxAutofitRange } from './portable/xlsx-contract.mjs';
import { auditDocxRedlining } from './portable/docx-revisions.mjs';
import { issuesPortableOoxml, validatePortableOoxml } from './portable/portable-validation.mjs';
import { officeOpenFailure } from './core/office-sessions.mjs';
import { parts, value, workspace, writeZip } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// A newsletter page is a section property: the prose flows through the columns
// the section declares, and a later page edit leaves them alone.
test('set_page lays a Word section out in columns and keeps them through later page edits', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'columns.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          { op: 'append_text', text: 'Two hundred words of prose flow through the columns.' },
          { op: 'set_page', properties: { columns: 3, columnSpacing: 18 } },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).columns, 3);
  const columned = await JSZip.loadAsync(await readFile(path));
  assert.match(
    await columned.file('word/document.xml').async('string'),
    /<w:cols w:num="3" w:equalWidth="1" w:space="360"\/>/
  );
  const rotated = value(
    await executeOfficeTool(
      {
        action: 'batch',
        path,
        mode: 'portable',
        operations: [{ op: 'set_page', properties: { orientation: 'landscape' } }],
      },
      { cwd }
    )
  );
  const document = await (await JSZip.loadAsync(await readFile(rotated.output)))
    .file('word/document.xml')
    .async('string');
  assert.match(document, /w:orient="landscape"/);
  assert.match(document, /<w:cols w:num="3" w:equalWidth="1" w:space="360"\/>/);
  const single = value(
    await executeOfficeTool(
      {
        action: 'batch',
        path: rotated.output,
        mode: 'portable',
        operations: [{ op: 'set_page', properties: { columns: 1 } }],
      },
      { cwd }
    )
  );
  assert.equal(single.results[0].columns, 1);
  assert.match(
    await (await JSZip.loadAsync(await readFile(single.output))).file('word/document.xml').async('string'),
    /<w:cols w:space="360"\/>/
  );
});

// A table long enough to cross a page keeps its column labels only while the
// first row is marked to repeat; a document that arrived from elsewhere is
// where that mark goes missing.
test('a long Word table whose header row stops repeating is reported', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'long-table.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          {
            op: 'add_table',
            values: [
              ['Region', 'Revenue'],
              ...Array.from({ length: 30 }, (_, row) => [`Row ${row + 1}`, `${row * 10}`]),
            ],
          },
        ],
      },
      { cwd }
    )
  );
  const repeated = await issuesPortableOoxml(path, 'docx');
  assert.deepEqual(
    repeated.issues.filter((issue) => issue.code === 'table_header_not_repeated'),
    []
  );
  const zip = await JSZip.loadAsync(await readFile(path));
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replaceAll('<w:tblHeader/>', ''));
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
  const dropped = (await issuesPortableOoxml(path, 'docx')).issues.filter(
    (issue) => issue.code === 'table_header_not_repeated'
  );
  assert.equal(dropped.length, 1, JSON.stringify(dropped));
  assert.equal(dropped[0].path, '/body/table[1]');
  assert.match(dropped[0].message, /31 rows/);
});

// Every tracked edit takes the reviewer's label beside the operation, and a redline is written that way from the
// first edit to the last. append_text alone read it nested in properties and refused the documented field, so a
// batch written as the guide says failed whole — with the rest of the redline in it.
test('a tracked append_text carries the reviewer label beside the operation', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'redline.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [{ op: 'append_text', text: '야간 출고는 10월부터 기본값이 된다.' }],
      },
      { cwd }
    )
  );
  const edited = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'track_changes', enabled: true },
          { op: 'append_text', text: '10월 운영 회의에 설계안을 올린다.', author: '검토자 A' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(edited.results.at(-1).tracked, true);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(snapshot.document.revisionAuthors, [{ author: '검토자 A', insertions: 1, deletions: 0 }]);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('XLSX autofit accepts bounded cell, whole-column, and whole-row selectors', () => {
  assert.equal(parseXlsxAutofitRange('A1:D5').type, 'cells');
  assert.deepEqual(parseXlsxAutofitRange('A:D'), { type: 'columns', start: 1, end: 4 });
  assert.deepEqual(parseXlsxAutofitRange('2:8'), { type: 'rows', start: 2, end: 8 });
  assert.throws(() => parseXlsxAutofitRange('D:A'), /Invalid XLSX column range/);
});

// A path-addressed edit is stored in the working copy and answered with
// saved:true. Reading the same document afterwards copied the source over that
// working copy, so the edit the caller had just been told was stored was gone.
test('reading a document leaves an earlier edit and its working copy alone', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'doc.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        mode: 'portable',
        operations: [{ op: 'append_text', text: '원본 문단' }],
      },
      { cwd }
    )
  );
  resetOfficeSessionsForTest();

  const edited = value(
    await executeOfficeTool(
      {
        action: 'batch',
        path: source,
        mode: 'portable',
        operations: [{ op: 'append_text', text: '배치로 추가한 문단' }],
      },
      { cwd }
    )
  );
  assert.equal(edited.saved, true);
  const workingCopy = edited.output;
  assert.match(workingCopy, /doc\.mixdog-edit\.docx$/);
  resetOfficeSessionsForTest();

  // The read opens the user's own file: it neither writes a copy of it nor
  // disturbs the edit stored beside it.
  const read = value(await executeOfficeTool({ action: 'snapshot', path: source, mode: 'portable' }, { cwd }));
  assert.deepEqual(
    read.document.paragraphs.map((paragraph) => paragraph.text),
    ['원본 문단']
  );
  resetOfficeSessionsForTest();

  const kept = value(await executeOfficeTool({ action: 'snapshot', path: workingCopy, mode: 'portable' }, { cwd }));
  assert.deepEqual(
    kept.document.paragraphs.map((paragraph) => paragraph.text),
    ['원본 문단', '배치로 추가한 문단']
  );
  // Reading the working copy did not spawn a copy of the copy either.
  await assert.rejects(
    executeOfficeTool(
      { action: 'snapshot', path: join(cwd, 'doc.mixdog-edit.mixdog-edit.docx'), mode: 'portable' },
      { cwd }
    ).then((result) => (result.isError ? Promise.reject(new Error(result.content[0].text)) : result)),
    /not found/i
  );
  resetOfficeSessionsForTest();

  // Looking at a document is a read too: rendering the edited copy used to
  // copy it again, so the preview belonged to doc.mixdog-edit.mixdog-edit.docx.
  const previewed = value(await executeOfficeTool({ action: 'render', path: workingCopy, mode: 'portable' }, { cwd }));
  for (const image of previewed.images || []) {
    assert.doesNotMatch(image.path, /mixdog-edit\.mixdog-edit/);
  }
  resetOfficeSessionsForTest();

  // An edit that starts from a read-opened session still lands beside the
  // document, never inside it.
  const opened = value(await executeOfficeTool({ action: 'snapshot', path: source, mode: 'portable' }, { cwd }));
  const second = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'append_text', text: '두 번째 편집' }],
      },
      { cwd }
    )
  );
  assert.match(second.output, /doc\.mixdog-edit\.docx$/);
  resetOfficeSessionsForTest();
  const untouched = value(await executeOfficeTool({ action: 'snapshot', path: source, mode: 'portable' }, { cwd }));
  assert.deepEqual(
    untouched.document.paragraphs.map((paragraph) => paragraph.text),
    ['원본 문단']
  );
});

// The audit reports a table running off the page as table_wider_than_page and
// asks for fit_table; the repair pass looked for a code and a path shape the
// audit never emits, so autoFix answered it with an empty fix list.
test('qa autoFix rebalances a table the audit reports as wider than the page', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'wide-table.docx'),
        format: 'docx',
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '10월 허브 운영 보고', style: 'Heading1' },
          {
            op: 'add_table',
            values: [
              ['지점', '9월 출고', '10월 출고', '증감', '야간 인력', '비고'],
              ['대전 물류 허브', '48,210', '52,140', '8.2%', '12명', '야간 증원 승인 대기'],
            ],
            properties: { columnWidths: [2600, 2200, 2200, 1800, 1800, 3200] },
          },
        ],
      },
      { cwd }
    )
  );
  const before = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.ok(
    before.issues.some((issue) => issue.code === 'table_wider_than_page' && issue.path === '/body/table[1]'),
    JSON.stringify(before.issues)
  );
  const repaired = value(
    await executeOfficeTool(
      {
        action: 'qa',
        session: created.session,
        autoFix: true,
        render: false,
      },
      { cwd }
    )
  );
  assert.deepEqual(repaired.fixes, [{ op: 'fit_table', table: 1 }], JSON.stringify(repaired.fixes));
  assert.equal(
    (repaired.issuesAfter || []).some((issue) => issue.code === 'table_wider_than_page'),
    false,
    JSON.stringify(repaired.issuesAfter)
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('create initial operations and finalize collapse a portable workflow into one call', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'workflow.csv');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'csv',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['name', 'value'],
              ['alpha', 1],
            ],
          },
        ],
        finalize: true,
      },
      { cwd }
    )
  );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'csv',
      },
      { cwd }
    )
  );
  const completed = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['name', 'value'],
              ['alpha', 1],
            ],
          },
        ],
        finalize: true,
      },
      { cwd }
    )
  );
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
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData></worksheet>',
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
  const vba = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]);
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="vbaProject" Target="vbaProject.bin"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
    'xl/vbaProject.bin': vba,
  });
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
  assert.equal(opened.fileKind, 'xlsm');
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'macro-safe' }],
      },
      { cwd }
    )
  );
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.macros, ['xl/vbaProject.bin']);
  assert.deepEqual(validation.baseline.lostProtectedParts, []);
  const zip = await JSZip.loadAsync(await readFile(output));
  assert.deepEqual(await zip.file('xl/vbaProject.bin').async('nodebuffer'), vba);
});

// A deck finalized through the background backend is saved by PowerPoint itself, which normalises the theme, layouts
// and master and renumbers a chart's data workbook. The baseline read those as damaged protected parts and refused
// the finalize; only a rewrite by another backend treats them as protected. Macros stay protected under every backend.
test("baseline validation treats the Office application's own resave of theme, layouts and chart workbooks as normalisation, not damage", async (t) => {
  const cwd = await workspace(t);
  const original = join(cwd, 'deck.pptx');
  const saved = join(cwd, 'deck.mixdog-edit.pptx');
  const vba = Buffer.from('vba-original');
  const common = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'ppt/presentation.xml':
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  };
  const rels = (workbook) =>
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/${workbook}"/></Relationships>`;
  await writeZip(original, {
    ...common,
    'ppt/theme/theme1.xml': '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="one"/>',
    'ppt/charts/_rels/chart1.xml.rels': rels('Microsoft_Excel_Worksheet2.xlsx'),
    'ppt/embeddings/Microsoft_Excel_Worksheet2.xlsx': 'workbook',
    'ppt/vbaProject.bin': vba,
  });
  await writeZip(saved, {
    ...common,
    'ppt/theme/theme1.xml':
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="one" normalised="1"/>',
    'ppt/charts/_rels/chart1.xml.rels': rels('Microsoft_Excel_Worksheet.xlsx'),
    'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx': 'workbook',
    'ppt/vbaProject.bin': Buffer.from('vba-changed'),
  });
  const rewritten = await validatePortableOoxml(saved, 'pptx', { original });
  assert.deepEqual(rewritten.baseline.changedProtectedParts.map((part) => part.part).sort(), [
    'ppt/theme/theme1.xml',
    'ppt/vbaProject.bin',
  ]);
  assert.deepEqual(rewritten.baseline.lostProtectedParts, ['ppt/embeddings/Microsoft_Excel_Worksheet2.xlsx']);
  const resaved = await validatePortableOoxml(saved, 'pptx', { original, savedBy: 'microsoft-office-com' });
  assert.equal(resaved.baseline.applicationSaved, true);
  assert.deepEqual(
    resaved.baseline.changedProtectedParts.map((part) => part.part),
    ['ppt/vbaProject.bin'],
    'a changed macro is damage under every backend'
  );
  assert.deepEqual(resaved.baseline.lostProtectedParts, []);
  assert.deepEqual([...resaved.baseline.applicationNormalizedParts].sort(), [
    'ppt/embeddings/Microsoft_Excel_Worksheet2.xlsx',
    'ppt/theme/theme1.xml',
  ]);
});

// Word draws a TOC field's cached entries until something asks it to rebuild
// the field, so the document shipped with a table of contents that was three
// lines of plain text: no leaders, no page numbers.
test('insert_toc asks Word to rebuild its fields, so the contents arrive with page numbers', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'toc.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        format: 'docx',
        path,
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '운영 안내서' },
          { op: 'append_text', text: '도입 범위', style: 'Heading 1' },
          { op: 'append_text', text: '사내 보고서와 회의록이 대상이다.' },
          { op: 'append_text', text: '사용 절차', style: 'Heading 1' },
          { op: 'append_text', text: '템플릿을 고르고 본문을 쓴다.' },
          { op: 'insert_toc', paragraph: 1 },
        ],
      },
      { cwd }
    )
  );
  const zip = await JSZip.loadAsync(await readFile(path));
  const settings = await zip.file('word/settings.xml').async('string');
  assert.match(settings, /<w:updateFields w:val="true"\/>/);
  const types = await zip.file('[Content_Types].xml').async('string');
  assert.match(types, /PartName="\/word\/settings\.xml"/);
  const relationships = await zip.file('word/_rels/document.xml.rels').async('string');
  assert.match(relationships, /Target="settings\.xml"/);
  // Asked twice, the part keeps one declaration rather than a stack of them.
  value(
    await executeOfficeTool(
      { action: 'batch', session: created.session, operations: [{ op: 'insert_toc', paragraph: 1 }] },
      { cwd }
    )
  );
  const again = await (await JSZip.loadAsync(await readFile(path))).file('word/settings.xml').async('string');
  assert.equal((again.match(/<w:updateFields\b/g) || []).length, 1);
  await executeOfficeTool({ action: 'close', session: created.session }, { cwd });
});

// A footer line and its page number are asked for as two operations, and the
// second one wrote the story from scratch: the author's words were gone from
// the package while the result reported the edit as done.
test('add_page_numbers joins the footer the author wrote instead of replacing it', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'footer.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        format: 'docx',
        path,
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '본문' },
          { op: 'set_header_footer', kind: 'footer', text: '운영 안내서 · 내부용' },
          { op: 'add_page_numbers' },
        ],
      },
      { cwd }
    )
  );
  const footer = async () => (await JSZip.loadAsync(await readFile(path))).file('word/footer1.xml').async('string');
  const written = await footer();
  assert.match(written, /운영 안내서 · 내부용/);
  assert.match(written, /w:instr=" PAGE "/);
  // Asked again, the story keeps one number and the same words around it.
  value(
    await executeOfficeTool(
      { action: 'batch', session: created.session, operations: [{ op: 'add_page_numbers', alignment: 'right' }] },
      { cwd }
    )
  );
  const again = await footer();
  assert.equal((again.match(/w:instr=" PAGE "/g) || []).length, 1, 'one page field, not a stack of them');
  assert.match(again, /운영 안내서 · 내부용/);
  assert.match(again, /<w:jc w:val="right"\/>/);
  await executeOfficeTool({ action: 'close', session: created.session }, { cwd });
});

// A value that reached the page as an object is a machine tell no author
// types. One slipped through a kit helper and shipped as a slide title, and the
// measured read named only the overlap the oversized string caused.
test('a stringified value on the page is reported like any other leftover', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        format: 'docx',
        path: join(cwd, 'tell.docx'),
        mode: 'portable',
        operations: [{ op: 'append_text', text: '분기 요약: [object Object]' }],
      },
      { cwd }
    )
  );
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const placeholder = (issues.issues || []).find((entry) => entry.code === 'placeholder_text');
  assert.ok(placeholder, 'the stringified value is reported');
  assert.match(placeholder.message, /\[object Object\]/);
  await executeOfficeTool({ action: 'close', session: created.session }, { cwd });
});

test('portable DOCX preserves the package while replacing split runs and appending text', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.docx');
  const output = join(cwd, 'edited.docx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    'word/media/untouched.bin': Buffer.from([1, 2, 3, 4]),
  });

  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
  assert.equal(opened.mode, 'portable');
  assert.equal(opened.backend, 'mixdog-ooxml');
  const described = value(
    await executeOfficeTool(
      {
        action: 'describe',
        session: opened.session,
      },
      { cwd }
    )
  );
  assert.ok(described.operations.includes('set_paragraph_style'));
  assert.ok(described.operations.includes('fill_template'));
  assert.ok(!described.unsupportedInBackend.includes('set_paragraph_style'));
  assert.deepEqual(described.unsupportedInBackend, []);

  const begun = value(
    await executeOfficeTool(
      {
        action: 'begin',
        session: opened.session,
      },
      { cwd }
    )
  );
  assert.equal(begun.transaction.diff.summary.total, 0);
  const temporary = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Temporary transaction text' }],
      },
      { cwd }
    )
  );
  assert.ok(temporary.transaction.diff.summary.modified > 0);
  const blockedSave = await executeOfficeTool({ action: 'save', session: opened.session }, { cwd });
  assert.equal(blockedSave.isError, true);
  assert.match(blockedSave.content[0].text, /Commit or roll back/);
  const blockedClose = await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
  assert.equal(blockedClose.isError, true);
  const transactionDiff = value(
    await executeOfficeTool(
      {
        action: 'diff',
        session: opened.session,
      },
      { cwd }
    )
  );
  assert.ok(transactionDiff.transaction.diff.changes.some((change) => change.path === '/body/p[1]'));
  resetOfficeSessionsForTest();
  const pending = value(await executeOfficeTool({ action: 'transactions' }, { cwd }));
  assert.equal(pending.transactions[0].id, begun.transaction.id);
  assert.equal(pending.transactions[0].phase, 'active');
  const rolledBack = value(
    await executeOfficeTool(
      {
        action: 'recover',
        transaction: begun.transaction.id,
        strategy: 'rollback',
      },
      { cwd }
    )
  );
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(rolledBack.remainingDiff.summary.total, 0);
  assert.equal(value(await executeOfficeTool({ action: 'transactions' }, { cwd })).transactions.length, 0);

  const edited = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'replace_text', find: 'Hello World', replace: '안녕하세요' },
          { op: 'append_text', text: 'Tail paragraph' },
          { op: 'set_table_cell', table: 1, row: 1, col: 1, text: 'Path cell' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(edited.atomic, true);
  assert.equal(edited.results[0].count, 1);

  const snapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: opened.session,
      },
      { cwd }
    )
  );
  const text = JSON.stringify(snapshot.document);
  assert.match(text, /안녕하세요/);
  assert.match(text, /Tail paragraph/);
  assert.equal(snapshot.document.paragraphs[0].path, '/body/p[1]');
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].path, '/body/tbl[1]/row[1]/cell[1]');
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].text, 'Path cell');

  const firstParagraph = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: opened.session,
        target: '/body/p[1]',
      },
      { cwd }
    )
  );
  assert.equal(firstParagraph.element.text, '안녕하세요');

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'set_paragraph_text', paragraph: 1, text: 'Path edited' },
          { op: 'set_paragraph_style', paragraph: 1, style: 'Heading1' },
        ],
      },
      { cwd }
    )
  );
  const queried = value(
    await executeOfficeTool(
      {
        action: 'query',
        session: opened.session,
        query: 'Path edited',
      },
      { cwd }
    )
  );
  assert.equal(queried.matches[0].path, '/body/p[1]');

  const validation = value(
    await executeOfficeTool(
      {
        action: 'validate',
        session: opened.session,
      },
      { cwd }
    )
  );
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
  externalZip.file(
    'word/document.xml',
    (await externalZip.file('word/document.xml').async('string')).replace('Path edited', 'Outside edit')
  );
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
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p></w:body></w:document>',
  });
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Self-closing paragraph' }],
      },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_paragraph_text', paragraph: 2, text: 'Styled empty paragraph' }],
      },
      { cwd }
    )
  );
  const snapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: opened.session,
      },
      { cwd }
    )
  );
  assert.equal(snapshot.document.paragraphs[0].text, 'Self-closing paragraph');
  assert.equal(snapshot.document.paragraphs[1].text, 'Styled empty paragraph');
  assert.equal(snapshot.document.paragraphs[1].style, 'Normal');
});

// A table's own type reaches its cells on the portable backend as it does
// through Word: a Korean table whose cells fall back to the document default is
// laid out face by face, and the label lands off the baseline of the figure
// beside it.
// The audit that rides on author reads the same geometry the design review
// reads, so an element a few points off a shared axis is answered in the turn
// that wrote it instead of surviving to the next call.
test('the authoring audit reports a slide element that almost lands on a shared axis', async (t) => {
  const cwd = await workspace(t);
  const brief = [
    '// BRIEF',
    '// subject/audience/action: 운영팀 · 축 정렬 검사',
    '// reading mode: balanced · argument mode: briefing',
    '// directions: A plain · hue 205 · concord · 규칙선 — 검사용 · B dark · hue 215 · weight · 필드 — 검사용 · selected: A · why: 축 하나만 본다',
    '// style: plain · palette: hue 205 · accent: counter · type: MODE balanced → body 18 · script: ko · pairing: concord · fonts: noto',
    '// facts: sample — 검사용 덱이라 수치가 없다',
    '// slide plan: 1 job: structure · move: 축을 본다 · composition: 세 열과 아래 띠 · carriers: diagram · rhythm: dense',
  ].join('\n');
  const deck = (offset) => `${brief}
deck({ hue: 205, mode: 'balanced', script: 'ko', pairing: 'concord', fonts: 'noto' });
{ const s = light(); const cols = spans(M, W - 2 * M, [1, 1, 1]);
  cols.forEach((c) => field(s, c.x, 2, c.w, 1.2));
  hairline(s, M, 3.6, W - 2 * M);
  field(s, M + ${offset}, 4.0, W - 2 * M, 0.7, T.tint); }
await pres.writeFile({ fileName: OUTPUT });`;
  const aligned = value(
    await executeOfficeTool(
      {
        action: 'author',
        path: join(cwd, 'aligned.pptx'),
        script: deck(0),
        mode: 'portable',
        overwrite: true,
        render: false,
      },
      { cwd }
    )
  );
  assert.equal(aligned.ok, true, `${aligned.error?.message}\n${aligned.error?.excerpt || ''}`);
  assert.equal(aligned.audit.status, 'pass', JSON.stringify(aligned.audit.top));
  const drifted = value(
    await executeOfficeTool(
      {
        action: 'author',
        path: join(cwd, 'drifted.pptx'),
        script: deck(0.05),
        mode: 'portable',
        overwrite: true,
        render: false,
      },
      { cwd }
    )
  );
  assert.equal(drifted.ok, true, `${drifted.error?.message}\n${drifted.error?.excerpt || ''}`);
  assert.equal(drifted.audit.status, 'fail');
  const drift = drifted.audit.top.find((entry) => entry.code === 'axis_drift');
  assert.ok(drift, JSON.stringify(drifted.audit.top));
  assert.match(drift.message, /3\.6 pt off the axis/);
});

test('portable DOCX applies the table type to every cell, Latin and East Asian', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'typed-table.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'portable',
        operations: [
          {
            op: 'add_table',
            values: [
              ['구간', '처리량'],
              ['1분기', '12'],
            ],
            properties: {
              fontName: 'Noto Sans KR',
              fontNameEastAsia: 'Noto Sans KR',
              fontSize: 10,
              color: '1F2933',
              spacingAfter: 4,
              columnWidths: [150, 130],
            },
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results[0].changed, true);
  const zip = await JSZip.loadAsync(await readFile(path));
  const document = await zip.file('word/document.xml').async('string');
  const cells = [...document.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((match) => match[0]);
  assert.equal(cells.length, 4);
  for (const cell of cells) {
    assert.match(
      cell,
      /<w:rFonts w:ascii="Noto Sans KR" w:hAnsi="Noto Sans KR" w:cs="Noto Sans KR" w:eastAsia="Noto Sans KR"\/>/
    );
    assert.match(cell, /<w:sz w:val="20"\/>/);
    assert.match(cell, /<w:color w:val="1F2933"\/>/);
    // The spacing the caller asked for, plus one minimum line height per row so
    // a Latin figure and a Hangul label share a baseline.
    assert.match(cell, /<w:spacing w:after="80" w:line="260" w:lineRule="atLeast"\/>/);
  }
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(snapshot.document.tables[0].rows[1].cells[0].text, '1분기');
  // Restyling a header cell must replace the ink the table set, not queue a
  // second colour behind it: Word honours the last value and the white header
  // text would land back on the dark fill it was meant to sit on.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_table_cell_style',
            table: 1,
            row: 1,
            col: 1,
            properties: { fillColor: '132C24', color: 'FFFFFF', bold: true },
          },
        ],
      },
      { cwd }
    )
  );
  const headerCell = [
    ...(await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string')).matchAll(
      /<w:tc>[\s\S]*?<\/w:tc>/g
    ),
  ][0][0];
  assert.deepEqual(
    [...headerCell.matchAll(/<w:color w:val="([0-9A-Fa-f]{6})"\/>/g)].map((match) => match[1]),
    ['FFFFFF']
  );
  assert.match(headerCell, /<w:rFonts[^>]*\/><w:b\/>(?:<w:bCs\/>)?<w:color w:val="FFFFFF"\/>/);
  // Declared column widths hold only when the table states its own width too,
  // and restyling the table keeps that width.
  assert.match(document, /<w:tblW w:w="5600" w:type="dxa"\/>/);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_table_style', table: 1, properties: { style: 'TableGrid' } }],
      },
      { cwd }
    )
  );
  const restyled = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
  assert.match(restyled, /<w:tblStyle w:val="TableGrid"\/><w:tblW w:w="5600" w:type="dxa"\/>/);
  // The header row repeats where the table breaks; a caller whose first row is
  // data says so.
  const rows = [...document.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)].map((match) => match[0]);
  assert.match(rows[0], /<w:trPr><w:tblHeader\/><\/w:trPr>/);
  assert.doesNotMatch(rows[1], /<w:tblHeader\/>/);
  const plain = join(cwd, 'data-table.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: plain,
        format: 'docx',
        mode: 'portable',
        operations: [
          {
            op: 'add_table',
            values: [
              ['12', '31'],
              ['18', '24'],
            ],
            properties: { repeatHeader: false },
          },
        ],
      },
      { cwd }
    )
  );
  const plainZip = await JSZip.loadAsync(await readFile(plain));
  assert.doesNotMatch(await plainZip.file('word/document.xml').async('string'), /<w:tblHeader\/>/);
});

test('portable DOCX authors professional tables and paragraph layout', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'professional.docx');
  const output = join(cwd, 'professional-output.docx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Summary</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  });
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
  const edited = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          {
            op: 'add_table',
            values: [
              ['Metric', 'Value'],
              ['Revenue', '120'],
            ],
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
      },
      { cwd }
    )
  );
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
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Original text</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Untracked replacement' }],
      },
      { cwd }
    )
  );
  const validation = value(
    await executeOfficeTool(
      {
        action: 'validate',
        session: opened.session,
        auditProfile: 'redlining',
      },
      { cwd }
    )
  );
  assert.equal(validation.ok, false);
  assert.equal(validation.redlining.ok, false);
  assert.match(validation.redlining.reason, /untracked/i);
  assert.deepEqual(validation.redlining.untrackedEdits.before, ['Original text']);
  assert.deepEqual(validation.redlining.untrackedEdits.after, ['Untracked replacement']);
  assert.equal(validation.redlining.untrackedEdits.paragraph, 1);
  assert.ok(validation.redlining.guidance.length >= 1);
});

// A reviewer's file usually arrives with tracking already on, and the same
// edit is a revision or a silent rewrite depending on that state: the reader
// reports it instead of leaving the caller to discover it afterwards.
test('a Word snapshot reports whether this document records edits as revisions', async (t) => {
  const cwd = await workspace(t);
  const document =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>제1조 (대금)</w:t></w:r></w:p></w:body></w:document>';
  const contentTypes =
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>';
  const settings = (element) =>
    '<?xml version="1.0"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `${element}</w:settings>`;
  const read = async (name, element) => {
    const source = join(cwd, `${name}.docx`);
    await writeZip(source, {
      '[Content_Types].xml': contentTypes,
      'word/document.xml': document,
      'word/settings.xml': settings(element),
    });
    const opened = value(
      await executeOfficeTool(
        {
          action: 'open',
          path: source,
          output: join(cwd, `${name}-out.docx`),
          mode: 'portable',
        },
        { cwd }
      )
    );
    const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
    value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
    return snapshot.document.trackChanges;
  };
  assert.equal(await read('tracking-on', '<w:trackRevisions/>'), true);
  assert.equal(await read('tracking-absent', ''), false);
  // A converted or template-based file writes the element with w:val="false"
  // rather than dropping it; reading the element alone calls that file tracked.
  assert.equal(await read('tracking-off-explicit', '<w:trackRevisions w:val="false"/>'), false);
  assert.equal(await read('tracking-on-explicit', '<w:trackRevisions w:val="1"/>'), true);
});

test('DOCX redlining audit accepts tracked edits by the named author and reports foreign authors', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'redline-tracked.docx');
  const output = join(cwd, 'redline-tracked-output.docx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Original text</w:t></w:r></w:p><w:p><w:r><w:t>Keep this paragraph</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell value</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const edited = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'track_changes', enabled: true },
          { op: 'set_paragraph_text', paragraph: 1, text: 'Tracked replacement', author: 'Reviewer' },
          { op: 'replace_text', find: 'Keep this', replace: 'Retain this', author: 'Reviewer' },
          { op: 'set_table_cell', table: 1, row: 1, col: 1, text: 'Cell revised', author: 'Reviewer' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(edited.results[1].tracked, true);
  assert.equal(edited.results[2].tracked, true);
  assert.equal(edited.results[2].count, 1);
  assert.equal(edited.results[2].granularity, 'run');
  assert.equal(edited.results[3].tracked, true);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.revisionCount, 6);
  assert.deepEqual(snapshot.document.revisionAuthors, [{ author: 'Reviewer', insertions: 3, deletions: 3 }]);
  assert.deepEqual(
    snapshot.document.paragraphs.map((paragraph) => paragraph.text),
    ['Tracked replacement', 'Retain this paragraph']
  );
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].text, 'Cell revised');
  const byReviewer = value(
    await executeOfficeTool(
      {
        action: 'validate',
        session: opened.session,
        auditProfile: 'redlining',
        author: 'Reviewer',
      },
      { cwd }
    )
  );
  assert.equal(byReviewer.ok, true);
  assert.equal(byReviewer.redlining.ok, true);
  assert.deepEqual(byReviewer.redlining.newChanges, { insertions: 3, deletions: 3 });
  assert.equal(byReviewer.redlining.untrackedEdits, null);
  const bySomeoneElse = value(
    await executeOfficeTool(
      {
        action: 'validate',
        session: opened.session,
        auditProfile: 'redlining',
        author: 'Someone else',
      },
      { cwd }
    )
  );
  assert.equal(bySomeoneElse.redlining.ok, false);
  assert.equal(bySomeoneElse.redlining.foreignAuthors.length, 6);
  assert.match(bySomeoneElse.redlining.reason, /author other than "Someone else"/);
  const zip = await JSZip.loadAsync(await readFile(output));
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(
    xml,
    /<w:del [^>]*w:author="Reviewer"[^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:delText>Original text<\/w:delText><\/w:r><\/w:del>/
  );
  assert.match(
    xml,
    /<w:ins [^>]*w:author="Reviewer"[^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Tracked replacement<\/w:t><\/w:r><\/w:ins>/
  );
  // Only the matched characters are redlined; the rest of the paragraph keeps its run.
  assert.match(
    xml,
    /<w:del [^>]*><w:r><w:delText xml:space="preserve">Keep this<\/w:delText><\/w:r><\/w:del><w:ins [^>]*><w:r><w:t xml:space="preserve">Retain this<\/w:t><\/w:r><\/w:ins><w:r><w:t xml:space="preserve"> paragraph<\/w:t><\/w:r>/
  );
});

test('portable DOCX resolve_revisions drops a comment whose anchored text was deleted', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'commented-deletion.docx');
  const output = join(cwd, 'commented-deletion-clean.docx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Doomed sentence</w:t></w:r></w:p><w:p><w:r><w:t>Survivor</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'add_comment', find: 'Doomed', text: 'Cut this?', author: 'Reviewer' },
          { op: 'add_comment', find: 'Survivor', text: 'Keep', author: 'Reviewer' },
          { op: 'track_changes', enabled: true },
          { op: 'remove_paragraph', paragraph: 1, author: 'Reviewer' },
        ],
      },
      { cwd }
    )
  );
  const resolved = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
      },
      { cwd }
    )
  );
  assert.equal(resolved.results[0].commentsRemoved, 1);
  assert.equal(resolved.results[0].mergedParagraphs, 1);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(
    snapshot.document.paragraphs.map((paragraph) => paragraph.text),
    ['Survivor']
  );
  assert.equal(snapshot.document.commentCount, 1);
  assert.equal(snapshot.document.comments[0].anchoredText, 'Survivor');
  assert.equal(snapshot.document.commentThreadCount, 1);
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.documentLint, []);
  const zip = await JSZip.loadAsync(await readFile(output));
  assert.equal(
    ((await zip.file('word/commentsIds.xml').async('string')).match(/<w16cid:commentId\b/g) || []).length,
    1
  );
});

test('portable DOCX resolve_revisions settles tracked table rows and cell paragraph marks', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'table-marks.docx');
  const contentTypes =
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const stamp = 'w:author="Editor" w:date="2026-01-01T00:00:00Z"';
  const document =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>' +
    `<w:tr><w:tc><w:p><w:pPr><w:rPr><w:del w:id="1" ${stamp}/></w:rPr></w:pPr><w:r><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>` +
    `<w:tr><w:trPr><w:del w:id="2" ${stamp}/></w:trPr><w:tc><w:p><w:r><w:t>Gone</w:t></w:r></w:p></w:tc></w:tr>` +
    '</w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p></w:body></w:document>';
  await writeZip(source, { '[Content_Types].xml': contentTypes, 'word/document.xml': document });

  const accepting = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'table-marks-accepted.docx'), mode: 'portable' },
      { cwd }
    )
  );
  const accepted = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: accepting.session,
        operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
      },
      { cwd }
    )
  );
  assert.equal(accepted.results[0].mergedParagraphs, 1);
  assert.deepEqual(accepted.results[0].tableRows, { removed: 1, cleared: 0 });
  const afterAccept = value(await executeOfficeTool({ action: 'snapshot', session: accepting.session }, { cwd }));
  assert.equal(afterAccept.document.tables[0].rows.length, 1);
  assert.equal(afterAccept.document.tables[0].rows[0].cells[0].text, 'AB');
  const acceptedXml = await (await JSZip.loadAsync(await readFile(join(cwd, 'table-marks-accepted.docx'))))
    .file('word/document.xml')
    .async('string');
  assert.doesNotMatch(acceptedXml, /<w:del\b|Gone/);
  assert.equal((acceptedXml.match(/<w:p>/g) || []).length, 2);

  const rejecting = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'table-marks-rejected.docx'), mode: 'portable' },
      { cwd }
    )
  );
  const rejected = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: rejecting.session,
        operations: [{ op: 'resolve_revisions', resolution: 'reject' }],
      },
      { cwd }
    )
  );
  assert.equal(rejected.results[0].mergedParagraphs, 0);
  assert.deepEqual(rejected.results[0].tableRows, { removed: 0, cleared: 1 });
  const afterReject = value(await executeOfficeTool({ action: 'snapshot', session: rejecting.session }, { cwd }));
  assert.equal(afterReject.document.tables[0].rows.length, 2);
  assert.equal(afterReject.document.tables[0].rows[1].cells[0].text, 'Gone');
  const rejectedXml = await (await JSZip.loadAsync(await readFile(join(cwd, 'table-marks-rejected.docx'))))
    .file('word/document.xml')
    .async('string');
  assert.doesNotMatch(rejectedXml, /<w:del\b/);
});

test('portable DOCX resolve_revisions settles moves and formatting change records so Word shows no revision', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'formatting.docx');
  const contentTypes =
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const stamp = 'w:author="Editor" w:date="2026-01-01T00:00:00Z"';
  const document =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr><w:pPrChange w:id="10" ${stamp}><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>` +
    `<w:r><w:rPr><w:i/><w:rPrChange w:id="11" ${stamp}><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>Styled</w:t></w:r></w:p>` +
    `<w:p><w:moveFromRangeStart w:id="20" w:name="move1"/><w:moveFrom w:id="21" ${stamp}><w:r><w:delText>Moved</w:delText></w:r></w:moveFrom><w:moveFromRangeEnd w:id="20"/></w:p>` +
    `<w:p><w:moveToRangeStart w:id="22" w:name="move1"/><w:moveTo w:id="23" ${stamp}><w:r><w:t>Moved</w:t></w:r></w:moveTo><w:moveToRangeEnd w:id="22"/></w:p>` +
    '</w:body></w:document>';
  await writeZip(source, { '[Content_Types].xml': contentTypes, 'word/document.xml': document });

  const accepting = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'formatting-accepted.docx'), mode: 'portable' },
      { cwd }
    )
  );
  assert.deepEqual(
    accepting.document.revisions.map((revision) => revision.type),
    ['moved_from', 'moved_to']
  );
  assert.equal(accepting.document.propertyChangeCount, 2);
  const pending = value(await executeOfficeTool({ action: 'issues', session: accepting.session }, { cwd }));
  assert.match(
    pending.issues.find((issue) => issue.code === 'unresolved_revisions').message,
    /2 formatting change record/
  );
  const accepted = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: accepting.session,
        operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
      },
      { cwd }
    )
  );
  assert.equal(accepted.results[0].resolved, 2);
  assert.equal(accepted.results[0].propertyChanges, 2);
  const acceptedXml = await (await JSZip.loadAsync(await readFile(join(cwd, 'formatting-accepted.docx'))))
    .file('word/document.xml')
    .async('string');
  assert.doesNotMatch(acceptedXml, /Change\b|moveFrom|moveTo|Range(?:Start|End)/);
  assert.ok(acceptedXml.includes('<w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>'));
  assert.ok(acceptedXml.includes('<w:r><w:rPr><w:i/></w:rPr><w:t>Styled</w:t></w:r>'));
  const afterAccept = value(await executeOfficeTool({ action: 'snapshot', session: accepting.session }, { cwd }));
  assert.deepEqual(
    afterAccept.document.paragraphs.map((paragraph) => paragraph.text),
    ['Styled', '', 'Moved']
  );
  assert.equal(afterAccept.document.propertyChangeCount, 0);

  const rejecting = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'formatting-rejected.docx'), mode: 'portable' },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: rejecting.session,
        operations: [{ op: 'resolve_revisions', resolution: 'reject' }],
      },
      { cwd }
    )
  );
  const rejectedXml = await (await JSZip.loadAsync(await readFile(join(cwd, 'formatting-rejected.docx'))))
    .file('word/document.xml')
    .async('string');
  assert.doesNotMatch(rejectedXml, /Change\b|moveFrom|moveTo|Range(?:Start|End)/);
  assert.ok(rejectedXml.includes('<w:pPr><w:jc w:val="left"/><w:rPr><w:b/></w:rPr></w:pPr>'));
  assert.ok(rejectedXml.includes('<w:r><w:rPr><w:b/></w:rPr><w:t>Styled</w:t></w:r>'));
  const afterReject = value(await executeOfficeTool({ action: 'snapshot', session: rejecting.session }, { cwd }));
  assert.deepEqual(
    afterReject.document.paragraphs.map((paragraph) => paragraph.text),
    ['Styled', 'Moved', '']
  );
});

test('DOCX redlining audit recognises source revisions a later reviewer split or nested', () => {
  const original =
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>' +
    '<w:ins w:id="1" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:r><w:t>Alice added this</w:t></w:r></w:ins>' +
    '<w:r><w:t xml:space="preserve"> and more</w:t></w:r></w:p></w:body></w:document>';
  const nested = original.replace(
    '<w:r><w:t>Alice added this</w:t></w:r>',
    '<w:r><w:t xml:space="preserve">Alice added </w:t></w:r><w:del w:id="2" w:author="Bob" w:date="2026-02-01T00:00:00Z"><w:r><w:delText>this</w:delText></w:r></w:del>'
  );
  const nestedAudit = auditDocxRedlining(nested, original, { author: 'Bob' });
  assert.equal(nestedAudit.ok, true, nestedAudit.reason);
  assert.deepEqual(nestedAudit.newChanges, { insertions: 0, deletions: 1 });
  assert.equal(nestedAudit.existingChanges, 1);

  const split = original.replace(
    '<w:ins w:id="1" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:r><w:t>Alice added this</w:t></w:r></w:ins>',
    '<w:ins w:id="1" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">Alice added </w:t></w:r></w:ins>' +
      '<w:ins w:id="5" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:r><w:t>this</w:t></w:r></w:ins>'
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
  const contentTypes =
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const document =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:rPr><w:del w:id="1" w:author="Editor" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">First </w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>second</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Third </w:t></w:r><w:del w:id="2" w:author="Editor" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del>' +
    '<w:ins w:id="3" w:author="Editor" w:date="2026-01-01T00:00:00Z"><w:r><w:t>kept</w:t></w:r></w:ins></w:p>' +
    '</w:body></w:document>';
  await writeZip(source, { '[Content_Types].xml': contentTypes, 'word/document.xml': document });

  const accepting = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'marks-accepted.docx'), mode: 'portable' },
      { cwd }
    )
  );
  assert.equal(accepting.document.revisionCount, 2);
  const accepted = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: accepting.session,
        operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
      },
      { cwd }
    )
  );
  assert.equal(accepted.results[0].resolved, 2);
  assert.equal(accepted.results[0].mergedParagraphs, 1);
  assert.equal(accepted.results[0].note, undefined);
  const afterAccept = value(await executeOfficeTool({ action: 'snapshot', session: accepting.session }, { cwd }));
  assert.deepEqual(
    afterAccept.document.paragraphs.map((paragraph) => [paragraph.text, paragraph.style]),
    [
      ['First second', 'Normal'],
      ['Third kept', 'Normal'],
    ]
  );
  assert.equal(afterAccept.document.revisionCount, 0);

  const rejecting = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'marks-rejected.docx'), mode: 'portable' },
      { cwd }
    )
  );
  const rejected = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: rejecting.session,
        operations: [{ op: 'resolve_revisions', resolution: 'reject' }],
      },
      { cwd }
    )
  );
  assert.equal(rejected.results[0].paragraphMarks, 1);
  assert.equal(rejected.results[0].mergedParagraphs, 0);
  const afterReject = value(await executeOfficeTool({ action: 'snapshot', session: rejecting.session }, { cwd }));
  assert.deepEqual(
    afterReject.document.paragraphs.map((paragraph) => [paragraph.text, paragraph.style]),
    [
      ['First ', 'Heading1'],
      ['second', 'Normal'],
      ['Third gone', 'Normal'],
    ]
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
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      `<w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r><w:ins w:id="1" w:author="Alice" ${stamp}><w:r><w:t>added</w:t></w:r></w:ins></w:p>` +
      `<w:p><w:pPr><w:rPr><w:del w:id="2" w:author="Bob" ${stamp}/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Beta </w:t></w:r><w:del w:id="3" w:author="Bob" ${stamp}><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>` +
      `<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="4" w:author="Alice" ${stamp}><w:rPr/></w:rPrChange></w:rPr><w:t>Gamma</w:t></w:r></w:p>` +
      '</w:body></w:document>',
  });

  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const before = opened.document;
  assert.deepEqual(
    before.revisions.map((revision) => [revision.author, revision.at]),
    [
      ['Alice', '/body/p[1]'],
      ['Bob', '/body/p[2]'],
    ]
  );
  assert.deepEqual(
    before.paragraphs.map((paragraph) => [paragraph.tracked, paragraph.revisions, paragraph.deletedText]),
    [
      [true, [1], undefined],
      [true, [2], 'gone'],
      [undefined, undefined, undefined],
    ]
  );
  assert.equal(before.propertyChangeCount, 1);

  const unknown = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'resolve_revisions', resolution: 'accept', author: 'Nobody', allowNoChange: true }],
      },
      { cwd }
    )
  );
  assert.equal(unknown.results[0].changed, false);
  assert.match(unknown.results[0].note, /"Alice", "Bob"/);

  const bob = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'resolve_revisions', resolution: 'accept', author: 'Bob' }],
      },
      { cwd }
    )
  );
  assert.equal(bob.results[0].resolved, 1);
  assert.equal(bob.results[0].mergedParagraphs, 1);
  assert.equal(bob.results[0].propertyChanges, undefined, "Alice's formatting record is not Bob's");
  const afterBob = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(
    afterBob.document.paragraphs.map((paragraph) => paragraph.text),
    ['Alpha added', 'Beta Gamma']
  );
  assert.deepEqual(afterBob.document.revisionAuthors, [{ author: 'Alice', insertions: 1, deletions: 0 }]);
  assert.equal(afterBob.document.propertyChangeCount, 1);

  const alice = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'resolve_revisions', resolution: 'reject', author: 'Alice' }],
      },
      { cwd }
    )
  );
  assert.equal(alice.results[0].resolved, 1);
  assert.equal(alice.results[0].propertyChanges, 1);
  const afterAlice = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(
    afterAlice.document.paragraphs.map((paragraph) => paragraph.text),
    ['Alpha ', 'Beta Gamma']
  );
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
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      `<w:p><w:r><w:t xml:space="preserve">Body </w:t></w:r><w:del w:id="1" w:author="Bob" ${stamp}><w:r><w:delText>old</w:delText></w:r></w:del></w:p>` +
      '</w:body></w:document>',
    'word/header1.xml':
      '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:p><w:pPr><w:rPr><w:ins w:id="6" w:author="Alice" ${stamp}/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Draft </w:t></w:r><w:ins w:id="7" w:author="Alice" ${stamp}><w:r><w:t>v2</w:t></w:r></w:ins></w:p>` +
      '<w:p><w:r><w:t>Confidential</w:t></w:r></w:p>' +
      '</w:hdr>',
  });
  const headerText = (document) => document.parts.find((part) => part.part === 'word/header1.xml').text;

  const byOrdinal = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'stories-ordinal.docx'), mode: 'portable' },
      { cwd }
    )
  );
  assert.deepEqual(
    byOrdinal.document.revisions.map((revision) => [revision.author, revision.part, revision.at]),
    [
      ['Bob', 'word/document.xml', '/body/p[1]'],
      ['Alice', 'word/header1.xml', undefined],
    ]
  );
  const second = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: byOrdinal.session,
        operations: [{ op: 'resolve_revision', revision: 2, resolution: 'accept' }],
      },
      { cwd }
    )
  );
  assert.equal(second.results[0].resolved, 1);
  const afterOrdinal = value(await executeOfficeTool({ action: 'snapshot', session: byOrdinal.session }, { cwd }));
  assert.deepEqual(
    afterOrdinal.document.revisions.map((revision) => revision.author),
    ['Bob']
  );
  assert.equal(headerText(afterOrdinal.document), 'Draft v2\nConfidential');
  const rest = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: byOrdinal.session,
        operations: [{ op: 'resolve_revisions', resolution: 'reject' }],
      },
      { cwd }
    )
  );
  assert.equal(rest.results[0].resolved, 1);
  assert.equal(
    rest.results[0].mergedParagraphs,
    1,
    'rejecting the inserted header paragraph mark joins it to the next paragraph'
  );
  const afterRest = value(await executeOfficeTool({ action: 'snapshot', session: byOrdinal.session }, { cwd }));
  assert.equal(afterRest.document.revisionCount, 0);
  assert.deepEqual(
    afterRest.document.paragraphs.map((paragraph) => paragraph.text),
    ['Body old']
  );
  assert.equal(headerText(afterRest.document), 'Draft v2Confidential');
  const zip = await JSZip.loadAsync(await readFile(join(cwd, 'stories-ordinal.docx')));
  const header = await zip.file('word/header1.xml').async('string');
  assert.doesNotMatch(header, /<w:(?:ins|del)\b/);
  assert.equal((header.match(/<w:p\b/g) || []).length, 1);

  const byId = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'stories-id.docx'), mode: 'portable' },
      { cwd }
    )
  );
  const rejected = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: byId.session,
        operations: [{ op: 'resolve_revision', id: '7', resolution: 'reject' }],
      },
      { cwd }
    )
  );
  assert.equal(rejected.results[0].id, '7');
  const afterId = value(await executeOfficeTool({ action: 'snapshot', session: byId.session }, { cwd }));
  assert.equal(headerText(afterId.document), 'Draft \nConfidential');
  assert.deepEqual(
    afterId.document.revisions.map((revision) => revision.author),
    ['Bob']
  );
});

test('DOCX redlining audit covers a header edited untracked and passes one edited under tracking', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'header-redline.docx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Body text</w:t></w:r></w:p></w:body></w:document>',
    'word/header1.xml':
      '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential draft</w:t></w:r></w:p></w:hdr>',
  });

  const untracked = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'header-untracked.docx'), mode: 'portable' },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: untracked.session,
        operations: [{ op: 'replace_text', find: 'Confidential', replace: 'Public' }],
      },
      { cwd }
    )
  );
  const failed = value(
    await executeOfficeTool(
      { action: 'validate', session: untracked.session, auditProfile: 'redlining', author: 'Reviewer' },
      { cwd }
    )
  );
  assert.equal(failed.redlining.ok, false);
  assert.equal(failed.redlining.untrackedEdits.part, 'word/header1.xml');
  assert.deepEqual(failed.redlining.untrackedEdits.before, ['Confidential draft']);
  assert.match(failed.redlining.reason, /header1\.xml/);
  assert.deepEqual(
    failed.redlining.parts.map((part) => [part.part, part.ok]),
    [
      ['word/document.xml', true],
      ['word/header1.xml', false],
    ]
  );

  const tracked = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'header-tracked.docx'), mode: 'portable' },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: tracked.session,
        operations: [
          { op: 'track_changes', enabled: true },
          { op: 'replace_text', find: 'Confidential', replace: 'Public', author: 'Reviewer' },
        ],
      },
      { cwd }
    )
  );
  const passed = value(
    await executeOfficeTool(
      { action: 'validate', session: tracked.session, auditProfile: 'redlining', author: 'Reviewer' },
      { cwd }
    )
  );
  assert.equal(passed.redlining.ok, true, passed.redlining.reason);
  assert.deepEqual(passed.redlining.newChanges, { insertions: 1, deletions: 1 });
  assert.deepEqual(passed.redlining.addedParts, []);
  assert.equal(passed.redlining.untrackedEdits, null);
});

test('a hyperlink asked for by phrase lands on that phrase, or says it is absent', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'linked.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '자세한 내용은 운영 대시보드에서 확인하십시오.' },
          // No display: linking a phrase must keep that phrase. Defaulting to the
          // address rewrote the sentence as "https://example.com/ops에서 …".
          // url is the name this runtime's PDF links use, so it reaches address.
          { op: 'add_hyperlink', find: '운영 대시보드', url: 'https://example.com/ops' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results[1].anchor, 'phrase');
  const document = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
  // The phrase moves inside the link; the words around it keep their own runs.
  assert.match(
    document,
    /자세한 내용은 <\/w:t><\/w:r><w:hyperlink r:id="[^"]+"><w:r><w:rPr><w:color w:val="0563C1"\/><w:u w:val="single"\/><\/w:rPr><w:t>운영 대시보드<\/w:t><\/w:r><\/w:hyperlink><w:r><w:t xml:space="preserve">에서/
  );
  assert.equal((document.match(/운영 대시보드/g) || []).length, 1, 'the phrase is not duplicated');
  // Appending the link to the end of the document and reporting success put it
  // somewhere the caller never named.
  const missing = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'add_hyperlink', find: '없는문구', address: 'https://example.com', display: 'x' }],
    },
    { cwd }
  );
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /text not found for hyperlink: 없는문구/);
  // A caller who does want other words still gets them.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'append_text', text: '월간 지표는 여기에서 봅니다.' },
          { op: 'add_hyperlink', find: '여기', address: 'https://example.com/metrics', display: '월간 지표 보드' },
        ],
      },
      { cwd }
    )
  );
  const relabelled = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
  assert.match(relabelled, /<w:hyperlink[^>]*><w:r><w:rPr>[^<]*(?:<[^>]+>)*<w:t>월간 지표 보드<\/w:t>/);
});

test('a worksheet name Excel would refuse is refused here', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'named.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [{ op: 'set_cell', cell: 'A1', value: '허브' }],
      },
      { cwd }
    )
  );
  for (const [name, reason] of [
    ['a/b:c', /cannot contain : \\ \/ \? \* \[ \]/],
    ['x'.repeat(32), /limited to 31 characters/],
    ["'quoted'", /apostrophe/],
    ['History', /reserved by Excel/],
  ]) {
    const refused = await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'rename_sheet', name }],
      },
      { cwd }
    );
    assert.equal(refused.isError, true, `${name} is refused`);
    assert.match(refused.content[0].text, reason);
  }
  const renamed = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'rename_sheet', name: '10월 실적' }],
      },
      { cwd }
    )
  );
  assert.deepEqual(renamed.results[0].to, '10월 실적');

  // Excel will not open a workbook whose defined name carries a space, and the
  // caller writes that name into formulas, so it is refused rather than
  // quietly repaired. A Korean name without one is valid and stays as given.
  for (const [name, reason] of [
    ['월 매출', /contains a space; use an underscore/],
    ['2026매출', /must start with a letter/],
    ['매출!', /use letters, digits, underscores, or periods/],
    ['B4', /reads it as a cell reference/],
  ]) {
    const refused = await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'define_name', name, refersTo: "'10월 실적'!$A$1" }],
      },
      { cwd }
    );
    assert.equal(refused.isError, true, `${name} is refused`);
    assert.match(refused.content[0].text, reason);
  }
  const defined = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'define_name', name: '월_매출', refersTo: "'10월 실적'!$A$1" }],
      },
      { cwd }
    )
  );
  assert.equal(defined.results[0].name, '월_매출');
});

test('portable DOCX fills the content controls the snapshot reports', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'template.docx');
  const output = join(cwd, 'filled.docx');
  const control = (tag, text, extra = '') =>
    '<w:sdt><w:sdtPr>' +
    `<w:alias w:val="${tag}"/><w:tag w:val="${tag}"/>${extra}</w:sdtPr>` +
    `<w:sdtContent><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${text}</w:t></w:r>` +
    '<w:r><w:t> leftover</w:t></w:r></w:p></w:sdtContent></w:sdt>';
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      control('계약명', '[계약명]', '<w:showingPlcHdr/>') +
      control('계약금액', '[금액]') +
      control('작성일', '2026-01-01', '<w:lock w:val="sdtContentLocked"/>') +
      '</w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const filled = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'set_content_control', tag: '계약명', text: '야간 운영 위탁 계약' },
          { op: 'set_content_control', control: 2, text: '38,400,000원' },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(
    filled.results.map((entry) => [entry.control, entry.tag, entry.text]),
    [
      [1, '계약명', '야간 운영 위탁 계약'],
      [2, '계약금액', '38,400,000원'],
    ]
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(
    snapshot.document.contentControls.map((entry) => [entry.tag, entry.text]),
    [
      ['계약명', '야간 운영 위탁 계약'],
      ['계약금액', '38,400,000원'],
      ['작성일', '2026-01-01 leftover'],
    ]
  );
  const document = await (await JSZip.loadAsync(await readFile(output))).file('word/document.xml').async('string');
  // The value replaces the placeholder outright, keeps the run's formatting,
  // and the control stops advertising prompt text.
  assert.match(document, /<w:rPr><w:b\/><\/w:rPr><w:t>야간 운영 위탁 계약<\/w:t>/);
  assert.doesNotMatch(
    document,
    /leftover<\/w:t><\/w:r><\/w:p><\/w:sdtContent><\/w:sdt><w:sdt><w:sdtPr><w:alias w:val="계약금액"/
  );
  assert.doesNotMatch(document, /<w:showingPlcHdr\/>/);
  await assert.rejects(
    async () =>
      value(
        await executeOfficeTool(
          {
            action: 'batch',
            session: opened.session,
            operations: [{ op: 'set_content_control', tag: '작성일', text: '2026-10-01' }],
          },
          { cwd }
        )
      ),
    /작성일 is locked for editing/
  );
  await assert.rejects(
    async () =>
      value(
        await executeOfficeTool(
          {
            action: 'batch',
            session: opened.session,
            operations: [{ op: 'set_content_control', tag: 'missing', text: 'x' }],
          },
          { cwd }
        )
      ),
    /content control not found for tag: missing/
  );
});

test('portable DOCX notes cite the phrase they follow and are the only notes counted', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'notes.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '정시 출고율은 92.8%로 내려갔습니다.' },
          { op: 'add_note', find: '92.8%', text: '물류운영팀 집계.' },
          { op: 'add_note', kind: 'endnote', paragraph: 1, text: '집계 기준은 부록 참조.' },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(
    created.batch.results.slice(1).map((entry) => [entry.op, entry.kind, entry.note, entry.anchor]),
    [
      ['add_note', 'footnote', 1, 'phrase'],
      ['add_note', 'endnote', 1, 'paragraph'],
    ]
  );
  const zip = await JSZip.loadAsync(await readFile(path));
  const document = await zip.file('word/document.xml').async('string');
  // The mark follows the cited number, so the run is cut around it.
  assert.match(
    document,
    /<w:t xml:space="preserve">92\.8%<\/w:t><\/w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><w:vertAlign w:val="superscript"\/><\/w:rPr><w:footnoteReference w:id="1"\/><\/w:r>/
  );
  assert.match(document, /<w:endnoteReference w:id="1"\/><\/w:r><\/w:p>/);
  const footnotes = await zip.file('word/footnotes.xml').async('string');
  // Word repairs a notes part that lacks its separators.
  assert.match(footnotes, /<w:footnote w:type="separator" w:id="-1">/);
  assert.match(footnotes, /<w:footnote w:type="continuationSeparator" w:id="0">/);
  assert.match(footnotes, /<w:footnote w:id="1">[\s\S]*물류운영팀 집계\./);
  assert.match(
    await zip.file('word/_rels/document.xml.rels').async('string'),
    /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/footnotes" Target="footnotes\.xml"/
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(snapshot.document.footnoteCount, 1);
  assert.equal(snapshot.document.endnoteCount, 1);
  assert.match(snapshot.document.footnotes[0].text, /물류운영팀 집계\./);
  assert.match(snapshot.document.endnotes[0].text, /부록 참조\./);
});

test('portable DOCX snapshot names the table cell a revision sits in and flags the cell', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'cell-revisions.docx');
  const stamp = 'w:date="2026-01-01T00:00:00Z"';
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>' +
      '<w:tr><w:tc><w:p><w:r><w:t>Plain</w:t></w:r></w:p></w:tc>' +
      `<w:tc><w:p><w:r><w:t xml:space="preserve">Price </w:t></w:r><w:del w:id="1" w:author="Bob" ${stamp}><w:r><w:delText>10</w:delText></w:r></w:del><w:ins w:id="2" w:author="Bob" ${stamp}><w:r><w:t>12</w:t></w:r></w:ins></w:p></w:tc></w:tr>` +
      `<w:tr><w:tc><w:p><w:ins w:id="3" w:author="Alice" ${stamp}><w:r><w:t>New</w:t></w:r></w:ins></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>` +
      '</w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(
    await executeOfficeTool(
      { action: 'open', path: source, output: join(cwd, 'cell-revisions-out.docx'), mode: 'portable' },
      { cwd }
    )
  );
  const { document } = opened;
  assert.deepEqual(
    document.revisions.map((revision) => revision.at),
    ['/body/tbl[1]/row[1]/cell[2]', '/body/tbl[1]/row[1]/cell[2]', '/body/tbl[1]/row[2]/cell[1]']
  );
  const cells = document.tables[0].rows.flatMap((row) => row.cells);
  assert.deepEqual(
    cells.map((cell) => [cell.text, cell.tracked, cell.deletedText, cell.revisions]),
    [
      ['Plain', undefined, undefined, undefined],
      ['Price 12', true, '10', [1, 2]],
      ['New', true, undefined, [3]],
      ['', undefined, undefined, undefined],
    ]
  );
  assert.equal(document.paragraphs[0].tracked, undefined);
});

test('portable DOCX normalize_runs merges fragmented runs without crossing tracked changes', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'fragmented.docx');
  const output = join(cwd, 'fragmented-normalized.docx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>' +
      '<w:r w:rsidR="00A1"><w:rPr><w:b/></w:rPr><w:t>Hel</w:t></w:r><w:proofErr w:type="spellStart"/>' +
      '<w:r w:rsidRPr="00B2"><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">lo </w:t></w:r>' +
      '<w:r><w:t>wor</w:t></w:r><w:r><w:t>ld</w:t></w:r>' +
      '<w:ins w:id="1" w:author="Editor" w:date="2026-01-01T00:00:00Z"><w:r><w:t>!</w:t></w:r></w:ins>' +
      '<w:r><w:t>?</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const normalized = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'normalize_runs' }],
      },
      { cwd }
    )
  );
  assert.equal(normalized.results[0].merged, 2);
  assert.equal(normalized.results[0].textMerged, 2);
  assert.equal(normalized.results[0].proofErrRemoved, 1);
  assert.equal(normalized.results[0].rsidStripped, 2);
  assert.deepEqual(normalized.results[0].parts, ['word/document.xml']);
  const zip = await JSZip.loadAsync(await readFile(output));
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(
    xml.includes(
      '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r><w:ins'
    )
  );
  assert.ok(xml.includes('</w:ins><w:r><w:t>?</w:t></w:r></w:p>'));
  assert.doesNotMatch(xml, /rsid|proofErr/);
  const replaced = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'replace_text', find: 'Hello world', replace: 'Hi there' },
          { op: 'normalize_runs', allowNoChange: true },
        ],
      },
      { cwd }
    )
  );
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
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Please anch</w:t></w:r><w:r><w:t>or me here</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const commented = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'add_comment', find: 'anchor me', text: 'Needs a source', author: 'Reviewer', initials: 'RV' },
          { op: 'add_comment_reply', comment: 1, text: 'Added below', author: 'Author' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(commented.results[0].anchor, 'phrase');
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, true, JSON.stringify(validation.documentLint));
  const anchored = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  // The comment highlights the phrase, cut out of its two runs, not the paragraph.
  assert.equal(anchored.document.comments[0].anchoredText, 'anchor me');
  assert.equal(anchored.document.paragraphs[0].text, 'Please anchor me here');
  const anchoredXml = await (await JSZip.loadAsync(await readFile(output))).file('word/document.xml').async('string');
  assert.ok(
    anchoredXml.includes(
      '<w:t xml:space="preserve">Please </w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">anch</w:t></w:r><w:r><w:t xml:space="preserve">or me</w:t></w:r>'
    )
  );
  // The reply's markers sit inside the parent range; the parent closes before the rest of the run.
  assert.ok(
    anchoredXml.includes(
      '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> here</w:t></w:r>'
    )
  );
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
  assert.ok(Number.parseInt(durableId, 16) < 0x7fffffff);
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  for (const target of ['comments.xml', 'commentsExtended.xml', 'commentsIds.xml', 'commentsExtensible.xml']) {
    assert.ok(rels.includes(`Target="${target}"`), target);
  }
  const types = await zip.file('[Content_Types].xml').async('string');
  assert.ok(types.includes('PartName="/word/commentsIds.xml"'));
  assert.ok(types.includes('PartName="/word/commentsExtensible.xml"'));

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'delete_comment', comment: 2 }],
      },
      { cwd }
    )
  );
  const after = await JSZip.loadAsync(await readFile(output));
  assert.equal(
    ((await after.file('word/commentsIds.xml').async('string')).match(/<w16cid:commentId\b/g) || []).length,
    1
  );
  assert.equal(
    ((await after.file('word/commentsExtensible.xml').async('string')).match(/<w16cex:commentExtensible\b/g) || [])
      .length,
    1
  );
  assert.equal(
    ((await after.file('word/commentsExtended.xml').async('string')).match(/<w15:commentEx\b/g) || []).length,
    1
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.commentCount, 1);
  assert.equal(snapshot.document.commentThreadCount, 1);
});

// A review thread is a thread: a reply belongs to the comment it answers, and
// resolving it settles the whole thread. The reader reports both, so the audit
// asks about the comment that is still open and no other.
test('a resolved comment thread reads back settled and only open threads are reported', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'review.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        format: 'docx',
        operations: [
          { op: 'append_text', text: '야간 운영 합의서', properties: { style: 'Heading1' } },
          { op: 'append_text', text: '대전 허브는 야간 인력 12명을 증원한다. 정시 출고율 목표는 96.0%로 한다.' },
        ],
      },
      { cwd }
    )
  );
  // The snapshot calls the anchor anchoredText, so the operation takes that name too.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'add_comment',
            anchoredText: '야간 인력 12명',
            text: '산정표를 첨부해 주세요.',
            author: '재영',
            initials: 'JY',
          },
          { op: 'add_comment', find: '96.0%', text: '목표가 맞는지 확인 필요합니다.', author: '재영', initials: 'JY' },
          { op: 'add_comment_reply', comment: 1, text: '별첨 2에 있습니다.', author: '운영기획팀', initials: 'OP' },
          { op: 'set_comment_resolved', comment: 1, resolved: true },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const comments = snapshot.document.comments;
  assert.equal(comments[0].anchoredText, '야간 인력 12명');
  assert.equal(comments[0].resolved, true);
  assert.equal(comments[1].resolved, undefined);
  assert.equal(comments[2].replyTo, comments[0].id);
  assert.equal(comments[2].resolved, true, 'a reply inherits its thread');
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues;
  const open = issues.filter((issue) => issue.code === 'unresolved_comments');
  assert.equal(open.length, 1);
  assert.match(open[0].message, /^1 comment thread\(s\)/);
  assert.equal(open[0].path, comments[1].path);
});

// "issues" answered ok with nothing found for a workbook whose chart the page
// break cuts in half, because the format review only ran inside qa. A review
// action that reports a clean file has to have looked at the document.
test('issues reads the document review, not only the package', async (t) => {
  const cwd = await workspace(t);
  const book = join(cwd, 'sliced.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: book,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['월', '처리량'],
              ['9월', 4390],
              ['10월', 4720],
            ],
          },
          {
            op: 'add_chart',
            sheet: 'Sheet1',
            chartType: 'column',
            range: 'A1:B3',
            left: 260,
            top: 20,
            width: 480,
            height: 280,
          },
          // A print area that stops at the table leaves the chart to the page break.
          { op: 'set_page_setup', sheet: 'Sheet1', printArea: 'A1:B3' },
        ],
      },
      { cwd }
    )
  );
  const reviewed = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const drawing = (reviewed.issues || []).find((entry) => entry.code === 'drawing_outside_print_area');
  assert.ok(drawing, JSON.stringify(reviewed.issues));
  assert.equal(drawing.path, '/sheet[Sheet1]/chart[1]');
  assert.equal(drawing.severity, 'warning');
  assert.match(drawing.message, /past the print area A1:B3/);
  assert.equal(reviewed.issueCount, (reviewed.issues || []).length);
  const checked = value(await executeOfficeTool({ action: 'qa', session: created.session, render: false }, { cwd }));
  assert.ok((checked.issuesAfter || []).some((entry) => entry.code === 'drawing_outside_print_area'));
  // The same finding is reported once, not once per review pass.
  assert.equal((checked.issuesAfter || []).filter((entry) => entry.code === 'drawing_outside_print_area').length, 1);
});

// A chart beside a table is wider than a portrait page, and a sheet with no page
// setup used to export by column blocks — the page break ran through the chart
// and the review then held finalize for it. The chart's own sheet now takes one
// page wide; a later print area keeps that fit, and a declared fit is left alone.
test('a chart on an unfitted sheet takes one page wide, and the review has nothing to hold', async (t) => {
  const cwd = await workspace(t);
  const book = join(cwd, 'fitted.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: book,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['월', '처리량'],
              ['9월', 4390],
              ['10월', 4720],
            ],
          },
          {
            op: 'add_chart',
            sheet: 'Sheet1',
            chartType: 'column',
            range: 'A1:B3',
            cell: 'G2',
            width: 480,
            height: 280,
          },
          { op: 'set_page_setup', sheet: 'Sheet1', printArea: 'A1:P20' },
        ],
      },
      { cwd }
    )
  );
  const chartResult = created.batch.results.find((entry) => entry.op === 'add_chart');
  assert.equal(chartResult.pageFit, 'one-page-wide');
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const setup = snapshot.document.sheets[0].pageSetup;
  assert.equal(setup.fitToPagesWide, 1, JSON.stringify(setup));
  assert.equal(setup.fitToPagesTall, 0);
  const reviewed = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.deepEqual(
    (reviewed.issues || []).filter((entry) => entry.code === 'drawing_outside_print_area'),
    []
  );
  // A sheet whose fit the author declared keeps it.
  const declared = join(cwd, 'declared.xlsx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: declared,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['월', '처리량'],
              ['9월', 4390],
              ['10월', 4720],
            ],
          },
          { op: 'set_page_setup', sheet: 'Sheet1', fitToPagesWide: 2, fitToPagesTall: 3 },
          { op: 'add_chart', sheet: 'Sheet1', chartType: 'column', range: 'A1:B3', cell: 'G2' },
        ],
      },
      { cwd }
    )
  );
  const declaredSnapshot = value(
    await executeOfficeTool({ action: 'snapshot', path: declared, mode: 'portable' }, { cwd })
  );
  assert.equal(declaredSnapshot.document.sheets[0].pageSetup.fitToPagesWide, 2);
  assert.equal(declaredSnapshot.document.sheets[0].pageSetup.fitToPagesTall, 3);
});

// A stat strip is a 22 pt value row over a 9 pt label row. Restyling the label
// cells has to set their size and repitch their lines, and must not drop the
// width or the bottom alignment the table was written with.
test('a restyled table cell keeps its width and bottom alignment and takes its new size', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'stats.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          {
            op: 'add_table',
            values: [
              ['1.6배', '0.3%'],
              ['처리량', '오류율'],
            ],
            properties: { fontSize: 22, columnWidths: [200, 200] },
          },
          {
            op: 'set_table_cell_style',
            table: 1,
            row: 2,
            col: 1,
            properties: { fontSize: 9, color: '6B7280', fontNameEastAsia: 'Malgun Gothic' },
          },
          {
            op: 'set_table_cell_style',
            table: 1,
            row: 2,
            col: 2,
            properties: { fillColor: 'EEF2F7', verticalAlignment: 'top' },
          },
        ],
      },
      { cwd }
    )
  );
  const written = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
  const cells = written.match(/<w:tc>[^]*?<\/w:tc>/g);
  assert.equal(cells.length, 4);
  // Every cell of a new table sits on its bottom edge, so a Latin-only figure and a Hangul one share a baseline.
  assert.match(cells[0], /<w:tcPr><w:tcW w:w="4000" w:type="dxa"\/><w:vAlign w:val="bottom"\/><\/w:tcPr>/);
  assert.match(cells[2], /<w:tcPr><w:tcW w:w="4000" w:type="dxa"\/><w:vAlign w:val="bottom"\/><\/w:tcPr>/);
  assert.match(
    cells[2],
    /<w:rFonts w:eastAsia="Malgun Gothic"\/>[^]*?<w:color w:val="6B7280"\/><w:sz w:val="18"\/><w:szCs w:val="18"\/>/
  );
  assert.match(cells[2], /<w:spacing[^>]*w:line="234" w:lineRule="atLeast"\/>/);
  assert.match(cells[0], /<w:spacing[^>]*w:line="572" w:lineRule="atLeast"\/>/);
  assert.match(
    cells[3],
    /<w:tcPr><w:tcW w:w="4000" w:type="dxa"\/><w:shd w:val="clear" w:color="auto" w:fill="EEF2F7"\/><w:vAlign w:val="top"\/><\/w:tcPr>/
  );
});

// A Word table has two alignments — the table's place on the page and the text
// of each column — and a finalize that carries the page review keeps a native
// document native instead of resolving the review into a preset profile.
test('a Word table takes per-column text alignment, and the page review keeps the document native', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'aligned.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '라인별 처리 건수', style: 'Heading 1' },
          {
            op: 'add_table',
            values: [
              ['라인', '10월'],
              ['1호', '1,200건'],
            ],
            properties: { alignment: 'center', columnAlignments: ['left', 'right'] },
          },
        ],
      },
      { cwd }
    )
  );
  const documentXml = async () =>
    (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
  const written = await documentXml();
  assert.match(written, /<w:tblPr>[^]*?<w:jc w:val="center"\/>[^]*?<\/w:tblPr>/);
  assert.equal((written.match(/<w:tc>[^]*?<w:jc w:val="right"\/>/g) || []).length, 2);
  // The header row is bold by default and every cell shares one minimum line
  // height, so a Latin figure and a Hangul label sit on the same baseline.
  const rowsXml = written.match(/<w:tr>[^]*?<\/w:tr>/g);
  assert.equal((rowsXml[0].match(/<w:b\/>/g) || []).length, 2);
  assert.equal((rowsXml[1].match(/<w:b\/>/g) || []).length, 0);
  assert.equal((written.match(/<w:tc>[^]*?<w:spacing[^>]*w:lineRule="atLeast"/g) || []).length, 4);
  // A created document keeps Hangul words whole at the line end (Word reads
  // wordWrap="0" as "break Korean words anywhere") and sets the Hangul-to-Latin
  // and Hangul-to-digit spacing off, which Word otherwise opens inside the word
  // ("2026 년 9 월") while the preview renders it tight.
  const styles = await (await JSZip.loadAsync(await readFile(path))).file('word/styles.xml').async('string');
  assert.match(
    styles,
    /<w:pPrDefault><w:pPr><w:wordWrap w:val="1"\/><w:autoSpaceDE w:val="0"\/><w:autoSpaceDN w:val="0"\/>/
  );
  const plain = join(cwd, 'plain.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: plain,
        mode: 'portable',
        operations: [
          {
            op: 'add_table',
            values: [
              ['라인', '10월'],
              ['1호', '1,200건'],
            ],
            properties: { headerBold: false },
          },
        ],
      },
      { cwd }
    )
  );
  assert.doesNotMatch(
    await (await JSZip.loadAsync(await readFile(plain))).file('word/document.xml').async('string'),
    /<w:b\/>/
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_table_style', table: 1, properties: { columnAlignments: ['center', 'center'] } }],
      },
      { cwd }
    )
  );
  assert.equal(((await documentXml()).match(/<w:jc w:val="center"\/>/g) || []).length, 4);
  const finalized = value(
    await executeOfficeTool(
      {
        action: 'finalize',
        session: created.session,
        review: false,
        design: {
          reviewed: true,
          reviewToken: 'none',
          critique: [{ page: 1, verdict: 'pass', note: 'table columns read as one grid' }],
        },
      },
      { cwd }
    )
  );
  assert.equal(finalized.ok, true, JSON.stringify(finalized.validation?.schema?.errors || finalized));
  assert.equal(finalized.design?.authoring, 'native');
  assert.equal(finalized.design?.profile, undefined);
});

// A file that arrives half-copied fails on the ZIP itself; the answer names the
// file and what to do, instead of a library's internal wording.
test('a damaged package is refused with the file name and a way forward', async (t) => {
  const cwd = await workspace(t);
  const intact = join(cwd, 'intact.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: intact,
        mode: 'portable',
        format: 'docx',
        operations: [{ op: 'append_text', text: '야간 운영 보고' }],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const damaged = join(cwd, 'damaged.docx');
  const bytes = await readFile(intact);
  await writeFile(damaged, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  const opened = await executeOfficeTool({ action: 'open', path: damaged, mode: 'portable' }, { cwd });
  assert.equal(opened.isError, true);
  assert.match(opened.content[0].text, /is not a readable Office package/);
  assert.match(opened.content[0].text, /damaged or incomplete/);
  assert.match(opened.content[0].text, /ask for an intact copy/);

  // Bytes that are not a package at all reach the library's own aside — a
  // question about zip files and a link to its documentation — which answers
  // nothing the caller asked and does not travel with the error.
  const notAPackage = join(cwd, 'not-a-package.docx');
  await writeFile(notAPackage, '이것은 워드 파일이 아닙니다', 'utf8');
  const refused = await executeOfficeTool({ action: 'open', path: notAPackage, mode: 'portable' }, { cwd });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /not a readable Office package/);
  assert.doesNotMatch(refused.content[0].text, /is this a zip file|https?:\/\//);

  // A legacy .doc renamed to .docx is intact — it is simply not a package.
  // Sending the caller to ask for an undamaged copy chases a file that exists.
  const legacy = join(cwd, 'legacy.docx');
  await writeFile(
    legacy,
    Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(1024)])
  );
  const old = await executeOfficeTool({ action: 'open', path: legacy, mode: 'portable' }, { cwd });
  assert.equal(old.isError, true);
  assert.match(old.content[0].text, /legacy Office file \(\.doc\/\.xls\/\.ppt\)/);
  assert.match(old.content[0].text, /save a copy as \.docx/);
  assert.doesNotMatch(old.content[0].text, /damaged or incomplete/);

  // recover finishes an interrupted transaction. Reached with a damaged file
  // in hand, "recover requires transaction" read as a missing argument; the
  // answer now says what it recovers and where the two paths diverge.
  const misread = await executeOfficeTool({ action: 'recover', path: damaged }, { cwd });
  assert.equal(misread.isError, true);
  assert.match(misread.content[0].text, /interrupted Office transaction/);
  assert.match(misread.content[0].text, /"action":"transactions"/);
  assert.match(misread.content[0].text, /damaged document is a different matter/);
});

// A running PowerPoint that refuses automation is not a damaged deck: sending the
// caller to repair an intact file wastes the turn and hides the route that works.
test('an Office application that refuses automation is not reported as a damaged file', () => {
  const refusal = officeOpenFailure(
    'Background Office refused a shared or unidentified application before opening the document (pid 48632).',
    'C:/decks/night-ops.pptx'
  );
  assert.match(refusal, /night-ops\.pptx/);
  assert.match(refusal, /mode:'portable'/);
  assert.doesNotMatch(refusal, /damaged or incomplete/);
  const unreadable = officeOpenFailure('PowerPoint을(를) 사용하여 파일을 열 수 없습니다', 'C:/decks/night-ops.pptx');
  assert.match(unreadable, /damaged or incomplete/);
});

test('DOCX validation reports revision and comment structure faults Word rejects', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'faulty.docx');
  const output = join(cwd, 'faulty-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:commentRangeStart w:id="3"/><w:r><w:t>Anchored</w:t></w:r><w:r><w:commentReference w:id="3"/></w:r></w:p>' +
      '<w:p><w:del w:id="1" w:author="Editor" w:date="2026-01-01T00:00:00Z"><w:r><w:t>wrong</w:t></w:r></w:del><w:r><w:t>trailing </w:t></w:r></w:p>' +
      '</w:body></w:document>',
    'word/footer1.xml':
      '<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t> footer edge</w:t></w:r></w:p></w:ftr>',
    'word/comments.xml':
      '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="3" w:author="R"><w:p><w:r><w:t>One</w:t></w:r></w:p></w:comment><w:comment w:id="4" w:author="R"><w:p><w:r><w:t>Two</w:t></w:r></w:p></w:comment></w:comments>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, false);
  const byCode = Object.fromEntries(
    validation.documentLint.map((finding) => [`${finding.code}@${finding.part || ''}`, finding])
  );
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
  assert.equal(
    issues.issues.find((issue) => issue.code === 'whitespace_not_preserved' && issue.path === '/word/footer1.xml')
      .severity,
    'warning'
  );
});

test('strict OOXML validation rejects missing relationship targets', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'broken.docx');
  const output = join(cwd, 'broken-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    'word/_rels/document.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="image" Target="media/missing.png"/></Relationships>',
  });
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
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
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Anchored text</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p><w:p><w:ins w:id="8" w:author="Editor" w:date="2026-08-27T00:00:00Z"><w:r><w:t>Inserted</w:t></w:r></w:ins><w:del w:id="9" w:author="Editor"><w:r><w:delText>Deleted</w:delText></w:r></w:del></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>Listed</w:t></w:r></w:p></w:body></w:document>',
    'word/comments.xml':
      '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="7" w:author="Reviewer" w:initials="RV" w:date="2026-08-27T00:00:00Z"><w:p><w:r><w:t>Needs source</w:t></w:r></w:p></w:comment></w:comments>',
    'word/numbering.xml':
      '<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
  });
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
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
  const byId = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'resolve_revision', id: '9', resolution: 'reject' }],
      },
      { cwd }
    )
  );
  assert.equal(byId.results[0].resolved, 1);
  assert.equal(byId.results[0].id, '9');
  const afterId = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(afterId.document.paragraphs[1].text, 'InsertedDeleted');
  assert.equal(afterId.document.revisionCount, 1);
  const missingId = await executeOfficeTool(
    {
      action: 'batch',
      session: opened.session,
      operations: [{ op: 'resolve_revision', id: '404', resolution: 'accept' }],
    },
    { cwd }
  );
  assert.equal(missingId.isError, true);
  assert.match(missingId.content[0].text, /revision id 404 not found/);
  const issues = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  assert.ok(issues.issues.some((issue) => issue.code === 'unresolved_comments'));
  assert.ok(issues.issues.some((issue) => issue.code === 'unresolved_revisions'));
});

test('template tokens named in the document language fill, and an unfilled one is reported', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'korean-template.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '{{계약명}} 위탁 계약 확인서', style: 'Heading 1' },
          { op: 'append_text', text: '수신: {{수신처}} 귀중' },
          {
            op: 'add_table',
            values: [
              ['항목', '내용'],
              ['담당자', '{{담당자}}'],
            ],
          },
          { op: 'set_header_footer', text: '{{계약명}} · 운영기획팀' },
        ],
      },
      { cwd }
    )
  );
  // Left as written, the placeholder is a shipping defect the audit must name.
  const pending = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.ok(
    (pending.issues || []).some((issue) => issue.code === 'unfilled_token'),
    JSON.stringify(pending.issues)
  );

  const strict = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [
        { op: 'fill_template', strict: true, tokens: { 계약명: '대전 허브 야간 운영', 수신처: '한빛물류' } },
      ],
    },
    { cwd }
  );
  assert.equal(strict.isError, true);
  assert.match(strict.content[0].text, /Unfilled template tokens: 담당자/);

  const mismatched = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'fill_template', tokens: { contractName: '대전 허브' } }],
    },
    { cwd }
  );
  assert.equal(mismatched.isError, true);
  assert.match(
    mismatched.content[0].text,
    /changed nothing: the document carries \{\{계약명\}\}, \{\{담당자\}\}, \{\{수신처\}\} and tokens named contractName/
  );

  const filled = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'fill_template',
            strict: true,
            tokens: { 계약명: '대전 허브 야간 운영', 수신처: '한빛물류', 담당자: '김서연 책임' },
          },
        ],
      },
      { cwd }
    )
  );
  // Twice for the heading and the running header, once each elsewhere.
  assert.deepEqual(filled.results[0].filled, { 계약명: 2, 수신처: 1, 담당자: 1 });
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(snapshot.document.tables[0].rows[1].cells[1].text, '김서연 책임');
  assert.doesNotMatch(JSON.stringify(snapshot.document), /\{\{/);
  const settled = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal((settled.issues || []).filter((issue) => issue.code === 'unfilled_token').length, 0);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('portable DOCX fills split template tokens across stories and rolls back strict failures', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'template.docx');
  const output = join(cwd, 'filled.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{ na</w:t></w:r><w:r><w:t>me }}</w:t></w:r></w:p><w:p><w:r><w:t>{{missing}}</w:t></w:r></w:p></w:body></w:document>',
    'word/header1.xml':
      '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Owner: {{ owner }}</w:t></w:r></w:p></w:hdr>',
  });
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
  const rejected = await executeOfficeTool(
    {
      action: 'batch',
      session: opened.session,
      operations: [{ op: 'fill_template', tokens: { name: 'Ada', owner: 'Team' }, strict: true }],
    },
    { cwd }
  );
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /missing/);
  const beforeFill = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.match(JSON.stringify(beforeFill.document), /\{\{ name }}/);

  const filled = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'fill_template', tokens: { name: 'Ada', owner: 'Team', missing: 'Done' }, strict: true }],
      },
      { cwd }
    )
  );
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
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">Dear {{ na</w:t></w:r><w:r><w:t>me }}, welcome.</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const filled = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'track_changes', enabled: true },
          { op: 'fill_template', tokens: { name: 'Ada' }, strict: true, author: 'Reviewer' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(filled.results[1].tracked, true);
  assert.deepEqual(filled.results[1].filled, { name: 1 });
  assert.deepEqual(filled.results[1].unfilledTokens, []);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.paragraphs[0].text, 'Dear Ada, welcome.');
  // The token straddled two runs, so each run keeps its own deletion; one insertion carries the value.
  assert.deepEqual(snapshot.document.revisionAuthors, [{ author: 'Reviewer', insertions: 1, deletions: 2 }]);
  const audit = value(
    await executeOfficeTool(
      { action: 'validate', session: opened.session, auditProfile: 'redlining', author: 'Reviewer' },
      { cwd }
    )
  );
  assert.equal(audit.redlining.ok, true, audit.redlining.reason);
});

test('portable XLSX edits cells, ranges, formulas, and appended rows', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.xlsx');
  const output = join(cwd, 'edited.xlsx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="InputRange">Data!$B$1:$C$2</definedName></definedNames></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Old</t></is></c></row></sheetData><dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="E1:E3"><formula1>"Yes,No"</formula1></dataValidation></dataValidations></worksheet>',
  });

  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'New' },
          {
            op: 'set_range',
            sheet: 'Data',
            range: 'B1:C2',
            values: [
              [1, 2],
              [3, 4],
            ],
          },
          { op: 'set_formula', sheet: 'Data', cell: 'D1', formula: '=SUM(B1:C2)' },
          { op: 'append_row', sheet: 'Data', values: ['tail', 5] },
        ],
      },
      { cwd }
    )
  );

  const snapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: opened.session,
      },
      { cwd }
    )
  );
  const cells = snapshot.document.sheets[0].cells;
  assert.equal(cells.find((cell) => cell.ref === 'A1').value, 'New');
  // Excel hands a stored number back as a number; the portable reader answers
  // with the same value, so a tie-out against 4 does not depend on the backend.
  assert.equal(cells.find((cell) => cell.ref === 'C2').value, 4);
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
    const rejected = await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [operation],
      },
      { cwd }
    );
    assert.equal(rejected.isError, true);
  }

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'Path set' }],
      },
      { cwd }
    )
  );
  const cell = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: opened.session,
        target: '/sheet[Data]/cell[A1]',
      },
      { cwd }
    )
  );
  assert.equal(cell.element.value, 'Path set');

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_cell', sheet: 'Data', cell: 'E1', value: '#REF!' }],
      },
      { cwd }
    )
  );
  const issues = value(
    await executeOfficeTool(
      {
        action: 'issues',
        session: opened.session,
      },
      { cwd }
    )
  );
  assert.equal(issues.ok, false);
  assert.ok(
    issues.issues.some((issue) => issue.code === 'formula_cache_missing' && issue.path === '/sheet[Data]/cell[D1]')
  );
  assert.ok(issues.issues.some((issue) => issue.code === 'formula_error' && issue.path === '/sheet[Data]/cell[E1]'));

  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_cell', sheet: 'Data', cell: 'F1', value: 'Committed' }],
      },
      { cwd }
    )
  );
  const committed = value(await executeOfficeTool({ action: 'commit', session: opened.session }, { cwd }));
  assert.equal(committed.committed, true);
  assert.ok(committed.transaction.diff.summary.added > 0);
});

// A header's rule and a total's rule are borders on the cells; the style keeps the edges it is not asked
// about, so a fill set later never erases the rule set first.
test('portable XLSX set_style draws cell borders and a later style keeps them', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'ruled.xlsx');
  const workbook = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['라인', '처리량'],
              ['1호', 1200],
              ['합계', 1200],
            ],
          },
          {
            op: 'set_style',
            range: 'A1:B1',
            properties: { bold: true, borders: { bottom: { style: 'thin', color: 'C9CED6' } } },
          },
          {
            op: 'set_style',
            range: 'A3:B3',
            properties: { bold: true, borders: { top: { style: 'medium', color: '1F6F8B' } } },
          },
          { op: 'set_style', range: 'A1:B1', properties: { fillColor: 'EEF2F7' } },
          { op: 'set_style', cell: 'B2', properties: { borders: { style: 'hair', color: 'D8DCE0' } } },
        ],
      },
      { cwd }
    )
  );
  const styles = await (await JSZip.loadAsync(await readFile(path))).file('xl/styles.xml').async('string');
  assert.match(
    styles,
    /<border><left\/><right\/><top\/><bottom style="thin"><color rgb="FFC9CED6"\/><\/bottom><diagonal\/><\/border>/
  );
  assert.match(
    styles,
    /<border><left\/><right\/><top style="medium"><color rgb="FF1F6F8B"\/><\/top><bottom\/><diagonal\/><\/border>/
  );
  assert.match(styles, /<border><left style="hair"><color rgb="FFD8DCE0"\/><\/left><right style="hair">/);
  const sheet = await (await JSZip.loadAsync(await readFile(path))).file('xl/worksheets/sheet1.xml').async('string');
  const styleOf = (ref) => Number(new RegExp(`<c r="${ref}"[^>]*\\bs="(\\d+)"`).exec(sheet)?.[1]);
  const xfs = [...styles.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((match) => match[0]);
  const cellXfs = xfs.slice(xfs.length - (styles.match(/<cellXfs count="(\d+)"/)?.[1] || 0));
  const headerXf = cellXfs[styleOf('A1')];
  assert.match(headerXf, /applyFill="1"/);
  assert.match(headerXf, /applyBorder="1"/);
  assert.notEqual(Number(/borderId="(\d+)"/.exec(headerXf)[1]), 0, 'the fill set later keeps the header rule');
  const refused = await executeOfficeTool(
    {
      action: 'batch',
      session: workbook.session,
      operations: [{ op: 'set_style', cell: 'A2', properties: { borders: { bottom: { style: 'wavy' } } } }],
    },
    { cwd }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /borders\.bottom\.style "wavy"/);
});

test('unreadable ink is reported in a workbook cell and a shaded document row', async (t) => {
  const cwd = await workspace(t);
  const workbook = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'ink.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['라인', '판정'],
              ['서울 1호', '정상'],
            ],
          },
          // A header on a dark field that kept the body's dark ink.
          { op: 'set_style', range: 'A1:A1', properties: { bold: true, fillColor: '16283C', color: '1B2A3B' } },
          // The readable version of the same idea sits beside it.
          { op: 'set_style', range: 'B1:B1', properties: { bold: true, fillColor: '16283C', color: 'FFFFFF' } },
        ],
      },
      { cwd }
    )
  );
  const cells = (
    value(await executeOfficeTool({ action: 'issues', session: workbook.session }, { cwd })).issues || []
  ).filter((entry) => entry.code === 'low_contrast');
  assert.deepEqual(
    cells.map((entry) => entry.path),
    ['/sheet[Sheet1]/cell[A1]']
  );

  const document = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'ink.docx'),
        format: 'docx',
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '라인별 판정', style: 'Heading 1' },
          {
            op: 'add_table',
            values: [
              ['라인', '판정'],
              ['서울 1호', '정상'],
            ],
            properties: { fontName: 'Noto Sans KR', fontSize: 10, color: '1B2A3B', shading: '16283C' },
          },
        ],
      },
      { cwd }
    )
  );
  const rows = (
    value(await executeOfficeTool({ action: 'issues', session: document.session }, { cwd })).issues || []
  ).filter((entry) => entry.code === 'low_contrast');
  assert.equal(rows.length, 4, JSON.stringify(rows));
  assert.equal(rows[0].path, '/body/tbl[1]/row[1]/cell[1]');
  assert.match(rows[0].message, /readable minimum at 10pt/);
});

test('a paged workbook snapshot reports the whole workbook calculation state', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'paged.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['a', 1],
              ['b', 2],
            ],
          },
          { op: 'add_sheet', name: 'Calc' },
          { op: 'set_formula', sheet: 'Calc', cell: 'B1', formula: '=SUM(Sheet1!B1:B2)' },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  // The page carries the first sheet, which has no formula at all; the
  // calculation state still has to describe the workbook the caller holds.
  assert.equal(snapshot.document.pagination.scope, 'Sheet1');
  assert.equal(snapshot.document.sheets.length, 1);
  assert.equal(snapshot.document.sheetCount, 2);
  assert.equal(snapshot.document.formulaCount, 1);
  assert.equal(snapshot.document.formulaCacheMissing, 1);
  assert.equal(snapshot.document.needsRecalculation, true);
});

test('XLSX finalize assertions prove values, formulas, tie-outs, and errors', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'assertions-source.xlsx');
  const output = join(cwd, 'assertions.xlsx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:B2',
            values: [
              ['Actual', 'Plan'],
              [120, 120],
            ],
          },
          { op: 'set_formula', sheet: 'Sheet1', cell: 'C2', formula: '=A2-B2' },
        ],
      },
      { cwd }
    )
  );
  const passed = value(
    await executeOfficeTool(
      {
        action: 'validate',
        session: created.session,
        assertions: [
          { kind: 'cell-value', sheet: 'Sheet1', cell: 'A2', equals: 120 },
          { kind: 'cell-formula', sheet: 'Sheet1', cell: 'C2', equals: '=A2-B2' },
          { kind: 'tie-out', sheet: 'Sheet1', left: 'A2', right: 'B2', tolerance: 0 },
          { kind: 'no-errors', sheet: 'Sheet1' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.equal(passed.assertions.passed, 4);
  const failed = value(
    await executeOfficeTool(
      {
        action: 'validate',
        session: created.session,
        assertions: [{ kind: 'cell-value', sheet: 'Sheet1', cell: 'A2', equals: 999 }],
      },
      { cwd }
    )
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.assertions.issues[0].code, 'assertion_value_mismatch');
});

// A page borrowed from another deck was drawn on that deck's layout. Refusing
// the import unless both files came from one template left the documented
// operation unusable between two decks the runtime itself authored, so the
// layout travels with the page and this deck's master adopts it — one master,
// one theme, and the page keeps the geometry it was built with.
test('portable PPTX imports a page from another template by adopting its layout', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'deck.pptx');
  const library = join(cwd, 'library.pptx');
  const output = join(cwd, 'merged.pptx');
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relationships = (entries) =>
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `${entries}</Relationships>`;
  const deck = (name) => ({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/></Types>',
    '_rels/.rels': relationships(
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>`
    ),
    'ppt/presentation.xml':
      `<?xml version="1.0"?><p:presentation ${P} ${R}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>` +
      '</p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relationships(
      `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/>`
    ),
    'ppt/slides/slide1.xml':
      `<?xml version="1.0"?><p:sld ${P} ${A}><p:cSld><p:spTree>` +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${name} 장</a:t></a:r></a:p></p:txBody></p:sp>` +
      '</p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': relationships(
      `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
    ),
    'ppt/slideLayouts/slideLayout1.xml': `<?xml version="1.0"?><p:sldLayout ${P}><p:cSld name="${name} Layout"/></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': relationships(
      `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`
    ),
    'ppt/slideMasters/slideMaster1.xml':
      `<?xml version="1.0"?><p:sldMaster ${P} ${R}><p:cSld name="${name} Master"/>` +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': relationships(
      `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
    ),
  });
  await writeZip(target, deck('Target'));
  await writeZip(library, deck('Library'));
  const opened = value(await executeOfficeTool({ action: 'open', path: target, output, mode: 'portable' }, { cwd }));
  const imported = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'import_slides', path: library, slides: [1], after: 1 }],
      },
      { cwd }
    )
  );
  assert.equal(imported.results[0].count, 1);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(
    snapshot.document.slides.map((entry) => entry.text.join('')),
    ['Target 장', 'Library 장']
  );
  const merged = await parts(output);
  // The borrowed layout came in as its own part; the library's master did not.
  assert.match(await merged.text('ppt/slideLayouts/slideLayout2.xml'), /Library Layout/);
  assert.equal(merged.has('ppt/slideMasters/slideMaster2.xml'), false);
  const master = await merged.text('ppt/slideMasters/slideMaster1.xml');
  const adopted = /<p:sldLayoutId id="\d+" r:id="(rId\d+)"\/><\/p:sldLayoutIdLst>/.exec(master)?.[1];
  assert.ok(adopted, master);
  assert.match(
    await merged.text('ppt/slideMasters/_rels/slideMaster1.xml.rels'),
    new RegExp(`Id="${adopted}"[^>]*Target="\\.\\./slideLayouts/slideLayout2\\.xml"`)
  );
  assert.match(await merged.text('ppt/slides/_rels/slide2.xml.rels'), /Target="\.\.\/slideLayouts\/slideLayout2\.xml"/);
  assert.match(
    await merged.text('ppt/slideLayouts/_rels/slideLayout2.xml.rels'),
    /Target="\.\.\/slideMasters\/slideMaster1\.xml"/
  );
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
});

test('portable PPTX fills template tokens while preserving masters and layouts', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.pptx');
  const output = join(cwd, 'edited.pptx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml':
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    'ppt/slides/slide1.xml':
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{{ti</a:t></a:r><a:r><a:t>tle}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/notesSlides/notesSlide1.xml':
      '<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Owner {{owner}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    'ppt/slideMasters/slideMaster1.xml':
      '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Master"/></p:sldMaster>',
    'ppt/slideLayouts/slideLayout1.xml':
      '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Layout"/></p:sldLayout>',
  });

  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'fill_template', tokens: { title: 'Mixdog', owner: '재영' }, strict: true },
          { op: 'add_textbox', slide: 1, text: 'Second box', left: 20, top: 40, width: 200, height: 50 },
        ],
      },
      { cwd }
    )
  );

  const snapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: opened.session,
      },
      { cwd }
    )
  );
  assert.deepEqual(snapshot.document.slides[0].text, ['Mixdog', 'Second box']);
  assert.equal(snapshot.document.slides[0].shapes[0].path, '/slide[1]/shape[1]');
  assert.equal(snapshot.document.layoutCount, 1);
  assert.equal(snapshot.document.layouts[0].name, 'Brand Layout');
  const packageAfterFill = await JSZip.loadAsync(await readFile(output));
  assert.equal(
    await packageAfterFill.file('ppt/slideMasters/slideMaster1.xml').async('string'),
    '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Master"/></p:sldMaster>'
  );
  assert.match(await packageAfterFill.file('ppt/notesSlides/notesSlide1.xml').async('string'), /Owner 재영/);

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'set_text', slide: 1, shape: 1, text: 'Path shape' },
          { op: 'delete_shape', slide: 1, shape: 2 },
        ],
      },
      { cwd }
    )
  );
  const updated = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: opened.session,
      },
      { cwd }
    )
  );
  assert.equal(updated.document.slides[0].shapes[0].text, 'Path shape');
  assert.equal(updated.document.slides[0].shapes.length, 1);
});

test('macro and digital-signature containers expose security inventory and fail invalidated signatures', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'signed.xlsm');
  const output = join(cwd, 'signed-copy.xlsm');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Default Extension="sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="vbaProject" Target="vbaProject.bin"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
    'xl/vbaProject.bin': Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]),
    '_xmlsignatures/origin.sigs': Buffer.from([1, 2, 3]),
    '_xmlsignatures/sig1.xml': '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>',
  });
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
      },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'edited' }],
      },
      { cwd }
    )
  );
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, false);
  assert.equal(validation.security.macroExecution, 'disabled');
  assert.equal(validation.security.macros.length, 1);
  assert.equal(validation.security.signatures.length, 2);
  assert.equal(validation.security.digitalSignatureInvalidated, true);
});
