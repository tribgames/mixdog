import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import i18n from './i18n';
import { localizeHeartbeatBreakerNotice } from './error-notice-copy';

const ko = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
i18n.addResourceBundle('ko', 'translation', ko);

// The warnings Node b6f10295a's heartbeat (src/session-runtime/mixy-heartbeat.mjs) posts once its Maintainer gate trips on 3 unusable
// replies / 5 failed calls, recorded by running it.
const UNUSABLE_NOTICE =
  'Heartbeat: the Maintainer model gave 3 unusable replies in a row, so heartbeat checks no longer ask it until Mixdog restarts or its model changes. Only failing routines wake Mixy meanwhile.';
const FAILED_NOTICE =
  'Heartbeat: the Maintainer model gave 5 failed calls in a row, so heartbeat checks no longer ask it until Mixdog restarts or its model changes. Only failing routines wake Mixy meanwhile.';
test("the heartbeat's breaker warning shows in the reader's language, its count kept", async () => {
  const unusable = UNUSABLE_NOTICE;
  const failed = FAILED_NOTICE;
  assert.equal(localizeHeartbeatBreakerNotice(unusable), unusable, 'English stays the source text');
  await i18n.changeLanguage('ko');
  try {
    assert.equal(
      localizeHeartbeatBreakerNotice(unusable),
      '하트비트: Maintainer 모델이 3번 연속으로 쓸 수 없는 답변을 보내, Mixdog을 다시 시작하거나 모델을 바꿀 때까지 하트비트 점검에서 더 묻지 않습니다. 그동안에는 실패가 이어지는 루틴만 Mixy를 깨웁니다.'
    );
    assert.equal(
      localizeHeartbeatBreakerNotice(failed),
      '하트비트: Maintainer 모델 호출이 5번 연속으로 실패해, Mixdog을 다시 시작하거나 모델을 바꿀 때까지 하트비트 점검에서 더 묻지 않습니다. 그동안에는 실패가 이어지는 루틴만 Mixy를 깨웁니다.'
    );
    assert.equal(localizeHeartbeatBreakerNotice('Heartbeat: something else.'), null);
  } finally {
    await i18n.changeLanguage('en');
  }
});