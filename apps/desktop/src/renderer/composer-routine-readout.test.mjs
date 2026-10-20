import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, { expose: ['navigator', 'Node', 'Element', 'HTMLElement'] });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { nextRunPhrase, roomRoutineFocus, routineFocus, routineReadoutVariants } = await import(
  './composer-routine-readout.tsx'
);

// Tuesday 2026-10-20 15:00 local.
const NOW = new Date(2026, 9, 20, 15, 0).getTime();
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const iso = (ms) => new Date(ms).toISOString();
const texts = (variants) => variants.map((items) => items.map((item) => item.text));

test('next run phrases: within the hour, today, tomorrow, weekday, date', () => {
  assert.match(nextRunPhrase(NOW + 40 * 60_000, NOW), /40/);
  assert.match(nextRunPhrase(at(20, 18), NOW), /6/);
  assert.match(nextRunPhrase(at(21, 8, 30), NOW), /8.*30|8:30/);
  assert.doesNotMatch(nextRunPhrase(at(21, 8), NOW), /:00|00/); // minutes only when non-zero
  assert.match(nextRunPhrase(at(23, 9), NOW), /Friday/);
  assert.match(nextRunPhrase(at(30, 9), NOW), /October.*30|30.*October/);
  // today and tomorrow differ in their day word.
  assert.notEqual(nextRunPhrase(at(20, 18), NOW).split(' ')[0], nextRunPhrase(at(21, 18), NOW).split(' ')[0]);
});

const schedules = [
  { name: 'later', owner: 'mixy', enabled: true, nextFireAt: iso(at(23, 9)) },
  { name: 'soon', owner: 'mixy', enabled: true, nextFireAt: iso(at(21, 8)) },
  { name: 'other', owner: 'zed', enabled: true, nextFireAt: iso(at(20, 16)) },
];
const hooks = [
  { name: 'gh', owner: 'mixy', enabled: true },
  { name: 'gh2', owner: 'mixy', enabled: true },
];

test("a group room shows its members' soonest routine, named with its bot", () => {
  const members = [
    { id: 'mixy', name: 'Mixy' },
    { id: 'zed', name: 'Zed' },
  ];
  assert.deepEqual(roomRoutineFocus({ schedules, webhooks: hooks }, members), {
    kind: 'next',
    name: 'Zed · other',
    at: at(20, 16),
    agentId: 'zed',
  });
  const broken = {
    name: 'broken',
    owner: 'mixy',
    enabled: true,
    lastSuccessAt: '2026-01-01T00:00:00Z',
    lastFailedAt: '2026-01-02T00:00:00Z',
  };
  assert.deepEqual(
    roomRoutineFocus({ schedules: [...schedules, broken], webhooks: hooks }, members),
    { kind: 'failed', name: 'Mixy · broken', agentId: 'mixy' },
    'a failure outranks an earlier run'
  );
  assert.equal(roomRoutineFocus({}, members).kind, 'none');
});

test('the soonest active schedule of this bot is the focus', () => {
  const focus = routineFocus({ schedules, webhooks: hooks }, 'mixy');
  assert.deepEqual(focus, { kind: 'next', name: 'soon', at: at(21, 8) });
  const variants = routineReadoutVariants(focus, NOW);
  // worded, without the name, then icon + short time; one item each.
  assert.ok(variants.every((items) => items.length === 1));
  assert.equal(variants.length, 3);
  assert.ok(variants[0][0].text.endsWith(' soon'));
  assert.equal(variants[1][0].text, variants[0][0].text.slice(0, -' soon'.length));
  assert.equal(variants[0][0].icon, null);
  assert.ok(variants[2][0].icon && variants[2][0].icon !== 'dot');
  assert.ok(variants[2][0].text.length > 0);
  assert.equal(variants[2][0].label, variants[0][0].label);
});

test('a failure wins over everything, one item, ending at the dot alone', () => {
  const failing = [
    ...schedules,
    {
      name: 'broken',
      owner: 'mixy',
      enabled: true,
      lastSuccessAt: '2026-01-01T00:00:00Z',
      lastFailedAt: '2026-01-02T00:00:00Z',
    },
  ];
  const focus = routineFocus({ schedules: failing, webhooks: hooks }, 'mixy');
  assert.deepEqual(focus, { kind: 'failed', name: 'broken' });
  const variants = routineReadoutVariants(focus, NOW);
  assert.deepEqual(texts(variants), [['broken failed'], ['Failed'], ['']]);
  assert.ok(variants.every((items) => items.length === 1 && items[0].icon === 'dot'));
  assert.ok(variants.every((items) => items[0].label === 'broken failed'));
});

test('a webhook stopped after repeated failures counts as a failure', () => {
  const focus = routineFocus(
    { webhooks: [{ name: 'hook', owner: 'mixy', enabled: false, consecutiveFailures: 5 }] },
    'mixy'
  );
  assert.deepEqual(focus, { kind: 'failed', name: 'hook' });
});

test('no active schedule: the first webhook only, no "and N more"', () => {
  const focus = routineFocus({ schedules: [{ name: 'p', owner: 'mixy', enabled: false }], webhooks: hooks }, 'mixy');
  assert.deepEqual(focus, { kind: 'webhook', name: 'gh' });
  const variants = routineReadoutVariants(focus, NOW);
  assert.deepEqual(texts(variants), [['Waiting for gh'], ['']]);
  assert.ok(variants[1][0].icon);
});

test('everything paused, then nothing at all', () => {
  const paused = routineFocus(
    {
      schedules: [{ name: 'p', owner: 'mixy', enabled: false }],
      webhooks: [{ name: 'w', owner: 'mixy', enabled: false }],
    },
    'mixy'
  );
  assert.deepEqual(paused, { kind: 'paused' });
  assert.deepEqual(texts(routineReadoutVariants(paused, NOW))[0], ['All routines paused']);
  const none = routineFocus({ schedules, webhooks: hooks }, 'nobody');
  assert.deepEqual(none, { kind: 'none' });
  assert.deepEqual(texts(routineReadoutVariants(none, NOW))[0], ['Nothing scheduled']);
  // Ownerless rows belong to Mixy.
  assert.equal(routineFocus({ webhooks: [{ name: 'w', enabled: true }] }, 'lead').kind, 'webhook');
});
