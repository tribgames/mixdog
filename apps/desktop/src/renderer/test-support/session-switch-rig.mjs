// Node side of the session-switch rig: bundles session-switch-harness.jsx and the app's stylesheets, and opens them in
// a real Chrome. Each page is a fresh renderer (its own lane store, identity baseline and geometry cache).
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { appStyles } from './app-styles.mjs';

const entry = fileURLToPath(new URL('./session-switch-harness.jsx', import.meta.url));
const assets = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' };

let built;
function bundle() {
  built ??= Promise.all([
    build({
      entryPoints: [entry],
      outfile: 'session-switch.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
      // Shared modules read the platform at load.
      banner: { js: 'var process = { platform: "win32", env: {}, argv: [], versions: {} };' },
      loader: { ...assets, '.css': 'empty' },
      plugins: [
        {
          name: 'worker-stub',
          setup(builder) {
            builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
              contents: 'export default class {};',
              loader: 'js',
            }));
          },
        },
      ],
    }).then((result) => result.outputFiles.find((file) => file.path.endsWith('.js')).text),
    appStyles(),
  ]);
  return built;
}

const PAGE =
  '<!doctype html><html><head><style>html,body{height:100%;margin:0}</style></head><body>' +
  '<div class="app-shell"><div class="desktop-body"><main class="workspace">' +
  '<div id="root" style="display:contents"></div></main></div></div></body></html>';

/** The caller closes it. */
export function launchSwitchBrowser() {
  return puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
}

/** A fresh renderer showing one pane with a New Task draft. `run(fn, ...args)` evaluates in the page, where `rig` is
 *  the harness (`core`, `ws`, `view`, `frames`, `settle`, `wheel`). */
export async function openSwitchPage(browser, { width = 1180, height = 820 } = {}) {
  const [script, styles] = await bundle();
  // A profile of its own: what the app keeps across windows (the chat text size a case set) is not what an earlier case
  // left.
  const profile = await browser.createBrowserContext();
  const page = await profile.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.stack ?? error).split('\n').slice(0, 4).join(' <- ')));
  await page.setViewport({ width, height });
  // A real origin: stores that persist (font settings, panel state) refuse an opaque one.
  await page.setRequestInterception(true);
  page.on('request', (request) => request.respond({ contentType: 'text/html', body: PAGE }));
  await page.goto('http://mixdog.test/');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.waitForSelector('.pane-cell', { timeout: 10_000 }).catch((error) => {
    throw new Error(`the workspace did not mount: ${errors.join('\n') || error.message}`);
  });
  const run = (fn, ...args) => page.evaluate(fn, ...args);
  await run(() => window.rig.settle());
  /** What every pane paints in each of `count` frames, `act(rig)` running in the first and `at[k](rig)` in the k-th,
   *  then once more when the panes have come to rest by their own signals (the last entry; `rest: false` leaves it
   *  out, for a case that ends with a request still unanswered). Each entry is one view per pane. */
  const frames = (act, { count = 12, at = {}, rest = true } = {}) =>
    run(
      async (source, total, later, settles) => {
        const call = (code) => new Function('rig', `return (${code})(rig)`)(window.rig);
        const hooks = Object.fromEntries(Object.entries(later).map(([frame, code]) => [frame, () => call(code)]));
        const painted = await window.rig.frames(total, () => call(source), hooks);
        if (!settles) return painted;
        await window.rig.settle();
        return [...painted, window.rig.view()];
      },
      act.toString(),
      count,
      Object.fromEntries(Object.entries(at).map(([frame, code]) => [frame, code.toString()])),
      rest
    );
  /** `act(rig)` in the page, then the views once the panes are at rest. */
  const act = async (fn, ...args) => {
    await run(fn, ...args);
    return run(async () => {
      await window.rig.settle();
      return window.rig.view();
    });
  };
  return { page, errors, run, frames, act, close: () => profile.close() };
}

/** One pane's view in every frame of `frames`. */
export const paneFrames = (frames, pane = 'pane-1') => frames.map((frame) => frame.find((view) => view.pane === pane));

/** The row keys a session of `turns` finished turns shows, oldest first (session-switch-harness.jsx `core.seed`). */
export function seededKeys(id, turns, { tools = 0 } = {}) {
  const keys = [];
  for (let n = 1; n <= turns; n += 1) {
    if (n > 1) keys.push(`${id}:gap:${id}-u${n}`);
    keys.push(`${id}:${id}-u${n}`);
    if (tools > 0) keys.push(`${id}:${id}-t${n}.0:tool-activity`);
    keys.push(`${id}:${id}-r${n}`);
  }
  return keys;
}
