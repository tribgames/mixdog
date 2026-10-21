import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { browserNotApproved, createBrowserActionApproval } from './action-approval.ts';

const target = () => ({ url: 'https://fixture.example/', identity: 'session:p1:d1' });
test('action policy denies before asking and rejects invalid policy names', async () => {
  let asks = 0;
  const approval = createBrowserActionApproval({
    denyActions: 'click',
    confirmActions: '*',
    ask: async () => {
      asks++;
      return true;
    },
  });
  await assert.rejects(approval.approve({ action: 'sequence', steps: [{ action: 'click' }] }, target), /denied/);
  assert.equal(asks, 0);
  await assert.rejects(
    createBrowserActionApproval({ denyActions: 'typo', ask: async () => true }).approve({ action: 'read' }, target),
    /invalid/
  );
});

test('a run command (runtime-set unattended_run) tells the host it belongs to a schedule/webhook run', async () => {
  const seen = [];
  const approval = createBrowserActionApproval({
    ask: async (request) => {
      seen.push([request.unattended, request.unattendedAgent]);
      return true;
    },
  });
  await approval.approve(
    { action: 'click', target: { name: 'Send' }, unattended_run: true, unattended_agent: 'mailer' },
    target
  );
  await approval.approve({ action: 'click', target: { name: 'Send' }, unattended_run: true }, target);
  await approval.approve({ action: 'click', target: { name: 'Send' }, unattended_agent: 'mailer' }, target);
  await approval.approve({ action: 'click', target: { name: 'Send' } }, target);
  assert.deepEqual(seen, [
    [true, 'mailer'],
    [true, ''],
    [undefined, undefined],
    [undefined, undefined],
  ]);
});

test('human approval is one-shot and cannot survive cancellation, target or argument changes', async () => {
  for (const variant of ['allow', 'deny', 'target', 'args', 'cancel']) {
    let identity = 'p1';
    let asks = 0;
    const command = { action: 'click', ref: 'r1' };
    const controller = new AbortController();
    const approval = createBrowserActionApproval({
      confirmActions: 'click',
      ask: async () => {
        asks++;
        if (variant === 'target') identity = 'p2';
        if (variant === 'args') command.ref = 'r2';
        if (variant === 'cancel') controller.abort(new Error('cancelled'));
        return variant !== 'deny';
      },
    });
    const run = () =>
      approval.approve(command, () => ({ url: 'https://fixture.example/', identity }), controller.signal);
    if (variant === 'allow') {
      await run();
      await run();
      assert.equal(asks, 2);
    } else {
      const refusal =
        { deny: /was not approved\./, cancel: /cancelled/ }[variant] || /target changed; nothing was dispatched/;
      await assert.rejects(run(), refusal, variant);
    }
  }
});

test('a human approval has no time limit: pending long after 30 s, honoured when the page is unchanged', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const answer = Promise.withResolvers();
  let shown;
  const approval = createBrowserActionApproval({
    confirmActions: 'click',
    ask: (request) => {
      shown = request;
      return answer.promise;
    },
  });
  let settled = false;
  const run = approval.approve({ action: 'click', ref: 'r1' }, target).finally(() => {
    settled = true;
  });
  assert.equal('expiresAt' in shown, false, 'the request carries no expiry');
  t.mock.timers.tick(31_000);
  await Promise.resolve();
  assert.equal(settled, false, 'still waiting past the old 30 s limit');
  t.mock.timers.tick(6 * 60 * 60_000);
  await Promise.resolve();
  assert.equal(settled, false, 'still waiting hours later');
  answer.resolve(true);
  await run;
});

for (const change of ['document', 'url', 'arguments']) {
  test(`a page that changed during a long wait (${change}) is still refused at dispatch`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    const answer = Promise.withResolvers();
    const page = { url: 'https://fixture.example/', identity: 'session:p1:d1' };
    const command = { action: 'click', ref: 'r1' };
    const approval = createBrowserActionApproval({ confirmActions: 'click', ask: () => answer.promise });
    const refused = assert.rejects(
      approval.approve(command, () => ({ ...page })),
      /target changed; nothing was dispatched/
    );
    t.mock.timers.tick(10 * 60_000);
    if (change === 'document') page.identity = 'session:p1:d2';
    if (change === 'url') page.url = 'https://elsewhere.example/';
    if (change === 'arguments') command.ref = 'r2';
    answer.resolve(true);
    await refused;
  });
}

