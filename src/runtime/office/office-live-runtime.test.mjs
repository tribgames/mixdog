import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import JSZip from 'jszip';

import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { PNG_PIXEL, value } from './office-test-support.mjs';
import { describeOfficeSnapshotViolations, officeSnapshotContractViolations } from './core/snapshot-contract.mjs';

const enabled = process.platform === 'win32' && process.env.MIXDOG_TEST_LIVE_OFFICE === '1';

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
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out opening external Excel workbook: ${path}`));
      try {
        child.kill();
      } catch {}
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

test('[excel] persistent Excel sessions own one document and preserve UTF-8 text', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const backgroundPath = join(cwd, 'background-한글.xlsx');
  const visiblePath = join(cwd, 'visible-한글.xlsx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });

  const background = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: backgroundPath,
        format: 'xlsx',
        mode: 'background',
      },
      { cwd }
    )
  );
  assert.equal(background.mode, 'background');
  assert.equal(background.ownership, 'owned');
  assert.notEqual(background.visible, true, 'a background session opens no window');

  const backgroundBatch = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: background.session,
        operations: [
          { op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '하이하이하이' },
          { op: 'set_cell', sheet: 'Sheet1', cell: 'B1', value: 21 },
          { op: 'set_range', sheet: 'Sheet1', range: 'C1:D1', values: [[true, 22.5]] },
          { op: 'append_row', sheet: 'Sheet1', values: ['추가 행', 23] },
          { op: 'add_validation', sheet: 'Sheet1', range: 'E1:E3', formula1: 'Yes,No', inputMessage: 'Choose a value' },
          { op: 'freeze_panes', sheet: 'Sheet1', row: 2 },
          { op: 'set_sheet_view', sheet: 'Sheet1', showGridlines: false, zoom: 95 },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(backgroundBatch.backgroundIsolation?.observedVisibleWindows, [], JSON.stringify(backgroundBatch));
  assert.equal(backgroundBatch.backgroundIsolation?.hiddenWindows, 0, JSON.stringify(backgroundBatch));
  assert.equal(backgroundBatch.backgroundIsolation?.focusRestorations, 0, JSON.stringify(backgroundBatch));
  // The contract is that background Office never takes the foreground — not that the desktop's
  // foreground window is frozen. Any unrelated window activating during the call would break the
  // second reading without saying anything about Office.
  assert.equal(backgroundBatch.backgroundIsolation?.ownedForeground, false, JSON.stringify(backgroundBatch));
  const backgroundCell = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: background.session,
        target: '/sheet[Sheet1]/cell[A1]',
      },
      { cwd }
    )
  );
  assert.equal(backgroundCell.element.value, '하이하이하이');
  const backgroundNumber = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: background.session,
        target: '/sheet[Sheet1]/cell[B1]',
      },
      { cwd }
    )
  );
  assert.equal(backgroundNumber.element.value, 21);
  const backgroundRangeNumber = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: background.session,
        target: '/sheet[Sheet1]/cell[D1]',
      },
      { cwd }
    )
  );
  assert.equal(backgroundRangeNumber.element.value, 22.5);
  const appendedNumber = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: background.session,
        target: '/sheet[Sheet1]/cell[B2]',
      },
      { cwd }
    )
  );
  assert.equal(appendedNumber.element.value, 23);
  const validatedWorkbook = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: background.session,
      },
      { cwd }
    )
  );
  assert.equal(validatedWorkbook.document.sheets[0].validationCount, 1);
  assert.deepEqual(validatedWorkbook.document.sheets[0].validations[0].ranges, ['E1:E3']);
  // Named as the portable reader names it, not by Excel's enumeration number.
  assert.equal(validatedWorkbook.document.sheets[0].validations[0].type, 'list');
  assert.equal(validatedWorkbook.document.sheets[0].validations[0].formula1, '"Yes,No"');
  value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
  const shiftedFormula = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: background.session,
        target: '/sheet[Sheet1]/cell[G3]',
      },
      { cwd }
    )
  );
  assert.match(shiftedFormula.element.formula, /B3/);
  value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
  const formulaIssues = value(await executeOfficeTool({ action: 'issues', session: background.session }, { cwd }));
  assert.ok(
    formulaIssues.issues.some((issue) => issue.code === 'formula_error' && issue.path === '/sheet[Sheet1]/cell[A1501]')
  );
  const financialAudit = value(
    await executeOfficeTool(
      {
        action: 'issues',
        session: background.session,
        auditProfile: 'financial-model',
      },
      { cwd }
    )
  );
  assert.equal(financialAudit.auditCoverage.mode, 'full');
  assert.equal(financialAudit.auditCoverage.complete, true);
  assert.equal(financialAudit.auditCoverage.scannedCells, financialAudit.auditCoverage.totalCells);
  assert.ok(
    financialAudit.issues.some(
      (issue) => issue.code === 'hardcode_missing_source' && issue.path === '/sheet[Sheet1]/cell[B1501]'
    )
  );
  assert.ok(
    financialAudit.issues.some((issue) => issue.code === 'failed_check' && issue.path === '/sheet[Checks]/cell[B1]')
  );
  const compactSnapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: background.session,
        sheet: 'Sheet1',
        limit: 10_000,
        maxChars: 100_000,
      },
      { cwd }
    )
  );
  assert.equal(compactSnapshot.document.sheets[0].representation, 'row-blocks');
  assert.equal((compactSnapshot.document.sheets[0].cells ?? []).length, 0, 'row blocks carry the cells');
  // Excel read the whole workbook whatever the limit, so a read over maxChars came back as a truncated text
  // preview; the retry now asks for pages, and the result is a document with a cursor.
  const narrow = value(
    await executeOfficeTool({ action: 'snapshot', session: background.session, maxChars: 4000 }, { cwd })
  );
  assert.equal(narrow.preview, undefined, JSON.stringify(narrow).slice(0, 400));
  assert.ok(Array.isArray(narrow.document.sheets), JSON.stringify(narrow.document).slice(0, 400));
  assert.ok(JSON.stringify(narrow).length <= 4000 + 2000, 'the page fits the size the caller asked for');
  assert.ok(compactSnapshot.document.sheets[0].rowBlocks.length > 0);
  assert.equal(compactSnapshot.document.pagination.scanned, 10_000);
  assert.equal(compactSnapshot.document.sheets[0].rowBlocks[0].values[0][0], '하이하이하이');
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: background.session,
        operations: [{ op: 'clear_cell', sheet: 'Sheet1', cell: 'A1501' }],
      },
      { cwd }
    )
  );
  const backgroundValidation = value(
    await executeOfficeTool({ action: 'validate', session: background.session }, { cwd })
  );
  assert.equal(backgroundValidation.ok, true, JSON.stringify(backgroundValidation));
  assert.equal(backgroundValidation.native.opened, true);

  const failedBatch = await executeOfficeTool(
    {
      action: 'batch',
      session: background.session,
      operations: [
        { op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '복원되어야 함' },
        { op: 'unsupported_operation' },
      ],
    },
    { cwd }
  );
  assert.equal(failedBatch.isError, true);
  const afterFailure = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: background.session,
        target: '/sheet[Sheet1]/cell[A1]',
      },
      { cwd }
    )
  );
  assert.equal(afterFailure.element.value, '하이하이하이');

  value(await executeOfficeTool({ action: 'begin', session: background.session }, { cwd }));
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: background.session,
        operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '트랜잭션 임시값' }],
      },
      { cwd }
    )
  );
  const transactionDiff = value(
    await executeOfficeTool(
      {
        action: 'diff',
        session: background.session,
      },
      { cwd }
    )
  );
  assert.ok(transactionDiff.transaction.diff.summary.modified > 0);
  value(await executeOfficeTool({ action: 'rollback', session: background.session }, { cwd }));
  const afterRollback = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: background.session,
        target: '/sheet[Sheet1]/cell[A1]',
      },
      { cwd }
    )
  );
  assert.equal(afterRollback.element.value, '하이하이하이');
  value(await executeOfficeTool({ action: 'close', session: background.session }, { cwd }));

  const strictAttach = await executeOfficeTool(
    {
      action: 'attach',
      path: backgroundPath,
    },
    { cwd }
  );
  assert.equal(strictAttach.isError, true);
  assert.match(strictAttach.content[0].text, /not registered as open/i);

  const visible = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: visiblePath,
        format: 'xlsx',
        mode: 'visible',
      },
      { cwd }
    )
  );
  assert.equal(visible.mode, 'visible');
  assert.equal(visible.ownership, 'owned');
  assert.equal(visible.visible, true);
  assert.ok(visible.appPid > 0);
  assert.ok(visible.windowHwnd > 0);

  const reused = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: visiblePath,
        mode: 'visible',
      },
      { cwd }
    )
  );
  assert.equal(reused.session, visible.session);
  assert.equal(reused.reused, true);

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: visible.session,
        operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '한글-日本語-中文' }],
        save: true,
      },
      { cwd }
    )
  );
  const visibleCell = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: visible.session,
        target: '/sheet[Sheet1]/cell[A1]',
      },
      { cwd }
    )
  );
  assert.equal(visibleCell.element.value, '한글-日本語-中文');
  const visibleSnapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: visible.session,
      },
      { cwd }
    )
  );
  assert.equal(visibleSnapshot.document.selection.available, true);
  assert.equal(visibleSnapshot.document.selection.sheet, 'Sheet1');
  assert.match(visibleSnapshot.document.selection.target, /^\/sheet\[Sheet1\]\/range\[/);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: visible.session,
        operations: [
          {
            op: 'add_provenance',
            sheet: 'Sheet1',
            cell: 'A1',
            source: { document: 'source-model.xlsx', target: '/sheet[Inputs]/cell[C3]', label: 'Revenue' },
          },
        ],
      },
      { cwd }
    )
  );
  const sourcedWorkbook = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: visible.session,
      },
      { cwd }
    )
  );
  assert.match(
    sourcedWorkbook.document.sheets[0].notes[0].text,
    /Source: source-model\.xlsx#\/sheet\[Inputs\]\/cell\[C3\]/
  );

  value(
    await executeOfficeTool(
      {
        action: 'close',
        session: visible.session,
        save: true,
      },
      { cwd }
    )
  );
  assert.equal(await waitForProcessExit(visible.appPid), true);
});

test('[word] persistent Word sessions create, save, and read Unicode content', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-formats-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });

  const word = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, '문서.docx'),
        format: 'docx',
        mode: 'visible',
      },
      { cwd }
    )
  );
  assert.ok(word.appPid > 0);
  assert.ok(word.windowHwnd > 0);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: word.session,
        operations: [
          { op: 'append_text', text: '한글-日本語-中文 {{ name }}' },
          { op: 'set_header_footer', section: 1, kind: 'header', text: 'Owner {{owner}}' },
          { op: 'fill_template', tokens: { name: '재영', owner: 'Mixdog' }, strict: true },
          {
            op: 'add_table',
            values: [
              ['Metric', 'Value'],
              ['Revenue', '120'],
              ['Summary', 'Ready'],
            ],
            properties: { borders: true, columnWidths: [110, 110], alignment: 'center' },
          },
          { op: 'set_table_cell_style', table: 1, row: 1, col: 1, properties: { fillColor: 'D9EAF7', bold: true } },
          { op: 'merge_table_cells', table: 1, row: 3, col: 1, colSpan: 2 },
          {
            op: 'set_paragraph_format',
            paragraph: 1,
            properties: {
              spacingAfter: 6,
              keepWithNext: true,
              tabStops: [{ position: 240, alignment: 'right', leader: 'dot' }],
            },
          },
        ],
      },
      { cwd }
    )
  );
  const wordSnapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: word.session,
      },
      { cwd }
    )
  );
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
  const commentBatch = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: word.session,
        operations: [
          { op: 'add_comment', find: '한글-日本語-中文', text: '검토 의견' },
          { op: 'add_comment_reply', comment: 1, text: '답글 확인' },
          { op: 'set_comment_resolved', comment: 1, resolved: true },
        ],
      },
      { cwd }
    )
  );
  assert.equal(commentBatch.results[0].anchor, 'phrase', 'the result says the comment spans the phrase');
  const commented = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: word.session,
      },
      { cwd }
    )
  );
  assert.equal(commented.document.commentCount, 1);
  assert.equal(commented.document.comments[0].text, '검토 의견');
  assert.equal(commented.document.comments[0].anchoredText, '한글-日本語-中文');
  assert.equal(commented.document.comments[0].replies.length, 1);
  assert.equal(commented.document.comments[0].replies[0].text, '답글 확인');
  assert.equal(commented.document.comments[0].resolved, true);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: word.session,
        operations: [{ op: 'delete_comment', comment: 1 }],
      },
      { cwd }
    )
  );
  const withoutComment = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: word.session,
      },
      { cwd }
    )
  );
  assert.equal(withoutComment.document.commentCount, 0);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: word.session,
        operations: [
          {
            op: 'add_provenance',
            paragraph: 1,
            source: { document: 'source-model.xlsx', target: '/sheet[Inputs]/cell[C3]', label: 'Revenue' },
          },
        ],
      },
      { cwd }
    )
  );
  const sourcedWord = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: word.session,
      },
      { cwd }
    )
  );
  assert.match(sourcedWord.document.comments[0].text, /Source: source-model\.xlsx#\/sheet\[Inputs\]\/cell\[C3\]/);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: word.session,
        operations: [
          { op: 'track_changes', enabled: true },
          { op: 'append_text', text: '추적 변경' },
          { op: 'track_changes', enabled: false },
        ],
      },
      { cwd }
    )
  );
  const revised = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: word.session,
      },
      { cwd }
    )
  );
  assert.ok(revised.document.revisionCount > 0);
  assert.ok(revised.document.revisions.some((revision) => revision.text.includes('추적 변경')));
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: word.session,
        operations: [{ op: 'resolve_revision', revision: 1, resolution: 'accept' }],
      },
      { cwd }
    )
  );
  const afterResolution = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: word.session,
      },
      { cwd }
    )
  );
  assert.ok(afterResolution.document.revisionCount < revised.document.revisionCount);
  const professional = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
  assert.deepEqual(
    professional.results.map((result) => result.op),
    ['add_bookmark', 'add_hyperlink', 'set_list', 'insert_break', 'add_page_numbers', 'insert_toc']
  );
  value(await executeOfficeTool({ action: 'close', session: word.session }, { cwd }));
});

test('[powerpoint] persistent PowerPoint sessions create, save, and read Unicode content', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-powerpoint-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });

  const powerpoint = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, '발표.pptx'),
        format: 'pptx',
        mode: 'background',
      },
      { cwd }
    )
  );
  assert.equal(powerpoint.backgroundIsolation?.strict, true, JSON.stringify(powerpoint));
  assert.equal(powerpoint.backgroundIsolation?.isolatedProcess, true, JSON.stringify(powerpoint));
  assert.deepEqual(powerpoint.backgroundIsolation?.observedVisibleWindows, [], JSON.stringify(powerpoint));
  assert.equal(powerpoint.backgroundIsolation?.visibleOwnedWindows, 0, JSON.stringify(powerpoint));
  assert.equal(powerpoint.backgroundIsolation?.ownedForeground, false, JSON.stringify(powerpoint));
  const powerpointBatch = value(
    await executeOfficeTool(
      {
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
            values: [
              ['Metric', 'Value'],
              ['Users', 42],
            ],
            left: 240,
            top: 240,
            width: 280,
            height: 100,
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
      },
      { cwd }
    )
  );
  assert.equal(powerpointBatch.backgroundIsolation?.strict, true, JSON.stringify(powerpointBatch));
  assert.deepEqual(powerpointBatch.backgroundIsolation?.observedVisibleWindows, [], JSON.stringify(powerpointBatch));
  assert.equal(powerpointBatch.backgroundIsolation?.visibleOwnedWindows, 0, JSON.stringify(powerpointBatch));
  assert.equal(powerpointBatch.backgroundIsolation?.ownedForeground, false, JSON.stringify(powerpointBatch));
  assert.equal(powerpointBatch.backgroundIsolation?.hiddenWindows, 0, JSON.stringify(powerpointBatch));
  assert.equal(powerpointBatch.backgroundIsolation?.focusRestorations, 0, JSON.stringify(powerpointBatch));
  const powerpointSnapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: powerpoint.session,
      },
      { cwd }
    )
  );
  assert.match(JSON.stringify(powerpointSnapshot.document), /한글-日本語-中文/);
  assert.match(JSON.stringify(powerpointSnapshot.document), /실제 템플릿/);
  assert.equal(powerpointSnapshot.document.slides[0].notes, 'Owner Mixdog');
  // replace_text scoped to a slide reaches its speaker notes, as the portable writer's does.
  const scoped = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: powerpoint.session,
        operations: [{ op: 'replace_text', slide: 1, find: 'Owner', replace: 'Lead' }],
      },
      { cwd }
    )
  );
  assert.equal(scoped.results[0].count, 1);
  // A batch is atomic: a background deck has no window for PowerPoint's Undo, so the edit before a failed
  // operation stayed in the deck. It now reloads from the copy the batch started from.
  const failed = await executeOfficeTool(
    {
      action: 'batch',
      session: powerpoint.session,
      operations: [
        { op: 'replace_text', slide: 1, find: '실제 템플릿', replace: '되돌려질 문구' },
        { op: 'set_text', slide: 1, shape: 99, text: 'missing' },
      ],
    },
    { cwd }
  );
  assert.equal(failed.isError, true);
  const afterFailure = value(await executeOfficeTool({ action: 'snapshot', session: powerpoint.session }, { cwd }));
  assert.doesNotMatch(JSON.stringify(afterFailure.document), /되돌려질 문구/);
  assert.match(JSON.stringify(afterFailure.document), /실제 템플릿/);
  assert.equal(afterFailure.document.slides[0].notes, 'Lead Mixdog');
  assert.ok(powerpointSnapshot.document.layoutCount > 0);
  const textbox = powerpointSnapshot.document.slides[0].shapes.find((shape) => shape.text?.includes('실제 템플릿'));
  assert.equal(textbox.left, 90);
  assert.equal(textbox.top, 80);
  assert.equal(textbox.width, 500);
  assert.equal(textbox.height, 120);
  assert.equal(textbox.font.size, 24);
  const table = powerpointSnapshot.document.slides[0].shapes.find((shape) => shape.table);
  // The table grew from two columns to four inside the width it was given, as the portable writer sets it.
  assert.equal(Math.round(table.width), 280);
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
  // Named as the portable reader and set_chart_series name it, not by Excel's enumeration number.
  assert.equal(chart.chart.series[1].chartType, 'line');
  assert.equal(chart.chart.series[1].axisGroup, 2);
  const oneSeriesChart = powerpointSnapshot.document.slides[0].shapes.find(
    (shape) => shape.chart?.title === 'One series'
  );
  assert.equal(oneSeriesChart.chart.seriesCount, 1);
  assert.equal(powerpointSnapshot.document.slides[0].comments.length, 1);
  assert.equal(powerpointSnapshot.document.slides[0].animations.length, 1);
  assert.notEqual(powerpointSnapshot.document.slides[0].transition.effect, 0);
  assert.ok(powerpointSnapshot.document.designCount > 0);
  assert.match(
    powerpointSnapshot.document.slides[0].shapes.find((shape) => shape.text?.includes('Card')).text,
    /Bullet item/
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: powerpoint.session,
        operations: [
          {
            op: 'add_provenance',
            slide: 1,
            shape: 1,
            source: { document: 'source-model.xlsx', target: '/sheet[Inputs]/cell[C3]', label: 'Revenue' },
          },
        ],
      },
      { cwd }
    )
  );
  const sourcedPowerPoint = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: powerpoint.session,
      },
      { cwd }
    )
  );
  assert.match(sourcedPowerPoint.document.slides[0].notes, /Source: source-model\.xlsx#\/sheet\[Inputs\]\/cell\[C3\]/);
  const powerpointIssues = value(await executeOfficeTool({ action: 'issues', session: powerpoint.session }, { cwd }));
  assert.ok(powerpointIssues.issues.some((issue) => issue.code === 'low_contrast'));
  const powerpointValidation = value(
    await executeOfficeTool({ action: 'validate', session: powerpoint.session }, { cwd })
  );
  assert.equal(powerpointValidation.ok, true, JSON.stringify(powerpointValidation));
  assert.equal(powerpointValidation.native.opened, true);
  value(await executeOfficeTool({ action: 'close', session: powerpoint.session }, { cwd }));
  const persistedPowerPoint = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: join(cwd, '발표.pptx'),
        output: join(cwd, '발표-재열기.pptx'),
        mode: 'background',
      },
      { cwd }
    )
  );
  const persistedSnapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: persistedPowerPoint.session,
      },
      { cwd }
    )
  );
  const persistedChart = persistedSnapshot.document.slides[0].shapes.find((shape) => shape.chart);
  assert.equal(persistedChart.chart.seriesCount, 2);
  assert.deepEqual(
    persistedChart.chart.series.map((series) => series.name),
    ['Actual', 'Plan']
  );
  const persistedOneSeriesChart = persistedSnapshot.document.slides[0].shapes.find(
    (shape) => shape.chart?.title === 'One series'
  );
  assert.equal(persistedOneSeriesChart.chart.seriesCount, 1);
  assert.deepEqual(
    persistedOneSeriesChart.chart.series.map((series) => series.name),
    ['Revenue']
  );
  value(await executeOfficeTool({ action: 'close', session: persistedPowerPoint.session }, { cwd }));
  const importedPowerPoint = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, '가져오기.pptx'),
        format: 'pptx',
        mode: 'background',
      },
      { cwd }
    )
  );
  const importedBatch = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: importedPowerPoint.session,
        operations: [{ op: 'import_slides', path: join(cwd, '발표.pptx'), after: 0, slides: [1] }],
      },
      { cwd }
    )
  );
  assert.equal(importedBatch.results[0].count, 1);
  const importedSnapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: importedPowerPoint.session,
      },
      { cwd }
    )
  );
  assert.equal(
    importedSnapshot.document.slideCount,
    1,
    JSON.stringify({ batch: importedBatch, snapshot: importedSnapshot })
  );
  assert.match(JSON.stringify(importedSnapshot.document.slides[0]), /실제 템플릿/);
  assert.notEqual(importedSnapshot.document.slides[0].transition.effect, 0);
  value(await executeOfficeTool({ action: 'close', session: importedPowerPoint.session }, { cwd }));
});

// PowerPoint's InsertFromFile gives an imported slide the deck's own design and dropped the background the slide had:
// the template's dark quote page arrived on the deck's light paper, its white words unreadable. The page keeps its
// template background, as the portable import keeps it.
test('[powerpoint] a template page keeps its own background on import', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      { action: 'create', path: join(cwd, 'quote.pptx'), format: 'pptx', mode: 'background' },
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
            op: 'use_template_page',
            path: fileURLToPath(new URL('./design/library/templates/mixdog-executive.pptx', import.meta.url)),
            slide: 14,
            after: 0,
            title: '설정이 잘못됐다고 바로 알려 주니 가맹점이 먼저 고쳤습니다.',
          },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const [page] = snapshot.document.slides;
  assert.equal(String(page.background?.color || '').toUpperCase(), '254E70', JSON.stringify(page.background));
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// set_chart_data read its numbers and title and set nothing else under PowerPoint, where the portable writer takes the
// fields beside them: a refresh asking for value labels and a zero base line came back bare.
test('[powerpoint] new chart numbers take the label and base-line fields beside them', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      { action: 'create', path: join(cwd, 'labels.pptx'), format: 'pptx', mode: 'background' },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_chart',
            slide: 1,
            chartType: 'column',
            categories: ['6월', '7월', '8월'],
            series: [{ name: '가동률 (%)', values: [96.2, 97.1, 98.4] }],
            left: 60,
            top: 80,
            width: 480,
            height: 280,
          },
          {
            op: 'set_chart_data',
            slide: 1,
            shape: 1,
            categories: ['7월', '8월', '9월'],
            series: [{ name: '가동률 (%)', values: [97.1, 98.4, 98.9] }],
            showValues: true,
            zeroBaseline: true,
            valueNumberFormat: '0.0',
          },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const { chart } = snapshot.document.slides[0].shapes.find((shape) => shape.chart);
  assert.equal(chart.series[0].hasDataLabels, true, JSON.stringify(chart.series[0]));
  assert.equal(chart.series[0].dataLabels.numberFormat, '0.0');
  assert.equal(chart.axes.find((axis) => axis.type === 'value').minimum, 0, JSON.stringify(chart.axes));
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A bar chart's reading order turns over on categoryOrder and a refresh that leaves it bottom-up says so, as the
// portable writer does: a template's monthly bars had read 9월 to 6월 from the top on both backends.
test('[word] a section laid out in columns reads back its columns and their spacing, as the portable reader reads them', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const operations = [
    { op: 'append_text', text: '물류운영 소식' },
    { op: 'insert_break', kind: 'section_continuous' },
    { op: 'set_page', properties: { columns: 2, columnSpacing: 18 } },
    { op: 'append_text', text: '두 단으로 흐르는 본문입니다.' },
    { op: 'insert_break', kind: 'section_continuous' },
    { op: 'set_page', properties: { columns: 1 } },
    { op: 'append_text', text: '문의: 운영기획팀' },
  ];
  const read = async (mode) => {
    const created = value(
      await executeOfficeTool(
        { action: 'create', path: join(cwd, `columns-${mode}.docx`), format: 'docx', mode, operations },
        { cwd }
      )
    );
    const sections = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document
      .sections;
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return sections.map((section) => [section.columns, section.columnSpacing]);
  };
  const word = await read('background');
  assert.deepEqual(word, [
    [undefined, undefined],
    [2, 18],
    [undefined, undefined],
  ]);
  assert.deepEqual(word, await read('portable'));
});

test('[word] placed list items, hung clauses, set_paragraph_format lists, and a contents range read as the portable file does', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const operations = [
    { op: 'append_text', text: '제1장 총칙', style: 'Heading 1' },
    { op: 'append_text', text: '제1조(목적)', style: 'Heading 2' },
    { op: 'append_text', text: '세부 기준', style: 'Heading 3' },
    { op: 'append_text', text: '①\t걸린 조항', properties: { indentLeft: 18, indentFirstLine: -18 } },
    {
      op: 'append_text',
      text: '상자 안의 항목',
      properties: { shading: 'FEF3C7', indentLeft: 12, listKind: 'bullet' },
    },
    { op: 'append_text', text: '목록이 될 문단' },
    { op: 'append_text', text: '목록에서 뺄 문단', properties: { listKind: 'bullet' } },
    { op: 'set_paragraph_format', paragraph: 6, properties: { listKind: 'number', indentLeft: 0 } },
    { op: 'set_paragraph_format', paragraph: 7, properties: { listKind: 'none' } },
    { op: 'append_text', text: '첫 단계', properties: { listKind: 'number' } },
    { op: 'append_text', text: '참고 상자', properties: { shading: 'EEF2F7' } },
    { op: 'append_text', text: '이어지는 단계', properties: { listKind: 'number', listContinue: true } },
    // Word's own naming: the upper level is the first one listed.
    { op: 'insert_toc', upperHeadingLevel: 1, lowerHeadingLevel: 2 },
  ];
  const read = async (mode) => {
    const path = join(cwd, `lists-${mode}.docx`);
    const created = value(
      await executeOfficeTool({ action: 'create', path, format: 'docx', mode, operations }, { cwd })
    );
    const levels = created.batch.results.find((result) => result.op === 'insert_toc').levels;
    const read = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document
      .paragraphs;
    const paragraphs = read
      .slice(3, 7)
      .map((paragraph) => [paragraph.text, paragraph.list?.kind || null, paragraph.style]);
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    const document = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
    // Word splits a paragraph's words into runs of its own, so a paragraph is found by its joined text.
    const paragraphXml = [...document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => match[0]);
    const textOf = (xml) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('');
    const indents = ['걸린 조항', '상자 안의 항목', '목록이 될 문단'].map((text) => {
      const paragraph = paragraphXml.find((xml) => textOf(xml).includes(text)) || '';
      const indent = /<w:ind\b([^>]*)\/>/.exec(paragraph)?.[1] || '';
      const read = (name) => Number(new RegExp(`\\bw:${name}="(\\d+)"`).exec(indent)?.[1] ?? Number.NaN);
      // Word leaves out a hang the item's list already gives it (18 pt on both backends' lists).
      let hanging = /<w:numPr>/.test(paragraph) ? 360 : 0;
      if (/\bw:hanging=/.test(indent)) hanging = read('hanging');
      return [read('left'), hanging];
    });
    // The step after the note carries the list on: the list of the step before it, not a new one counting from 1.
    const steps = ['첫 단계', '이어지는 단계'].map(
      (text) => /<w:numId w:val="(\d+)"/.exec(paragraphXml.find((xml) => textOf(xml).includes(text)) || '')?.[1]
    );
    assert.ok(steps[0] && steps[0] === steps[1], `${mode}: ${JSON.stringify(steps)}`);
    return { levels, paragraphs, indents };
  };
  const word = await read('background');
  assert.deepEqual(word.levels, '1-2');
  assert.deepEqual(word.indents, [
    [360, 360],
    [600, 360],
    [360, 360],
  ]);
  assert.deepEqual(word.paragraphs, [
    ['①\t걸린 조항', null, 'Normal'],
    ['상자 안의 항목', 'bullet', 'ListParagraph'],
    ['목록이 될 문단', 'number', 'Normal'],
    ['목록에서 뺄 문단', null, 'ListParagraph'],
  ]);
  assert.deepEqual(word, await read('portable'));
});

test('[word] a Korean list counts 1. 가. 1), any other 1. a. i., and lists join and open as the portable file does', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const item = (text, listLevel = 0, extra = {}) => ({
    op: 'append_text',
    text,
    properties: { listKind: 'number', listLevel, ...extra },
  });
  const operations = [
    item('계획을 세운다'),
    item('일정을 정한다', 1),
    item('담당을 정한다', 2),
    item('QA'),
    { op: 'append_text', text: 'Rollout', style: 'Heading 1' },
    item('Plan the rollout'),
    item('Pick the dates', 1),
    { op: 'append_text', text: '예외', style: 'Heading 1' },
    item('한국어 목록이지만 글로벌', 0, { listNumbering: 'global' }),
    item('둘째 단계', 1),
    { op: 'append_text', text: '이어 붙일 한국어 문단' },
    { op: 'append_text', text: '사이 문단' },
    { op: 'append_text', text: '목록이 될 한국어 문단' },
    { op: 'append_text', text: '목록에서 뺄 문단', properties: { listKind: 'bullet' } },
    { op: 'set_list', paragraph: 11, kind: 'number', level: 1 },
    { op: 'set_list', paragraph: 13, kind: 'number', level: 1 },
    { op: 'set_list', paragraph: 14, kind: 'none' },
  ];
  const read = async (mode) => {
    const path = join(cwd, `numbering-${mode}.docx`);
    const created = value(
      await executeOfficeTool({ action: 'create', path, format: 'docx', mode, operations }, { cwd })
    );
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    const zip = await JSZip.loadAsync(await readFile(path));
    const document = await zip.file('word/document.xml').async('string');
    const numbering = (await zip.file('word/numbering.xml')?.async('string')) || '';
    const abstractOf = new Map(
      [...numbering.matchAll(/<w:num\b[^>]*\bw:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="(\d+)"/g)].map((match) => [
        match[1],
        match[2],
      ])
    );
    const levelOf = (numId, level) => {
      const abstract =
        new RegExp(
          `<w:abstractNum\\b[^>]*\\bw:abstractNumId="${abstractOf.get(numId)}"[^>]*>[\\s\\S]*?</w:abstractNum>`
        ).exec(numbering)?.[0] || '';
      const lvl = new RegExp(`<w:lvl\\b[^>]*\\bw:ilvl="${level}"[^>]*>[\\s\\S]*?</w:lvl>`).exec(abstract)?.[0] || '';
      return `${/<w:numFmt w:val="([^"]+)"/.exec(lvl)?.[1]} ${/<w:lvlText w:val="([^"]*)"/.exec(lvl)?.[1]}`;
    };
    // Word splits a paragraph's words into runs; the list a paragraph joins is compared by the paragraphs it
    // shares a numId with, the ids themselves being each writer's own.
    const entries = [...document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
      .map((match) => ({
        text: [...match[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((run) => run[1]).join(''),
        numId: /<w:numId w:val="(\d+)"/.exec(match[0])?.[1],
        level: /<w:ilvl w:val="(\d+)"/.exec(match[0])?.[1] || '0',
      }))
      .filter((entry) => entry.text);
    const firstOf = new Map();
    for (const entry of entries) if (entry.numId && !firstOf.has(entry.numId)) firstOf.set(entry.numId, entry.text);
    return entries.map((entry) =>
      entry.numId && entry.numId !== '0'
        ? [entry.text, levelOf(entry.numId, entry.level), firstOf.get(entry.numId)]
        : [entry.text, null]
    );
  };
  const word = await read('background');
  assert.deepEqual(word, [
    ['계획을 세운다', 'decimal %1.', '계획을 세운다'],
    ['일정을 정한다', 'ganada %2.', '계획을 세운다'],
    ['담당을 정한다', 'decimal %3)', '계획을 세운다'],
    ['QA', 'decimal %1.', '계획을 세운다'],
    ['Rollout', null],
    ['Plan the rollout', 'decimal %1.', 'Plan the rollout'],
    ['Pick the dates', 'lowerLetter %2.', 'Plan the rollout'],
    ['예외', null],
    ['한국어 목록이지만 글로벌', 'decimal %1.', '한국어 목록이지만 글로벌'],
    ['둘째 단계', 'lowerLetter %2.', '한국어 목록이지만 글로벌'],
    ['이어 붙일 한국어 문단', 'lowerLetter %2.', '한국어 목록이지만 글로벌'],
    ['사이 문단', null],
    ['목록이 될 한국어 문단', 'ganada %2.', '목록이 될 한국어 문단'],
    ['목록에서 뺄 문단', null],
  ]);
  assert.deepEqual(word, await read('portable'));
});

test('[powerpoint] a bar chart reads top-down or bottom-up as categoryOrder asks, and says when it reads bottom-up', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      { action: 'create', path: join(cwd, 'bars.pptx'), format: 'pptx', mode: 'background' },
      { cwd }
    )
  );
  const batch = async (operations) =>
    value(await executeOfficeTool({ action: 'batch', session: created.session, operations }, { cwd })).results;
  const data = (extra = {}) => ({
    op: 'set_chart_data',
    slide: 1,
    shape: 1,
    categories: ['6월', '7월', '8월', '9월'],
    series: [{ name: '오류 (건)', values: [8200, 5900, 3100, 2700] }],
    ...extra,
  });
  await batch([
    { op: 'add_slide' },
    {
      op: 'add_chart',
      slide: 1,
      chartType: 'bar',
      categories: ['6월', '7월'],
      series: [{ name: '오류 (건)', values: [8200, 5900] }],
      left: 60,
      top: 80,
      width: 480,
      height: 280,
    },
  ]);
  // The runtime's own bar chart already reads top-down.
  assert.equal((await batch([data()]))[0].readingOrder, undefined);
  await batch([data({ categoryOrder: 'bottomUp' })]);
  const left = (await batch([data()]))[0];
  assert.equal(left.readingOrder, 'bottomUp', JSON.stringify(left));
  assert.match(left.note, /categoryOrder:'topDown'/);
  await batch([data({ categoryOrder: 'topDown' })]);
  assert.equal((await batch([data()]))[0].readingOrder, undefined);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A table grown by set_table_data: PowerPoint's Rows.Add copied the last row's cells but not their runs, and the
// added row read in black regular type under bold names and toned verdicts, where the portable writer repeats the row.
test('[powerpoint] a row set_table_data adds takes the type of the last row, as the portable writer repeats it', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
  timeout: 180_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const source = join(cwd, 'options.pptx');
  const script = `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const cell = (text, options = {}) => ({ text, options });
pres.addSlide().addTable([
  [cell('안', { bold: true }), cell('판정', { bold: true })],
  [cell('주간 전용', { bold: true, color: '1F2933' }), cell('보류', { color: '8A5A00' })],
  [cell('야간 전용', { bold: true, color: '1F2933' }), cell('채택', { color: '2E7D4F' })],
], { x: 0.6, y: 1.2, w: 8, colW: [4, 4], rowH: 0.6, fontSize: 16, color: '52606D' });
await pres.writeFile({ fileName: OUTPUT });
`;
  const authored = value(
    await executeOfficeTool({ action: 'author', path: source, script, mode: 'portable', render: false }, { cwd })
  );
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  const addedRow = async (mode) => {
    const opened = value(
      await executeOfficeTool({ action: 'open', path: source, mode, output: join(cwd, `${mode}.pptx`) }, { cwd })
    );
    value(
      await executeOfficeTool(
        {
          action: 'batch',
          session: opened.session,
          operations: [
            {
              op: 'set_table_data',
              slide: 1,
              shape: 1,
              values: [
                ['안', '판정'],
                ['주간 전용', '보류'],
                ['야간 전용', '채택'],
                ['외주 위탁', '보류'],
              ],
            },
          ],
        },
        { cwd }
      )
    );
    const slideXml = async () => {
      value(await executeOfficeTool({ action: 'save', session: opened.session }, { cwd }));
      return await (await JSZip.loadAsync(await readFile(join(cwd, `${mode}.pptx`))))
        .file('ppt/slides/slide1.xml')
        .async('string');
    };
    const lastRow = (slide) =>
      [...[...slide.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)][3][0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((cell) => {
        const run = /<a:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>)/.exec(cell[0])?.[0] || '';
        // The cell's own fill, not one of its borders' (each border line carries a fill of its own).
        const tcPr = (/<a:tcPr\b[^>]*\/>|<a:tcPr\b[^>]*>[\s\S]*?<\/a:tcPr>/.exec(cell[0])?.[0] || '').replace(
          /<a:ln\w*\b[^>]*?(?:\/>|>[\s\S]*?<\/a:ln\w*>)/g,
          ''
        );
        return {
          bold: /\bb="1"/.test(run),
          color: /<a:srgbClr val="([0-9A-F]{6})"/i.exec(run)?.[1]?.toUpperCase() || '',
          fill: /<a:solidFill>\s*<a:srgbClr val="([0-9A-F]{6})"/i.exec(tcPr)?.[1]?.toUpperCase() || '',
        };
      });
    const added = lastRow(await slideXml());
    // The added row copied the adopted verdict's green; set_table_cell_style retones it as the hold it is.
    value(
      await executeOfficeTool(
        {
          action: 'batch',
          session: opened.session,
          operations: [
            {
              op: 'set_table_cell_style',
              slide: 1,
              shape: 1,
              row: 4,
              col: 2,
              properties: { fillColor: 'F5ECD9', color: '8A5A00', bold: true },
            },
          ],
        },
        { cwd }
      )
    );
    const retoned = lastRow(await slideXml());
    value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
    return { added: added.map(({ bold, color }) => ({ bold, color })), retoned: retoned[1] };
  };
  const office = await addedRow('background');
  assert.deepEqual(office.added, [
    { bold: true, color: '1F2933' },
    { bold: false, color: '2E7D4F' },
  ]);
  assert.deepEqual(office.retoned, { bold: true, color: '8A5A00', fill: 'F5ECD9' });
  assert.deepEqual(await addedRow('portable'), office);
});

// fillColor: null takes a cell's fill away in all three formats, identically on both backends: Excel and Word had
// skipped null and kept the fill, the portable Word writer had no way to drop a shading at all.
test('[compat] fillColor null clears an Excel cell, a Word table cell and a slide table cell alike on both backends', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
  timeout: 300_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const cases = {
    xlsx: [
      { op: 'set_range', sheet: 'Sheet1', range: 'A1:B1', values: [['권역', 29000]] },
      { op: 'set_style', sheet: 'Sheet1', range: 'A1:B1', properties: { fillColor: 'FFF2CC' } },
      { op: 'set_style', sheet: 'Sheet1', cell: 'B1', properties: { fillColor: null } },
    ],
    docx: [
      {
        op: 'add_table',
        values: [
          ['권역', '9월'],
          ['수도권', '29,000'],
        ],
      },
      { op: 'set_table_cell_style', table: 1, row: 2, col: 1, properties: { fillColor: 'EEF2F7' } },
      { op: 'set_table_cell_style', table: 1, row: 2, col: 2, properties: { fillColor: 'EEF2F7' } },
      { op: 'set_table_cell_style', table: 1, row: 2, col: 2, properties: { fillColor: null } },
    ],
    pptx: [
      { op: 'add_slide' },
      {
        op: 'add_table',
        slide: 1,
        values: [
          ['권역', '9월'],
          ['수도권', '29,000'],
        ],
        left: 60,
        top: 80,
        width: 400,
        height: 100,
      },
      { op: 'set_table_cell_style', slide: 1, shape: 1, row: 2, col: 1, properties: { fillColor: 'F5ECD9' } },
      { op: 'set_table_cell_style', slide: 1, shape: 1, row: 2, col: 2, properties: { fillColor: 'F5ECD9' } },
      { op: 'set_table_cell_style', slide: 1, shape: 1, row: 2, col: 2, properties: { fillColor: null } },
    ],
  };
  const read = {
    xlsx: async (zip) => {
      const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
      const styles = await zip.file('xl/styles.xml').async('string');
      const fills = [
        ...(/<fills[^>]*>([\s\S]*?)<\/fills>/.exec(styles)?.[1] || '').matchAll(/<fill>[\s\S]*?<\/fill>/g),
      ].map((match) => /rgb="(?:FF)?([0-9A-F]{6})"/i.exec(match[0])?.[1] || 'none');
      const xfs = [...(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] || '').matchAll(/<xf\b[^>]*>/g)].map(
        (match) => Number(/fillId="(\d+)"/.exec(match[0])?.[1] || 0)
      );
      return ['A1', 'B1'].map(
        (ref) => fills[xfs[Number(new RegExp(`<c r="${ref}"[^>]*?\\bs="(\\d+)"`).exec(sheet)?.[1] || 0)]] || 'none'
      );
    },
    docx: async (zip) => {
      const row = [...(await zip.file('word/document.xml').async('string')).matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)][1][0];
      return [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((cell) =>
        (/<w:shd\b[^>]*w:fill="([^"]+)"/.exec(cell[0])?.[1] || 'none').toUpperCase()
      );
    },
    pptx: async (zip) => {
      const row = [
        ...(await zip.file('ppt/slides/slide1.xml').async('string')).matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g),
      ][1][0];
      return [...row.matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((cell) => {
        const own = (/<a:tcPr\b[^>]*\/>|<a:tcPr\b[^>]*>[\s\S]*?<\/a:tcPr>/.exec(cell[0])?.[0] || '').replace(
          /<a:ln\w*\b[^>]*?(?:\/>|>[\s\S]*?<\/a:ln\w*>)/g,
          ''
        );
        return /<a:noFill\/>/.test(own) ? 'noFill' : /<a:srgbClr val="([0-9A-F]{6})"/i.exec(own)?.[1] || 'none';
      });
    },
  };
  const expected = { xlsx: ['FFF2CC', 'none'], docx: ['EEF2F7', 'NONE'], pptx: ['F5ECD9', 'noFill'] };
  for (const [format, operations] of Object.entries(cases)) {
    for (const mode of ['background', 'portable']) {
      const path = join(cwd, `clear-${mode}.${format}`);
      const created = value(await executeOfficeTool({ action: 'create', path, format, mode, operations }, { cwd }));
      value(await executeOfficeTool({ action: 'save', session: created.session }, { cwd }));
      value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
      assert.deepEqual(
        await read[format](await JSZip.loadAsync(await readFile(path))),
        expected[format],
        `${format} ${mode}`
      );
    }
  }
});

// A layout without a footer placeholder refused HeadersFooters ("Invalid request") and failed the batch, where the
// portable writer places the footer itself; both now set the same quiet line along the foot.
test('[powerpoint] set_footer on a layout without a footer placeholder lands where the portable writer puts it', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
  timeout: 180_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const source = join(cwd, 'footerless.pptx');
  const script = `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
pres.defineSlideMaster({ title: 'PLAIN', objects: [] });
pres.addSlide({ masterName: 'PLAIN' }).addText('처리량', { x: 0.6, y: 0.6, w: 6, h: 0.6, fontSize: 24 });
await pres.writeFile({ fileName: OUTPUT });
`;
  const authored = value(
    await executeOfficeTool({ action: 'author', path: source, script, mode: 'portable', render: false }, { cwd })
  );
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  const footer = async (mode) => {
    const opened = value(
      await executeOfficeTool({ action: 'open', path: source, mode, output: join(cwd, `${mode}.pptx`) }, { cwd })
    );
    value(
      await executeOfficeTool(
        {
          action: 'batch',
          session: opened.session,
          operations: [{ op: 'set_footer', slide: 1, text: '운영팀 · 대외비' }],
        },
        { cwd }
      )
    );
    const shapes = value(await executeOfficeTool({ action: 'snapshot', session: opened.session, pages: [1] }, { cwd }))
      .document.slides[0].shapes;
    value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
    const line = shapes.find((shape) => String(shape.text || '').includes('대외비'));
    return line && [line.left, line.top, line.width, line.height].map(Math.round);
  };
  const powerpoint = await footer('background');
  assert.deepEqual(powerpoint, [58, 500, 720, 24]);
  assert.deepEqual(await footer('portable'), powerpoint);
});

// set_shape with a colour of null takes the fill or the outline away on both backends; PowerPoint had skipped null and
// kept the outline where the portable writer drew none.
test('[powerpoint] set_shape null takes the fill and the outline away, as the portable writer does', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
  timeout: 180_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const cleared = async (mode) => {
    const path = join(cwd, `clear-${mode}.pptx`);
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path,
          format: 'pptx',
          mode,
          operations: [
            { op: 'add_slide' },
            {
              op: 'add_shape',
              slide: 1,
              shapeType: 'rectangle',
              text: '요약',
              left: 100,
              top: 100,
              width: 300,
              height: 100,
              properties: { fillColor: 'E8F0FE', lineColor: '3367D6', lineWidth: 2 },
            },
            { op: 'set_shape', slide: 1, shape: 1, properties: { fillColor: null, lineColor: null } },
          ],
        },
        { cwd }
      )
    );
    value(await executeOfficeTool({ action: 'save', session: created.session }, { cwd }));
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    const slide = await (await JSZip.loadAsync(await readFile(path))).file('ppt/slides/slide1.xml').async('string');
    const spPr = /<p:spPr\b[\s\S]*?<\/p:spPr>/.exec(/<p:sp>[\s\S]*?<\/p:sp>/.exec(slide)[0])[0];
    let line = 'inherited';
    if (/<a:ln\b[\s\S]*?<a:noFill\/>/.test(spPr)) line = 'noFill';
    else if (/<a:ln\b/.test(spPr)) line = 'line';
    return {
      fill: /<p:spPr[^>]*>(?:(?!<a:ln\b)[\s\S])*?<a:(noFill|solidFill)/.exec(spPr)?.[1] || 'inherited',
      line,
    };
  };
  const powerpoint = await cleared('background');
  assert.deepEqual(powerpoint, { fill: 'noFill', line: 'noFill' });
  assert.deepEqual(await cleared('portable'), powerpoint);
});

test('[compat] native Office creates and reopens template and macro-enabled file kinds', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
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
      operations: [{ op: 'add_slide' }, { op: 'add_textbox', slide: 1, text: 'PPTM presentation' }],
      expected: /PPTM presentation/,
    },
    {
      fileKind: 'potx',
      operations: [{ op: 'add_slide' }, { op: 'add_textbox', slide: 1, text: 'POTX template' }],
      expected: /POTX template/,
    },
    {
      fileKind: 'potm',
      operations: [{ op: 'add_slide' }, { op: 'add_textbox', slide: 1, text: 'POTM template' }],
      expected: /POTM template/,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.fileKind, async (caseTest) => {
      caseTest.after(() => resetOfficeSessionsForTest());
      const path = join(cwd, `native.${entry.fileKind}`);
      const created = value(
        await executeOfficeTool(
          {
            action: 'create',
            path,
            format: entry.fileKind,
            mode: 'background',
          },
          { cwd }
        )
      );
      assert.equal(created.fileKind, entry.fileKind);
      value(
        await executeOfficeTool(
          {
            action: 'batch',
            session: created.session,
            operations: entry.operations,
          },
          { cwd }
        )
      );
      const validation = value(await executeOfficeTool({ action: 'validate', session: created.session }, { cwd }));
      assert.equal(validation.ok, true, JSON.stringify(validation));
      assert.equal(validation.native.opened, true);
      if (entry.fileKind.startsWith('xl')) {
        // validate still carries the reopened workbook's reading, which a caller checks persisted settings against;
        // only finalize, which drops it from its answer, no longer asks for it.
        assert.match(JSON.stringify(validation.native.snapshot?.sheets || []), entry.expected);
      }
      value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
      const reopened = value(
        await executeOfficeTool(
          {
            action: 'open',
            path,
            output: join(cwd, `reopened.${entry.fileKind}`),
            mode: 'background',
          },
          { cwd }
        )
      );
      assert.equal(reopened.fileKind, entry.fileKind);
      assert.match(JSON.stringify(reopened.document), entry.expected);
      value(await executeOfficeTool({ action: 'close', session: reopened.session }, { cwd }));
    });
  }
});

test('[attach] attach selects the exact workbook across multiple Excel instances', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
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
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path,
          format: 'xlsx',
        },
        { cwd }
      )
    );
    assert.equal(created.mode, 'background');
    assert.notEqual(created.visible, true);
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  }

  firstExternal = await startExternalExcel(firstPath);
  secondExternal = await startExternalExcel(secondPath);

  const automatic = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: secondPath,
        output: join(cwd, 'auto-background.xlsx'),
      },
      { cwd }
    )
  );
  assert.equal(automatic.mode, 'background');
  assert.equal(automatic.ownership, 'owned');
  assert.notEqual(automatic.visible, true);
  assert.equal(automatic.backgroundIsolation?.strict, true, JSON.stringify(automatic));
  assert.equal(automatic.backgroundIsolation?.isolatedProcess, true, JSON.stringify(automatic));
  assert.equal(automatic.backgroundIsolation?.visibleOwnedWindows, 0, JSON.stringify(automatic));
  assert.equal(automatic.backgroundIsolation?.ownedForeground, false, JSON.stringify(automatic));
  assert.notEqual(automatic.windowHwnd, secondExternal.hWnd);
  value(await executeOfficeTool({ action: 'close', session: automatic.session }, { cwd }));

  const attachedSecond = value(
    await executeOfficeTool(
      {
        action: 'attach',
        path: secondPath,
      },
      { cwd }
    )
  );
  assert.equal(attachedSecond.ownership, 'attached');
  assert.equal(attachedSecond.windowHwnd, secondExternal.hWnd);
  assert.equal(attachedSecond.appPid, secondExternal.processId);

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: attachedSecond.session,
        operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '두 번째 정확한 창' }],
        save: true,
      },
      { cwd }
    )
  );
  const secondCell = value(
    await executeOfficeTool(
      {
        action: 'get',
        session: attachedSecond.session,
        target: '/sheet[Sheet1]/cell[A1]',
      },
      { cwd }
    )
  );
  assert.equal(secondCell.element.value, '두 번째 정확한 창');
  value(await executeOfficeTool({ action: 'close', session: attachedSecond.session }, { cwd }));
  assert.equal(
    secondExternal.child.exitCode,
    null,
    'closing an attached session must not close the user-owned Excel instance'
  );

  const attachedFirst = value(
    await executeOfficeTool(
      {
        action: 'attach',
        path: firstPath,
      },
      { cwd }
    )
  );
  assert.equal(attachedFirst.windowHwnd, firstExternal.hWnd);
  const firstSnapshot = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: attachedFirst.session,
      },
      { cwd }
    )
  );
  assert.equal((firstSnapshot.document.sheets[0].cells ?? []).length, 0);
  value(await executeOfficeTool({ action: 'close', session: attachedFirst.session }, { cwd }));

  await stopExternalExcel(firstExternal);
  await stopExternalExcel(secondExternal);
  firstExternal = null;
  secondExternal = null;
});

// The default header used to land on the first page only: the HeadersFooters
// collection, handed through an if-expression, was unrolled into an array whose
// Item(1) is the first-page story. A picture went to the document start, the
// footer read "Page 1 of 1", and a sheet added later came first in the workbook.
test('[word] a background Word session writes the header, the picture, and the page number where the portable writer does', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-stories-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const picture = join(cwd, 'dot.png');
  await writeFile(
    picture,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  const path = join(cwd, 'stories.docx');
  const word = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'background',
        operations: [
          { op: 'append_text', text: '본문 첫 단락' },
          { op: 'append_text', text: '그림 앞 제목', style: 'Heading 1' },
          { op: 'add_image', path: picture, width: 24, height: 24, altText: '점' },
          { op: 'set_header_footer', kind: 'header', text: '머리글 · 운영기획팀' },
          { op: 'add_page_numbers' },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: word.session }, { cwd }));
  const stories = snapshot.document.sections[0].stories;
  assert.deepEqual(
    stories.filter((story) => story.location === 'header').map((story) => [story.kind, story.text]),
    [['primary', '머리글 · 운영기획팀']],
    JSON.stringify(stories)
  );
  value(await executeOfficeTool({ action: 'close', session: word.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(path));
  const document = await zip.file('word/document.xml').async('string');
  assert.match(document, /<w:headerReference w:type="default"/);
  assert.doesNotMatch(document, /<w:titlePg\/>/);
  // The picture follows the heading it was appended after, not the document start.
  assert.ok(document.indexOf('그림 앞 제목') < document.indexOf('<w:drawing>'), 'picture before its heading');
  assert.ok(document.indexOf('본문 첫 단락') < document.indexOf('<w:drawing>'), 'picture before the body');
  const footers = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^word\/footer\d*\.xml$/.test(name))
      .map((name) => zip.file(name).async('string'))
  );
  const numbered = footers.find((xml) => /PAGE/.test(xml));
  assert.ok(numbered, 'a footer carries the PAGE field');
  assert.doesNotMatch(numbered, /NUMPAGES|Page /);
});

test('[word] a background Word session reports and settles a redline like the portable reader', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-redline-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });

  const word = value(
    await executeOfficeTool(
      { action: 'create', path: join(cwd, 'redline.docx'), format: 'docx', mode: 'background' },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: word.session,
        operations: [
          { op: 'append_text', text: 'Alpha one.' },
          { op: 'append_text', text: 'Beta two.' },
          {
            op: 'add_table',
            values: [
              ['Item', 'Price'],
              ['Widget', 'old'],
            ],
          },
          { op: 'track_changes', enabled: true },
          { op: 'replace_text', find: 'one', replace: 'uno', author: 'Alice' },
          { op: 'replace_text', find: 'two', replace: 'dos', author: 'Bob' },
          { op: 'replace_text', find: 'old', replace: 'new', author: 'Bob' },
          { op: 'track_changes', enabled: false },
        ],
      },
      { cwd }
    )
  );
  const before = value(await executeOfficeTool({ action: 'snapshot', session: word.session }, { cwd })).document;
  // Paragraph text is the accepted view; the struck-through words sit beside it.
  const tracked = before.paragraphs.filter((paragraph) => paragraph.tracked);
  assert.deepEqual(
    tracked.map((paragraph) => [paragraph.text, paragraph.deletedText]),
    [
      ['Alpha uno.', 'one'],
      ['Beta dos.', 'two'],
      ['new', 'old'],
    ]
  );
  assert.ok(tracked.every((paragraph) => paragraph.revisions.length === 2));
  // A revision in a table names its cell, as the portable reader does, not the body-wide paragraph count Word keeps.
  assert.deepEqual(
    before.revisions.map((revision) => revision.at),
    [
      ...tracked.slice(0, 2).flatMap((paragraph) => [paragraph.path, paragraph.path]),
      '/body/tbl[1]/row[2]/cell[2]',
      '/body/tbl[1]/row[2]/cell[2]',
    ]
  );
  assert.deepEqual(before.revisionAuthors, [
    { author: 'Alice', insertions: 1, deletions: 1 },
    { author: 'Bob', insertions: 2, deletions: 2 },
  ]);
  const cells = before.tables[0].rows[1].cells;
  assert.deepEqual([cells[1].text, cells[1].deletedText, cells[1].tracked], ['new', 'old', true]);
  assert.equal(cells[0].tracked, undefined, 'a revision touching only the neighbouring cell does not flag this one');

  const nobody = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: word.session,
        operations: [{ op: 'resolve_revisions', resolution: 'accept', author: 'Nobody', allowNoChange: true }],
      },
      { cwd }
    )
  );
  assert.equal(nobody.results[0].changed, false);
  assert.match(nobody.results[0].note, /"Alice", "Bob"/);
  const bob = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: word.session,
        operations: [{ op: 'resolve_revisions', resolution: 'accept', author: 'Bob' }],
      },
      { cwd }
    )
  );
  assert.equal(bob.results[0].resolved, 4);
  const after = value(await executeOfficeTool({ action: 'snapshot', session: word.session }, { cwd })).document;
  assert.deepEqual(after.revisionAuthors, [{ author: 'Alice', insertions: 1, deletions: 1 }]);
  assert.deepEqual(
    after.paragraphs.filter((paragraph) => paragraph.tracked).map((paragraph) => paragraph.text),
    ['Alpha uno.']
  );
  assert.deepEqual(
    [after.tables[0].rows[1].cells[1].text, after.tables[0].rows[1].cells[1].tracked],
    ['new', undefined]
  );
  value(await executeOfficeTool({ action: 'close', session: word.session }, { cwd }));
});

test('[contract] both backends satisfy one snapshot contract and agree on the same document', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
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
        {
          op: 'add_table',
          values: [
            ['A', 'B'],
            ['1', '2'],
          ],
        },
      ],
    },
    {
      format: 'xlsx',
      file: 'contract.xlsx',
      operations: [
        {
          op: 'set_range',
          range: 'A1:B3',
          values: [
            ['Region', 'Revenue'],
            ['Korea', 120],
            ['Japan', 95],
          ],
        },
      ],
    },
    {
      format: 'pptx',
      file: 'contract.pptx',
      operations: [
        { op: 'add_slide' },
        { op: 'set_slide_background', slide: 1, color: '16191D' },
        {
          op: 'add_textbox',
          slide: 1,
          text: 'Title',
          properties: { left: 40, top: 40, width: 400, height: 60, fontSize: 40 },
        },
        { op: 'set_notes', slide: 1, text: 'Speaker note.' },
        { op: 'add_slide' },
        { op: 'set_slide_background', slide: 2, color: 'F5F2EC' },
        {
          op: 'add_table',
          slide: 2,
          values: [
            ['A', 'B'],
            ['1', '2'],
          ],
          left: 40,
          top: 40,
          width: 300,
          height: 90,
        },
      ],
    },
  ];

  for (const testCase of cases) {
    const target = join(cwd, testCase.file);
    const authored = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: target,
          mode: 'portable',
          operations: testCase.operations,
        },
        { cwd }
      )
    );
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
        `${opened.backend} ${testCase.format} breaks the backend contract:\n${describeOfficeSnapshotViolations(violations)}`
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
      const bodyText = (document) =>
        (document.paragraphs || [])
          .filter((entry) => entry.inTable !== true)
          .map((entry) => entry.text)
          .filter(Boolean);
      assert.deepEqual(bodyText(com), bodyText(portable), 'body paragraph text must agree');
      // Word answers under the UI language; a localized style name handed to the
      // portable writer produces an unknown styleId and silently drops styling.
      const bodyStyles = (document) =>
        (document.paragraphs || [])
          .filter((entry) => entry.inTable !== true && String(entry.text || '').trim())
          .map((entry) => entry.style);
      assert.deepEqual(bodyStyles(com), bodyStyles(portable), 'paragraph styles must agree');
      assert.deepEqual(
        (com.tables || []).map((entry) => entry.style),
        (portable.tables || []).map((entry) => entry.style),
        'table styles must agree'
      );
    }
    if (testCase.format === 'xlsx') {
      const cellValues = (document) =>
        (document.sheets || []).flatMap((sheet) => (sheet.cells || []).map((cell) => `${cell.path}=${cell.value}`));
      assert.deepEqual(cellValues(com), cellValues(portable), 'cell values must agree');
    }
    if (testCase.format === 'pptx') {
      assert.equal(com.slideCount, portable.slideCount, 'slide counts must agree');
      const indexes = (document) => (document.slides || []).map((slide) => slide.index);
      assert.deepEqual(indexes(com), indexes(portable), 'slide order must agree');
      const notes = (document) => (document.slides || []).map((slide) => String(slide.notes || '').trim());
      assert.deepEqual(notes(com), notes(portable), 'speaker notes must agree');
      const backgrounds = (document) =>
        (document.slides || []).map((slide) => String(slide.background?.color || '').toUpperCase());
      assert.deepEqual(backgrounds(com), backgrounds(portable), 'slide backgrounds must agree');
      const shapeCounts = (document) => (document.slides || []).map((slide) => (slide.shapes || []).length);
      assert.deepEqual(shapeCounts(com), shapeCounts(portable), 'shape counts must agree');
    }
  }
});

// The authoring loop re-authors the same target over and over, and starting PowerPoint again costs
// seconds every pass. Re-authoring keeps the hidden process and swaps only the document: the session
// survives, what it reads is the new deck, and a failed script leaves the live deck untouched.
test('[author] re-authoring a deck reuses the open PowerPoint session and reads the new deck', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
  timeout: 180_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-author-reuse-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const path = join(cwd, 'reused.pptx');
  const deck = (titles) => `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
for (const title of ${JSON.stringify(titles)}) {
  pres.addSlide().addText(title, { x: 0.8, y: 0.8, w: 11, h: 1.2, fontSize: 32, bold: true });
}
await pres.writeFile({ fileName: OUTPUT });
`;
  const first = value(
    await executeOfficeTool({ action: 'author', path, script: deck(['First deck']), render: false }, { cwd })
  );
  assert.equal(first.ok, true, JSON.stringify(first.error || {}));
  assert.equal(first.backend, 'microsoft-office-com');
  assert.notEqual(first.reusedSession, true);
  const opened = value(await executeOfficeTool({ action: 'snapshot', session: first.session }, { cwd }));
  assert.equal(opened.document.slides.length, 1);

  const again = value(
    await executeOfficeTool(
      {
        action: 'author',
        path,
        script: deck(['Second deck', 'Added slide']),
        overwrite: true,
        render: false,
      },
      { cwd }
    )
  );
  assert.equal(again.ok, true, JSON.stringify(again.error || {}));
  assert.equal(again.reusedSession, true);
  assert.equal(again.session, first.session, 'the session survives the rewrite');
  assert.equal(again.receipt?.slides?.length, 2);
  const reread = value(await executeOfficeTool({ action: 'snapshot', session: again.session }, { cwd }));
  assert.equal(reread.document.slides.length, 2, 'the reused session reads the new deck, not the cached old one');
  assert.match(JSON.stringify(reread.document.slides[0]), /Second deck/);
  assert.equal(reread.appPid, opened.appPid, 'the same PowerPoint process carries both decks');

  const failed = value(
    await executeOfficeTool(
      { action: 'author', path, script: 'undefinedCall();', overwrite: true, render: false },
      { cwd }
    )
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'script_failed');
  const survived = value(await executeOfficeTool({ action: 'snapshot', session: again.session }, { cwd }));
  assert.equal(survived.document.slides.length, 2, 'a failed script leaves the open deck alone');
  const staged = (await readdir(cwd)).filter((entry) => entry.includes('.authoring.'));
  assert.deepEqual(staged, [], 'no staging file is left beside the target');
  value(await executeOfficeTool({ action: 'close', session: again.session }, { cwd }));
});

test('[word] move_paragraph moves the paragraph instead of deleting it', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'move.docx'),
        format: 'docx',
        mode: 'background',
        operations: ['A', 'B', 'C', 'D'].map((text) => ({ op: 'append_text', text })),
      },
      { cwd }
    )
  );
  const texts = async () =>
    value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }))
      .document.paragraphs.map((paragraph) => paragraph.text)
      .filter(Boolean);
  const move = async (paragraph, index) =>
    value(
      await executeOfficeTool(
        { action: 'batch', session: created.session, operations: [{ op: 'move_paragraph', paragraph, index }] },
        { cwd }
      )
    );
  // Before the index-th paragraph that remains, or after the last one, as the portable writer moves it.
  await move(4, 2);
  assert.deepEqual(await texts(), ['A', 'D', 'B', 'C']);
  await move(1, 9);
  assert.deepEqual(await texts(), ['D', 'B', 'C', 'A']);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A form's instruction line under its title set column A four times the width of the dates under it, as the portable
// writer no longer does: a line alone in its row prints across the empty cells beside it and sizes no column of a
// fit over several.
test('[excel] a multi-column fit is not widened by a line of text alone in its row', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'form.xlsx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'background',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:A2',
            values: [['경비 신청서'], ['파란 칸에 입력하세요. 둘째 줄은 작성 예시입니다.']],
          },
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A4:C5',
            values: [
              ['사용일', '구분', '금액'],
              ['2026-10-02', '교통', 18400],
            ],
          },
          { op: 'autofit_range', sheet: 'Sheet1', range: 'A:C' },
        ],
      },
      { cwd }
    )
  );
  // The line is wrapped only for the fit: it still reads on one line afterwards.
  const line = value(
    await executeOfficeTool({ action: 'get', session: created.session, target: '/sheet[Sheet1]/cell[A2]' }, { cwd })
  );
  assert.notEqual(line.element.style?.wrapText, true, JSON.stringify(line.element.style));
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const sheet = await (await JSZip.loadAsync(await readFile(path))).file('xl/worksheets/sheet1.xml').async('string');
  const width = Number(/<col min="1" max="1" width="([\d.]+)"/.exec(sheet)?.[1]);
  assert.ok(width > 0 && width < 18, `column A fits its dates, not the instruction line: ${width}`);
});

// A pivot over Hangul fields took the fixed caption "Sum of 매출"; Korean Excel heads it "합계 : 매출" and its totals
// "총합계", as the portable writer now writes them.
test('[excel] a pivot over Korean fields takes Korean captions', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'pivot.xlsx'),
        format: 'xlsx',
        mode: 'background',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:C4',
            values: [
              ['권역', '분기', '매출'],
              ['서울', '1분기', 820],
              ['부산', '1분기', 410],
              ['서울', '2분기', 910],
            ],
          },
          {
            op: 'add_pivot_table',
            sheet: 'Sheet1',
            source: 'A1:C4',
            destination: 'E1',
            rows: ['권역'],
            columns: ['분기'],
            values: ['매출'],
          },
        ],
      },
      { cwd }
    )
  );
  const read = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Sheet1', range: 'E1:I8' }, { cwd })
  );
  const values = (read.document.sheets[0].cells || []).map((cell) => cell.value);
  assert.ok(values.includes('합계 : 매출'), JSON.stringify(values));
  assert.ok(values.includes('총합계'), JSON.stringify(values));
  // The row header names its field, as the portable writer heads it, not "행 레이블".
  assert.ok(!values.includes('행 레이블') && !values.includes('Row Labels'), JSON.stringify(values));
  // And the column header names its field over the quarters, not "열 레이블".
  assert.ok(values.includes('분기'), JSON.stringify(values));
  assert.ok(!values.includes('열 레이블') && !values.includes('Column Labels'), JSON.stringify(values));
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('[excel] a text Excel would type as a date, a number, or a truth value stays text, as the portable writer keeps it', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const texts = [
    '1',
    '1,234',
    '12,345.6',
    '15%',
    '12.5%',
    '-500000',
    '.5',
    '007',
    '1-1',
    '1/2',
    '2026/10/05',
    '2026-10-05',
    '1e3',
    '(100)',
    '10:30',
    'TRUE',
    '#N/A',
    '214-86-12345',
  ];
  const operations = [
    { op: 'set_style', range: 'B1', properties: { numberFormat: '0.0' } },
    { op: 'set_range', range: `A1:A${texts.length}`, values: texts.map((text) => [text]) },
    { op: 'set_cell', cell: 'B1', value: '3-4' },
    { op: 'set_cell', cell: 'B2', value: '2,500' },
    { op: 'append_row', values: ['1-3', '7', '9%'] },
  ];
  const read = async (mode) => {
    const created = value(
      await executeOfficeTool(
        { action: 'create', path: join(cwd, `typed-${mode}.xlsx`), format: 'xlsx', mode, operations },
        { cwd }
      )
    );
    const snapshot = value(
      await executeOfficeTool(
        {
          action: 'snapshot',
          session: created.session,
          sheet: 'Sheet1',
          range: `A1:C${texts.length + 1}`,
          includeStyles: true,
        },
        { cwd }
      )
    );
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return snapshot.document.sheets[0].cells.map((cell) => [cell.ref, cell.value, cell.style?.numberFormat || '']);
  };
  const excel = await read('background');
  const cell = (ref) => excel.find((entry) => entry[0] === ref);
  // "1-1" as an item number, a fraction, a slashed date, an exponent, a time, a truth value, and an error stay text,
  // under the format their cell had ('0.0' on B1).
  for (const ref of ['A8', 'A9', 'A10', 'A11', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19']) {
    assert.equal(typeof cell(ref)[1], 'string', JSON.stringify(cell(ref)));
  }
  assert.deepEqual(cell('B1'), ['B1', '3-4', '0.0']);
  assert.deepEqual(cell('A2'), ['A2', 1234, '#,##0']);
  assert.deepEqual(cell('A5'), ['A5', 0.125, '0.00%']);
  assert.deepEqual(cell('A12'), ['A12', 46300, 'yyyy-mm-dd']);
  assert.deepEqual(excel, await read('portable'));
});

test('[excel] freeze_panes freezes above and left of the cell it names, under a tall title band', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'frozen.xlsx'),
        format: 'xlsx',
        mode: 'background',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A7:C9',
            values: [
              ['지역', '매출', '비중'],
              ['서울', 1, 2],
              ['부산', 3, 4],
            ],
          },
          { op: 'set_row_height', sheet: 'Sheet1', row: 1, height: 86 },
          // The portable writer's reading: row 8 and column B scroll, so rows 1-7 and column A stay.
          { op: 'freeze_panes', sheet: 'Sheet1', row: 8, column: 2 },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(snapshot.document.sheets[0].freezePanes.splitRow, 7);
  assert.equal(snapshot.document.sheets[0].freezePanes.splitColumn, 1);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('[excel] a protected form reads back, allows, and reports its entry cells as the portable file does', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const operations = [
    { op: 'set_range', sheet: 'Sheet1', range: 'A5:B5', values: [['일자', '항목']] },
    { op: 'add_validation', sheet: 'Sheet1', range: 'B6:B15', formula1: '"교통비,숙박비"' },
    { op: 'set_style', sheet: 'Sheet1', range: 'B11:B15', properties: { locked: false } },
    { op: 'protect_sheet', sheet: 'Sheet1', allowFiltering: true },
  ];
  const read = async (mode) => {
    const created = value(
      await executeOfficeTool(
        { action: 'create', path: join(cwd, `form-${mode}.xlsx`), format: 'xlsx', mode, operations },
        { cwd }
      )
    );
    const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
    const sheet = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document
      .sheets[0];
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    // Excel does not say whether a password guards a sheet; the portable reader does.
    const protection = { ...sheet.protection };
    delete protection.password;
    return {
      locked: issues.find((issue) => issue.code === 'protected_input_locked'),
      protection,
      validations: (sheet.validations || []).map((entry) => [entry.ranges, entry.type, entry.formula1]),
    };
  };
  const portable = await read('portable');
  const excel = await read('background');
  // Excel refuses SpecialCells on a protected sheet: its dropdowns had read back as none, and its locked entry
  // cells passed the audit.
  assert.deepEqual(excel.validations, [[['B6:B15'], 'list', '"교통비,숙박비"']]);
  assert.deepEqual(excel.validations, portable.validations);
  assert.ok(excel.locked, 'Excel reports the locked entry cells');
  assert.equal(excel.locked.path, '/sheet[Sheet1]/cell[B6]');
  assert.equal(excel.locked.message, portable.locked.message);
  assert.deepEqual(excel.protection, {
    protected: true,
    allowFormattingCells: false,
    allowSorting: false,
    allowFiltering: true,
  });
  assert.deepEqual(excel.protection, portable.protection);
});

test('[excel] a cut label, a figure run into its label, and faint ink are reported on Excel as portably', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const operations = [
    {
      op: 'set_range',
      sheet: 'Sheet1',
      range: 'A1:D3',
      values: [
        ['일자', '허브', '비고', '확인'],
        [46204, '수도권', '야간 증원 인력 두 명을 추가로 투입할 예정', '예'],
        [46205, '부산', '없음', '예'],
      ],
    },
    { op: 'set_style', sheet: 'Sheet1', range: 'A2:A3', properties: { numberFormat: 'yyyy-mm-dd' } },
    { op: 'set_column_width', sheet: 'Sheet1', column: 'A', width: 12 },
    { op: 'set_column_width', sheet: 'Sheet1', column: 'C', width: 8 },
    { op: 'set_cell', sheet: 'Sheet1', cell: 'A5', value: '참고: 잠정 집계' },
    { op: 'set_style', sheet: 'Sheet1', range: 'A5', properties: { color: 'D1D5DB' } },
  ];
  const codes = new Set(['figure_label_adjacent', 'label_truncated', 'low_contrast']);
  const read = async (mode) => {
    const created = value(
      await executeOfficeTool(
        { action: 'create', path: join(cwd, `log-${mode}.xlsx`), format: 'xlsx', mode, operations },
        { cwd }
      )
    );
    const reviewed = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return (reviewed.issues || [])
      .filter((entry) => codes.has(entry.code))
      .map((entry) => `${entry.code} ${entry.path}`)
      .sort();
  };
  const excel = await read('background');
  // Excel's host had reported none of the three.
  assert.deepEqual(excel, [
    'figure_label_adjacent /sheet[Sheet1]/cell[B2]',
    'label_truncated /sheet[Sheet1]/cell[C2]',
    'low_contrast /sheet[Sheet1]/cell[A5]',
  ]);
  assert.deepEqual(excel, await read('portable'));
});

test('[excel] a fit by width alone leaves the printed length free, as the portable file does', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const read = async (mode) => {
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: join(cwd, `log-${mode}.xlsx`),
          format: 'xlsx',
          mode,
          operations: [
            {
              op: 'set_range',
              sheet: 'Sheet1',
              range: 'A1:B2',
              values: [
                ['일자', '처리량'],
                ['2026-07-01', 1400],
              ],
            },
            { op: 'set_page_setup', sheet: 'Sheet1', fitToPagesWide: 1 },
            // A one-page report after a data sheet fitted by width: Excel had refused its height of 1 once the
            // same statement had set the data sheet's free height ("Specified cast is not valid").
            { op: 'add_sheet', name: 'Report' },
            { op: 'set_cell', sheet: 'Report', cell: 'A1', value: '요약' },
            { op: 'set_page_setup', sheet: 'Report', fitToPagesWide: 1, fitToPagesTall: 1 },
          ],
        },
        { cwd }
      )
    );
    // The portable reader answers a sheet at a time; Excel answers the workbook either way.
    const fits = {};
    for (const name of ['Sheet1', 'Report']) {
      const sheets = value(
        await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: name }, { cwd })
      ).document.sheets;
      const setup = sheets.find((sheet) => sheet.name === name).pageSetup;
      // Excel says False for a free count and the portable reader 0; either way no page limit.
      fits[name] = [Number(setup.fitToPagesWide) || 0, Number(setup.fitToPagesTall) || 0];
    }
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return fits;
  };
  // Excel had kept the height at its default of one page and shrunk a 92-row log onto it.
  const expected = { Sheet1: [1, 0], Report: [1, 1] };
  assert.deepEqual(await read('background'), expected);
  assert.deepEqual(await read('portable'), expected);
});

test('[excel] a validation takes its choices and its rule in the forms the contract names them', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  // Side by side and one above another: Excel finds the validated cells as one area (B6:E15), and had read the
  // five rules back as the first of them.
  const operations = [
    { op: 'set_range', sheet: 'Sheet1', range: 'A1:A3', values: [['서울'], ['부산'], ['대구']] },
    { op: 'add_validation', sheet: 'Sheet1', range: 'B6:B15', formula1: '"교통비,숙박비"' },
    { op: 'add_validation', sheet: 'Sheet1', range: 'C6:C15', type: 'whole', formula1: '1', formula2: '5000000' },
    { op: 'add_validation', sheet: 'Sheet1', range: 'D6:D10', formula1: '서울,부산' },
    { op: 'add_validation', sheet: 'Sheet1', range: 'D11:D15', formula1: '$A$1:$A$3' },
    { op: 'add_validation', sheet: 'Sheet1', range: 'E6:E15', formula1: 'LEN(E6)<=10' },
  ];
  const read = async (mode) => {
    const created = value(
      await executeOfficeTool(
        { action: 'create', path: join(cwd, `rules-${mode}.xlsx`), format: 'xlsx', mode, operations },
        { cwd }
      )
    );
    const sheet = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document
      .sheets[0];
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return (sheet.validations || [])
      .map((entry) => [entry.ranges.join(' '), entry.type, entry.operator, entry.formula1, entry.formula2])
      .sort(([left], [right]) => left.localeCompare(right));
  };
  const excel = await read('background');
  // A quoted list had kept its quotes as part of its first and last choice (""교통비,숙박비""), and a bare range
  // had become a dropdown of its own address.
  assert.deepEqual(excel, [
    ['B6:B15', 'list', '', '"교통비,숙박비"', ''],
    ['C6:C15', 'whole', 'between', '1', '5000000'],
    ['D11:D15', 'list', '', '$A$1:$A$3', ''],
    ['D6:D10', 'list', '', '"서울,부산"', ''],
    ['E6:E15', 'custom', '', 'LEN(E6)<=10', ''],
  ]);
  assert.deepEqual(excel, await read('portable'));
});

// A workbook opened in the background came up in a 114 x 58 pt window, too short to split: freezing row 2 and column B
// failed on every opened file ("FreezePanes 속성을 설정할 수 없습니다") while the portable writer froze them.
test('[excel] freeze_panes freezes a row and a column on an opened workbook, as the portable writer does', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const source = join(cwd, 'ledger.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:C3',
            values: [
              ['권역', '7월', '9월'],
              ['수도권', 26100, 29000],
              ['부산', 21400, 26400],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const frozen = async (mode) => {
    const output = join(cwd, `frozen-${mode}.xlsx`);
    const opened = value(await executeOfficeTool({ action: 'open', path: source, mode, output }, { cwd }));
    value(
      await executeOfficeTool(
        {
          action: 'batch',
          session: opened.session,
          operations: [{ op: 'freeze_panes', sheet: 'Sheet1', row: 2, column: 2 }],
        },
        { cwd }
      )
    );
    value(await executeOfficeTool({ action: 'save', session: opened.session }, { cwd }));
    value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
    const sheet = await (await JSZip.loadAsync(await readFile(output)))
      .file('xl/worksheets/sheet1.xml')
      .async('string');
    const pane = /<pane\b[^>]*\/>/.exec(sheet)?.[0] || '';
    // Excel records a split it froze as frozenSplit; either state holds the panes frozen.
    return ['xSplit', 'ySplit', 'topLeftCell', 'state'].map((name) =>
      (new RegExp(`\\b${name}="([^"]+)"`).exec(pane)?.[1] ?? '').replace(/^frozenSplit$/, 'frozen')
    );
  };
  const excel = await frozen('background');
  assert.deepEqual(excel, ['1', '1', 'B2', 'frozen']);
  assert.deepEqual(await frozen('portable'), excel);
});

