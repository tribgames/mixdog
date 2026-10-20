import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// New-session (draft) screen on a phone: the context chips (Project, Workflow,
// Delegation, Branch) take a line of their own above the two-row card, whose
// bottom row holds the +, the model picker, the mic and send. At 360-430px the
// chips used to share one non-wrapping line with the model picker, squeezed
// over each other.
const select = (cls, label) => `<div class="mx-select-root route-select ${cls}">
  <button type="button" class="mx-select-trigger"><span class="mx-select-value">${label}</span><svg width="12" height="12"></svg></button></div>`;
const chips = `<div class="composer-project-context" id="c-project"><svg width="14" height="14"></svg>
    <div class="mx-select-root context-pill-select project-context-select">
      <button type="button" class="mx-select-trigger"><span class="mx-select-value">mixdog-project</span><svg width="12" height="12"></svg></button></div></div>
  <div class="composer-route-workflow" id="c-workflow">${select('workflow-context-select', 'Default workflow')}</div>
  <div class="composer-route-workflow" id="c-delegation">${select('context-pill-select orchestration-mode-select', 'Collaborative')}</div>
  <div class="composer-branch-context" id="c-branch"><button type="button" class="branch-chip-trigger">
    <svg width="14" height="14"></svg><span class="branch-chip-label">feature/long-branch-name</span></button></div>`;

test('new-session phone layout: chips above the card, model in the card row, nothing overlaps', async (t) => {
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents:
        '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./desktop/composer-add-menu.css"; @import "./agent-chat.css";',
    },
    outfile: 'new-session-mobile.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 800 });
  await page.setContent(`<!doctype html><html data-mixdog-mobile-tabs><body style="margin:0">
    <main class="workspace" style="width:100vw;height:700px">
      <section class="conversation" style="height:700px;justify-content:flex-end">
        <div class="composer-region">
        <div class="composer-context-line"><div class="composer-model-line-context">${chips}</div></div>
        <form class="composer" data-phone-card>
          <div class="composer-input-row"><textarea rows="1" aria-label="Message"></textarea></div>
          <div class="composer-footer"><button type="button" class="composer-tool">+</button>
            <span class="composer-model-line-controls"><div class="route-controls"><div class="route-editor">
              <button type="button" class="model-trigger"><span>Claude Opus 4.7</span></button></div></div></span>
            <span class="composer-primary-actions"><button type="button" class="send-button">↑</button></span>
          </div>
        </form>
        <div class="composer-model-line"></div></div>
      </section>
    </main>
  </body></html>`);
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  for (const width of [360, 390, 430]) {
    await t.test(`${width}px`, async () => {
      await page.setViewport({ width, height: 800 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await page.evaluate(() => {
        const boxes = ['#c-project', '#c-workflow', '#c-delegation', '#c-branch', '.model-trigger'].map((selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
        const overlaps = [];
        for (let a = 0; a < boxes.length; a += 1) {
          for (let b = a + 1; b < boxes.length; b += 1) {
            const x = Math.min(boxes[a].right, boxes[b].right) - Math.max(boxes[a].left, boxes[b].left);
            const y = Math.min(boxes[a].bottom, boxes[b].bottom) - Math.max(boxes[a].top, boxes[b].top);
            if (x > 0.5 && y > 0.5) overlaps.push(`${boxes[a].selector} x ${boxes[b].selector}`);
          }
        }
        // A chip squeezed below its trigger paints the trigger over its neighbours.
        const squeezed = boxes
          .slice(0, 4)
          .filter(({ selector }) => {
            const chip = document.querySelector(selector);
            const box = chip.getBoundingClientRect();
            return [...chip.querySelectorAll('button')].some((button) => {
              const inner = button.getBoundingClientRect();
              return inner.left < box.left - 0.5 || inner.right > box.right + 0.5 || inner.width < 24;
            });
          })
          .map((box) => box.selector);
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        const context = box('.composer-context-line');
        const input = box('.composer-input-row');
        const plus = box('.composer-tool');
        const model = box('.model-trigger');
        const send = box('.send-button');
        const centre = (rect) => (rect.top + rect.bottom) / 2;
        return {
          overlaps,
          squeezed,
          // The chips line may scroll sideways; the line itself and the card's row stay on screen.
          outside: [
            ['.composer-context-line', context],
            ['.model-trigger', model],
            ['.send-button', send],
          ]
            .filter(([, rect]) => rect.left < -0.5 || rect.right > innerWidth + 0.5)
            .map(([selector]) => selector),
          contextAboveCard: context.bottom <= input.top + 0.5,
          oneRow: Math.abs(centre(plus) - centre(model)) < 2 && Math.abs(centre(model) - centre(send)) < 2,
          rowUnderInput: model.top >= input.bottom - 0.5,
          modelAfterPlus: model.left >= plus.right - 0.5 && model.right <= send.left + 0.5,
          boxes,
        };
      });
      assert.deepEqual(result.overlaps, [], JSON.stringify(result.boxes));
      assert.deepEqual(result.squeezed, [], JSON.stringify(result.boxes));
      assert.deepEqual(result.outside, [], JSON.stringify(result.boxes));
      assert.ok(result.contextAboveCard, 'the pickers line sits above the card');
      assert.ok(result.rowUnderInput && result.oneRow, '+, model and send share the row under the typing band');
      assert.ok(result.modelAfterPlus, 'the model sits right after the +, before send');
    });
  }
});
