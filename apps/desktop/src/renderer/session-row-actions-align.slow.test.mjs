import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The sidebar row markup of session-sidebar-rows.tsx: a plain row, a working
// row (spinner in the status slot) and an unread row (dot).
const row = (id, kind = id) => `
  <div class="session-row${kind === 'working' ? ' working' : ''}" id="${id}">
    <button type="button" class="session-row-main">
      <span class="session-row-slot"><svg class="session-row-chat-icon" width="14" height="14"></svg></span>
      <span class="session-row-copy"><b>A session title long enough to need an ellipsis on hover</b></span>
      <span class="session-row-status">${kind === 'working' ? '<svg class="session-row-spinner" width="12" height="12"></svg>' : ''}</span>
      ${kind === 'unread' ? '<span class="session-row-unread-dot"></span>' : ''}
    </button>
    <div class="session-row-actions">
      <button type="button" class="session-row-action session-row-favorite"><svg width="14" height="14"></svg></button>
      <button type="button" class="session-row-action session-row-archive"><svg width="14" height="14"></svg></button>
    </div>
  </div>`;

async function openPage(t, body) {
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
    },
    outfile: 'session-row-actions-align.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  // Scrollbars stay on: the rows must fit beside a real scrollbar gutter.
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 600 });
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  return page;
}

test('the hovered archive button sits at one position on plain, working and unread rows', async (t) => {
  const page = await openPage(
    t,
    `<aside class="session-sidebar" style="width:280px"><div class="session-list">
      ${row('plain')}${row('working')}${row('unread')}
    </div></aside>`
  );

  const hovered = [];
  for (const id of ['plain', 'working', 'unread']) {
    await page.hover(`#${id} .session-row-copy`);
    hovered.push(
      await page.evaluate((id) => {
        const row = document.getElementById(id);
        const rowBox = row.getBoundingClientRect();
        const archive = row.querySelector('.session-row-archive').getBoundingClientRect();
        const favorite = row.querySelector('.session-row-favorite').getBoundingClientRect();
        const copy = row.querySelector('.session-row-copy');
        const trailing = row.querySelector('.session-row-unread-dot, .session-row-status:not(:empty)');
        return {
          id,
          archiveRight: rowBox.right - archive.right,
          titleGap:
            favorite.left -
            (copy.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(copy).paddingRight)),
          copyPadding: getComputedStyle(copy).paddingRight,
          trailingOpacity: trailing ? getComputedStyle(trailing).opacity : null,
        };
      }, id)
    );
  }
  for (const sample of hovered) {
    assert.ok(sample.titleGap >= 0, `title ends before the buttons: ${sample.id}`);
  }
  const [plain, ...busy] = hovered;
  for (const sample of busy) {
    assert.equal(sample.archiveRight, plain.archiveRight, `archive button position: ${sample.id}`);
    assert.equal(sample.copyPadding, plain.copyPadding, `title clearance: ${sample.id}`);
    assert.equal(sample.trailingOpacity, '0', `trailing mark hides under the buttons: ${sample.id}`);
  }
});