// append_row wrote into bare cells on both backends: under #,##0 figures and 0.0% rates the new row read 1200 and
// 0.006. The row now takes the last row's formatting on each, as an inserted row takes the row above's.
test('[excel] an appended row is formatted as the last row is, as the portable writer formats it', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const appended = async (mode) => {
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: join(cwd, `append-${mode}.xlsx`),
          format: 'xlsx',
          mode,
          operations: [
            {
              op: 'set_range',
              sheet: 'Sheet1',
              range: 'A1:C3',
              values: [
                ['권역', '처리량', '지연률'],
                ['수도권', 29000, 0.009],
                ['부산', 26400, 0.019],
              ],
            },
            { op: 'set_style', sheet: 'Sheet1', range: 'B2:B3', properties: { numberFormat: '#,##0' } },
            { op: 'set_style', sheet: 'Sheet1', range: 'C2:C3', properties: { numberFormat: '0.0%' } },
            { op: 'append_row', sheet: 'Sheet1', values: ['세종', 1500, 0.006] },
          ],
        },
        { cwd }
      )
    );
    const cells = value(
      await executeOfficeTool(
        { action: 'snapshot', session: created.session, sheet: 'Sheet1', range: 'B4:C4', includeStyles: true },
        { cwd }
      )
    ).document.sheets[0].cells;
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return cells.map((cell) => `${cell.ref}:${cell.value}:${cell.style?.numberFormat ?? ''}`);
  };
  const excel = await appended('background');
  assert.deepEqual(excel, ['B4:1500:#,##0', 'C4:0.006:0.0%']);
  assert.deepEqual(await appended('portable'), excel);
});

