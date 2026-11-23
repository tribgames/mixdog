import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Native focus order and form submission require Chromium: jsdom's selector
// engine can return grouped selectors in selector order rather than DOM order.
test('branch name popup keeps keyboard focus and never submits the chat composer', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { BranchChip } from './BranchChip';
        import { initUiLanguage, setUiLanguagePreference } from './i18n';
        window.branchCalls = [];
        window.composerSubmits = 0;
        const workspace = {
          projectPath: '/p', repoCommonDir: '/p/.git', cwd: '/p',
          worktreeId: null, branch: 'main', baseCommit: null,
          mergeTarget: 'main', revision: 3, transition: { state: 'idle', txId: null },
        };
        window.prompt = () => { throw new Error('Native prompt must not be used'); };
        window.mixdogDesktop = {
          rendererDiagnostic() {},
          async invokeCapability(request) {
            if (request.capability === 'getBranchMenu') {
              return { value: { workspace, branches: [], occupancy: [], retainedWorktree: null }, snapshot: null };
            }
            if (request.capability === 'selectBranch') {
              window.branchCalls.push(request);
              if (window.failNextBranch) {
                window.failNextBranch = false;
                throw new Error('Branch creation failed');
              }
              workspace.branch = request.args[0].branch;
              workspace.revision++;
              return { value: { workspace, revision: workspace.revision }, snapshot: null };
            }
            throw new Error('Unexpected capability: ' + request.capability);
          },
        };
        setUiLanguagePreference('en');
        initUiLanguage().then(() => {
          createRoot(document.getElementById('root')).render(
            <div className="pane-cell">
              <form onSubmit={event => { event.preventDefault(); window.composerSubmits++; }}>
                <BranchChip sessionId="s1" projectPath="/p" />
              </form>
            </div>
          );
        });
      `,
    },
    bundle: true,
    jsx: 'automatic',
    write: false,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = '.branch-name-dialog input';
  const submit = '.branch-name-dialog button[type="submit"]';
  const openDialog = async () => {
    await page.waitForSelector('.branch-chip-trigger', { timeout: 5000 }).catch((error) => {
      assert.deepEqual(pageErrors, [], 'the fixture must render without errors');
      throw error;
    });
    await page.click('.branch-chip-trigger');
    await page.waitForSelector('.branch-menu [data-kind="create"]');
    await page.click('.branch-menu [data-kind="create"]');
    await page.waitForSelector(input);
    assert.equal(await page.$eval(input, (node) => document.activeElement === node), true);
  };
  await openDialog();
  assert.equal(await page.$('.branch-menu'), null);
  assert.equal(await page.$eval('.branch-name-dialog', (node) => node.parentElement.className), 'pane-dialog-layer');
  await page.keyboard.type('feat/popup');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  assert.equal(await page.$eval(submit, (node) => document.activeElement === node), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.branch-name-dialog', { hidden: true });
  assert.equal(await page.$eval('.branch-chip-trigger', (node) => document.activeElement === node), true);
  assert.deepEqual(await page.evaluate(() => window.branchCalls), []);

  await openDialog();
  await page.keyboard.type('feat/popup');
  await page.evaluate(() => {
    window.failNextBranch = true;
  });
  await page.click(submit);
  await page.waitForSelector('.branch-name-dialog [role="alert"]');
  assert.match(
    await page.$eval('.branch-name-dialog [role="alert"]', (node) => node.textContent),
    /Branch creation failed/
  );
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true);
  assert.equal(await page.$eval(input, (node) => node.value), 'feat/popup');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.branch-name-dialog', { hidden: true });
  assert.deepEqual(await page.evaluate(() => window.branchCalls), [
    {
      capability: 'selectBranch',
      args: [{ branch: 'feat/popup', create: true, expectedRevision: 3 }],
      sessionId: 's1',
    },
    {
      capability: 'selectBranch',
      args: [{ branch: 'feat/popup', create: true, expectedRevision: 3 }],
      sessionId: 's1',
    },
  ]);
  assert.equal(await page.evaluate(() => window.composerSubmits), 0);
  assert.deepEqual(pageErrors, []);
  assert.equal(await page.$eval('.branch-chip-trigger', (node) => document.activeElement === node), true);
});

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const assetLoader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };

// The branch list in its three hosts, with the app's styles: the New Task chip's popup, the session panel's
// Branch row popup (280px, the row's width; a session in the project folder, one in its own worktree, a New Task
// draft) and the composer island's branch tab (project folder, worktree).
const LIST_HARNESS = `
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { BranchChip } from './BranchChip';
  import { BranchIslandSegment, clearBranchSegmentCache } from './WorktreeIslandSegment';
  import { initUiLanguage } from './i18n';

  const day = 86_400_000;
  const at = (days) => new Date(Date.now() - days * day).toISOString();
  const workspace = (worktree) => ({
    projectPath: '/p', repoCommonDir: '/p/.git', cwd: worktree ? '/wt' : '/p',
    worktreeId: worktree ? 'w1' : null, branch: worktree ? 'setup-task-make-exactly-these' : 'main',
    baseCommit: null, mergeTarget: 'main', revision: 3, transition: { state: 'idle', txId: null },
  });
  const branch = (name, days) => ({ name, current: name === 'main', remote: false, upstream: '', lastCommitAt: at(days) });
  const menu = (worktree) => ({
    workspace: workspace(worktree),
    branches: [
      branch('main', 0.2), branch('setup-task-make-exactly-these', 0.1), branch('reply-with-the-single-word-ok', 0.3),
      branch('feat/session-rail-polish', 2), branch('fix/cursor-tool-schema', 5),
      branch('old-a', 60), branch('old-b', 70), branch('old-c', 80), branch('ext', 90),
    ],
    occupancy: [
      { branch: 'main', kind: 'current' },
      { branch: 'setup-task-make-exactly-these', kind: 'session', sessionId: 'sw' },
      { branch: 'reply-with-the-single-word-ok', kind: 'session', sessionId: 'other' },
      { branch: 'ext', kind: 'external', path: '/elsewhere/ext' },
    ],
    retainedWorktree: null,
  });
  // Three rows, as a small repository shows them.
  const shortMenu = () => ({
    workspace: workspace(false),
    branches: [branch('main', 0.2), branch('dev', 1), branch('feat/login', 2)],
    occupancy: [{ branch: 'main', kind: 'current' }],
    retainedWorktree: null,
  });
  window.mixdogDesktop = {
    rendererDiagnostic() {},
    async gitStatus() { return null; },
    async invokeCapability(request) {
      if (request.capability === 'getBranchMenu') {
        return { value: request.sessionId === 'short' ? shortMenu() : menu(request.sessionId === 'sw'), snapshot: null };
      }
      if (request.capability === 'getProjectBranchMenu') return { value: menu(false), snapshot: null };
      if (request.capability === 'previewWorktreeCleanup') return { value: { hasCandidates: true }, snapshot: null };
      return { value: null, snapshot: null };
    },
  };
  let root;
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  async function until(find) {
    for (let tries = 0; tries < 200; tries += 1) {
      const found = find();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('never shown');
  }
  // Mounts one host in \`language\` and opens its list; resolves to the list's root.
  window.openList = async (host, language, top = 20) => {
    window.process.env.MIXDOG_UI_LANGUAGE = language;
    await initUiLanguage();
    clearBranchSegmentCache();
    root ??= createRoot(document.getElementById('root'));
    flushSync(() => root.render(null));
    const sessionId = host.endsWith('worktree') ? 'sw' : host.endsWith('short') ? 'short' : 'sp';
    const segment = (props) => <BranchIslandSegment sessionId={sessionId} workspace={workspace(sessionId === 'sw')}
      projectPath="/p" onViewChanges={() => {}} {...props} />;
    const row = (button) => <button {...button} type="button" className="probe-row" style={{ width: 280, height: 32 }}>Branch</button>;
    const railBox = { width: 280, margin: 20, marginTop: top };
    const element = host === 'rail-draft'
      ? <div className="probe-wrap" style={railBox}><BranchChip sessionId="" draftId="d" projectPath="/p" renderTrigger={row} /></div>
      : {
          chip: <div style={{ margin: '400px 0 0 20px' }}><BranchChip sessionId={sessionId} projectPath="/p" /></div>,
          rail: <div className="probe-wrap" style={railBox}>{segment({ renderTrigger: row })}</div>,
          // Held at its bottom edge, as over the composer: the panel grows upward.
          island: <div className="composer-island" style={{ position: 'fixed', left: 20, bottom: 20, width: 'var(--island-panel-width)' }}>{segment({})}</div>,
        }[host.replace(/-.*/, '')];
    flushSync(() => root.render(element));
    const trigger = await until(() => document.querySelector('.branch-chip-trigger, .probe-row, .composer-island-seg-branch'));
    // The chip opens on the press itself.
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    trigger.click();
    const list = await until(() => {
      const node = document.querySelector('.branch-menu, .branch-tab-host, .composer-island-branch-panel');
      return node?.querySelector('[data-kind="branch"]') && node.querySelector('.branch-menu-foot [data-kind="prune"]') && node;
    });
    await frames();
    return Boolean(list);
  };
  window.measureList = () => {
    const list = document.querySelector('.branch-menu, .branch-tab-host, .composer-island-branch-panel');
    const box = (node) => node.getBoundingClientRect();
    const foot = list.querySelector('.branch-menu-foot');
    const probe = document.createElement('span');
    probe.style.fontSize = 'var(--mx-font-supporting)';
    document.body.append(probe);
    const supporting = getComputedStyle(probe).fontSize;
    probe.remove();
    return {
      width: box(list).width,
      rows: [...list.querySelectorAll('.branch-menu-list [data-kind="branch"]')].map((row) => {
        const name = row.querySelector(':scope > span');
        const end = row.querySelector(':scope > small');
        return {
          branch: row.dataset.branch,
          height: box(row).height,
          nameLeft: box(name).left - box(row).left,
          nameHeight: box(name).height,
          nameWeight: getComputedStyle(name).fontWeight,
          endCut: end ? end.scrollWidth > end.clientWidth : false,
          opacity: Number(getComputedStyle(row).opacity),
        };
      }),
      labels: [...list.querySelectorAll('.branch-menu-list .branch-menu-label')].map((label) => ({
        text: label.textContent,
        height: box(label).height,
        size: getComputedStyle(label).fontSize,
      })),
      supporting,
      foot: { left: box(foot).left, right: box(foot).right, overflows: foot.scrollWidth > foot.clientWidth },
      buttons: [...foot.querySelectorAll('button')].map((button) => ({
        id: button.dataset.actionId ?? button.dataset.kind,
        top: Math.round(box(button).top),
        height: box(button).height,
        left: box(button).left,
        right: box(button).right,
        text: button.innerText.trim(),
      })),
    };
  };
  // The island's branch tab: its height, where its search field stands, and the room under its last row.
  window.islandState = () => {
    const panel = document.querySelector('.composer-island-branch-panel');
    const list = panel.querySelector('.branch-menu-list');
    const last = list.lastElementChild;
    return {
      height: panel.getBoundingClientRect().height,
      searchTop: panel.querySelector('.branch-menu-search').getBoundingClientRect().top,
      underLastRow: list.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom,
      rows: list.querySelectorAll('[data-kind="branch"]').length,
    };
  };
  // The session panel's popup against its row: both boxes, its whole content's height, and the search's focus.
  window.popupState = () => {
    const host = document.querySelector('.branch-tab-host');
    const row = document.querySelector('.probe-row').getBoundingClientRect();
    if (!host) return { open: false };
    const box = host.getBoundingClientRect();
    const cap = host.style.maxHeight;
    host.style.maxHeight = 'none';
    const content = host.scrollHeight;
    host.style.maxHeight = cap;
    return {
      open: true,
      row: { top: row.top, bottom: row.bottom, left: row.left, width: row.width },
      popup: { top: box.top, bottom: box.bottom, left: box.left, width: box.width, height: box.height },
      content,
      searchFocused: document.activeElement === host.querySelector('.branch-menu-search'),
    };
  };
  // A row's name and end mark before and while the pointer is on it.
  window.rowBox = (branch) => {
    const row = document.querySelector('[data-branch="' + branch + '"]');
    const name = row.querySelector(':scope > span').getBoundingClientRect();
    const end = row.querySelector(':scope > small, :scope > .branch-menu-check');
    const more = row.parentElement.querySelector(':scope > .branch-row-more');
    return {
      name: { left: name.left, right: name.right },
      endShown: end ? getComputedStyle(end).visibility === 'visible' : null,
      more: { left: more.getBoundingClientRect().left, shown: getComputedStyle(more).opacity === '1' },
    };
  };
`;

let listAssets;
let listBrowser;
after(async () => (await listBrowser)?.close());
/** A page with the list harness and the app's styles; the bundle and the browser are the file's, once. */
async function openListPage(t) {
  listAssets ??= Promise.all([
    build({
      // The editor's Vite-only `?worker` imports, reached through the island's changes store.
      plugins: [
        {
          name: 'worker-stub',
          setup(builder) {
            builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
              contents: 'export default class {};',
              loader: 'js',
            }));
          },
        },
      ],
      stdin: { resolveDir, loader: 'tsx', contents: LIST_HARNESS },
      outfile: 'branch-list-layout.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
      loader: assetLoader,
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./session-rail.css";',
      },
      outfile: 'branch-list-layout.css',
      bundle: true,
      write: false,
      loader: assetLoader,
    }),
  ]);
  const [bundle, styles] = await listAssets;
  listBrowser ??= puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  const page = await (await listBrowser).newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1100, height: 900 });
  await page.setContent('<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>');
  for (const file of bundle.outputFiles.filter((output) => output.path.endsWith('.css'))) {
    await page.addStyleTag({ content: file.text });
  }
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: 'window.process = { env: {}, platform: "win32", argv: [], versions: {} };' });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  assert.deepEqual(errors, [], 'the fixture loads');
  return { page, errors };
}

test('the branch list in all three hosts: one-line rows at the row height, a one-line foot at the longest and shortest words', async (t) => {
  const { page, errors } = await openListPage(t);
  // The foot's words are longest in French (New branch · New worktree · Clean up) and German (View changes · Merge ·
  // Remove), where labels give way to icons, shortest in Simplified Chinese; Korean is the approved mockup's.
  const languages = ['fr', 'de', 'zh-CN', 'ko'];
  const hosts = ['chip-project', 'rail-project', 'rail-worktree', 'rail-draft', 'island-project', 'island-worktree'];
  for (const language of languages) {
    for (const host of hosts) {
      const at = `${language} ${host}`;
      await page.evaluate((name, lang) => window.openList(name, lang), host, language);
      const list = await page.evaluate(() => window.measureList());
      for (const label of list.labels) {
        assert.equal(label.height, 24, `${at}: label ${label.text}`);
        assert.equal(label.size, list.supporting, `${at}: label ${label.text} in the supporting size`);
      }
      for (const row of list.rows) {
        assert.equal(row.height, 32, `${at}: ${row.branch} is one row at the row height`);
        assert.equal(row.nameHeight, 20, `${at}: ${row.branch} on the text line`);
        assert.equal(row.nameLeft, list.rows[0].nameLeft, `${at}: ${row.branch} name aligned`);
        assert.equal(row.nameWeight, '400', `${at}: ${row.branch} in the regular weight`);
        assert.equal(row.endCut, false, `${at}: ${row.branch} end mark whole`);
        // An unmanaged worktree's branch cannot be picked and reads as unavailable; the rest in full ink.
        assert.equal(row.opacity < 1, row.branch === 'ext', `${at}: ${row.branch} opacity ${row.opacity}`);
      }
      // The foot: one line inside its box.
      assert.equal(list.foot.overflows, false, `${at}: foot fits`);
      assert.equal(
        new Set(list.buttons.map((button) => button.top)).size,
        1,
        `${at}: foot on one line ${JSON.stringify(list.buttons)}`
      );
      for (const button of list.buttons) {
        assert.equal(button.height, 28, `${at}: ${button.id} height`);
        assert.ok(
          button.left >= list.foot.left - 0.5 && button.right <= list.foot.right + 0.5,
          `${at}: ${button.id} inside the foot`
        );
      }
      if (host.startsWith('rail')) {
        assert.equal(list.width, 280, `${at}: as wide as its row`);
        assert.equal(list.buttons.at(-1).text, '', `${at}: Clean up is its broom alone`);
      }
      if (language === 'ko' && host === 'rail-project') {
        // The "…" takes the end mark's place; the name stays where it is and never runs under it.
        for (const branch of ['main', 'reply-with-the-single-word-ok', 'feat/session-rail-polish']) {
          const before = await page.evaluate((name) => window.rowBox(name), branch);
          await page.hover(`[data-branch="${branch}"]`);
          const during = await page.evaluate((name) => window.rowBox(name), branch);
          assert.equal(during.more.shown, true, `${branch}: "…" shown`);
          assert.equal(during.name.left, before.name.left, `${branch}: the name does not move`);
          assert.ok(during.name.right <= during.more.left, `${branch}: the name stops before "…"`);
          if (before.endShown !== null) assert.equal(during.endShown, false, `${branch}: the end mark gives way`);
          await page.mouse.move(1000, 880);
        }
      }
    }
  }
  assert.deepEqual(errors, []);
});

test("the island's branch tab is as tall as its rows, and a search keeps its field where it was until cleared", async (t) => {
  const { page, errors } = await openListPage(t);
  await page.evaluate(() => window.openList('island-short', 'en'));
  const opened = await page.evaluate(() => window.islandState());
  assert.equal(opened.rows, 3);
  assert.ok(opened.underLastRow < 1, `no empty band under the last row: ${opened.underLastRow}px`);

  // The panel grows up from the composer: a list narrowing under a search must not move the field under the caret.
  await page.focus('.composer-island-branch-panel .branch-menu-search');
  await page.keyboard.type('login');
  const narrowed = await page.evaluate(() => window.islandState());
  assert.equal(narrowed.rows, 1);
  assert.equal(narrowed.searchTop, opened.searchTop, 'the search field stays put');

  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  const cleared = await page.evaluate(() => window.islandState());
  assert.equal(cleared.rows, 3);
  assert.equal(cleared.height, opened.height, 'cleared, it is as tall as its rows again');
  assert.deepEqual(errors, []);
});

test("the Branch row's popup stays open on its row while the window and the row change, back on the roomier side", async (t) => {
  const { page, errors } = await openListPage(t);
  const frames = () =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // A short window: the popup opens below its row, cut to the room there; the user is in its search field.
  await page.setViewport({ width: 1100, height: 380 });
  await page.evaluate(() => window.openList('rail-draft', 'en', 100));
  await page.focus('.branch-tab-host .branch-menu-search');
  const cramped = await page.evaluate(() => window.popupState());
  assert.ok(cramped.popup.top >= cramped.row.bottom, 'below its row');
  assert.ok(cramped.popup.height < cramped.content, 'cut to the room below');

  // The panel reflows its row lower, then the window grows (a zoom, a keyboard closing): below can now hold the cut
  // height but not the whole list, and above is roomier.
  await page.evaluate(() => {
    document.querySelector('.probe-wrap').style.marginTop = '400px';
  });
  await page.setViewport({ width: 1100, height: 760 });
  await frames();
  const grown = await page.evaluate(() => window.popupState());
  assert.equal(grown.open, true, 'still open');
  assert.equal(grown.searchFocused, true, 'the search keeps the focus');
  assert.ok(760 - grown.row.bottom < grown.content && grown.row.top > 760 - grown.row.bottom, 'the fixture premise');
  assert.ok(grown.popup.bottom <= grown.row.top, `above its row, the roomier side: ${JSON.stringify(grown)}`);
  assert.ok(grown.popup.height > cramped.popup.height, 'no longer held to the earlier cut');

  // The row's own box changes in a later render than any window event: the popup follows it.
  await page.evaluate(() => {
    document.querySelector('.probe-row').style.width = '240px';
  });
  await frames();
  const narrowed = await page.evaluate(() => window.popupState());
  assert.equal(narrowed.open, true);
  assert.equal(narrowed.popup.width, 240, 'as wide as its row again');
  assert.equal(narrowed.popup.left, narrowed.row.left);
  assert.deepEqual(errors, []);
});
