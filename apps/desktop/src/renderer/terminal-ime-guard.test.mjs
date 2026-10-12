import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalImeGuard } from './terminal-ime-guard.ts';

// Event sequences captured from the installed Linux app (Ubuntu 24.04, GNOME
// Wayland, ibus-hangul, keys injected through uinput) while typing
// `gksrmf dkssudgktpdy⏎` (= 한글 안녕하세요⏎). Format: [ms, kind, ...args]
//   cs | cu data | ce data | in inputType data | kd key keyCode | ku key keyCode
// Both ibus-hangul commit shapes occur: compositionend{한} (A) and
// compositionend{''} followed by input insertText{글} (B).
const FAST = [
  [0,"cs"],
  [0,"cu","ㅎ"],
  [44,"in","insertCompositionText","ㅎ"],
  [45,"ku","g",71],
  [75,"cu","하"],
  [99,"in","insertCompositionText","하"],
  [99,"ku","k",75],
  [109,"cu","한"],
  [129,"in","insertCompositionText","한"],
  [129,"ku","s",83],
  [172,"cu","한"],
  [189,"in","insertCompositionText","한"],
  [189,"ce","한"],
  [195,"cs"],
  [195,"cu","ㄱ"],
  [221,"in","insertCompositionText","ㄱ"],
  [223,"ku","r",82],
  [247,"cu","그"],
  [257,"in","insertCompositionText","그"],
  [289,"ku","m",77],
  [342,"cu","글"],
  [379,"in","insertCompositionText","글"],
  [392,"ku","f",70],
  [393,"cu","글"],
  [424,"in","insertCompositionText","글"],
  [425,"ce","글"],
  [429,"kd"," ",32],
  [431,"in","insertText"," "],
  [432,"ku"," ",32],
  [485,"cs"],
  [485,"cu","ㅇ"],
  [507,"in","insertCompositionText","ㅇ"],
  [509,"ku","d",68],
  [577,"cu","아"],
  [593,"in","insertCompositionText","아"],
  [598,"ku","k",75],
  [671,"cu","안"],
  [707,"in","insertCompositionText","안"],
  [712,"ku","s",83],
  [754,"cu","안"],
  [782,"in","insertCompositionText","안"],
  [782,"ce","안"],
  [783,"cs"],
  [783,"cu","ㄴ"],
  [803,"in","insertCompositionText","ㄴ"],
  [813,"ku","s",83],
  [814,"cu","녀"],
  [842,"in","insertCompositionText","녀"],
  [860,"ku","u",85],
  [863,"cu","녕"],
  [881,"in","insertCompositionText","녕"],
  [882,"ku","d",68],
  [946,"cu","녕"],
  [960,"in","insertCompositionText","녕"],
  [960,"ce","녕"],
  [966,"cs"],
  [966,"cu","ㅎ"],
  [991,"in","insertCompositionText","ㅎ"],
  [992,"ku","g",71],
  [993,"cu","하"],
  [1002,"in","insertCompositionText","하"],
  [1015,"ku","k",75],
  [1059,"cu","핫"],
  [1088,"in","insertCompositionText","핫"],
  [1090,"ku","t",84],
  [1164,"cu","하"],
  [1196,"in","insertCompositionText","하"],
  [1196,"ce","하"],
  [1207,"cs"],
  [1207,"cu","세"],
  [1229,"in","insertCompositionText","세"],
  [1230,"ku","p",80],
  [1231,"cu","셍"],
  [1247,"in","insertCompositionText","셍"],
  [1248,"ku","d",68],
  [1263,"cu",""],
  [1290,"in","deleteContentBackward",""],
  [1290,"ce",""],
  [1293,"in","insertText","세"],
  [1296,"cs"],
  [1296,"cu","요"],
  [1298,"in","insertCompositionText","요"],
  [1305,"ku","y",89],
  [1372,"cu","요"],
  [1388,"in","insertCompositionText","요"],
  [1388,"ce","요"],
  [1390,"kd","Enter",13],
  [1452,"ku","Enter",13],
];
const SLOW = [
  [0,"cs"],
  [0,"cu","ㅎ"],
  [2,"in","insertCompositionText","ㅎ"],
  [150,"ku","g",71],
  [451,"cu","하"],
  [458,"in","insertCompositionText","하"],
  [603,"ku","k",75],
  [904,"cu","한"],
  [910,"in","insertCompositionText","한"],
  [1055,"ku","s",83],
  [1356,"cu","한"],
  [1362,"in","insertCompositionText","한"],
  [1362,"ce","한"],
  [1364,"cs"],
  [1364,"cu","ㄱ"],
  [1370,"in","insertCompositionText","ㄱ"],
  [1506,"ku","r",82],
  [1806,"cu","그"],
  [1812,"in","insertCompositionText","그"],
  [1956,"ku","m",77],
  [2258,"cu","글"],
  [2265,"in","insertCompositionText","글"],
  [2408,"ku","f",70],
  [2710,"cu",""],
  [2715,"in","deleteContentBackward",""],
  [2715,"ce",""],
  [2717,"in","insertText","글"],
  [2718,"kd"," ",32],
  [2719,"in","insertText"," "],
  [2860,"ku"," ",32],
  [3163,"cs"],
  [3163,"cu","ㅇ"],
  [3164,"in","insertCompositionText","ㅇ"],
  [3313,"ku","d",68],
  [3613,"cu","아"],
  [3620,"in","insertCompositionText","아"],
  [3764,"ku","k",75],
  [4066,"cu","안"],
  [4071,"in","insertCompositionText","안"],
  [4215,"ku","s",83],
  [4517,"cu",""],
  [4523,"in","deleteContentBackward",""],
  [4523,"ce",""],
  [4525,"in","insertText","안"],
  [4526,"cs"],
  [4526,"cu","ㄴ"],
  [4527,"in","insertCompositionText","ㄴ"],
  [4667,"ku","s",83],
  [4968,"cu","녀"],
  [4974,"in","insertCompositionText","녀"],
  [5118,"ku","u",85],
  [5419,"cu","녕"],
  [5425,"in","insertCompositionText","녕"],
  [5572,"ku","d",68],
  [5872,"cu","녕"],
  [5884,"in","insertCompositionText","녕"],
  [5884,"ce","녕"],
  [5885,"cs"],
  [5886,"cu","ㅎ"],
  [5892,"in","insertCompositionText","ㅎ"],
  [6020,"ku","g",71],
  [6323,"cu","하"],
  [6329,"in","insertCompositionText","하"],
  [6472,"ku","k",75],
  [6773,"cu","핫"],
  [6779,"in","insertCompositionText","핫"],
  [6923,"ku","t",84],
  [7223,"cu",""],
  [7230,"in","deleteContentBackward",""],
  [7230,"ce",""],
  [7232,"in","insertText","하"],
  [7233,"cs"],
  [7233,"cu","세"],
  [7234,"in","insertCompositionText","세"],
  [7378,"ku","p",80],
  [7678,"cu","셍"],
  [7684,"in","insertCompositionText","셍"],
  [7828,"ku","d",68],
  [8130,"cu","세"],
  [8136,"in","insertCompositionText","세"],
  [8136,"ce","세"],
  [8138,"cs"],
  [8138,"cu","요"],
  [8143,"in","insertCompositionText","요"],
  [8280,"ku","y",89],
  [8581,"cu","요"],
  [8587,"in","insertCompositionText","요"],
  [8587,"ce","요"],
  [8589,"kd","Enter",13],
  [8740,"ku","Enter",13],
];
const DIGITS = [
  [0,"cs"],
  [0,"cu","ㅎ"],
  [9,"in","insertCompositionText","ㅎ"],
  [19,"ku","g",71],
  [60,"cu","하"],
  [68,"in","insertCompositionText","하"],
  [79,"ku","k",75],
  [121,"cu","한"],
  [127,"in","insertCompositionText","한"],
  [142,"ku","s",83],
  [182,"cu","한"],
  [189,"in","insertCompositionText","한"],
  [189,"ce","한"],
  [190,"cs"],
  [191,"cu","ㄱ"],
  [199,"in","insertCompositionText","ㄱ"],
  [205,"ku","r",82],
  [244,"cu","그"],
  [249,"in","insertCompositionText","그"],
  [263,"ku","m",77],
  [303,"cu","글"],
  [309,"in","insertCompositionText","글"],
  [324,"ku","f",70],
  [365,"cu",""],
  [371,"in","deleteContentBackward",""],
  [371,"ce",""],
  [374,"in","insertText","글"],
  [375,"kd","1",49],
  [385,"ku","1",49],
  [431,"kd","2",50],
  [448,"ku","2",50],
  [489,"kd","3",51],
  [508,"ku","3",51],
  [557,"kd","Shift",16],
  [558,"kd","!",49],
  [572,"ku","!",49],
  [573,"ku","Shift",16],
  [613,"kd","Enter",13],
  [633,"ku","Enter",13],
]; // gksrmf123!⏎ typed fast
const BACKSPACE = [
  [0,"cs"],
  [0,"cu","ㄱ"],
  [8,"in","insertCompositionText","ㄱ"],
  [40,"ku","r",82],
  [122,"cu","가"],
  [130,"in","insertCompositionText","가"],
  [164,"ku","k",75],
  [246,"cu","각"],
  [254,"in","insertCompositionText","각"],
  [286,"ku","r",82],
  [370,"cu","가"],
  [377,"in","insertCompositionText","가"],
  [377,"ce","가"],
  [379,"cs"],
  [380,"cu","고"],
  [387,"in","insertCompositionText","고"],
  [410,"ku","h",72],
  [492,"cu","ㄱ"],
  [499,"in","insertCompositionText","ㄱ"],
  [531,"ku","Backspace",8],
  [613,"cu","ㄳ"],
  [621,"in","insertCompositionText","ㄳ"],
  [653,"ku","t",84],
  [733,"cu",""],
  [740,"in","deleteContentBackward",""],
  [741,"ce",""],
  [742,"in","insertText","ㄱ"],
  [742,"cs"],
  [742,"cu","수"],
  [745,"in","insertCompositionText","수"],
  [781,"ku","n",78],
  [856,"cu","수"],
  [863,"in","insertCompositionText","수"],
  [863,"ce","수"],
  [865,"kd","Enter",13],
  [905,"ku","Enter",13],
]; // rkrh⌫tn⏎ (가ㄱ수: backspace splits 고 into ㄱ)

