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
