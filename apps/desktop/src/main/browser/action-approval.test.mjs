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

test('approval identifies a named action target instead of the page identity', async () => {
  let shown;
  const approval = createBrowserActionApproval({
    confirmActions: 'click', ask: async (request) => { shown = request; return true; },
  });
  await approval.approve({
    action: 'click', target: { role: 'button', name: 'Delete account', exact: true },
  }, target);
  assert.equal(shown.action, 'click');
  assert.equal(shown.target, 'button "Delete account" (exact)');
  assert.equal(shown.url, target().url);
});

test('approval masks credentials in named and selector targets without exposing typed input', async () => {
  const shown = [];
  const approval = createBrowserActionApproval({
    confirmActions: 'fill', ask: async (request) => { shown.push(request); return true; },
  });
  for (const spec of [
    { name: 'Open https://fixture.example/?token=approval-secret' },
    { selector: 'a[href="https://fixture.example/?token=approval-secret"]' },
    { role: 'textbox', name: 'Password' },
  ]) {
    await approval.approve({ action: 'fill', target: spec, text: 'typed-private-value' }, target);
  }
  assert.match(shown[0].target, /REDACTED/);
  assert.match(shown[1].target, /REDACTED/);
  assert.equal(shown[2].target, 'textbox "Password"');
  assert.doesNotMatch(JSON.stringify(shown), /approval-secret|typed-private-value/);
});

test('changing the named target after its description is approved refuses dispatch', async () => {
  const command = { action: 'click', target: { role: 'button', name: 'Save', exact: true } };
  const approval = createBrowserActionApproval({
    confirmActions: 'click',
    ask: async (request) => {
      assert.equal(request.target, 'button "Save" (exact)');
      command.target.name = 'Delete account';
      return true;
    },
  });
  await assert.rejects(approval.approve(command, target), /target changed; nothing was dispatched/);
});

test('sequence approval describes every action and target without showing input secrets', async () => {
  let shown;
  const approval = createBrowserActionApproval({
    confirmActions: 'click', ask: async (request) => { shown = request; return true; },
  });
  await approval.approve({
    action: 'sequence',
    steps: [
      { action: 'fill', target: { name: 'Password' }, text: 'private-password' },
      { action: 'select', target: { name: 'Recovery method' }, values: ['private-choice'] },
      { action: 'fill', ref: 'p1-s2-e3', savedAccount: 'private-account', submit: true },
      { action: 'click', target: { name: 'Delete account', exact: true } },
      { action: 'click', target: { selector: 'a[href="https://fixture.example/?token=nested-secret"]' } },
    ],
  }, target);
  assert.equal(shown.action, 'sequence');
  assert.match(shown.target, /^1\. fill: "Password"\n2\. select: "Recovery method"\n3\. fill \(submit\): p1-s2-e3\n4\. click: "Delete account" \(exact\)\n5\. click: selector /);
  assert.match(shown.target, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(shown), /private-password|private-choice|private-account|nested-secret/);
});

test('batch fill approval lists all targets or refs and explicit submission, but no field values', async () => {
  const shown = [];
  const approval = createBrowserActionApproval({
    confirmActions: 'fill', ask: async (request) => { shown.push(request); return true; },
  });
  await approval.approve({
    action: 'fill', submit: true, fields: [
      { target: { name: 'Password' }, text: 'private-text' },
      { target: { role: 'textbox', name: 'Recovery code' }, value: 'private-value' },
      { target: { name: 'Recovery method' }, values: ['private-choice'] },
      { target: { selector: 'input[data-token="nested-secret"]' }, checked: true },
    ],
  }, target);
  await approval.approve({
    action: 'fill', fields: [{ ref: 'p1-s2-e1', text: 'private-text' }, { ref: 'p1-s2-e2', checked: false }],
  }, target);
  assert.match(shown[0].target, /^1\. fill: "Password"\n2\. fill: textbox "Recovery code"\n3\. fill: "Recovery method"\n4\. fill: selector /);
  assert.match(shown[0].target, /REDACTED/);
  assert.match(shown[0].target, /\nSubmit form$/);
  assert.equal(shown[1].target, '1. fill: p1-s2-e1\n2. fill: p1-s2-e2');
  assert.doesNotMatch(JSON.stringify(shown), /private-text|private-value|private-choice|nested-secret/);
});

test('nested approval descriptions do not weaken cancellation or command binding', async () => {
  for (const variant of ['step', 'field', 'cancel', 'deny']) {
    const controller = new AbortController();
    const command = variant === 'field'
      ? { action: 'fill', fields: [{ target: { name: 'Password' }, text: 'private-text' }] }
      : { action: 'sequence', steps: [{ action: 'fill', ref: 'p1-s2-e1', text: 'private-text' }, { action: 'click', target: { name: 'Save' } }] };
    const approval = createBrowserActionApproval({
      confirmActions: '*', ask: async () => {
        if (variant === 'step') command.steps[1].target.name = 'Delete account';
        if (variant === 'field') command.fields[0].text = 'changed-private-text';
        if (variant === 'cancel') controller.abort(new Error('approval cancelled'));
        return variant !== 'deny';
      },
    });
    await assert.rejects(approval.approve(command, target, controller.signal), /approval.*(?:denied|cancelled)/);
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
