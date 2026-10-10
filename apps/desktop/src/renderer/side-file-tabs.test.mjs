import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIDE_FILE_PIN_ORIGIN_MS,
  SIDE_FILE_TAB_LIMIT,
  keepSideFileTabs,
  planSideFileOpen,
  sideFileKey,
} from './side-file-tabs.ts';
import {
  normalizePaneSideDocks,
  paneDockActiveFile,
  withPaneDockFileClosed,
  withPaneDockFileKept,
  withPaneDockFileOpened,
} from './pane-side-dock.tsx';

const ref = (rel) => ({ project: 'C:/p', rel });
const keyOf = (rel) => sideFileKey(ref(rel));
const rels = (plan) => plan.files.map((file) => file.rel);
const empty = { files: [], active: null };
const open = (tabs, rel, options, nonce = 1) => planSideFileOpen(tabs, ref(rel), nonce, options);
const asTabs = (plan) => ({ files: plan.files, active: plan.active });

test('Link preview ON: a new file becomes the preview tab and the next one replaces it', () => {
  let plan = open(empty, 'a.ts', { preview: true, now: 1000 });
  assert.deepEqual(rels(plan), ['a.ts']);
  assert.equal(plan.files[0].preview, true);
  assert.equal(plan.active, keyOf('a.ts'));
  plan = open(asTabs(plan), 'b.ts', { preview: true, now: 2000 }, 2);
  assert.deepEqual(rels(plan), ['b.ts'], 'replaced in place');
  assert.deepEqual(
    plan.removed.map((file) => file.rel),
    ['a.ts']
  );
  assert.equal(plan.files[0].preview, true);
});

test('a kept tab stays when the next preview replaces only the preview tab', () => {
  let plan = open(empty, 'a.ts', { preview: true, now: 1 });
  plan = { ...plan, files: keepSideFileTabs(plan.files, keyOf('a.ts')) };
  assert.equal(plan.files[0].preview, undefined, 'Keep open / double-click / edit');
  plan = open(asTabs(plan), 'b.ts', { preview: true, now: 2 }, 2);
  plan = open(asTabs(plan), 'c.ts', { preview: true, now: 3 }, 3);
  assert.deepEqual(rels(plan), ['a.ts', 'c.ts']);
  assert.deepEqual(
    plan.files.map((file) => Boolean(file.preview)),
    [false, true]
  );
});

test('an edit keeps the preview tab through the entry reducer', () => {
  let entry = withPaneDockFileOpened({ open: false, view: null, surface: '', diff: null }, ref('a.ts'), 1, {
    preview: true,
  });
  assert.equal(entry.files[0].preview, true);
  entry = withPaneDockFileKept(entry, keyOf('a.ts'));
  assert.equal(entry.files[0].preview, undefined);
  assert.equal(withPaneDockFileKept(entry, keyOf('a.ts')), entry, 'nothing left to keep');
});

test('Link preview OFF: every new file is a normal tab', () => {
  let plan = open(empty, 'a.ts', { preview: false });
  plan = open(asTabs(plan), 'b.ts', { preview: false }, 2);
  assert.deepEqual(rels(plan), ['a.ts', 'b.ts']);
  assert.ok(plan.files.every((file) => !file.preview));
  assert.deepEqual(plan.removed, []);
  assert.equal(plan.active, keyOf('b.ts'));
});

test('a file that already has a tab is activated with its line revealed, no new tab', () => {
  let plan = open(empty, 'a.ts', { preview: true, now: 1 });
  plan = open(asTabs(plan), 'b.ts', { preview: false }, 2);
  plan = open(asTabs(plan), 'a.ts', { preview: true, now: 3 }, 9);
  assert.deepEqual(rels(plan), ['a.ts', 'b.ts']);
  assert.equal(plan.active, keyOf('a.ts'));
  assert.deepEqual(plan.removed, []);
  const again = planSideFileOpen(asTabs(plan), { ...ref('a.ts'), line: 12, column: 3 }, 10, { preview: true });
  assert.equal(again.files[0].line, 12);
  assert.equal(again.files[0].column, 3);
  assert.equal(again.files[0].nonce, 10);
  assert.equal(again.files[0].preview, true, 'a preview tab stays a preview');
});

