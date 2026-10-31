import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationRouter } from './notification-router.mjs';

function router() {
  const sets = [];
  let refreshed = 0;
  const route = createNotificationRouter({
    set: (patch) => sets.push(patch),
    getDisposed: () => false,
    dedup: { promote() {} },
    statusRefresh: { refresh() {} },
    executionDelivery: {},
    modelNotification: {},
    refreshContextStats: () => {
      refreshed += 1;
    },
  });
  return { route, sets, refreshed: () => refreshed };
}

test("an empty session's settings reconcile refreshes the context gauge, not the settings panel", () => {
  const r = router();
  r.route({ content: 'Context status refreshed', meta: { kind: 'setup-changed', action: 'context_status_refreshed' } });
  assert.equal(r.refreshed(), 1);
  assert.deepEqual(r.sets, []);
  r.route({ content: 'Settings changed', meta: { kind: 'setup-changed', action: 'settings_changed' } });
  assert.equal(r.refreshed(), 1);
  assert.equal(r.sets.at(-1).setupChanged.action, 'settings_changed');
});
