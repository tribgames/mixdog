import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import i18n from './i18n';
import { quietCueText } from './quiet-cue';

const parts = (minutes, wait, tool = '') => ({ quietMs: minutes * 60_000, minutes, wait, tool, escalated: false });

test('a quiet wait reads as one phrase: what it waits on and for how long', () => {
  assert.equal(quietCueText(parts(3, 'thinking')), 'model thinking for 3m');
  assert.equal(quietCueText(parts(6, 'tool', 'shell')), 'running shell for 6m');
});

test('a quiet state without a wait kind keeps the plain no-updates phrase', () => {
  assert.equal(quietCueText(parts(2, '')), 'No updates for 2m');
});

test('the Korean cue is the short merged phrase', async () => {
  const catalog = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
  i18n.addResourceBundle('ko', 'translation', catalog);
  try {
    await i18n.changeLanguage('ko');
    assert.equal(quietCueText(parts(2, 'model')), '모델 대기 2분째');
    assert.equal(quietCueText(parts(6, 'tool')), '도구 실행 중 6분째');
  } finally {
    await i18n.changeLanguage('en');
  }
});