// What xterm 5.5.0 does with these events, transcribed from its CompositionHelper
// and Terminal._keyDown/_inputEvent. `timerMs` is how late its setTimeout(0)
// callbacks run (the real app ran them up to ~120 ms late).
class XtermModel {
  constructor(textarea, onData, timerMs) {
    this.ta = textarea;
    this.onData = onData;
    this.timerMs = timerMs;
    this.composing = false;
    this.sending = false;
    this.pos = { start: 0, end: 0 };
    this.sent = '';
    this.keyDownSeen = false;
    this.timers = [];
  }
  later(now, fn) {
    this.timers.push({ at: now + this.timerMs, fn });
  }
  runTimers(upTo) {
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      if (!this.timers.length || this.timers[0].at > upTo) return;
      this.timers.shift().fn();
    }
  }
  finalize(wait, now) {
    this.composing = false;
    if (wait) {
      const e = { start: this.pos.start, end: this.pos.end };
      this.sending = true;
      this.later(now, () => {
        if (!this.sending) return;
        this.sending = false;
        e.start += this.sent.length;
        const text = this.composing ? this.ta.value.substring(e.start, e.end) : this.ta.value.substring(e.start);
        if (text.length > 0) this.onData(text);
      });
    } else {
      this.sending = false;
      this.onData(this.ta.value.substring(this.pos.start, this.pos.end));
    }
  }
  handle(ev, now) {
    const [, kind, a, b] = ev;
    if (kind === 'cs') {
      this.composing = true;
      this.pos.start = this.ta.value.length;
      this.sent = '';
    } else if (kind === 'cu') {
      this.later(now, () => {
        this.pos.end = this.ta.value.length;
      });
    } else if (kind === 'ce') {
      this.finalize(true, now);
    } else if (kind === 'kd') {
      this.keyDownSeen = true;
      if ((this.composing || this.sending) && ![229, 16, 17, 18].includes(b)) this.finalize(false, now);
      if (a === 'Enter') this.onData('\r');
      else if (a.length === 1) this.onData(a);
    } else if (kind === 'ku') {
      this.keyDownSeen = false;
    } else if (kind === 'in' && a === 'insertText' && b && !this.keyDownSeen) {
      this.onData(b);
    }
  }
}

