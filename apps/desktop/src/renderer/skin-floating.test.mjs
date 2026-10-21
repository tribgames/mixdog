// Floating surfaces (dialogs, sheets, popovers, menus, tooltips, toasts, the
// composer's status pill) in a real Chrome against the app's own bundled
// stylesheets. Two contracts on every theme x skin x plate x imported theme:
// each one's text holds 4.5:1 on its own background, and each one takes ONE
// tone with the window: the skin's plate tone when a skin is on (the shell,
// the dialogs portaled to <body> and the popovers in the shell alike), the
// theme's otherwise. A dark settings panel over a light-plated shell, or a
// popover painting the theme's dark paper under the plate's dark ink, fails.
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { installTestDom } from './test-support/test-dom.mjs';
import { appStyles, measureIds, paintState, QA_THEME, transcriptMarkdownProbe } from './test-support/app-styles.mjs';
import { resolveTheme, parseThemeFile } from './appearance/theme-file';
import { themeStyleText } from './appearance/theme-tokens';
import { DEFAULT_TRANSPARENCY } from './skin-color';
import { SKIN_MANIFEST } from './skin-manifest';

/* Each surface's markup as its component renders it (class names from the
   .tsx), with the texts the probe reads tagged by id. Dialog layers,
   menus, tooltips and toasts are portaled to <body> (outside .app-shell);
   the rail's usage flyout, the composer pill and a pane dialog live in the
   shell. */
const TRANSCRIPT = transcriptMarkdownProbe('message');

const SHELL = `
  <div class="app-shell" id="shell">
    <div class="desktop-body">
      <nav class="activity-rail">
        <div class="rail-usage-popup" data-state="open" style="--rail-usage-popup-bottom: 48px; width: 340px">
          <section class="sidebar-usage">
            <header class="sidebar-usage-heading session-panel-header"><span class="session-panel-title" id="usage-title">Providers</span></header>
            <div class="sidebar-usage-content"><div class="sidebar-usage-list">
              <div class="sidebar-usage-row"><span class="sidebar-usage-line"><span class="sidebar-usage-provider-icon"></span><b id="usage-provider">Claude</b></span>
                <span class="sidebar-usage-meters"><span class="sidebar-usage-meter"><small id="usage-window">5H</small><i><i style="width: 42%"></i></i><b id="usage-percent">42%</b><em id="usage-reset-at">2h 10m</em></span></span>
                <div class="sidebar-usage-credit"><small id="usage-credits">Credits</small><span class="sidebar-usage-credit-value"><b id="usage-credit-value">$12.40</b><small class="sidebar-usage-credit-limit" id="usage-credit-limit"> · Monthly limit $50</small></span><button type="button" role="switch" class="sidebar-usage-credit-switch" aria-checked="false"></button></div>
                <div class="sidebar-usage-reset-credit"><div class="sidebar-usage-reset-line"><small id="usage-reset">Reset credits</small><span class="sidebar-usage-credit-value"><b id="usage-reset-left">2 left</b></span></div></div>
              </div>
            </div></div>
          </section>
        </div>
      </nav>
      <main class="main-panel">
        <div class="pane-cell" style="position: relative; width: 900px; height: 600px">
          ${TRANSCRIPT.html}
          <div class="composer-island-slot"><div class="composer-island" data-mode="pill"><div class="composer-island-pill">
            <button type="button" class="composer-island-seg" id="pill-agents">Agents 3 · Running 2</button>
            <button type="button" class="composer-island-seg composer-island-seg-branch" id="pill-branch">main</button>
            <button type="button" class="composer-island-seg turn-review-segment" id="pill-files">12 files <span class="diff-stats"><i id="pill-added">+49749</i> <em id="pill-removed">−4678</em></span></button>
            <button type="button" class="composer-island-seg" id="pill-pr">Create PR</button>
          </div></div></div>
          <div class="pane-side-dock" data-open="true" data-overlay="true" data-placement="right" id="overlay-dock"></div>
          <div class="pane-dialog-layer"><section class="schedules-dialog" role="dialog"><header><h2 id="pane-dialog-title">Session goal</h2></header>
            <form><label class="schedules-field"><span id="pane-dialog-label">Goal</span><small id="pane-dialog-help">What finishes this session.</small></label></form>
          </section></div>
        </div>
      </main>
    </div>
  </div>`;

