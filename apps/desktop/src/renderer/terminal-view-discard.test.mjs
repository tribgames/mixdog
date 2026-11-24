import assert from 'node:assert/strict';
import test from 'node:test';
import { discardUnopenedView } from './terminal-view-discard.ts';

const makeView = (element) => {
  const calls = [];
  return {
    calls,
    term: { element, dispose: () => calls.push('term') },
    writer: { dispose: () => calls.push('writer') },
    localEcho: null,
  };
};

test('a prewarmed view no pane opened is released; an opened or replaced one stays', () => {
  const views = new Map();
  const empty = makeView(undefined);
  views.set('t', empty);
  discardUnopenedView(views, 't', empty);
  assert.equal(views.size, 0);
  assert.deepEqual(empty.calls, ['writer', 'term']);

  const opened = makeView({});
  views.set('t', opened);
  discardUnopenedView(views, 't', opened);
  assert.equal(views.get('t'), opened);

  const stale = makeView(undefined);
  discardUnopenedView(views, 't', stale);
  assert.equal(views.get('t'), opened);
  assert.deepEqual(stale.calls, []);
});