test('[excel] a chart ended at toColumn reaches that column in the workbook font', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'spanned.xlsx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'background',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:B3',
            values: [
              ['지역', '매출'],
              ['서울', 120],
              ['부산', 95],
            ],
          },
          { op: 'set_column_width', sheet: 'Sheet1', column: 'A', width: 20, count: 4 },
          {
            op: 'add_chart',
            sheet: 'Sheet1',
            range: 'A1:B3',
            chartType: 'column',
            cell: 'A5',
            toColumn: 'D',
            height: 200,
          },
        ],
      },
      { cwd }
    )
  );
  // Read as the portable reader reads it: the kind by name and the series' three references apart, not Excel's
  // enumeration number and one =SERIES(...) formula.
  const charted = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const [chart] = charted.document.sheets[0].charts;
  assert.equal(chart.chartType, 'column');
  assert.deepEqual(
    [chart.series[0].formula, chart.series[0].categoryFormula, chart.series[0].valueFormula],
    ['Sheet1!$B$1', 'Sheet1!$A$2:$A$3', 'Sheet1!$B$2:$B$3']
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const drawing = await (await JSZip.loadAsync(await readFile(path))).file('xl/drawings/drawing1.xml').async('string');
  // The frame's right edge is column D's: the anchor ends at E with no offset, whatever a column measures here.
  assert.match(drawing, /<xdr:to><xdr:col>4<\/xdr:col><xdr:colOff>0<\/xdr:colOff>/);
});

