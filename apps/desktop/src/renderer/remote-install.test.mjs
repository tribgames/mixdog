import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isIosInstallPlatform, remoteInstallMode } from "./remote-install.ts";

test("remote install prompt only appears on eligible uninstalled web surfaces", () => {
  const base = { remote: true, standalone: false, dismissed: false, canPrompt: false, ios: false };
  assert.equal(remoteInstallMode({ ...base, canPrompt: true }), "prompt");
  assert.equal(remoteInstallMode({ ...base, ios: true }), "ios");
  assert.equal(remoteInstallMode({ ...base, remote: false, canPrompt: true }), "hidden");
  assert.equal(remoteInstallMode({ ...base, standalone: true, canPrompt: true }), "hidden");
  assert.equal(remoteInstallMode({ ...base, dismissed: true, canPrompt: true }), "hidden");
});

test("iPad desktop user agents still receive Add to Home Screen guidance", () => {
  assert.equal(isIosInstallPlatform("Mozilla/5.0 (iPhone)", "iPhone", 5), true);
  assert.equal(isIosInstallPlatform("Mozilla/5.0 (Macintosh)", "MacIntel", 5), true);
  assert.equal(isIosInstallPlatform("Mozilla/5.0 (Windows NT 10.0)", "Win32", 0), false);
});

test("manifest carries Chromium installability icons", () => {
  const manifest = JSON.parse(readFileSync(
    new URL("./public/manifest.webmanifest", import.meta.url),
    "utf8",
  ));
  const icons = new Map(manifest.icons.map((icon) => [icon.sizes, icon]));
  assert.equal(icons.get("192x192")?.type, "image/png");
  assert.equal(icons.get("512x512")?.type, "image/png");
  assert.equal(manifest.display, "standalone");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /rel="apple-touch-icon" href="\.\/mixdog-192\.png"/u);
});
