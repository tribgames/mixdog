import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVELOPER_SECTIONS } from '../../../../../src/runtime/shared/developer-options.mjs';
import { createDeveloperSettings } from '../../../../../src/session-runtime/settings-developer-api.mjs';
import { assertRemoteCapabilityCall } from '../remote-methods.ts';
import { DIRECT_PHONE_CONNECTION_OPTION, directPhoneConnectionStored, readDirectPhoneConnection } from './switch.ts';

const withOption = (value) => ({ agent: { developer: { [DIRECT_PHONE_CONNECTION_OPTION]: value } } });

test('the switch is a registered developer option', () => {
  const option = DEVELOPER_SECTIONS.flatMap((section) => section.options).find(
    (entry) => entry.id === DIRECT_PHONE_CONNECTION_OPTION
  );
  assert.equal(option?.label, 'Direct phone connection (test)');
  assert.ok(option.warning, 'it carries a warning');
});

test('off unless the stored value is the boolean true', () => {
  for (const config of [
    undefined,
    null,
    {},
    { agent: {} },
    { agent: { developer: {} } },
    withOption(false),
    withOption('true'),
    withOption(1),
    { agent: [] },
    { developer: { [DIRECT_PHONE_CONNECTION_OPTION]: true } },
    { agent: { developer: { allowAllActions: true } } },
  ]) {
    assert.equal(directPhoneConnectionStored(config), false, JSON.stringify(config));
  }
  assert.equal(directPhoneConnectionStored(withOption(true)), true);
});

test('what the developer settings API stores is what the switch reads', async () => {
  let agent = {};
  const api = createDeveloperSettings({
    getConfig: () => agent,
    saveConfigAndAdopt: (next) => {
      agent = next;
    },
  });
  assert.equal(directPhoneConnectionStored({ agent }), false);
  await api.setDeveloperOption(DIRECT_PHONE_CONNECTION_OPTION, true);
  assert.equal(directPhoneConnectionStored({ agent }), true);
  await api.setDeveloperOption(DIRECT_PHONE_CONNECTION_OPTION, false);
  assert.equal(directPhoneConnectionStored({ agent }), false);
});

test('local enable works, and a paired client may turn the switch on or off', async () => {
  let agent = {};
  const api = createDeveloperSettings({
    getConfig: () => agent,
    saveConfigAndAdopt: (next) => {
      agent = next;
    },
  });
  await api.setDeveloperOption(DIRECT_PHONE_CONNECTION_OPTION, true);
  assert.equal(directPhoneConnectionStored({ agent }), true);
  // Unlike "Allow all actions", the remote guard lets both directions through.
  assertRemoteCapabilityCall('setDeveloperOption', [DIRECT_PHONE_CONNECTION_OPTION, true]);
  assertRemoteCapabilityCall('setDeveloperOption', [DIRECT_PHONE_CONNECTION_OPTION, false]);
  assert.throws(() => assertRemoteCapabilityCall('setDeveloperOption', ['allowAllActions', true]));
});

test('reading the switch fails closed', async () => {
  assert.equal(await readDirectPhoneConnection(async () => ({ readConfig: () => withOption(true) })), true);
  assert.equal(await readDirectPhoneConnection(async () => ({ readConfig: () => withOption(false) })), false);
  assert.equal(await readDirectPhoneConnection(async () => ({ readConfig: () => ({}) })), false);
  assert.equal(
    await readDirectPhoneConnection(async () => {
      throw new Error('config module missing');
    }),
    false
  );
  assert.equal(
    await readDirectPhoneConnection(async () => ({
      readConfig: () => {
        throw new SyntaxError('malformed');
      },
    })),
    false
  );
});
