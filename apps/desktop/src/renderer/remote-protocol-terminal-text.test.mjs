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
