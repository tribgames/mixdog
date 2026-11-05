// Real Chromium owns the layout: jsdom cannot see a shrunk flex item paint its
// unclipped text over the next one, which made two status texts read as one
// overlaid line (#326).
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const rendererDir = fileURLToPath(new URL('.', import.meta.url));

// Electron needs a display server; the Linux CI lanes have none, so the probe runs where a desktop exists.
const headlessLinux = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

// The report's geometry: a ~391px transcript column at UI scale 1.15, Korean,
// a turn quiet for two minutes with its clock and token count running.
const PROBE = `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import i18n from './i18n';
import ko from './locales/ko.json';
import { LiveActivity } from './transcript-status';

(window as any).runLiveActivityProbe = async (widths: number[]) => {
  i18n.addResourceBundle('ko', 'translation', ko);
  await i18n.changeLanguage('ko');
  document.documentElement.style.setProperty('--mx-ui-scale', '1.15');
  const now = Date.now();
  const snapshot = {
    busy: true,
    spinner: {
      active: true,
      mode: 'requesting',
      startedAt: now - 275_000,
      outputTokens: 12_400,
      quiet: { since: now - 150_000, wait: 'model', warnMs: 0 },
    },
  };
  const results = [];
  for (const width of widths) {
    const host = document.createElement('div');
    host.style.width = width + 'px';
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(<LiveActivity snapshot={snapshot as any} />));
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const row = host.querySelector('.live-activity-status')!;
    const items = [...row.children]
      .filter((element) => element.textContent!.trim())
      .map((element) => {
        const box = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const ink = range.getBoundingClientRect();
        return { name: element.className || element.tagName, text: element.textContent, left: box.left, top: box.top, inkRight: ink.right };
      });
    results.push({ width, columnRight: host.getBoundingClientRect().right, items });
    root.unmount();
    host.remove();
  }
  return results;
};
`;

test('the live status line never paints one item over the next while the quiet cue shows', {
  timeout: 45_000,
  skip: headlessLinux && 'no display server for Electron',
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'mixdog-live-activity-layout-'));
  try {
    const bundle = await build({
      stdin: { contents: PROBE, loader: 'tsx', resolveDir: rendererDir, sourcefile: 'live-activity-probe.tsx' },
      outfile: join(scratch, 'entry.js'),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    assert.equal(bundle.errors.length, 0);
    const links = [
      require.resolve('pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'),
      ...['font-faces.css', 'styles.css', 'desktop.css'].map((name) => join(rendererDir, name)),
    ]
      .map((path) => `<link rel="stylesheet" href="${pathToFileURL(path).href}">`)
      .join('\n');
    await writeFile(
      join(scratch, 'index.html'),
      `<!doctype html><html lang="ko"><head><meta charset="utf-8">${links}</head><body><script src="./entry.js"></script></body></html>`
    );
    await writeFile(
      join(scratch, 'main.cjs'),
      `
      const { app, BrowserWindow } = require("electron");
      const { writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      app.setPath("userData", join(__dirname, "profile"));
      app.disableHardwareAcceleration();
      app.whenReady().then(async () => {
        const win = new BrowserWindow({
          show: false, width: 1000, height: 600,
          webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false },
        });
        await win.loadFile(join(__dirname, "index.html"));
        const results = await win.webContents.executeJavaScript("window.runLiveActivityProbe([391, 300])");
        writeFileSync(join(__dirname, "result.json"), JSON.stringify(results));
        win.destroy();
        app.quit();
      }).catch((error) => { console.error(error); app.exit(1); });
    `
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [join(scratch, 'main.cjs')], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: t.signal,
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-8_000);
      });
    }
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, output);
    const results = JSON.parse(await readFile(join(scratch, 'result.json'), 'utf8'));
    assert.equal(results.length, 2);
    for (const { width, columnRight, items } of results) {
      const layout = JSON.stringify(items);
      assert.ok(items.some((item) => /live-activity-quiet/.test(item.name)), `${width}px: no quiet cue: ${layout}`);
      for (const [index, item] of items.entries()) {
        assert.ok(item.inkRight <= columnRight + 0.5, `${width}px: ${item.name} runs past the column: ${layout}`);
        const next = items[index + 1];
        if (!next || Math.abs(next.top - item.top) > 2) continue;
        assert.ok(item.inkRight <= next.left + 0.5, `${width}px: ${item.name} paints over ${next.name}: ${layout}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
