import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import i18n, { SUPPORTED_UI_LANGUAGES } from './i18n';
import {
  LOCALIZED_ACTIVITY_VERBS,
  activityVerb,
  activityVerbPool,
  reconnectActivityVerb,
  thinkingEffortLabel,
} from './activity-verbs';
import { SPINNER_VERBS } from '../../../../src/tui/spinner-verbs.mjs';

const MODES = [
  'requesting',
  'thinking',
  'tool-use',
  'tool-input',
  'responding',
  'compacting',
  'auto-clear',
  'resuming',
  'task-wait',
  'model-thinking',
  'reconnecting',
];
const RUNTIME_VERBS = [
  '',
  'Working',
  'Reconnecting... 2/3',
  'Connection lost · retry 1/3 in 15s',
  'Rate-limited — waiting ~12s for the provider window',
  'Sign-in expired — switching to the next account',
  'Waiting for the local model',
];
const NON_LATIN = new Set(['ko', 'ja', 'ru', 'zh-CN', 'zh-TW']);
const catalog = (language) => JSON.parse(readFileSync(new URL(`./locales/${language}.json`, import.meta.url), 'utf8'));

async function switchLanguage(language) {
  if (language !== 'en') i18n.addResourceBundle(language, 'translation', catalog(language));
  await i18n.changeLanguage(language);
}

test('every localized spinner key exists in all 11 locales', () => {
  const keys = [
    ...LOCALIZED_ACTIVITY_VERBS,
    'Working',
    'Reconnecting…',
    'Compacting conversation',
    'Auto-clearing conversation',
    'Resuming conversation',
    'Waiting for tasks',
    'Model thinking',
    'model thinking',
    'Thinking (spinner)',
  ];
  for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
    if (language === 'en') continue;
    const entries = catalog(language);
    for (const key of keys) assert.ok(String(entries[key] || '').trim(), `${language}/${key}`);
  }
});

test('non-English UI never yields an English verb in any mode', async () => {
  try {
    for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
      if (language === 'en') continue;
      await switchLanguage(language);
      for (const mode of MODES) {
        for (const runtimeVerb of RUNTIME_VERBS) {
          for (const now of [0, 31_000, 95_000, 400_000]) {
            const verb = activityVerb({ mode, runtimeVerb, anchor: 1_000, now: 1_000 + now });
            assert.ok(verb.trim(), `${language}/${mode}`);
            if (NON_LATIN.has(language))
              assert.doesNotMatch(verb, /[A-Za-z]/, `${language}/${mode}/${runtimeVerb}: ${verb}`);
            else assert.ok(!SPINNER_VERBS.includes(verb), `${language}/${mode}: ${verb}`);
          }
        }
      }
      const label = thinkingEffortLabel('');
      if (NON_LATIN.has(language)) assert.doesNotMatch(label, /[A-Za-z]/, `${language}: ${label}`);
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('the verb pool follows the active language and updates on a switch', async () => {
  try {
    await i18n.changeLanguage('en');
    assert.equal(activityVerbPool(), SPINNER_VERBS);
    assert.equal(reconnectActivityVerb('Connection lost · retry 1/3 in 15s'), 'Connection lost · retry 1/3 in 15s');
    assert.equal(thinkingEffortLabel('High'), 'Thinking (High)');
    await switchLanguage('ko');
    assert.equal(activityVerbPool(), LOCALIZED_ACTIVITY_VERBS);
    assert.equal(reconnectActivityVerb('Reconnecting... 2/3'), `${catalog('ko')['Reconnecting…']} 2/3`);
    await switchLanguage('ja');
    assert.equal(activityVerb({ mode: 'resuming', anchor: 1, now: 1 }), catalog('ja')['Resuming conversation']);
    // A request waiting for its headers reads as the model thinking, not a pool verb.
    assert.equal(activityVerb({ mode: 'model-thinking', anchor: 1, now: 1 }), catalog('ja')['Model thinking']);
    i18n.addResourceBundle('de', 'translation', catalog('de'));
    await i18n.changeLanguage('de');
    assert.equal(activityVerb({ mode: 'model-thinking', anchor: 1, now: 400_000 }), 'Modell denkt nach');
    await i18n.changeLanguage('en');
    assert.equal(activityVerbPool(), SPINNER_VERBS);
    assert.equal(activityVerb({ mode: 'compacting', anchor: 1, now: 1 }), 'Compacting conversation');
    assert.equal(activityVerb({ mode: 'model-thinking', anchor: 1, now: 1 }), 'Model thinking');
  } finally {
    await i18n.changeLanguage('en');
  }
});