test('[word] set_paragraph_text rewrites a table cell paragraph without adding one', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'cell.docx'),
        format: 'docx',
        mode: 'background',
        operations: [
          { op: 'append_text', text: '첫 문단' },
          {
            op: 'add_table',
            values: [
              ['가', '나'],
              ['다', '라'],
            ],
          },
          { op: 'append_text', text: '표 뒤 문단' },
        ],
      },
      { cwd }
    )
  );
  const listed = async () =>
    value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document.paragraphs.map(
      (paragraph) => `${paragraph.index}:${paragraph.text}`
    );
  const before = await listed();
  // Word numbers the cell paragraphs too: 2 is the first cell, and the paragraphs after it keep their numbers.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_paragraph_text', paragraph: 2, text: '수정' }],
      },
      { cwd }
    )
  );
  assert.deepEqual(
    await listed(),
    before.map((entry) => (entry === '2:가' ? '2:수정' : entry))
  );
  // A cleared body paragraph stays in the reading, with its number to fill it by, as the portable reader lists it.
  value(
    await executeOfficeTool(
      { action: 'batch', session: created.session, operations: [{ op: 'set_paragraph_text', paragraph: 1, text: '' }] },
      { cwd }
    )
  );
  assert.equal((await listed())[0], '1:');
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// Word opened a break's paragraph in the next paragraph's style — an empty heading before a heading — and wrote a
// column break as a page break, inline in the next line; the break now stands in a plain paragraph of its own.
test('[word] a page or column break stands in a plain paragraph of its own, as the portable writer writes it', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const broken = async (mode, kind) => {
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: join(cwd, `break-${mode}-${kind}.docx`),
          format: 'docx',
          mode,
          operations: [
            { op: 'append_text', text: '요약 문단' },
            { op: 'append_text', text: '부록', style: 'Heading1' },
            { op: 'insert_break', paragraph: 1, kind },
          ],
        },
        { cwd }
      )
    );
    const paragraphs = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }))
      .document.paragraphs;
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return paragraphs.slice(0, 3).map((paragraph) => `${paragraph.text}:${paragraph.style}`);
  };
  for (const kind of ['page', 'column']) {
    const word = await broken('background', kind);
    assert.deepEqual(word, ['요약 문단:Normal', ':Normal', '부록:Heading1'], kind);
    assert.deepEqual(await broken('portable', kind), word, kind);
  }
});

