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

test('a prompt keeps its full default only when a person accepted it untouched, never on equal text', async () => {
  const bodies = [];
  const record = {};
  const service = createBrowserDialogReport({
    diagnostics: () => record,
    cdp: {
      call: async (_guest, _method, params, _signal, options) => {
        options.beforeDispatch();
        bodies.push(JSON.parse(Buffer.from(String(params.body), 'base64').toString('utf8')));
      },
    },
  });
  const ask = () => {
    record.pendingDialog = { type: 'prompt', defaultPrompt: 'x'.repeat(2_000), bridgeRequestId: 'r1' };
  };
  ask();
  await service.handleDialog({}, true, 'x'.repeat(2_000), undefined, undefined, true);
  ask();
  // The same text sent deliberately (an agent's literal answer) stays literal.
  await service.handleDialog({}, true, 'x'.repeat(2_000));
  ask();
  await service.handleDialog({}, false, '', undefined, undefined, true);
  assert.deepEqual(
    bodies.map((body) => body.keepDefault === true),
    [true, false, false]
  );
});
