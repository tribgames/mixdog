import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

test('Studio reserves the session dock frame and fade as the draft grows at any pane width', async () => {
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents: `
        @import "./font-faces.css";
        @import "./ui/tokens.css";
        @import "./styles.css";
        @import "./desktop.css";
        @import "./pane-layout.css";
        @import "./pane-side-dock-bottom.css";
        @import "./mobile-web-runtime.css";
        @import "./agent-chat.css";
      `,
    },
    outfile: 'studio-composer-layout.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    external: ['*.jpg', '*.png', '*.webp'],
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 2500, height: 800 });
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    // Bootstrap and the session geometry harness load styles before mounting.
    // Styling an already painted form starts its shadow transition from none.
    await page.addStyleTag({ content: result.outputFiles[0].text });
    await page.addStyleTag({
      content: '.fixture { position:absolute; top:0; height:700px; display:flex; flex-direction:column; }',
    });
    await page.evaluate(() => {
      document.documentElement.dataset.mixdogTheme = 'dark';
      document.body.innerHTML = `
      <div class="workspace fixture" id="session">
        <section class="conversation">
          <div class="transcript-shell"><div class="transcript"><div style="height:1800px"></div></div></div>
          <div class="composer-region">
            <form class="composer"><div class="composer-input-row"><textarea rows="1"></textarea></div></form>
            <div class="composer-model-line"><button>Model</button></div>
          </div>
        </section>
      </div>
      <div class="studio-root fixture" id="studio">
        <div class="studio-pane"><div class="studio-shell">
          <div class="studio-stage-host">
            <div class="studio-results"><div class="last-tile" style="height:1800px"></div></div>
          </div>
          <div class="studio-dock">
            <div class="studio-composer"><div class="studio-composer-bar"><textarea rows="1"></textarea></div></div>
            <div class="studio-composer-controls"><button class="studio-board-trigger">Board</button>
              <span class="studio-composer-controls-gap"></span><button class="studio-model-trigger">Model</button></div>
          </div>
        </div></div>
      </div>
      `;
    });
    const cases = ['dark', 'light'].flatMap((theme) => [390, 840, 1200].map((width) => ({ theme, width })));
    for (const { theme, width } of cases) {
      await page.evaluate(async (theme) => {
        document.documentElement.dataset.mixdogTheme = theme;
        // Theme changes legitimately animate; compare the settled app state.
        document.body.getBoundingClientRect();
        await document.fonts.ready;
        await Promise.all(document.getAnimations().map((animation) => animation.finished));
      }, theme);
      let singleLine;
      for (const lines of [1, 5]) {
        const geometry = await page.evaluate(
          ({ width, lines }) => {
            for (const id of ['session', 'studio']) {
              const root = document.getElementById(id);
              root.style.width = `${width}px`;
              root.style.left = id === 'session' ? '0px' : `${width + 16}px`;
              root.querySelector('textarea').value = Array(lines).fill('A draft line').join('\n');
            }
            const measure = (id, shellSelector, scrollSelector, dockSelector, cardSelector, controlsSelector) => {
              const root = document.getElementById(id);
              const shell = root.querySelector(shellSelector);
              const scroll = root.querySelector(scrollSelector);
              const dock = root.querySelector(dockSelector);
              const card = root.querySelector(cardSelector);
              const controls = root.querySelector(controlsSelector);
              scroll.scrollTop = scroll.scrollHeight;
              const bounds = (node) => node.getBoundingClientRect();
              const fade = getComputedStyle(shell, '::after');
              return {
                viewportBottom: bounds(scroll).bottom,
                viewportHeight: bounds(scroll).height,
                dockTop: bounds(dock).top,
                dockBottom: bounds(dock).bottom,
                paneBottom: bounds(root).bottom,
                cardTopGap: bounds(card).top - bounds(dock).top,
                cardLeft: bounds(card).left - bounds(root).left,
                cardWidth: bounds(card).width,
                cardHeight: bounds(card).height,
                controlsGap: bounds(controls).top - bounds(card).bottom,
                floorGap: bounds(root).bottom - bounds(controls).bottom,
                radius: getComputedStyle(card).borderRadius,
                bottomBorder: getComputedStyle(card).borderBottom,
                shadow: getComputedStyle(card).boxShadow,
                background: getComputedStyle(card).backgroundColor,
                fadeBottom: parseFloat(fade.bottom),
                fadeHeight: parseFloat(fade.height),
                fadeBackground: fade.backgroundImage,
                fadeZ: Number(fade.zIndex),
                dockZ: Number(getComputedStyle(dock).zIndex),
                tailGap: id === 'studio' ? bounds(dock).top - bounds(root.querySelector('.last-tile')).bottom : null,
              };
            };
            return {
              session: measure(
                'session',
                '.transcript-shell',
                '.transcript',
                '.composer-region',
                '.composer',
                '.composer-model-line'
              ),
              studio: measure(
                'studio',
                '.studio-stage-host',
                '.studio-results',
                '.studio-dock',
                '.studio-composer',
                '.studio-composer-controls'
              ),
            };
          },
          { width, lines }
        );
        const { session, studio } = geometry;
        const label = `${theme} / ${width}px / ${lines} lines`;
        assert.equal(studio.viewportBottom, studio.dockTop, `${label}: gallery ends above the dock, not behind it`);
        assert.equal(studio.dockBottom, studio.paneBottom, `${label}: dock stays inside the pane`);
        for (const key of [
          'cardTopGap',
          'cardLeft',
          'cardWidth',
          'cardHeight',
          'controlsGap',
          'floorGap',
          'radius',
          'bottomBorder',
          'shadow',
          'background',
          'fadeBottom',
          'fadeHeight',
          'fadeBackground',
          'dockZ',
        ]) {
          assert.equal(studio[key], session[key], `${label}: ${key} matches the session`);
        }
        assert.ok(studio.fadeZ < studio.dockZ, `${label}: fade cannot cover the input edge`);
        assert.notEqual(session.shadow, 'none', `${label}: the themed reference has a shadow`);
        assert.equal(studio.tailGap, session.fadeHeight, `${label}: the final tile clears the fade`);
        assert.ok(studio.floorGap > 0, `${label}: controls and bottom edge are not clipped`);
        if (lines === 1) singleLine = studio;
        else {
          assert.ok(studio.cardHeight > singleLine.cardHeight, `${label}: real textarea growth is exercised`);
          assert.equal(
            singleLine.viewportHeight - studio.viewportHeight,
            studio.cardHeight - singleLine.cardHeight,
            `${label}: draft growth takes its own room from the gallery`
          );
        }
      }
    }
  } finally {
    await browser.close();
  }
});
