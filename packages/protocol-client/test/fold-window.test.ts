// The live fold stays bounded while a thread is followed, and the merged transcript keeps the identity of every card whose rows did
// not change, so a reader comparing by identity skips them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { FOLD_MAX_ITEMS, desktopSessionState, sessionReducer, type SessionFold } from '../src/session-state.ts';

const apply = (fold: SessionFold, method: string, params: Obj): SessionFold =>
  sessionReducer.apply(fold, { jsonrpc: '2.0', method, params } as never);
const reply = (id: string): Obj => ({ item: { type: 'agentMessage', id, text: id, meta: { status: 'completed' } } });
const empty = (): SessionFold => sessionReducer.initial({ thread: { id: 't' }, state: {}, items: [] });

test('a fold past its window drops its oldest rows and says older rows exist', () => {
  let fold = empty();
  for (let i = 0; i < FOLD_MAX_ITEMS; i++) fold = apply(fold, 'item/completed', reply(`r${i}`));
  assert.equal(fold.items.length, FOLD_MAX_ITEMS);
  assert.equal(
    desktopSessionState(fold, []).transcriptHasOlder,
    undefined,
    'a full window that dropped nothing has nothing older'
  );
  // A row replaced in place drops nothing.
  fold = apply(fold, 'item/completed', {
    item: { type: 'agentMessage', id: 'r0', text: 'again', meta: { status: 'completed' } },
  });
  assert.equal(fold.items.length, FOLD_MAX_ITEMS);
  assert.equal(fold.items[0]!.text, 'again');
  assert.equal(fold.fields.transcriptHasOlder, undefined);
  const revision = fold.structureRevision;
  for (let i = 0; i < 5; i++) fold = apply(fold, 'item/completed', reply(`n${i}`));
  assert.equal(fold.items.length, FOLD_MAX_ITEMS);
  assert.equal(fold.items[0]!.id, 'r5', 'the oldest rows went');
  assert.equal(fold.items.at(-1)!.id, 'n4');
  assert.equal(fold.structureRevision, revision + 5);
  assert.equal(desktopSessionState(fold, []).transcriptHasOlder, true);
  // A rewind inside the window leaves the dropped rows above it, whatever the core's own window holds; a clear leaves none.
  fold = apply(fold, 'thread/historyReset', { fromItemId: 'n4', hasOlder: false });
  assert.equal(desktopSessionState(fold, []).transcriptHasOlder, true);
  fold = apply(fold, 'thread/historyReset', { hasOlder: false });
  assert.equal(desktopSessionState(fold, []).transcriptHasOlder, undefined);
});

test('a merge keeps the identity of every card whose rows are unchanged', () => {
  const frames = JSON.parse(readFileSync(new URL('live-turn-items.json', import.meta.url), 'utf8')) as {
    method: string;
    params: Obj;
  }[];
  const stripLive = (frame: { method: string; params: Obj }) => {
    if (!frame.params.item) return frame;
    const item = JSON.parse(JSON.stringify(frame.params.item, (k, v) => (k === 'live' ? undefined : v)));
    return { ...frame, params: { ...frame.params, item } };
  };
  for (const live of [true, false]) {
    const feed = live ? frames : frames.map(stripLive);
    let fold = empty();
    for (const n of feed) fold = apply(fold, n.method, n.params);
    const before = desktopSessionState(fold, []).items as Obj[];
    const after = desktopSessionState(apply(fold, 'item/completed', reply('later')), []).items as Obj[];
    assert.ok(
      before.some((row) => row.kind === 'tool'),
      'the turn has tool cards'
    );
    assert.equal(after.length, before.length + 1);
    for (const [i, row] of before.entries()) {
      assert.equal(
        after[i],
        row,
        `${live ? 'live' : 'restored'} row ${i} (${String(row.name ?? row.kind)}) is the same object`
      );
    }
    // A fold that changed nothing of a run, merged again from scratch, gives the same cards.
    const again = desktopSessionState({ ...fold, items: [...fold.items] }, []).items as Obj[];
    for (const [i, row] of before.entries()) assert.equal(again[i], row);
  }
});
