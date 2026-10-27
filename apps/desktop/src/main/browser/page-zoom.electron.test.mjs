import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import electron from 'electron';
import { build } from 'esbuild';

const bundled = (relativePath) =>
  build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    write: false,
  }).then(({ outputFiles }) => outputFiles[0].contents);

/** Runs the fixture as the built app lays itself out: main/ beside preload/. */
async function runFixture(softwareRendering) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-page-zoom-'));
  try {
    const [main, preload] = await Promise.all([
      bundled('./test-fixtures/page-zoom.ts'),
      bundled('../../preload/browser-page.ts'),
    ]);
    await Promise.all([mkdir(join(directory, 'main')), mkdir(join(directory, 'preload'))]);
    await Promise.all([
      writeFile(join(directory, 'main/index.cjs'), main),
      writeFile(join(directory, 'preload/browser-page.js'), preload),
    ]);
    const env = { ...process.env, PAGE_ZOOM_DIRECTORY: directory, PAGE_ZOOM_SOFTWARE: softwareRendering ? '1' : '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = await promisify(execFile)(electron, [join(directory, 'main/index.cjs')], {
      env,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }).catch((error) => error);
    const stdout = String(run.stdout ?? '');
    const evidence = `\n--- stdout ---\n${stdout.slice(-4000)}\n--- stderr ---\n${String(run.stderr ?? '').slice(-8000)}`;
    assert.ok(!(run instanceof Error), `fixture failed: ${String(run.message).split('\n')[0]}${evidence}`);
    const marker = stdout.split('PAGE_ZOOM_RESULT ')[1];
    assert.ok(marker, `fixture exited without a PAGE_ZOOM_RESULT marker${evidence}`);
    return JSON.parse(marker.split('\n')[0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const FIT = 0.3944;
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`);

/** The page window the product asks for, in DIP (OFFSCREEN_VIEWPORT). */
const REQUESTED = [1280, 900];
/** Windows clamps a window to the work area of the display it is created on,
 *  whatever its size (enableLargerThanScreen is macOS only): a runner whose
 *  screen is 1024x768 with a 48 px taskbar lays every page out at 1024x720.
 *  That is the intended size there, so the expectation follows the display. */
const intendedSize = ({ workAreaSize }) => [
  Math.min(REQUESTED[0], workAreaSize.width),
  Math.min(REQUESTED[1], workAreaSize.height),
];
/** Equal on a whole-scale display. On a fractional one (a 125% laptop) the DIP
 *  size goes through physical pixels, which may add a pixel at each end. */
const slackFor = (dpr) => (Number.isInteger(dpr) ? 0 : 2);
const sameSize = (actual, expected, slack, label) =>
  assert.ok(
    actual.every((value, axis) => Math.abs(value - expected[axis]) <= slack),
    `${label}: [${actual}] vs [${expected}] (slack ${slack})`
  );

for (const softwareRendering of [false, true]) {
  const rendering = softwareRendering ? 'software' : 'GPU';
  test(`a hidden page lays out at its own window size while the site's pane page keeps the pane's zoom (${rendering})`, {
    timeout: 90_000,
    // Like the lane's other suites: the Linux CI lanes have no display server.
    skip: process.platform !== 'win32' && 'Windows only',
  }, async () => {
    const results = await runFixture(softwareRendering);
    for (const mode of ['offscreen', 'native']) {
      const result = results[mode];
      const { agent, control, pane } = result.first;
      assert.ok(Math.abs(result.legacyLevel - FIT) < 0.001, `${mode}: the fixture set the site's shared level`);
      const slack = slackFor(control.dpr);
      const display = JSON.stringify(result.display);
      // The window is the size the product intends on this display, not
      // merely whatever it came out as.
      sameSize(result.content, intendedSize(result.display), slack, `${mode}: the window size on ${display}`);
      // The hidden page of the zoomed site reads as an unzoomed page does:
      // inner = its window, inner <= outer <= screen, the display's own
      // devicePixelRatio, from its first script on.
      for (const [label, page] of [
        ['first document', agent],
        ['next document', result.next.agent],
      ]) {
        const at = `${mode} ${label}`;
        sameSize(page.inner, result.content, slack, `${at}: inner is the window size`);
        sameSize(page.inner, control.inner, slack, `${at}: inner is what an unzoomed site's page reads`);
        assert.ok(page.inner[0] <= page.outer[0] && page.inner[1] <= page.outer[1], `${at}: inner <= outer`);
        assert.ok(page.outer[0] <= page.screen[0] && page.outer[1] <= page.screen[1], `${at}: outer <= screen`);
        assert.equal(page.dpr, control.dpr, `${at}: devicePixelRatio is the display's`);
        assert.deepEqual(page.early, [...page.inner, page.dpr], `${at}: the page's first script already reads it`);
      }
      assert.equal(result.siteLevelAfter, 1, `${mode}: the site's shared level went back to 100%`);
      // The pane's page keeps its own zoom, across its navigation too.
      // (Against the unzoomed page's own width: the window's, as that page reads it.)
      close(pane.inner[0], control.inner[0] / FIT, `${mode}: the pane page's zoom`);
      assert.ok(Math.abs(result.keptOnNavigation - FIT) < 0.001, `${mode}: kept across the pane page's navigation`);
      close(result.next.pane.inner[0], control.inner[0] / 0.5, `${mode}: the pane's next zoom`);
    }
  });
}