// set_list number took Word's one-level gallery list, where level 1 failed (0x800A1200), and a nested bullet was
// indented by ListIndent, which moves a list's first item whole instead of nesting it. Both read as portably now.
test('[word] set_list numbers and nests items at the level asked, as the portable writer lists them', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const listed = async (mode) => {
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: join(cwd, `list-${mode}.docx`),
          format: 'docx',
          mode,
          operations: [
            { op: 'append_text', text: '처리 절차' },
            { op: 'append_text', text: '접수' },
            { op: 'append_text', text: '분류' },
            { op: 'append_text', text: '야간 분류' },
            { op: 'set_list', paragraph: 2, kind: 'number' },
            { op: 'set_list', paragraph: 3, kind: 'number' },
            { op: 'set_list', paragraph: 4, kind: 'number', level: 1 },
          ],
        },
        { cwd }
      )
    );
    const paragraphs = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }))
      .document.paragraphs;
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return paragraphs
      .slice(1, 4)
      .map((paragraph) => `${paragraph.text}:${paragraph.list?.kind}:${paragraph.list?.level}`);
  };
  const word = await listed('background');
  assert.deepEqual(word, ['접수:number:0', '분류:number:0', '야간 분류:number:1']);
  assert.deepEqual(await listed('portable'), word);
});

