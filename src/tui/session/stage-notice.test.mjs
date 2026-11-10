import assert from 'node:assert/strict';
import test from 'node:test';
import { createNoticeSurface } from './notice-surface.mjs';
import { createTurnStream } from './turn-stream.mjs';
import { streamHandlers } from './turn.mjs';
import { recordProviderToolExclusion } from '../../runtime/agent/orchestrator/session/loop/provider-tool-exclusions.mjs';

test('an excluded-tool notice lands once as a warn transcript notice, the item the TUI and desktop render', () => {
  let state = { items: [], toasts: [], spinner: { active: true, mode: 'requesting' } };
  const getState = () => state;
  const set = (patch) => {
    state = { ...state, ...patch };
  };
  let id = 0;
  const surface = createNoticeSurface({
    getState,
    set,
    isDisposed: () => false,
    pushItem: (item) => set({ items: [...state.items, item] }),
    replaceItems: (items) => items,
  });
  const isCurrentTurn = () => true;
  const stream = createTurnStream({ getState, set, nextId: () => ++id, isCurrentTurn });
  const { onStageChange } = streamHandlers({ isCurrentTurn, stream, pushNotice: surface.pushNotice });

  const session = { id: 'notice-session' };
  const exclusion = {
    name: 'mcp__x__broken',
    pointer: '/allOf',
    reason: 'Anthropic input_schema does not allow a root "allOf"',
  };
  recordProviderToolExclusion(session, exclusion, onStageChange);
  recordProviderToolExclusion(session, exclusion, onStageChange);

  assert.equal(state.items.length, 1);
  const [notice] = state.items;
  assert.equal(notice.kind, 'notice');
  assert.equal(notice.tone, 'warn');
  assert.match(notice.text, /^Tool "mcp__x__broken" was excluded/);
  assert.match(notice.text, /root "allOf"/);
  assert.match(notice.text, /disable the tool/);
  assert.deepEqual(state.toasts, []);
  assert.equal(state.spinner.mode, 'requesting', 'a notice is not a spinner phase');
});
