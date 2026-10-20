import assert from 'node:assert/strict';
import test from 'node:test';
import { mixyDefaultPlan } from './agent-home-default.ts';

const MIXY = 'sess_home_lead';
const desktop = (filled = new Set()) => ({ mobile: false, draftHasContent: (scope) => filled.has(scope) });
const draft = { kind: 'new', draftId: 'd1' };

test('an untouched draft that is the only tab is replaced by Mixy', () => {
  const plan = mixyDefaultPlan({ focused: draft, focusedTabCount: 1, openSessionIds: [] }, desktop());
  assert.deepEqual(plan, { kind: 'open', replaceKey: 'new:d1' });
});

test('a draft with text is kept and Mixy is added beside it', () => {
  const plan = mixyDefaultPlan(
    { focused: draft, focusedTabCount: 1, openSessionIds: [] },
    desktop(new Set(['draft:d1']))
  );
  assert.deepEqual(plan, { kind: 'open', replaceKey: '' });
});

test('a session in use is never closed: Mixy is added only when no home tab exists', () => {
  const focused = { kind: 'session', id: 'work-1' };
  assert.deepEqual(mixyDefaultPlan({ focused, focusedTabCount: 1, openSessionIds: ['work-1'] }, desktop()), {
    kind: 'open',
    replaceKey: '',
  });
  assert.deepEqual(
    mixyDefaultPlan({ focused, focusedTabCount: 2, openSessionIds: ['work-1', 'sess_home_watcher'] }, desktop()),
    { kind: 'none' }
  );
});

test('an open home tab is reused from an untouched draft, Mixy first', () => {
  const plan = mixyDefaultPlan(
    { focused: draft, focusedTabCount: 3, openSessionIds: ['sess_home_watcher', MIXY] },
    desktop()
  );
  assert.deepEqual(plan, { kind: 'focus', sessionId: MIXY });
});

test('a focused home thread stays, and the phone never auto-opens', () => {
  assert.deepEqual(
    mixyDefaultPlan({ focused: { kind: 'session', id: MIXY }, focusedTabCount: 1, openSessionIds: [MIXY] }, desktop()),
    { kind: 'none' }
  );
  assert.deepEqual(
    mixyDefaultPlan(
      { focused: draft, focusedTabCount: 1, openSessionIds: [] },
      { mobile: true, draftHasContent: () => false }
    ),
    { kind: 'none' }
  );
});
