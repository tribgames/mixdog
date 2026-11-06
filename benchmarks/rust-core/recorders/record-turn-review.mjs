#!/usr/bin/env node
// Golden twin of Node's turn review: the bounded line diff (jsDiff Myers, the operation budget and
// the replacement-hunk fallback), the review-reply bounds, the per-call card diff, and whole turns
// driven through the real turn-snapshot store (recording, mid-turn and sealed reviews, composer and
// historical Undo/Reapply with the real `git apply`, failures, worker reviews, cleared history).
//
//   node benchmarks/rust-core/recorders/record-turn-review.mjs [--tree C:/Project/mixdog] [--work <dir>]
//
// Runs the real functions of `runtime/shared/{bounded-line-diff,review-diff,turn-review-reply,
// turn-snapshot,turn-snapshot-store}.mjs` and `runtime/agent/orchestrator/tools/patch/ui-diff.mjs`
// and records, per scenario, the ops that drive them and what each answered. The Rust component
// replays the same ops (`mixdog-core::turn_review::tests`). Output keeps each reply's key order:
// the review tag hashes the reply's JSON text.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeSetManifest, writeText } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = realpathSync.native(mkdtempSync(join(resolve(args.get('work') ?? tmpdir()), 'turn-review-')));
// Every scenario is its own workspace and data directory; Git never looks above them.
process.env.GIT_CEILING_DIRECTORIES = work;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const lineDiff = await importFrom(tree, 'src/runtime/shared/bounded-line-diff.mjs');
const reviewDiff = await importFrom(tree, 'src/runtime/shared/review-diff.mjs');
const replyMod = await importFrom(tree, 'src/runtime/shared/turn-review-reply.mjs');
const snapshot = await importFrom(tree, 'src/runtime/shared/turn-snapshot.mjs');
const store = await importFrom(tree, 'src/runtime/shared/turn-snapshot-store.mjs');
const baselines = await importFrom(tree, 'src/runtime/shared/session-baseline-store.mjs');
const uiDiff = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch/ui-diff.mjs');
const redirects = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch/read-redirects.mjs');

// ── content specs ───────────────────────────────────────────────────────────
// null | { text } | { b64 } | { omitted: { size, reason } }
const content = (spec) => {
  if (spec == null) return null;
  if (spec.text !== undefined) return Buffer.from(spec.text, 'utf8');
  if (spec.b64 !== undefined) return Buffer.from(spec.b64, 'base64');
  if (spec.omitted) return { omitted: true, size: spec.omitted.size, reason: spec.omitted.reason ?? null };
  throw new Error(`bad content spec ${JSON.stringify(spec)}`);
};

// ── A. line diff ────────────────────────────────────────────────────────────
const lcg = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};
const numbered = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';
const randomEdit = (seed, lines, edits) => {
  const rnd = lcg(seed);
  const base = Array.from({ length: lines }, (_, i) => `row ${i % 17}`);
  const next = [...base];
  for (let i = 0; i < edits; i += 1) {
    const at = Math.floor(rnd() * next.length);
    const kind = rnd();
    if (kind < 0.4) next.splice(at, 1);
    else if (kind < 0.8) next.splice(at, 0, `new ${i}`);
    else next[at] = `changed ${i}`;
  }
  return [`${base.join('\n')}\n`, `${next.join('\n')}\n`];
};
const [randOldA, randNewA] = randomEdit(7, 400, 40);
const [randOldB, randNewB] = randomEdit(11, 3000, 150);
const diffCases = [
  ['replace one line', 'a\nb\nc\n', 'a\nB\nc\n'],
  ['insert at start', 'b\nc\n', 'a\nb\nc\n'],
  ['delete at end', 'a\nb\nc\n', 'a\nb\n'],
  ['create from empty', '', 'one\ntwo\n'],
  ['delete to empty', 'one\ntwo\n', ''],
  ['no newline at end of both', 'a\nb', 'a\nc'],
  ['newline added at end', 'a\nb', 'a\nb\n'],
  ['newline removed at end', 'a\nb\n', 'a\nb'],
  ['crlf lines', 'a\r\nb\r\nc\r\n', 'a\r\nX\r\nc\r\n'],
  ['lone cr inside a line', 'a\rb\nc\n', 'a\rB\nc\n'],
  ['repeated lines tie-break', 'x\nx\nx\ny\nx\nx\n', 'x\nx\ny\nx\nx\nx\n'],
  ['hunks six lines apart', `${numbered(30)}`, numbered(30).replace('line 5\n', 'five\n').replace('line 12\n', 'twelve\n')],
  ['hunks seven lines apart', `${numbered(30)}`, numbered(30).replace('line 5\n', 'five\n').replace('line 13\n', 'thirteen\n')],
  ['unicode text', 'héllo\n日本語\n', 'héllo\n日本語!\n😀\n'],
  ['seeded random 400 lines', randOldA, randNewA],
  ['seeded random 3000 lines', randOldB, randNewB],
  ['over the line limit falls back', { gen: 'numbered', n: 20_001 }, { gen: 'numbered', n: 20_001, replace: ['line 9000\n', 'changed\n'] }],
  ['at the line limit is diffed', { gen: 'numbered', n: 19_999 }, { gen: 'numbered', n: 19_999, replace: ['line 9000\n', 'changed\n'] }],
  ['over the character limit falls back', { gen: 'wide', rows: 18_000, width: 60 }, { gen: 'wide', rows: 18_000, width: 60, change: 9000 }],
];
// The large inputs are recorded as the recipe that makes them.
const generate = (spec) => {
  if (typeof spec === 'string') return spec;
  if (spec.gen === 'numbered') {
    const text = numbered(spec.n);
    return spec.replace ? text.replace(spec.replace[0], spec.replace[1]) : text;
  }
  const rows = Array.from({ length: spec.rows }, (_, i) => (i === spec.change ? 'changed'.padEnd(spec.width, 'y') : String(i).padEnd(spec.width, 'x')));
  return `${rows.join('\n')}\n`;
};
const headerCases = [
  ['a/plain.txt', 'b/plain.txt'],
  ['/dev/null', 'b/new file.txt'],
  ['a/café.txt', 'b/café.txt'],
  ['a/with "quote".txt', 'b/with "quote".txt'],
  ['a/back\\slash.txt', 'b/back\\slash.txt'],
  ['a/tab\tname.txt', 'b/tab\tname.txt'],
  ['a/日本語/emoji😀.txt', 'b/日本語/emoji😀.txt'],
];
const lineDiffOut = { diffs: [], budgets: [], headers: [] };
for (const [name, oldSpec, newSpec] of diffCases) {
  const oldText = generate(oldSpec);
  const newText = generate(newSpec);
  const result = lineDiff.lineDiffHunks(oldText, newText, lineDiff.createLineDiffBudget(10_000_000));
  lineDiffOut.diffs.push({ name, old: oldSpec, new: newSpec, hunks: result.hunks, exact: result.exact, body: lineDiff.unifiedHunksBody('a/f', 'b/f', result.hunks) });
}
// An exhausted budget: every pair of the operation is the replacement hunk, the same pair again too.
{
  lineDiff._resetLineDiffCacheForTest();
  const budget = lineDiff.createLineDiffBudget(0);
  const pairs = [
    ['a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nX\ne\nf\ng\n'],
    ['one\ntwo\n', 'one\n2\ntwo\n'],
    ['a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nX\ne\nf\ng\n'],
    ['', 'new\n'],
    ['gone\n', ''],
  ];
  lineDiffOut.budgets.push({
    name: 'zero budget',
    totalMs: 0,
    results: pairs.map(([oldText, newText]) => ({ old: oldText, new: newText, ...lineDiff.lineDiffHunks(oldText, newText, budget) })),
  });
  lineDiff._resetLineDiffCacheForTest();
}
for (const [oldHeader, newHeader] of headerCases) {
  const hunks = lineDiff.lineDiffHunks('a\nb\n', 'a\nc\n', lineDiff.createLineDiffBudget(10_000_000)).hunks;
  lineDiffOut.headers.push({ oldHeader, newHeader, body: lineDiff.unifiedHunksBody(oldHeader, newHeader, hunks) });
}
// An empty file created: no hunks, headers only.
lineDiffOut.headers.push({ oldHeader: '/dev/null', newHeader: 'b/empty.txt', noHunks: true, body: lineDiff.unifiedHunksBody('/dev/null', 'b/empty.txt', []) });

