// Deterministic "bursty" mock of a streamed assistant reply, for smoothness
// checks. Provider text does not arrive evenly: steady token trickles, lumps
// of a few hundred characters that land together after a short gap, and
// multi-second pauses that end in a lump. The reply is fixed markdown (prose,
// lists, a table, code fences) cut into chunks by a seeded generator, so one
// seed always yields the same chunk sizes and gaps.

export const BURSTY_MARKDOWN = [
  '## Rollout notes',
  '',
  'The migration landed in **three phases**, and each one kept the app *usable* while the data moved underneath it. Here is what changed, in the order a reader would hit it:',
  '',
  '- Schema: the `sessions` table gained a `revision` column, backfilled in batches',
  '- Writers: every [writer](https://example.com/writers) now stamps the revision before it commits',
  '- Readers: stale replays are rejected instead of repainting older rows',
  '  - Duplicate frames are dropped silently',
  '  - Out-of-order frames wait for their predecessor',
  '',
  '1. Run the backfill during a quiet window.',
  '2. Verify the row counts match.',
  '3. Flip the feature flag.',
  '',
  '| Phase | Rows moved | Duration | Status |',
  '| ----- | ---------- | -------- | ------ |',
  '| Schema | 0 | 2 s | done |',
  '| Backfill | 1,204,331 | 14 min | done |',
  '| Cutover | 1,204,331 | 38 s | pending |',
  '',
  'The batch loop is small enough to read at a glance:',
  '',
  '```ts',
  'export async function backfill(db: Db, batch = 500): Promise<number> {',
  '  let moved = 0;',
  '  for (;;) {',
  "    const rows = await db.take('sessions', { revision: null }, batch);",
  '    if (rows.length === 0) return moved;',
  '    await db.stamp(rows, nextRevision());',
  '    moved += rows.length;',
  '  }',
  '}',
  '```',
  '',
  'If the count drifts, rerun the loop; it is idempotent. Afterwards, verify with:',
  '',
  '```sh',
  'npm run db:verify -- --table sessions',
  '```',
  '',
  'That is everything needed to roll forward. Rolling back is the same steps in reverse, and the `revision` column can stay in place because nothing reads it once the flag is off.',
  '',
  '> Keep the backfill window short: the longer it runs, the more writes it has to reconcile afterwards.',
  '',
  '- Monitor replication lag while the loop runs',
  '- Pause the loop if lag exceeds the budget',
  '- Resume from the last stamped row; no state is kept elsewhere',
  '',
  'Questions go to the platform channel, with the batch size and the last stamped row attached.',
].join('\n');

/** Small, fast, seedable 32-bit generator. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// The arrival shape, repeated until the text is spent. A lump is preceded by
// its gap; a pause is a long gap before a lump.
const PHASES = ['trickle', 'lump', 'trickle', 'pause', 'trickle', 'lump', 'pause', 'trickle', 'lump'];

/**
 * @param {object} [options]
 * @param {number} [options.seed]
 * @param {string} [options.text]
 * @returns {{ text: string, chunks: { atMs: number, text: string }[], pauses: number, lumps: number }}
 */
export function createBurstyStream({ seed = 7, text = BURSTY_MARKDOWN } = {}) {
  const random = createRandom(seed);
  const between = (low, high) => low + Math.floor(random() * (high - low + 1));
  const chunks = [];
  let position = 0;
  let atMs = 0;
  let pauses = 0;
  let lumps = 0;
  // Cut at a code point boundary: a chunk never splits a surrogate pair.
  const take = (size) => {
    let end = Math.min(text.length, position + size);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end += 1;
    const piece = text.slice(position, end);
    position = end;
    return piece;
  };
  for (let phase = 0; position < text.length; phase += 1) {
    const kind = PHASES[phase % PHASES.length];
    if (kind === 'trickle') {
      for (let token = between(6, 14); token > 0 && position < text.length; token -= 1) {
        atMs += between(25, 60);
        chunks.push({ atMs, text: take(between(2, 9)) });
      }
      continue;
    }
    atMs += kind === 'pause' ? between(1400, 2200) : between(150, 450);
    if (kind === 'pause') pauses += 1;
    else lumps += 1;
    // The lump itself reaches the renderer as one to three frames a few
    // milliseconds apart.
    let size = between(120, 500);
    for (let part = between(1, 3); part > 0 && position < text.length; part -= 1) {
      const piece = take(Math.ceil(size / part));
      size -= piece.length;
      chunks.push({ atMs, text: piece });
      atMs += between(1, 6);
    }
  }
  return { text, chunks, pauses, lumps };
}
