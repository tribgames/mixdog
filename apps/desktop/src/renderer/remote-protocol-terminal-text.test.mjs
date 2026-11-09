// The terminal script compares what the user sees: a reply's `replay` and each snapped tab's streamed output become the screen the
// text draws (rows' text and attributes, cursor, size). Differences in how the bytes got there are not differences on screen; any
// changed, extra or missing visible text, colour, cursor position or size is (see benchmarks/rust-core/recorders/lib/phone-terminal-script.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { MARK, play } from '../../../../benchmarks/rust-core/recorders/lib/phone-terminal-script.mjs';

const PROMPT = 'PS D:\\x> ';
const text = `${PROMPT}Write-Output ${MARK}\r\n\x1b[m${MARK}\r\n${PROMPT}`;
const RESIZE = '\x1b[8;30;100t';

async function trace({ replay, output }) {
  const script = {
    cwd: 'D:\\x',
    ops: [
      { op: 'call', name: 'termAttach', params: ['t'] },
      { op: 'snap', name: 's', tabs: ['t'] },
    ],
  };
  const driver = {
    call: async () => ({ id: 't', replay, sizeOwner: { cols: 1, rows: 1, own: true } }),
    waitFor: async () => {},
    events: () => ({ activity: [], sizeOwner: [], folder: [], run: [], output: { t: output } }),
  };
  return JSON.parse(JSON.stringify(await play(script, driver)));
}

test('identical terminal text gives identical traces', async () => {
  assert.deepEqual(await trace({ replay: text, output: text }), await trace({ replay: text, output: text }));
});

test('a reply whose replay carries an extra line or corrupted text differs', async () => {
  const exact = await trace({ replay: text, output: text });
  assert.notDeepEqual(await trace({ replay: `${text}\r\nextra line`, output: text }), exact);
  assert.notDeepEqual(await trace({ replay: text.replace(`\x1b[m${MARK}`, '\x1b[mMIXDOG_PH2_DONF'), output: text }), exact);
});

test('streamed output with an extra line or corrupted text differs', async () => {
  const exact = await trace({ replay: text, output: text });
  assert.notDeepEqual(await trace({ replay: text, output: text.replace(`${MARK}\r\n${PROMPT}`, `${MARK}\r\nextra\r\n${PROMPT}`) }), exact);
  assert.notDeepEqual(await trace({ replay: text, output: `${text}x` }), exact);
});

test('corrupted text after a resize differs', async () => {
  const exact = await trace({ replay: text, output: `${text}${RESIZE}\x1b[HAfter` });
  assert.notDeepEqual(await trace({ replay: text, output: `${text}${RESIZE}\x1b[HAfteR` }), exact);
  assert.notDeepEqual(await trace({ replay: `${text}${RESIZE}\x1b[HAfteR`, output: text }), await trace({ replay: `${text}${RESIZE}\x1b[HAfter`, output: text }));
});

test('a different colour on the same text differs', async () => {
  assert.notDeepEqual(await trace({ replay: text, output: text.replace(MARK + '\r\n' + PROMPT, `\x1b[31m${MARK}\x1b[m\r\n${PROMPT}`) }), await trace({ replay: text, output: text }));
});

test('byte streams that draw the same screen are the same trace', async () => {
  const redrawn = text.replace(`Write-Output ${MARK}`, `Wri\x1b[3DWrite-Output ${MARK}`);
  assert.notEqual(redrawn, text);
  assert.deepEqual(await trace({ replay: redrawn, output: redrawn }), await trace({ replay: text, output: text }));
});

// Everything a user can see differs: each pair draws the same characters and differs in one visible thing.
const visibly = {
  'a hidden cursor': ['', '\x1b[?25l'],
  'a block, bar or underline cursor': ['\x1b[2 q', '\x1b[6 q'],
  'a blinking cursor': ['\x1b[2 q', '\x1b[1 q'],
  'a straight, double, curly, dotted or dashed underline': ['\x1b[4mX\x1b[m', '\x1b[4:3mX\x1b[m'],
  'an underline in red or green': ['\x1b[4m\x1b[58;2;255;0;0mX\x1b[m', '\x1b[4m\x1b[58;2;0;255;0mX\x1b[m'],
  'an overline': ['X', '\x1b[53mX\x1b[m'],
  'a link target': ['\x1b]8;;http://a\x07X\x1b]8;;\x07', '\x1b]8;;http://b\x07X\x1b]8;;\x07'],
  'the alternate buffer': ['', '\x1b[?1049h'],
  // The app's terminal view draws a blinking bar until the shell asks for another (TerminalPane.tsx), so a stream that never says and one
  // that asks for the emulator's own default (a steady block) are different screens.
  'no cursor escape and an explicit steady block': ['', '\x1b[2 q'],
  'a bold underlined blank': ['ab\x1b[4m   \x1b[m\x1b[3D', 'ab\x1b[4;1m   \x1b[m\x1b[3D'],
  'a dim underlined blank': ['ab\x1b[4m   \x1b[m\x1b[3D', 'ab\x1b[4;2m   \x1b[m\x1b[3D'],
  'a red foreground on an underlined blank': ['ab\x1b[4m   \x1b[m\x1b[3D', 'ab\x1b[4;31m   \x1b[m\x1b[3D'],
  'italic on a background-coloured blank': ['ab\x1b[41m   \x1b[m\x1b[3D', 'ab\x1b[41;3m   \x1b[m\x1b[3D'],
  'a struck blank in bold': ['ab\x1b[9m   \x1b[m\x1b[3D', 'ab\x1b[9;1m   \x1b[m\x1b[3D'],
};
for (const [what, [left, right]] of Object.entries(visibly)) {
  test(`${what} is a different screen`, async () => {
    assert.notDeepEqual(await trace({ replay: text, output: `${text}${left}` }), await trace({ replay: text, output: `${text}${right}` }));
  });
}

test('no cursor escape and a blinking bar are the same screen: the view\'s own cursor', async () => {
  assert.deepEqual(await trace({ replay: text, output: text }), await trace({ replay: text, output: `${text}\x1b[5 q` }));
});

test('an underline colour that no underline shows is not a different screen', async () => {
  assert.deepEqual(await trace({ replay: text, output: `${text}\x1b[58;2;255;0;0mX\x1b[m` }), await trace({ replay: text, output: `${text}X` }));
});

// What a blank cell does not show is not a difference; what it does show is.
test('a foreground colour on blank cells is not a different screen, a background or an underline on them is', async () => {
  const plain = await trace({ replay: text, output: `${text}ab` });
  assert.deepEqual(await trace({ replay: text, output: `${text}ab\x1b[1;31m   \x1b[m\x1b[3D` }), plain);
  assert.notDeepEqual(await trace({ replay: text, output: `${text}ab\x1b[41m   \x1b[m\x1b[3D` }), plain);
  assert.notDeepEqual(await trace({ replay: text, output: `${text}ab\x1b[4m   \x1b[m\x1b[3D` }), plain);
  assert.notDeepEqual(await trace({ replay: text, output: `${text}ab\x1b[7m   \x1b[m\x1b[3D` }), plain);
});