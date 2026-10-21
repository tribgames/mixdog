// Skin surfaces in a real Chrome against the app's own bundled stylesheets:
// every surface whose text sits directly on a plate token (the inverted
// buttons, pills, the island, both bubbles) keeps 4.5:1 on every skin x plate
// x theme x transparency, with and without an imported theme; Mixy's bubbles
// keep their own size under a skin; the pane ladder sees the pane's width in
// a single pane and in a split.
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { installTestDom } from './test-support/test-dom.mjs';
import { appStyles, measureIds, paintState, QA_THEME, transcriptMarkdownProbe } from './test-support/app-styles.mjs';
import { resolveTheme, parseThemeFile } from './appearance/theme-file';
import { themeStyleText } from './appearance/theme-tokens';
import { DEFAULT_TRANSPARENCY } from './skin-color';
import { SKIN_MANIFEST } from './skin-manifest';

/* An approval card (approval-prompt.tsx markup): docked in the composer
   island (desktop, and the phone sheet under data-mixdog-mobile-tabs) as a
   payment, whose allow button is always the danger tone, or floating /
   held in the pane, narrow enough that its buttons stack. */
const approval = (id) => `
  <section class="approval-prompt" data-tone="danger" data-approval="payment">
    <div class="approval-prompt-top"><span class="approval-queue" id="${id}-queue">1 of 2</span><span class="approval-corner" id="${id}-corner">4:59 left</span></div>
    <h3 class="approval-title" id="${id}-title">Proceed with this payment?</h3>
    <div class="approval-who"><span class="approval-chip"><span class="approval-chip-name" id="${id}-who">Mixy</span></span><span class="approval-service" id="${id}-service">shop</span></div>
    <div class="approval-preview"><div class="approval-amount"><b id="${id}-amount">₩23,100</b><small id="${id}-merchant">ACME Store · KRW</small></div></div>
    <div class="approval-buttons" data-count="2" style="--approval-columns: 2">
      <button type="button" class="approval-button" id="${id}-deny"><span class="approval-button-label">Deny</span></button>
      <button type="button" class="approval-button" data-tone="danger" id="${id}-allow"><span class="approval-button-label">Allow payment</span></button>
    </div>
  </section>`;
const APPROVAL_SURFACES = ['queue', 'corner', 'title', 'who', 'service', 'amount', 'merchant', 'deny', 'allow'];

const TRANSCRIPT = transcriptMarkdownProbe('turn');

const PAGE = `
  <div class="app-shell" id="shell">
    <div class="desktop-body">
      <aside class="workbench-side-panel" data-side="left">
        <button type="button" class="mixy-empty-create" id="mixy-create">Create representative bot</button>
        <div class="starter-guide">
          <div class="starter-guide-pill">
            <button type="button" class="starter-guide-toggle"><span class="starter-guide-title" id="starter-title">Getting started</span></button>
          </div>
        </div>
      </aside>
      <main class="main-panel">
        <div class="conversation">
          <article class="message user"><div class="message-body" id="user-bubble">hello</div></article>
          ${TRANSCRIPT.html}
          <div class="composer-island"><span class="composer-island-seg" id="island">main · 1 file · Create PR</span></div>
          <div class="composer-island-slot"><div class="composer-island" data-mode="approval"><div class="composer-island-approval">${approval('docked')}</div></div></div>
          <div style="width: 360px">${approval('floating')}</div>
          <!-- agent-chat-row.tsx: row > column > line > the row's part (article) + time. -->
          <div class="mx-chat-row" data-side="agent" data-first="true" data-last="true">
            <div class="mx-chat-column"><div class="mx-chat-line"><article class="message assistant settled"><div class="message-body" id="agent-bubble">Done.</div></article><time class="mx-chat-time">11:18 AM</time></div></div>
          </div>
          <div class="mx-chat-row" data-side="user" data-first="true" data-last="true">
            <div class="mx-chat-column"><div class="mx-chat-line"><article class="message user settled"><div class="message-body" id="agent-user">thanks</div></article><time class="mx-chat-time">11:19 AM</time></div></div>
          </div>
        </div>
      </main>
    </div>
  </div>`;

const SURFACES = [
  'mixy-create',
  'starter-title',
  'user-bubble',
  'island',
  'agent-bubble',
  'agent-user',
  ...TRANSCRIPT.ids,
  ...['docked', 'floating'].flatMap((card) => APPROVAL_SURFACES.map((part) => `${card}-${part}`)),
];