test('following a link from the fresh preview tab keeps that tab (10 s window)', () => {
  const first = open(empty, 'a.ts', { preview: true, now: 1000 });
  const from = keyOf('a.ts');
  const within = open(asTabs(first), 'b.ts', { preview: true, now: 1000 + SIDE_FILE_PIN_ORIGIN_MS, from });
  assert.deepEqual(rels(within), ['a.ts', 'b.ts']);
  assert.deepEqual(
    within.files.map((file) => Boolean(file.preview)),
    [false, true]
  );
  assert.deepEqual(within.removed, []);
  const late = open(asTabs(first), 'b.ts', { preview: true, now: 1000 + SIDE_FILE_PIN_ORIGIN_MS + 1, from });
  assert.deepEqual(rels(late), ['b.ts'], 'too late: the preview is replaced');
  const elsewhere = open(asTabs(first), 'b.ts', { preview: true, now: 1500, from: keyOf('zzz.ts') });
  assert.deepEqual(rels(elsewhere), ['b.ts'], 'a link from another tab does not pin');
});

function filled(count) {
  let plan = empty;
  for (let index = 0; index < count; index += 1) {
    plan = open(asTabs(plan), `f${index}.ts`, { preview: false, now: 100 + index }, index);
  }
  return plan;
}

test('the 9th tab evicts the least recently opened, never the active, new or dirty one', () => {
  const eight = filled(SIDE_FILE_TAB_LIMIT);
  assert.equal(eight.files.length, SIDE_FILE_TAB_LIMIT);
  const ninth = open(asTabs(eight), 'new.ts', { preview: false, now: 500 }, 99);
  assert.equal(ninth.files.length, SIDE_FILE_TAB_LIMIT);
  assert.ok(!rels(ninth).includes('f0.ts'), 'oldest evicted');
  assert.deepEqual(
    ninth.removed.map((file) => file.rel),
    ['f0.ts']
  );
  // The oldest is the active tab: the next oldest goes.
  const activeOldest = { files: eight.files, active: keyOf('f0.ts') };
  assert.ok(!rels(open(activeOldest, 'new.ts', { now: 500 }, 99)).includes('f1.ts'));
  assert.ok(rels(open(activeOldest, 'new.ts', { now: 500 }, 99)).includes('f0.ts'));
  // Dirty tabs are skipped.
  const dirty = new Set([keyOf('f0.ts'), keyOf('f1.ts')]);
  const skipped = open(asTabs(eight), 'new.ts', { now: 500, isDirty: (key) => dirty.has(key) }, 99);
  assert.ok(rels(skipped).includes('f0.ts') && rels(skipped).includes('f1.ts'));
  assert.ok(!rels(skipped).includes('f2.ts'));
  // Every candidate dirty: more than 8 rather than dropping unsaved work.
  const all = new Set(eight.files.map((file) => sideFileKey(file)));
  const kept = open(asTabs(eight), 'new.ts', { now: 500, isDirty: (key) => all.has(key) }, 99);
  assert.equal(kept.files.length, SIDE_FILE_TAB_LIMIT + 1);
  assert.deepEqual(kept.removed, []);
});

test('a stored single file migrates to a one-tab list; the tab list round-trips', () => {
  const groups = [['source-control']];
  const legacy = {
    'pane-1': {
      open: true,
      view: 'source-control',
      surface: 'file',
      diff: null,
      file: { project: 'C:/p', rel: 'src/a.ts', line: 4, nonce: 7 },
    },
  };
  const migrated = normalizePaneSideDocks(legacy, ['pane-1'], groups, false)['pane-1'];
  assert.equal(migrated.surface, 'file');
  assert.equal(migrated.files.length, 1);
  assert.equal(migrated.files[0].rel, 'src/a.ts');
  assert.equal(migrated.files[0].openedAt, 7);
  assert.equal(migrated.activeFile, sideFileKey(migrated.files[0]));
  assert.equal('file' in migrated, false);

  let entry = migrated;
  entry = withPaneDockFileOpened(entry, ref('b.ts'), 8, { preview: true, now: 50 });
  const stored = JSON.parse(JSON.stringify({ 'pane-1': entry }));
  const restored = normalizePaneSideDocks(stored, ['pane-1'], groups, false)['pane-1'];
  assert.deepEqual(
    restored.files.map((file) => [file.rel, Boolean(file.preview)]),
    [
      ['src/a.ts', false],
      ['b.ts', true],
    ]
  );
  assert.equal(paneDockActiveFile(restored).rel, 'b.ts');
});

test('closing a tab activates its neighbour; closing the last hands the body back', () => {
  let entry = { open: true, view: 'source-control', surface: '', diff: null };
  entry = withPaneDockFileOpened(entry, ref('a.ts'), 1, { now: 1 });
  entry = withPaneDockFileOpened(entry, ref('b.ts'), 2, { now: 2 });
  entry = withPaneDockFileClosed(entry, keyOf('b.ts'));
  assert.equal(entry.surface, 'file');
  assert.equal(paneDockActiveFile(entry).rel, 'a.ts');
  entry = withPaneDockFileClosed(entry);
  assert.equal(entry.files, undefined);
  assert.equal(entry.activeFile, undefined);
  assert.equal(entry.surface, '');
});
