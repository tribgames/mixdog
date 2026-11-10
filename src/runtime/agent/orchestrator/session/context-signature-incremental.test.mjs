// The incremental signature chain must produce exactly the digest a
// from-scratch hash of the same transcript produces. Fresh clones share no
// memo, chain or transcript state with the live list, so their signatures are
// the from-scratch reference.
import assert from 'node:assert/strict';
import test from 'node:test';
import { contextMessagesShapeSignature, contextMessagesSignature } from './context-utils.mjs';

let seed = 7919;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const OPAQUE = 'Zm9vYmFyYmF6'.repeat(20);

function message(index) {
  switch (random() % 7) {
    case 0:
      return { role: 'user', content: `question ${index} 한글 😀 [Image omitted from stored history: image/png]` };
    case 1:
      return {
        role: 'assistant',
        content: `answer ${index}`,
        toolCalls: [{ id: `call_${index}`, name: 'read', arguments: { path: `src/${index}.mjs` } }],
      };
    case 2:
      return { role: 'tool', toolCallId: `call_${index}`, content: `body ${index}\n`.repeat(1 + (random() % 30)) };
    case 3:
      return {
        role: 'user',
        content: [
          { type: 'text', text: `look ${index}` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: OPAQUE }, width: 640, height: 480 },
        ],
      };
    case 4:
      return {
        role: 'assistant',
        content: [{ type: 'text', text: `thinking ${index}` }],
        providerReplay: { items: [{ type: 'reasoning', encrypted_content: OPAQUE, summary: [] }] },
      };
    case 5:
      return {
        role: 'assistant',
        content: `plain ${index}`,
        thinkingBlocks: [{ type: 'thinking', thinking: `weighing ${index}`, signature: OPAQUE }],
      };
    default:
      return { role: 'system', content: `# Workflow\nstep ${index}` };
  }
}

function assertMatchesScratch(list, counts) {
  const clone = structuredClone(list);
  for (const count of counts) {
    assert.equal(contextMessagesSignature(list, count), contextMessagesSignature(clone, count), `exact @${count}`);
    assert.equal(
      contextMessagesShapeSignature(list, count),
      contextMessagesShapeSignature(clone, count),
      `shape @${count}`
    );
  }
}

test('incremental transcript signatures equal from-scratch digests across growth, edits and rewinds', () => {
  let list = Array.from({ length: 150 }, (_, index) => message(index));
  assertMatchesScratch(list, [0, 1, 63, 64, 65, 128, 150]);
  for (let turn = 0; turn < 120; turn += 1) {
    // A turn replaces the array with the same objects plus appended messages.
    list = [...list, ...Array.from({ length: 1 + (random() % 3) }, (_, index) => message(1000 + turn * 3 + index))];
    const last = list.at(-1);
    if (turn % 3 === 0) last.content = typeof last.content === 'string' ? `${last.content} streamed` : 'streamed';
    if (turn % 5 === 0 && last.toolCalls) last.toolCalls[0].arguments.path = 'restored/in/place.mjs';
    if (turn % 7 === 0) {
      // A settled field replaced by reference (the producer invariant).
      const settled = list[random() % (list.length - 1)];
      settled.content = Array.isArray(settled.content)
        ? [...settled.content, { type: 'text', text: `late ${turn}` }]
        : `${settled.content} late ${turn}`;
    }
    if (turn % 11 === 0) list[random() % list.length] = message(5000 + turn); // interior replacement
    if (turn % 13 === 0) list = [list[0], message(9000 + turn), ...list.slice(-40)]; // compaction, same head
    assertMatchesScratch(list, [list.length, list.length - 1, random() % list.length]);
  }
  // Non-snapshottable messages break the chain but not the digest.
  list.splice(10, 0, { role: 'user', content: [{ type: 'text', text: 'dated', at: new Date(0) }] }, 'raw string', null);
  assertMatchesScratch(list, [5, 11, 12, 13, 14, list.length]);
  list[10].content[0].at.setTime(1);
  list.push(message(9999));
  assertMatchesScratch(list, [list.length]);
});

test('the chain re-hashes a settled message edited deep in place', () => {
  const list = Array.from({ length: 200 }, (_, index) => message(index));
  assertMatchesScratch(list, [200]);
  const settled = list.find((entry, index) => index > 70 && index < 120 && Array.isArray(entry.content));
  settled.content.push({ type: 'text', text: 'edited in place' });
  // An appended message makes the count's contributions new, so the answer
  // must come from the chain, which has to notice the nested edit.
  const next = [...list, message(999)];
  assertMatchesScratch(next, [201]);
  const call = next.find((entry, index) => index > 130 && entry.toolCalls);
  call.toolCalls[0].arguments.path = 'restored/in/place.mjs';
  const again = [...next, message(1000)];
  assertMatchesScratch(again, [202]);
});

test('signatures of a non-object head and of non-arrays still hash from scratch', () => {
  const list = ['head', { role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }];
  assertMatchesScratch(list, [0, 1, 2, 3]);
  assert.equal(contextMessagesSignature(null), contextMessagesSignature([]));
  assert.equal(contextMessagesShapeSignature(undefined), contextMessagesShapeSignature([]));
});
