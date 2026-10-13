import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createVisualizeVersionStore, pageReferences, VersionHistoryFullError, writeFileInside } from './versions.ts';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-visualize-versions-'));
  const cwd = join(root, 'project');
  const store = join(root, 'app-data', 'visualize-versions');
  mkdirSync(join(cwd, 'site', 'css'), { recursive: true });
  mkdirSync(join(cwd, 'site', '.cache'), { recursive: true });
  return {
    root,
    cwd,
    store,
    write: (rel, text) => writeFileSync(join(cwd, ...rel.split('/')), text),
    source: (kind, rel) => ({ kind, path: realpathSync(join(cwd, ...rel.split('/'))) }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const read = (version, rel) => readFileSync(join(version.dir, ...rel.split('/')), 'utf8');

test('page references are the local styles, scripts and media only', () => {
  const html = `<link rel="stylesheet" href="css/a.css?v=2"><script src='app.js#x'></script>
    <img src=img/pic.png><a href="other.html">x</a><script src="https://cdn.test/x.js"></script>
    <link href="/abs.css"><img src="data:image/png;base64,AA"><video poster="poster%20one.png"></video>`;
  assert.deepEqual(pageReferences(html).sort(), ['app.js', 'css/a.css', 'img/pic.png', 'poster one.png']);
});

test('a version is kept only when the files changed, with the page assets it uses', async () => {
  const space = workspace();
  // Leftovers of an earlier run are wiped: tabs do not survive a restart.
  mkdirSync(join(space.store, 'stale'), { recursive: true });
  try {
    space.write('site/index.html', '<link rel="stylesheet" href="css/site.css"><script src="app.js"></script><script src=".cache/x.js"></script>');
    space.write('site/css/site.css', 'body{color:red}');
    space.write('site/app.js', 'one()');
    space.write('site/.cache/x.js', 'hidden');
    const store = createVisualizeVersionStore({ directory: space.store });
    const sources = [space.source('html', 'site/index.html')];

    const first = await store.snapshot('s1', 'v1', space.cwd, sources);
    assert.equal(first.n, 1);
    assert.equal(existsSync(join(space.store, 'stale')), false);
    assert.ok(realpathSync(first.dir).startsWith(realpathSync(space.store)), 'kept under the app data folder');
    assert.deepEqual(first.panes, ['site/index.html']);
    assert.equal(read(first, 'site/css/site.css'), 'body{color:red}');
    assert.equal(read(first, 'site/app.js'), 'one()');
    assert.equal(existsSync(join(first.dir, 'site', '.cache', 'x.js')), false, 'hidden assets are not kept');

    assert.equal(await store.snapshot('s1', 'v1', space.cwd, sources), null, 'unchanged files keep no version');
    // A changed stylesheet alone is a new version: the old one renders as it was.
    space.write('site/css/site.css', 'body{color:blue}');
    const second = await store.snapshot('s1', 'v1', space.cwd, sources);
    assert.equal(second.n, 2);
    assert.equal(read(first, 'site/css/site.css'), 'body{color:red}');
    assert.equal(read(second, 'site/css/site.css'), 'body{color:blue}');
    assert.deepEqual(store.list('s1', 'v1').map((version) => version.n), [1, 2]);

    // Concurrent snapshots of equal content land once.
    space.write('site/app.js', 'two()');
    const both = await Promise.all([store.snapshot('s1', 'v1', space.cwd, sources), store.snapshot('s1', 'v1', space.cwd, sources)]);
    assert.equal(both.filter(Boolean).length, 1);
    assert.equal(store.list('s1', 'v1').length, 3);

    await store.drop('s1', 'v1');
    assert.deepEqual(store.list('s1', 'v1'), []);
    assert.equal(existsSync(first.dir), false, 'a closed tab deletes its files');
  } finally {
    space.cleanup();
  }
});

test('the per-tab cap evicts oldest first but never the newest or the pinned version', async () => {
  const space = workspace();
  try {
    let pinned = 2;
    const store = createVisualizeVersionStore({
      directory: space.store,
      maxVersionsPerTab: 3,
      pinned: (_sessionId, tabId) => (tabId === 'v1' ? pinned : null),
    });
    const sources = () => [space.source('image', 'chart.png')];
    for (let index = 1; index <= 5; index += 1) {
      space.write('chart.png', `png-${index}`);
      await store.snapshot('s1', 'v1', space.cwd, sources());
    }
    const kept = store.list('s1', 'v1');
    assert.deepEqual(kept.map((version) => version.n), [2, 4, 5]);
    assert.equal(read(kept[0], 'chart.png'), 'png-2');
    pinned = null;
    space.write('chart.png', 'png-6');
    await store.snapshot('s1', 'v1', space.cwd, sources());
    assert.deepEqual(store.list('s1', 'v1').map((version) => version.n), [4, 5, 6]);
  } finally {
    space.cleanup();
  }
});

test('the session byte cap evicts the oldest versions across tabs; oversized panes keep none', async () => {
  const space = workspace();
  try {
    const store = createVisualizeVersionStore({ directory: space.store, maxSessionBytes: 25, maxSnapshotBytes: 12 });
    space.write('a.png', 'aaaaaaaaaa');
    await store.snapshot('s1', 'v1', space.cwd, [space.source('image', 'a.png')]);
    space.write('b.png', 'bbbbbbbbbb');
    await store.snapshot('s1', 'v2', space.cwd, [space.source('image', 'b.png')]);
    space.write('a.png', 'AAAAAAAAAA');
    await store.snapshot('s1', 'v1', space.cwd, [space.source('image', 'a.png')]);
    // 30 bytes > 25: v1's oldest goes; each tab keeps its newest.
    assert.deepEqual(store.list('s1', 'v1').map((version) => version.n), [2]);
    assert.deepEqual(store.list('s1', 'v2').map((version) => version.n), [1]);
    // Another session has its own budget.
    space.write('c.png', 'cccccccccc');
    await store.snapshot('s2', 'v1', space.cwd, [space.source('image', 'c.png')]);
    assert.equal(store.list('s1', 'v1').length + store.list('s1', 'v2').length, 2);

    space.write('big.png', 'x'.repeat(13));
    assert.equal(await store.snapshot('s1', 'v3', space.cwd, [space.source('image', 'big.png')]), null);
    assert.deepEqual(store.list('s1', 'v3'), []);
  } finally {
    space.cleanup();
  }
});

test('the session byte cap holds: when versions eviction may not drop fill it, the new snapshot is skipped', async () => {
  const space = workspace();
  try {
    let pinned = null;
    const store = createVisualizeVersionStore({
      directory: space.store,
      maxSessionBytes: 25,
      maxSnapshotBytes: 12,
      pinned: (_sessionId, tabId) => (tabId === 'v1' ? pinned : null),
    });
    const numbers = (tabId) => store.list('s1', tabId).map((version) => version.n);
    const total = () =>
      ['v1', 'v2', 'v3'].flatMap((tabId) => store.list('s1', tabId)).reduce((sum, version) => sum + version.bytes, 0);
    const keptFiles = () => readdirSync(space.store, { recursive: true }).filter((entry) => String(entry).endsWith('.png'));
    for (const name of ['a', 'b', 'c']) space.write(`${name}.png`, name.repeat(10));
    await store.snapshot('s1', 'v1', space.cwd, [space.source('image', 'a.png')]);
    await store.snapshot('s1', 'v2', space.cwd, [space.source('image', 'b.png')]);

    // Each tab's newest stays, so a third tab's 10 bytes cannot fit in 25.
    await assert.rejects(store.snapshot('s1', 'v3', space.cwd, [space.source('image', 'c.png')]), VersionHistoryFullError);
    assert.deepEqual([numbers('v1'), numbers('v2'), numbers('v3')], [[1], [1], []]);
    assert.ok(total() <= 25);

    // The shown (pinned) version stays too: v1's next version has no room.
    pinned = 1;
    space.write('a.png', 'A'.repeat(10));
    await assert.rejects(store.snapshot('s1', 'v1', space.cwd, [space.source('image', 'a.png')]), VersionHistoryFullError);
    assert.deepEqual(numbers('v1'), [1], 'the version list is unchanged');
    assert.ok(total() <= 25);

    // Once v1's old version may go, the new one fits within the cap.
    pinned = null;
    const kept = await store.snapshot('s1', 'v1', space.cwd, [space.source('image', 'a.png')]);
    assert.equal(kept.n, 2);
    assert.deepEqual(numbers('v1'), [2]);
    assert.ok(total() <= 25);
    assert.equal(keptFiles().length, 2, 'skipped snapshots leave no files behind');
  } finally {
    space.cleanup();
  }
});

test('restore writes re-resolve the folder inside cwd, replace via a temp file, and never follow a link', async () => {
  const space = workspace();
  const outside = join(space.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'site.css'), 'outside');
  try {
    const root = realpathSync(space.cwd);
    space.write('site/css/site.css', 'old');
    await writeFileInside(root, join(root, 'site', 'css', 'site.css'), Buffer.from('new'));
    assert.equal(readFileSync(join(space.cwd, 'site', 'css', 'site.css'), 'utf8'), 'new');
    assert.deepEqual(readdirSync(join(space.cwd, 'site', 'css')), ['site.css'], 'no temp file is left behind');

    // The folder swapped for a link outside since it was validated: refused.
    renameSync(join(space.cwd, 'site', 'css'), join(space.cwd, 'site', 'css-old'));
    symlinkSync(outside, join(space.cwd, 'site', 'css'), 'junction');
    await assert.rejects(
      writeFileInside(root, join(root, 'site', 'css', 'site.css'), Buffer.from('x')),
      /site\/css\/site\.css is outside the working directory/
    );
    // A link at the destination itself is refused, never followed.
    symlinkSync(outside, join(space.cwd, 'site', 'app.js'), 'junction');
    await assert.rejects(writeFileInside(root, join(root, 'site', 'app.js'), Buffer.from('x')), /site\/app\.js is a link/);
    await assert.rejects(writeFileInside(root, join(space.root, 'x.css'), Buffer.from('x')), /outside the working directory/);
    assert.deepEqual(readdirSync(outside), ['site.css'], 'nothing landed outside');
    assert.equal(readFileSync(join(outside, 'site.css'), 'utf8'), 'outside');
  } finally {
    space.cleanup();
  }
});

test('a file with another hard link outside cwd is never written in place', async () => {
  const space = workspace();
  const outside = join(space.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'shared.css'), 'outside');
  try {
    const root = realpathSync(space.cwd);
    linkSync(join(outside, 'shared.css'), join(space.cwd, 'site', 'shared.css'));
    await assert.rejects(
      writeFileInside(root, join(root, 'site', 'shared.css'), Buffer.from('restored')),
      /site\/shared\.css has other hard links; not restored/
    );
    // The link appearing between validation and the open is caught on the handle too.
    space.write('site/solo.css', 'inside');
    await assert.rejects(
      writeFileInside(root, join(root, 'site', 'solo.css'), Buffer.from('restored'), {
        beforeOpen: () => linkSync(join(space.cwd, 'site', 'solo.css'), join(outside, 'solo.css')),
      }),
      /site\/solo\.css has other hard links; not restored/
    );
    assert.equal(readFileSync(join(outside, 'shared.css'), 'utf8'), 'outside', 'the outside file is unchanged');
    assert.equal(readFileSync(join(outside, 'solo.css'), 'utf8'), 'inside');
  } finally {
    space.cleanup();
  }
});

