import assert from 'node:assert/strict';
import test from 'node:test';
import { attachNeedsRedraw, TerminalFeedPositions } from './terminal-feed-reader.ts';

test('a tab resumes from the last stamp noted; a value that is not a stamp leaves it; forget clears it', () => {
  const positions = new TerminalFeedPositions();
  assert.equal(positions.resumeFrom('t1'), undefined);
  positions.note('t1', { id: 'process:t1', epoch: 'e1', seq: 4 });
  positions.note('t1', { id: 'process:t1', epoch: 'e1', seq: 5, from: 5 });
  for (const bad of [undefined, null, 'x', { epoch: 'e1' }, { epoch: '', seq: 1 }, { epoch: 'e1', seq: Number.NaN }]) positions.note('t1', bad);
  assert.deepEqual(positions.resumeFrom('t1'), { epoch: 'e1', seq: 5 });
  assert.equal(positions.resumeFrom('t2'), undefined);
  positions.forget('t1');
  assert.equal(positions.resumeFrom('t1'), undefined);
});

test('only a replay of the resumed epoch needs no redraw', () => {
  const resumed = { epoch: 'e1', seq: 5 };
  const reply = (mode, epoch) => ({ id: 't1', replay: '', subscription: { mode, epoch, startSeq: 6 } });
  assert.equal(attachNeedsRedraw(reply('replay', 'e1'), resumed), false);
  assert.equal(attachNeedsRedraw(reply('replay', 'e2'), resumed), true);
  assert.equal(attachNeedsRedraw(reply('snapshot', 'e1'), resumed), true);
  assert.equal(attachNeedsRedraw(reply('replay', 'e1'), undefined), true);
  assert.equal(attachNeedsRedraw({ id: 't1', replay: '' }, resumed), true);
  assert.equal(attachNeedsRedraw(null, resumed), true);
});