const PORTALED = `
  <div class="mixdog-settings-layer" data-surface-active="true" style="z-index: auto">
    <section class="mixdog-settings mixdog-settings-v2" role="dialog">
      <aside class="mixdog-settings__rail"><nav><div class="mixdog-settings__rail-group">
        <button type="button" class="active" id="settings-rail-active"><span>General</span></button>
        <button type="button" id="settings-rail"><span>Skin</span></button>
      </div></nav></aside>
      <div class="mixdog-settings__panel">
        <header class="mixdog-settings__header"><div class="mixdog-settings__header-title"><h1 id="settings-title">General</h1></div></header>
        <div class="mixdog-settings__body"><div class="mixdog-settings__category-stage"><div class="capability-settings-content">
          <div class="mixdog-settings__row skin-row"><div class="mixdog-settings__copy"><span class="mixdog-settings__row-title" id="settings-row">Profile</span><span class="skin-row-desc" id="settings-desc">How Mixdog addresses you.</span></div></div>
          <p class="appearance-message" data-tone="error" id="settings-error">This file is not a Mixdog theme.</p>
          <div class="markdown"><p><a href="#x" id="settings-link">Theme format</a></p></div>
        </div></div></div>
      </div>
    </section>
  </div>
  <div class="schedules-dialog-layer">
    <section class="schedules-dialog schedules-editor-dialog" role="dialog">
      <header><h2 id="schedule-title">Edit scheduled task</h2></header>
      <form>
        <label class="schedules-field"><span id="schedule-name">Name</span><small id="schedule-help">Shown in schedule lists and notifications.</small><input id="schedule-input" value="daily-briefing"></label>
        <div class="schedules-composer"><textarea id="schedule-prompt">Summarize the inbox</textarea></div>
        <footer><button type="button" class="danger" id="schedule-delete">Delete</button><button type="button" id="schedule-run">Run now</button><button type="button" class="secondary" id="schedule-cancel">Cancel</button><button type="submit" id="schedule-save">Save</button></footer>
      </form>
    </section>
  </div>
  <div class="schedules-dialog-layer"><section class="schedules-dialog agent-create-dialog" role="dialog"><header><h2 id="agent-title">Lead appearance</h2></header><form><label class="schedules-field"><span id="agent-label">Name</span><small id="agent-help">Shown on the bot's messages.</small></label></form></section></div>
  <div class="schedules-dialog-layer"><section class="schedules-dialog workflows-dialog" role="dialog"><header><h2 id="workflow-title">Edit workflow</h2></header><form><label class="schedules-field"><span id="workflow-label">Steps</span><small id="workflow-help">Runs top to bottom.</small></label></form></section></div>
  <div class="mx-dialog-layer"><section class="mx-dialog" role="dialog"><header class="mx-dialog-header"><h2 id="mx-dialog-title">Open file?</h2></header><div class="mx-dialog-body"><p id="mx-dialog-body">It opens in the default app.</p></div></section></div>
  <ul class="sidebar-usage-reset-popover" role="dialog" style="position: fixed; top: 400px; left: 10px"><li><b id="reset-item">Reset credit 1</b><small id="reset-when">Expires in 3 days</small></li></ul>
  <div class="starter-guide-toast" style="position: fixed; top: 400px; left: 300px"><span id="starter-toast">Step done</span></div>
  <div class="settings-confirm-layer"><section class="settings-confirm-dialog" role="alertdialog"><h2 id="confirm-title">Discard changes?</h2><p id="confirm-body">Unsaved edits are lost.</p></section></div>
  <div class="settings-confirm-layer"><section class="settings-confirm-dialog skin-custom-dialog" role="dialog"><h2 id="custom-title">Custom picture</h2><p id="custom-body">Pick a picture.</p></section></div>
  <div class="settings-confirm-layer"><section class="conn-dialog" role="dialog"><h2 id="conn-title">Connect</h2><p id="conn-body">Sign in to continue.</p></section></div>
  <div class="onboarding-layer"><section class="onboarding-dialog" role="dialog"><h2 id="onboarding-title">Welcome</h2><p id="onboarding-body">Set up your first provider.</p></section></div>
  <div class="workbench-quick-access-layer"><section class="workbench-quick-access session-search" role="dialog"><div class="workbench-quick-input"><input id="search-input" value="query"></div><div class="workbench-quick-results" role="listbox"><div class="session-search-heading" id="search-heading">Sessions</div></div></section></div>
  <i id="window-tone" style="position: fixed; width: 1px; height: 1px; background: var(--mx-skin-tint)"></i>
  <div class="mx-menu" role="listbox" style="position: fixed; top: 10px; left: 10px"><div class="mx-menu-item" role="option" aria-selected="true" id="menu-selected"><span>Daily</span></div><div class="mx-menu-item" role="option" id="menu-item"><span>Weekly</span></div></div>
  <div class="row-overflow-menu usage-menu" role="menu" style="position: fixed; top: 10px; left: 220px">
    <button type="button" role="menuitem"><span class="row-overflow-label" id="context-item">Pin to rail</span></button>
    <div class="usage-menu-separator" role="separator"></div>
    <div class="usage-menu-group" id="context-group">Rail bars</div>
  </div>
  <div class="slash-palette" role="listbox" style="position: fixed; top: 10px; left: 440px"><header id="slash-header">Commands</header><button type="button" aria-selected="true" id="slash-selected"><span>/compact</span></button><button type="button" id="slash-item"><span>/model</span></button></div>
  <div class="mx-tooltip" style="position: fixed; top: 300px; left: 10px"><span class="mx-tooltip-label" id="tooltip">Open settings</span></div>
  <div class="mx-toast-region"><article class="mx-toast"><span class="mx-toast-copy" id="toast">Saved</span></article></div>`;