test('a parent swapped for a link between validation and the write changes no outside file', async () => {
  const space = workspace();
  const outside = join(space.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'site.css'), 'outside');
  // A counter, not the clock: two swaps can land in the same millisecond.
  let swaps = 0;
  const swap = () => {
    swaps += 1;
    renameSync(join(space.cwd, 'site', 'css'), join(space.cwd, 'site', `css-old-${swaps}`));
    symlinkSync(outside, join(space.cwd, 'site', 'css'), 'junction');
  };
  try {
    const root = realpathSync(space.cwd);
    // An existing destination: the open lands on the outside file of the same name.
    space.write('site/css/site.css', 'inside');
    await assert.rejects(
      writeFileInside(root, join(root, 'site', 'css', 'site.css'), Buffer.from('restored'), { beforeOpen: swap }),
      /site\/css\/site\.css changed while it was restored; nothing was written/
    );
    assert.equal(readFileSync(join(outside, 'site.css'), 'utf8'), 'outside', 'the outside file is untouched');

    // A missing destination: created outside by the exclusive open, then removed.
    rmSync(join(space.cwd, 'site', 'css'), { recursive: true, force: true });
    mkdirSync(join(space.cwd, 'site', 'css'));
    await assert.rejects(
      writeFileInside(root, join(root, 'site', 'css', 'new.css'), Buffer.from('restored'), { beforeOpen: swap }),
      /site\/css\/new\.css changed while it was restored; nothing was written/
    );
    assert.deepEqual(readdirSync(outside), ['site.css'], 'no file is left outside');
    assert.equal(readFileSync(join(outside, 'site.css'), 'utf8'), 'outside');

    // Without a swap, a missing destination is created in place.
    rmSync(join(space.cwd, 'site', 'css'), { recursive: true, force: true });
    mkdirSync(join(space.cwd, 'site', 'css'));
    await writeFileInside(root, join(root, 'site', 'css', 'new.css'), Buffer.from('restored'));
    assert.equal(readFileSync(join(space.cwd, 'site', 'css', 'new.css'), 'utf8'), 'restored');
  } finally {
    space.cleanup();
  }
});
