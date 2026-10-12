import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalImeGuard } from './terminal-ime-guard.ts';

// Replays the DOM events ibus-hangul emits (real log C:\VM\qa3\n3-events.txt)
// plus the data events xterm 5.5 derives from them. Event kinds:
//   start | end <data> | input <text> (insertText) | xterm <data> | done
function run(events) {
  const sent = [];
  let clock = 0;
  const guard = new TerminalImeGuard((d) => sent.push(d), () => clock);
  for (const [kind, data] of events) {
    if (kind === 'start') guard.compositionStart();
    else if (kind === 'end') guard.compositionEnd(data);
    else if (kind === 'input') guard.inputCommit(data, 'insertText');
    else if (kind === 'done') guard.finalizeDone(data); // data = composition number, default latest
    else if (kind === 'wait') clock += data;
    else sent.push(guard.filter(data));
  }
  return sent.join('');
}

// Pattern A: data on compositionend (한, 녕, 하 in the log).
const dataEnd = (s) => [['start'], ['end', s], ['xterm', s], ['xterm', s], ['done']];
// Pattern B: empty compositionend, text on the following insertText (글, 안, 세).
const inputEnd = (s) => [['start'], ['end', ''], ['input', s], ['xterm', s], ['xterm', s], ['done']];

test('real log: 한글 안녕하세요 mixes both commit patterns and nothing is dropped', () => {
  const out = run([
    ...dataEnd('한'), ...inputEnd('글'),
    ['xterm', ' '],
    ...inputEnd('안'), ...dataEnd('녕'), ...dataEnd('하'), ...inputEnd('세'),
    ['start'], // 요 still composing
  ]);
  assert.equal(out, '한글 안녕하세');
});

test('empty compositionend followed by insertText is committed once', () => {
  assert.equal(run(inputEnd('글')), '글');
});

test('fast typing: next compositionstart arrives before the finalize task', () => {
  assert.equal(
    run([
      ['start'], ['end', ''], ['input', '글'], ['start'], ['xterm', '글'], ['done'],
      ['end', '안'], ['xterm', '안'], ['done'],
    ]),
    '글안'
  );
});

test('slow typing: finalize completes between syllables', () => {
  assert.equal(run([...inputEnd('한'), ...dataEnd('글'), ...inputEnd('안')]), '한글안');
});

test('mixed Korean and English', () => {
  assert.equal(run([['xterm', 'l'], ['xterm', 's'], ...inputEnd('한'), ['xterm', ' '], ['xterm', 'a'], ...dataEnd('글')]), 'ls한 a글');
});

test('backspace mid-composition cancels with no output, then next syllable commits', () => {
  assert.equal(run([['start'], ['end', ''], ['done'], ...inputEnd('가')]), '가');
});

test('Enter after composing passes through exactly once', () => {
  assert.equal(run([...inputEnd('가'), ['xterm', '\r']]), '가\r');
  assert.equal(run([['start'], ['end', ''], ['input', '가'], ['xterm', '\r'], ['xterm', '가'], ['done']]), '가\r');
});

test('late insertText duplicate of a data commit is not re-sent', () => {
  assert.equal(run([['start'], ['end', '한'], ['input', '한'], ['xterm', '한'], ['done']]), '한');
});

test('space, Latin letter, punctuation right after a commit in the SAME task (no finalize in between) are not lost', () => {
  for (const next of [' ', 'a', ',', '.', '1']) {
    assert.equal(run([['start'], ['end', '글'], ['xterm', '글'], ['xterm', next], ['xterm', '글'], ['done']]), '글' + next, 'data ' + JSON.stringify(next));
    assert.equal(run([['start'], ['end', ''], ['input', '글'], ['xterm', '글'], ['xterm', next], ['done']]), '글' + next, 'input ' + JSON.stringify(next));
  }
});

test('한글 안녕: the space arrives before the finalize task', () => {
  const out = run([
    ['start'], ['end', '한'], ['xterm', '한'], ['done'],
    ['start'], ['end', '글'], ['xterm', '글'], ['xterm', ' '], ['done'],
    ['start'], ['end', '안'], ['xterm', '안'], ['done'],
  ]);
  assert.equal(out, '한글 안');
});

test('combined payload: committed text + delimiter in one data event', () => {
  assert.equal(run([['start'], ['end', '글'], ['xterm', '글 '], ['done']]), '글 ');
  assert.equal(run([['start'], ['end', ''], ['input', '글'], ['xterm', '글 '], ['done']]), '글 ');
  assert.equal(run([['start'], ['end', '글'], ['xterm', '글.'], ['xterm', '글\r'], ['done']]), '글.\r');
});

test('delayed duplicate echo after finalize is dropped within the grace window only', () => {
  assert.equal(run([['start'], ['end', '글'], ['xterm', '글'], ['done'], ['wait', 20], ['xterm', '글']]), '글');
  // Long after, the same character is genuine new input.
  assert.equal(run([['start'], ['end', '글'], ['xterm', '글'], ['done'], ['wait', 500], ['xterm', '글']]), '글글');
});

test('rapid successive compositions with overlapping finalize timers', () => {
  // A ends, B starts and ends before A's timer fires; A's late timer must not
  // end B's finalize window.
  assert.equal(
    run([
      ['start'], ['end', '한'], ['xterm', '한'],
      ['start'], ['end', ''], ['input', '글'],
      ['done', 1], // stale timer of the first composition
      ['xterm', '글'], ['xterm', '글'], ['xterm', ' '],
      ['done', 2],
    ]),
    '한글 '
  );
  // Echo of A arriving while B is still finalizing is stripped too.
  assert.equal(run([['start'], ['end', '한'], ['start'], ['end', '글'], ['xterm', '한'], ['xterm', '글'], ['done', 1], ['done', 2]]), '한글');
});

test('non-duplicate input is never dropped while finalizing', () => {
  assert.equal(run([['start'], ['end', '글'], ['xterm', 'ab'], ['xterm', '\x7f'], ['xterm', '글'], ['done']]), '글ab\x7f');
});