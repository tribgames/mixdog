// The multi-turn scenarios of the read-cache recording (record-read-cache.mjs) and its replay on the Rust core
// (replay-read-cache.mjs): one definition, so both sides are given the same model replies, the same files and the same
// steps between the turns.
//
// A scenario is a list of phases run in order against ONE session:
//   { turn: [reply, ...] }  a user turn; `reply` is what the model says to each request of the turn in order (`calls` its tool
//                           calls, `args` an object; a reply without calls ends the turn)
//   { write: { file, text } }  the file is rewritten on disk between turns, by something other than the session
//   { compact: true }       a manual compaction of the session
//   { close: true }         the session is closed (no tombstone) and the next turn resumes it
export const MODEL = 'fake-model';
export const FILES = {
  'a.txt': 'alpha\nbeta\ngamma\n',
  'b.txt': 'one\ntwo\nthree\n',
};
/** `count` files `f000.txt` ... for the entry-cap scenario. */
export const cappedFiles = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${String(i).padStart(3, '0')}.txt`, `file ${i}\n`]));

const read = (id, path) => ({ id, name: 'read', args: { path } });
const say = (text = 'done') => ({ text, calls: [] });
const call = (...calls) => ({ text: '', calls });
const turn = (...replies) => ({ turn: replies });
const patch = (id, from, to) => ({ id, name: 'apply_patch', args: { patch: `--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-${from}\n+${to}\n beta\n gamma\n` } });

export function scenarios() {
  const first = turn(call(read('r1', 'a.txt')), say());
  const again = turn(call(read('r2', 'a.txt')), say());
  const capped = cappedFiles(101);
  // Enough conversation after the first read for a compaction to have something to replace.
  const filler = [1, 2, 3, 4].map((n) => turn(say(`filler ${n} ${'lorem ipsum dolor sit amet '.repeat(400)}`)));
  return [
    { name: 'the same file read again in the next turn', phases: [first, again] },
    { name: 'the same file read twice in each of two turns', phases: [turn(call(read('r1', 'a.txt')), call(read('r1b', 'a.txt')), say()), turn(call(read('r2', 'a.txt')), call(read('r2b', 'a.txt')), say())] },
    { name: 'the file changed on disk between the turns', phases: [first, { write: { file: 'a.txt', text: 'ALPHA\nbeta\ngamma\n' } }, again] },
    { name: 'the file patched by the session in the next turn', phases: [first, turn(call(patch('p2', 'alpha', 'ALPHA')), call(read('r2', 'a.txt')), say()), turn(call(read('r3', 'a.txt')), say())] },
    { name: 'another file read after the first turn', phases: [first, turn(call(read('r2', 'b.txt')), say()), again] },
    { name: 'a compaction between the turns', phases: [first, ...filler, { compact: true }, again] },
    { name: 'the session closed and resumed between the turns', phases: [first, { close: true }, again] },
    // The read cache holds `[file unchanged: a.txt]` after the patch (the session had just changed the file); the compaction takes that receipt out of the context.
    { name: 'a compaction after the session patched the file', phases: [first, turn(call(patch('p2', 'alpha', 'ALPHA')), call(read('r2', 'a.txt')), say()), ...filler, { compact: true }, turn(call(read('r3', 'a.txt')), say())] },
    { name: 'the hundred and first entry', files: capped, phases: [turn(call(...Object.keys(capped).map((name, i) => read(`c${i}`, name))), say()), turn(call(read('d1', 'f001.txt')), call(read('d0', 'f000.txt')), call(read('d100', 'f100.txt')), say())] },
  ];
}
