import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserActionApproval } from './action-approval.ts';

const target = () => ({ url: 'https://fixture.example/', identity: 'session:p1:d1' });
test('action policy denies before asking and rejects invalid policy names', async () => {
  let asks = 0;
  const approval = createBrowserActionApproval({
    denyActions: 'click', confirmActions: '*', ask: async () => { asks++; return true; },
  });
  await assert.rejects(approval.approve({ action: 'sequence', steps: [{ action: 'click' }] }, target), /denied/);
  assert.equal(asks, 0);
  await assert.rejects(createBrowserActionApproval({ denyActions: 'typo', ask: async () => true })
    .approve({ action: 'read' }, target), /invalid/);
});

test('human approval is one-shot and cannot survive cancellation, expiry, target or argument changes', async () => {
  for (const variant of ['allow', 'deny', 'expire', 'target', 'args', 'cancel']) {
    let time = 100;
    let identity = 'p1';
    let asks = 0;
    const command = { action: 'click', ref: 'r1' };
    const controller = new AbortController();
    const approval = createBrowserActionApproval({
      confirmActions: 'click', now: () => time,
      ask: async () => {
        asks++;
        if (variant === 'expire') time += 30_001;
        if (variant === 'target') identity = 'p2';
        if (variant === 'args') command.ref = 'r2';
        if (variant === 'cancel') controller.abort(new Error('cancelled'));
        return variant !== 'deny';
      },
    });
    const run = () => approval.approve(command, () => ({ url: 'https://fixture.example/', identity }), controller.signal);
    if (variant === 'allow') { await run(); await run(); assert.equal(asks, 2); }
    else await assert.rejects(run(), /approval|cancelled/);
  }
});

test('nothing asks by default: upload and shared clear dispatch without a human prompt', async () => {
  let asks = 0;
  const approval = createBrowserActionApproval({ ask: async () => { asks++; return false; } });
  await approval.approve({ action: 'storage', operation: 'clear' }, target);
  await approval.approve({ action: 'cookies', operation: 'clear' }, target);
  await approval.approve({ action: 'upload', paths: ['relative.txt'] }, target);
  await approval.approve({ action: 'read' }, target);
  assert.equal(asks, 0);
});

test('a named confirm policy binds upload approval to real absolute files before asking', async () => {
  let asks = 0;
  const approval = createBrowserActionApproval({
    confirmActions: 'upload', ask: async () => { asks++; return true; },
  });
  await assert.rejects(approval.approve({ action: 'upload', paths: ['relative.txt'] }, target), /absolute/);
  assert.equal(asks, 0);
  await approval.approve({ action: 'storage', operation: 'clear' }, target);
  assert.equal(asks, 0);
});
