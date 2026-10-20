import assert from 'node:assert/strict';
import test from 'node:test';

const { readSortChoice, scheduleCadence, scheduleGroups, sortByNextRun, webhookGroups } = await import(
  './routine-sideview-model.ts'
);

const at = (iso) => `2030-01-0${iso}T09:00:00.000Z`;
const SCHEDULES = [
  { name: 'weekly-retro', whenCron: '0 17 * * 5', owner: 'lead', enabled: false, nextFireAt: at(1) },
  { name: 'pr-summary', whenCron: '0 18 * * 1-5', owner: 'coder', nextFireAt: at(3) },
  { name: 'briefing', whenCron: '0 8 * * *', nextFireAt: at(4) },
  { name: 'digest', whenCron: '0 9 * * 1', owner: 'research', nextFireAt: at(6) },
  { name: 'orphan', whenCron: '0 7 * * *', owner: 'gone', ownerProblem: 'owner-deleted', nextFireAt: at(2) },
  { name: 'odd', whenCron: '*/5 * * * *', owner: 'coder' },
  { name: 'once', whenAt: at(5), owner: 'coder', nextFireAt: at(5) },
];
const names = (groups) => groups.map((group) => [group.key, group.rows.map((row) => row.name)]);

test('다음 실행: one flat list, soonest first, paused (off or ownerless bot) last', () => {
  assert.deepEqual(names(scheduleGroups(SCHEDULES, 'next')), [
    ['', ['pr-summary', 'briefing', 'once', 'digest', 'odd', 'orphan', 'weekly-retro']],
  ]);
  assert.deepEqual(scheduleGroups([], 'next'), []);
});

test('주기: groups by cadence in the editor order, custom crons last', () => {
  assert.deepEqual(
    SCHEDULES.map((row) => scheduleCadence(row)),
    ['weekly', 'weekdays', 'daily', 'weekly', 'daily', 'custom', 'once']
  );
  assert.deepEqual(names(scheduleGroups(SCHEDULES, 'cadence')), [
    ['cadence:daily', ['briefing', 'orphan']],
    ['cadence:weekdays', ['pr-summary']],
    ['cadence:weekly', ['digest', 'weekly-retro']],
    ['cadence:once', ['once']],
    ['cadence:custom', ['odd']],
  ]);
});

test('봇별: groups by bot in the picker order (Mixy first), unknown bots after', () => {
  const groups = scheduleGroups(SCHEDULES, 'bot', ['lead', 'research', 'coder']);
  assert.deepEqual(names(groups), [
    ['bot:lead', ['briefing', 'weekly-retro']],
    ['bot:research', ['digest']],
    ['bot:coder', ['pr-summary', 'once', 'odd']],
    ['bot:gone', ['orphan']],
  ]);
  assert.deepEqual(
    groups.map((group) => group.bot),
    ['lead', 'research', 'coder', 'gone']
  );
});

test('webhooks: latest event first (none last), or by bot', () => {
  const hooks = [
    { name: 'sentry', owner: 'coder' },
    { name: 'billing', lastEventAt: at(1) },
    { name: 'github', owner: 'coder', lastEventAt: at(3) },
  ];
  assert.deepEqual(names(webhookGroups(hooks, 'recent')), [['', ['github', 'billing', 'sentry']]]);
  assert.deepEqual(names(webhookGroups(hooks, 'bot', ['lead', 'coder'])), [
    ['bot:lead', ['billing']],
    ['bot:coder', ['github', 'sentry']],
  ]);
});

test('sorting never mutates the served rows', () => {
  const copy = SCHEDULES.map((row) => row.name);
  sortByNextRun(SCHEDULES);
  assert.deepEqual(
    SCHEDULES.map((row) => row.name),
    copy
  );
});

test('the remembered chip: a stored valid choice wins, anything else falls back', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  try {
    const options = ['next', 'cadence', 'bot'];
    assert.equal(readSortChoice('k', options, 'next'), 'next');
    store.set('k', 'bot');
    assert.equal(readSortChoice('k', options, 'next'), 'bot');
    store.set('k', 'nonsense');
    assert.equal(readSortChoice('k', options, 'next'), 'next');
  } finally {
    delete globalThis.localStorage;
  }
});
