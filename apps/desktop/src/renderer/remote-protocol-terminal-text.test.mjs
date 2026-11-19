// The real playback comparator processes synthetic phone traces, with the same termData, resize and snap boundaries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTraces, nodeView, stateAt } from './remote-protocol-terminal-compare.mjs';

const TAB = 'term_checkpoint';
const prompt = 'test> ';
const text = `${prompt}echo DONE\r\nDONE\r\n${prompt}`;
const data = (bytes) => ({ push: 'termData', event: { id: TAB, data: bytes } });
const resize = { push: 'sizeOwner', event: { id: TAB, cols: 100, rows: 30, own: true } };
const snap = { snap: 'result' };

function trace({ replay = text, stream = [data(text)], after = [] } = {}) {
  return {
    order: [{ call: 'termAttach', params: [TAB], value: { id: TAB, replay } }, ...stream, snap, ...after],
    claims: { order: [] },
    immediate: { order: [] },
  };
}

const baseline = [trace()];
const differsAtSnap = /order: term_checkpoint's screen before entry \d+/;
const withOutput = (output) => trace({ stream: [data(output)] });

test('the same playback screen accepts redrawn and differently chunked output', async () => {
  const got = trace({ stream: [data(`${prompt}ech`), data(`\x1b[3Decho DONE\r\nDONE\r\n${prompt}`)] });
  const { exemptions, bytes } = await compareTraces(got, baseline);
  assert.deepEqual(exemptions, []);
  assert.ok(bytes.some(({ tab, where, exact }) => tab === TAB && where === 'before entry 1' && !exact));
});

test('an attach replay with an extra line or corrupted text is refused as an answer, not a stream difference', async () => {
  for (const replay of [`${text}\r\nextra line`, text.replace('\r\nDONE', '\r\nDOME')]) {
    await assert.rejects(compareTraces(trace({ replay }), baseline), /order entry 0[\s\S]*value\.replay: normal line/);
  }
});

test('an extra line, corrupted text or changed colour in streamed output is refused at the checkpoint', async () => {
  for (const output of [
    text.replace(`DONE\r\n${prompt}`, `DONE\r\nextra\r\n${prompt}`),
    `${text}x`,
    text.replace(`DONE\r\n${prompt}`, `\x1b[31mDONE\x1b[m\r\n${prompt}`),
  ]) {
    await assert.rejects(compareTraces(withOutput(output), baseline), differsAtSnap);
  }
});

test('the checkpoint applies a size-owner push before comparing later output', async () => {
  const reference = [trace({ stream: [data(text), resize, data('\x1b[HAfter')] })];
  const { analyses: [analysis] } = await nodeView(reference, 'order');
  assert.deepEqual(stateAt(analysis, 2, TAB).size, [100, 30]);
  await assert.rejects(
    compareTraces(trace({ stream: [data(text), resize, data('\x1b[HAfteR')] }), reference),
    differsAtSnap
  );
});

test('the result checkpoint catches title and scrollback changes that are absent from the final screen', async () => {
  const title = (value) => `\x1b]2;${value}\x07`;
  const output = (first, heading) => `${title(heading)}${first}\r\n${'intermediate\r\n'.repeat(23)}visible`;
  // After the checkpoint, clear both the screen and scrollback and restore the same title.
  const after = [data(`\x1b[3J\x1b[2J\x1b[H${title('Final title')}finished`)];
  const reference = [trace({ stream: [data(output('Old line', 'Checkpoint title'))], after })];
  const { analyses: [analysis] } = await nodeView(reference, 'order');
  const checkpoint = stateAt(analysis, 1, TAB);
  assert.equal(checkpoint.title, 'Checkpoint title');
  assert.deepEqual(checkpoint['normal viewport'], [1, 1]);
  assert.match(checkpoint['normal line 0'], /^Old line/);
  assert.match(checkpoint['normal line 24'], /^visible/);
  for (const [first, heading, unit] of [
    ['Old line', 'Wrong title', 'title'],
    ['New line', 'Checkpoint title', 'normal line 0'],
  ]) {
    const got = trace({ stream: [data(output(first, heading))], after });
    const { analyses: [candidate] } = await nodeView([got], 'order');
    assert.deepEqual(stateAt(candidate, 2, TAB), stateAt(analysis, 2, TAB));
    await assert.rejects(compareTraces(got, reference), new RegExp(`screen before entry 1[\\s\\S]*${unit}: got`));
  }
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
    await assert.rejects(compareTraces(withOutput(`${text}${right}`), [withOutput(`${text}${left}`)]), differsAtSnap);
  });
}

test('no cursor escape and a blinking bar are the same screen: the view\'s own cursor', async () => {
  await compareTraces(withOutput(`${text}\x1b[5 q`), baseline);
});

test('playback compares retained cell attributes, including on blanks', async () => {
  for (const attr of ['1;31', '41', '4', '7']) {
    const plain = withOutput(`${text}ab   \x1b[3D`);
    const decorated = withOutput(`${text}ab\x1b[${attr}m   \x1b[m\x1b[3D`);
    await assert.rejects(compareTraces(decorated, [plain]), differsAtSnap);
  }
});