// One past the last column adds a column at the end on both backends; Word's Columns.Item refused it with "no such
// member" (a localized COM error) while the portable writer added the column.
test('[word] a column inserted one past the last lands at the end, and one further is refused, as portably', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const grown = async (mode) => {
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: join(cwd, `columns-${mode}.docx`),
          format: 'docx',
          mode,
          operations: [
            {
              op: 'add_table',
              values: [
                ['권역', '9월'],
                ['수도권', '29,000'],
              ],
            },
            { op: 'insert_table_column', table: 1, column: 3 },
            { op: 'set_table_cell', table: 1, row: 1, col: 3, text: '증가율' },
          ],
        },
        { cwd }
      )
    );
    const refused = await executeOfficeTool(
      { action: 'batch', session: created.session, operations: [{ op: 'insert_table_column', table: 1, column: 5 }] },
      { cwd }
    );
    const table = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document
      .tables[0];
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return {
      header: JSON.stringify(table.rows?.[0] ?? table.cells?.[0] ?? table),
      refused: refused.isError,
      message: refused.content[0].text,
    };
  };
  const word = await grown('background');
  assert.match(word.header, /권역[\s\S]*9월[\s\S]*증가율/);
  assert.equal(word.refused, true);
  assert.match(
    word.message,
    /so it has no column 5: insert_table_column column is the position the new column takes, 1 to 4/
  );
  const portable = await grown('portable');
  assert.match(portable.header, /권역[\s\S]*9월[\s\S]*증가율/);
  assert.match(
    portable.message,
    /so it has no column 5: insert_table_column column is the position the new column takes, 1 to 4/
  );
});

test('[word] a link or note placed by paragraph lands at the end of its text', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'placed.docx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'background',
        operations: ['첫 문단', '둘째 문단', '셋째 문단'].map((text) => ({ op: 'append_text', text })),
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
          { op: 'add_hyperlink', paragraph: 2, address: 'https://example.com', display: '링크' },
          { op: 'add_note', paragraph: 1, text: '출처' },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const body = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
  const paragraphs = [...body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => match[0]);
  const text = (xml) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('');
  // Laid over the paragraph's mark, the link joined the second paragraph to the third and its display replaced
  // the paragraph's text; the note's mark opened the second paragraph.
  assert.deepEqual(paragraphs.slice(0, 3).map(text), ['첫 문단', '둘째 문단링크', '셋째 문단']);
  assert.match(paragraphs[0], /<w:footnoteReference /);
  assert.doesNotMatch(paragraphs[1], /<w:footnoteReference /);
});

// Word put a second table into the paragraph right after the first, and the two read back as one table; the
// portable writer keeps a paragraph between them, and so does Word now.
test('[word] two tables added in a row stay two tables', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'tables.docx'),
        format: 'docx',
        mode: 'background',
        operations: [
          { op: 'append_text', text: '첫' },
          { op: 'add_table', rows: 1, columns: 1, values: [['A']] },
          { op: 'add_table', rows: 1, columns: 1, values: [['B']] },
        ],
      },
      { cwd }
    )
  );
  const read = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(read.document.tableCount, 2, JSON.stringify(read.document.blockOrder));
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// Word ended every document it wrote with an empty paragraph, put a picture added at the end at the start of the
// last paragraph's text, and opened an empty paragraph after a page break; the paragraphs now read as the portable
// writer's do.
test('[word] appended blocks read as the portable writer lays them out', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const picture = join(cwd, 'dot.png');
  await writeFile(
    picture,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  const operations = [
    { op: 'append_text', text: '제목', style: 'Heading 1' },
    { op: 'append_text', text: '항목', properties: { listKind: 'bullet' } },
    { op: 'append_text', text: '목록 뒤' },
    { op: 'add_image', path: picture, width: 20, height: 20 },
    { op: 'append_text', text: '그림 설명' },
    { op: 'insert_break' },
    { op: 'append_text', text: '둘째 쪽' },
    { op: 'add_table', rows: 1, columns: 1, values: [['A']] },
    { op: 'append_text', text: '표 뒤' },
    { op: 'set_header_footer', kind: 'header', text: '대외비' },
    { op: 'set_header_footer', kind: 'footer', text: '물류운영팀' },
    { op: 'add_page_numbers' },
    { op: 'insert_break', kind: 'section_next' },
    { op: 'append_text', text: '다음 구역' },
  ];
  const read = {};
  const sections = {};
  for (const mode of ['portable', 'background']) {
    const created = value(
      await executeOfficeTool(
        { action: 'create', path: join(cwd, `${mode}.docx`), format: 'docx', mode, operations },
        { cwd }
      )
    );
    const document = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document;
    read[mode] = document.paragraphs.filter((paragraph) => !paragraph.inTable).map((paragraph) => paragraph.text);
    sections[mode] = document.sections;
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  }
  assert.deepEqual(read.background, read.portable);
  assert.deepEqual(read.background, [
    '제목',
    '항목',
    '목록 뒤',
    '',
    '그림 설명',
    '',
    '둘째 쪽',
    '표 뒤',
    '',
    '다음 구역',
  ]);
  // Headers and footers read under the section that shows them on both backends.
  assert.deepEqual(sections.background, sections.portable);
  assert.deepEqual(
    sections.portable.map((section) =>
      section.stories.map((story) => [story.location, story.text, story.linkToPrevious === true])
    ),
    [
      [
        ['header', '대외비', false],
        ['footer', '물류운영팀\n1', false],
      ],
      [
        ['header', '대외비', true],
        ['footer', '물류운영팀\n1', true],
      ],
    ]
  );
});

// Paragraphs appended one after another go into Word as one block: one at a time, a 150-paragraph Korean report took
// 56 s to create. The block still answers one result per operation, no paragraph carries its neighbour's format (a
// callout's text under its bold label stays regular), and it reads back as the portable writer lays it out.
test('[word] consecutive paragraphs append as one block and read back one by one in their own formats', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const body = { name: 'Calibri', nameEastAsia: '맑은 고딕', size: 10.5, lineSpacing: 18, spacingAfter: 8 };
  // compose_document names Normal on its list items, and the portable writer keeps it; Word moved them to List
  // Paragraph, whose contextual spacing took away each item's spacing. An item naming no style takes List Paragraph
  // on both paths.
  const bullet = (text) => ({
    op: 'append_text',
    text,
    style: 'Normal',
    properties: { ...body, spacingAfter: 3, listKind: 'bullet' },
  });
  const operations = [
    { op: 'append_text', text: '현황', style: 'Heading 1' },
    { op: 'append_text', text: '첫째 문단입니다.', properties: body },
    { op: 'append_text', text: '둘째 문단입니다.', properties: body },
    { op: 'append_text', text: '셋째 문단입니다.', properties: body },
    bullet('항목 하나'),
    bullet('항목 둘'),
    { op: 'append_text', text: '항목 셋', properties: { ...body, listKind: 'bullet' } },
    { op: 'append_text', text: '결론', properties: { ...body, bold: true, shading: 'EEF2F7' } },
    { op: 'append_text', text: '맺음 문단입니다.', properties: { ...body, size: 12, shading: 'EEF2F7' } },
  ];
  const read = {};
  for (const mode of ['portable', 'background']) {
    const created = value(
      await executeOfficeTool(
        { action: 'create', path: join(cwd, `${mode}.docx`), format: 'docx', mode, operations },
        { cwd }
      )
    );
    if (mode === 'background') {
      assert.deepEqual(
        created.batch.results.map((entry) => entry.paragraph),
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
        'one result per operation, each naming its own paragraph'
      );
    }
    const document = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document;
    read[mode] = document.paragraphs.map((paragraph) => [
      paragraph.text,
      paragraph.list?.kind || '',
      paragraph.font?.size,
      paragraph.style,
      Boolean(paragraph.font?.bold),
    ]);
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  }
  assert.deepEqual(
    read.background.map(([text, kind]) => [text, kind]),
    read.portable.map(([text, kind]) => [text, kind])
  );
  assert.deepEqual(
    read.background.slice(1).map(([, , size]) => size),
    [10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 12]
  );
  assert.deepEqual(
    read.background.map((entry) => entry[3]),
    read.portable.map((entry) => entry[3])
  );
  assert.deepEqual(
    read.background.map((entry) => entry[4]),
    read.portable.map((entry) => entry[4])
  );
  assert.deepEqual(
    read.background.slice(-2).map((entry) => entry[4]),
    [true, false]
  );
});

