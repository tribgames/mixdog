// The replay window at its boundary as the phone gets it: the JSON text of `replay` in a `termAttach`/`termEnsure` answer equals the JSON
// text Node's relay wrote (apps/mobile/fixtures/phone-terminal/golden.json, trace.replayWindow, `json`), a lone low surrogate included.
// The core's answer is the window's units after the lone surrogate as `replay` and that surrogate as `replayLeadUnit` (proven unit for unit
// against the same recording by mixdog-spawn tests/terminal.rs `the_replay_window_is_nodes_at_its_boundary`); this is the adapter's half.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { terminalReply } from '../shared/terminal-protocol.ts';

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-terminal/golden.json', import.meta.url), 'utf8'));

/** The core's answer for a window of `units` (an array of UTF-16 units). */
function coreReply(units) {
  const lone = units[0] >= 0xdc00 && units[0] < 0xe000;
  const rest = lone ? units.slice(1) : units;
  let replay = '';
  for (let at = 0; at < rest.length; at += 8192) replay += String.fromCharCode(...rest.slice(at, at + 8192));
  return { id: 'term_window', replay, sizeOwner: null, client: '1', ...(lone ? { replayLeadUnit: units[0] } : {}) };
}

test('the replay window reaches the phone as the JSON text Node wrote', () => {
  const cases = golden.trace.replayWindow;
  assert.equal(cases.length, 6);
  for (const { name, chunks, length, json } of cases) {
    const text = chunks.map((chunk) => chunk.map(([part, count]) => part.repeat(count)).join('')).join('');
    const units = Array.from({ length }, (_, at) => text.charCodeAt(text.length - length + at));
    const answer = terminalReply(coreReply(units));
    assert.deepEqual(Object.keys(answer), ['id', 'replay'], `${name}: Node's keys`);
    assert.equal(JSON.stringify(answer.replay).slice(0, json.length), json, name);
  }
});