/** Every probed text; the prefix names its surface. */
const SURFACES = {
  'usage-popover': [
    'usage-title',
    'usage-provider',
    'usage-window',
    'usage-percent',
    'usage-reset-at',
    'usage-credits',
    'usage-credit-value',
    'usage-credit-limit',
    'usage-reset',
    'usage-reset-left',
  ],
  'transcript-message': TRANSCRIPT.ids,
  'composer-pill': ['pill-agents', 'pill-branch', 'pill-files', 'pill-added', 'pill-removed', 'pill-pr'],
  'pane-dialog': ['pane-dialog-title', 'pane-dialog-label', 'pane-dialog-help'],
  settings: [
    'settings-rail-active',
    'settings-rail',
    'settings-title',
    'settings-row',
    'settings-desc',
    'settings-error',
    'settings-link',
  ],
  'schedule-editor': [
    'schedule-title',
    'schedule-name',
    'schedule-help',
    'schedule-input',
    'schedule-prompt',
    'schedule-delete',
    'schedule-run',
    'schedule-cancel',
    'schedule-save',
  ],
  'agent-editor': ['agent-title', 'agent-label', 'agent-help'],
  'workflow-editor': ['workflow-title', 'workflow-label', 'workflow-help'],
  'mx-dialog': ['mx-dialog-title', 'mx-dialog-body'],
  'reset-popover': ['reset-item', 'reset-when'],
  'starter-toast': ['starter-toast'],
  'confirm-dialog': ['confirm-title', 'confirm-body'],
  'skin-custom-dialog': ['custom-title', 'custom-body'],
  'connection-dialog': ['conn-title', 'conn-body'],
  onboarding: ['onboarding-title', 'onboarding-body'],
  'quick-access': ['search-input', 'search-heading'],
  'select-menu': ['menu-selected', 'menu-item'],
  'context-menu': ['context-item', 'context-group'],
  'slash-menu': ['slash-header', 'slash-selected', 'slash-item'],
  tooltip: ['tooltip'],
  toast: ['toast'],
};
/** The surface's own plate (where its tone is read). */
const PLATES = {
  'usage-popover': '.rail-usage-popup',
  'composer-pill': '.composer-island',
  'pane-dialog': '.pane-dialog-layer .schedules-dialog',
  settings: '.mixdog-settings',
  'schedule-editor': '.schedules-editor-dialog',
  'agent-editor': '.agent-create-dialog',
  'workflow-editor': '.workflows-dialog',
  'mx-dialog': '.mx-dialog',
  'reset-popover': '.sidebar-usage-reset-popover',
  'starter-toast': '.starter-guide-toast',
  'confirm-dialog': '.settings-confirm-dialog:not(.skin-custom-dialog)',
  'skin-custom-dialog': '.skin-custom-dialog',
  'connection-dialog': '.conn-dialog',
  onboarding: '.onboarding-dialog',
  'quick-access': '.workbench-quick-access',
  'select-menu': '.mx-menu',
  'context-menu': '.row-overflow-menu',
  'slash-menu': '.slash-palette',
  tooltip: '.mx-tooltip',
  toast: '.mx-toast',
};
const IDS = Object.values(SURFACES).flat();
const PLATE_IDS = Object.keys(PLATES).map((name) => `plate-${name}`);
const surfaceOf = (id) => Object.keys(SURFACES).find((name) => SURFACES[name].includes(id));
/** Light and dark sides of a tone (relative luminance): the point of equal
    contrast against black and white. */
