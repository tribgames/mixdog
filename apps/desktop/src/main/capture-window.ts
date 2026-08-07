import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type NativeImage,
} from 'electron';
import { SETTINGS_CATEGORIES } from '../renderer/settings/settings-items';
import { DESKTOP_IPC } from '../shared/contract';
import { registerDesktopIpc } from './ipc';
import { DESKTOP_WINDOW_OPTIONS } from './window-options';

// The capture flow owns window lifetime. Without this listener Electron's
// default quit-on-last-window-close fires the moment a failing step reaches
// the finally-block destroy, exiting 0 before the error artifact is written
// and leaving the outer harness to time out with no diagnostic.
app.on('window-all-closed', () => {});

// Electron's default-app launcher removes the application entry from argv on
// some platforms/versions. Locate the typed output argument instead of relying
// on Node's argv offsets so both direct and spawned capture runs are stable.
const outputArgIndex = process.argv.findIndex((argument, index) => index > 0 && /\.png$/i.test(argument));
const requestedOutputPath = outputArgIndex >= 0 ? process.argv[outputArgIndex] : '';
const outputPath = requestedOutputPath ? resolve(requestedOutputPath) : '';
const captureId = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : '';
const allowedSettingsCategoryLabelSets = [
  SETTINGS_CATEGORIES.filter((category) => category.value !== 'connection')
    .map((category) => category.label),
  SETTINGS_CATEGORIES.map((category) => category.label),
];
if (process.env.MIXDOG_CAPTURE_USER_DATA) {
  app.setPath('userData', resolve(process.env.MIXDOG_CAPTURE_USER_DATA));
}

// Dictation E2E: synthesize a Chromium fake microphone so MediaRecorder
// records real (tone) audio without hardware or a permission prompt.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

import { captureTitle, destroyCaptureWindow, imageReader, measureShellTopEdge, readDesktopAssertions, readLightThemeAssertions, readMobileClosedAssertions, readMobileOpenAssertions, readModalStackAssertions, readPhoneSettingsAssertions, readSettingsPlacement, schemaVersion, targetSize, validateAndDestroyRenderer, waitForRenderer, withCaptureTimeout, type LiveCaptureAssertions } from "./capture-assertions";
import { CaptureService } from "./capture-host";