// Review reply bounds.
const section = (name, body) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,1 @@\n${body}`;
const boundInputs = [
  ['fits', `${section('a.txt', '-a\n+b\n')}`, 10_000],
  ['two sections, tight', `${section('a.txt', `-${'a'.repeat(300)}\n+b\n`)}${section('b.txt', '-c\n+d\n')}`, 400],
  ['headers only survive', `${section('a.txt', `-${'a'.repeat(300)}\n`)}${section('b.txt', `-${'b'.repeat(300)}\n`)}`, 50],
  ['already truncated', `diff --git a/x b/x\n… [diff truncated for display]\n${section('y', 'z\n')}`, 10_000],
  ['carriage return opens a section', `${section('a.txt', `-${'a'.repeat(200)}\r`)}diff --git a/b b/b\n@@ -1 +1 @@\n-${'q'.repeat(200)}\n`, 300],
  ['non-ascii length is UTF-16', `${section('é.txt', `-${'日'.repeat(150)}\n+x\n`)}`, 120],
];
const budgetAdmit = (() => {
  const budget = reviewDiff.createReviewPatchBudget(2_000_000);
  return [1_000_000, 1_000_001, 900_000, 1_000_000, 100_000].map((bytes) => ({ bytes, admitted: budget.admit(bytes), remaining: budget.remaining }));
})();
const reviewOut = {
  bound: boundInputs.map(([name, patch, max]) => ({ name, input: patch, max, ...reviewDiff.boundReviewPatch(patch, max) })),
  admit: budgetAdmit,
  filePatch: [
    ['plain', 'p', 'text'],
    ['empty', 'p', ''],
    ['over', 'p', 'x'.repeat(40)],
  ].map(([name, path, patch]) => ({ name, path, patch, max: name === 'over' ? 32 : 8 * 1024 * 1024, reply: reviewDiff.filePatchReply(path, patch, name === 'over' ? 32 : 8 * 1024 * 1024) })),
  omitted: reviewDiff.patchOmittedFile({ path: 'big.txt', additions: 3, reason: 'other' }),
  tooLarge: [
    reviewDiff.reviewDiffTooLarge([{ patchOmitted: true, reason: 'too_large' }], ''),
    reviewDiff.reviewDiffTooLarge([{ patchOmitted: true, reason: 'too_large' }], 'x'),
    reviewDiff.reviewDiffTooLarge([{ path: 'a' }], ''),
  ],
};
// The review reply: the tag hashes the reply JSON, a summary drops the patch.
{
  const read = (review) => async () => review;
  const full = { supported: true, files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }], patch: 'diff --git a/a.txt b/a.txt\n', snapshotKind: 'tool', revertMode: 'tracked', checkpointId: 'cp', patchTruncated: false, authoritative: true, agents: [], generation: 2, historyTurns: 0 };
  const first = await replyMod.turnReviewReply(read(full), {});
  const summary = await replyMod.turnReviewReply(read(full), { summary: true });
  const unchanged = await replyMod.turnReviewReply(read(full), { known: first.etag });
  const other = await replyMod.turnReviewReply(read({ ...full, snapshotKind: 'session' }), { summary: true });
  const none = await replyMod.turnReviewReply(async () => null, {});
  reviewOut.reply = { review: full, first, summary, unchanged, otherKind: other, none };
}

// ── B. per-call card diff ───────────────────────────────────────────────────
const callCases = [
  ['modify', [{ displayPath: 'src/a.txt', before: { text: 'a\nb\nc\n' }, after: { text: 'a\nB\nc\n' } }]],
  ['create', [{ displayPath: 'new.txt', before: null, after: { text: 'hi\n' } }]],
  ['delete', [{ displayPath: 'old.txt', before: { text: 'bye\n' }, after: null }]],
  ['create empty file', [{ displayPath: 'empty.txt', before: null, after: { text: '' } }]],
  ['delete empty file', [{ displayPath: 'empty.txt', before: { text: '' }, after: null }]],
  ['unchanged', [{ displayPath: 'same.txt', before: { text: 'x\n' }, after: { text: 'x\n' } }]],
  ['rename same content', [{ displayPath: 'a.txt', newDisplayPath: 'b.txt', before: { text: 'x\n' }, after: { text: 'x\n' } }]],
  ['rename and modify', [{ displayPath: 'a.txt', newDisplayPath: 'dir/b.txt', before: { text: 'x\ny\n' }, after: { text: 'x\nz\n' } }]],
  ['nul byte is binary', [{ displayPath: 'bin.dat', before: { b64: Buffer.from([1, 0, 2]).toString('base64') }, after: { b64: Buffer.from([1, 0, 3]).toString('base64') } }]],
  ['invalid utf8 is binary', [{ displayPath: 'bad.txt', before: { text: 'ok\n' }, after: { b64: Buffer.from([0xff, 0xfe, 0x41]).toString('base64') } }]],
  ['omitted before', [{ displayPath: 'big.bin', before: { omitted: { size: 70000000, reason: 'oversized' } }, after: { text: 'small\n' } }]],
  ['omitted after', [{ displayPath: 'big.bin', before: { text: 'small\n' }, after: { omitted: { size: 5, reason: null } } }]],
  ['no display path', [{ displayPath: '', before: null, after: { text: 'x\n' } }]],
  ['backslash and padded names', [{ displayPath: '  dir\\sub\\f.txt ', before: { text: 'a\n' }, after: { text: 'b\n' } }]],
  ['crlf and no newline at end', [{ displayPath: 'w.txt', before: { text: 'a\r\nb' }, after: { text: 'a\r\nc' } }]],
  ['two files in one call', [
    { displayPath: 'one.txt', before: { text: '1\n' }, after: { text: '2\n' } },
    { displayPath: 'two.txt', before: null, after: { text: 'new\n' } },
  ]],
  ['non-ascii name', [{ displayPath: 'café/日本.txt', before: { text: 'a\n' }, after: { text: 'b\n' } }]],
];
const tracked = (spec) => ({
  path: `/virtual/${spec.displayPath}`,
  displayPath: spec.displayPath,
  ...(spec.newDisplayPath ? { newPath: `/virtual/${spec.newDisplayPath}`, newDisplayPath: spec.newDisplayPath } : {}),
  before: content(spec.before),
  after: content(spec.after),
});
const callOut = { measure: [], registry: null };
for (const [name, specs] of callCases) {
  const measured = uiDiff.measureCallChanges(specs.map(tracked), lineDiff.createLineDiffBudget(10_000_000));
  callOut.measure.push({
    name,
    changes: specs,
    diff: measured.diff,
    counts: measured.changes.map(({ additions, deletions }) => ({ additions, deletions })),
  });
}

// ── C. scenarios ────────────────────────────────────────────────────────────
function normalizer(ws, data) {
  const forms = (dir) => {
    const back = dir;
    const fwd = dir.replace(/\\/g, '/');
    return [...new Set([back.replace(/\\/g, '\\\\'), fwd, back])];
  };
  return (value) => {
    let text = JSON.stringify(value);
    if (text === undefined) return null;
    for (const [dir, token] of [[data, '<data>'], [ws, '<ws>'], [dirname(ws), '<sc>']]) {
      for (const form of forms(dir)) text = text.split(form).join(token);
      for (const form of forms(dir.toLowerCase())) text = text.split(form).join(token);
    }
    text = text.replace(/"(createdAt|updatedAt|clearedAt)":\d+(\.\d+)?/g, '"$1":0').replace(/"baselineTree":"[0-9a-f]+"/g, '"baselineTree":"<tree>"');
    return JSON.parse(text);
  };
}

const TOKENS = new Map();
async function runScenario(scenario) {
  const dir = mkdtempSync(join(work, 'sc-'));
  const ws = join(dir, 'ws');
  const data = join(dir, 'data');
  mkdirSync(ws, { recursive: true });
  mkdirSync(data, { recursive: true });
  process.env.MIXDOG_DATA_DIR = data;
  store._setTurnSnapshotStoreRootForTest(join(data, 'turn-snapshots'));
  snapshot._resetTurnSnapshotForTest();
  TOKENS.clear();
  const norm = normalizer(ws, data);
  const full = (path) => join(ws, path);
  const handles = new Map();
  const lastReview = new Map();
  const revisions = new Map();
  const results = [];
  // The persisted bytes of a session's file in one store directory ('' = the turn index), clocks
  // zeroed and the scenario's directories tokenized; null when there is none.
  const persistedText = (sessionId, sub) => {
    const name = `${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}.json`;
    const file = join(data, 'turn-snapshots', sub, name);
    if (!existsSync(file)) return null;
    let text = readFileSync(file, 'utf8')
      .replace(/"(at|touched|createdAt|updatedAt|clearedAt|incompleteAt|foldedAt)":[0-9.e+-]+/g, '"$1":0')
      .replace(/\[[0-9.e+-]+,/g, '[0,')
      .replace(/"baselineTree":"[0-9a-f]+"/g, '"baselineTree":"<tree>"');
    for (const [dir, token] of [[data, '<data>'], [ws, '<ws>'], [dirname(ws), '<sc>']]) {
      for (const form of [dir, dir.toLowerCase()]) text = text.split(JSON.stringify(form).slice(1, -1)).join(token);
    }
    return text;
  };
  const readDisk = (path) => (existsSync(full(path)) ? readFileSync(full(path)) : null);
  const record = (index, value) => results.push({ op: index, result: norm(value) });
  const attempt = async (index, task) => {
    try {
      record(index, { ok: await task() });
    } catch (error) {
      record(index, { error: { name: error?.constructor?.name ?? 'Error', message: error?.message ?? String(error) } });
    }
  };
  for (const [index, op] of scenario.ops.entries()) {
    const session = op.session ?? 's1';
    switch (op.op) {
      case 'git':
        execFileSync('git', ['init', '-q'], { cwd: ws });
        break;
      case 'file':
        mkdirSync(dirname(full(op.path)), { recursive: true });
        writeFileSync(full(op.path), content(op.content));
        break;
      case 'remove':
        rmSync(full(op.path), { force: true });
        break;
      case 'begin': {
        const token = await snapshot.beginTurnSnapshot(ws, session, { checkpointId: op.checkpoint ?? '', continueTurn: op.continue === true });
        TOKENS.set(session, token);
        record(index, { token });
        break;
      }
      case 'complete': {
        const token = op.stale ? { generation: 99, checkpointId: '' } : (TOKENS.get(session) ?? null);
        record(index, { completed: await snapshot.completeTurnSnapshot(session, token) });
        break;
      }
      case 'edit': {
        // A tool call: the file on disk changes, then the call's before/after join the review.
        const path = full(op.path);
        const before = op.before !== undefined ? content(op.before) : readDisk(op.path);
        let after;
        if (op.to !== undefined) {
          mkdirSync(dirname(full(op.to)), { recursive: true });
          renameSync(path, full(op.to));
          after = op.after !== undefined ? content(op.after) : before;
          if (op.content !== undefined) writeFileSync(full(op.to), content(op.content));
          if (op.content !== undefined) after = content(op.content);
        } else if (op.content === null) {
          rmSync(path, { force: true });
          after = null;
        } else {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content(op.content));
          after = op.after !== undefined ? content(op.after) : content(op.content);
        }
        if (op.card && op.to === undefined) {
          uiDiff.registerEditToolUiDiff({ callId: op.card, sessionId: session, basePath: ws, fullPath: path, before, after });
        } else if (op.tool) {
          uiDiff.recordToolFileChanges({ sessionId: session, basePath: ws, changes: [{ fullPath: path, before, after }] });
        } else {
          const change = {
            path,
            displayPath: redirects.patchHeaderPathForResolved(ws, path),
            ...(op.to !== undefined ? { newPath: full(op.to), newDisplayPath: redirects.patchHeaderPathForResolved(ws, full(op.to)) } : {}),
            before,
            after,
          };
          const budget = lineDiff.createLineDiffBudget();
          const measured = uiDiff.measureCallChanges([change], budget);
          snapshot.recordTurnDiffChanges(session, measured.changes, budget);
        }
        break;
      }
      case 'card':
        record(index, { diff: uiDiff.takeApplyPatchUiDiff(op.call) });
        break;
      case 'review': {
        const known = op.known === '@last' ? lastReview.get(session)?.etag : op.known;
        const reply = await replyMod.turnReviewReply(
          (options) => snapshot.getTurnReviewDiff(ws, session, options),
          { ...(op.summary ? { summary: true } : {}), ...(known ? { known } : {}) }
        );
        lastReview.set(session, reply);
        record(index, reply);
        break;
      }
      case 'filePatch':
        record(index, await snapshot.getTurnReviewFilePatch(ws, session, op.file));
        break;
      case 'revert':
        await attempt(index, () =>
          op.file ? snapshot.revertTurnReviewFile(ws, session, op.file, op.checkpoint ?? '') : snapshot.revertTurnReview(ws, session, op.checkpoint ?? '')
        );
        break;
      case 'changes': {
        await attempt(index, async () => {
          const reply = await snapshot.getTurnChanges(session, { checkpointId: op.checkpoint, ...(op.patch ? { patch: true } : {}), ...(op.file ? { file: op.file } : {}) });
          revisions.set(op.checkpoint, reply.revision);
          return reply;
        });
        break;
      }
      case 'undo':
      case 'redo': {
        const revision = op.revision === '@current' ? revisions.get(op.checkpoint) : op.revision;
        const run = op.op === 'undo' ? snapshot.revertTurnChanges : snapshot.reapplyTurnChanges;
        await attempt(index, async () => {
          const reply = await run(session, op.checkpoint, op.file ?? null, revision);
          revisions.set(op.checkpoint, reply.revision);
          return reply;
        });
        break;
      }
      case 'clearHistory':
        await attempt(index, () => snapshot.clearSessionChangeHistory(session));
        break;
      case 'restart':
        // The process is gone; the files stay. Its queued baseline writes land first.
        await baselines._settleSessionBaselinesForTest();
        snapshot._resetTurnSnapshotForTest();
        TOKENS.clear();
        break;
      case 'agentBegin': {
        const handle = snapshot.beginAgentTurnReview(op.owner, op.child, { agent: op.agent, tag: op.tag });
        handles.set(op.handle, handle);
        record(index, { handle: handle ? { ...handle, id: '<id>' } : null });
        break;
      }
      case 'agentComplete':
        record(index, { joined: snapshot.completeAgentTurnReview(handles.get(op.handle), op.patches ?? []) });
        break;
      case 'forget':
        snapshot.forgetTurnSnapshotSession(session);
        break;
      case 'disk': {
        const bytes = readDisk(op.path);
        record(index, { text: bytes === null ? null : bytes.toString('base64') });
        break;
      }
      case 'records': {
        const records = await store.loadTurnChangeRecords(session);
        record(index, { records, file: persistedText(session, 'changes') });
        break;
      }
      case 'snapshotRecord': {
        const found = await store.loadTurnSnapshotRecord(session);
        record(index, found ? { generation: found.generation, checkpointId: found.checkpointId, root: found.root, toolFiles: found.toolFiles, sealed: found.sealed, file: persistedText(session, '') } : { file: persistedText(session, '') });
        break;
      }
      case 'baselineIndex':
        record(index, { text: persistedText(session, 'baselines') });
        break;
      case 'sessionReview':
        record(index, await snapshot.getSessionReviewDiff(ws, session));
        break;
      case 'sessionFile':
        record(index, await snapshot.getSessionReviewFilePatch(ws, session, op.file, op.oldPath ?? ''));
        break;
      case 'cleared':
        record(index, { cleared: await store.sessionChangeHistoryCleared(session), file: persistedText(session, 'cleared') });
        break;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  }
  return { name: scenario.name, platform: process.platform, ops: scenario.ops, results };
}

const T = (text) => ({ text });
const lines = (...rows) => `${rows.join('\n')}\n`;
const scenarios = [
  {
    name: 'tracked turn: edit, create, delete, rename, mid-turn and sealed reviews',
    ops: [
      { op: 'file', path: 'a.txt', content: T(lines('one', 'two', 'three')) },
      { op: 'file', path: 'c.txt', content: T('gone\n') },
      { op: 'file', path: 'd.txt', content: T('moves\n') },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', card: 'call-1', path: 'a.txt', content: T(lines('one', '2', 'three', 'four')) },
      { op: 'edit', path: 'b.txt', content: T('fresh\n') },
      { op: 'edit', path: 'c.txt', content: null },
      { op: 'edit', path: 'd.txt', to: 'e.txt' },
      { op: 'card', call: 'call-1' },
      { op: 'card', call: 'call-1' },
      { op: 'review' },
      { op: 'review', known: '@last' },
      { op: 'review', summary: true },
      { op: 'filePatch', file: 'a.txt' },
      { op: 'filePatch', file: 'zzz.txt' },
      { op: 'complete' },
      { op: 'review' },
      { op: 'changes', checkpoint: 'cp1' },
      { op: 'changes', checkpoint: 'cp1', patch: true },
      { op: 'changes', checkpoint: 'cp1', patch: true, file: 'a.txt' },
      { op: 'changes', checkpoint: 'cp1', patch: true, file: 'nope.txt' },
      { op: 'changes', checkpoint: 'unknown' },
      { op: 'records' },
      { op: 'restart' },
      { op: 'review' },
      { op: 'review', summary: true },
      { op: 'filePatch', file: 'a.txt' },
      { op: 'changes', checkpoint: 'cp1' },
    ],
  },
  {
    name: 'running turn: composer undo of one file and of the whole review',
    ops: [
      { op: 'file', path: 'a.txt', content: T(lines('x', 'y')) },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'a.txt', content: T(lines('x', 'Y')) },
      { op: 'edit', path: 'n.txt', content: T('new\n') },
      { op: 'revert', file: 'a.txt' },
      { op: 'disk', path: 'a.txt' },
      { op: 'revert', file: 'missing.txt' },
      { op: 'review' },
      { op: 'revert', checkpoint: 'other' },
      { op: 'revert' },
      { op: 'disk', path: 'n.txt' },
      { op: 'review' },
      { op: 'complete' },
      { op: 'changes', checkpoint: 'cp1' },
    ],
  },
  {
    name: 'sealed turn: composer undo, then historical undo and reapply, stale and busy failures',
    ops: [
      { op: 'file', path: 'a.txt', content: T(lines('1', '2', '3')) },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'a.txt', content: T(lines('1', 'two', '3')) },
      { op: 'edit', path: 'b.txt', content: T('b\n') },
      { op: 'complete' },
      { op: 'restart' },
      { op: 'revert', file: 'a.txt' },
      { op: 'disk', path: 'a.txt' },
      { op: 'review' },
      { op: 'changes', checkpoint: 'cp1' },
      { op: 'undo', checkpoint: 'cp1', revision: 99 },
      { op: 'undo', checkpoint: 'cp1', revision: '@current', file: 'a.txt' },
      { op: 'redo', checkpoint: 'cp1', revision: '@current', file: 'a.txt' },
      { op: 'disk', path: 'a.txt' },
      { op: 'undo', checkpoint: 'cp1', revision: '@current' },
      { op: 'disk', path: 'b.txt' },
      { op: 'undo', checkpoint: 'cp1', revision: '@current' },
      { op: 'redo', checkpoint: 'cp1', revision: '@current' },
      { op: 'disk', path: 'b.txt' },
      { op: 'undo', checkpoint: 'nope', revision: 1 },
      { op: 'undo', checkpoint: 'cp1', revision: 1.5 },
      { op: 'undo', checkpoint: '', revision: 1 },
      { op: 'records' },
    ],
  },
  {
    name: 'foreign edits: outside the turn hunks survives, overlapping fails',
    ops: [
      { op: 'file', path: 'a.txt', content: T(lines('top', 'mid', 'bottom')) },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'a.txt', content: T(lines('top', 'MID', 'bottom')) },
      { op: 'complete' },
      { op: 'file', path: 'a.txt', content: T(lines('TOP', 'MID', 'bottom')) },
      { op: 'changes', checkpoint: 'cp1' },
      { op: 'undo', checkpoint: 'cp1', revision: '@current' },
      { op: 'disk', path: 'a.txt' },
      { op: 'redo', checkpoint: 'cp1', revision: '@current' },
      { op: 'file', path: 'a.txt', content: T(lines('TOP', 'changed elsewhere', 'bottom')) },
      { op: 'undo', checkpoint: 'cp1', revision: '@current' },
      { op: 'disk', path: 'a.txt' },
      { op: 'changes', checkpoint: 'cp1' },
    ],
  },
  {
    name: 'binary and uncaptured files',
    ops: [
      { op: 'file', path: 'img.bin', content: { b64: Buffer.from([0, 1, 2, 3, 255]).toString('base64') } },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'img.bin', content: { b64: Buffer.from([0, 1, 9, 3, 255, 7]).toString('base64') } },
      { op: 'edit', path: 'big.dat', before: { omitted: { size: 70000000, reason: 'oversized' } }, content: T('now small\n') },
      { op: 'review' },
      { op: 'revert', file: 'big.dat' },
      { op: 'revert', file: 'img.bin' },
      { op: 'disk', path: 'img.bin' },
      { op: 'revert' },
      { op: 'complete' },
      { op: 'changes', checkpoint: 'cp1', patch: true },
      { op: 'records' },
    ],
  },
  {
    name: 'git turn: a file outside the root is view-only',
    ops: [
      { op: 'git' },
      { op: 'file', path: 'a.txt', content: T('inside\n') },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'a.txt', content: T('inside!\n') },
      { op: 'edit', path: '../outside.txt', content: T('out\n') },
      { op: 'review' },
      { op: 'complete' },
      { op: 'review' },
      { op: 'changes', checkpoint: 'cp1' },
      { op: 'changes', checkpoint: 'cp1', patch: true },
      { op: 'snapshotRecord' },
      { op: 'records' },
    ],
  },
  {
    name: 'tool writes without a card (office, tidy) and a second turn replacing the first',
    ops: [
      { op: 'file', path: 'doc.txt', content: T('v1\n') },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'doc.txt', tool: true, content: T('v2\n') },
      { op: 'review' },
      { op: 'begin', checkpoint: 'cp2' },
      { op: 'edit', path: 'doc.txt', tool: true, content: T('v3\n') },
      { op: 'review' },
      { op: 'complete' },
      { op: 'changes', checkpoint: 'cp1' },
      { op: 'changes', checkpoint: 'cp2' },
      { op: 'records' },
    ],
  },
  {
    name: 'continue turn reopens the sealed turn',
    ops: [
      { op: 'file', path: 'a.txt', content: T('a1\n') },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'a.txt', content: T('a2\n') },
      { op: 'complete' },
      { op: 'begin', checkpoint: 'cp-wake', continue: true },
      { op: 'edit', path: 'a.txt', content: T('a3\n') },
      { op: 'complete' },
      { op: 'review' },
      { op: 'changes', checkpoint: 'cp1', patch: true },
      { op: 'changes', checkpoint: 'cp-wake' },
    ],
  },
  {
    name: 'worker reviews join the running lead turn, or park for the next one',
    ops: [
      { op: 'file', path: 'lead.txt', content: T('l\n') },
      { op: 'file', path: 'w.txt', content: T('w\n') },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'agentBegin', handle: 'h1', owner: 's1', child: 'worker-1', agent: 'worker', tag: 'task' },
      { op: 'edit', session: 'worker-1', path: 'w.txt', content: T('w2\n') },
      { op: 'edit', path: 'lead.txt', content: T('l2\n') },
      { op: 'agentComplete', handle: 'h1' },
      { op: 'agentComplete', handle: 'h1' },
      { op: 'review' },
      { op: 'complete' },
      { op: 'agentBegin', handle: 'h2', owner: 's1', child: 'worker-2', agent: 'worker', tag: 'late' },
      { op: 'edit', session: 'worker-2', path: 'w2.txt', content: T('late\n') },
      { op: 'agentComplete', handle: 'h2', patches: ['diff --git a/x b/x\n'] },
      { op: 'begin', checkpoint: 'cp2' },
      { op: 'review' },
      { op: 'agentBegin', handle: 'h3', owner: 's1', child: 'worker-3', agent: 'w', tag: 't' },
      { op: 'agentComplete', handle: 'h3', patches: ['diff --git a/p b/p\n--- a/p\n+++ b/p\n@@ -1 +1 @@\n-a\n+b\n'] },
      { op: 'review' },
      { op: 'complete' },
      { op: 'changes', checkpoint: 'cp2' },
    ],
  },
  {
    name: 'clearing history, a deleted session, and the kill switch of a running turn',
    ops: [
      { op: 'file', path: 'a.txt', content: T('a\n') },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'a.txt', content: T('b\n') },
      { op: 'clearHistory' },
      { op: 'complete' },
      { op: 'clearHistory' },
      { op: 'cleared' },
      { op: 'review' },
      { op: 'changes', checkpoint: 'cp1' },
      { op: 'begin', checkpoint: 'cp2' },
      { op: 'cleared' },
      { op: 'edit', path: 'a.txt', content: T('c\n') },
      { op: 'complete' },
      { op: 'cleared' },
      { op: 'forget' },
      { op: 'review' },
      { op: 'changes', checkpoint: 'cp2' },
    ],
  },
  {
    name: 'a binary rename, a move onto an existing path, and a rename chain',
    ops: [
      { op: 'file', path: 'old.bin', content: { b64: Buffer.from([0, 9, 9]).toString('base64') } },
      { op: 'file', path: 'x.txt', content: T('x\n') },
      { op: 'file', path: 'y.txt', content: T('y\n') },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'old.bin', to: 'new.bin' },
      { op: 'edit', path: 'x.txt', to: 'x2.txt' },
      { op: 'edit', path: 'x2.txt', to: 'x3.txt', content: T('x edited\n') },
      { op: 'review' },
      { op: 'complete' },
      { op: 'changes', checkpoint: 'cp1', patch: true },
      { op: 'undo', checkpoint: 'cp1', revision: '@current' },
      { op: 'disk', path: 'x.txt' },
      { op: 'disk', path: 'old.bin' },
      { op: 'redo', checkpoint: 'cp1', revision: '@current' },
      { op: 'disk', path: 'x3.txt' },
    ],
  },
  {
    name: 'session review without Git: first states across turns, renames, outside files, external edits, restart',
    ops: [
      { op: 'file', path: 'a.txt', content: T(lines('one', 'two', 'three')) },
      { op: 'file', path: 'b.txt', content: T('moves\n') },
      { op: 'file', path: 'c.txt', content: T('gone\n') },
      { op: 'file', path: '../out/o.txt', content: T('outside v1\n') },
      { op: 'sessionReview' },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'a.txt', content: T(lines('one', '2', 'three')) },
      { op: 'edit', path: 'new.txt', content: T('fresh\n') },
      { op: 'edit', path: 'c.txt', content: null },
      { op: 'sessionReview' },
      { op: 'complete' },
      { op: 'begin', checkpoint: 'cp2' },
      { op: 'edit', path: 'a.txt', content: T(lines('one', '2', 'three', 'four')) },
      { op: 'edit', path: 'b.txt', to: 'b2.txt' },
      { op: 'edit', path: '../out/o.txt', content: T('outside v2\n') },
      { op: 'complete' },
      { op: 'sessionReview' },
      { op: 'sessionFile', file: 'a.txt' },
      { op: 'sessionFile', file: 'b2.txt', oldPath: 'b.txt' },
      { op: 'sessionFile', file: 'zzz.txt' },
      { op: 'file', path: 'new.txt', content: T('changed outside the session\n') },
      { op: 'sessionReview' },
      { op: 'baselineIndex' },
      { op: 'restart' },
      { op: 'sessionReview' },
      { op: 'file', path: 'a.txt', content: T(lines('one', 'two', 'three')) },
      { op: 'sessionReview' },
      { op: 'sessionFile', file: 'new.txt' },
    ],
  },
  {
    name: 'session review inside Git: baseline tree, owned paths, files outside the root',
    ops: [
      { op: 'git' },
      { op: 'file', path: 'a.txt', content: T(lines('x', 'y')) },
      { op: 'file', path: 'keep.txt', content: T('untouched\n') },
      { op: 'file', path: '../outside.txt', content: T('out v1\n') },
      { op: 'sessionReview' },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'edit', path: 'a.txt', content: T(lines('x', 'Y')) },
      { op: 'edit', path: '../outside.txt', content: T('out v2\n') },
      { op: 'sessionReview' },
      { op: 'complete' },
      { op: 'sessionReview' },
      { op: 'sessionFile', file: 'a.txt' },
      { op: 'sessionFile', file: 'keep.txt' },
      { op: 'sessionFile', file: '../outside.txt' },
      { op: 'begin', checkpoint: 'cp2' },
      { op: 'edit', path: 'b.txt', content: T('second turn\n') },
      { op: 'complete' },
      { op: 'restart' },
      { op: 'sessionReview' },
      { op: 'sessionFile', file: 'b.txt' },
    ],
  },
  {
    name: 'session review: workers join their lead, uncaptured first states, deleted history, other sessions',
    ops: [
      { op: 'file', path: 'img.bin', content: { b64: Buffer.from([0, 1, 2, 3, 255]).toString('base64') } },
      { op: 'file', path: 'w.txt', content: T('worker file\n') },
      { op: 'begin', checkpoint: 'cp1' },
      { op: 'agentBegin', handle: 'h1', owner: 's1', child: 'worker-1', agent: 'worker', tag: 'task' },
      { op: 'edit', session: 'worker-1', path: 'w.txt', content: T('worker edit\n') },
      { op: 'edit', path: 'img.bin', content: { b64: Buffer.from([0, 1, 9, 3, 255, 7]).toString('base64') } },
      { op: 'edit', path: 'big.dat', before: { omitted: { size: 70000000, reason: 'oversized' } }, content: T('now small\n') },
      { op: 'edit', path: 'huge.bin', before: { omitted: { size: 5000, reason: 'binary' } }, content: T('text now\n') },
      { op: 'sessionReview' },
      { op: 'sessionReview', session: 'worker-1' },
      { op: 'sessionReview', session: 'nobody' },
      { op: 'baselineIndex' },
      { op: 'baselineIndex', session: 'worker-1' },
      { op: 'agentComplete', handle: 'h1', patches: [] },
      { op: 'complete' },
      { op: 'restart' },
      { op: 'sessionReview' },
      { op: 'clearHistory' },
      { op: 'sessionReview' },
      { op: 'baselineIndex' },
      { op: 'begin', checkpoint: 'cp2' },
      { op: 'edit', path: 'w.txt', content: T('after the delete\n') },
      { op: 'complete' },
      { op: 'sessionReview' },
      { op: 'baselineIndex' },
      { op: 'forget' },
      { op: 'sessionReview' },
    ],
  },
];
const recorded = [];
for (const scenario of scenarios) {
  const out = await runScenario(scenario);
  recorded.push(out);
  console.log(`scenario ${out.name}: ${out.results.length} results`);
}

// The card registry: a bounded map, oldest out first.
{
  const dir = mkdtempSync(join(work, 'reg-'));
  process.env.MIXDOG_DATA_DIR = join(dir, 'data');
  store._setTurnSnapshotStoreRootForTest(join(dir, 'data', 'turn-snapshots'));
  snapshot._resetTurnSnapshotForTest();
  const ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  const steps = [];
  for (let i = 0; i < 70; i += 1) {
    uiDiff.registerEditToolUiDiff({ callId: `c${i}`, sessionId: 'reg', basePath: ws, fullPath: join(ws, `f${i}.txt`), before: null, after: Buffer.from(`${i}\n`) });
  }
  const taken = [];
  for (const id of ['c0', 'c5', 'c6', 'c69', 'c69', 'nope', '']) taken.push({ id, found: uiDiff.takeApplyPatchUiDiff(id) !== null });
  // A re-registered id keeps its place; the oldest goes when the map is full.
  for (let i = 0; i < 64; i += 1) {
    uiDiff.registerEditToolUiDiff({ callId: `r${i}`, sessionId: 'reg', basePath: ws, fullPath: join(ws, `r${i}.txt`), before: null, after: Buffer.from('x\n') });
  }
  uiDiff.registerEditToolUiDiff({ callId: 'r10', sessionId: 'reg', basePath: ws, fullPath: join(ws, 'r10.txt'), before: null, after: Buffer.from('again\n') });
  uiDiff.registerEditToolUiDiff({ callId: 'extra', sessionId: 'reg', basePath: ws, fullPath: join(ws, 'extra.txt'), before: null, after: Buffer.from('e\n') });
  for (const id of ['r0', 'r1', 'r10', 'extra']) taken.push({ id, found: uiDiff.takeApplyPatchUiDiff(id) !== null });
  callOut.registry = { taken, again: uiDiff.takeApplyPatchUiDiff('r10') };
  void steps;
}

// Node's path functions the review's keys depend on, in both flavours (absolute inputs: the
// process directory never enters).
const pathOut = { win32: [], posix: [] };
{
  const win = ['C:\\a\\b', 'C:\\a\\b\\c\\d', 'c:\\A\\B', 'C:\\a\\x', 'D:\\a\\b', 'C:\\', 'C:\\a\\b\\..\\c', 'C:\\a\\.\\b\\', '\\\\srv\\share\\dir', '\\\\srv\\share\\dir\\f.txt', 'C:/a/b/c', 'C:\\a\\..\\..\\x', 'C:\\a\\b\\', 'C:\\a b\\c'];
  const pos = ['/a/b', '/a/b/c/d', '/a/x', '/', '/a/b/../c', '/a/./b/', '/a/../../x', '/a/b/', '/a b/c', '/A/b'];
  for (const [style, list, lib] of [['win32', win, path.win32], ['posix', pos, path.posix]]) {
    for (const a of list) {
      pathOut[style].push({ fn: 'isAbsolute', args: [a], out: lib.isAbsolute(a) });
      pathOut[style].push({ fn: 'resolve', args: [a], out: lib.resolve(a) });
      for (const b of list) {
        pathOut[style].push({ fn: 'relative', args: [a, b], out: lib.relative(a, b) });
      }
    }
    for (const [a, b] of [[list[0], 'x/y'], [list[0], '../z'], [list[0], list[1]], [list[0], './q/../r']]) pathOut[style].push({ fn: 'resolve', args: [a, b], out: lib.resolve(a, b) });
    for (const rel of ['x', '/x', 'C:x', '\\x', '..\\x', 'C:\\x']) pathOut[style].push({ fn: 'isAbsolute', args: [rel], out: lib.isAbsolute(rel) });
  }
}

const stage = stageSet(join(FIXTURES_ROOT, 'turn-review'));
const dump = (name, value) => writeText(join(stage, name), `${JSON.stringify(value, null, 1)}\n`);
dump('nodepath.json', pathOut);
dump('line-diff.json', lineDiffOut);
dump('review-diff.json', reviewOut);
dump('call-diff.json', callOut);
dump('scenarios.json', recorded);
writeSetManifest(stage, {
  set: 'turn-review',
  recorder: 'benchmarks/rust-core/recorders/record-turn-review.mjs',
  command: 'node benchmarks/rust-core/recorders/record-turn-review.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(stage, join(FIXTURES_ROOT, 'turn-review'));
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${join(FIXTURES_ROOT, 'turn-review')}`);
void readdirSync;
