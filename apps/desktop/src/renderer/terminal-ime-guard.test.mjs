import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalImeGuard } from './terminal-ime-guard.ts';

// Replays the DOM events ibus-hangul emits (real log C:\VM\qa3\n3-events.txt)
// plus the data events xterm 5.5 derives from them. Event kinds:
//   start | end <data> | input <text> (insertText) | xterm <data> | done
function run(events) {
  const sent = [];
  const guard = new TerminalImeGuard((d) => sent.push(d));
  for (const [kind, data] of events) {
    if (kind === 'start') guard.compositionStart();
    else if (kind === 'end') guard.compositionEnd(data);
    else if (kind === 'input') guard.inputCommit(data, 'insertText');
    else if (kind === 'done') guard.finalizeDone();
    else if (!guard.shouldDrop(data)) sent.push(data);
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
