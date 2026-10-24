// A refused or unsure schedule rename reaches the editor translated by its
// code and `name` param, after the IPC hop that drops custom Error fields.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import i18n, { t } from './i18n';
import { scheduleErrorText } from './schedule-error-text';
import { ipcErrorEnvelope, ipcErrorFromEnvelope } from '../shared/coded-error';
import { SUPPORTED_UI_LANGUAGES } from '../shared/ui-language';

const KEYS = [
  'A schedule named "{{name}}" already exists.',
  'Schedule "{{name}}" is running. Rename it after the run finishes.',
  'Renamed to "{{name}}", but the scheduler could not reload. It is armed on the next reload.',
  'The rename may or may not have applied because the scheduler did not answer. Check the schedule list.',
];
const catalogs = new Map(
  SUPPORTED_UI_LANGUAGES.filter(({ value }) => value !== 'en').map(({ value }) => [
    value,
    JSON.parse(readFileSync(new URL(`./locales/${value}.json`, import.meta.url), 'utf8')),
  ])
);
for (const [language, catalog] of catalogs) i18n.addResourceBundle(language, 'translation', catalog);

const engineError = (message, code, details) => Object.assign(new Error(message), { code }, details ? { details } : {});
const overIpc = (error) => ipcErrorFromEnvelope(structuredClone(ipcErrorEnvelope(error)));

const cases = [
  [engineError('A schedule named "b" already exists.', 'SCHEDULE_NAME_TAKEN', { name: 'b' }), KEYS[0]],
  [engineError('Schedule "a" is running. Rename it after the run finishes.', 'SCHEDULE_RENAME_RUNNING', { name: 'a' }), KEYS[1]],
  [engineError('Renamed to "b", but reloading the scheduler failed (x); ...', 'SCHEDULE_RENAME_RELOAD_FAILED', { name: 'b' }), KEYS[2]],
  [engineError('The rename may or may not have applied (timeout). Check the schedule list.', 'SCHEDULE_RENAME_UNCERTAIN'), KEYS[3]],
];

test('every schedule rename refusal is translated in every UI language after the IPC hop', async () => {
  try {
    for (const [language, catalog] of catalogs) {
      await i18n.changeLanguage(language);
      for (const [error, key] of cases) {
        const name = error.details?.name;
        assert.ok(catalog[key]?.trim(), `${language}: missing "${key}"`);
        assert.notEqual(catalog[key], key, `${language}: "${key}" must be translated`);
        const text = scheduleErrorText(overIpc(error));
        assert.equal(text, t(key, name ? { name } : {}), `${language}: ${error.code}`);
        if (name) assert.ok(text.includes(`"${name}"`), `${language}: ${error.code} names the schedule`);
      }
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('in English the text is the code\'s own sentence, and an uncoded failure shows its message', async () => {
  await i18n.changeLanguage('en');
  assert.equal(scheduleErrorText(overIpc(cases[1][0])), 'Schedule "a" is running. Rename it after the run finishes.');
  assert.equal(scheduleErrorText(new Error('schedule instructions are required')), 'schedule instructions are required');
});
