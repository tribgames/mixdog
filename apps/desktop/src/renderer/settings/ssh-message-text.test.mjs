import assert from 'node:assert/strict';
import test from 'node:test';
import { sshMessages } from '@mixdog/protocol';
import i18n, { SUPPORTED_UI_LANGUAGES } from '../i18n';
import { SSH_MESSAGE_CODES, SSH_MESSAGE_TEXT, sshMessageText } from './ssh-message-text.ts';

const all = [...sshMessages.client, ...sshMessages.server];
const sample = (english) => Object.fromEntries([...english.matchAll(/\{(\w+)\}/g)].map((m) => [m[1], `<${m[1]}>`]));

test('every code the core says has a sentence here, and no code is only here', () => {
  assert.deepEqual([...SSH_MESSAGE_CODES].sort(), Object.keys(SSH_MESSAGE_TEXT).sort());
});

test('every code reads in every language, with its parameters filled and no slot left', async () => {
  for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
    await i18n.changeLanguage(language);
    for (const { code, english } of all) {
      const text = sshMessageText({ code, params: sample(english) }, 'fallback');
      assert.notEqual(text, 'fallback', `${language} ${code}`);
      assert.doesNotMatch(text, /\{\{|\}\}/, `${language} ${code}`);
    }
  }
  await i18n.changeLanguage('en');
});

test('a code this window does not know shows the English the sender attached', () => {
  assert.equal(sshMessageText({ code: 'from-a-newer-core' }, 'The English.'), 'The English.');
  assert.equal(sshMessageText(undefined, 'Plain.'), 'Plain.');
});