test('an upload whose receiving frame changed during a long wait is still refused at dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const answer = Promise.withResolvers();
  const asked = Promise.withResolvers();
  let receiver = { key: 's1\nhttps://a.example/frame', url: 'https://a.example/frame' };
  const approval = createBrowserActionApproval({
    ask: () => {
      asked.resolve();
      return answer.promise;
    },
  });
  const refused = assert.rejects(
    approval.approve(
      { action: 'upload', ref: 'r1', paths: [process.execPath] },
      target,
      undefined,
      async () => receiver
    ),
    /target changed; nothing was dispatched/
  );
  await asked.promise;
  t.mock.timers.tick(10 * 60_000);
  receiver = { key: 's1\nhttps://b.example/frame', url: 'https://b.example/frame' };
  answer.resolve(true);
  await refused;
});

test('the command clock stands still while the person is asked, and runs again after', async () => {
  const states = [];
  const answer = Promise.withResolvers();
  const userWait = {
    begin() {
      states.push('asking');
      return () => states.push('answered');
    },
  };
  const approval = createBrowserActionApproval({
    confirmActions: 'click',
    ask: () => {
      assert.deepEqual(states, ['asking'], 'the wait starts before the card is shown');
      return answer.promise;
    },
  });
  const run = approval.approve({ action: 'click', ref: 'r1' }, target, undefined, undefined, userWait);
  answer.resolve(true);
  await run;
  assert.deepEqual(states, ['asking', 'answered']);
  // A refusal and a cancelled ask end the wait too.
  const failing = createBrowserActionApproval({
    confirmActions: 'click',
    ask: async () => {
      throw new Error('window closed');
    },
  });
  await assert.rejects(
    failing.approve({ action: 'click', ref: 'r1' }, target, undefined, undefined, userWait),
    /closed/
  );
  assert.deepEqual(states, ['asking', 'answered', 'asking', 'answered']);
});

test('approval identifies a named action target instead of the page identity', async () => {
  let shown;
  const approval = createBrowserActionApproval({
    confirmActions: 'click',
    ask: async (request) => {
      shown = request;
      return true;
    },
  });
  await approval.approve(
    {
      action: 'click',
      target: { role: 'button', name: 'Delete account', exact: true },
    },
    target
  );
  assert.equal(shown.action, 'click');
  assert.equal(shown.target, 'button "Delete account" (exact)');
  assert.equal(shown.url, target().url);
});

test('approval masks credentials in named and selector targets without exposing typed input', async () => {
  const shown = [];
  const approval = createBrowserActionApproval({
    confirmActions: 'fill',
    ask: async (request) => {
      shown.push(request);
      return true;
    },
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
    confirmActions: 'click',
    ask: async (request) => {
      shown = request;
      return true;
    },
  });
  await approval.approve(
    {
      action: 'sequence',
      steps: [
        { action: 'fill', target: { name: 'Password' }, text: 'private-password' },
        { action: 'select', target: { name: 'Recovery method' }, values: ['private-choice'] },
        { action: 'fill', ref: 'p1-s2-e3', savedAccount: 'private-account', submit: true },
        { action: 'click', target: { name: 'Delete account', exact: true } },
        { action: 'click', target: { selector: 'a[href="https://fixture.example/?token=nested-secret"]' } },
      ],
    },
    target
  );
  assert.equal(shown.action, 'sequence');
  assert.match(
    shown.target,
    /^1\. fill: "Password"\n2\. select: "Recovery method"\n3\. fill \(submit\): p1-s2-e3\n4\. click: "Delete account" \(exact\)\n5\. click: selector /
  );
  assert.match(shown.target, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(shown), /private-password|private-choice|private-account|nested-secret/);
});

