// The setup tool's desktop request (`thread/notification` with `meta.kind: 'setup-ui'`) folds into `setupUiRequest` as Node's
// session store sets it: `native/core/fixtures/setup-ui/golden.json`, recorded by record-setup-ui.mjs from the real
// `createNotificationRouter` under a fixed clock, holds the event each store took and the patch it made.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;
const golden: O = JSON.parse(readFileSync(new URL('../../../native/core/fixtures/setup-ui/golden.json', import.meta.url), 'utf8'));

const empty = (): SessionFold => sessionReducer.initial({ thread: { id: 't' }, items: [], state: {}, hasOlder: false } as unknown as Json);
const notice = (s: SessionFold, content: string, meta: unknown): SessionFold =>
  sessionReducer.apply(s, { method: 'thread/notification', params: { threadId: 't', content, meta } } as never);

test('a setup-ui notice becomes the setupUiRequest the store set', (t) => {
  t.mock.method(Date, 'now', () => golden.now);
  const taken = (golden.scenarios as O[]).filter((s) => s.patches.length > 0);
  assert.ok(taken.length > 0);
  for (const scenario of taken) {
    const received = (scenario.received as O[]).filter((r) => r.listener === 'store');
    let s = empty();
    for (const r of received) s = notice(s, r.event.content, r.event.meta);
    const want = Object.assign({}, ...(scenario.patches as O[]));
    assert.deepEqual(s.fields.setupUiRequest, want.setupUiRequest, scenario.name);
    assert.deepEqual(desktopSessionState(s, []).setupUiRequest, want.setupUiRequest, scenario.name);
  }
});

test('a notice the store ignores leaves the state alone', () => {
  const start = empty();
  const event = (golden.scenarios as O[]).find((s) => s.name === 'attached')!.received[0].event;
  // No id (notification-plan.mjs:90), no text (notification-bus.mjs:99), or another kind of notice.
  for (const [content, meta] of [
    [event.content, { kind: 'setup-ui' }],
    [event.content, { kind: 'setup-ui', id: '' }],
    ['  ', event.meta],
    [event.content, { ...event.meta, kind: 'ui-open' }],
    ['shell job done', { status: 'completed' }],
  ] as [string, unknown][]) {
    const s = notice(start, content, meta);
    assert.equal('setupUiRequest' in s.fields, false, JSON.stringify(meta));
  }
});
