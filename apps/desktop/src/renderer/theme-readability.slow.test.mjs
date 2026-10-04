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
  const channels = hex.slice(1).match(/../g).map((channel) => {
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
    './desktop/01-tokens.css',
    './desktop/03-titlebar.css',
    './desktop/06-activity-rail.css',
    './desktop/09-sidebar-chrome.css',
    './desktop/10-rail-pages.css',
    './desktop/22-markdown.css',
    './desktop/25-scm-dock.css',
    './desktop/28-usage-explorer.css',
  ]) {
    await page.addStyleTag({ content: await readFile(new URL(file, import.meta.url), 'utf8') });
  }
  const declarations = await Promise.all([
    paletteDeclarations('./TerminalPane.tsx', ['cssVar', 'terminalTheme']),
    paletteDeclarations('./monaco-setup.ts', [
      'themeColorProbe', 'colorProbe', 'channelHex', 'alphaHex', 'resolveThemeColor', 'withAlpha', 'currentMonacoColors',
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
    samples.push(await page.evaluate((theme) => {
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
    }, theme));
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
      assert.equal(editor['editor.background'], theme === 'light' ? '#f8f8fb' : '#111113');
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
  await t.test('dark Mica frames a deeper workspace while white surfaces stay unchanged', async () => {
    await page.evaluate(() => {
      document.documentElement.dataset.windowMaterial = 'mica';
      document.body.insertAdjacentHTML('beforeend', `
        <div class="app-shell">
          <header class="topbar" id="mica-titlebar"></header>
          <div class="desktop-body">
            <nav class="activity-rail" id="mica-rail"></nav>
            <aside class="workbench-side-panel" data-side="left" id="mica-sidebar">
              <div class="sidebar session-sidebar"></div>
            </aside>
            <main class="main-panel" id="mica-main">
              <div class="pane-surface-handoff-layer" id="mica-handoff"></div>
              <aside class="pane-side-dock" id="mica-dock">
                <div class="workbench-side-panel"></div>
              </aside>
            </main>
          </div>
        </div>
      `);
    });
    for (const [theme, sidebar, workspace, frame] of [
      ['dark', 'rgb(24, 24, 27)', 'rgb(17, 17, 19)', 'rgba(0, 0, 0, 0)'],
      ['light', 'rgb(247, 247, 250)', 'rgb(247, 247, 250)', 'rgba(243, 243, 243, 0.5)'],
      ['dark', 'rgb(24, 24, 27)', 'rgb(17, 17, 19)', 'rgba(0, 0, 0, 0)'],
    ]) {
      const surfaces = await page.evaluate((theme) => {
        document.documentElement.dataset.mixdogTheme = theme;
        return {
          frame: getComputedStyle(document.body).backgroundColor,
          panels: ['mica-sidebar', 'mica-main', 'mica-dock', 'mica-handoff'].map((id) => {
            const style = getComputedStyle(document.getElementById(id));
            return { id, background: style.backgroundColor, opacity: style.opacity };
          }),
          chrome: ['mica-titlebar', 'mica-rail'].map((id) =>
            getComputedStyle(document.getElementById(id)).backgroundColor
          ),
        };
      }, theme);
      assert.equal(surfaces.frame, frame);
      for (const panel of surfaces.panels) {
        const background = ['mica-main', 'mica-handoff'].includes(panel.id) ? workspace : sidebar;
        assert.equal(panel.background, background, `${theme}: ${panel.id}`);
        assert.equal(panel.opacity, '1', theme);
      }
      assert.deepEqual(surfaces.chrome, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
    }
  });
  t.diagnostic(JSON.stringify(samples.slice(0, 2).map(({ theme, terminal, editor }) => ({
    theme,
    terminalContrast: Number(contrast(terminal.foreground, terminal.background).toFixed(2)),
    menuSelectionContrast: Number(contrast(editor['menu.selectionForeground'], editor['menu.selectionBackground']).toFixed(2)),
  }))));
});