test('batch fill approval lists all targets or refs and explicit submission, but no field values', async () => {
  const shown = [];
  const approval = createBrowserActionApproval({
    confirmActions: 'fill',
    ask: async (request) => {
      shown.push(request);
      return true;
    },
  });
  await approval.approve(
    {
      action: 'fill',
      submit: true,
      fields: [
        { target: { name: 'Password' }, text: 'private-text' },
        { target: { role: 'textbox', name: 'Recovery code' }, value: 'private-value' },
        { target: { name: 'Recovery method' }, values: ['private-choice'] },
        { target: { selector: 'input[data-token="nested-secret"]' }, checked: true },
      ],
    },
    target
  );
  await approval.approve(
    {
      action: 'fill',
      fields: [
        { ref: 'p1-s2-e1', text: 'private-text' },
        { ref: 'p1-s2-e2', checked: false },
      ],
    },
    target
  );
  assert.match(
    shown[0].target,
    /^1\. fill: "Password"\n2\. fill: textbox "Recovery code"\n3\. fill: "Recovery method"\n4\. fill: selector /
  );
  assert.match(shown[0].target, /REDACTED/);
  assert.match(shown[0].target, /\nSubmit form$/);
  assert.equal(shown[1].target, '1. fill: p1-s2-e1\n2. fill: p1-s2-e2');
  assert.doesNotMatch(JSON.stringify(shown), /private-text|private-value|private-choice|nested-secret/);
});

test('nested approval descriptions do not weaken cancellation or command binding', async () => {
  for (const variant of ['step', 'field', 'cancel', 'deny']) {
    const controller = new AbortController();
    const command =
      variant === 'field'
        ? { action: 'fill', fields: [{ target: { name: 'Password' }, text: 'private-text' }] }
        : {
            action: 'sequence',
            steps: [
              { action: 'fill', ref: 'p1-s2-e1', text: 'private-text' },
              { action: 'click', target: { name: 'Save' } },
            ],
          };
    const approval = createBrowserActionApproval({
      confirmActions: '*',
      ask: async () => {
        if (variant === 'step') command.steps[1].target.name = 'Delete account';
        if (variant === 'field') command.fields[0].text = 'changed-private-text';
        if (variant === 'cancel') controller.abort(new Error('approval cancelled'));
        return variant !== 'deny';
      },
    });
    const refusal = { deny: /was not approved\./, cancel: /approval cancelled/ }[variant] || /target changed/;
    await assert.rejects(approval.approve(command, target, controller.signal), refusal, variant);
  }
});

test('submitting and posting ask by default; the opt-out turns only that default off', async () => {
  const asked = [];
  const approval = createBrowserActionApproval({
    ask: async (request) => {
      asked.push(request.action);
      return true;
    },
  });
  await approval.approve({ action: 'fill', ref: 'p1-s1-e1', text: 'x', submit: true }, target);
  await approval.approve({ action: 'press', key: 'Enter' }, target);
  await approval.approve({ action: 'click', target: { role: 'button', name: 'Post comment' } }, target);
  await approval.approve(
    { action: 'sequence', steps: [{ action: 'type', ref: 'r', text: 'a', submit: true }] },
    target
  );
  assert.deepEqual(asked, ['fill', 'press', 'click', 'sequence']);
  await approval.approve({ action: 'click', target: { role: 'button', name: 'Open menu' } }, target);
  await approval.approve({ action: 'press', key: 'Tab' }, target);
  assert.equal(asked.length, 4, 'other gestures still run without a prompt');
  const denied = createBrowserActionApproval({ ask: async () => false });
  await assert.rejects(
    denied.approve({ action: 'press', key: 'Enter' }, target),
    (error) => error.message === browserNotApproved()
  );
  const off = createBrowserActionApproval({ confirmSubmit: false, ask: async () => assert.fail('no prompt') });
  await off.approve({ action: 'press', key: 'Enter' }, target);
});

