import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

test('compact chrome preserves input growth, readable rows and accessible actions', async (t) => {
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./desktop/composer-add-menu.css";',
    },
    outfile: 'compact-chrome.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
    // Headless Linux Chrome reports no mouse (hover: none); declare one so the
    // hover-gated rules under test are evaluated the same on every runner.
    args: ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.setContent(`<!doctype html><html><body>
    <main class="workspace" style="width:700px;height:400px">
      <section class="conversation" style="height:400px">
        <div class="composer-region"><form class="composer">
          <div class="composer-input-row"><textarea rows="1" aria-label="Message"></textarea></div>
          <div class="composer-footer"><button type="button" class="composer-tool">+</button>
            <button type="button" class="model-trigger">Model</button>
            <span class="composer-primary-actions"><button type="button" class="send-button">↑</button></span>
          </div>
        </form></div>
      </section>
    </main>
    <aside class="utility-dock" style="position:absolute;left:740px;top:0;width:252px;height:400px">
      <section class="agent-activity-page">
        <section class="workflows-models">
          <div class="workflows-section-head"><button class="agent-session-heading">Session</button>
            <div class="row-overflow"><button class="row-overflow-trigger" aria-expanded="false">Actions</button></div>
          </div>
          <div class="schedules-list">
            <button class="schedules-row agent-pool-row">
              <span class="sidebar-resource-icon">○</span>
              <span class="schedules-row-copy"><span class="agent-pool-heading">
                <b class="agent-pool-name">Long agent name that must not push the clock away</b></span>
                <small>Model with a long supporting description</small></span>
              <span class="agent-activity-status"><span class="agent-activity-elapsed" data-state="running">12m 34s</span></span>
            </button>
          </div>
        </section>
      </section>
    </aside>
    <div class="row-overflow-menu" style="position:absolute;left:740px;top:450px;width:220px">
      <button type="button">Menu item</button>
    </div>
    <div class="transcript-virtual-row-content" data-tag="UserMessage" id="question"></div>
    <div class="transcript-virtual-row-content" data-tag="AssistantPart" id="answer"></div>
    <div class="transcript-turn-gap" id="turn-gap"></div>
    <div class="message-body" id="prose">한글 English</div>
  </body></html>`);
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  const settle = () => page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));

  for (const theme of ['light', 'dark']) {
    await t.test(`${theme}: compact input grows without moving controls or overflowing narrow panes`, async () => {
      await page.evaluate((theme) => { document.documentElement.dataset.mixdogTheme = theme; }, theme);
      for (const width of [700, 340]) {
        await page.evaluate((width) => {
          document.querySelector('.workspace').style.width = `${width}px`;
          document.querySelector('textarea').value = '';
        }, width);
        await settle();
        const resting = await page.evaluate(() => {
          const form = document.querySelector('.composer');
          const textarea = form.querySelector('textarea');
          const rect = form.getBoundingClientRect();
          const footer = form.querySelector('.composer-footer').getBoundingClientRect();
          return {
            height: rect.height,
            inputHeight: textarea.getBoundingClientRect().height,
            footerHeight: footer.height,
            overflow: form.scrollWidth > form.clientWidth,
            controlsFit: [...form.querySelectorAll('button')].every((button) => {
              const box = button.getBoundingClientRect();
              return box.left >= rect.left && box.right <= rect.right && box.bottom <= rect.bottom;
            }),
          };
        });
        assert.equal(resting.height, 96);
        assert.equal(resting.inputHeight, 56);
        assert.equal(resting.footerHeight, 40);
        assert.equal(resting.overflow, false);
        assert.equal(resting.controlsFit, true);
        await page.evaluate(() => { document.querySelector('textarea').value = '한글 English\n'.repeat(20); });
        await settle();
        const expanded = await page.evaluate(() => ({
          form: document.querySelector('.composer').getBoundingClientRect().height,
          input: document.querySelector('textarea').getBoundingClientRect().height,
          scrolls: document.querySelector('textarea').scrollHeight > document.querySelector('textarea').clientHeight,
        }));
        assert.equal(expanded.input, 180);
        assert.equal(expanded.form, 220);
        assert.equal(expanded.scrolls, true);
      }
    });
  }

  await t.test('row metadata aligns with the title and long labels cannot widen the sidebar', async () => {
    const row = await page.evaluate(() => {
      const element = document.querySelector('.agent-pool-row');
      const name = element.querySelector('.schedules-row-copy').getBoundingClientRect();
      const clock = element.querySelector('.agent-activity-elapsed').getBoundingClientRect();
      const pane = document.querySelector('.utility-dock').getBoundingClientRect();
      return {
        topDifference: Math.abs((name.top + name.bottom) / 2 - (clock.top + clock.bottom) / 2),
        right: clock.right,
        paneRight: pane.right,
        radius: getComputedStyle(element).borderRadius,
        gap: getComputedStyle(element.querySelector('.schedules-row-copy')).gap,
      };
    });
    assert.ok(row.topDifference <= 1);
    assert.ok(row.right <= row.paneRight);
    assert.equal(row.radius, '10px');
    assert.equal(row.gap, '2px');
  });

  await t.test('secondary actions remain available by hover, keyboard and open-menu state', async () => {
    const client = await page.createCDPSession();
    assert.equal(await page.evaluate(() => matchMedia('(hover: hover)').matches), true);
    await page.mouse.move(1100, 850);
    const opacity = () => page.$eval('.row-overflow-trigger', (element) => getComputedStyle(element).opacity);
    assert.equal(await opacity(), '0');
    await page.hover('.workflows-section-head');
    assert.equal(await opacity(), '1');
    await page.mouse.move(1100, 850);
    await page.focus('.row-overflow-trigger');
    assert.equal(await opacity(), '1');
    await page.$eval('.row-overflow-trigger', (element) => {
      element.blur();
      element.setAttribute('aria-expanded', 'true');
    });
    assert.equal(await opacity(), '1');
    await page.$eval('.row-overflow-trigger', (element) => element.setAttribute('aria-expanded', 'false'));
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await settle();
    assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true);
    assert.equal(await opacity(), '1');
    await client.detach();
  });

  await t.test('conversation spacing and menus have distinct compact and touch rhythms', async () => {
    const desktop = await page.evaluate(() => {
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        question: style('#question').paddingBottom,
        answer: style('#answer').paddingBottom,
        turnGap: style('#turn-gap').height,
        font: style('#prose').fontSize,
        line: style('#prose').lineHeight,
        menu: document.querySelector('.row-overflow-menu > button').getBoundingClientRect().height,
      };
    });
    assert.deepEqual(desktop, { question: '24px', answer: '8px', turnGap: '20px', font: '15px', line: '24px', menu: 30 });
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
      document.documentElement.style.setProperty('--mx-device-scale', '1');
      document.querySelector('textarea').value = '';
    });
    await settle();
    const mobile = await page.evaluate(() => ({
      menu: document.querySelector('.row-overflow-menu > button').getBoundingClientRect().height,
      footer: document.querySelector('.composer-footer').getBoundingClientRect().height,
      input: document.querySelector('textarea').getBoundingClientRect().height,
    }));
    assert.ok(mobile.menu >= 44);
    assert.equal(mobile.footer, 44);
    assert.equal(mobile.input, 44);
  });
});
