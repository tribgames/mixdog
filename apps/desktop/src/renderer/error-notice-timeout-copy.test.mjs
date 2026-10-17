import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import i18n from './i18n';
import { localizeErrorCopy } from './error-notice-copy';

const ko = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
i18n.addResourceBundle('ko', 'translation', ko);

test('provider-thinking and agent-watchdog timeouts are localized with their values', async () => {
  await i18n.changeLanguage('ko');
  try {
    assert.equal(
      localizeErrorCopy('Model still thinking: no output in 465s; Antigravity sent nothing yet; attempts: 2.'),
      '모델이 아직 생각 중입니다: 465s 동안 출력이 없고 Antigravity에서 아직 아무것도 보내지 않았습니다. 시도 2회.'
    );
    assert.equal(
      localizeErrorCopy('Model still thinking: no output in 1m; the provider sent nothing yet.'),
      '모델이 아직 생각 중입니다: 1m 동안 출력이 없고 프로바이더에서 아직 아무것도 보내지 않았습니다.'
    );
    assert.equal(
      localizeErrorCopy('Agent watchdog stopped the run: no model response in 481s.'),
      '에이전트 감시가 실행을 중지했습니다: 481s 동안 모델 응답이 없습니다.'
    );
  } finally {
    await i18n.changeLanguage('en');
  }
});