// Replays a capture through a minimal textarea, the guard (capture phase, ahead
// of xterm) and the xterm model; returns what would be written to the pty.
function replay(events, { guard: useGuard = true, timerMs = 0, clock = null } = {}) {
  const ta = { value: '' };
  const sent = [];
  let now = 0;
  const guard = new TerminalImeGuard((d) => sent.push(d), ta, () => now);
  const xterm = new XtermModel(
    ta,
    (d) => {
      const out = useGuard ? guard.filter(d) : d;
      if (out !== '') sent.push(out);
    },
    timerMs
  );
  let compStart = 0;
  for (const ev of events) {
    now = ev[0];
    xterm.runTimers(now);
    const [, kind, a, b] = ev;
    if (kind === 'x') continue; // recorded xterm output; the model produces its own
    let stopped = false;
    // browser-side effect on the textarea
    if (kind === 'cs') compStart = ta.value.length;
    if (kind === 'in') {
      if (a === 'insertCompositionText') ta.value = ta.value.slice(0, compStart) + b;
      else if (a === 'deleteContentBackward') ta.value = ta.value.slice(0, compStart);
      else if (a === 'insertText') ta.value += b;
    }
    // ancestor capture listener: the guard
    if (useGuard) {
      if (kind === 'cs') guard.compositionStart();
      else if (kind === 'ce') guard.compositionEnd(a);
      else if (kind === 'in') stopped = guard.input(a, b);
    }
    if (!stopped) xterm.handle(ev, now);
  }
  xterm.runTimers(Infinity);
  return sent.join('');
}

