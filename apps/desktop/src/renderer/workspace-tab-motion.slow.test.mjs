// Real Chromium owns the layout/scroll/transition interaction; jsdom cannot
// reproduce the transient overflow that used to pan the entire tab strip.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const rendererDir = fileURLToPath(new URL(".", import.meta.url));

test("tab creation keeps fitting runs anchored and still reveals genuine overflow", { timeout: 45_000 }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "mixdog-tab-motion-"));
  try {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("../../scripts/tab-motion-probe/entry.tsx", import.meta.url))],
      outfile: join(scratch, "entry.js"),
      bundle: true,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
      // Surface prefetch is unrelated to tab layout. Keep this isolated
      // fixture from loading editors or connecting to the user's daemon.
      plugins: [{
        name: "isolated-surface-prefetch",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/lazy-widgets$/ }, () => ({
            path: "surface-prefetch", namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export const prefetchSurfaceForSelection = () => {};",
          }));
        },
      }],
    });
    assert.equal(bundle.errors.length, 0);
    const links = ["styles.css", "desktop.css", "pane-layout.css"].map((name) =>
      `<link rel="stylesheet" href="${pathToFileURL(join(rendererDir, name)).href}">`).join("\n");
    await writeFile(join(scratch, "index.html"), `<!doctype html><html><head>
      <meta charset="utf-8">${links}</head><body><script src="./entry.js"></script></body></html>`);
    await writeFile(join(scratch, "main.cjs"), `
      const { app, BrowserWindow } = require("electron");
      const { writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      app.setPath("userData", join(__dirname, "profile"));
      app.disableHardwareAcceleration();
      app.whenReady().then(async () => {
        const win = new BrowserWindow({
          show: false, width: 1400, height: 800,
          webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false },
        });
        await win.loadFile(join(__dirname, "index.html"));
        win.webContents.debugger.attach("1.3");
        const results = {};
        for (const motion of ["no-preference", "reduce"]) {
          await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-reduced-motion", value: motion }],
          });
          results[motion] = await win.webContents.executeJavaScript("window.runTabMotionProbe()");
        }
        writeFileSync(join(__dirname, "result.json"), JSON.stringify(results));
        win.destroy();
        app.quit();
      }).catch((error) => { console.error(error); app.exit(1); });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [join(scratch, "main.cjs")], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal: t.signal,
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => { output = (output + chunk).slice(-8_000); });
    }
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, output);
    const results = JSON.parse(await readFile(join(scratch, "result.json"), "utf8"));
    for (const [motion, cases] of Object.entries(results)) {
      for (const result of cases) {
        const label = `${motion}: ${result.width}px, ${result.initialCount} + ${result.additions} tabs`;
        await t.test(label, () => {
          if (result.initialCount < 12) {
            assert.ok(result.samples.length > 2, `${label}: no animation frames captured`);
            assert.ok(result.samples.every((sample) => Math.abs(sample.scroll) < 0.75),
              `${label}: strip scrolled during creation: ${JSON.stringify(result.samples)}`);
            assert.ok(result.samples.every((sample) => Math.abs(sample.firstOffset) < 0.75),
              `${label}: leading tab moved`);
            if (motion === "no-preference") {
              assert.ok(result.samples.some((sample) => sample.activeWidth < result.settled.activeWidth - 1),
                `${label}: entry width no longer animates`);
            }
          } else {
            assert.ok(result.settled.scroll > 0, `${label}: actual overflow did not scroll`);
          }
          assert.ok(result.settled.activeVisible, `${label}: added tab remains clipped`);
          assert.ok(result.selectedFirst.activeVisible, `${label}: first tab could not be revealed`);
          assert.ok(result.selectedLast.activeVisible, `${label}: last tab could not be revealed`);
          assert.equal(result.expanded.scroll, 0, `${label}: fitting a wider pane did not reset scrolling`);
        });
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
