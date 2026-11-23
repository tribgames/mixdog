// A record's text is held once: the core tells a tool's output when the tool ends and again when its record is stored
// (and whenever a window reads the record again), each frame parsing to strings of its own, while the reader keeps the
// rows it was shown. Measured on the heap: equal strings cannot be told apart any other way.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { Json } from '../src/api.ts';
import type { Obj } from '../src/obj.ts';
import { desktopSessionState, sessionReducer, type SessionFold } from '../src/session-state.ts';

v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc') as () => void;
/** What stays held: weakly keyed entries go a collection after their keys, so it settles over a few turns. */
const heldBytes = async (): Promise<number> => {
  for (let round = 0; round < 4; round += 1) {
    collect();
    await new Promise((turn) => setImmediate(turn));
  }
  return v8.getHeapStatistics().used_heap_size;
};

const TOOLS = 40;
const TEXT_BYTES = 256 * 1024;
const pos = (id: string) => `h1:0:${id}`;
const end = { kind: 'end' };
/** As a frame arrives: parsed, every string its own. */
const frame = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const output = (index: number): string => `${String(index).padStart(8, '0')}:`.repeat(TEXT_BYTES / 9);
const tool = (index: number, stored: boolean): Obj => ({
  type: 'toolCall',
  id: `t${index}`,
  name: 'read',
  input: { file_path: `f${index}.ts` },
  output: output(index),
  meta: { status: 'completed', ...(stored ? { ext: { historyPosition: pos(`t${index}`) } } : {}) },
});
const at = (s: SessionFold, method: string, params: Obj) =>
  sessionReducer.apply(s, frame({ method, params: { threadId: 't', ...params } }) as never);
const shown = (fold: SessionFold): Obj[] => desktopSessionState(fold, []).items as Obj[];

test('a tool output shown and then stored as its record is held once, beside the rows the reader keeps', async () => {
  const first = { type: 'agentMessage', id: 'a0', text: 'a0', meta: { ext: { historyPosition: pos('a0') } } };
  let fold = sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: [],
    hasOlder: false,
    window: {
      windowVersion: 10,
      lineage: 1,
      ranges: [{ id: 'tail', older: end, newer: end }],
      added: [{ range: 'tail', units: [{ position: pos('a0'), items: [first] }] }],
      followTail: true,
    },
  } as unknown as Json);
  const before = await heldBytes();

  // Each tool ends (its row is shown), and the reader reads the frame.
  let read: Obj[] = shown(fold);
  for (let index = 0; index < TOOLS; index += 1) {
    fold = at(fold, 'item/completed', { item: tool(index, false) });
    read = shown(fold);
  }
  const once = await heldBytes() - before;
  assert.ok(once > TOOLS * TEXT_BYTES * 0.9, `the outputs are held: ${once} bytes`);

  // Each record is stored: the core tells the output again, in a frame of its own.
  let after = 'a0';
  for (let index = 0; index < TOOLS; index += 1) {
    fold = at(fold, 'thread/transcript/changed', {
      lineage: 1,
      change: { op: 'insert', after: pos(after), unit: { position: pos(`t${index}`), items: [tool(index, true)] } },
    });
    after = `t${index}`;
  }
  assert.equal(fold.loose?.length ?? 0, 0, 'every row shown gave way to its record');
  const stored = shown(fold);
  const both = await heldBytes() - before;
  // The reader's rows (`read`) and the fold's are both alive here.
  assert.ok(read.length > 0 && stored.length > 0);
  assert.ok(both < once * 1.3, `the stored records brought no second copy of the outputs: ${once} bytes shown, ${both} with the records stored`);

  // A window that reads the records again tells them once more.
  fold = at(fold, 'thread/window/changed', {
    subscriptionId: 'sub',
    requestId: 'q1',
    windowVersion: 20,
    lineage: 1,
    atFeedPosition: { epoch: 'e', seq: 20 },
    ranges: [{ id: 'tail', older: end, newer: end }],
    removed: [],
    added: [
      {
        range: 'tail',
        units: [
          { position: pos('a0'), items: [first] },
          ...Array.from({ length: TOOLS }, (_, index) => ({ position: pos(`t${index}`), items: [tool(index, true)] })),
        ],
      },
    ],
    followTail: true,
  });
  const again = shown(fold);
  const reread = await heldBytes() - before;
  assert.ok(read.length > 0 && stored.length > 0 && again.length > 0);
  assert.ok(reread < once * 1.3, `records read again brought no further copy: ${once} bytes shown, ${reread} after the window read them again`);
});
