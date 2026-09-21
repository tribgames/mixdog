import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { executeOfficeTool } from '../index.mjs';
import { value, workspace } from '../office-test-support.mjs';

test('initial tabular batches keep session identity and the source document when snapshots are omitted', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'table.csv');
  const output = join(cwd, 'edited.csv');
  const created = value(
    await executeOfficeTool(
      { action: 'create', path: source, operations: [{ op: 'append_row', values: ['original'] }] },
      { cwd }
    )
  );
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output,
        mode: 'portable',
        operations: [{ op: 'append_row', values: ['edited'] }],
      },
      { cwd }
    )
  );

  for (const [result, path, isCreate] of [
    [created, source, true],
    [opened, output, false],
  ]) {
    assert.match(result.session, /^office_[0-9a-f]{16}$/);
    assert.equal(result.mode, 'portable');
    assert.equal(result.backend, 'mixdog-tabular');
    assert.equal(result.fileKind, 'csv');
    assert.equal(result.source, source);
    assert.equal(result.output, path);
    assert.equal(result.ownership, isCreate ? 'owned' : undefined);
    assert.equal(result.visible, isCreate ? false : undefined);
    assert.equal(result.foregroundActivated, false);
    assert.equal(result.backgroundIsolation, null);
    assert.equal(result.opened, true);
    assert.equal(result.created, isCreate);
    assert.equal(result.reused, false);
    assert.equal(result.batch.saved, true);
    for (const omitted of ['appPid', 'windowHwnd', 'documentId', 'document']) {
      assert.equal(Object.hasOwn(result, omitted), false, omitted);
    }
  }
  assert.notEqual(opened.session, created.session);
  assert.deepEqual(created.artifacts, [
    { type: 'spreadsheet', format: 'csv', fileKind: 'csv', operation: 'create', path: source },
  ]);
  assert.equal(await readFile(source, 'utf8'), 'original\r\n');
  assert.equal(await readFile(output, 'utf8'), 'original\r\nedited\r\n');
});
