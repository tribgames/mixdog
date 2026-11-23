import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// Real CSS and the real strips: the side panel's file header (Changes ahead of
// the file tabs, as reported at a 430px panel) and the Changes pane's own
// strip, at the panel's minimum and the reported width, with 2, 5 and 8 file
// tabs (8 is the most a dock keeps), with and without Changes and with an
// inline header action (Save while dirty).
const PAGE = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { SideFileStrip } from './side-surface-strip.tsx';
  import { SessionDiffTabStrip } from './session-diff-tab-strip.tsx';
  import { DockHeaderRow, PaneDockExpandContext } from './pane-dock-chrome.tsx';
  import { sideFileKey } from './side-file-tabs.ts';
  const h = React.createElement;
  const root = createRoot(document.getElementById('host'));
  window.__render = ({ strip, files: count, changes, inline }) => {
    const files = Array.from({ length: count }, (_, index) => ({
      project: 'C:/p',
      rel: 'attachments/image-1a2061b028c4dab' + index + '.png',
      nonce: index + 1,
      openedAt: index + 1,
    }));
    const chrome = inline ? { editable: true, dirty: true, saving: false, save() {} } : null;
    const body =
      strip === 'file'
        ? h(SideFileStrip, {
            files,
            activeKey: sideFileKey(files[files.length - 1]),
            leadingTab: changes ? { label: '변경 사항', onSelect() {} } : undefined,
            chrome,
            onSelect() {}, onCloseTab() {}, onKeep() {}, onOpenInMain() {}, onClose() {},
          })
        : h(DockHeaderRow, {
            className: 'session-diff-header',
            onClose() {},
            actions: inline ? [{ id: 'save', label: 'Save', icon: () => h('svg', { width: 15, height: 15 }), inline: true, onSelect() {} }] : [],
            left: h(SessionDiffTabStrip, {
              pendingPath: '',
              showChanges: changes,
              focusRow: null,
              tabRows: [],
              fileTabs: {
                tabs: files.map((file) => ({ key: sideFileKey(file), name: file.rel.split('/').pop(), title: file.rel })),
                onSelect() {},
                onClose() {},
              },
              onShowAllFiles() {}, onCloseChanges() {}, onOpenDiffTab() {}, onCloseDiffTab() {},
            }),
          });
    flushSync(() =>
      root.render(h(PaneDockExpandContext.Provider, { value: { expanded: false, toggle() {} } }, body))
    );
  };
