import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import puppeteer from 'puppeteer-core';

// Execute the production palette functions without starting Monaco workers or
// a PTY. Their DOM/CSS reads still run in Chromium against the actual stylesheet.
async function paletteDeclarations(file, names) {
  const source = ts.createSourceFile(
    file,
    await readFile(new URL(file, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  return source.statements
    .filter(
      (node) =>
        (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) ||
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((declaration) => names.includes(declaration.name.getText(source))))
    )
    .map((node) => node.getText(source))
    .join('\n');
}

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, 'palette colors must be opaque');
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('theme palettes, panel surfaces and italic labels remain readable in dark and white', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <div class="markdown"><em id="emphasis">한글 English emphasis</em></div>
    <div class="workspace-tab preview"><div class="workspace-tab-main"><span id="preview">Preview</span></div></div>
    <div class="dock-pr-row" data-draft><div class="dock-pr-row-label"><b id="draft">Draft PR</b></div></div>
    <pre class="markdown-code"><code class="hljs-emphasis" id="code">code emphasis</code></pre>
    <span id="regular">Regular label</span>
  `);
  for (const file of [
    './ui/tokens.css',
    './desktop/01-tokens.css',
    './desktop/03-titlebar.css',
    './desktop/05-shell.css',
    './desktop/06-activity-rail.css',
    './desktop/09-sidebar-chrome.css',
    './desktop/10-rail-pages.css',
    './desktop/11-sidebar-usage.css',
    './desktop/12-transcript.css',
    './desktop/13-tool-cards.css',
    './desktop/17-settings.css',
    './desktop/22-markdown.css',
    './desktop/25-scm-dock.css',
    './desktop/28-usage-explorer.css',
    './desktop/30-dialogs.css',
    './settings/settings.css',
  ]) {
    await page.addStyleTag({ content: await readFile(new URL(file, import.meta.url), 'utf8') });
  }
  const declarations = await Promise.all([
    paletteDeclarations('./TerminalPane.tsx', ['cssVar', 'terminalTheme']),
    paletteDeclarations('./monaco-setup.ts', [
      'themeColorProbe',
      'colorProbe',
      'channelHex',
      'alphaHex',
      'resolveThemeColor',
      'withAlpha',
      'currentMonacoColors',
    ]),
  ]);
  const { outputText } = ts.transpileModule(declarations.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  await page.addScriptTag({
    content: `{ const exports = {}; ${outputText}
      window.themeFixture = { terminalTheme, currentMonacoColors };
    }`,
  });
  const samples = [];
  // Return to dark as well: changing the app palette must not recolor a
  // dark terminal or leave an editor selection on its previous palette.
  for (const theme of ['dark', 'light', 'dark']) {
    samples.push(
      await page.evaluate((theme) => {
        document.documentElement.dataset.mixdogTheme = theme;
        return {
          theme,
          terminal: window.themeFixture.terminalTheme(),
          editor: window.themeFixture.currentMonacoColors(theme === 'light'),
          labels: ['emphasis', 'preview', 'draft', 'code', 'regular'].map((id) => {
            const style = getComputedStyle(document.getElementById(id));
            return {
              id,
              fontStyle: style.fontStyle,
              synthesisStyle: style.fontSynthesisStyle,
              synthesisWeight: style.fontSynthesisWeight,
            };
          }),
        };
      }, theme)
    );
  }

  await t.test('terminal text and cursor keep contrast on the permanent dark canvas', () => {
    for (const { theme, terminal } of samples) {
      assert.ok(contrast(terminal.foreground, terminal.background) >= 4.5, theme);
      assert.equal(terminal.cursor, terminal.foreground);
      assert.equal(terminal.cursorAccent, terminal.background);
      assert.deepEqual(terminal, samples[0].terminal);
    }
  });
  await t.test('editor menu selections use readable ink on a distinct opaque surface', () => {
    for (const { theme, editor } of samples) {
      assert.equal(editor['editor.background'], theme === 'light' ? '#fcfcfc' : '#111113');
      assert.ok(contrast(editor['menu.selectionForeground'], editor['menu.selectionBackground']) >= 4.5, theme);
      assert.notEqual(editor['menu.selectionBackground'], editor['menu.background']);
      assert.equal(editor['menu.selectionForeground'], editor['menu.foreground']);
    }
    assert.notEqual(samples[0].editor['menu.selectionBackground'], samples[1].editor['menu.selectionBackground']);
  });
  await t.test('emphasis and preview labels allow italics without synthetic bold', () => {
    for (const { labels } of samples) {
      for (const label of labels) {
        assert.equal(label.fontStyle, label.id === 'regular' ? 'normal' : 'italic', label.id);
        assert.equal(label.synthesisStyle, 'auto', label.id);
        assert.equal(label.synthesisWeight, 'none', label.id);
      }
    }
  });
  await t.test('light chrome is neutral and secondary text remains readable on every regular surface', async () => {
    const palette = await page.evaluate(() => {
      document.documentElement.dataset.mixdogTheme = 'light';
      const style = getComputedStyle(document.documentElement);
      const value = (name) => style.getPropertyValue(`--mx-${name}`).trim();
      return {
        inks: ['text', 'text-muted'].map(value),
        surfaces: [
          'bg-deep',
          'window-band',
          'workspace-sheet',
          'bg-base',
          'bg-layer-1',
          'bg-layer-2',
          'bg-layer-3',
        ].map(value),
      };
    });
    for (const color of [...palette.inks, ...palette.surfaces]) {
      assert.match(color, /^#[0-9a-f]{6}$/i);
      const channels = color.slice(1).match(/../g);
      assert.equal(channels[0], channels[1], color);
      assert.equal(channels[1], channels[2], color);
    }
    for (const ink of palette.inks) {
      for (const surface of palette.surfaces) {
        assert.ok(contrast(ink, surface) >= 4.5, `${ink} on ${surface}`);
      }
    }
    assert.ok(luminance(palette.surfaces[1]) < luminance(palette.surfaces[2]), 'sidebar sits under the reading canvas');
    assert.ok(
      luminance(palette.surfaces[2]) < luminance(palette.surfaces[3]),
      'popups and the prompt card sit above it'
    );
  });
  await t.test('native Mica connects the frame and sidebar while documents and right docks stay opaque', async () => {
    await page.evaluate(() => {
      document.documentElement.dataset.windowMaterial = 'mica';
      document.body.insertAdjacentHTML(
        'beforeend',
        `
        <div class="app-shell">
          <header class="topbar" id="mica-titlebar"></header>
          <div class="desktop-body">
            <nav class="activity-rail" id="mica-rail"></nav>
            <aside class="workbench-side-panel" data-side="left" id="mica-sidebar">
              <div class="workbench-side-panel-content" id="mica-sidebar-content">
                <div class="sidebar session-sidebar" id="mica-sidebar-list"></div>
              </div>
            </aside>
            <main class="main-panel" id="mica-main">
              <div class="pane-surface-handoff-layer" id="mica-handoff"></div>
              <aside class="pane-side-dock" id="mica-dock">
                <div class="workbench-side-panel"></div>
              </aside>
            </main>
          </div>
        </div>
      `
      );
    });
    for (const [theme, dock, workspace, frame] of [
      ['dark', 'rgb(24, 24, 27)', 'rgb(17, 17, 19)', [0, 0, 0, 0]],
      ['light', 'rgb(247, 247, 247)', 'rgb(252, 252, 252)', [247, 247, 247, 128]],
      ['dark', 'rgb(24, 24, 27)', 'rgb(17, 17, 19)', [0, 0, 0, 0]],
    ]) {
      const surfaces = await page.evaluate((theme) => {
        document.documentElement.dataset.mixdogTheme = theme;
        const sidebar = getComputedStyle(document.getElementById('mica-sidebar'));
        // Normalize color-mix and rgba serialization to the same RGBA sample.
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const rgba = (color) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        return {
          frame: rgba(getComputedStyle(document.body).backgroundColor),
          sidebar: { rgba: rgba(sidebar.backgroundColor), opacity: sidebar.opacity },
          panels: ['mica-main', 'mica-dock', 'mica-handoff'].map((id) => {
            const style = getComputedStyle(document.getElementById(id));
            return { id, background: style.backgroundColor, opacity: style.opacity };
          }),
          chrome: ['mica-titlebar', 'mica-rail', 'mica-sidebar-content', 'mica-sidebar-list'].map(
            (id) => getComputedStyle(document.getElementById(id)).backgroundColor
          ),
        };
      }, theme);
      assert.equal(surfaces.frame[3], frame[3]);
      // Dark keeps its opaque sidebar; paper lets 5% of native Mica through.
      const expectedSidebar = theme === 'light' ? [252, 252, 252, 240] : [24, 24, 27, 255];
      assert.equal(surfaces.sidebar.rgba[3], expectedSidebar[3]);
      // Reading back an 8-bit premultiplied canvas rounds RGB by up to two
      // steps at half alpha.
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(Math.abs(surfaces.frame[channel] - frame[channel]) <= 2);
        assert.ok(Math.abs(surfaces.sidebar.rgba[channel] - expectedSidebar[channel]) <= 2);
      }
      if (theme === 'light') {
        const nativeTransmission = (1 - surfaces.frame[3] / 255) * (1 - surfaces.sidebar.rgba[3] / 255);
        // 8-bit alpha quantization moves the product by a few thousandths.
        assert.ok(Math.abs(nativeTransmission - 0.03) < 0.005, 'only 3% of native Mica reaches the wide panel');
      }
      assert.equal(surfaces.sidebar.opacity, '1');
      for (const panel of surfaces.panels) {
        const background = panel.id === 'mica-dock' ? dock : workspace;
        assert.equal(panel.background, background, `${theme}: ${panel.id}`);
        assert.equal(panel.opacity, '1', theme);
      }
      assert.ok(
        surfaces.chrome.every((color) => color === 'rgba(0, 0, 0, 0)'),
        JSON.stringify(surfaces.chrome)
      );
    }
  });
  await t.test('folding the sidebar transfers its seam to the rail without a double main-panel edge', async () => {
    // The seam corners belong to narrow windows; wider ones use the joined
    // sheet from pane-layout.css, which this page does not load.
    const viewport = page.viewport();
    await page.setViewport({ width: 760, height: 600 });
    try {
      for (const theme of ['light', 'dark']) {
        for (const collapsed of [false, true, false]) {
          const seam = await page.evaluate(
            ({ theme, collapsed }) => {
              document.documentElement.dataset.mixdogTheme = theme;
              document.querySelector('.app-shell').classList.toggle('sidebar-collapsed', collapsed);
              document.getElementById('mica-sidebar').style.display = collapsed ? 'none' : '';
              const rail = getComputedStyle(document.getElementById('mica-rail'));
              const panel = getComputedStyle(document.getElementById('mica-main'));
              const sidebar = getComputedStyle(document.getElementById('mica-sidebar'));
              return {
                color: rail.borderRightColor,
                expected: getComputedStyle(document.documentElement).getPropertyValue('--mx-border-structure').trim(),
                width: rail.borderRightWidth,
                shadow: panel.boxShadow,
                corner: panel.borderTopLeftRadius,
                sidebarCorner: sidebar.borderTopLeftRadius,
                sidebarShadow: sidebar.boxShadow,
              };
            },
            { theme, collapsed }
          );
          assert.equal(seam.width, '1px');
          assert.equal(seam.color, collapsed ? seam.expected : 'rgba(0, 0, 0, 0)');
          assert.match(seam.shadow, /0px 1px 0px 0px inset$/);
          assert.equal(seam.corner, collapsed ? '8px' : '0px');
          assert.equal(seam.sidebarCorner, '8px');
          assert.match(seam.sidebarShadow, /1px 1px 0px 0px inset$/);
        }
      }
    } finally {
      await page.setViewport(viewport);
    }
  });
  await t.test('without native Mica both panels stay opaque in their theme tones', async () => {
    await page.evaluate(() => {
      delete document.documentElement.dataset.windowMaterial;
    });
    for (const [theme, sidebar, workspace] of [
      ['dark', 'rgb(24, 24, 27)', 'rgb(17, 17, 19)'],
      ['light', 'rgb(252, 252, 252)', 'rgb(252, 252, 252)'],
    ]) {
      const colors = await page.evaluate((theme) => {
        document.documentElement.dataset.mixdogTheme = theme;
        return ['mica-sidebar', 'mica-main'].map((id) => getComputedStyle(document.getElementById(id)).backgroundColor);
      }, theme);
      assert.deepEqual(colors, [sidebar, workspace]);
    }
  });
  await t.test('icons and all usage meter states keep contrast in the rail and popup', async () => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `
        <nav class="activity-rail" id="contrast-rail"><button id="contrast-icon" style="transition:none">○</button></nav>
        <div id="contrast-popup"></div>
      `
      );
      for (const tone of ['', 'tone-warning', 'tone-danger']) {
        document
          .getElementById('contrast-rail')
          .insertAdjacentHTML(
            'beforeend',
            `<div class="rail-usage-pin-brand ${tone}"><i><i></i></i><small>71%</small></div>`
          );
        document
          .getElementById('contrast-popup')
          .insertAdjacentHTML('beforeend', `<div class="sidebar-usage-meter ${tone}"><i><i></i></i><b>71%</b></div>`);
      }
    });
    for (const theme of ['light', 'dark']) {
      const colors = await page.evaluate((theme) => {
        document.documentElement.dataset.mixdogTheme = theme;
        const root = getComputedStyle(document.documentElement);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        // Composite nested alpha fills over their track, not directly over
        // the page. A meter's track remains underneath its filled segment.
        const composite = (color, background) => {
          context.fillStyle = background;
          context.fillRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return (
            '#' +
            [...context.getImageData(0, 0, 1, 1).data]
              .slice(0, 3)
              .map((value) => value.toString(16).padStart(2, '0'))
              .join('')
          );
        };
        const frame = root.getPropertyValue('--mx-window-band').trim();
        const popup = root.getPropertyValue('--mx-bg-base').trim();
        const icon = document.getElementById('contrast-icon');
        const idle = composite(getComputedStyle(icon).color, frame);
        icon.classList.add('is-active');
        const tile = composite(getComputedStyle(icon, '::before').backgroundColor, frame);
        const selected = composite(getComputedStyle(icon).color, tile);
        icon.classList.remove('is-active');
        const meters = [
          ...document.querySelectorAll('#contrast-rail .rail-usage-pin-brand, #contrast-popup .sidebar-usage-meter'),
        ].map((element) => {
          const surface = element.closest('#contrast-rail') ? frame : popup;
          const track = composite(getComputedStyle(element.querySelector(':scope > i')).backgroundColor, surface);
          const fill = composite(getComputedStyle(element.querySelector('i > i')).backgroundColor, track);
          const text = composite(getComputedStyle(element.querySelector('small, b')).color, surface);
          return { name: element.className, surface, track, fill, text };
        });
        return { frame, idle, tile, selected, meters };
      }, theme);
      assert.ok(contrast(colors.idle, colors.frame) >= 3, `${theme}: idle icon`);
      assert.ok(contrast(colors.selected, colors.tile) >= 3, `${theme}: selected icon`);
      assert.notEqual(colors.idle, colors.selected);
      for (const meter of colors.meters) {
        assert.ok(contrast(meter.fill, meter.track) >= 3, `${theme}: ${meter.name} fill`);
        assert.ok(contrast(meter.text, meter.surface) >= 4.5, `${theme}: ${meter.name} text`);
      }
    }
  });
  await t.test('item containers are hairline frames in both themes; selections stay filled', async () => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `
        <div class="sidebar-usage-row" id="item-usage"></div>
        <div class="session-sidebar"><div class="session-row selected" id="item-selected" style="transition:none"></div></div>
        <div class="message user"><div class="message-body" id="item-bubble"></div></div>
      `
      );
    });
    for (const theme of ['light', 'dark']) {
      const items = await page.evaluate((theme) => {
        document.documentElement.dataset.mixdogTheme = theme;
        const root = getComputedStyle(document.documentElement);
        const read = (id, pseudo) => {
          const style = getComputedStyle(document.getElementById(id), pseudo);
          return { background: style.backgroundColor, shadow: style.boxShadow };
        };
        return {
          popup: root.getPropertyValue('--mx-popup-bg').trim(),
          base: root.getPropertyValue('--mx-bg-base').trim(),
          cards: [read('item-usage', '::before'), read('item-selected'), read('item-bubble')],
        };
      }, theme);
      const [usage, selected, bubble] = items.cards;
      for (const frame of [usage]) {
        assert.equal(frame.background, 'rgba(0, 0, 0, 0)', theme);
        assert.match(frame.shadow, /0px 0px 0px 1px inset/, theme);
      }
      assert.notEqual(selected.background, 'rgba(0, 0, 0, 0)', theme);
      assert.notEqual(bubble.background, 'rgba(0, 0, 0, 0)', theme);
      assert.deepEqual([selected.shadow, bubble.shadow], ['none', 'none'], theme);
      if (theme === 'light') {
        assert.deepEqual([selected.background, bubble.background], ['rgb(230, 230, 230)', 'rgb(238, 238, 238)']);
      }
      assert.equal(items.popup, items.base, 'popups use the base plate');
    }
  });
  await t.test('windows share one grammar in both themes: framed cards, unbanded tables, filled controls', async () => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `
        <div id="paper-window">
          <i id="paper-tone"></i>
          <aside class="mixdog-settings__rail" id="paper-rail"></aside>
          <div class="settings-group-body" id="paper-group"></div>
          <div class="usage-table-shell" id="paper-table">
            <table class="usage-table"><thead><tr><th id="paper-th">A</th></tr></thead>
              <tbody class="stats-provider"><tr class="stats-provider-row"><td id="paper-group-row">B</td></tr></tbody>
            </table>
            <nav class="quota-history-pager" id="paper-pager"></nav>
          </div>
          <section class="stats-trend" id="paper-chart"></section>
          <button class="stats-range" id="paper-range" style="transition:none">7D</button>
          <button class="stats-range is-active" id="paper-range-active" style="transition:none">30D</button>
          <button class="stats-period-arrow" id="paper-arrow" style="transition:none">‹</button>
          <div class="tool-panel" id="paper-tool"><div class="tool-section-header" id="paper-tool-head"></div></div>
          <div class="notice" id="paper-notice"></div>
          <div class="markdown"><table><tr><th id="paper-md-th">C</th></tr></table></div>
        </div>
      `
      );
    });
    const read = (theme) =>
      page.evaluate((theme) => {
        document.documentElement.dataset.mixdogTheme = theme;
        const probe = document.getElementById('paper-tone');
        const tone = (name) => {
          probe.style.color = `var(--mx-${name})`;
          return getComputedStyle(probe).color;
        };
        const elements = Object.fromEntries(
          [
            'paper-rail',
            'paper-group',
            'paper-table',
            'paper-th',
            'paper-group-row',
            'paper-pager',
            'paper-chart',
            'paper-range',
            'paper-range-active',
            'paper-arrow',
            'paper-tool',
            'paper-tool-head',
            'paper-notice',
            'paper-md-th',
          ].map((id) => {
            const style = getComputedStyle(document.getElementById(id));
            return [
              id,
              {
                bg: style.backgroundColor,
                color: style.color,
                shadow: style.boxShadow,
                border: `${style.borderTopWidth} ${style.borderTopColor}`,
                right: `${style.borderRightWidth} ${style.borderRightColor}`,
              },
            ];
          })
        );
        return {
          elements,
          tones: Object.fromEntries(
            ['bg-base', 'window-band', 'workspace-sheet', 'hover', 'text', 'border-muted', 'surface-plate'].map(
              (name) => [name, tone(name)]
            )
          ),
        };
      }, theme);
    const clear = 'rgba(0, 0, 0, 0)';
    for (const theme of ['light', 'dark']) {
      const { elements: paper, tones } = await read(theme);
      // Containers: no plate, one hairline frame.
      for (const id of ['paper-group', 'paper-chart', 'paper-tool', 'paper-notice']) {
        assert.equal(paper[id].bg, clear, `${theme}: ${id}`);
        assert.match(paper[id].shadow, /0px 0px 0px 1px/, `${theme}: ${id}`);
      }
      // The table card's frame is a real border so its opaque header and
      // rows cannot paint over it.
      assert.equal(paper['paper-table'].bg, clear, theme);
      assert.equal(paper['paper-table'].shadow, 'none', theme);
      assert.equal(paper['paper-table'].border, `1px ${tones['border-muted']}`, theme);
      // Tables: no banded fills; the sticky header takes the dialog surface.
      assert.equal(paper['paper-th'].bg, tones['bg-base'], theme);
      for (const id of ['paper-group-row', 'paper-pager']) {
        assert.equal(paper[id].bg, clear, `${theme}: ${id}`);
      }
      // Markdown table headers share the code block's neutral header band.
      assert.equal(paper['paper-md-th'].bg, tones['surface-plate'], theme);
      // Settings nav: one band step plus one hairline.
      assert.equal(paper['paper-rail'].bg, tones['window-band'], theme);
      assert.equal(paper['paper-rail'].right, `1px ${tones['border-muted']}`, theme);
      // Sticky tool header takes the canvas tone, not a grey band.
      assert.equal(paper['paper-tool-head'].bg, tones['workspace-sheet'], theme);
      // Controls: flat fills without an outline; the chosen chip inverts.
      for (const id of ['paper-range', 'paper-arrow']) {
        assert.equal(paper[id].bg, tones.hover, `${theme}: ${id}`);
        assert.equal(paper[id].border, '1px rgba(0, 0, 0, 0)', `${theme}: ${id}`);
      }
      assert.equal(paper['paper-range-active'].bg, tones.text, theme);
      assert.equal(paper['paper-range-active'].color, tones['bg-base'], theme);
    }
    await page.evaluate(() => document.getElementById('paper-window').remove());
  });
  t.diagnostic(
    JSON.stringify(
      samples.slice(0, 2).map(({ theme, terminal, editor }) => ({
        theme,
        terminalContrast: Number(contrast(terminal.foreground, terminal.background).toFixed(2)),
        menuSelectionContrast: Number(
          contrast(editor['menu.selectionForeground'], editor['menu.selectionBackground']).toFixed(2)
        ),
      }))
    )
  );
});
