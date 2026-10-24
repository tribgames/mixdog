// The phone's copy of a long edit carries a digest of its diff instead of the
// text. Everything the transcript row and the turn review read from the diff
// must come out the same from the digest as from the desktop's own text.
import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteToolOutput, remoteTranscriptSnapshot } from '../main/remote-transcript.ts';
import {
  desktopToolActivityItemPresentation,
  diffTargetPath,
  flattenedToolActivityItems,
} from './transcript-tool-model.ts';
import { toolActivityItemTone } from './transcript-tool-core.ts';
import { summarizeSessionTranscriptReview } from './turn-review-model.ts';
import { summarizeTurnTranscript } from './use-turn-review-summaries.ts';

function modifyDiff(path, hunks, { dashLine = false } = {}) {
  const lines = [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`];
  for (let hunk = 0; hunk < hunks; hunk += 1) {
    lines.push(`@@ -${hunk * 40 + 1},12 +${hunk * 40 + 1},14 @@ function f${hunk}()`);
    for (let line = 0; line < 4; line += 1) lines.push(` context ${hunk}.${line}`);
    for (let line = 0; line < 4; line += 1) lines.push(`-removed ${hunk}.${line} ${'x'.repeat(30)}`);
    if (dashLine) lines.push('--- a markdown rule that was removed', '+++ a line that starts with plus signs');
    for (let line = 0; line < 6; line += 1) lines.push(`+added ${hunk}.${line} ${'y'.repeat(30)}`);
    for (let line = 0; line < 4; line += 1) lines.push(` context ${hunk}.${line + 4}`);
  }
  return `${lines.join('\n')}\n`;
}

function addedDiff(path, count) {
  const body = Array.from({ length: count }, (_, index) => `+line ${index} ${'z'.repeat(40)}`);
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${count} @@\n${body.join('\n')}\n`;
}

function deletedDiff(path, count) {
  const body = Array.from({ length: count }, (_, index) => `-line ${index} ${'q'.repeat(40)}`);
  return `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex 3333333..0000000\n--- a/${path}\n+++ /dev/null\n@@ -1,${count} +0,0 @@\n${body.join('\n')}\n`;
}

function edit(id, path, uiDiff, extra = {}) {
  return {
    id,
    kind: 'tool',
    name: 'edit',
    args: { file_path: path, old_string: 'a', new_string: 'b' },
    result: `Edited ${path}`,
    rawResult: `Edited ${path}`,
    uiDiff,
    count: 1,
    completedCount: 1,
    startedAt: 1,
    completedAt: 2,
    ...extra,
  };
}

const LONG_EDIT = modifyDiff('src/app.ts', 30);
const items = [
  { id: 'u1', kind: 'user', text: 'change things' },
  edit('e-long', 'src/app.ts', LONG_EDIT),
  edit('e-dash', 'docs/readme.md', modifyDiff('docs/readme.md', 25, { dashLine: true })),
  edit('e-added', 'src/new-file.ts', addedDiff('src/new-file.ts', 300)),
  edit('e-deleted', 'src/old-file.ts', deletedDiff('src/old-file.ts', 300)),
  edit('e-small', 'src/small.ts', modifyDiff('src/small.ts', 1)),
  edit('e-again', 'src/app.ts', modifyDiff('src/app.ts', 28)),
  // A batch's patch carried by a call that names one of its files, and by one that names none of them.
  edit(
    'e-multi',
    'src/a.ts',
    `${modifyDiff('src/a.ts', 20)}${addedDiff('src/b.ts', 40)}${deletedDiff('src/c.ts', 40)}`
  ),
  edit('e-batch-other', 'src/elsewhere.ts', `${modifyDiff('src/a.ts', 20)}${addedDiff('src/b.ts', 40)}`),
  // Not git-form: sent whole.
  edit(
    'e-plain',
    'src/plain.ts',
    `--- a/src/plain.ts\n+++ b/src/plain.ts\n@@ -1,1 +1,${60} @@\n${Array.from({ length: 60 }, (_, index) => `+plain ${index} ${'p'.repeat(150)}`).join('\n')}\n`
  ),
  edit('e-failed', 'src/app.ts', modifyDiff('src/app.ts', 30), { isError: true, errorCount: 1, callErrorCount: 1 }),
  {
    id: 'agg',
    kind: 'tool',
    name: '__aggregate__',
    aggregate: true,
    args: {},
    callIds: ['c1', 'c2'],
    categories: { 'Patch|Editing|Edited|file|files': 2 },
    count: 2,
    completedCount: 2,
    result: '',
    uiDiff: modifyDiff('src/tail.ts', 26),
    toolMembers: [
      edit('m1', 'src/head.ts', modifyDiff('src/head.ts', 27)),
      edit('m2', 'src/tail.ts', modifyDiff('src/tail.ts', 26)),
    ],
  },
];

const phoneItems = remoteTranscriptSnapshot({ items }).items;
const rows = (list) => flattenedToolActivityItems(list.filter((item) => item.kind === 'tool'));

/** The parts of a row presentation the diff decides. */
function shown(presentation) {
  const { diffCounts, verb, hasDetails, tone, outputText, outputNote, resultLabel, headerSubject, previewText } =
    presentation;
  return { diffCounts, verb, hasDetails, tone, outputText, outputNote, resultLabel, headerSubject, previewText };
}

/** What a review summary says, and nothing about how the phone holds it. */
function plain(summary) {
  const semantic = ({ additions, deletions, lineStats, status, binary }) => ({
    additions,
    deletions,
    lineStats,
    status,
    binary,
  });
  return {
    additions: summary.additions,
    deletions: summary.deletions,
    hasLineStats: summary.hasLineStats,
    files: [...summary.files].map(([name, entry]) => [name, semantic(entry)]),
  };
}

test('the phone copy really replaced the long single-file diffs and kept the rest whole', () => {
  const byId = new Map(phoneItems.map((item) => [item.id, item]));
  for (const id of ['e-long', 'e-dash', 'e-added', 'e-deleted', 'e-again', 'e-failed', 'e-multi', 'e-batch-other']) {
    assert.equal(Object.hasOwn(byId.get(id), 'uiDiff'), false, id);
    assert.ok(byId.get(id).uiDiffSummary, id);
  }
  assert.equal(byId.get('e-small').uiDiff, items.find((item) => item.id === 'e-small').uiDiff, 'a short diff is whole');
  assert.equal(Object.hasOwn(byId.get('e-plain'), 'uiDiffSummary'), false, 'a plain patch is whole');
  assert.equal(byId.get('e-multi').uiDiffSummary.sections.length, 3);
  const aggregate = byId.get('agg');
  assert.ok(aggregate.uiDiffSummary && aggregate.toolMembers.every((member) => member.uiDiffSummary));
  assert.equal(byId.get('e-small').uiDiffSummary, undefined);
});

test('each row shows the same counts, verb, path and tone from the digest as from the diff', () => {
  const desktop = rows(items);
  const phone = rows(phoneItems);
  assert.equal(phone.length, desktop.length);
  for (const [index, row] of desktop.entries()) {
    const own = desktopToolActivityItemPresentation(row);
    const remote = desktopToolActivityItemPresentation(phone[index]);
    assert.deepEqual(shown(remote), shown(own), String(row.id));
    if (!remote.diffPatch && phone[index].uiDiffSummary) {
      assert.equal(remote.diffDigestPath, diffTargetPath(own.diffPatch), `${row.id} path`);
    }
    assert.equal(toolActivityItemTone(phone[index]), toolActivityItemTone(row), `${row.id} tone`);
  }
  const added = desktopToolActivityItemPresentation(phone.find((row) => row.id === 'e-added'));
  assert.deepEqual(added.diffCounts, { additions: 300, deletions: 0 });
  assert.equal(added.verb, 'Created file');
});

test('the turn review reads the same files and line totals from the digests', () => {
  const own = summarizeSessionTranscriptReview(items, '/repo');
  const remote = summarizeSessionTranscriptReview(phoneItems, '/repo');
  assert.ok(own.files.size >= 6);
  assert.deepEqual(plain(remote), plain(own));
  // Line counts and statuses are the review's content; only the parsed diff
  // bodies are not held on the phone.
  assert.ok([...own.files.values()].every((entry) => entry.parts.length > 0));
});

test('the turn summary of the newest diff matches, for a digest or a held diff', () => {
  const args = {
    authoritativeLeadFiles: [],
    authoritativeLeadPatch: null,
    authoritativeSnapshotKind: '',
    authoritativeWorktreeSnapshot: false,
    revertedBoundary: '',
    turnBoundaryKey: 'turn',
  };
  for (const end of [3, 5, 7, items.length]) {
    const desktop = items.slice(0, end);
    const phone = phoneItems.slice(0, end);
    assert.deepEqual(
      plain(summarizeTurnTranscript({ items: phone, startIndex: 0, ...args })),
      plain(summarizeTurnTranscript({ items: desktop, startIndex: 0, ...args })),
      `through row ${end}`
    );
  }
});

test('opening a digest row loads the diff and the row then reads exactly like the desktop row', () => {
  const snapshot = { items };
  for (const row of rows(phoneItems).filter((entry) => entry.uiDiffSummary)) {
    const full = remoteToolOutput(snapshot, String(row.id));
    assert.ok(typeof full.uiDiff === 'string' && full.uiDiff.length > 8_192, String(row.id));
    const { uiDiffSummary: _digest, remoteOutputTruncated: _cut, ...rest } = row;
    const merged = { ...rest, ...('uiDiff' in full ? { uiDiff: full.uiDiff } : {}) };
    const desktopRow = rows(items).find((entry) => entry.id === row.id);
    assert.deepEqual(desktopToolActivityItemPresentation(merged), desktopToolActivityItemPresentation(desktopRow));
  }
});

test("only the phone copy records which rows still hold each file's diff, in diff order", () => {
  const desktop = summarizeSessionTranscriptReview(items, '/repo');
  const phone = summarizeSessionTranscriptReview(phoneItems, '/repo');
  for (const entry of desktop.files.values()) assert.equal(entry.slots, undefined, 'the desktop holds every diff');
  const rowsOf = (entry) => entry.slots.filter((slot) => typeof slot === 'object').map((slot) => slot.id);
  // The batch patch rides on several calls; each is one contribution, in order.
  assert.deepEqual(rowsOf(phone.files.get('src/app.ts')), ['e-long', 'e-again']);
  assert.ok(rowsOf(phone.files.get('src/b.ts')).includes('e-multi'));
  for (const entry of phone.files.values()) {
    if (!entry.slots) {
      assert.ok(entry.parts.length > 0, 'a file whose diffs are all held records no slots');
      continue;
    }
    assert.equal(entry.parts.length, entry.slots.filter((slot) => typeof slot === 'number').length);
    assert.ok(entry.slots.every((slot) => typeof slot === 'number' || (slot.id && slot.revision)));
  }
});
