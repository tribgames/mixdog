import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-oauth-usage-'));
process.env.MIXDOG_DATA_DIR = dir;
const { normalizeAnthropicUsage } = await import('./oauth-usage.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

test('scoped weekly windows are reported next to the all-model windows', () => {
  const resetsAt = '2026-09-18T08:00:00Z';
  const snapshot = normalizeAnthropicUsage({
    five_hour: { utilization: 4, resets_at: '2026-09-14T20:00:00Z' },
    seven_day: { utilization: 52, resets_at: resetsAt },
    seven_day_opus: { utilization: 100, resets_at: resetsAt },
    seven_day_omelette: null,
    limits: [
      {
        kind: 'weekly_model',
        percent: 100,
        resets_at: resetsAt,
        scope: { model: { id: 'opus', display_name: 'Opus' } },
      },
      {
        kind: 'weekly_surface',
        percent: 12,
        resets_at: resetsAt,
        scope: { surface: { id: 'oauth_apps', display_name: 'OAuth apps' } },
      },
      { kind: 'weekly_model', percent: 90, resets_at: resetsAt, is_active: false, scope: { model: { id: 'retired' } } },
    ],
  });
  assert.deepEqual(
    snapshot.quotaWindows.map((window) => [window.label, window.usedPct]),
    [
      ['5H', 4],
      ['7D', 52],
      ['7D Opus', 100],
      ['7D OAuth apps', 12],
    ]
  );
  assert.equal(snapshot.quotaWindows[2].resetAt, Date.parse(resetsAt));
});

test('the limits[] fallback still covers unscoped windows only once', () => {
  const snapshot = normalizeAnthropicUsage({
    limits: [
      { kind: 'session', percent: 10, resets_at: '2026-09-14T20:00:00Z' },
      { kind: 'weekly_all', percent: 20, resets_at: '2026-09-18T08:00:00Z' },
      { kind: 'weekly_model', percent: 30, resets_at: '2026-09-18T08:00:00Z', scope: { model: { id: 'opus' } } },
    ],
  });
  assert.deepEqual(
    snapshot.quotaWindows.map((window) => [window.label, window.usedPct]),
    [
      ['5H', 10],
      ['7D', 20],
      ['7D Opus', 30],
    ]
  );
});