// A phrase cut inside a word ("성장" of "성장했습니다") took the note's mark mid-word; a phrase ending on a sign
// ("92.8%" before "로") keeps it there, as the portable writer sets both.
test('[word] a note mark goes at the end of the word the cited phrase ends in', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'notes.docx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'background',
        operations: [
          { op: 'append_text', text: '부산 권역이 가장 크게 성장했습니다.' },
          { op: 'add_note', find: '가장 크게 성장', text: '영업 시스템 추출 기준.' },
          { op: 'append_text', text: '정시 출고율은 92.8%로 내려갔습니다.' },
          { op: 'add_note', find: '92.8%', text: '물류운영팀 집계.' },
        ],
      },
      { cwd }
    )
  );
  // Word holds the note reference in the text as \x02; the paragraph reads as the page shows it.
  const read = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    read.document.paragraphs.slice(0, 2).map((paragraph) => paragraph.text),
    ['부산 권역이 가장 크게 성장했습니다.', '정시 출고율은 92.8%로 내려갔습니다.']
  );
  assert.equal(read.document.footnotes[0].text, '영업 시스템 추출 기준.');
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const document = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
  const before = (reference) => {
    const at = document.indexOf(reference);
    return [...document.slice(0, at).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('');
  };
  assert.match(before('<w:footnoteReference w:id="1"/>'), /성장했습니다$/);
  assert.match(before('<w:footnoteReference w:id="2"/>'), /92\.8%$/);
});

test('[word][excel] an unlabelled picture is reported on the Office backend as it is portably', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const picture = join(cwd, 'logo.png');
  await writeFile(picture, PNG_PIXEL);
  const placed = {
    docx: [
      { op: 'append_text', text: '로고' },
      { op: 'add_image', path: picture, width: 40 },
    ],
    xlsx: [
      { op: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '로고' },
      { op: 'add_image', sheet: 'Sheet1', path: picture, cell: 'C2', width: 40 },
    ],
  };
  for (const [format, operations] of Object.entries(placed)) {
    const created = value(
      await executeOfficeTool(
        { action: 'create', path: join(cwd, `picture.${format}`), format, mode: 'background', operations },
        { cwd }
      )
    );
    const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues;
    assert.ok(
      issues.some((entry) => entry.code === 'missing_alt_text'),
      `${format}: ${JSON.stringify(issues.map((entry) => entry.code))}`
    );
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  }
});

test('[excel] charts and pictures are reviewed against the print area and each other on Excel too', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const picture = join(cwd, 'logo.png');
  await writeFile(picture, PNG_PIXEL);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'drawings.xlsx'),
        format: 'xlsx',
        mode: 'background',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:B4',
            values: [
              ['지역', '매출'],
              ['서울', 120],
              ['부산', 80],
              ['대구', 60],
            ],
          },
          {
            op: 'add_chart',
            sheet: 'Sheet1',
            range: 'A1:B4',
            chartType: 'column',
            cell: 'D2',
            width: 300,
            height: 200,
          },
          { op: 'add_chart', sheet: 'Sheet1', range: 'A1:B4', chartType: 'pie', cell: 'F6', width: 240, height: 180 },
          { op: 'add_image', sheet: 'Sheet1', path: picture, cell: 'D20', width: 40, altText: '회사 로고' },
          // Excel reports the area as $A$1:$C$10; read that way it was no print area at all.
          { op: 'set_page_setup', sheet: 'Sheet1', printArea: 'A1:C10' },
        ],
      },
      { cwd }
    )
  );
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues;
  const found = issues.map((entry) => `${entry.code} ${entry.path}`);
  for (const expected of [
    'drawing_outside_print_area /sheet[Sheet1]/chart[1]',
    'drawing_outside_print_area /sheet[Sheet1]/image[1]',
    'drawing_overlap /sheet[Sheet1]/chart[2]',
  ]) {
    assert.ok(found.includes(expected), `${expected} in ${JSON.stringify(found)}`);
  }
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('[word] an edit of a table-of-contents entry says what to edit instead', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'toc.docx'),
        format: 'docx',
        mode: 'background',
        operations: [
          { op: 'append_text', text: '개요', style: 'Heading 1' },
          { op: 'append_text', text: '본문' },
          { op: 'append_text', text: '결론', style: 'Heading 1' },
          { op: 'insert_toc', paragraph: 1 },
        ],
      },
      { cwd }
    )
  );
  // Paragraph 2 is the first entry of the contents Word filled in after the heading.
  const refused = await executeOfficeTool(
    { action: 'batch', session: created.session, operations: [{ op: 'remove_paragraph', paragraph: 2 }] },
    { cwd }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /table of contents.*edit the heading it lists/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('[word] name sets the Latin face alone and leaves the Hangul face to nameEastAsia', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'faces.docx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'background',
        operations: [
          { op: 'append_text', text: '서울 매출' },
          // Font.Name given an East Asian face set the Hangul face too; the portable writer sets w:ascii alone.
          { op: 'set_font', find: '서울', properties: { name: 'Batang' } },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const xml = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
  const run = [...xml.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)].map((m) => m[0]).find((r) => r.includes('서울'));
  const fonts = /<w:rFonts\b[^>]*\/>/.exec(run)?.[0] || '';
  assert.match(fonts, /w:ascii="(?:Batang|바탕)"/, fonts);
  assert.doesNotMatch(fonts, /w:eastAsia="(?:Batang|바탕)"/, fonts);
});

test('[excel] a border set on a block rules the lines between its cells, as the portable writer does', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'grid.xlsx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'background',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:C3',
            values: [
              ['a', 'b', 'c'],
              [1, 2, 3],
              [4, 5, 6],
            ],
          },
          // The edge indexes alone drew one box around the block; the file writer borders every cell.
          { op: 'set_style', sheet: 'Sheet1', range: 'A1:C3', properties: { borders: { style: 'thin' } } },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(path));
  const styles = await zip.file('xl/styles.xml').async('string');
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const xfs = [.../<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(styles)[0].matchAll(/<xf\b[^>]*>/g)].map((m) => m[0]);
  const borders = [.../<borders\b[\s\S]*?<\/borders>/.exec(styles)[0].matchAll(/<border\b[\s\S]*?<\/border>/g)];
  const style = Number(/<c r="B2"[^>]*?\ss="(\d+)"/.exec(sheet)?.[1] || 0);
  const border = borders[Number(/borderId="(\d+)"/.exec(xfs[style])?.[1] || 0)]?.[0] || '';
  assert.match(border, /<left style="thin"/, border);
  assert.match(border, /<top style="thin"/, border);
});

// A row names its cells as it stands: a merge across columns moves the later cells left, so a header merged left to
// right lost its last label, and Word said only that the collection has no such member, in the UI language. Merged
// A report's metric strip is a table too: "table 1, row 4" named it where the results table was meant. Word said only
// that the collection has no such member and the portable writer added a row to the strip; both now refuse it with
// the table's size and first words, and a table the document lacks lists the ones it holds.
test('[word] a row or table the document lacks is refused with the tables it holds, as the portable writer says it', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const tables = [
    {
      op: 'add_table',
      values: [
        ['184,200건', '+34%'],
        ['야간 처리량', '전년 대비'],
      ],
    },
    {
      op: 'add_table',
      values: [
        ['권역', '처리량'],
        ['수도권', '82,400'],
        ['부산', '71,600'],
        ['합계', '154,000'],
      ],
    },
  ];
  const refusals = async (mode) => {
    const created = value(
      await executeOfficeTool(
        { action: 'create', path: join(cwd, `tables-${mode}.docx`), format: 'docx', mode, operations: tables },
        { cwd }
      )
    );
    const refused = async (operation) => {
      const result = await executeOfficeTool(
        { action: 'batch', session: created.session, operations: [operation] },
        { cwd }
      );
      assert.equal(result.isError, true, `${operation.op} is refused`);
      return /DOCX table [^\n]*/.exec(result.content[0].text)?.[0];
    };
    const messages = [
      await refused({ op: 'insert_table_row', table: 1, row: 4 }),
      await refused({ op: 'set_table_cell', table: 1, row: 5, col: 1, text: '강원' }),
      await refused({ op: 'insert_table_row', table: 3, row: 1 }),
    ];
    // One past the last row adds a row at the end.
    const added = value(
      await executeOfficeTool(
        { action: 'batch', session: created.session, operations: [{ op: 'insert_table_row', table: 2, row: 5 }] },
        { cwd }
      )
    );
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return { messages, rows: added.results[0].rows };
  };
  const word = await refusals('background');
  assert.match(
    word.messages[0],
    /DOCX table 1 is 2×2 starting "184,200건", so it has no row 4: insert_table_row row is the position the new row takes, 1 to 3/
  );
  assert.match(word.messages[1], /DOCX table 1 is 2×2 starting "184,200건", so it has no row 5$/);
  assert.match(
    word.messages[2],
    /DOCX table 3 not found: the document holds 2 table\(s\) \(1: 2×2 starting "184,200건"; 2: 4×2 starting "권역"\)/
  );
  assert.equal(word.rows, 5);
  const portable = await refusals('portable');
  assert.deepEqual(portable.messages, word.messages);
});

// right to left the two-level header comes out whole, and a cell named past the row's end is explained in the words
// the portable writer uses.
test('[word] a two-level header merges right to left and a shifted cell is explained', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'merged.docx'),
        format: 'docx',
        mode: 'background',
        operations: [
          {
            op: 'add_table',
            values: [
              ['권역', '3분기 처리량', '', '', '지연률'],
              ['', '7월', '8월', '9월', ''],
              ['수도권', '26,100', '27,300', '29,000', '0.8%'],
            ],
            properties: { headerRows: 2 },
          },
          { op: 'merge_table_cells', table: 1, row: 1, col: 5, rowSpan: 2 },
          { op: 'merge_table_cells', table: 1, row: 1, col: 2, colSpan: 3 },
          { op: 'merge_table_cells', table: 1, row: 1, col: 1, rowSpan: 2 },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.filter((entry) => entry.op === 'merge_table_cells').length, 3);
  const shifted = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'set_table_cell', table: 1, row: 1, col: 5, text: '지연' }],
    },
    { cwd }
  );
  assert.equal(shifted.isError, true);
  assert.match(shifted.content[0].text, /row 1 holds 3 cell\(s\)[\s\S]*merge a row from its right end first/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  // Both header rows are the header, as the portable writer sets them: bold, on their bottom edge, and repeated.
  const document = await (await JSZip.loadAsync(await readFile(join(cwd, 'merged.docx'))))
    .file('word/document.xml')
    .async('string');
  const rows = [...document.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((match) => match[0]);
  assert.deepEqual(
    rows.map((row) => /<w:tblHeader\/>/.test(row)),
    [true, true, false]
  );
  const month = /<w:tc>(?:(?!<\/w:tc>)[\s\S])*?<w:t>7월<\/w:t>/.exec(rows[1])?.[0] || '';
  assert.match(month, /<w:vAlign w:val="bottom"\/>/, month);
  assert.match(month, /<w:b\/>/, month);
});

// A Word chart is the picture the PDF chart block draws, placed as add_image places one, so Word holds the same
// picture the portable writer does.
test('[word] a chart lands as a picture that names its figures', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'charted.docx'),
        format: 'docx',
        mode: 'background',
        operations: [
          { op: 'append_text', text: '분기별 처리량' },
          {
            op: 'add_chart',
            chartType: 'column',
            categories: ['1분기', '2분기', '3분기'],
            values: [120, 150, 184.2],
            unit: '천 건',
            highlight: 2,
          },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(join(cwd, 'charted.docx')));
  const document = await zip.file('word/document.xml').async('string');
  assert.match(document, /descr="1분기 120천 건, 2분기 150천 건, 3분기 184\.2천 건"/);
  assert.ok(
    Object.keys(zip.files).some((name) => /^word\/media\/.+\.png$/.test(name)),
    'the picture is in the package'
  );
});

// A provenance comment names its source in the language the source is named in, as the portable writer writes it:
// Word's comment read "Source: 실적원장.xlsx#Raw!B8" beside the portable file's "출처: …".
test('[word] a provenance comment cites its source in the copy language', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'cited.docx'),
        format: 'docx',
        mode: 'background',
        operations: [
          { op: 'append_text', text: '3분기 매출은 86억 원입니다.' },
          { op: 'add_provenance', paragraph: 1, source: { document: '실적원장.xlsx', target: 'Raw!B8' } },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).citation, '출처: 실적원장.xlsx#Raw!B8');
  const read = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(read.document.comments[0].text, '출처: 실적원장.xlsx#Raw!B8');
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A display title's leading is held exactly when asked, as the portable writer sets it; without the rule it stays a
// minimum.
test('[word] a paragraph holds an exact line when asked and a minimum otherwise', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'leading.docx'),
        format: 'docx',
        mode: 'background',
        operations: [
          {
            op: 'append_text',
            text: '가맹점 설정 오류를 먼저 알려 주는 안내 자동화',
            style: 'Title',
            properties: { size: 24, lineSpacing: 30, lineSpacingRule: 'exact' },
          },
          { op: 'append_text', text: '본문 한 줄', properties: { size: 10.5, lineSpacing: 18 } },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const document = await (await JSZip.loadAsync(await readFile(join(cwd, 'leading.docx'))))
    .file('word/document.xml')
    .async('string');
  assert.match(document, /<w:spacing\b[^>]*\bw:line="600" w:lineRule="exact"/);
  assert.match(document, /<w:spacing\b[^>]*\bw:line="360" w:lineRule="atLeast"/);
});

// A column of words that follows a column of figures takes room on its left, as the portable writer gives it: set
// right, "96" ran into "내부 인력 4명" across the cells' own padding alone.
test('[word] a column of words after a column of figures takes a gutter', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'budget.docx'),
        format: 'docx',
        mode: 'background',
        operations: [
          {
            op: 'add_table',
            values: [
              ['항목', '금액 (백만 원)', '비고'],
              ['개발 인력', '96', '내부 인력 4명'],
              ['합계', '160', '예비비 포함'],
            ],
            properties: { columnAlignments: ['left', 'right', 'left'] },
          },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const document = await (await JSZip.loadAsync(await readFile(join(cwd, 'budget.docx'))))
    .file('word/document.xml')
    .async('string');
  const rows = [...document.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((match) => match[0]);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const [, figure, note] = [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((match) => match[0]);
    assert.doesNotMatch(figure, /<w:tcMar>[\s\S]*?<w:left\b/, 'the figures keep their padding');
    assert.match(note, /<w:tcMar>[\s\S]*?<w:left w:w="268" w:type="dxa"\/>/, 'the words take the gutter');
  }
});

