import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { describeOfficeSnapshotViolations, officeSnapshotContractViolations } from './snapshot-contract.mjs';

const enabled = process.platform === 'win32' && process.env.MIXDOG_TEST_LIVE_OFFICE === '1';

function value(result) {
  assert.equal(result?.isError, undefined, result?.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function waitForProcessExit(processId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function startExternalExcel(path) {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MixdogExcelTestWindow {
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static int ProcessId(long hWnd) {
    uint processId;
    GetWindowThreadProcessId(new IntPtr(hWnd), out processId);
    return unchecked((int)processId);
  }
}
'@
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $true
$excel.DisplayAlerts = $false
$workbook = $excel.Workbooks.Open(${JSON.stringify(path)})
[Console]::Out.WriteLine("READY:$($excel.Hwnd):$([MixdogExcelTestWindow]::ProcessId([long]$excel.Hwnd))")
$null = [Console]::In.ReadLine()
try { $workbook.Close($false) } catch {}
try { $excel.Quit() } catch {}
try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($workbook) } catch {}
try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) } catch {}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const powershell = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
  const child = spawn(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Sta',
    '-EncodedCommand',
    encoded,
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out opening external Excel workbook: ${path}`));
      try { child.kill(); } catch {}
    }, 20_000);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.once('error', fail);
    child.once('close', (code) => fail(new Error(`External Excel host exited early with code ${code}`)));
    lines.on('line', (line) => {
      const match = /^READY:(\d+):(\d+)$/.exec(line.trim());
      if (!match) return;
      clearTimeout(timer);
      child.removeListener('error', fail);
      resolve({ child, lines, hWnd: Number(match[1]), processId: Number(match[2]) });
    });
  });
}

async function stopExternalExcel(external) {
  if (!external || external.child.exitCode !== null) return;
  external.child.stdin.end('\n');
  await Promise.race([
    once(external.child, 'close'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('External Excel host did not close')), 15_000)),
  ]);
  external.lines.close();
}

test('persistent Excel sessions own one document and preserve UTF-8 text', {
  skip: !enabled,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const backgroundPath = join(cwd, 'background-한글.xlsx');
  const visiblePath = join(cwd, 'visible-한글.xlsx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });

  const background = value(await executeOfficeTool({
    action: 'create',
    path: backgroundPath,
    format: 'xlsx',
    mode: 'background',
  }, { cwd }));
  assert.equal(background.mode, 'background');
  assert.equal(background.ownership, 'owned');
  assert.equal(background.visible, false);

  const backgroundBatch = value(await executeOfficeTool({
    action: 'batch',
    session: background.session,
    operations: [
      { op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '하이하이하이' },
      { op: 'set_cell', sheet: 'Sheet1', cell: 'B1', value: 21 },
      { op: 'set_range', sheet: 'Sheet1', range: 'C1:D1', values: [[true, 22.5]] },
      { op: 'append_row', sheet: 'Sheet1', values: ['추가 행', 23] },
      { op: 'add_validation', sheet: 'Sheet1', range: 'E1:E3', formula1: 'Yes,No', inputMessage: 'Choose a value' },
      { op: 'freeze_panes', sheet: 'Sheet1', row: 1 },
      { op: 'set_sheet_view', sheet: 'Sheet1', showGridlines: false, zoom: 95 },
    ],
  }, { cwd }));
  assert.deepEqual(backgroundBatch.backgroundIsolation?.observedVisibleWindows, [], JSON.stringify(backgroundBatch));
  assert.equal(backgroundBatch.backgroundIsolation?.hiddenWindows, 0, JSON.stringify(backgroundBatch));
  assert.equal(backgroundBatch.backgroundIsolation?.focusRestorations, 0, JSON.stringify(backgroundBatch));
  assert.equal(
    backgroundBatch.backgroundIsolation?.foregroundAfter,
    backgroundBatch.backgroundIsolation?.foregroundBefore,
    JSON.stringify(backgroundBatch),
  );
  const backgroundCell = value(await executeOfficeTool({
    action: 'get',
    session: background.session,
    target: '/sheet[Sheet1]/cell[A1]',
  }, { cwd }));
  assert.equal(backgroundCell.element.value, '하이하이하이');
  const backgroundNumber = value(await executeOfficeTool({
    action: 'get',
    session: background.session,
    target: '/sheet[Sheet1]/cell[B1]',
  }, { cwd }));
  assert.equal(backgroundNumber.element.value, 21);
  const backgroundRangeNumber = value(await executeOfficeTool({
    action: 'get',
    session: background.session,
    target: '/sheet[Sheet1]/cell[D1]',
  }, { cwd }));
  assert.equal(backgroundRangeNumber.element.value, 22.5);
  const appendedNumber = value(await executeOfficeTool({
    action: 'get',
    session: background.session,
    target: '/sheet[Sheet1]/cell[B2]',
  }, { cwd }));
  assert.equal(appendedNumber.element.value, 23);
  const validatedWorkbook = value(await executeOfficeTool({
    action: 'snapshot',
    session: background.session,
  }, { cwd }));
  assert.equal(validatedWorkbook.document.sheets[0].validationCount, 1);
  assert.deepEqual(validatedWorkbook.document.sheets[0].validations[0].ranges, ['E1:E3']);
  value(await executeOfficeTool({
    action: 'batch',
    session: background.session,
    operations: [
      { op: 'set_formula', sheet: 'Sheet1', cell: 'G2', formula: '=B2*2' },
      { op: 'insert_rows', sheet: 'Sheet1', row: 2, count: 1 },
      { op: 'merge_cells', sheet: 'Sheet1', range: 'H1:I1' },
      { op: 'unmerge_cells', sheet: 'Sheet1', range: 'H1:I1' },
      { op: 'define_name', name: 'MixdogInput', refersTo: 'Sheet1!$B$1' },
      { op: 'set_hyperlink', sheet: 'Sheet1', cell: 'J1', address: 'https://mix.dog', text: 'Mixdog' },
    ],
  }, { cwd }));
  const shiftedFormula = value(await executeOfficeTool({
    action: 'get',
    session: background.session,
    target: '/sheet[Sheet1]/cell[G3]',
  }, { cwd }));
  assert.match(shiftedFormula.element.formula, /B3/);
  value(await executeOfficeTool({
    action: 'batch',
    session: background.session,
    operations: [
      { op: 'delete_rows', sheet: 'Sheet1', row: 2, count: 1 },
      { op: 'set_formula', sheet: 'Sheet1', cell: 'A1501', formula: '=1/0' },
      { op: 'set_cell', sheet: 'Sheet1', cell: 'B1501', value: 99 },
      { op: 'add_sheet', name: 'Checks' },
      { op: 'set_cell', sheet: 'Checks', cell: 'A1', value: 'Tie-out' },
      { op: 'set_formula', sheet: 'Checks', cell: 'B1', formula: '=1=2' },
    ],
  }, { cwd }));
  const formulaIssues = value(await executeOfficeTool({ action: 'issues', session: background.session }, { cwd }));
  assert.ok(formulaIssues.issues.some((issue) => issue.code === 'formula_error' && issue.path === '/sheet[Sheet1]/cell[A1501]'));
  const financialAudit = value(await executeOfficeTool({
    action: 'issues',
    session: background.session,
    auditProfile: 'financial-model',
  }, { cwd }));
  assert.equal(financialAudit.auditCoverage.mode, 'full');
  assert.equal(financialAudit.auditCoverage.complete, true);
  assert.equal(financialAudit.auditCoverage.scannedCells, financialAudit.auditCoverage.totalCells);
  assert.ok(financialAudit.issues.some((issue) => issue.code === 'hardcode_missing_source' && issue.path === '/sheet[Sheet1]/cell[B1501]'));
  assert.ok(financialAudit.issues.some((issue) => issue.code === 'failed_check' && issue.path === '/sheet[Checks]/cell[B1]'));
  const compactSnapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: background.session,
    sheet: 'Sheet1',
    limit: 10_000,
    maxChars: 100_000,
  }, { cwd }));
  assert.equal(compactSnapshot.document.sheets[0].representation, 'row-blocks');
  assert.equal(compactSnapshot.document.sheets[0].cells.length, 0);
  assert.ok(compactSnapshot.document.sheets[0].rowBlocks.length > 0);
  assert.equal(compactSnapshot.document.pagination.scanned, 10_000);
  assert.equal(compactSnapshot.document.sheets[0].rowBlocks[0].values[0][0], '하이하이하이');
  value(await executeOfficeTool({
    action: 'batch',
    session: background.session,
    operations: [{ op: 'clear_cell', sheet: 'Sheet1', cell: 'A1501' }],
  }, { cwd }));
  const backgroundValidation = value(await executeOfficeTool({ action: 'validate', session: background.session }, { cwd }));
  assert.equal(backgroundValidation.ok, true, JSON.stringify(backgroundValidation));
  assert.equal(backgroundValidation.native.opened, true);

  const failedBatch = await executeOfficeTool({
    action: 'batch',
    session: background.session,
    operations: [
      { op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '복원되어야 함' },
      { op: 'unsupported_operation' },
    ],
  }, { cwd });
  assert.equal(failedBatch.isError, true);
  const afterFailure = value(await executeOfficeTool({
    action: 'get',
    session: background.session,
    target: '/sheet[Sheet1]/cell[A1]',
  }, { cwd }));
  assert.equal(afterFailure.element.value, '하이하이하이');

  value(await executeOfficeTool({ action: 'begin', session: background.session }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: background.session,
    operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '트랜잭션 임시값' }],
  }, { cwd }));
  const transactionDiff = value(await executeOfficeTool({
    action: 'diff',
    session: background.session,
  }, { cwd }));
  assert.ok(transactionDiff.transaction.diff.summary.modified > 0);
  value(await executeOfficeTool({ action: 'rollback', session: background.session }, { cwd }));
  const afterRollback = value(await executeOfficeTool({
    action: 'get',
    session: background.session,
    target: '/sheet[Sheet1]/cell[A1]',
  }, { cwd }));
  assert.equal(afterRollback.element.value, '하이하이하이');
  value(await executeOfficeTool({ action: 'close', session: background.session }, { cwd }));

  const strictAttach = await executeOfficeTool({
    action: 'attach',
    path: backgroundPath,
  }, { cwd });
  assert.equal(strictAttach.isError, true);
  assert.match(strictAttach.content[0].text, /not registered as open/i);

  const visible = value(await executeOfficeTool({
    action: 'create',
    path: visiblePath,
    format: 'xlsx',
    mode: 'visible',
  }, { cwd }));
  assert.equal(visible.mode, 'visible');
  assert.equal(visible.ownership, 'owned');
  assert.equal(visible.visible, true);
  assert.ok(visible.appPid > 0);
  assert.ok(visible.windowHwnd > 0);

  const reused = value(await executeOfficeTool({
    action: 'open',
    path: visiblePath,
    mode: 'visible',
  }, { cwd }));
  assert.equal(reused.session, visible.session);
  assert.equal(reused.reused, true);

  value(await executeOfficeTool({
    action: 'batch',
    session: visible.session,
    operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '한글-日本語-中文' }],
    save: true,
  }, { cwd }));
  const visibleCell = value(await executeOfficeTool({
    action: 'get',
    session: visible.session,
    target: '/sheet[Sheet1]/cell[A1]',
  }, { cwd }));
  assert.equal(visibleCell.element.value, '한글-日本語-中文');
  const visibleSnapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: visible.session,
  }, { cwd }));
  assert.equal(visibleSnapshot.document.selection.available, true);
  assert.equal(visibleSnapshot.document.selection.sheet, 'Sheet1');
  assert.match(visibleSnapshot.document.selection.target, /^\/sheet\[Sheet1\]\/range\[/);
  value(await executeOfficeTool({
    action: 'batch',
    session: visible.session,
    operations: [{
      op: 'add_provenance',
      sheet: 'Sheet1',
      cell: 'A1',
      source: { document: 'source-model.xlsx', target: '/sheet[Inputs]/cell[C3]', label: 'Revenue' },
    }],
  }, { cwd }));
  const sourcedWorkbook = value(await executeOfficeTool({
    action: 'snapshot',
    session: visible.session,
  }, { cwd }));
  assert.match(sourcedWorkbook.document.sheets[0].notes[0].text, /Source: source-model\.xlsx#\/sheet\[Inputs\]\/cell\[C3\]/);

  value(await executeOfficeTool({
    action: 'close',
    session: visible.session,
    save: true,
  }, { cwd }));
  assert.equal(await waitForProcessExit(visible.appPid), true);
});

test('persistent Word and PowerPoint sessions create, save, and read Unicode content', {
  skip: !enabled,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-formats-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });

  const word = value(await executeOfficeTool({
    action: 'create',
    path: join(cwd, '문서.docx'),
    format: 'docx',
    mode: 'visible',
  }, { cwd }));
  assert.ok(word.appPid > 0);
  assert.ok(word.windowHwnd > 0);
  value(await executeOfficeTool({
    action: 'batch',
    session: word.session,
    operations: [
      { op: 'append_text', text: '한글-日本語-中文 {{ name }}' },
      { op: 'set_header_footer', section: 1, kind: 'primary', header: true, text: 'Owner {{owner}}' },
      { op: 'fill_template', tokens: { name: '재영', owner: 'Mixdog' }, strict: true },
      {
        op: 'add_table',
        values: [['Metric', 'Value'], ['Revenue', '120'], ['Summary', 'Ready']],
        properties: { borders: true, columnWidths: [110, 110], alignment: 'center' },
      },
      { op: 'set_table_cell_style', table: 1, row: 1, col: 1, properties: { fillColor: 'D9EAF7', bold: true } },
      { op: 'merge_table_cells', table: 1, row: 3, col: 1, colSpan: 2 },
      {
        op: 'set_paragraph_format',
        paragraph: 1,
        properties: { spacingAfter: 6, keepWithNext: true, tabStops: [{ position: 240, alignment: 'right', leader: 'dot' }] },
      },
    ],
  }, { cwd }));
  const wordSnapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: word.session,
  }, { cwd }));
  assert.match(JSON.stringify(wordSnapshot.document), /한글-日本語-中文/);
  assert.match(JSON.stringify(wordSnapshot.document), /한글-日本語-中文 재영/);
  assert.match(JSON.stringify(wordSnapshot.document), /Owner Mixdog/);
  assert.doesNotMatch(JSON.stringify(wordSnapshot.document), /\{\{/);
  assert.notEqual(wordSnapshot.document.paragraphs[0].style, 'System.__ComObject');
  assert.ok(wordSnapshot.document.paragraphs[0].style.length > 0);
  assert.equal(wordSnapshot.document.tableCount, 1);
  assert.equal(wordSnapshot.document.tables[0].rows[0].cells[0].text, 'Metric');
  assert.equal(wordSnapshot.document.tables[0].alignment, 1);
  assert.equal(wordSnapshot.document.tables[0].columnWidths.length, 2);
  assert.equal(wordSnapshot.document.paragraphs[0].format.spacingAfter, 6);
  value(await executeOfficeTool({
    action: 'batch',
    session: word.session,
    operations: [
      { op: 'add_comment', find: '한글-日本語-中文', text: '검토 의견' },
      { op: 'add_comment_reply', comment: 1, text: '답글 확인' },
      { op: 'set_comment_resolved', comment: 1, resolved: true },
    ],
  }, { cwd }));
  const commented = value(await executeOfficeTool({
    action: 'snapshot',
    session: word.session,
  }, { cwd }));
  assert.equal(commented.document.commentCount, 1);
  assert.equal(commented.document.comments[0].text, '검토 의견');
  assert.equal(commented.document.comments[0].anchoredText, '한글-日本語-中文');
  assert.equal(commented.document.comments[0].replies.length, 1);
  assert.equal(commented.document.comments[0].replies[0].text, '답글 확인');
  assert.equal(commented.document.comments[0].resolved, true);
  value(await executeOfficeTool({
    action: 'batch',
    session: word.session,
    operations: [{ op: 'delete_comment', comment: 1 }],
  }, { cwd }));
  const withoutComment = value(await executeOfficeTool({
    action: 'snapshot',
    session: word.session,
  }, { cwd }));
  assert.equal(withoutComment.document.commentCount, 0);
  value(await executeOfficeTool({
    action: 'batch',
    session: word.session,
    operations: [{
      op: 'add_provenance',
      paragraph: 1,
      source: { document: 'source-model.xlsx', target: '/sheet[Inputs]/cell[C3]', label: 'Revenue' },
    }],
  }, { cwd }));
  const sourcedWord = value(await executeOfficeTool({
    action: 'snapshot',
    session: word.session,
  }, { cwd }));
  assert.match(sourcedWord.document.comments[0].text, /Source: source-model\.xlsx#\/sheet\[Inputs\]\/cell\[C3\]/);
  value(await executeOfficeTool({
    action: 'batch',
    session: word.session,
    operations: [
      { op: 'track_changes', enabled: true },
      { op: 'append_text', text: '추적 변경' },
      { op: 'track_changes', enabled: false },
    ],
  }, { cwd }));
  const revised = value(await executeOfficeTool({
    action: 'snapshot',
    session: word.session,
  }, { cwd }));
  assert.ok(revised.document.revisionCount > 0);
  assert.ok(revised.document.revisions.some((revision) => revision.text.includes('추적 변경')));
  value(await executeOfficeTool({
    action: 'batch',
    session: word.session,
    operations: [{ op: 'resolve_revision', revision: 1, resolution: 'accept' }],
  }, { cwd }));
  const afterResolution = value(await executeOfficeTool({
    action: 'snapshot',
    session: word.session,
  }, { cwd }));
  assert.ok(afterResolution.document.revisionCount < revised.document.revisionCount);
  const professional = value(await executeOfficeTool({
    action: 'batch',
    session: word.session,
    operations: [
      { op: 'add_bookmark', name: 'MixdogStart', find: '한글-日本語-中文' },
      { op: 'add_hyperlink', find: '한글-日本語-中文', address: 'https://mix.dog' },
      { op: 'set_list', paragraph: 1, kind: 'bullet' },
      { op: 'insert_break', kind: 'page' },
      { op: 'add_page_numbers', section: 1, includeTotal: true },
      { op: 'insert_toc', lowerHeadingLevel: 1, upperHeadingLevel: 3 },
    ],
  }, { cwd }));
  assert.deepEqual(professional.results.map((result) => result.op), [
    'add_bookmark',
    'add_hyperlink',
    'set_list',
    'insert_break',
    'add_page_numbers',
    'insert_toc',
  ]);
  value(await executeOfficeTool({ action: 'close', session: word.session }, { cwd }));

  const powerpoint = value(await executeOfficeTool({
    action: 'create',
    path: join(cwd, '발표.pptx'),
    format: 'pptx',
    mode: 'background',
  }, { cwd }));
  assert.equal(powerpoint.backgroundIsolation?.strict, true, JSON.stringify(powerpoint));
  assert.equal(powerpoint.backgroundIsolation?.isolatedProcess, true, JSON.stringify(powerpoint));
  assert.deepEqual(powerpoint.backgroundIsolation?.observedVisibleWindows, [], JSON.stringify(powerpoint));
  assert.equal(
    powerpoint.backgroundIsolation?.foregroundAfter,
    powerpoint.backgroundIsolation?.foregroundBefore,
    JSON.stringify(powerpoint),
  );
  assert.equal(powerpoint.backgroundIsolation?.visibleOwnedWindows, 0, JSON.stringify(powerpoint));
  assert.equal(powerpoint.backgroundIsolation?.ownedForeground, false, JSON.stringify(powerpoint));
  const powerpointBatch = value(await executeOfficeTool({
    action: 'batch',
    session: powerpoint.session,
    operations: [
      { op: 'add_slide' },
      {
        op: 'add_textbox',
        slide: 1,
        text: '{{ title }} 한글-日本語-中文',
        properties: { left: 90, top: 80, width: 500, height: 120, fontSize: 24 },
      },
      {
        op: 'add_shape',
        slide: 1,
        shapeType: 'rounded_rectangle',
        paragraphs: [
          { text: 'Card', bold: true, fontSize: 20, color: 'FFFFFF' },
          { text: 'Bullet item', bullet: true, level: 0, fontSize: 14, color: 'FFFFFF' },
        ],
        properties: { left: 40, top: 240, width: 180, height: 80, fillColor: 'E8F0FE', lineColor: '3367D6' },
      },
      {
        op: 'add_table',
        slide: 1,
        values: [['Metric', 'Value'], ['Users', 42]],
        properties: { left: 240, top: 240, width: 280, height: 100 },
      },
      {
        op: 'set_table_data',
        slide: 1,
        shape: 3,
        values: [
          ['Metric', 'Actual', 'Plan', 'Status'],
          ['Users', 42, 45, 'Track'],
          ['Calls', 18, 20, 'Track'],
          ['Errors', 0, 0, 'Pass'],
        ],
      },
      {
        op: 'add_chart',
        slide: 1,
        chartType: 'column',
        title: 'Initial',
        left: 540,
        top: 220,
        width: 300,
        height: 180,
      },
      {
        op: 'set_chart_data',
        slide: 1,
        shape: 4,
        title: 'Metrics',
        categories: ['A', 'B'],
        series: [
          { name: 'Actual', values: [10, 20] },
          { name: 'Plan', values: [12, 18] },
        ],
      },
      { op: 'set_chart_series', slide: 1, shape: 4, series: 2, chartType: 'line', secondaryAxis: true },
      { op: 'set_chart_trendline', slide: 1, shape: 4, series: 1, type: 'linear' },
      { op: 'set_chart_error_bars', slide: 1, shape: 4, series: 1, amount: 2, direction: 'y' },
      { op: 'set_chart_data_labels', slide: 1, shape: 4, series: 1, showValue: true },
      { op: 'set_transition', slide: 1, effect: 'fade', duration: 1, advanceOnTime: false },
      { op: 'add_animation', slide: 1, shape: 2, effect: 'fade', trigger: 'afterprevious', duration: 0.5 },
      {
        op: 'set_shape',
        slide: 1,
        shape: 2,
        properties: { fillTransparency: 0.1, marginLeft: 8, marginRight: 8, paragraphSpacing: 3 },
      },
      { op: 'add_comment', slide: 1, text: '차트와 전환 검토', author: 'Mixdog', initials: 'MD' },
      { op: 'align_shapes', slide: 1, shapes: [2, 3], align: 'top' },
      { op: 'set_hyperlink', slide: 1, shape: 2, address: 'https://mix.dog' },
      { op: 'z_order', slide: 1, shape: 2, command: 'front' },
      {
        op: 'add_chart',
        slide: 1,
        chartType: 'column',
        title: 'One series',
        categories: ['May', 'June', 'July'],
        series: [{ name: 'Revenue', values: [10, 12, 15] }],
        left: 540,
        top: 410,
        width: 300,
        height: 120,
      },
      { op: 'set_notes', slide: 1, text: 'Owner {{owner}}' },
      { op: 'fill_template', tokens: { title: '실제 템플릿', owner: 'Mixdog' }, strict: true },
    ],
  }, { cwd }));
  assert.equal(powerpointBatch.backgroundIsolation?.strict, true, JSON.stringify(powerpointBatch));
  assert.deepEqual(powerpointBatch.backgroundIsolation?.observedVisibleWindows, [], JSON.stringify(powerpointBatch));
  assert.equal(
    powerpointBatch.backgroundIsolation?.foregroundAfter,
    powerpointBatch.backgroundIsolation?.foregroundBefore,
    JSON.stringify(powerpointBatch),
  );
  assert.equal(powerpointBatch.backgroundIsolation?.visibleOwnedWindows, 0, JSON.stringify(powerpointBatch));
  assert.equal(powerpointBatch.backgroundIsolation?.ownedForeground, false, JSON.stringify(powerpointBatch));
  assert.equal(powerpointBatch.backgroundIsolation?.hiddenWindows, 0, JSON.stringify(powerpointBatch));
  assert.equal(powerpointBatch.backgroundIsolation?.focusRestorations, 0, JSON.stringify(powerpointBatch));
  const powerpointSnapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: powerpoint.session,
  }, { cwd }));
  assert.match(JSON.stringify(powerpointSnapshot.document), /한글-日本語-中文/);
  assert.match(JSON.stringify(powerpointSnapshot.document), /실제 템플릿/);
  assert.equal(powerpointSnapshot.document.slides[0].notes, 'Owner Mixdog');
  assert.ok(powerpointSnapshot.document.layoutCount > 0);
  const textbox = powerpointSnapshot.document.slides[0].shapes.find((shape) => shape.text?.includes('실제 템플릿'));
  assert.equal(textbox.left, 90);
  assert.equal(textbox.top, 80);
  assert.equal(textbox.width, 500);
  assert.equal(textbox.height, 120);
  assert.equal(textbox.font.size, 24);
  const table = powerpointSnapshot.document.slides[0].shapes.find((shape) => shape.table);
  assert.deepEqual(table.table.values, [
    ['Metric', 'Actual', 'Plan', 'Status'],
    ['Users', '42', '45', 'Track'],
    ['Calls', '18', '20', 'Track'],
    ['Errors', '0', '0', 'Pass'],
  ]);
  const chart = powerpointSnapshot.document.slides[0].shapes.find((shape) => shape.chart);
  assert.equal(chart.chart.title, 'Metrics');
  assert.equal(chart.chart.seriesCount, 2);
  assert.equal(chart.chart.series[0].trendlineCount, 1);
  assert.equal(chart.chart.series[0].hasErrorBars, true);
  assert.equal(chart.chart.series[1].chartType, 4);
  assert.equal(chart.chart.series[1].axisGroup, 2);
  const oneSeriesChart = powerpointSnapshot.document.slides[0].shapes.find((shape) => shape.chart?.title === 'One series');
  assert.equal(oneSeriesChart.chart.seriesCount, 1);
  assert.equal(powerpointSnapshot.document.slides[0].comments.length, 1);
  assert.equal(powerpointSnapshot.document.slides[0].animations.length, 1);
  assert.notEqual(powerpointSnapshot.document.slides[0].transition.effect, 0);
  assert.ok(powerpointSnapshot.document.designCount > 0);
  assert.match(powerpointSnapshot.document.slides[0].shapes.find((shape) => shape.text?.includes('Card')).text, /Bullet item/);
  value(await executeOfficeTool({
    action: 'batch',
    session: powerpoint.session,
    operations: [{
      op: 'add_provenance',
      slide: 1,
      shape: 1,
      source: { document: 'source-model.xlsx', target: '/sheet[Inputs]/cell[C3]', label: 'Revenue' },
    }],
  }, { cwd }));
  const sourcedPowerPoint = value(await executeOfficeTool({
    action: 'snapshot',
    session: powerpoint.session,
  }, { cwd }));
  assert.match(sourcedPowerPoint.document.slides[0].notes, /Source: source-model\.xlsx#\/sheet\[Inputs\]\/cell\[C3\]/);
  const powerpointIssues = value(await executeOfficeTool({ action: 'issues', session: powerpoint.session }, { cwd }));
  assert.ok(powerpointIssues.issues.some((issue) => issue.code === 'low_contrast'));
  const powerpointValidation = value(await executeOfficeTool({ action: 'validate', session: powerpoint.session }, { cwd }));
  assert.equal(powerpointValidation.ok, true, JSON.stringify(powerpointValidation));
  assert.equal(powerpointValidation.native.opened, true);
  value(await executeOfficeTool({ action: 'close', session: powerpoint.session }, { cwd }));
  const persistedPowerPoint = value(await executeOfficeTool({
    action: 'open',
    path: join(cwd, '발표.pptx'),
    output: join(cwd, '발표-재열기.pptx'),
    mode: 'background',
  }, { cwd }));
  const persistedSnapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: persistedPowerPoint.session,
  }, { cwd }));
  const persistedChart = persistedSnapshot.document.slides[0].shapes.find((shape) => shape.chart);
  assert.equal(persistedChart.chart.seriesCount, 2);
  assert.deepEqual(persistedChart.chart.series.map((series) => series.name), ['Actual', 'Plan']);
  const persistedOneSeriesChart = persistedSnapshot.document.slides[0].shapes.find((shape) => shape.chart?.title === 'One series');
  assert.equal(persistedOneSeriesChart.chart.seriesCount, 1);
  assert.deepEqual(persistedOneSeriesChart.chart.series.map((series) => series.name), ['Revenue']);
  value(await executeOfficeTool({ action: 'close', session: persistedPowerPoint.session }, { cwd }));
  const importedPowerPoint = value(await executeOfficeTool({
    action: 'create',
    path: join(cwd, '가져오기.pptx'),
    format: 'pptx',
    mode: 'background',
  }, { cwd }));
  const importedBatch = value(await executeOfficeTool({
    action: 'batch',
    session: importedPowerPoint.session,
    operations: [
      { op: 'import_slides', path: join(cwd, '발표.pptx'), after: 0, slides: [1] },
    ],
  }, { cwd }));
  assert.equal(importedBatch.results[0].count, 1);
  const importedSnapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: importedPowerPoint.session,
  }, { cwd }));
  assert.equal(importedSnapshot.document.slideCount, 1, JSON.stringify({ batch: importedBatch, snapshot: importedSnapshot }));
  assert.match(JSON.stringify(importedSnapshot.document.slides[0]), /실제 템플릿/);
  assert.notEqual(importedSnapshot.document.slides[0].transition.effect, 0);
  value(await executeOfficeTool({ action: 'close', session: importedPowerPoint.session }, { cwd }));
});

test('native Office creates and reopens template and macro-enabled file kinds', {
  skip: !enabled,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-kinds-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const cases = [
    {
      fileKind: 'docm',
      operations: [{ op: 'append_text', text: 'DOCM document' }],
      expected: /DOCM document/,
    },
    {
      fileKind: 'dotm',
      operations: [{ op: 'append_text', text: 'DOTM template' }],
      expected: /DOTM template/,
    },
    {
      fileKind: 'dotx',
      operations: [{ op: 'append_text', text: 'DOTX template' }],
      expected: /DOTX template/,
    },
    {
      fileKind: 'xltx',
      operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: 'XLTX template' }],
      expected: /XLTX template/,
    },
    {
      fileKind: 'xltm',
      operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: 'XLTM template' }],
      expected: /XLTM template/,
    },
    {
      fileKind: 'xlsm',
      operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: 'XLSM workbook' }],
      expected: /XLSM workbook/,
    },
    {
      fileKind: 'pptm',
      operations: [
        { op: 'add_slide' },
        { op: 'add_textbox', slide: 1, text: 'PPTM presentation' },
      ],
      expected: /PPTM presentation/,
    },
    {
      fileKind: 'potx',
      operations: [
        { op: 'add_slide' },
        { op: 'add_textbox', slide: 1, text: 'POTX template' },
      ],
      expected: /POTX template/,
    },
    {
      fileKind: 'potm',
      operations: [
        { op: 'add_slide' },
        { op: 'add_textbox', slide: 1, text: 'POTM template' },
      ],
      expected: /POTM template/,
    },
  ];
  for (const entry of cases) {
    const path = join(cwd, `native.${entry.fileKind}`);
    const created = value(await executeOfficeTool({
      action: 'create',
      path,
      format: entry.fileKind,
      mode: 'background',
    }, { cwd }));
    assert.equal(created.fileKind, entry.fileKind);
    value(await executeOfficeTool({
      action: 'batch',
      session: created.session,
      operations: entry.operations,
    }, { cwd }));
    const validation = value(await executeOfficeTool({ action: 'validate', session: created.session }, { cwd }));
    assert.equal(validation.ok, true, JSON.stringify(validation));
    assert.equal(validation.native.opened, true);
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    const reopened = value(await executeOfficeTool({
      action: 'open',
      path,
      output: join(cwd, `reopened.${entry.fileKind}`),
      mode: 'background',
    }, { cwd }));
    assert.equal(reopened.fileKind, entry.fileKind);
    assert.match(JSON.stringify(reopened.document), entry.expected);
    value(await executeOfficeTool({ action: 'close', session: reopened.session }, { cwd }));
  }
});

test('attach selects the exact workbook across multiple Excel instances', {
  skip: !enabled,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-multi-instance-'));
  const firstPath = join(cwd, 'first.xlsx');
  const secondPath = join(cwd, 'second.xlsx');
  let firstExternal;
  let secondExternal;
  t.after(async () => {
    resetOfficeSessionsForTest();
    await stopExternalExcel(firstExternal).catch(() => {});
    await stopExternalExcel(secondExternal).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  });

  for (const path of [firstPath, secondPath]) {
    const created = value(await executeOfficeTool({
      action: 'create',
      path,
      format: 'xlsx',
    }, { cwd }));
    assert.equal(created.mode, 'background');
    assert.equal(created.visible, false);
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  }

  firstExternal = await startExternalExcel(firstPath);
  secondExternal = await startExternalExcel(secondPath);

  const automatic = value(await executeOfficeTool({
    action: 'open',
    path: secondPath,
    output: join(cwd, 'auto-background.xlsx'),
  }, { cwd }));
  assert.equal(automatic.mode, 'background');
  assert.equal(automatic.ownership, 'owned');
  assert.equal(automatic.visible, false);
  assert.equal(automatic.backgroundIsolation?.strict, true, JSON.stringify(automatic));
  assert.equal(automatic.backgroundIsolation?.isolatedProcess, true, JSON.stringify(automatic));
  assert.equal(automatic.backgroundIsolation?.visibleOwnedWindows, 0, JSON.stringify(automatic));
  assert.equal(automatic.backgroundIsolation?.ownedForeground, false, JSON.stringify(automatic));
  assert.notEqual(automatic.windowHwnd, secondExternal.hWnd);
  value(await executeOfficeTool({ action: 'close', session: automatic.session }, { cwd }));

  const attachedSecond = value(await executeOfficeTool({
    action: 'attach',
    path: secondPath,
  }, { cwd }));
  assert.equal(attachedSecond.ownership, 'attached');
  assert.equal(attachedSecond.windowHwnd, secondExternal.hWnd);
  assert.equal(attachedSecond.appPid, secondExternal.processId);

  value(await executeOfficeTool({
    action: 'batch',
    session: attachedSecond.session,
    operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '두 번째 정확한 창' }],
    save: true,
  }, { cwd }));
  const secondCell = value(await executeOfficeTool({
    action: 'get',
    session: attachedSecond.session,
    target: '/sheet[Sheet1]/cell[A1]',
  }, { cwd }));
  assert.equal(secondCell.element.value, '두 번째 정확한 창');
  value(await executeOfficeTool({ action: 'close', session: attachedSecond.session }, { cwd }));
  assert.equal(secondExternal.child.exitCode, null, 'closing an attached session must not close the user-owned Excel instance');

  const attachedFirst = value(await executeOfficeTool({
    action: 'attach',
    path: firstPath,
  }, { cwd }));
  assert.equal(attachedFirst.windowHwnd, firstExternal.hWnd);
  const firstSnapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: attachedFirst.session,
  }, { cwd }));
  assert.equal(firstSnapshot.document.sheets[0].cells.length, 0);
  value(await executeOfficeTool({ action: 'close', session: attachedFirst.session }, { cwd }));

  await stopExternalExcel(firstExternal);
  await stopExternalExcel(secondExternal);
  firstExternal = null;
  secondExternal = null;
});

test('both backends satisfy one snapshot contract and agree on the same document', {
  skip: !enabled,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-contract-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });

  const cases = [
    {
      format: 'docx',
      file: 'contract.docx',
      operations: [
        { op: 'append_text', text: 'Document title', style: 'Title' },
        { op: 'append_text', text: 'Heading one', style: 'Heading1' },
        { op: 'append_text', text: 'Body paragraph.' },
        { op: 'add_table', values: [['A', 'B'], ['1', '2']] },
      ],
    },
    {
      format: 'xlsx',
      file: 'contract.xlsx',
      operations: [
        { op: 'set_range', range: 'A1:B3', values: [['Region', 'Revenue'], ['Korea', 120], ['Japan', 95]] },
      ],
    },
    {
      format: 'pptx',
      file: 'contract.pptx',
      operations: [
        { op: 'add_slide' },
        { op: 'set_slide_background', slide: 1, color: '16191D' },
        { op: 'add_textbox', slide: 1, text: 'Title', properties: { left: 40, top: 40, width: 400, height: 60, fontSize: 40 } },
        { op: 'set_notes', slide: 1, text: 'Speaker note.' },
        { op: 'add_slide' },
        { op: 'set_slide_background', slide: 2, color: 'F5F2EC' },
        { op: 'add_table', slide: 2, values: [['A', 'B'], ['1', '2']], left: 40, top: 40, width: 300, height: 90 },
      ],
    },
  ];

  for (const testCase of cases) {
    const target = join(cwd, testCase.file);
    const authored = value(await executeOfficeTool({
      action: 'create',
      path: target,
      mode: 'portable',
      operations: testCase.operations,
    }, { cwd }));
    value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));

    const readings = {};
    for (const mode of ['portable', 'background']) {
      const opened = value(await executeOfficeTool({ action: 'open', path: target, mode }, { cwd }));
      const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
      const violations = officeSnapshotContractViolations(snapshot.document, {
        format: testCase.format,
        paged: true,
      });
      assert.deepEqual(
        violations,
        [],
        `${opened.backend} ${testCase.format} breaks the backend contract:\n${describeOfficeSnapshotViolations(violations)}`,
      );
      readings[mode] = snapshot.document;
      value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
    }

    // One file, two readers. Representation may differ, but the facts a caller
    // acts on must not: silent disagreement here is what blinded design review.
    const portable = readings.portable;
    const com = readings.background;
    if (testCase.format === 'docx') {
      assert.equal(com.tableCount, portable.tableCount, 'table counts must agree');
      // Word numbers table-cell paragraphs alongside body paragraphs while the
      // portable model reports cell text under tables, so /body/p[N] addresses
      // different content per backend. Body text itself must still agree.
      const bodyText = (document) => (document.paragraphs || [])
        .filter((entry) => entry.inTable !== true)
        .map((entry) => entry.text)
        .filter(Boolean);
      assert.deepEqual(bodyText(com), bodyText(portable), 'body paragraph text must agree');
      // Word answers under the UI language; a localized style name handed to the
      // portable writer produces an unknown styleId and silently drops styling.
      const bodyStyles = (document) => (document.paragraphs || [])
        .filter((entry) => entry.inTable !== true && String(entry.text || '').trim())
        .map((entry) => entry.style);
      assert.deepEqual(bodyStyles(com), bodyStyles(portable), 'paragraph styles must agree');
      assert.deepEqual(
        (com.tables || []).map((entry) => entry.style),
        (portable.tables || []).map((entry) => entry.style),
        'table styles must agree',
      );
    }
    if (testCase.format === 'xlsx') {
      const cellValues = (document) => (document.sheets || [])
        .flatMap((sheet) => (sheet.cells || []).map((cell) => `${cell.path}=${cell.value}`));
      assert.deepEqual(cellValues(com), cellValues(portable), 'cell values must agree');
    }
    if (testCase.format === 'pptx') {
      assert.equal(com.slideCount, portable.slideCount, 'slide counts must agree');
      const indexes = (document) => (document.slides || []).map((slide) => slide.index);
      assert.deepEqual(indexes(com), indexes(portable), 'slide order must agree');
      const notes = (document) => (document.slides || []).map((slide) => String(slide.notes || '').trim());
      assert.deepEqual(notes(com), notes(portable), 'speaker notes must agree');
      const backgrounds = (document) => (document.slides || [])
        .map((slide) => String(slide.background?.color || '').toUpperCase());
      assert.deepEqual(backgrounds(com), backgrounds(portable), 'slide backgrounds must agree');
      const shapeCounts = (document) => (document.slides || []).map((slide) => (slide.shapes || []).length);
      assert.deepEqual(shapeCounts(com), shapeCounts(portable), 'shape counts must agree');
    }
  }
});