test('skin surfaces: inverted ink, bubble size, pane-width queries', async (t) => {
  installTestDom(t, { actEnvironment: false });
  const { skinVars } = await import('./desktop-skin');
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setContent(
    `<!doctype html><html><head><style>${await appStyles()}</style></head><body>${PAGE}</body></html>`
  );
  await page.addStyleTag({
    content: 'body::before { background-image: none !important; } * { transition: none !important; }',
  });

  const paint = (state) => paintState(page, state);
  const measure = (underlay) => measureIds(page, SURFACES, underlay);

  /** What must not depend on skin or theme: a payment's allow keeps the
      danger fill (stacked or docked), and the bot chat's bubbles hug their
      one word on one line. */
  const shape = () =>
    page.evaluate(() => {
      const probe = document.createElement('i');
      document.querySelector('.approval-buttons').append(probe);
      probe.style.backgroundColor = 'var(--mx-danger-bg)';
      const danger = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const box = (id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      return {
        danger,
        allow: ['docked-allow', 'floating-allow'].map(
          (id) => getComputedStyle(document.getElementById(id)).backgroundColor
        ),
        stacked:
          document.getElementById('floating-allow').getBoundingClientRect().top !==
          document.getElementById('floating-deny').getBoundingClientRect().top,
        agent: box('agent-bubble'),
        user: box('agent-user'),
      };
    });

  const parsed = parseThemeFile(QA_THEME);
  assert.ok(parsed.ok);
  const failures = [];
  const shapes = [];
  let combos = 0;
  const check = async (label, state, underlay) => {
    await paint(state);
    combos++;
    for (const [id, probe] of Object.entries(await measure(underlay))) {
      if (probe.ratio < 4.5) failures.push(`${label} ${id} ${probe.ratio} (${probe.ink} on ${probe.background})`);
    }
    shapes.push({ label, ...(await shape()) });
  };
  for (const theme of ['dark', 'light']) {
    for (const themeSheet of [null, themeStyleText(resolveTheme(parsed.theme, theme))]) {
      for (const phone of [false, true]) {
        const tag = `${phone ? 'phone ' : ''}${theme}${themeSheet ? '+theme' : ''}`;
        await check(`${tag} no skin`, { theme, themeSheet, phone });
        for (const skin of SKIN_MANIFEST) {
          for (const plate of ['light', 'dark', 'tint']) {
            for (const transparency of [DEFAULT_TRANSPARENCY, 100]) {
              const vars = skinVars(
                skin.id,
                { outerTransparency: transparency, mainTransparency: transparency, plate, accent: null },
                theme
              );
              await check(
                `${tag} ${skin.id}/${plate}@${transparency}`,
                { theme, themeSheet, skin: skin.id, plate, vars, phone },
                skin.picture
              );
            }
          }
        }
      }
    }
  }

  await t.test(
    'text on every plate surface holds 4.5:1 with no skin and on every skin, plate, theme and imported theme',
    () => {
      assert.equal(combos, 2 * 2 * 2 * (1 + SKIN_MANIFEST.length * 3 * 2));
      assert.deepEqual(failures, []);
    }
  );

  await t.test("a payment's allow button is the danger fill everywhere, docked and stacked", () => {
    for (const { label, danger, allow, stacked } of shapes) {
      assert.ok(stacked, `${label}: the narrow card stacks its buttons`);
      assert.deepEqual(allow, [danger, danger], label);
    }
  });

  await t.test("the bot chat's one-word bubbles keep one line and their no-skin size", () => {
    const [plain] = shapes;
    assert.ok(plain.agent.height < 60 && plain.user.height < 60, JSON.stringify(plain));
    for (const { label, agent, user } of shapes) {
      assert.deepEqual({ agent, user }, { agent: plain.agent, user: plain.user }, label);
    }
  });

  await t.test('the reported pairs: Dark + Glass flow, White + Night city', async () => {
    const glass = SKIN_MANIFEST.find((skin) => skin.id === 'glass-flow');
    await paint({
      theme: 'dark',
      skin: glass.id,
      plate: 'light',
      vars: skinVars(
        glass.id,
        {
          outerTransparency: DEFAULT_TRANSPARENCY,
          mainTransparency: DEFAULT_TRANSPARENCY,
          plate: 'light',
          accent: null,
        },
        'dark'
      ),
    });
    const dark = await measure(glass.picture);
    assert.ok(dark['mixy-create'].ratio >= 4.5, JSON.stringify(dark['mixy-create']));
    // The phone's docked approval sheet (area E: dark sheet, dark text).
    await paint({
      theme: 'dark',
      skin: glass.id,
      plate: 'light',
      phone: true,
      vars: skinVars(
        glass.id,
        {
          outerTransparency: DEFAULT_TRANSPARENCY,
          mainTransparency: DEFAULT_TRANSPARENCY,
          plate: 'light',
          accent: null,
        },
        'dark'
      ),
    });
    const phone = await measure(glass.picture);
    for (const id of ['docked-title', 'docked-amount', 'docked-deny', 'docked-allow']) {
      assert.ok(phone[id].ratio >= 4.5, `${id} ${JSON.stringify(phone[id])}`);
    }
    const night = SKIN_MANIFEST.find((skin) => skin.id === 'night-city');
    await paint({
      theme: 'light',
      skin: night.id,
      plate: 'dark',
      vars: skinVars(
        night.id,
        {
          outerTransparency: DEFAULT_TRANSPARENCY,
          mainTransparency: DEFAULT_TRANSPARENCY,
          plate: 'dark',
          accent: null,
        },
        'light'
      ),
    });
    const light = await measure(night.picture);
    for (const id of ['user-bubble', 'starter-title', 'island'])
      assert.ok(light[id].ratio >= 4.5, `${id} ${JSON.stringify(light[id])}`);
  });

  await t.test("Mixy's short bubble keeps its no-skin size under a skin", async () => {
    const size = () =>
      page.evaluate(() => {
        const box = document.getElementById('agent-bubble').getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height) };
      });
    await paint({ theme: 'light' });
    const plain = await size();
    const night = SKIN_MANIFEST.find((skin) => skin.id === 'night-city');
    await paint({
      theme: 'dark',
      skin: night.id,
      plate: 'dark',
      vars: skinVars(
        night.id,
        {
          outerTransparency: DEFAULT_TRANSPARENCY,
          mainTransparency: DEFAULT_TRANSPARENCY,
          plate: 'dark',
          accent: null,
        },
        'dark'
      ),
    });
    const skinned = await size();
    assert.ok(plain.height < 60, JSON.stringify(plain));
    assert.deepEqual(skinned, plain);
  });

  await t.test('the pane ladder queries the pane in a single pane and in a split', async () => {
    const night = SKIN_MANIFEST.find((skin) => skin.id === 'night-city');
    await paint({
      theme: 'dark',
      skin: night.id,
      plate: 'dark',
      vars: skinVars(
        night.id,
        {
          outerTransparency: DEFAULT_TRANSPARENCY,
          mainTransparency: DEFAULT_TRANSPARENCY,
          plate: 'dark',
          accent: null,
        },
        'dark'
      ),
    });
    const probe = (wrap, width) =>
      page.evaluate(
        ({ wrap, width }) => {
          const host = document.createElement('div');
          host.style.cssText = `display:flex;width:${width}px;height:600px`;
          const cell = `<div class="pane-cell is-focused"><div class="workspace"><div class="conversation"></div><div class="schedules-page" id="qa-schedules"></div></div></div>`;
          host.innerHTML =
            wrap === 'single'
              ? `<div class="main-panel" style="flex:1;display:flex">${cell}</div>`
              : `<div class="main-panel" style="flex:1;display:flex"><div class="pane-split" style="display:flex;flex:1"><div class="pane-leaf">${cell}</div></div></div>`;
          document.body.append(host);
          const out = {
            schedules: getComputedStyle(document.getElementById('qa-schedules')).paddingLeft,
          };
          host.remove();
          return out;
        },
        { wrap, width }
      );
    for (const wrap of ['single', 'split']) {
      assert.deepEqual(await probe(wrap, 1195), { schedules: '32px' }, `${wrap} wide`);
      assert.deepEqual(await probe(wrap, 900), { schedules: '32px' }, `${wrap} mid`);
      assert.deepEqual(await probe(wrap, 600), { schedules: '16px' }, `${wrap} narrow`);
    }
  });
});