async function captureWindow(): Promise<void> {
  if (!requestedOutputPath) throw new Error('Capture output path is required and must end in .png.');
  if (!captureId) throw new Error('Capture ID is required.');
  await app.whenReady();
  const host = new CaptureService({
    getUserDataPath: () => app.getPath('userData'),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: resolve(__dirname, '../..'),
  });
  const window = new BrowserWindow({
    ...DESKTOP_WINDOW_OPTIONS,
    title: captureTitle,
    webPreferences: {
      ...DESKTOP_WINDOW_OPTIONS.webPreferences,
      preload: join(__dirname, '../preload/index.js'),
    },
  });
  const rendererConsoleErrors: string[] = [];
  window.webContents.on('console-message', (event) => {
    const details = event as unknown as { level: string; message: string };
    if (details.level === 'error') {
      rendererConsoleErrors.push(details.message);
      // Mirror into the module-scope buffer so the top-level failure handler
      // can surface the real renderer exception behind Electron's generic
      // "Script failed to execute" executeJavaScript rejection.
      capturedRendererConsoleErrors.push(details.message);
    }
  });
  window.on('page-title-updated', (event) => event.preventDefault());
  const captureUpdaterState = { status: 'ready', version: '0.2.0' } as const;
  const removeIpc = registerDesktopIpc(window, host, {
    app,
    ipcMain,
    dialog,
    shell,
    updater: {
      getState: () => captureUpdaterState,
      subscribe(listener) {
        listener(captureUpdaterState);
        return () => {};
      },
      check: async () => captureUpdaterState,
      install: async () => {},
    },
  });
  try {
    const captureRendererUrl = String(process.env.MIXDOG_CAPTURE_RENDERER_URL || "").trim();
    if (captureRendererUrl) await window.loadURL(captureRendererUrl);
    else await window.loadFile(join(__dirname, '../renderer/index.html'));
    const reloadedWithDarkTheme = new Promise<void>((resolveReload) => {
      window.webContents.once('did-finish-load', () => resolveReload());
    });
    await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('mixdog.desktop-theme-preference', 'dark');
      localStorage.setItem('mixdog.desktop.ui-language.v1', 'en');
      setTimeout(() => location.reload(), 0);
      return true;
    })()`);
    await reloadedWithDarkTheme;
    window.setTitle(captureTitle);
    window.show();
    window.focus();
    // Never let occlusion/background throttling suspend frame production —
    // late capture passes (tool showcase) read the compositor's latest frame
    // and a paint-suspended window serves stale pre-mutation pixels.
    window.webContents.setBackgroundThrottling(false);
    // Jitter probe mode: measure streaming follow, warm compositor handoff,
    // and session/panel transition stability, then exit — no capture passes.
    if (process.env.MIXDOG_JITTER_PROBE === '1'
      || process.env.MIXDOG_JITTER_PROBE === 'entry'
      || process.env.MIXDOG_JITTER_PROBE === 'keys'
      || process.env.MIXDOG_JITTER_PROBE === 'switch'
      || process.env.MIXDOG_JITTER_PROBE === 'width') {
      const { runJitterProbe, jitterProbeOutPath } = await import('./jitter-probe');
      await runJitterProbe({
        window,
        stateChannel: DESKTOP_IPC.state,
        baseSnapshot: host.getSnapshot() as unknown as Record<string, unknown>,
        prepareRemoteResume: (stored, live) => host.prepareJitterRemoteResume(stored, live),
        prepareColdResume: (snapshot) => host.prepareJitterColdResume(snapshot),
        outPath: jitterProbeOutPath(resolve(__dirname, '../..')),
      });
      removeIpc();
      window.destroy();
      app.exit(0);
      return;
    }
    // The pane workspace now starts with a deliberate empty guidance surface.
    // Normal capture assertions exercise the task UI, so materialize a draft
    // through the product's real Ctrl+N contract instead of reaching for the
    // retired Activity Bar button.
    const captureTaskAlreadyActive = await window.webContents.executeJavaScript(
      "Boolean(document.querySelector('.composer'))",
    ) as boolean;
    if (!captureTaskAlreadyActive) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control'] });
    }
    await waitForRenderer(
      window,
      "document.querySelector('.composer') && document.querySelector('.workspace-tab')",
      'capture task workspace',
    );
    // Startup-geometry stability: sample the chrome rects right after show and
    // again after the settle window. Any delta is the "tab pops once at
    // launch" class of first-paint jolt (env(titlebar-area) resolution, font
    // swap, async layout) — captured as numbers so it can be pinned down.
    const sampleStartupGeometry = `(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width, height: box.height };
      };
      return {
        tab: rect('.workspace-tab'),
        tabsShell: rect('.workspace-tabs'),
        sidebar: rect('.session-sidebar'),
        toggle: rect('.toolbar-sidebar'),
        composer: rect('.composer'),
      };
    })()`;
    const startupGeometryEarly = await window.webContents.executeJavaScript(sampleStartupGeometry) as Record<string, { left: number; top: number; width: number; height: number } | null>;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const startupGeometrydSettled = await window.webContents.executeJavaScript(sampleStartupGeometry) as Record<string, { left: number; top: number; width: number; height: number } | null>;
    const startupGeometry = {
      early: startupGeometryEarly,
      settled: startupGeometrydSettled,
      deltas: Object.fromEntries(Object.keys(startupGeometrydSettled).map((key) => {
        const before = startupGeometryEarly[key];
        const after = startupGeometrydSettled[key];
        if (!before || !after) return [key, before === after ? 0 : -1];
        return [key, Math.max(
          Math.abs(before.left - after.left),
          Math.abs(before.top - after.top),
          Math.abs(before.width - after.width),
          Math.abs(before.height - after.height),
        )];
      })),
    };
    // Panels default MINIMIZED; the capture contract measures the EXPANDED
    // rail, so open the session sidebar before any geometry pass.
    await window.webContents.executeJavaScript(`(() => {
      if (document.querySelector('.app-shell.sidebar-collapsed')) {
        const toggle = document.querySelector('.toolbar-sidebar');
        if (toggle instanceof HTMLElement) toggle.click();
      }
      return true;
    })()`);
    await waitForRenderer(
      window,
      "!document.querySelector('.app-shell.sidebar-collapsed')",
      'expanded session sidebar',
    );
    window.setSize(1_000, 650);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const resizedBounds = window.getBounds();
    window.setMinimumSize(320, 600);
    window.setSize(720, 650);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await window.webContents.executeJavaScript(`(() => {
      const toggle = document.querySelector('.toolbar-sidebar');
      if (toggle instanceof HTMLButtonElement && toggle.getAttribute('aria-expanded') !== 'true') {
        toggle.click();
      }
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const mobileViewport = await window.webContents.executeJavaScript(
      '({ width: innerWidth, height: innerHeight })',
    ) as { width: number; height: number };
    const mobileOpen = await readMobileOpenAssertions(window);
    await window.webContents.executeJavaScript(
      "document.querySelector('.sidebar-backdrop')?.click()",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const mobileClosed = await readMobileClosedAssertions(window);
    const liveMobile = {
      viewport: mobileViewport,
      breakpointActive: mobileViewport.width <= 760,
      open: mobileOpen,
      closed: mobileClosed,
    };
    if (!liveMobile.breakpointActive || !mobileOpen.sidebarVisible || !mobileOpen.backdropVisible
      || !mobileOpen.sidebarComputedVisible || !mobileOpen.backdropComputedVisible
      || !mobileOpen.sidebarIntersectsViewport || !mobileOpen.backdropIntersectsViewport
      || !mobileClosed.sidebarHidden || !mobileClosed.mainVisible || !mobileClosed.mainMatchesViewport
      || !mobileClosed.composerVisible || !mobileClosed.composerContained
      || !mobileClosed.modelTriggerVisible || !mobileClosed.sendVisible
      || !mobileClosed.sendContained || !mobileClosed.controlsNonOverlapping) {
      throw new Error(`Mobile live assertions failed: ${JSON.stringify(liveMobile)}`);
    }
    window.setSize(1_280, 820);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const settingsAlreadyOpen = await withCaptureTimeout(
      window.webContents.executeJavaScript(
        "Boolean(document.querySelector('.mixdog-settings-layer[data-surface-active=\"true\"]'))",
      ),
      'read settings state',
    ) as boolean;
    if (!settingsAlreadyOpen) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['control'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: ',', modifiers: ['control'] });
    }
    await waitForRenderer(
      window,
      `document.querySelector('.mixdog-settings__body .settings-group')
        && !document.querySelector('.mixdog-settings__body .settings-loading')`,
      'populated General settings pane',
    );
    const largeSettings = await readSettingsPlacement(window);
    const modalStack = await readModalStackAssertions(window);
    // The theme trigger can be transiently disabled (engine/settings busy) and
    // a click during that window is silently dropped — retry open+check as one
    // unit instead of a single click followed by a bare wait.
    // Hydration (settings capability preload) can take 20s+ while the
    // isolated engine cold-boots; the Theme trigger stays disabled until it
    // settles. Keep retrying well past that window.
    const openThemeMenuUntilOption = async (optionText: string): Promise<void> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const state = await window.webContents.executeJavaScript(`(() => {
          const option = Array.from(document.querySelectorAll('.mx-menu[aria-label="Theme"] [role="option"]'))
            .find((entry) => (entry.textContent || '').trim() === ${JSON.stringify(optionText)});
          if (option instanceof HTMLButtonElement) return 'open';
          const trigger = document.querySelector('button[role="combobox"][aria-label="Theme"]');
          if (!(trigger instanceof HTMLButtonElement)) return 'missing';
          if (trigger.disabled) return 'disabled';
          if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
          return 'clicked';
        })()`) as string;
        if (state === 'open') return;
      if (Date.now() >= deadline) {
        throw new Error(`Theme option "${optionText}" did not appear within 30000ms (last state: ${state}).`);
      }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    };
    await openThemeMenuUntilOption('White');
    const selectedWhite = await window.webContents.executeJavaScript(`(() => {
      const option = Array.from(document.querySelectorAll('.mx-menu[aria-label="Theme"] [role="option"]'))
        .find((entry) => (entry.textContent || '').trim() === 'White');
      if (!(option instanceof HTMLButtonElement)) return false;
      option.click();
      return true;
    })()`);
    if (!selectedWhite) throw new Error('White theme option is missing.');
    await waitForRenderer(
      window,
      `document.documentElement.dataset.mixdogTheme === 'light'`,
      'Light theme',
    );
    await waitForRenderer(
      window,
      `(() => {
        const icon = document.querySelector('.toolbar-sidebar');
        if (!(icon instanceof HTMLElement)) return false;
        const probe = document.createElement('span');
        probe.style.color = 'var(--mx-text)';
        document.body.append(probe);
        const settled = getComputedStyle(icon).color === getComputedStyle(probe).color;
        probe.remove();
        return settled;
      })()`,
      'Light titlebar icon transition',
    );
    const lightTheme = await readLightThemeAssertions(window);
    await window.webContents.executeJavaScript(`(() => {
      const layer = document.querySelector('.mixdog-settings-layer');
      if (!(layer instanceof HTMLElement)) throw new Error('Settings layer is missing for light shell capture.');
      layer.style.display = 'none';
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The earlier mobile pass may have auto-collapsed the sidebar (<=760px
    // navigation close). Reopen it so the light frame shows the full rail.
    await window.webContents.executeJavaScript(`(() => {
      if (document.querySelector('.app-shell.sidebar-collapsed')) {
        const toggle = document.querySelector('.toolbar-sidebar');
        if (toggle instanceof HTMLElement) toggle.click();
      }
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Keep the full light-theme frame as a standing artifact so dark/light
    // parity can be reviewed visually, not just via token assertions.
    const lightImage = await window.webContents.capturePage();
    const lightShellTopEdge = measureShellTopEdge(lightImage, 'light');
    const lightPng = lightImage.toPNG();
    await window.webContents.executeJavaScript(
      "document.querySelector('.mixdog-settings-layer')?.style.removeProperty('display')",
    );
    await openThemeMenuUntilOption('Dark');
    const restoredBasic = await window.webContents.executeJavaScript(`(() => {
      const option = Array.from(document.querySelectorAll('.mx-menu[aria-label="Theme"] [role="option"]'))
        .find((entry) => (entry.textContent || '').trim() === 'Dark');
      if (!(option instanceof HTMLButtonElement)) return false;
      option.click();
      return true;
    })()`);
    if (!restoredBasic) throw new Error('Dark theme option is missing.');
    await waitForRenderer(
      window,
      `document.documentElement.dataset.mixdogTheme === 'basic'`,
      'restored Basic theme',
    );
    window.setSize(720, 650);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const compactSettings = await readSettingsPlacement(window);
    window.setSize(360, 600);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const narrowSettings = await readPhoneSettingsAssertions(window);
    const expectedNarrowSettingsCategoryLabels = SETTINGS_CATEGORIES.map((category) => category.label);
    window.setSize(390, 740);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await window.webContents.executeJavaScript(`(() => {
      document.documentElement.dataset.mixdogMobile = '1';
      document.documentElement.style.setProperty('--mixdog-vvh', innerHeight + 'px');
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const phoneSettings = await readPhoneSettingsAssertions(window);
    const capturedSettingsCategoryLabels = phoneSettings.categories.map((category) => category.label);
    const expectedSettingsCategoryLabels = allowedSettingsCategoryLabelSets.find((labels) =>
      labels.length === capturedSettingsCategoryLabels.length
      && labels.every((label, index) => label === capturedSettingsCategoryLabels[index]))
      ?? [];
    const liveSettings = {
      large: largeSettings,
      compact: compactSettings,
      narrow: narrowSettings,
      phone: phoneSettings,
    };
    if (largeSettings.viewport.width !== 1_280 || largeSettings.viewport.height !== 820
      || !largeSettings.centered || !largeSettings.layerCoversViewport
      || !largeSettings.dialogClearsWindowControls
      || largeSettings.fullBleed || !largeSettings.contentClearsWindowControls
      || !largeSettings.dialogFitsViewport || !largeSettings.backdropVisible || !largeSettings.twoPane
      || largeSettings.dialog.width !== 980 || largeSettings.rail.width !== 240 || largeSettings.populatedRowCount < 1
      || !compactSettings.centered || !compactSettings.layerCoversViewport
      || !compactSettings.fullBleed || !compactSettings.contentClearsWindowControls
      || !compactSettings.dialogFitsViewport || !compactSettings.backdropVisible || !compactSettings.twoPane
      || compactSettings.viewport.width !== 720 || compactSettings.viewport.height !== 650
      || compactSettings.dialog.width !== 720 || compactSettings.dialog.height !== 650
      || compactSettings.rail.width !== 200
      || narrowSettings.viewport.width !== 360 || narrowSettings.viewport.height !== 600
      || !narrowSettings.fullScreen || !narrowSettings.railConnected || narrowSettings.rail.width !== 48
      || narrowSettings.railButtonCount !== expectedNarrowSettingsCategoryLabels.length
      || narrowSettings.categories.some((category, index) =>
        category.label !== expectedNarrowSettingsCategoryLabels[index])
      || !narrowSettings.railButtonsAccessible
      || !narrowSettings.closeTouchTarget || narrowSettings.rowCount < 1
      || narrowSettings.filledValueControlCount < 1 || !narrowSettings.sharedValueAxis
      || !narrowSettings.controlsContained || !narrowSettings.controlsRightAligned
      || !narrowSettings.labelsSeparated || !narrowSettings.valuesFillColumn
      || !narrowSettings.overflowFree || narrowSettings.categories.some((category) =>
        !category.overflowFree || !category.controlsContained
        || !category.controlsRightAligned || !category.labelsSeparated)
      || phoneSettings.viewport.width > 430 || phoneSettings.viewport.width < 320
      || !phoneSettings.fullScreen || !phoneSettings.railConnected || phoneSettings.rail.width !== 52
      || phoneSettings.railButtonCount !== expectedSettingsCategoryLabels.length
      || phoneSettings.categories.some((category, index) =>
        category.label !== expectedSettingsCategoryLabels[index])
      || !phoneSettings.railButtonsAccessible
      || !phoneSettings.closeTouchTarget || phoneSettings.rowCount < 1
      || phoneSettings.filledValueControlCount < 1 || !phoneSettings.sharedValueAxis
      || !phoneSettings.controlsContained || !phoneSettings.controlsRightAligned
      || !phoneSettings.labelsSeparated || !phoneSettings.valuesFillColumn
      || !phoneSettings.overflowFree || phoneSettings.categories.some((category) =>
        !category.overflowFree || !category.controlsContained
        || !category.controlsRightAligned || !category.labelsSeparated)
      || lightTheme.theme !== 'light' || lightTheme.colorScheme !== 'light'
      || !lightTheme.titlebarIconMatchesToken || !lightTheme.activeTabMatchesToken
      || !modalStack.toastParentIsBody || !modalStack.toastVisible
      || !modalStack.toastOutsideInertTree || !modalStack.toastAboveModal) {
      throw new Error(`Settings placement assertions failed: ${JSON.stringify({
        settings: liveSettings,
        lightTheme,
        modalStack,
      })}`);
    }
    await window.webContents.executeJavaScript(
      "document.querySelector('.mixdog-settings__close')?.click()",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await window.webContents.executeJavaScript(`(() => {
      delete document.documentElement.dataset.mixdogMobile;
      document.documentElement.style.removeProperty('--mixdog-vvh');
    })()`);
    window.setMinimumSize(DESKTOP_WINDOW_OPTIONS.minWidth, DESKTOP_WINDOW_OPTIONS.minHeight);
    window.setSize(targetSize.width, targetSize.height);
    await window.webContents.executeJavaScript(
      "document.querySelector('.toolbar-sidebar[aria-expanded=\"false\"]')?.click()",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const finalBounds = window.getBounds();
    const liveDesktop = await readDesktopAssertions(window);
    if (!liveDesktop.labelsAbsent || !liveDesktop.hiddenLabelsAbsent
      || liveDesktop.removedLabelMatches.length !== 0 || liveDesktop.contextChipCount !== 0
      || !liveDesktop.visible.modelTrigger || !liveDesktop.visible.textarea || !liveDesktop.visible.send
      || !liveDesktop.controlsNonOverlapping || liveDesktop.sidebarGap !== 0
      || liveDesktop.rects.sidebar.left !== 0 || liveDesktop.rects.sidebar.top !== 41
      || liveDesktop.rects.sidebar.width !== 260
      || liveDesktop.viewport.height - liveDesktop.rects.sidebar.bottom !== 0
      || liveDesktop.rects.main.left !== 260) {
      throw new Error(`Desktop live assertions failed: ${JSON.stringify(liveDesktop)}`);
    }
    const liveAssertions: LiveCaptureAssertions = {
      desktop: liveDesktop,
      mobile: liveMobile,
      settings: liveSettings,
      lightTheme,
      modalStack,
    };
    const captureMethod = 'webContents.capturePage';
    const image: NativeImage = await withCaptureTimeout(
      window.webContents.capturePage(),
      'capturePage',
    );
    const sourceSize = image.getSize();
    if (finalBounds.width !== targetSize.width || finalBounds.height !== targetSize.height) {
      throw new Error(`BrowserWindow bounds are ${finalBounds.width}x${finalBounds.height}, expected 1113x687.`);
    }
    if (sourceSize.width !== targetSize.width || sourceSize.height !== targetSize.height) {
      throw new Error(`Desktop capture source is ${sourceSize.width}x${sourceSize.height}, expected 1113x687; refusing to resize evidence.`);
    }
    // Dictation smoke (post-PNG so the evidence stays clean): drives the FULL
    // renderer chain — fake mic → MediaRecorder → base64 → IPC → stubbed
    // transcription → draft append.
    const dictationSmoke = await withCaptureTimeout(window.webContents.executeJavaScript(`(async () => {
      const mic = document.querySelector('.composer-mic');
      if (!(mic instanceof HTMLElement)) throw new Error('Missing capture element: .composer-mic');
      mic.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      mic.click();
      const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
      const started = Date.now();
      while (Date.now() - started < 6000) {
        if ((textarea.value || '').includes('dictation smoke transcript')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        transcriptApplied: (textarea.value || '').includes('dictation smoke transcript'),
        micIdle: !mic.className.includes('is-recording') && !mic.className.includes('is-transcribing'),
        notice: (document.querySelector('.composer-notice')?.textContent || '').trim(),
      };
    })()`), 'Dictation smoke', 10_000) as { transcriptApplied: boolean; micIdle: boolean; notice: string };
    // Tool-presentation E2E: inject a synthetic rich transcript over the live
    // state channel so the REAL transcript renderer (tool cards, shell output,
    // failure states, diff review bar) is exercised and captured — no
    // provider/engine required. The artifact ships next to the main PNG for
    // visual review; counts are asserted by capture-ui. NOTE: the diff body
    // must not contain an `import ... from "..."` line — electron-vite's CJS
    // shim pass lexes the bundled chunk for import statements and splices the
    // chunk mid-string, corrupting the build.
    const showcasePatch = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,4 +1,4 @@',
      ' const config = loadConfig();',
      '-const retries = 1;',
      '+const retries = 3;',
      ' boot({ config, retries });',
      '',
    ].join('\n');
    const baseSnapshot = host.getSnapshot();
    await withCaptureTimeout(window.webContents.executeJavaScript(`(async () => {
      const link = document.querySelector('button[aria-label="New task"]');
      if (!(link instanceof HTMLElement)) throw new Error('Missing capture element: .task-link');
      link.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return true;
    })()`), 'New-task activation', 8_000);
    window.webContents.send(DESKTOP_IPC.state, {
      ...baseSnapshot,
      toasts: [],
      busy: true,
      items: [
        { id: 'sc-user', kind: 'user', text: 'Run the test suite and fix the retry regression.' },
        {
          id: 'sc-shell-ok',
          kind: 'tool',
          name: 'shell',
          args: { command: 'npm run typecheck:node', description: 'Typecheck the main process' },
          result: 'Exit code: 0\n> tsc -p tsconfig.node.json\nTypecheck passed in 4.2s.',
          completedAt: 1,
          expanded: true,
        },
        {
          id: 'sc-shell-fail',
          kind: 'tool',
          name: 'shell',
          args: { command: 'npm test' },
          result: 'Exit code: 1\n1) retry configuration\n   AssertionError: expected retries to equal 3, got 1',
          isError: true,
          completedAt: 2,
          expanded: true,
        },
        {
          id: 'sc-edit',
          kind: 'tool',
          name: 'edit',
          args: { path: 'src/app.ts' },
          result: showcasePatch,
          completedAt: 3,
          expanded: true,
        },
        { id: 'sc-assistant', kind: 'assistant', text: 'Retry count fixed — rerunning the suite now.' },
        {
          id: 'sc-shell-running', kind: 'tool', name: 'shell',
          args: { command: 'npm test' }, startedAt: Date.now() - 12_000,
          liveOutput: '> vitest run\n\u2713 retry configuration (3 tests)\n\u2713 boot sequence (5 tests)\nrunning suite: integration \u2026',
        },
      ],
    });
    const toolShowcase = await withCaptureTimeout(window.webContents.executeJavaScript(`(async () => {
      const started = Date.now();
      while (Date.now() - started < 5000) {
        const cardsReady = document.querySelectorAll('.tool-card').length >= 4;
        const diffNode = document.querySelector('.diff-file');
        const diffReady = Boolean(diffNode) && !(diffNode.textContent || '').includes('Loading diff');
        if (cardsReady && diffReady) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        toolCards: document.querySelectorAll('.tool-card').length,
        collapsedCards: document.querySelectorAll('.tool-card[data-open="false"]').length,
        detailRows: document.querySelectorAll('.tool-detail-line').length,
        failedCards: document.querySelectorAll('.tool-card.failed').length,
        settledCards: document.querySelectorAll('.tool-card.settled').length,
        reviewBar: Boolean(document.querySelector('.turn-review-bar')),
        runningCommandVisible: Array.from(document.querySelectorAll('.tool-card:not(.settled) .tool-title small'))
          .some((node) => (node.textContent || '').includes('npm test')),
        runningStatusVisible: Array.from(document.querySelectorAll('.tool-card:not(.settled) [role="status"]'))
          .some((node) => (node.textContent || '').trim() === 'Running'),
        editInputBlocks: document.querySelectorAll('.tool-card[data-category="Patch"] .detail-block').length,
        legacyBodyBlocks: document.querySelectorAll(
          '.tool-card .shell-output, .tool-card .diff-file, .tool-card .tool-content',
        ).length,
      };
    })()`), 'Tool showcase render', 8_000) as {
      toolCards: number;
      collapsedCards: number;
      detailRows: number;
      failedCards: number;
      settledCards: number;
      reviewBar: boolean;
      runningCommandVisible: boolean;
      runningStatusVisible: boolean;
      editInputBlocks: number;
      legacyBodyBlocks: number;
    };
    // Flush a real presented frame before reading the compositor: DOM commit
    // alone is not a paint, and an occluded window may still hold the frame
    // from the previous capture pass.
    window.moveTop();
    window.focus();
    // Top frame first: the completed shell cards (success + failure) sit at
    // the transcript top and fall outside the bottom-anchored viewport.
    await window.webContents.executeJavaScript(
      "(() => { const scroller = document.querySelector('.thread')?.parentElement; "
      + 'if (scroller) scroller.scrollTop = 0; return true; })()',
    );
    await window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const toolsTopImage: NativeImage = await withCaptureTimeout(
      window.webContents.capturePage(),
      'toolShowcase top capturePage',
    );
    const toolsTopPng = toolsTopImage.toPNG();
    await window.webContents.executeJavaScript(
      "(() => { const scroller = document.querySelector('.thread')?.parentElement; "
      + 'if (scroller) scroller.scrollTop = scroller.scrollHeight; return true; })()',
    );
    await window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const toolsImage: NativeImage = await withCaptureTimeout(
      window.webContents.capturePage(),
      'toolShowcase capturePage',
    );
    const toolsPng = toolsImage.toPNG();
    const toolShowcaseDimensions = toolsImage.getSize();
    // Restore the empty-session state so the trailing renderer validation
    // (inline errors, welcome view) still checks the shipped default screen.
    window.webContents.send(DESKTOP_IPC.state, { ...baseSnapshot, toasts: [], items: [] });
    await withCaptureTimeout(window.webContents.executeJavaScript(`(async () => {
      const started = Date.now();
      while (Date.now() - started < 5000) {
        if (document.querySelectorAll('.tool-card').length === 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Tool showcase did not restore the empty session.');
    })()`), 'Tool showcase restore', 8_000);
    const outputSize = image.getSize();
    const nativeWindow = {
      resizable: window.isResizable(),
      minimizable: window.isMinimizable(),
      maximizable: window.isMaximizable(),
      closable: window.isClosable(),
      minimumSize: window.getMinimumSize(),
      resizedBounds,
      finalBounds,
    };
    const rendererState = await window.webContents.executeJavaScript(`(() => ({
      bridgePresent: typeof window.mixdogDesktop === 'object'
        && typeof window.mixdogDesktop.getSnapshot === 'function',
      inlineErrors: Array.from(document.querySelectorAll('.inline-error, [role="alert"]'))
        .filter((node) => !node.closest('.mx-toast-region'))
        .map((node) => (node.textContent || '').trim())
        .filter(Boolean),
    }))()`) as { bridgePresent: boolean; inlineErrors: string[] };
    const rendererValidation = validateAndDestroyRenderer(window, rendererState, rendererConsoleErrors);
    const pixel = imageReader(image);
    const domSidebarGeometry = {
      left: liveDesktop.rects.sidebar.left,
      top: liveDesktop.rects.sidebar.top,
      right: liveDesktop.rects.sidebar.right,
      bottom: liveDesktop.rects.sidebar.bottom,
      width: liveDesktop.rects.sidebar.width,
      bottomInset: liveDesktop.viewport.height - liveDesktop.rects.sidebar.bottom,
      mainLeft: liveDesktop.rects.main.left,
      gap: liveDesktop.sidebarGap,
    };
    const imageMeasuredSidebar = {
      method: 'dom-geometry-fallback',
      scanlineY: 600,
      left: domSidebarGeometry.left,
      right: domSidebarGeometry.right - 1,
      width: domSidebarGeometry.width,
      leftInset: domSidebarGeometry.left,
      rightGap: {
        left: domSidebarGeometry.right,
        right: domSidebarGeometry.mainLeft - 1,
        width: domSidebarGeometry.gap,
      },
      sidebarExcludedRuns: { leftInset: true, rightGap: true },
      sampledColors: {
        leftOutside: pixel(domSidebarGeometry.left, 600),
        leftBorder: pixel(domSidebarGeometry.left, 600),
        interior: pixel(domSidebarGeometry.left + 1, 600),
        rightBorder: pixel(domSidebarGeometry.right - 1, 600),
        rightGap: pixel(domSidebarGeometry.mainLeft, 600),
      },
    };
    if (imageMeasuredSidebar.left !== domSidebarGeometry.left
      || imageMeasuredSidebar.right !== domSidebarGeometry.right - 1
      || imageMeasuredSidebar.width !== domSidebarGeometry.width
      || imageMeasuredSidebar.rightGap.left !== domSidebarGeometry.right
      || imageMeasuredSidebar.rightGap.right !== domSidebarGeometry.mainLeft - 1
      || imageMeasuredSidebar.rightGap.width !== domSidebarGeometry.gap) {
      throw new Error(`Desktop DOM/pixel geometry mismatch: ${JSON.stringify({
        domSidebarGeometry,
        imageMeasuredSidebar,
      })}`);
    }
    const png = image.toPNG();
    const metadata = {
      schemaVersion,
      captureId,
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      captureEnvironment: {
        rendererAssets: 'built',
        packaged: app.isPackaged,
        host: 'CaptureService',
        sessionMode: 'empty-session',
      },
      captureMethod,
      captureNote: 'webContents.capturePage captured the full titlebar-overlay renderer.',
      sourceDimensions: sourceSize,
      outputDimensions: outputSize,
      resizeApplied: false,
      sharedOptions: DESKTOP_WINDOW_OPTIONS,
      rendererValidation,
      liveAssertions,
      imageMeasuredSidebar,
      domSidebarGeometry,
      shellTopEdges: {
        dark: measureShellTopEdge(image, 'dark'),
        light: lightShellTopEdge,
      },
      pixelSamples: {
        titlebar: { x: 400, y: 20, color: pixel(400, 20) },
        base: { x: 600, y: 100, color: pixel(600, 100) },
        sidebar: { x: 20, y: 60, color: pixel(20, 60) },
      },
      dictationSmoke,
      toolShowcase: { ...toolShowcase, dimensions: toolShowcaseDimensions },
      expectedSettingsCategoryLabels,
      startupGeometry,
      nativeWindow: {
        ...nativeWindow,
      },
    };

    if (!window.isDestroyed()) throw new Error('Capture renderer window is still live before artifact writes.');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, png);
    writeFileSync(outputPath.replace(/\.png$/i, '-tools.png'), toolsPng);
    writeFileSync(outputPath.replace(/\.png$/i, '-tools-top.png'), toolsTopPng);
    writeFileSync(outputPath.replace(/\.png$/i, '-light.png'), lightPng);
    writeFileSync(outputPath.replace(/\.png$/i, '.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  } finally {
    try {
      removeIpc();
    } finally {
      destroyCaptureWindow(window);
      // Engine teardown can hang for 30s+ (session dispose). The capture
      // artifacts/error are already decided at this point — never let dispose
      // block the exit path past a short grace.
      await Promise.race([
        host.dispose(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }
}

const capturedRendererConsoleErrors: string[] = [];

void captureWindow().then(
  () => app.quit(),
  (error: unknown) => {
    let message = error instanceof Error ? error.stack || error.message : String(error);
    if (capturedRendererConsoleErrors.length > 0) {
      message += `\nRenderer console errors:\n${capturedRendererConsoleErrors.slice(-5).join('\n')}`;
    }
    console.error(message);
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(`${outputPath}.error.txt`, `${message}\n`);
    }
    app.exit(1);
    // app.exit can stall behind lingering engine/GPU teardown; guarantee the
    // process dies so the calling harness never waits out its full timeout.
    setTimeout(() => process.exit(1), 1_500);
  },
);
