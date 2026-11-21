// The working indicator is the core's retained state: the client shows the spinner the runtime section carries and never rebuilds a
// phase from a transient `thread/stage/updated`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';

const note = (method: string, params: Record<string, unknown>) =>
  ({ method, params: { threadId: 't1', ...params } }) as never;
const runtime = (spinner: Record<string, unknown> | null) =>
  note('thread/runtime/updated', { value: { busy: true, ...(spinner ? { spinner } : {}) } });
const spinnerOf = (fold: Parameters<typeof desktopSessionState>[0]) =>
  desktopSessionState(fold, []).spinner as Record<string, unknown> | undefined;
const fresh = () => sessionReducer.initial({ thread: { id: 't1' }, items: [], state: {} } as never);
const retrying = {
  mode: 'reconnecting',
  verb: 'Provider overloaded · retry 2/5 in 15s',
  retryAt: 1_015_000,
  retryInMs: 15_000,
  startedAt: 1,
};

test('the retained reconnecting spinner is shown as the core published it, retry identity and relative wait included', () => {
  const fold = sessionReducer.apply(fresh(), runtime(retrying));
  assert.deepEqual(spinnerOf(fold), retrying);
});

test('a stage event changes nothing in the fold: the state the runtime section carries is the only source', () => {
  const before = sessionReducer.apply(fresh(), runtime({ mode: 'requesting', startedAt: 1 }));
  const after = sessionReducer.apply(
    before,
    note('thread/stage/updated', { stage: 'reconnecting', detail: { message: 'x', retryAt: 5 } })
  );
  assert.equal(after, before);
  assert.equal(spinnerOf(after)?.mode, 'requesting');
});

test('the next runtime publication replaces the retry and the end of the turn removes the spinner', () => {
  let fold = sessionReducer.apply(fresh(), runtime(retrying));
  fold = sessionReducer.apply(fold, runtime({ mode: 'responding', startedAt: 1, retryAt: null, retryInMs: null }));
  assert.equal(spinnerOf(fold)?.mode, 'responding');
  fold = sessionReducer.apply(fold, runtime(null));
  assert.equal(spinnerOf(fold), undefined);
});
