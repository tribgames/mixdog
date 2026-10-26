import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import i18n from './i18n';
import { composerSubmitErrorText } from './composer-submit-error';
import { codedErrorParams, ipcErrorEnvelope, ipcErrorFromEnvelope } from '../shared/coded-error';
import { roomMemberSwitchedOffError } from '../shared/room-error-codes';
import { executeRemoteFrame } from '../main/remote-methods';
import { SUPPORTED_UI_LANGUAGES } from '../shared/ui-language';

const KEY = '"{{name}}" is switched off.';
const GENERIC = 'This bot is switched off.';

// What the preload does with an IPC refusal, and what remote-shim-dispatch does with a relay frame.
const overIpc = (error) => ipcErrorFromEnvelope(structuredClone(ipcErrorEnvelope(error)));
async function overRelay(error) {
  const frame = await executeRemoteFrame(
    {
      send: async () => {
        throw error;
      },
    },
    JSON.stringify({ id: 1, method: 'send', params: [] })
  );
  const failure = Object.assign(new Error(frame.error), { code: frame.errorCode });
  const params = codedErrorParams(frame.errorCode, JSON.parse(JSON.stringify(frame)).errorParams);
  if (params) failure.details = params;
  return failure;
}

test('a send to a switched-off room member shows the refusal in the UI language', async () => {
  for (const { value } of SUPPORTED_UI_LANGUAGES) {
    if (value === 'en') continue;
    const catalog = JSON.parse(readFileSync(new URL(`./locales/${value}.json`, import.meta.url), 'utf8'));
    assert.ok(catalog[KEY], `${value} has the string`);
    assert.ok(catalog[GENERIC], `${value} has the generic string`);
    i18n.addResourceBundle(value, 'translation', catalog);
  }
  const original = roomMemberSwitchedOffError('Release');
  assert.equal(original.message, '"Release" is switched off.');
  await i18n.changeLanguage('ko');
  try {
    for (const error of [original, overIpc(original), await overRelay(original)]) {
      assert.equal(composerSubmitErrorText(error), '"Release" 봇이 꺼져 있습니다.');
    }
    // The name never comes from the prose: no param, generic localized text.
    const bare = Object.assign(new Error('"Release" is switched off.'), { code: 'ROOM_MEMBER_SWITCHED_OFF' });
    for (const error of [bare, overIpc(bare), await overRelay(bare)]) {
      assert.equal(composerSubmitErrorText(error), '이 봇이 꺼져 있습니다.');
    }
    // Other messages, or the prose without the code, are shown as they came.
    assert.equal(composerSubmitErrorText(new Error('Write a message to send.')), 'Write a message to send.');
    assert.equal(composerSubmitErrorText(new Error('"Release" is switched off.')), '"Release" is switched off.');
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('error params are whitelisted strings, and the relay redacts them like the message', async () => {
  const code = 'ROOM_MEMBER_SWITCHED_OFF';
  assert.deepEqual(codedErrorParams(code, { name: 'Rel', other: 'x' }), { name: 'Rel' });
  for (const bad of [null, 'x', { name: 3 }, { name: '' }, { name: 'x'.repeat(201) }, {}]) {
    assert.equal(codedErrorParams(code, bad), undefined);
  }
  // Only codes that declare a public display param forward it.
  for (const other of ['ENOENT', 'PROJECT_UNAVAILABLE', 'WORKTREE_DIRTY', '', undefined, 'toString']) {
    assert.equal(codedErrorParams(other, { name: 'C:/secret/path.txt' }), undefined);
  }
  const file = Object.assign(new Error('x'), { code: 'ENOENT', details: { name: 'C:/secret/path.txt' } });
  assert.equal(overIpc(file).details, undefined);
  assert.equal((await overRelay(file)).details, undefined);
  const error = Object.assign(new Error('x'), {
    code: 'ROOM_MEMBER_SWITCHED_OFF',
    details: { name: 'my-secret-value' },
  });
  const frame = await executeRemoteFrame(
    {
      invokeCapability: async () => {
        throw error;
      },
    },
    JSON.stringify({
      id: 1,
      method: 'invokeCapability',
      params: [{ capability: 'saveProviderApiKey', args: { key: 'my-secret-value' } }],
    })
  );
  assert.ok(!JSON.stringify(frame).includes('my-secret-value'));
});
