import assert from 'node:assert/strict';
import test from 'node:test';

import { formActions } from './forms.ts';

/** A fill context whose only live service is the stored-login bridge; the
 *  handler must never touch refs or the page for a savedAccount fill. */
function credentialContext(fillResult, command) {
  const calls = { accounts: [], keys: [], invalidated: 0, snapshots: 0 };
  const guest = { id: 7 };
  const context = {
    guest,
    command: { action: 'fill', ...command },
    action: 'fill',
    refRecovery: {},
    services: {
      credentials: {
        fillStored: async (target, account) => {
          assert.equal(target, guest);
          calls.accounts.push(account);
          return fillResult;
        },
      },
      state: {
        invalidateInteraction: () => {
          calls.invalidated += 1;
        },
      },
      input: {
        pressKey: async (_guest, key) => {
          calls.keys.push(key);
        },
      },
      reply: { decorateRecovery: (result) => result },
      refActions: new Proxy(
        {},
        {
          get: () => {
            throw new Error('ref actions must not run for a stored login');
          },
        }
      ),
      targets: {
        resolveTargetRefs: async () => {
          throw new Error('targets must not resolve for a stored login');
        },
      },
    },
    actionSnapshot: async () => {
      calls.snapshots += 1;
      return { text: 'snapshot' };
    },
  };
  return { context, calls };
}

test('savedAccount hands the account to the host and reports only the settled page', async () => {
  const { context, calls } = credentialContext(
    { usernameFilled: true, passwordFilled: true },
    { savedAccount: 'ada@example.test' }
  );
  const result = await formActions.fill(context);
  assert.deepEqual(calls.accounts, ['ada@example.test']);
  assert.deepEqual(calls.keys, [], 'no submit unless asked');
  assert.equal(calls.invalidated, 1);
  assert.equal(calls.snapshots, 1);
  assert.equal(result.text, 'snapshot');
});

test('savedAccount with submit presses Enter after the host filled the form', async () => {
  const { context, calls } = credentialContext(
    { usernameFilled: false, passwordFilled: true },
    { savedAccount: 'a•••a@example.test', submit: true }
  );
  await formActions.fill(context);
  assert.deepEqual(calls.keys, ['enter']);
});

test('a page without a password field is reported instead of claimed filled', async () => {
  const { context, calls } = credentialContext(
    { usernameFilled: false, passwordFilled: false, reason: 'no-password-field' },
    { savedAccount: 'ada@example.test', submit: true }
  );
  await assert.rejects(formActions.fill(context), /no visible password field/);
  assert.deepEqual(calls.keys, [], 'a failed fill never submits');
  assert.equal(calls.snapshots, 0);
});

test('a host lookup failure surfaces its masked-label guidance unchanged', async () => {
  const { context } = credentialContext(undefined, { savedAccount: 'nobody@example.test' });
  context.services.credentials.fillStored = async () => {
    throw new Error(
      'savedAccount "nobody@example.test" is not a stored login for https://example.test; stored: a•••a@example.test'
    );
  };
  await assert.rejects(formActions.fill(context), /stored: a•••a@example\.test/);
});

test('savedAccount passes cancellation through and never submits after takeover', async () => {
  const controller = new AbortController();
  const reason = new Error('user took control');
  const { context, calls } = credentialContext(undefined, { savedAccount: 'ada@example.test', submit: true });
  context.signal = controller.signal;
  context.services.credentials.fillStored = async (_guest, _account, signal) => {
    assert.equal(signal, controller.signal);
    controller.abort(reason);
    return { usernameFilled: true, passwordFilled: true };
  };
  await assert.rejects(formActions.fill(context), (error) => error === reason);
  assert.deepEqual(calls.keys, []);
  assert.equal(calls.snapshots, 0);
  context.services.credentials.fillStored = async () => assert.fail('an already-cancelled fill must not start');
  await assert.rejects(formActions.fill(context), (error) => error === reason);
});

test('partial multi-field failure reports completed inputs and a fresh observation without replay', async () => {
  const writes = [];
  let observed = 0;
  const context = {
    guest: {},
    command: { action: 'fill', fields: ['first', 'second', 'third'].map((ref) => ({ ref, text: ref })) },
    refRecovery: {},
    services: {
      state: { invalidateInteraction() {} },
      reply: {
        withRefRecovery: async (_guest, _recovery, ref, operation) => operation(ref),
        snapshotResult: async (_guest, command) => {
          observed++;
          assert.equal(command.action, 'snapshot');
          return { text: 'First=first; second disabled; third empty' };
        },
      },
      refActions: {
        prepareRef: async (_guest, ref) => {
          if (ref === 'second') throw new Error('element is disabled');
          return ref;
        },
        fillRef: async (_guest, ref, text) => writes.push([ref, text]),
      },
    },
  };
  await assert.rejects(
    formActions.fill(context),
    /field 2 of 3; 1 field\(s\) completed[\s\S]*not replayed[\s\S]*element is disabled[\s\S]*First=first/
  );
  assert.deepEqual(writes, [['first', 'first']]);
  assert.equal(observed, 1);
});

test('a sensitive fill registers its code before the page sees it; no reply or later snapshot repeats it', async (t) => {
  const { secretInputs } = await import('../../secret-input.ts');
  const { guardBrowserSecrets } = await import('../agent-bridge.ts');
  const { rememberForSession } = await import('../credential-fill-host.ts');
  const { createBrowserRefActions } = await import('../ref-actions.ts');
  const CODE = '682419';
  const session = 'sess-verification-code';
  t.after(() => secretInputs.forget(session));
  // The page echoes the field's value, as a non-password snapshot does.
  const page = `- textbox "Verification code" [ref=p1-s1-e3] value=${CODE}`;
  const run = async (sensitive) => {
    let registeredFirst;
    // The toolkit's wiring (command-toolkit.ts): a value the host fills is remembered for the page's session.
    const toolkit = createBrowserRefActions({
      rememberSecret: (guest, value) => rememberForSession({ sessionIdForGuest: () => session }, guest, value),
    });
    const command = { action: 'fill', ref: 'p1-s1-e3', text: CODE, session_id: session, ...(sensitive ? { sensitive } : {}) };
    const context = {
      guest: {},
      command,
      refRecovery: {},
      services: {
        state: { invalidateInteraction() {} },
        reply: { withRefRecovery: async (_guest, _recovery, ref) => ref, decorateRecovery: (result) => result },
        refActions: {
          ...toolkit,
          fillRef: async () => {
            registeredFirst = secretInputs.secretsOf(session).includes(CODE);
          },
        },
      },
      actionSnapshot: async () => ({ text: page }),
    };
    const signal = new AbortController().signal;
    const reply = await guardBrowserSecrets(command, signal, () => formActions.fill(context));
    const next = await guardBrowserSecrets({ action: 'snapshot', session_id: session }, signal, async () => ({ text: page }));
    return { registeredFirst, reply: reply.text, next: next.text };
  };

  const plain = await run(false);
  assert.match(plain.reply, new RegExp(CODE), 'an ordinary fill keeps the page text as it is');
  const marked = await run(true);
  assert.equal(marked.registeredFirst, true, 'registered before the field was filled');
  for (const text of [marked.reply, marked.next]) {
    assert.doesNotMatch(text, new RegExp(CODE));
    assert.match(text, /value=\[redacted\]/);
  }
});
