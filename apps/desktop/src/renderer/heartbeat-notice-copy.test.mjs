import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import i18n from './i18n';
import { localizeHeartbeatBreakerNotice } from './error-notice-copy';
import { HEARTBEAT_LIMITS, createMixyHeartbeat } from '../../../../src/session-runtime/mixy-heartbeat.mjs';

const ko = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
i18n.addResourceBundle('ko', 'translation', ko);

/** The warning the real heartbeat posts once its Maintainer gate trips on `decide`. */
async function breakerNotice(t, decide) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-heartbeat-notice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 0, 1, 9);
  const notices = [];
  const heartbeat = createMixyHeartbeat({
    now: () => clock,
    path: join(dir, 'heartbeat.json'),
    isEnabled: async () => true,
    userTurnAt: () => 0,
    collect: async () => ({
      sessions: [{ id: 'sess_lead_1', bot: '', title: 'Report', preview: 'Draft done' }],
      tasks: [],
      approvals: 0,
      routines: [],
    }),
    routeKey: async () => 'fake/tiny/',
    decide,
    review: async () => ({ action: 'unmanaged' }),
    wake: async () => ({ quiet: true }),
    notify: async (text) => notices.push(text),
    log: () => {},
  });
  assert.equal(await heartbeat.tick(), 'armed');
  for (let i = 0; i < HEARTBEAT_LIMITS.providerFailuresToTrip && !notices.length; i += 1) {
    clock += HEARTBEAT_LIMITS.intervalMs;
    await heartbeat.tick();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(notices.length, 1);
  return notices[0];
}

test("the heartbeat's breaker warning shows in the reader's language, its count kept", async (t) => {
  const unusable = await breakerNotice(t, async () => null);
  const failed = await breakerNotice(t, async () => {
    throw new Error('503 overloaded');
  });
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
