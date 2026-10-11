import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalImeGuard } from './terminal-ime-guard.ts';

// Event order ibus-hangul produces for `gksrmf dkssudgktpdy`, as xterm 5.5 turns
// it into data events: the commit is emitted by compositionend's delayed read,
// again by the textarea `input` event, and the residual textarea text rides
// along with the next syllable.
function run(events) {
  const sent = [];
  const guard = new TerminalImeGuard((d) => sent.push(d));
  const xterm = (d) => {
    if (!guard.shouldDrop(d)) sent.push(d);
  };
  for (const [kind, data] of events) {
    if (kind === 'start') guard.compositionStart();
    else if (kind === 'end') guard.compositionEnd(data);
    else if (kind === 'done') guard.finalizeDone();
    else xterm(data);
  }
  return sent.join('');
}

test('duplicated ibus commits are sent once', () => {
  const out = run([
    ['start'], ['end', '한'], ['xterm', '한'], ['xterm', '한'], ['done'],
    ['start'], ['end', '글'], ['xterm', '글글'], ['done'],
    ['xterm', ' '],
    ['start'], ['end', '안'], ['xterm', '안'], ['done'],
    ['start'], ['end', '녕'], ['xterm', '안녕'], ['done'],
  ]);
  assert.equal(out, '한글 안녕');
});

test('control bytes pass through during finalization and plain typing is untouched', () => {
  assert.equal(run([['start'], ['end', '가'], ['xterm', '\r'], ['xterm', '가'], ['done'], ['xterm', 'a']]), '가\ra');
});

test('data from a composition that starts before the finalize task is still guarded', () => {
  assert.equal(run([['start'], ['end', '한'], ['start'], ['xterm', '한'], ['done'], ['end', '글'], ['done']]), '한글');
});