const timers = [0, 5, 60, 120, 400];

test('captured fast run: 한글 안녕하세요⏎ is sent exactly once per syllable', () => {
  for (const timerMs of timers) assert.equal(replay(FAST, { timerMs }), '한글 안녕하세요\r', `timer ${timerMs}ms`);
});

test('captured slow run (~450 ms between keys)', () => {
  for (const timerMs of timers) assert.equal(replay(SLOW, { timerMs }), '한글 안녕하세요\r', `timer ${timerMs}ms`);
});

test('digits and punctuation after Korean are neither doubled nor dropped', () => {
  for (const timerMs of timers) assert.equal(replay(DIGITS, { timerMs }), '한글123!\r', `timer ${timerMs}ms`);
});

test('backspace splitting a syllable leaves the jamo, next syllable follows', () => {
  for (const timerMs of timers) assert.equal(replay(BACKSPACE, { timerMs }), '가ㄱ수\r', `timer ${timerMs}ms`);
});

test('the xterm model reproduces the doubling of the capture without the guard', () => {
  // Fails if the model stopped modelling xterm: unguarded, a B commit is
  // emitted twice by xterm itself.
  assert.notEqual(replay(SLOW, { guard: false, timerMs: 60 }), '한글 안녕하세요\r');
});

// --- unit rules ---

function guardWith() {
  const sent = [];
  let now = 0;
  const ta = { value: '' };
  const guard = new TerminalImeGuard((d) => sent.push(d), ta, () => now);
  return { guard, sent, ta, at: (t) => (now = t) };
}

test('compositionend data is sent once and empties the textarea', () => {
  const { guard, sent, ta } = guardWith();
  ta.value = '한';
  guard.compositionStart();
  guard.compositionEnd('한');
  assert.deepEqual(sent, ['한']);
  assert.equal(ta.value, '');
});

test('empty compositionend: the following insertText is the commit, sent once and consumed', () => {
  const { guard, sent, ta } = guardWith();
  guard.compositionStart();
  guard.compositionEnd('');
  ta.value = '글';
  assert.equal(guard.input('insertText', '글'), true);
  assert.deepEqual(sent, ['글']);
  assert.equal(ta.value, '');
  // a second insertText of the same text is not part of this commit
  assert.equal(guard.input('insertText', '글'), false);
});

test('insertText repeating an already sent compositionend text is consumed once', () => {
  const { guard, sent } = guardWith();
  guard.compositionStart();
  guard.compositionEnd('한');
  assert.equal(guard.input('insertText', '한'), true);
  assert.equal(guard.input('insertText', '한'), false);
  assert.deepEqual(sent, ['한']);
});

test('other insertText (space after a commit, text unrelated to a commit) is left to xterm', () => {
  const { guard, sent } = guardWith();
  guard.compositionStart();
  guard.compositionEnd('글');
  assert.equal(guard.input('insertText', ' '), false);
  assert.equal(guard.input('insertCompositionText', '글'), false);
  assert.deepEqual(sent, ['글']);
});

test('insertText long after a cancelled composition is not taken for a commit', () => {
  const { guard, sent, at } = guardWith();
  at(0);
  guard.compositionStart();
  guard.compositionEnd('');
  at(1000);
  assert.equal(guard.input('insertText', 'a'), false);
  assert.deepEqual(sent, []);
});

test('filter drops only slices of the preedit text while composing', () => {
  const { guard, ta } = guardWith();
  guard.compositionStart();
  ta.value = 'ㄱ';
  assert.equal(guard.filter('ㄱ'), '');
  assert.equal(guard.filter(' '), ' ');
  assert.equal(guard.filter('a'), 'a');
  assert.equal(guard.filter('\r'), '\r');
  assert.equal(guard.filter('\x1b[A'), '\x1b[A');
  guard.compositionEnd('');
  assert.equal(guard.filter('ㄱ'), 'ㄱ'); // not composing: always passes
});
