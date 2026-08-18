import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("remote boot projects the canonical desktop width before renderer startup", () => {
  const boot = readFileSync(new URL("./public/boot.js", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../shared/window-layout.ts", import.meta.url), "utf8");
  const windowOptions = readFileSync(new URL("../main/window-options.ts", import.meta.url), "utf8");

  assert.match(layout, /DESKTOP_WINDOW_DEFAULT_WIDTH = 1040/u);
  assert.match(boot, /width=1040, viewport-fit=cover/u);
  assert.ok(
    boot.indexOf("width=1040") < boot.indexOf("First-paint theme"),
    "projection viewport must be selected before theme/CSS startup",
  );
  assert.match(windowOptions, /width: DESKTOP_WINDOW_DEFAULT_WIDTH/u);
  assert.match(boot, /!\/Electron\/i\.test\(navigator\.userAgent\)/u);
});

test("remote browser owns its tabs and layout independently", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(app, /useRemoteUiProjection/u);
  assert.doesNotMatch(app, /applyRemoteProjection/u);
  assert.match(app, /workspace=\{paneWorkspace\}/u);
});

test("channel corner controls are fully retired from the composer", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
  const surface = readFileSync(
    new URL("./app-conversation-pane-surfaces.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(surface, /composerCornerStatus/u);
  assert.doesNotMatch(surface, /headerStatus/u);
  assert.doesNotMatch(css, /\.composer-corner-status/u);
});

test("mobile right panel keeps its frame separate from scaled content", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
  const layout = readFileSync(
    new URL("./workbench-side-view-layout.tsx", import.meta.url),
    "utf8",
  );

  assert.match(layout, /className="workbench-side-panel-content"/u);
  assert.match(css, /\.workbench-side-panel\[data-side="right"\]\s*\{[^}]*width: 78vw !important;[^}]*overflow: clip;[^}]*contain: paint;[^}]*clip-path:/su);
  assert.match(css, /\.workbench-side-panel\[data-side="right"\] > \.workbench-side-panel-content\s*\{[^}]*transform: scale\(var\(--mx-device-scale/su);
  assert.doesNotMatch(css, /\.workbench-side-panel\[data-side="right"\] > \.workbench-side-panel-content\s*\{[^}]*zoom:/su);
  assert.match(css, /\.workbench-side-panel\[data-side="right"\] :is\([^)]*\.utility-dock-pane,[^)]*\.agent-activity-page[^)]*\)\s*\{[^}]*border-radius: 0 !important;[^}]*box-shadow: none !important;/su);
});

test("mobile settings fill the viewport while shared composer controls align", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");

  assert.match(css, /\.mixdog-settings-layer > \.mixdog-settings-v2\s*\{[^}]*width: 100% !important;[^}]*height: 100% !important;[^}]*max-width: none !important;/su);
  assert.match(css, /\.composer-project-context,[\s\S]*?\.composer-workflow-context\s*\{[^}]*height: 28px;/u);
  assert.match(css, /\.context-pill-select \.mx-select-trigger\s*\{[^}]*height: 28px;/su);
});