test("every row's mark and last hover action centre on the header +, worktree rows included", async (t) => {
  const subheading = (name) => `
    <button type="button" class="session-subheading">
      <span class="session-row-slot"></span>
      <span class="session-subheading-name">${name}</span>
      <svg width="12" height="12"></svg>
    </button>`;
  const page = await openPage(
    t,
    `<div style="display:flex;height:360px">
      <aside class="sidebar session-sidebar open">
        <header class="session-panel-header">
          <span class="session-panel-title">Sessions</span>
          <div class="session-panel-header-actions">
            <button type="button" class="session-panel-action session-search-open"><svg width="16" height="16"></svg></button>
            <div class="row-overflow"><button type="button" class="row-overflow-trigger"><svg width="18" height="18"></svg></button></div>
            <button type="button" class="session-panel-action session-new-task"><svg width="16" height="16"></svg></button>
          </div>
        </header>
        <div class="session-sidebar-surface session-sidebar-sessions" data-surface-active="true">
          <div class="session-sidebar-scroll">
            <section class="sidebar-recent">
              <nav class="session-list recent-session-list">${row('recent-working', 'working')}${row('recent-unread', 'unread')}</nav>
            </section>
            <section class="sidebar-recent project-group">
              <nav class="session-list project-session-list">${row('project-working', 'working')}</nav>
            </section>
            <section class="sidebar-recent project-group">
              <nav class="session-list project-session-list project-session-list-split">
                ${subheading('setup-task-make-exactly-these-steps-in-this-order')}
                ${row('nested-working', 'working')}
                ${subheading('reply-with-the-single-word-ok')}
                ${row('nested-unread', 'unread')}
                <div id="fillers">${Array.from({ length: 12 }, (_, i) => row(`filler${i}`, 'plain')).join('')}</div>
              </nav>
            </section>
          </div>
        </div>
      </aside>
    </div>`
  );
  const measure = (id) =>
    page.evaluate((id) => {
      const centre = (element) => {
        const box = element.getBoundingClientRect();
        return (box.left + box.right) / 2;
      };
      const scroll = document.querySelector('.session-sidebar-scroll');
      const box = scroll.getBoundingClientRect();
      const row = document.getElementById(id);
      const rowBox = row.getBoundingClientRect();
      const mark = row.querySelector('.session-row-unread-dot, .session-row-status:not(:empty)');
      const archive = row.querySelector('.session-row-archive');
      const title = row.querySelector('.session-row-copy b');
      const icon = row.querySelector('.session-row-chat-icon');
      return {
        overflows: scroll.scrollHeight > scroll.clientHeight,
        plus: centre(document.querySelector('.session-new-task svg')),
        edge: Math.min(
          document.querySelector('.session-sidebar').getBoundingClientRect().right,
          box.left + scroll.clientLeft + scroll.clientWidth
        ),
        row: rowBox.right,
        height: rowBox.height,
        mark: centre(mark),
        markShown: getComputedStyle(mark).opacity !== '0',
        archive: centre(archive.querySelector('svg')),
        archiveRight: archive.getBoundingClientRect().right,
        archiveSlot: archive.getBoundingClientRect().width,
        favorite: centre(row.querySelector('.session-row-favorite svg')),
        archiveShown: getComputedStyle(archive).opacity !== '0',
        titleCut: title.scrollWidth > title.clientWidth,
        titleLeft: title.getBoundingClientRect().left,
        iconShown: icon.getClientRects().length > 0,
        iconPlace: rowBox.left + Number.parseFloat(getComputedStyle(row).paddingLeft),
      };
    }, id);

  for (const scrolling of [true, false]) {
    await page.evaluate((scrolling) => {
      document.getElementById('fillers').style.display = scrolling ? 'contents' : 'none';
    }, scrolling);
    for (const width of [232, 300, 420]) {
      await page.evaluate((width) => {
        document.querySelector('.session-sidebar').style.setProperty('--session-sidebar-width', `${width}px`);
      }, width);
      await page.mouse.move(1100, 500);
      for (const id of ['recent-working', 'recent-unread', 'project-working', 'nested-working', 'nested-unread']) {
        const label = `${id} at ${width}px, ${scrolling ? 'scrolling' : 'no overflow'}`;
        const resting = await measure(id);
        assert.equal(resting.overflows, scrolling, `scrollbar state: ${label}`);
        assert.ok(resting.row <= resting.edge, `row ends inside the sidebar: ${label} ${JSON.stringify(resting)}`);
        assert.ok(resting.markShown, `mark shown at rest: ${label}`);
        assert.equal(resting.mark, resting.plus, `mark centred on the header +: ${label}`);
        assert.ok(resting.titleCut, `title ellipsized before the mark: ${label}`);
        if (id.startsWith('nested')) {
          assert.equal(resting.iconShown, false, `no chat bubble under a worktree: ${label}`);
          assert.equal(resting.titleLeft, resting.iconPlace, `title takes the bubble's place: ${label}`);
        } else {
          assert.equal(resting.iconShown, true, `chat bubble kept: ${label}`);
        }

        await page.hover(`#${id} .session-row-copy`);
        const hovered = await measure(id);
        await page.mouse.move(1100, 500);
        assert.ok(hovered.archiveShown && !hovered.markShown, `actions take the mark's place: ${label}`);
        assert.equal(hovered.archive, hovered.plus, `archive centred on the header +: ${label}`);
        assert.equal(hovered.favorite, hovered.archive - hovered.archiveSlot, `favourite one slot left: ${label}`);
        assert.ok(hovered.archiveRight <= hovered.edge, `actions inside the sidebar: ${label}`);
        assert.equal(hovered.row, resting.row, `row edge holds on hover: ${label}`);
        assert.equal(hovered.height, resting.height, `row height holds on hover: ${label}`);
      }
    }
  }
});
