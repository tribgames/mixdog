#!/usr/bin/env node
/**
 * termio-input-smoke.mjs — throwaway smoke for the vendored termio input
 * pipeline. Feeds synthetic chunk sequences through createInputParser() and
 * asserts the typed event kinds / channel routing decisions.
 *
 * Run: node scripts/termio-input-smoke.mjs
 */
import { createInputParser } from '../vendor/ink/build/input-parser.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`ok   - ${name}`);
  } else {
    failures++;
    console.log(`FAIL - ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

// Helper: push a list of chunks, collect all emitted events.
function run(chunks) {
  const p = createInputParser();
  const events = [];
  for (const c of chunks) events.push(...p.push(c));
  return { p, events };
}

// 1. ESC split across two chunks -> single arrow-up key, no lone escape.
{
  const { events } = run(['\x1b', '[A']);
  check('split ESC -> one up key',
    events.length === 1 && events[0].kind === 'key' && events[0].name === 'up',
    JSON.stringify(events));
}

// 2. SGR mouse click (button 0 press) -> ParsedMouse.
{
  const { events } = run(['\x1b[<0;12;34M']);
  const m = events[0];
  check('SGR click -> mouse press',
    events.length === 1 && m.kind === 'mouse' && m.action === 'press' &&
      m.col === 12 && m.row === 34 && m.button === 0,
    JSON.stringify(events));
}

// 3. SGR wheel-up (button 64) -> key wheelup (stays a key, routes to mouse chan).
{
  const { events } = run(['\x1b[<64;5;5M']);
  const k = events[0];
  check('SGR wheel -> wheelup key',
    events.length === 1 && k.kind === 'key' && k.name === 'wheelup',
    JSON.stringify(events));
}

// 4. X10 mouse: CSI M + 3 payload bytes (wheel-up: Cb = 0x40+32 = 96 = '`').
{
  const { events } = run(['\x1b[M\x60\x30\x30']);
  const k = events[0];
  check('X10 wheel -> wheelup key',
    events.length === 1 && k.kind === 'key' && k.name === 'wheelup',
    JSON.stringify(events));
}

// 5. Bracketed paste split across 3 chunks -> one pasted key with full body.
{
  const { events } = run(['\x1b[200~hel', 'lo wor', 'ld\x1b[201~']);
  const paste = events.find((e) => e.isPasted);
  check('split paste -> one pasted key "hello world"',
    events.length === 1 && paste && paste.sequence === 'hello world',
    JSON.stringify(events));
}

// 6. Paste whose body ends with an X10 mouse tail `\x1b[M` — the ESC in the
//    payload slot must NOT be consumed as X10 mouse; it stays paste content and
//    PASTE_END still terminates the paste.
{
  const { events } = run(['\x1b[200~abc\x1b[M12\x1b[201~']);
  const paste = events.find((e) => e.isPasted);
  check('paste with \\x1b[M tail stays paste',
    events.length === 1 && paste && paste.sequence === 'abc\x1b[M12',
    JSON.stringify(events));
}

// 7. Terminal response (DA1) -> ParsedResponse.
{
  const { events } = run(['\x1b[?62;1c']);
  const r = events[0];
  check('DA1 -> response',
    events.length === 1 && r.kind === 'response' && r.response.type === 'da1',
    JSON.stringify(events));
}

// 8. Lone ESC buffered -> hasPendingEscape true; flushPendingEscape -> escape key.
{
  const p = createInputParser();
  const first = p.push('\x1b');
  check('lone ESC buffers (no immediate events)', first.length === 0, JSON.stringify(first));
  check('hasPendingEscape true for lone ESC', p.hasPendingEscape() === true);
  const flushed = p.flushPendingEscape();
  check('flushPendingEscape -> escape key',
    Array.isArray(flushed) && flushed.length === 1 && flushed[0].name === 'escape',
    JSON.stringify(flushed));
}

// 9. Incomplete paste-start marker must NOT arm the escape flush timer.
{
  const p = createInputParser();
  p.push('\x1b[200');
  check('partial paste-start does not arm flush', p.hasPendingEscape() === false);
}

// 9b. Generic partial CSI (`\x1b[`, `\x1b[2`, `\x1b[20`) — none of these are
//     paste-start prefixes/penultimate, so hasPendingEscape MUST arm to avoid
//     buffering indefinitely.
{
  for (const partial of ['\x1b[', '\x1b[2', '\x1b[20']) {
    const p = createInputParser();
    p.push(partial);
    check(`generic partial CSI ${JSON.stringify(partial)} arms flush`,
      p.hasPendingEscape() === true);
  }
}

// 9c. `\x1b[200` and `\x1b[200~`-prefixed pending must NOT arm the flush
//     (paste-start marker / its penultimate prefix complete on their own).
{
  const p1 = createInputParser();
  p1.push('\x1b[200');
  check('"\\x1b[200" does not arm flush', p1.hasPendingEscape() === false);

  const p2 = createInputParser();
  p2.push('\x1b[200~hel'); // still inside paste body once PASTE_START token completes
  check('paste-start-prefixed pending does not arm flush', p2.hasPendingEscape() === false);
}

// 9d. Held-backspace chunk splits into individual key events; `\r`/`\t` in
//     text are NOT split.
{
  const { events } = run(['abc\x7f\x7f\x7f']);
  const names = events.map((e) => e.name || e.sequence);
  check('abc + 3x backspace -> text key(s) + 3 separate backspace keys',
    events.length === 4 &&
      events[0].sequence === 'abc' &&
      events.slice(1).every((e) => e.name === 'backspace' || e.sequence === '\x7f'),
    JSON.stringify(names));
}
{
  const { events } = run(['a\rb\tc']);
  check('\\r and \\t inside text are not split (single key for whole run)',
    events.length === 1 && events[0].sequence === 'a\rb\tc',
    JSON.stringify(events));
}

// 10. Plain text -> key events, sequence carries the character.
{
  const { events } = run(['a']);
  check('plain char -> key "a"',
    events.length === 1 && events[0].kind === 'key' && events[0].sequence === 'a',
    JSON.stringify(events));
}

// 11. Consumer-level routing: synthetic 'mouse' channel events reach the
//     use-mouse-input dispatch decisions exactly once each. We replicate the
//     hook's branch keys (kind:'key' wheel with ctrl-mask from sequence vs.
//     kind:'mouse' press) to guard against double-handling / mis-routing.
//     MOUSE_CTRL_MASK = 16; wheel ctrl bit is read from the SGR button in
//     the ParsedKey.sequence via /\x1b\[<(\d+);/ (no button field on wheel).
{
  const MOUSE_CTRL_MASK = 16;
  const WHEEL_SGR = /\x1b\[<(\d+);/;
  // Feed real parser output so field shapes match production.
  const wheelPlain = run(['\x1b[<64;5;5M']).events[0];      // wheelup, no ctrl
  const wheelCtrl = run(['\x1b[<80;5;5M']).events[0];        // 64|16 -> ctrl wheelup
  const click = run(['\x1b[<0;12;34M']).events[0];           // left press

  const routes = { zoom: 0, scroll: 0, press: 0, ignored: 0 };
  function route(event) {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'key') {
      if (event.name !== 'wheelup' && event.name !== 'wheeldown') { routes.ignored++; return; }
      const wm = WHEEL_SGR.exec(typeof event.sequence === 'string' ? event.sequence : '');
      const ctrl = wm ? ((Number(wm[1]) & MOUSE_CTRL_MASK) !== 0) : false;
      if (ctrl) routes.zoom++; else routes.scroll++;
      return;
    }
    if (event.kind !== 'mouse') { routes.ignored++; return; }
    const button = Number(event.button);
    if ((button & 3) === 0 && event.action === 'press' && (button & 32) === 0) routes.press++;
  }
  for (const e of [wheelPlain, wheelCtrl, click]) route(e);
  check('mouse routing: plain wheel -> scroll x1', routes.scroll === 1, JSON.stringify(routes));
  check('mouse routing: ctrl wheel -> zoom x1', routes.zoom === 1, JSON.stringify(routes));
  check('mouse routing: left press -> press x1 (no double)', routes.press === 1, JSON.stringify(routes));
  check('mouse routing: nothing mis-routed', routes.ignored === 0, JSON.stringify(routes));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