test("Android back closes global and settings popup layers in stack order", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const select = readFileSync(new URL("./OpenSelect.tsx", import.meta.url), "utf8");
  const controls = readFileSync(
    new URL("./settings/capability-controls.tsx", import.meta.url),
    "utf8",
  );
  const panels = readFileSync(
    new URL("./settings/capability-panels.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /registerMobileBack\(\(\) => setSettingsOpen\(false\)\)/u);
  assert.match(app, /registerMobileBack\(\(\) => setOnboardingOpen\(false\)\)/u);
  assert.match(app, /registerMobileBack\(\(\) => setQuickAccessMode\(null\)\)/u);
  assert.match(app, /registerMobileBack\(\(\) => cancelPendingTabCloseRef\.current\(\)\)/u);
  assert.match(app, /registerMobileBack\(closeDesktopUpdate\)/u);
  assert.match(select, /if \(!menuOpen\) return undefined;[\s\S]*?registerMobileBack\(\(\) => \{[\s\S]*?setOpen\(false\)/u);
  assert.match(controls, /registerMobileBack\(\(\) => onCloseRef\.current\(\)\)/u);
  assert.match(panels, /registerMobileBack\(\(\) => closeRef\.current\(\)\)/u);
});

test("desktop TASK restores its reading column while mobile TASK stays full-width", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");

  assert.match(css, /@container chat-pane \(min-width: 768px\)\s*\{[\s\S]*?\.conversation\s*\{[^}]*--pane-column: 800px;/u);
  assert.match(css, /@container chat-pane \(min-width: 1536px\)\s*\{[\s\S]*?\.conversation\s*\{\s*--pane-column: 1000px;/u);
  assert.match(css, /html\[data-mixdog-mobile-tabs\] \.conversation\s*\{[^}]*--pane-column: 100%;[^}]*--pane-scroll-column: 100%;[^}]*--pane-card: 100%;/su);
  assert.match(css, /\.transcript-virtual-row-content\[data-tag="UserMessage"\],[\s\S]*?padding-left: calc\(var\(--pane-inset\) \+ var\(--composer-text-inset\)\);[\s\S]*?padding-right: calc\(var\(--pane-inset\) \+ var\(--composer-text-inset\) - var\(--mx-scrollbar-size\)\);/u);
  assert.match(css, /html\[data-mixdog-mobile-tabs\] \.transcript-virtual-row-content\[data-tag="UserMessage"\],[\s\S]*?padding-left: var\(--pane-inset\);[\s\S]*?padding-right: calc\(var\(--pane-inset\) - var\(--mx-scrollbar-size\)\);/u);
  assert.match(css, /\.composer-region\s*\{[^}]*max-width: var\(--pane-column\);[^}]*padding: 0 var\(--pane-inset\) 16px;/su);
  assert.match(css, /\.studio-grid\s*\{[^}]*width: min\(100%, var\(--pane-card\)\);/su);
  assert.match(css, /\.studio-dock\s*\{[^}]*width: min\(100%, var\(--pane-column\)\);[^}]*padding: 0 var\(--pane-inset\) 16px;/su);
});

test("chrome typography grows without changing prose, code, or badge tiers", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");

  assert.match(css, /--mx-font-micro: 11px;/u);
  assert.match(css, /--mx-font-meta: 13px;/u);
  assert.match(css, /--mx-font-minor: 14px;/u);
  assert.match(css, /--mx-font-code: 13px;/u);
  assert.match(css, /--mx-font-ui: 14px;/u);
  assert.match(css, /--mx-font-emphasis: 15px;/u);
  assert.match(css, /--mx-font-body: 15px;/u);
  assert.match(css, /--mx-font-panel-title: 16px;/u);
});

test("session frames preserve base and automation hierarchy insets", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");

  assert.match(css, /\.session-sidebar \.session-row\s*\{\s*padding-inline: 8px var\(--mx-rail-gutter\);/u);
  assert.match(css, /\.session-sidebar \.automation-group-past \.session-row\s*\{\s*padding-left: 20px;/u);
});

test("boot brand exits before the final content watermark fades in", () => {
  const gate = readFileSync(new URL("./PaneSurfaceGate.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");

  assert.match(gate, /DESKTOP_BOOT_BRAND_FADE_MS = 160/u);
  assert.match(gate, /data-ready=\{handoffComplete \? "true" : "false"\}/u);
  assert.match(gate, /data-leaving=\{coverLeaving \? "true" : undefined\}/u);
  assert.match(css, /\.desktop-boot-cover\[data-leaving="true"\]\s*\{\s*opacity: 0;[^}]*pointer-events: none;/su);
  assert.match(css, /\.desktop-boot-gate\[data-brand-handoff\] \.welcome-logo\s*\{[^}]*animation: desktop-boot-brand-in 180ms 20ms ease-out both;/su);
});

test("model triggers follow their labels and morph to the sheet width on PC and mobile", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");

  assert.match(css, /\.route-editor\s*\{[^}]*width: max-content;[^}]*max-width: 100%;[^}]*flex: 0 1 auto;/su);
  assert.match(css, /\.model-trigger\s*\{[^}]*width: max-content;[^}]*max-width: 100%;[^}]*flex: 0 1 auto;/su);
  assert.match(css, /html\[data-mixdog-mobile-tabs\] \.route-editor\s*\{[^}]*width: max-content;[^}]*max-width: 100%;[^}]*flex: 0 1 auto;/su);
  assert.match(css, /html\[data-mixdog-mobile-tabs\] \.model-trigger\s*\{[^}]*width: max-content;[^}]*max-width: 100%;[^}]*flex: 0 1 auto;/su);
  assert.match(css, /\.model-route-label\s*\{[^}]*overflow: visible;[^}]*text-overflow: clip;/su);
  assert.match(css, /\.route-editor > \.model-trigger\[data-morph\]\s*\{[^}]*max-width: none;[^}]*flex: 0 0 auto;[^}]*transition: width 110ms/su);
  assert.doesNotMatch(css, /\.model-trigger\s*\{[^}]*max-width: 38vw;/su);
  assert.doesNotMatch(css, /\.model-trigger\s*\{[^}]*max-width: 150px;/su);
});

