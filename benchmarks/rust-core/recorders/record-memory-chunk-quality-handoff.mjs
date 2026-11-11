#!/usr/bin/env node
// The compact-handoff cases of Node's chunk quality tests (src/runtime/memory/lib/memory-chunk-quality.test.mjs lines
// 372, 393, 406: the rest of that file, the Cycle1 chunking, is recorded by the cycles golden already) from the real
// `compactHandoffRows` (compact-handoff.mjs), `renderEntryLines` (recall-format.mjs), `assessChunkQuality` and
// `makeChunkQuality` (memory-chunk-quality.mjs): the roots of the test file plus further shapes (fresh summary, no
// members, single root, a root whose summary was altered), with the projected rows and the rendered text.
//
//   node benchmarks/rust-core/recorders/record-memory-chunk-quality-handoff.mjs --tree <dir>
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
// makeChunkQuality stamps verifiedAt from Date.now(): the virtual clock stands still at this input for the whole run.
const CLOCK_MS = 1_700_000_000_000;
Date.now = () => CLOCK_MS;
const dir = 'src/runtime/memory/lib/';
const { assessChunkQuality, makeChunkQuality } = await importFrom(ctx.tree, `${dir}memory-chunk-quality.mjs`);
const { compactHandoffRows } = await importFrom(ctx.tree, `${dir}compact-handoff.mjs`);
const { renderEntryLines } = await importFrom(ctx.tree, `${dir}recall-format.mjs`);

const row = (id, content = 'The request and its details are repeated. '.repeat(5), session = 's') => ({
  id, ts: id * 1000, source_turn: id, session_id: session, role: id % 2 ? 'user' : 'assistant', content,
});

async function handoff(label, roots, renderOptions) {
  const input = structuredClone(roots);
  const projected = await capture(() => compactHandoffRows(roots));
  const out = { label, roots: input, projected };
  if (projected.result) {
    out.rendered = await capture(() => renderEntryLines(compactHandoffRows(structuredClone(roots)), renderOptions));
    out.renderOptions = renderOptions ?? null;
    out.rootsUnchanged = JSON.stringify(roots) === JSON.stringify(input);
  }
  return out;
}

const first = row(1, '```js\nconst n = 296;\n```\nhttps://example.com | exact');
const second = row(2, 'No success was verified.');
const staleRoots = [{
  ...first, is_root: 1, element: 'stale metadata', summary: 'All succeeded.',
  chunk_quality: makeChunkQuality('No success was verified.', [first, second]),
  members: [{ ...first, element: 'stale', summary: 'wrong' }, second],
}];
const staleCase = await handoff('stale summary falls back to originals', staleRoots, { maxBodyChars: null });

const members = [row(1), row(2)];
const legacyRoot = { id: 1, ts: 1000, is_root: 1, element: 'internal-search-key', summary: 'Pending request.', members };
const legacyCase = await handoff('legacy compressed body carries no metadata', [legacyRoot]);

const overlapRoot = { id: 1, is_root: 1, summary: 'Pending request.', members };
overlapRoot.chunk_quality = makeChunkQuality(overlapRoot.summary, members);
const overlapCase = await handoff('overlapping memberships fall back to unique originals', [overlapRoot, { ...overlapRoot, id: 3 }]);

const further = [
  await handoff('verified summary of a single root is used', [overlapRoot]),
  await handoff('verified summary rendered without a body bound', [overlapRoot], { maxBodyChars: null }),
  await handoff('altered summary on a verified root', [{ ...overlapRoot, summary: 'It succeeded.' }]),
  await handoff('root without members', [{ id: 9, ts: 9000, is_root: 1, summary: 'Alone.', content: 'original alone' }]),
  await handoff('two disjoint legacy roots', [legacyRoot, { id: 5, ts: 5000, is_root: 1, summary: 'Second request.', members: [row(5), row(6)] }]),
  await handoff('no roots', []),
];
const quality = [];
for (const [label, root, expectedMembers] of [
  ['legacy root with members', { id: 1, is_root: 1, summary: 'Pending request.', members }, undefined],
  ['verified root', overlapRoot, undefined],
  ['verified root, member list cut', overlapRoot, members.slice(1)],
  ['verified root, duplicated member', overlapRoot, [...members, members[0]]],
  ['verified root, member content changed', overlapRoot, [row(1, 'changed'), row(2)]],
  ['expanded summary', { ...overlapRoot, summary: 'Expanded. '.repeat(1000) }, undefined],
]) quality.push({ label, expectedMembers: expectedMembers ?? null, ...(await capture(() => assessChunkQuality(structuredClone(root), expectedMembers && structuredClone(expectedMembers)))) });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-chunk-quality-handoff',
  golden: {
    domain: 'memory-chunk-quality-handoff',
    clock: { dateNowMs: CLOCK_MS, reason: 'verifiedAt of every chunk_quality below' },
    source: 'src/runtime/memory/lib/memory-chunk-quality.test.mjs',
    cases: [
      { name: 'known stale-summary fallback includes the original root body, code, URLs and every unique member (test line 372)', handoff: staleCase },
      { name: 'legacy compressed bodies contain no search metadata, IDs or role labels (test line 393)', handoff: legacyCase },
      { name: 'overlapping chunk memberships fall back to unique originals instead of duplicate summaries (test line 406)', handoff: overlapCase },
      { name: 'further shapes (beyond the test file)', handoffs: further, quality },
    ],
  },
  extra: {
    entry: { runs: 'compactHandoffRows (compact-handoff.mjs), renderEntryLines (recall-format.mjs), assessChunkQuality, makeChunkQuality (memory-chunk-quality.mjs)', notRun: 'the other 23 cases of the test file (Cycle1 prompts, parsing, partitioning, budgets): covered by the cycles golden (mem/cycles/golden_tests.rs)' },
    replay: 'mixdog-services memory: mem/recall/compact.rs compact_handoff_rows + mem/recall/format.rs render_entry_lines + mem/cycles/quality.rs assess_chunk_quality/make_chunk_quality; compares the projected rows (all fields), rendered text, and the assessments (usable, reasons, provenance)',
    exclusions: 'chunk_quality of the roots is the value makeChunkQuality produced here (a stored JSON); a replay builds the same roots from the golden',
    normalised: { 'verifiedAt': 'Date.now() is fixed at the recorded clock.dateNowMs (virtual clock, never advanced), so verifiedAt equals it' },
  },
});
process.exit(0);
