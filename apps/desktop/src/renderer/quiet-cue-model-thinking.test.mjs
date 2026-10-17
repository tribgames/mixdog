import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import i18n from './i18n';
import { agentStageCueText, quietCueText } from './quiet-cue';

const de = JSON.parse(readFileSync(new URL('./locales/de.json', import.meta.url), 'utf8'));
i18n.addResourceBundle('de', 'translation', de);

test('an agent row whose request waits for its headers reads "Model thinking"; others read nothing', async () => {
  assert.equal(agentStageCueText({ progressStage: 'model_thinking' }), 'Model thinking');
  assert.equal(agentStageCueText({ progressStage: 'requesting' }), '');
  assert.equal(agentStageCueText({ progressStage: null }), '');
  await i18n.changeLanguage('de');
  try {
    assert.equal(agentStageCueText({ progressStage: 'model_thinking' }), 'Modell denkt nach');
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('a quiet wait for headers says the model is thinking', () => {
  const text = quietCueText({ quietMs: 180_000, minutes: 3, wait: 'thinking', tool: '', escalated: false });
  assert.match(text, / · model thinking$/);
});
