import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserDialogReport } from './dialog-report.ts';

test('concurrent answers dispatch once and completion cannot erase a replacement dialog', async () => {
  const record = { pendingDialog: { type: 'confirm' } };
  const { promise, resolve: finish } = Promise.withResolvers();
  let sent = 0;
  const service = createBrowserDialogReport({
    diagnostics: () => record,
    cdp: {
      call: async (_guest, _method, _params, _signal, options) => {
        options.beforeDispatch();
        sent++;
        await promise;
      },
    },
  });
  const first = service.handleDialog({}, true, '');
  await assert.rejects(service.handleDialog({}, false, ''), /already being answered/);
  const replacement = { type: 'alert' };
  record.pendingDialog = replacement;
  finish();
  await first;
  assert.equal(sent, 1);
  assert.equal(record.pendingDialog, replacement);
});
