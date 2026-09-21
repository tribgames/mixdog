// The portable conversion path keeps one LibreOffice user profile for the life
// of the process and runs conversions through it in order. These drive real
// LibreOffice runs, so they sit in the slow lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import {
  libreOfficeAvailable,
  recalculateLibreOfficeWorkbook,
  renderPortableOoxml,
  validateLibreOfficeReopen,
} from './portable/portable-soffice.mjs';
import { value, workspace } from './office-test-support.mjs';

const RENDERED = { skip: !(await libreOfficeAvailable()) && 'LibreOffice is not installed' };

// A killed or failed run can leave a lock behind in the profile it used, and a
// reused profile would hand that to everything after it. The failed conversion
// drops the profile instead, so the next render builds a clean one.
test('a failed conversion leaves the next render working', RENDERED, async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'recovers.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        mode: 'portable',
        operations: [{ op: 'append_text', text: '복구 확인' }],
      },
      { cwd }
    )
  );
  await assert.rejects(() => renderPortableOoxml(join(cwd, 'absent.docx'), join(cwd, 'absent.pdf')));
  const details = await stat(await renderPortableOoxml(source, join(cwd, 'after.pdf')));
  assert.ok(details.isFile() && details.size > 0);
});

// LibreOffice writes its output under the source's own name, so overlapping
// runs would fight over the same intermediate file, and a shared profile would
// refuse the second process. Both renders must still finish.
test('concurrent portable renders both produce a PDF through the shared profile', RENDERED, async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'queued.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        mode: 'portable',
        operations: [{ op: 'append_text', text: '대기열 렌더링' }],
      },
      { cwd }
    )
  );
  const outputs = [join(cwd, 'first.pdf'), join(cwd, 'second.pdf')];
  const rendered = await Promise.all(outputs.map((output) => renderPortableOoxml(source, output)));
  assert.deepEqual(rendered, outputs);
  for (const output of outputs) {
    const details = await stat(output);
    assert.ok(details.isFile() && details.size > 0, output);
  }
});

// LibreOffice names what it converts after the source it read, minus the
// source's own extension: a document named `reopen.check.docx` comes back as
// `reopen.check.pdf`. Every caller finds its output by rebuilding that name,
// and a wrong name reads as "LibreOffice produced nothing".
test('a reopen validation finds the PDF named after the source', RENDERED, async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'reopen.check.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        mode: 'portable',
        operations: [{ op: 'append_text', text: '재열기 확인' }],
      },
      { cwd }
    )
  );
  const reopened = await validateLibreOfficeReopen(source);
  assert.equal(reopened.available, true);
  assert.equal(reopened.opened, true);
  assert.equal(reopened.backend, 'libreoffice');
  assert.ok(reopened.outputBytes > 0);
});

test('a recalculation reads back the workbook named after the source', RENDERED, async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'recalculate.check.xlsx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        mode: 'portable',
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
          { op: 'set_formula', cell: 'B4', formula: '=SUM(B2:B3)' },
        ],
      },
      { cwd }
    )
  );
  const recalculated = await recalculateLibreOfficeWorkbook(source, { force: true });
  assert.equal(recalculated.available, true);
  assert.equal(recalculated.recalculated, true);
  assert.ok(recalculated.outputBytes > 0);
});