// The Excel snapshot reads a sheet's values and formulas in one array each and settles "nothing withheld" with one
// question (its visible cells are the whole range); only otherwise are rows and columns walked. EntireRow.Hidden reads
// False on a range whose rows are mixed, and taken for that answer it reported a hidden row and column as shown.
test('[excel] the snapshot names hidden rows and columns and reads formulas from the sheet', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'withheld.xlsx'),
        format: 'xlsx',
        mode: 'background',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:C3',
            values: [
              ['지역', '매출', '비고'],
              ['서울', 120, '본사'],
              ['부산', 80, '허브'],
            ],
          },
          { op: 'set_cell', sheet: 'Sheet1', cell: 'A4', value: '합계' },
          { op: 'set_formula', sheet: 'Sheet1', cell: 'B4', formula: '=SUM(B2:B3)' },
        ],
      },
      { cwd }
    )
  );
  const read = async () =>
    value(
      await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Sheet1' }, { cwd })
    ).document.sheets.find((entry) => entry.name === 'Sheet1');
  const shown = await read();
  // Nothing withheld reads absent, as the portable reader answers it.
  assert.deepEqual([shown.hiddenRows ?? [], shown.hiddenColumns ?? []], [[], []]);
  assert.deepEqual(
    shown.cells.map((cell) => [cell.ref, cell.value, cell.formula ?? null]).filter(([ref]) => ref.endsWith('4')),
    [
      ['A4', '합계', null],
      ['B4', 200, '=SUM(B2:B3)'],
    ]
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'set_column_visibility', sheet: 'Sheet1', column: 'C', visible: false },
          { op: 'set_row_visibility', sheet: 'Sheet1', row: 3, visible: false },
        ],
      },
      { cwd }
    )
  );
  const withheld = await read();
  assert.deepEqual([withheld.hiddenRows, withheld.hiddenColumns], [[3], ['C']]);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('[excel] copy_sheet copies and insert_columns takes a column letter', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'sheets.xlsx'),
        format: 'xlsx',
        mode: 'background',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:B2',
            values: [
              ['a', 'b'],
              [1, 2],
            ],
          },
        ],
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
          { op: 'copy_sheet', sheet: 'Sheet1', name: '사본' },
          { op: 'insert_columns', sheet: 'Sheet1', column: 'B', count: 1 },
        ],
      },
      { cwd }
    )
  );
  assert.equal(edited.results.find((result) => result.op === 'copy_sheet')?.sheet, '사본');
  assert.equal(edited.results.find((result) => result.op === 'insert_columns')?.column, 2);
  const missing = await executeOfficeTool(
    { action: 'batch', session: created.session, operations: [{ op: 'delete_sheet', sheet: '없는 시트' }] },
    { cwd }
  );
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Worksheet not found: 없는 시트/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A monthly refresh that adds a period: the accent marked the latest point, and PowerPoint kept it on the old last
// point by index, under a title about the new one. It follows the last point; the point it left takes the series colour.
test('[powerpoint] a data refresh moves a last-point accent to the new last point', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'accent.pptx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'pptx',
        mode: 'background',
        operations: [
          { op: 'add_slide', layout: 'Title Only' },
          {
            op: 'add_chart',
            slide: 1,
            chartType: 'column',
            categories: ['Jan', 'Feb'],
            series: [{ name: 'Visits', values: [10, 20], color: 'D0CBC8', pointColors: ['D0CBC8', '1C6FE3'] }],
          },
        ],
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
            op: 'set_chart_data',
            slide: 1,
            shape: 2,
            categories: ['Jan', 'Feb', 'Mar'],
            series: [{ name: 'Visits', values: [10, 20, 30] }],
          },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(path));
  const chartPart = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const chart = await zip.file(chartPart).async('string');
  const fills = new Map(
    [...chart.matchAll(/<c:dPt>[\s\S]*?<c:idx val="(\d+)"\/>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/g)].map(
      (match) => [Number(match[1]), match[2].toUpperCase()]
    )
  );
  assert.equal(fills.get(2), '1C6FE3', `the new last point carries the accent: ${JSON.stringify([...fills])}`);
  assert.notEqual(fills.get(1), '1C6FE3', 'the point it left no longer does');
});

test("[powerpoint] a data refresh that names no categories keeps the chart's own, as the portable writer does", {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const read = async (mode) => {
    const path = join(cwd, `refresh-${mode}.pptx`);
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path,
          format: 'pptx',
          mode,
          operations: [
            { op: 'add_slide', layout: 'Blank' },
            {
              op: 'add_chart',
              slide: 1,
              chartType: 'column',
              categories: ['2024', '2025', '2026 전망'],
              series: [{ name: '수요', values: [21, 27, 33] }],
            },
          ],
        },
        { cwd }
      )
    );
    value(
      await executeOfficeTool(
        {
          action: 'batch',
          session: created.session,
          operations: [{ op: 'set_chart_data', slide: 1, shape: 1, series: [{ name: '수요', values: [21, 28, 35] }] }],
        },
        { cwd }
      )
    );
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    const zip = await JSZip.loadAsync(await readFile(path));
    const chartPart = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    const chart = await zip.file(chartPart).async('string');
    const cache = (tag) =>
      [...(new RegExp(`<c:${tag}>[\\s\\S]*?</c:${tag}>`).exec(chart)?.[0] || '').matchAll(/<c:v>([^<]*)<\/c:v>/g)].map(
        (match) => match[1]
      );
    return { categories: cache('cat'), values: cache('val').map(Number) };
  };
  // Refreshed without categories, PowerPoint's own had put Item 1, Item 2, Item 3 under the bars.
  const powerpoint = await read('background');
  assert.deepEqual(powerpoint, { categories: ['2024', '2025', '2026 전망'], values: [21, 28, 35] });
  assert.deepEqual(powerpoint, await read('portable'));
});

test('[powerpoint] default layout and data label names work in any PowerPoint language', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'layouts.pptx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'pptx',
        mode: 'background',
        operations: [
          { op: 'add_slide', layout: 'Title Only' },
          { op: 'add_slide', layout: 'title and content' },
          {
            op: 'add_chart',
            slide: 1,
            chartType: 'column',
            categories: ['A', 'B'],
            series: [
              { name: 'S1', values: [1, 2] },
              { name: 'S2', values: [3, 4] },
            ],
          },
        ],
      },
      { cwd }
    )
  );
  const labelled = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_chart_data_labels', slide: 1, shape: 2, position: 'outside_end' }],
      },
      { cwd }
    )
  );
  assert.equal(labelled.results[0].series, 'all');
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(path));
  const slides = await Promise.all(
    [1, 2].map((slide) => zip.file(`ppt/slides/_rels/slide${slide}.xml.rels`).async('string'))
  );
  const layoutPart = (rels) => /slideLayouts\/(slideLayout\d+\.xml)/.exec(rels)[1];
  const layoutType = async (rels) =>
    /<p:sldLayout\b[^>]*\btype="(\w+)"/.exec(await zip.file(`ppt/slideLayouts/${layoutPart(rels)}`).async('string'))[1];
  assert.deepEqual(await Promise.all(slides.map(layoutType)), ['titleOnly', 'obj']);
  const chartPart = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const chart = await zip.file(chartPart).async('string');
  const positions = [...chart.matchAll(/<c:dLblPos val="outEnd"\/>/g)].length;
  assert.ok(positions >= 2, 'both series carry the named position');
});

test('[powerpoint] a large glyph its box holds is not an overflow; words past the box still are', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'glyph.pptx'),
        format: 'pptx',
        mode: 'background',
        operations: [
          { op: 'add_slide', layout: 'blank' },
          // The kit's quotation mark: 120 pt in a box its ink fills, 30 pt short of PowerPoint's BoundWidth.
          {
            op: 'add_textbox',
            slide: 1,
            text: '“',
            left: 227,
            top: 153,
            width: 66,
            height: 148,
            fontSize: 120,
            fontName: 'Noto Serif KR',
          },
          {
            op: 'add_textbox',
            slide: 1,
            text: '넘치는 긴 문장이 좁은 상자를 벗어난다',
            left: 400,
            top: 60,
            width: 80,
            height: 24,
            fontSize: 18,
          },
        ],
      },
      { cwd }
    )
  );
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues;
  const overflowing = issues.filter((entry) => entry.code === 'text_overflow').map((entry) => entry.path);
  assert.ok(!overflowing.includes('/slide[1]/shape[1]'), JSON.stringify(overflowing));
  assert.ok(overflowing.includes('/slide[1]/shape[2]'), JSON.stringify(overflowing));
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('[powerpoint] qa repairs a box past the slide edge after fitting another', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'qa.pptx'),
        format: 'pptx',
        mode: 'background',
        operations: [
          { op: 'add_slide', layout: 'blank' },
          {
            op: 'add_textbox',
            slide: 1,
            text: '넘치는 문장 '.repeat(8),
            left: 40,
            top: 40,
            width: 200,
            height: 40,
            fontSize: 24,
          },
          {
            op: 'add_textbox',
            slide: 1,
            text: '밖으로 나간 상자',
            left: 900,
            top: 480,
            width: 200,
            height: 60,
            fontSize: 18,
          },
        ],
      },
      { cwd }
    )
  );
  // The second fit_text set a width computed as a Double after the first had set one as a Single; PowerShell's COM
  // binder refused it and qa returned an error in place of its repairs.
  const qa = value(
    await executeOfficeTool({ action: 'qa', session: created.session, autoFix: true, render: false }, { cwd })
  );
  assert.equal(qa.fixes.length, 2, JSON.stringify(qa.fixes));
  assert.ok(
    !(qa.issuesAfter || []).some((entry) => entry.code === 'text_outside_slide'),
    JSON.stringify(qa.issuesAfter)
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('[powerpoint] trendline codes and error bar sides read as the portable writer reads them', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'kinds.pptx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'pptx',
        mode: 'background',
        operations: [
          { op: 'add_slide', layout: 'blank' },
          {
            op: 'add_chart',
            slide: 1,
            chartType: 'line',
            categories: ['1월', '2월', '3월'],
            series: [
              { name: 'A', values: [1, 3, 9] },
              { name: 'B', values: [2, 4, 8] },
            ],
          },
          // 'exp' was drawn as a straight line on the first series alone.
          { op: 'set_chart_trendline', slide: 1, shape: 1, type: 'exp' },
          { op: 'set_chart_error_bars', slide: 1, shape: 1, amount: 1, endStyle: 'plus' },
        ],
      },
      { cwd }
    )
  );
  const both = { op: 'set_chart_error_bars', slide: 1, shape: 1, amount: 1, direction: 'both' };
  const refused = await executeOfficeTool({ action: 'batch', session: created.session, operations: [both] }, { cwd });
  assert.match(refused.content[0].text, /direction must be x or y/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(path));
  const part = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const chart = await zip.file(part).async('string');
  assert.equal([...chart.matchAll(/<c:trendlineType val="exp"\/>/g)].length, 2);
  assert.equal([...chart.matchAll(/<c:errBarType val="plus"\/>/g)].length, 2);
});

test('[powerpoint] a named face, a transparency, and paragraph spacing are written as the portable file writes them', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'faces.pptx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'pptx',
        mode: 'background',
        operations: [
          { op: 'add_slide', layout: 'blank' },
          // Font.Name alone set the Latin face; the Hangul stayed in the theme's East Asian font.
          // A text box's fill, outline and description were not read either.
          {
            op: 'add_textbox',
            slide: 1,
            text: '매출 증가',
            fontName: 'Batang',
            properties: { paragraphSpacing: 6, fillColor: 'F2F2F2', lineColor: '1F3A5F', altText: '요약' },
          },
          // The shadow set_shape draws was dropped by add_shape.
          {
            op: 'add_shape',
            slide: 1,
            shapeType: 'rect',
            text: '핵심',
            fillColor: 'EAF2F8',
            properties: { shadow: true },
          },
          // A fraction here: 30 was not the 30% add_shape and the portable writer read.
          {
            op: 'set_shape',
            slide: 1,
            shape: 2,
            properties: { fillTransparency: 30, paragraphSpacing: 4, fontName: 'Batang' },
          },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(path));
  const part = Object.keys(zip.files).find((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const [box, card] = [...(await zip.file(part).async('string')).matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  for (const shape of [box, card]) assert.match(shape, /<a:ea typeface="Batang"/);
  assert.match(box, /<a:spcBef><a:spcPts val="600"\/><\/a:spcBef>/);
  assert.match(box, /descr="요약"/);
  assert.match(
    box,
    /<p:spPr>[\s\S]*<a:solidFill><a:srgbClr val="F2F2F2"\/>[\s\S]*<a:ln\b[^>]*><a:solidFill><a:srgbClr val="1F3A5F"/
  );
  assert.match(card, /<a:spcBef><a:spcPts val="400"\/><\/a:spcBef>/);
  assert.match(card, /<a:srgbClr val="EAF2F8"><a:alpha val="70000"\/>/);
  assert.match(card, /<a:outerShdw blurRad="63500"/);
});

test('[powerpoint] a footer and page number on a dark slide take the portable writer\u2019s quiet ink and place', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'footer.pptx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'pptx',
        mode: 'background',
        operations: [
          { op: 'add_slide', layout: 'blank' },
          { op: 'set_slide_background', slide: 1, color: '172C2C' },
          // The theme's 12 pt grey 767676 read 3.2:1 on this field.
          { op: 'set_footer', slide: 1, text: '모아페이 · 2025 IR' },
          { op: 'set_slide_number', slide: 1, visible: true },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(path));
  const part = Object.keys(zip.files).find((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const shapes = [...(await zip.file(part).async('string')).matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  const footer = shapes.find((shape) => /<p:ph\b[^>]*type="ftr"/.test(shape));
  const number = shapes.find((shape) => /<p:ph\b[^>]*type="sldNum"/.test(shape));
  for (const shape of [footer, number]) {
    assert.match(shape, /\bsz="1000"/);
    assert.match(shape, /<a:srgbClr val="A9B1B9"\/>/);
  }
  assert.match(footer, /<a:off x="736600"/, 'the footer starts 58 pt from the left edge');
  assert.match(number, /<a:off x="10185400"/, 'the number box ends 58 pt from the right edge');
});

test('[powerpoint] a cover picture is cropped about its focus, centred by default', {
  skip: !enabled && 'needs Windows with MIXDOG_TEST_LIVE_OFFICE=1',
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-office-live-'));
  const path = join(cwd, 'cover.pptx');
  t.after(async () => {
    resetOfficeSessionsForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  const { default: sharp } = await import('sharp');
  const wide = join(cwd, 'wide.png');
  await writeFile(
    wide,
    await sharp({ create: { width: 200, height: 100, channels: 3, background: '#2563EB' } })
      .png()
      .toBuffer()
  );
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'pptx',
        mode: 'background',
        operations: [
          { op: 'add_slide', layout: 'blank' },
          // The focus was rounded to 0 or 1, so the crop took the whole excess from the right.
          { op: 'add_image', slide: 1, path: wide, left: 40, top: 40, width: 200, height: 200, fit: 'cover' },
          {
            op: 'add_image',
            slide: 1,
            path: wide,
            left: 300,
            top: 40,
            width: 200,
            height: 200,
            fit: 'cover',
            focusX: 0.3,
          },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(path));
  const part = Object.keys(zip.files).find((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const crops = [...(await zip.file(part).async('string')).matchAll(/<a:srcRect\b[^>]*\/>/g)].map((m) => m[0]);
  assert.match(crops[0], /\bl="25000"/, crops[0]);
  assert.match(crops[0], /\br="25000"/, crops[0]);
  // Half the picture shows; its centre sits at 0.3 of the width: 5% off the left, 45% off the right.
  assert.match(crops[1], /\bl="5000"/, crops[1]);
  assert.match(crops[1], /\br="45000"/, crops[1]);
});