test('a denial reaches the agent in the wording of every tool denial; a changed page is not called a denial', async () => {
  assert.equal(
    browserNotApproved(' use the other form.  '),
    'tool "browser" was not approved: use the other form. Do not retry it or reach the same result another way; report it.'
  );
  for (const none of [undefined, '', '   ', '.']) {
    assert.equal(
      browserNotApproved(none),
      'tool "browser" was not approved. Do not retry it or reach the same result another way; report it.'
    );
  }
  const denied = createBrowserActionApproval({ ask: async () => false });
  await assert.rejects(
    denied.approve({ action: 'press', key: 'Enter' }, target),
    /^Error: tool "browser" was not approved\. Do not retry it or reach the same result another way; report it\.$/
  );
  let url = 'https://fixture.example/';
  const moved = createBrowserActionApproval({
    ask: async () => {
      url = 'https://other.example/';
      return true;
    },
  });
  await assert.rejects(
    moved.approve({ action: 'press', key: 'Enter' }, () => ({ url, identity: 'session:p1:d1' })),
    (error) =>
      /target changed; nothing was dispatched/.test(error.message) && !/denied|not approved/.test(error.message)
  );
});

test('nothing else asks by default: shared clear and reads dispatch without a human prompt', async () => {
  let asks = 0;
  const approval = createBrowserActionApproval({
    ask: async () => {
      asks++;
      return false;
    },
  });
  await approval.approve({ action: 'storage', operation: 'clear' }, target);
  await approval.approve({ action: 'cookies', operation: 'clear' }, target);
  await approval.approve({ action: 'read' }, target);
  assert.equal(asks, 0);
});

test('an upload asks by default with its files; the harness switch turns that default off', async () => {
  const shown = [];
  const approval = createBrowserActionApproval({
    ask: async (request) => {
      shown.push(request);
      return true;
    },
  });
  await approval.approve({ action: 'upload', ref: 'p1-s1-e1', paths: [process.execPath] }, target);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].kinds, ['upload']);
  assert.equal(shown[0].files.length, 1);
  assert.equal(shown[0].files[0].path, shown[0].paths[0]);
  assert.ok(shown[0].files[0].size > 0);
  await assert.rejects(
    createBrowserActionApproval({ ask: async () => false }).approve(
      { action: 'upload', paths: [process.execPath] },
      target
    ),
    (error) => error.message === browserNotApproved()
  );
  await assert.rejects(
    createBrowserActionApproval({ ask: async () => assert.fail('asked') }).approve(
      { action: 'upload', paths: ['relative.txt'] },
      target
    ),
    /absolute/
  );
  const off = createBrowserActionApproval({ confirmSubmit: false, ask: async () => assert.fail('no prompt') });
  await off.approve({ action: 'upload', paths: ['relative.txt'] }, target);
  await off.approve({ action: 'upload', paths: [process.execPath] }, target);
});

test('an upload card gets the receiving frame origin, empty when it cannot be confirmed', async () => {
  const originOf = async (receiver) => {
    let shown;
    const approval = createBrowserActionApproval({
      ask: async (request) => {
        shown = request;
        return true;
      },
    });
    await approval.approve({ action: 'upload', ref: 'r1', paths: [process.execPath] }, target, undefined, receiver);
    return shown.receiverOrigin;
  };
  const receiver = (url) => async () => ({ key: `s\n${url}`, url });
  assert.equal(
    await originOf(receiver('https://uploads.other.example/widget?token=x')),
    'https://uploads.other.example'
  );
  assert.equal(
    await originOf(receiver('https://fixture.example/inner')),
    'https://fixture.example',
    'same origin is still confirmed'
  );
  assert.equal(await originOf(receiver('about:blank')), '', 'no tuple origin');
  assert.equal(await originOf(undefined), '', 'no way to resolve it');
});

