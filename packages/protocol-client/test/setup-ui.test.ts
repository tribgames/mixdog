// The setup tool's desktop request is thread state (`setupUiRequest`, the `thread/setupUiRequest/updated` section): the value
// Node's session store sets (`native/core/fixtures/setup-ui/golden.json`, recorded by record-setup-ui.mjs from the real
// `createNotificationRouter`) reaches the projection the same way from a snapshot as from the live section, and goes when
// the core clears it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;
const golden: O = JSON.parse(readFileSync(new URL('../../../native/core/fixtures/setup-ui/golden.json', import.meta.url), 'utf8'));
/** Every `setupUiRequest` a Node store set, in scenario order. */
const requests: O[] = (golden.scenarios as O[]).flatMap((s) => (s.patches as O[]).map((p) => p.setupUiRequest));

const snapshot = (state: O): SessionFold => sessionReducer.initial({ thread: { id: 't' }, items: [], state, hasOlder: false } as unknown as Json);
const section = (s: SessionFold, value: unknown): SessionFold =>
  sessionReducer.apply(s, { method: 'thread/setupUiRequest/updated', params: { threadId: 't', value } } as never);

test('a pending desktop request reads the same from a snapshot and from the live section', () => {
  assert.ok(requests.length > 0);
  for (const request of requests) {
    const live = section(snapshot({}), request);
    const late = snapshot({ setupUiRequest: request });
    assert.deepEqual(live.fields.setupUiRequest, request);
    assert.deepEqual(late.fields.setupUiRequest, request);
    assert.deepEqual(desktopSessionState(late, []).setupUiRequest, desktopSessionState(live, []).setupUiRequest);
  }
});

test('a claimed or expired request leaves the projection', () => {
  const live = section(snapshot({ setupUiRequest: requests[0] }), null);
  assert.equal('setupUiRequest' in live.fields, false);
  assert.equal('setupUiRequest' in desktopSessionState(snapshot({}), []), false, 'a snapshot without one has none');
});