const isLight = (luminance) => luminance > 0.18;

async function openFloatingProbe(t) {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setContent(
    `<!doctype html><html><head><style>${await appStyles()}</style></head><body>${SHELL}${PORTALED}</body></html>`
  );
  // Every layer shows at once (static: no entrance animations, no scrims
  // stacking over each other), so each surface is read on its own plate.
  await page.addStyleTag({
    content: `body::before { background-image: none !important; }
      * { transition: none !important; animation: none !important; }
      :is(.mixdog-settings-layer, .schedules-dialog-layer, .settings-confirm-layer, .onboarding-layer, .workbench-quick-access-layer, .pane-dialog-layer, .mx-dialog-layer) { position: static !important; background: none !important; backdrop-filter: none !important; display: block !important; width: auto !important; height: auto !important; padding: 0 !important; }
      :is(.mixdog-settings, .schedules-dialog, .settings-confirm-dialog, .conn-dialog, .onboarding-dialog, .workbench-quick-access, .mx-dialog) { position: relative !important; height: auto !important; max-height: none !important; }`,
  });
  await page.evaluate((plates) => {
    for (const [name, selector] of Object.entries(plates)) document.querySelector(selector).id ||= `plate-${name}`;
  }, PLATES);
  return page;
}

test('floating surfaces: one tone with the window, text 4.5:1, on every theme x skin x plate', async (t) => {
  installTestDom(t, { actEnvironment: false });
  const { skinVars } = await import('./desktop-skin');
  const page = await openFloatingProbe(t);
  const parsed = parseThemeFile(QA_THEME);
  assert.ok(parsed.ok);

  await t.test('without a skin each theme keeps its own semantic inks', async () => {
    const inks = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [
            '--mx-text-accent',
            '--mx-danger',
            '--mx-danger-bg',
            '--mx-warning',
            '--mx-success',
            '--mx-merged',
            '--mx-meter-danger',
          ].map((name) => {
            const probe = document.createElement('i');
            probe.style.color = `var(${name})`;
            document.body.append(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return [name, value];
          })
        )
      );
    await paintState(page, { theme: 'dark' });
    assert.deepEqual(await inks(), {
      '--mx-text-accent': 'rgb(91, 176, 255)',
      '--mx-danger': 'rgb(255, 110, 105)',
      '--mx-danger-bg': 'rgb(74, 22, 24)',
      '--mx-warning': 'rgb(255, 181, 46)',
      '--mx-success': 'rgb(61, 220, 110)',
      '--mx-merged': 'rgb(187, 148, 250)',
      '--mx-meter-danger': 'rgb(255, 110, 105)',
    });
    await paintState(page, { theme: 'light' });
    assert.deepEqual(await inks(), {
      '--mx-text-accent': 'rgb(10, 95, 209)',
      '--mx-danger': 'rgb(200, 32, 31)',
      '--mx-danger-bg': 'rgb(253, 234, 234)',
      '--mx-warning': 'rgb(163, 82, 0)',
      '--mx-success': 'rgb(7, 117, 40)',
      '--mx-merged': 'rgb(109, 63, 196)',
      '--mx-meter-danger': 'rgb(207, 66, 73)',
    });
  });

  const unreadable = [];
  const incoherent = [];
  const translucentOverlay = [];
  /** Each surface's lowest text contrast over every combination. */
  const minima = {};
  let combos = 0;
  for (const theme of ['dark', 'light']) {
    for (const themeSheet of [null, themeStyleText(resolveTheme(parsed.theme, theme))]) {
      const tag = `${theme}${themeSheet ? '+theme' : ''}`;
      const states = [{ label: `${tag} no skin`, state: { theme, themeSheet } }];
      for (const skin of SKIN_MANIFEST) {
        for (const plate of ['light', 'dark', 'tint']) {
          for (const transparency of [DEFAULT_TRANSPARENCY, 100]) {
            states.push({
              label: `${tag} ${skin.id}/${plate}@${transparency}`,
              underlay: skin.picture,
              state: {
                theme,
                themeSheet,
                skin: skin.id,
                plate,
                vars: skinVars(
                  skin.id,
                  { outerTransparency: transparency, mainTransparency: transparency, plate, accent: null },
                  theme
                ),
              },
            });
          }
        }
      }
      for (const { label, state, underlay } of states) {
        await paintState(page, state);
        combos++;
        // The window's tone: the skin's plate when a skin is on, else the theme's.
        const tones = await measureIds(page, ['window-tone', ...PLATE_IDS], underlay);
        const windowLight = state.skin ? isLight(tones['window-tone'].light) : theme === 'light';
        for (const id of PLATE_IDS) {
          const { light, background } = tones[id];
          if (isLight(light) !== windowLight) {
            incoherent.push(`${label} ${id.slice(6)} ${background} (window ${windowLight ? 'light' : 'dark'})`);
          }
        }
        if (state.skin) {
          const overlay = await page.evaluate(
            () => getComputedStyle(document.getElementById('overlay-dock')).backgroundColor
          );
          if (/^rgba\(|\/ 0?\.\d+\)$/.test(overlay)) translucentOverlay.push(`${label} ${overlay}`);
        }
        for (const [id, probe] of Object.entries(await measureIds(page, IDS, underlay))) {
          const surface = surfaceOf(id);
          if (!(minima[surface]?.ratio <= probe.ratio)) minima[surface] = { ratio: probe.ratio, at: `${label} ${id}` };
          if (probe.ratio < 4.5)
            unreadable.push(`${label} ${surfaceOf(id)}/${id} ${probe.ratio} (${probe.ink} on ${probe.background})`);
        }
      }
    }
  }

  if (process.env.SKIN_FLOATING_REPORT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.SKIN_FLOATING_REPORT, JSON.stringify({ incoherent, unreadable, minima }, null, 1));
  }
  await t.test('every floating surface takes the window tone', () => {
    assert.equal(combos, 2 * 2 * (1 + SKIN_MANIFEST.length * 3 * 2));
    assert.deepEqual(incoherent, []);
  });
  await t.test('a dock floating over a narrow pane is opaque under every skin', () => {
    assert.deepEqual(translucentOverlay, []);
  });
  await t.test('every floating surface keeps its text 4.5:1', () => {
    assert.deepEqual(unreadable, []);
  });
});
