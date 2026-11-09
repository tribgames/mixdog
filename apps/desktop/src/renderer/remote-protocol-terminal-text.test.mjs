// The terminal script compares the text the phone receives exactly: a reply's `replay` and the streamed output differ in the trace
// when one character differs or any data is added, so a corrupted or extra byte cannot pass; only what ConPTY re-renders after a
// resize, the shell's echo of the typed command (redrawn per keystroke, differently from one Node recording to the next) and the answers
// kept as `id` and `sizeOwner` are outside the comparison (see benchmarks/rust-core/recorders/lib/phone-terminal-script.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { MARK, play } from '../../../../benchmarks/rust-core/recorders/lib/phone-terminal-script.mjs';

const PROMPT = 'PS D:\\x> ';
const text = `${PROMPT}Write-Output ${MARK}\r\n\x1b[m${MARK}\r\n${PROMPT}`;
const corrupted = text.replace(`\x1b[m${MARK}`, '\x1b[mMIXDOG_PH2_DONF');
const RERENDER = '\x1b[8;30;100t\x1b[HPS D:\\x> ';

async function trace({ replay, output, only }) {
  const script = {
    cwd: 'D:\\x',
    ops: [
      { op: 'call', name: 'termAttach', params: ['t'], ...(only ? { only } : {}) },
      { op: 'until', kind: 'output', text: MARK },
    ],
  };
  const driver = {
    call: async () => ({ id: 't', replay, sizeOwner: { cols: 1, rows: 1, own: true } }),
    waitFor: async () => {},
    events: () => ({ activity: [], sizeOwner: [], folder: [], run: [], output }),
  };
  return JSON.parse(JSON.stringify(await play(script, driver)));
}

test('identical terminal text gives identical traces', async () => {
  assert.deepEqual(await trace({ replay: text, output: text }), await trace({ replay: text, output: text }));
});

test('a reply whose replay carries extra or corrupted text differs from the exact one', async () => {
  const exact = await trace({ replay: text, output: text });
  assert.notDeepEqual(await trace({ replay: `CORRUPTED OR EXTRA DATA ${text}`, output: text }), exact);
  assert.notDeepEqual(await trace({ replay: `${text}x`, output: text }), exact);
  assert.notDeepEqual(await trace({ replay: corrupted, output: text }), exact);
});

test('streamed output with extra or corrupted text differs from the exact one', async () => {
  const exact = await trace({ replay: text, output: text });
  assert.notDeepEqual(await trace({ replay: text, output: `CORRUPTED OR EXTRA DATA ${text}` }), exact);
  assert.notDeepEqual(await trace({ replay: text, output: corrupted }), exact);
  assert.notDeepEqual(await trace({ replay: text, output: `${text}extra` }), exact);
});

test("the shell's echo of the typed command is outside the comparison, the text around it is not", async () => {
  const redrawn = text.replace(`Write-Output ${MARK}\r\n\x1b[m`, '\x1b[93mW\x1b[97mrite-Output MIXDOG_PH2_DONE\x1b[1;43H');
  assert.notEqual(redrawn, text);
  assert.deepEqual(await trace({ replay: text, output: redrawn }), await trace({ replay: text, output: text }));
});

test('what ConPTY re-renders after the first resize report is outside the comparison, the text before it is not', async () => {
  const exact = await trace({ replay: text, output: `${text}${RERENDER}one frame` });
  assert.deepEqual(await trace({ replay: text, output: `${text}${RERENDER}another form of the frame, longer` }), exact);
  assert.notDeepEqual(await trace({ replay: text, output: `${text}x${RERENDER}one frame` }), exact);
});

test('a reply kept as id and sizeOwner does not hold the replay', async () => {
  const only = ['id', 'sizeOwner'];
  assert.deepEqual(await trace({ replay: text, output: text, only }), await trace({ replay: `${text}${RERENDER}`, output: text, only }));
});