test("Dark is the original Mixdog grey ramp and the separate Gray theme is retired", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
  const paneCss = readFileSync(new URL("./pane-layout.css", import.meta.url), "utf8");
  const monaco = readFileSync(new URL("./monaco-setup.ts", import.meta.url), "utf8");
  const themes = readFileSync(new URL("./desktop-theme.ts", import.meta.url), "utf8");
  const onboarding = readFileSync(new URL("./settings/OnboardingWizard.tsx", import.meta.url), "utf8");
  const boot = readFileSync(new URL("./public/boot.js", import.meta.url), "utf8");
  const index = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const manifest = readFileSync(new URL("./public/manifest.webmanifest", import.meta.url), "utf8");

  assert.match(css, /--mx-window-band: #151518;/u);
  assert.match(css, /--mx-bg-deep: #101013;/u);
  assert.match(css, /--mx-workspace-sheet: #1c1c1f;/u);
  assert.match(css, /--mx-bg-base: #222225;/u);
  assert.match(css, /--mx-bg-layer-1: #2a2a2d;/u);
  assert.match(css, /--mx-bg-layer-2: #323236;/u);
  assert.match(css, /--mx-bg-layer-3: #3d3d41;/u);
  assert.match(css, /html\[data-mixdog-theme="basic"\]\[data-mixdog-mobile-tabs\] \.pane-cell > \.workspace-tabs-shell,[^}]*background: var\(--mx-workspace-sheet\);/su);
  assert.doesNotMatch(css, /data-mixdog-theme="gray"/u);
  assert.match(css, /--mx-border-structure: rgba\(255, 255, 255, \.16\);/u);
  assert.match(css, /\.activity-rail\s*\{[^}]*border-right: 1px solid var\(--mx-border-structure\);/su);
  assert.match(css, /\.workspace-tab\.active\s*\{[^}]*--workspace-tab-surface: var\(--mx-window-band\);[^}]*box-shadow: inset 1px 0 0 var\(--mx-border\), inset -1px 0 0 var\(--mx-border\);/su);
  assert.match(css, /\.rail-usage-popup\s*\{[^}]*background: var\(--mx-window-band\);/su);
  assert.match(css, /\.sidebar-usage-row\s*\{[^}]*background: transparent;/su);
  assert.match(css, /\.sidebar-usage-reset-credit\s*\{[^}]*background: transparent;/su);
  assert.match(paneCss, /\.bottom-panel\s*\{[^}]*background: var\(--mx-window-band\);/su);
  assert.match(paneCss, /\.bottom-panel\s*\{[^}]*border-top: 1px solid var\(--mx-border-structure\);/su);
  assert.match(paneCss, /\.pane-resize-handle::after\s*\{[^}]*background: var\(--mx-border-structure\);/su);
  assert.match(paneCss, /\.pane-cell > \.workspace-tabs-shell,[\s\S]*?border-bottom: 1px solid var\(--mx-border\);/u);
  assert.match(monaco, /'editor\.background': '#1c1c1f'/u);
  assert.match(monaco, /resolveThemeColor\('--mx-workspace-sheet', light \? '#fafafa' : '#1c1c1f'\)/u);
  assert.match(monaco, /resolveThemeColor\('--mx-bg-base', light \? '#ffffff' : '#222225'\)/u);
  assert.doesNotMatch(themes, /DESKTOP_GRAY_THEME_ID/u);
  assert.match(themes, /if \(value === 'gray'\) return 'dark';/u);
  assert.match(themes, /if \(value === 'system' \|\| value === 'dark' \|\| value === 'white'\) return value;/u);
  assert.match(themes, /function pwaSystemBarColor\(\): string\s*\{\s*return '#000000';/u);
  assert.match(themes, /\.setAttribute\('content', pwaSystemBarColor\(\)\)/u);
  assert.doesNotMatch(onboarding, /id: 'gray'/u);
  assert.match(boot, /mixdogThemePref !== 'gray'/u);
  assert.doesNotMatch(boot, /dataset\.mixdogTheme = 'gray'/u);
  assert.match(index, /<meta name="theme-color" content="#000000" \/>/u);
  assert.match(manifest, /"background_color": "#000000"/u);
  assert.match(manifest, /"theme_color": "#000000"/u);
});