test('an upload approval is bound to the receiving frame: a changed frame refuses, an unchanged one hands the key on', async () => {
  for (const variant of ['same', 'url', 'session', 'gone']) {
    let calls = 0;
    const approval = createBrowserActionApproval({ ask: async () => true });
    const run = approval.approve(
      { action: 'upload', ref: 'r1', paths: [process.execPath] },
      target,
      undefined,
      async () => {
        calls++;
        if (calls === 1 || variant === 'same')
          return { key: 's1\nhttps://a.example/frame', url: 'https://a.example/frame' };
        if (variant === 'gone') throw new Error('ref r1 is stale');
        return variant === 'url'
          ? { key: 's1\nhttps://b.example/frame', url: 'https://b.example/frame' }
          : { key: 's2\nhttps://a.example/frame', url: 'https://a.example/frame' };
      }
    );
    if (variant === 'same') assert.deepEqual(await run, { receiver: 's1\nhttps://a.example/frame' });
    else await assert.rejects(run, variant === 'gone' ? /stale/ : /target changed; nothing was dispatched/, variant);
  }
});

test('an upload resolves its target before asking, so the command the person approves already holds the ref', async () => {
  const command = { action: 'upload', target: { role: 'button', name: 'Attach' }, paths: [process.execPath] };
  let shownRef;
  const approval = createBrowserActionApproval({
    ask: async (request) => {
      shownRef = command.ref;
      assert.equal(request.target, 'button "Attach"');
      return true;
    },
  });
  await approval.approve(command, target, undefined, async () => {
    command.ref ||= 'p1-s1-e9';
    return { key: 's\nhttps://x.example/', url: 'https://x.example/' };
  });
  assert.equal(shownRef, 'p1-s1-e9');
});
test('an upload binds its files: one that changes after approval is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upload-approval-'));
  try {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'one');
    const approval = createBrowserActionApproval({
      ask: async () => {
        writeFileSync(file, 'changed after approval');
        return true;
      },
    });
    await assert.rejects(
      approval.approve({ action: 'upload', paths: [file] }, target),
      /approved upload file changed; nothing was dispatched/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a named confirm policy binds upload approval to real absolute files before asking', async () => {
  let asks = 0;
  const approval = createBrowserActionApproval({
    confirmActions: 'upload',
    ask: async () => {
      asks++;
      return true;
    },
  });
  await assert.rejects(approval.approve({ action: 'upload', paths: ['relative.txt'] }, target), /absolute/);
  assert.equal(asks, 0);
  await approval.approve({ action: 'storage', operation: 'clear' }, target);
  assert.equal(asks, 0);
});

test('a request names its kinds: form submits, send/post clicks and operator-confirmed actions stay apart', async () => {
  const kindsOf = async (command, options = {}) => {
    let kinds;
    const approval = createBrowserActionApproval({
      ...options,
      ask: async (request) => {
        kinds = request.kinds;
        return true;
      },
    });
    await approval.approve(command, target);
    return kinds;
  };
  assert.deepEqual(await kindsOf({ action: 'press', key: 'Enter' }), ['submit']);
  assert.deepEqual(await kindsOf({ action: 'fill', fields: [], submit: true }), ['submit']);
  assert.deepEqual(await kindsOf({ action: 'click', target: { name: 'Send message' } }), ['post']);
  assert.deepEqual(
    await kindsOf({
      action: 'sequence',
      steps: [
        { action: 'press', key: 'Enter' },
        { action: 'click', target: { name: 'Post' } },
      ],
    }),
    ['submit', 'post']
  );
  assert.deepEqual(await kindsOf({ action: 'click', ref: 'r1' }, { confirmActions: 'click' }), ['confirm']);
  assert.deepEqual(await kindsOf({ action: 'press', key: 'Enter' }, { confirmActions: 'press' }), [
    'submit',
    'confirm',
  ]);
  assert.deepEqual(await kindsOf({ action: 'upload', paths: [process.execPath] }), ['upload']);
  assert.deepEqual(
    await kindsOf({ action: 'upload', paths: [process.execPath] }, { confirmActions: 'upload' }),
    ['upload', 'confirm'],
    'an operator-listed upload also always asks: confirm cannot be remembered'
  );
  assert.deepEqual(
    await kindsOf({ action: 'upload', paths: [process.execPath] }, { confirmActions: 'upload', confirmSubmit: false }),
    ['confirm'],
    'with the default off, only the operator policy asks'
  );
});
