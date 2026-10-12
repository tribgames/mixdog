import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The phone composer must stay above the soft keyboard in both delivery modes:
// the Android shell resizes the WebView (layout AND visual viewport shrink),
// while iOS WKWebView keeps the layout viewport and only shrinks/pans the
// visual one. Exactly one of the two applies, so neither may double the offset.
const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };
const WIDTH = 412;
const FULL = 900;
const KEYBOARD = 360;

const PAGE = `<!doctype html><html data-mixdog-mobile-tabs style="--mx-device-scale:1"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content">
  </head><body><div id="root"><div class="app-shell"><div class="desktop-body"><main class="workspace">
    <section class="conversation">
      <div class="transcript">${'<p>message</p>'.repeat(80)}<p id="latest">latest</p></div>
      <div class="composer-region"><form class="composer">
        <div class="composer-input-row"><textarea rows="1" aria-label="Message"></textarea></div>
        <div class="composer-footer"><button type="button" class="send-button">↑</button></div>
      </form></div>
    </section>
  </main></div></div></div></body></html>`;

test('phone composer follows the keyboard-shrunk viewport without a double offset', async (t) => {
  const [styles, script] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./mobile-web-runtime.css";',
      },
      outfile: 'mobile-keyboard.css',
      bundle: true,
      write: false,
      loader,
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'ts',
        contents: 'import { installShellViewport } from "./shell-viewport"; window.__installShellViewport = installShellViewport;',
      },
      bundle: true,
      format: 'iife',
      write: false,
    }),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());

  const open = async (stubVisualViewport) => {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: FULL, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.setContent(PAGE);
    await page.addStyleTag({ content: styles.outputFiles[0].text });
    await page.evaluate((stub) => {
      if (stub) {
        // iOS-style keyboard: the visual viewport is a separate, pannable frame.
        const visual = new EventTarget();
        Object.assign(visual, { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
      }
    }, stubVisualViewport);
    await page.addScriptTag({ content: script.outputFiles[0].text });
    await page.evaluate(() => {
      window.__installShellViewport();
      const transcript = document.querySelector('.transcript');
      transcript.scrollTop = transcript.scrollHeight;
    });
    return page;
  };
  const settle = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measure = (page) =>
    page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const transcript = document.querySelector('.transcript');
      transcript.scrollTop = transcript.scrollHeight;
      return {
        body: { top: rect('body').top, bottom: rect('body').bottom },
        composer: rect('.composer').bottom,
        region: { top: rect('.composer-region').top, bottom: rect('.composer-region').bottom },
        transcript: { top: rect('.transcript').top, bottom: rect('.transcript').bottom },
        latest: rect('#latest').bottom,
      };
    });
  const assertFrame = (geometry, top, bottom) => {
    assert.equal(Math.round(geometry.body.top), top, 'body starts at the visible top');
    assert.equal(Math.round(geometry.body.bottom), bottom, 'body ends at the visible bottom (one offset only)');
    assert.equal(Math.round(geometry.region.bottom), bottom, 'composer region sits on the visible bottom');
    assert.ok(geometry.composer <= bottom && geometry.composer > bottom - 64, 'composer is above the keyboard');
    // The composer island floats over the transcript's tail reserve, so the
    // scroller itself must end on the visible bottom: its pinned last row then
    // lands right above the composer instead of behind the keyboard.
    assert.equal(Math.round(geometry.transcript.top), top, 'transcript starts at the visible top');
    assert.equal(Math.round(geometry.transcript.bottom), bottom, 'transcript ends on the visible bottom');
    assert.ok(geometry.latest <= bottom && geometry.latest > top, 'latest message stays inside the visible frame');
  };

  await t.test('Android shell: the WebView itself shrinks to the keyboard', async () => {
    const page = await open(false);
    await settle(page);
    const resting = await measure(page);
    assertFrame(resting, 0, FULL);
    await page.setViewport({ width: WIDTH, height: FULL - KEYBOARD, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await settle(page);
    assertFrame(await measure(page), 0, FULL - KEYBOARD);
    await page.setViewport({ width: WIDTH, height: FULL, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await settle(page);
    assert.deepEqual(await measure(page), resting, 'closing the keyboard restores the resting frame');
    await page.close();
  });

  await t.test('iOS WKWebView: only the visual viewport shrinks and pans', async () => {
    const page = await open(true);
    await settle(page);
    const resting = await measure(page);
    assertFrame(resting, 0, FULL);
    const pan = 120;
    const setVisual = (height, offsetTop) =>
      page.evaluate(
        (height, offsetTop) => {
          Object.assign(window.visualViewport, { height, offsetTop });
          window.visualViewport.dispatchEvent(new Event('resize'));
          window.visualViewport.dispatchEvent(new Event('scroll'));
        },
        height,
        offsetTop
      );
    await setVisual(FULL - KEYBOARD, pan);
    await settle(page);
    assertFrame(await measure(page), pan, pan + FULL - KEYBOARD);
    await setVisual(FULL, 0);
    await settle(page);
    assert.deepEqual(await measure(page), resting, 'closing the keyboard restores the resting frame');
    await page.close();
  });
});
