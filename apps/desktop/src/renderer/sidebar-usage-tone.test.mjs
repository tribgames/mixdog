import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("usage popup shares the pinned rail warning and danger ladder", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("./SidebarUsage.tsx", import.meta.url), "utf8"),
    readFile(new URL("./desktop.css", import.meta.url), "utf8"),
  ]);

  assert.match(component,
    /percent !== null && percent >= 90 \? " tone-danger"[\s\S]*?percent !== null && percent >= 70 \? " tone-warning"/,
    "popup meters must use the rail's 70/90 thresholds");
  assert.match(component,
    /className=\{`sidebar-usage-meter\$\{tone\}`\}/,
    "each quota window must carry its computed tone");
  assert.match(styles,
    /\.sidebar-usage-meter > i > i\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--mx-text\) 52%, transparent\);/s,
    "normal popup usage must use the same quiet ink as the rail");
  assert.match(styles,
    /\.sidebar-usage-meter\.tone-warning > i > i\s*\{\s*background:\s*var\(--mx-warning\);[\s\S]*?\.sidebar-usage-meter\.tone-danger > i > i\s*\{\s*background:\s*var\(--mx-danger\);/s,
    "warning and danger fills must share semantic tokens");
  assert.match(styles,
    /\.sidebar-usage-meter\.tone-warning > b\s*\{\s*color:\s*var\(--mx-warning\);[\s\S]*?\.sidebar-usage-meter\.tone-danger > b\s*\{\s*color:\s*var\(--mx-danger\);/s,
    "warning and danger percentages must match their fills");
});