`;

/** Read in the page: where the strip ends against the first header action, and each tab's cut. */
function readStrip() {
  const header = document.querySelector('.dock-header-row');
  const list = header.querySelector('.browser-tab-list');
  const action = header.querySelector('.dock-header-controls button');
  const box = list.getBoundingClientRect();
  const fadeStart = list.hasAttribute('data-fade-start');
  const fadeEnd = list.hasAttribute('data-fade-end');
  return {
    stripRight: box.right,
    actionLeft: action.getBoundingClientRect().left,
    overflow: list.scrollWidth - list.clientWidth,
    fadeStart,
    fadeEnd,
    masked: getComputedStyle(list).maskImage !== 'none',
    tabs: [...list.querySelectorAll(':scope > .browser-tab')].map((cell) => {
      const rect = cell.getBoundingClientRect();
      const label = cell.querySelector('.browser-tab-select > span');
      const labelBox = label.getBoundingClientRect();
      // Characters drawn whole before the ellipsis (all of them when the name fits).
      let readable = label.textContent.length;
      if (label.scrollWidth > label.clientWidth) {
        const context = document.createElement('canvas').getContext('2d');
        context.font = getComputedStyle(label).font;
        const limit = labelBox.right - context.measureText('…').width;
        const range = document.createRange();
        const text = label.firstChild;
        readable = 0;
        for (let end = 1; end <= text.length; end += 1) {
          range.setStart(text, 0);
          range.setEnd(text, end);
          if (range.getBoundingClientRect().right > limit + 0.5) break;
          readable = end;
        }
      }
      return {
        name: label.textContent,
        active: cell.classList.contains('is-active'),
        width: rect.width,
        readable,
        iconShown: cell.querySelector('.browser-tab-select svg').getBoundingClientRect().width > 0,
        closeShown: Boolean(cell.querySelector('.browser-tab-close')?.getClientRects().length),
        glyphsInside: [...cell.querySelectorAll('svg')]
          .filter((icon) => icon.getClientRects().length > 0)
          .every((icon) => {
            const glyph = icon.getBoundingClientRect();
            return glyph.left >= rect.left - 0.5 && glyph.right <= rect.right + 0.5;
          }),
        labelInside: label.getBoundingClientRect().right <= rect.right + 0.5,
        cut: label.scrollWidth > label.clientWidth,
        ellipsis: getComputedStyle(label).textOverflow === 'ellipsis',
        // A tab crossing a strip edge: that edge must be faded, never a hard cut.
        crossesStart: rect.left < box.left - 0.5 && rect.right > box.left + 0.5,
        crossesEnd: rect.left < box.right - 0.5 && rect.right > box.right + 0.5,
        visible: rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5,
      };
    }),
  };
}

test('dock tab strips: names ellipsize inside their tabs, the strip ends before the header actions, and a scrolling edge fades instead of cutting', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' };
  const [page, base] = await Promise.all([
    build({
      stdin: { contents: PAGE, resolveDir, loader: 'tsx' },
      outdir: 'side-file-strip',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      logLevel: 'silent',
      loader,
    }),
    build({
      stdin: {
        contents: '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
        resolveDir,
        loader: 'css',
      },
      outfile: 'side-file-strip-base.css',
      bundle: true,
      write: false,
      loader,
    }),
  ]);
  const js = page.outputFiles.find((out) => out.path.endsWith('.js')).text;
  const css = [base, page].flatMap((result) => result.outputFiles.filter((out) => out.path.endsWith('.css')));
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.setViewport({ width: 900, height: 200 });
  await tab.setContent(
    `<!doctype html><html><head><style>${css.map((out) => out.text).join('\n')}</style></head><body style="margin:0"><div id="host" style="display:flex;flex-direction:column"></div></body></html>`
  );
  await tab.addScriptTag({ content: js });

  const out = process.env.SIDE_FILE_STRIP_OUT;
  if (out) mkdirSync(out, { recursive: true });
  const report = [];
  for (const strip of ['file', 'changes-pane'])
    for (const width of [280, 430])
      for (const files of [2, 5, 8])
        for (const changes of [true, false])
          for (const inline of [false, true]) {
            const name = `${strip} ${width}px, ${files} files${changes ? ' + Changes' : ''}${inline ? ', inline action' : ''}`;
            await t.test(name, async () => {
              await tab.evaluate(
                (options, panel) => {
                  document.getElementById('host').style.width = `${panel}px`;
                  window.__render(options);
                },
                { strip, files, changes, inline },
                width
              );
              // The strip's resize observer reveals the active tab and marks its fades.
              await tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
              const geometry = await tab.evaluate(readStrip);
              if (out) {
                report.push({ name, ...geometry });
                await tab.screenshot({ path: join(out, `${name.replace(/[^\w]+/g, '-')}.png`), clip: { x: 0, y: 0, width, height: 48 } });
              }
              assert.deepEqual(errors, []);
              assert.equal(geometry.tabs.length, files + (changes ? 1 : 0));
              assert.ok(
                geometry.stripRight <= geometry.actionLeft + 0.5,
                `strip ends at ${geometry.stripRight}, the first action starts at ${geometry.actionLeft}`
              );
              for (const cell of geometry.tabs) {
                assert.ok(cell.iconShown, `${cell.name}: its icon is gone`);
                assert.ok(cell.glyphsInside, `${cell.name}: an icon is cut inside its tab`);
                if (cell.active) assert.ok(cell.closeShown, `${cell.name}: the selected tab lost its X`);
                // At its floor a long name keeps "image-1a" on the selected tab (136px, X kept) and
                // "imag" on another (88px, X dropped below 104px), the Visualize strip's rungs.
                if (cell.name.startsWith('image-'))
                  assert.ok(
                    cell.readable >= (cell.active ? 8 : 4),
                    `${cell.name}: ${cell.readable} characters readable at ${cell.width}px`
                  );
                assert.ok(cell.labelInside, `${cell.name}: the label runs past its tab`);
                if (cell.cut) assert.ok(cell.ellipsis, `${cell.name}: cut without an ellipsis`);
                if (cell.crossesStart) assert.ok(geometry.fadeStart, `${cell.name}: hard cut at the strip's start`);
                if (cell.crossesEnd) assert.ok(geometry.fadeEnd, `${cell.name}: hard cut at the strip's end`);
              }
              if (geometry.overflow > 0) {
                // Scrolling only once every tab is down to its floor, the selected one in view, the edge faded.
                assert.ok(
                  geometry.tabs.every((cell) => cell.width <= (cell.active ? 136.5 : 88.5)),
                  `scrolls before the floors: ${geometry.tabs.map((cell) => cell.width).join(', ')}`
                );
                if (strip === 'file') assert.ok(geometry.tabs.find((cell) => cell.active).visible, 'the open file is in view');
                assert.ok(geometry.masked && (geometry.fadeStart || geometry.fadeEnd), 'a scrolling edge fades');
              } else {
                assert.ok(!geometry.fadeStart && !geometry.fadeEnd && !geometry.masked, 'a strip that fits does not fade');
              }
            });
          }
  if (out) writeFileSync(join(out, 'geometry.json'), JSON.stringify(report, null, 1));
});
