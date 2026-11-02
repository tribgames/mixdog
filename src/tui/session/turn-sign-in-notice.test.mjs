import assert from 'node:assert/strict';
import test from 'node:test';

import { registerDesktopNoticeSink } from '../../runtime/shared/desktop-notice-host.mjs';
import { providerDisplayName } from '../../runtime/shared/provider-display-name.mjs';
import { failTurn } from './turn.mjs';
import { createTurnStream } from './turn-stream.mjs';

function fail(provider, error) {
  let state = { spinner: null };
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    isCurrentTurn: () => true,
  });
  failTurn(
    {
      turn: { startedAt: Date.now(), submittedIds: [], completionVerb: 'Done', routeMeta: { provider, model: 'm' } },
      stream,
      cards: { aggregates: { finalizeToolHeaders() {} }, toolCards: [] },
      getState: () => state,
      nextId: () => 1,
      pushNotice() {},
    },
    error
  );
}

test('a turn refused for an expired provider sign-in tells the desktop once per provider', (t) => {
  const notices = [];
  t.after(registerDesktopNoticeSink((notice) => notices.push(notice)));
  const expired = () => Object.assign(new Error('refresh failed: invalid_grant'), { reauthRequired: true });

  fail('anthropic', expired());
  fail('anthropic', expired());
  fail('openai', Object.assign(new Error('server error'), { status: 500 }));

  assert.deepEqual(notices, [
    {
      key: 'provider-sign-in:anthropic',
      code: 'provider-sign-in-expired',
      params: { name: providerDisplayName('anthropic') },
    },
  ]);
});
