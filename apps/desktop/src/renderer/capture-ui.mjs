import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const captureEntry = join(here, "../../out/main/capture-window.js");
const windowOutput = join(here, "../../artifacts/mixdog-desktop-window-1113x687.png");
const metadataOutput = windowOutput.replace(/\.png$/i, ".json");
const errorOutput = `${windowOutput}.error.txt`;
const jitterProbeOutput = join(here, "../../artifacts/jitter-probe.json");
const jitterProbeMode = process.env.MIXDOG_JITTER_PROBE === "1";
const timeoutMs = Number.parseInt(process.env.MIXDOG_CAPTURE_TIMEOUT_MS || "30000", 10);
// Last-resort self-destruct: if any cleanup/teardown path wedges past the
// capture deadline (locked temp profiles, zombie Electron descendants), kill
// this process outright so the calling shell never waits out its own
// deadline. unref'd — never delays a normal exit.
const hardExitWatchdog = setTimeout(() => {
  console.error(`[capture-ui] hard-exit watchdog fired ${timeoutMs + 30_000}ms after start; forcing exit 3.`);
  process.exit(3);
}, timeoutMs + 30_000);
if (typeof hardExitWatchdog.unref === "function") hardExitWatchdog.unref();
const userData = await mkdtemp(join(tmpdir(), "mixdog-capture-"));
// Full shared-state isolation: the capture engine must never touch the real
// ~/.mixdog home or the machine-shared runtime root (%TMP%/mixdog). A capture
// session that registers itself there is discovered by the live channel
// worker, which rebinds its transcript forwarder to the capture session and
// silently stops Discord forwarding for the user's real session.
const isolatedHome = join(userData, "mixdog-home");
const isolatedRuntimeRoot = join(userData, "mixdog-runtime");
const captureId = randomUUID();

await rm(windowOutput, { force: true });
await rm(metadataOutput, { force: true });
await rm(errorOutput, { force: true });
if (jitterProbeMode) await rm(jitterProbeOutput, { force: true });
await stat(captureEntry);
const startedAt = Date.now();

// child.kill() only signals the top-level Electron launcher. Its renderer/GPU
// children survive on Windows, keep the inherited stdio pipes open, and wedge
// the calling shell session. Timeouts must always reap the full process tree.
function killCaptureTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
  } else {
    child.kill("SIGKILL");
  }
}

try {
  const exitCode = await new Promise((resolve, reject) => {
    let settled = false;
    // stdio must never be "inherit": surviving Electron grandchildren
    // (crashpad) would hold the calling shell's pipe handles and wedge the
    // whole pipeline after a kill. Pipe through this process instead so the
    // pipe always closes when capture-ui exits.
    const child = spawn(electronPath, [captureEntry, windowOutput, captureId], {
      env: {
        ...process.env,
        MIXDOG_CAPTURE_USER_DATA: userData,
        MIXDOG_HOME: isolatedHome,
        MIXDOG_DATA_DIR: join(isolatedHome, "data"),
        MIXDOG_RUNTIME_ROOT: isolatedRuntimeRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`Capture timed out after ${timeoutMs}ms.`);
      const terminate = () => {
        killCaptureTree(child);
        reject(error);
      };
      void writeFile(errorOutput, `${error.message}\n`, "utf8").then(terminate, terminate);
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal) reject(new Error(`Capture exited on signal ${signal}.`));
      else resolve(code);
    });
  });
  assert.equal(exitCode, 0, `Capture exited with code ${exitCode}.`);
  if (jitterProbeMode) {
    const [reportText, reportStat] = await Promise.all([
      readFile(jitterProbeOutput, "utf8"),
      stat(jitterProbeOutput),
    ]);
    const report = JSON.parse(reportText);
    const summary = report?.summary || {};
    assert.ok(reportStat.mtimeMs >= startedAt && reportStat.mtimeMs <= Date.now(),
      "Jitter probe output mtime is outside the current run window.");
    assert.equal(summary.reversals, 0, "followed transcript must not reverse direction while streaming.");
    assert.equal(summary.offBottomFrames, 0, "followed transcript must remain pinned to the bottom.");
    assert.ok(Number(summary.maxDistance) <= 8, "followed transcript drifted away from the bottom.");
    assert.equal(summary.partialFrames, 0,
      "remote resume must never paint the persisted last-user-only transcript.");
    console.log(`JITTER_PROBE_JSON=${jitterProbeOutput}`);
    console.log(`JITTER_PROBE_SUMMARY=${JSON.stringify(summary)}`);
  } else {
  while (true) {
    try {
      await Promise.all([stat(windowOutput), stat(metadataOutput)]);
      break;
    } catch {
      try {
        throw new Error(`Capture child failed:\n${await readFile(errorOutput, "utf8")}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Capture artifacts were not produced within ${timeoutMs}ms.`);
      }
      await delay(50);
    }
  }
  const completedAt = Date.now();

  const [png, metadataText, pngStat, metadataStat] = await Promise.all([
    readFile(windowOutput),
    readFile(metadataOutput, "utf8"),
    stat(windowOutput),
    stat(metadataOutput),
  ]);
  assert.ok(
    pngStat.mtimeMs >= startedAt && pngStat.mtimeMs <= completedAt
      && metadataStat.mtimeMs >= startedAt && metadataStat.mtimeMs <= completedAt,
    "Capture output mtimes are outside the current run window.",
  );
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], "Capture is not a PNG.");
  assert.equal(png.readUInt32BE(16), 1113, "Capture width is not 1113.");
  assert.equal(png.readUInt32BE(20), 687, "Capture height is not 687.");

  const metadata = JSON.parse(metadataText);
  const capturedAt = Date.parse(metadata.capturedAt);
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.captureId, captureId);
  assert.ok(
    Number.isFinite(capturedAt) && capturedAt >= startedAt && capturedAt <= completedAt,
    "capturedAt is outside the current run window.",
  );
  assert.ok(["desktopCapturer", "webContents.capturePage"].includes(metadata.captureMethod));
  assert.deepEqual(metadata.captureEnvironment, {
    rendererAssets: "built",
    packaged: false,
    host: "CaptureEngineHost",
    sessionMode: "empty-session",
  });
  assert.deepEqual(metadata.sourceDimensions, { width: 1113, height: 687 });
  assert.deepEqual(
    { width: metadata.nativeWindow.finalBounds.width, height: metadata.nativeWindow.finalBounds.height },
    { width: 1113, height: 687 },
  );
  assert.deepEqual(metadata.outputDimensions, { width: 1113, height: 687 });
  assert.equal(metadata.resizeApplied, false);
  assert.equal(metadata.sharedOptions.titleBarOverlay.color, "#00000000");
  assert.equal(metadata.sharedOptions.titleBarOverlay.symbolColor, "white");
  assert.equal(metadata.sharedOptions.titleBarOverlay.height, 40);
  assert.equal(metadata.sharedOptions.backgroundColor, "#201e1c");
  assert.deepEqual(metadata.rendererValidation, {
    bridgePresent: true,
    inlineErrorCount: 0,
    consoleErrorCount: 0,
  });
  assert.deepEqual(metadata.liveAssertions.desktop.visible, {
    modelTrigger: true,
    textarea: true,
    send: true,
  });
  assert.equal(metadata.liveAssertions.desktop.labelsAbsent, true);
  assert.equal(metadata.liveAssertions.desktop.hiddenLabelsAbsent, true);
  assert.deepEqual(metadata.liveAssertions.desktop.removedLabelMatches, []);
  assert.equal(metadata.liveAssertions.desktop.contextChipCount, 0);
  assert.equal(metadata.liveAssertions.desktop.controlsNonOverlapping, true);
  assert.equal(metadata.liveAssertions.desktop.sidebarGap, 8);
  // Header/composer shared axis: title left and status right sit exactly on
  // the composer field edges (user-flagged drift; now pinned).
  {
    const axis = metadata.liveAssertions.desktop.headerAxis;
    assert.ok(Math.abs(axis.titleLeft - axis.composerLeft) <= 0.5,
      `header title must sit on the composer left edge (${axis.titleLeft} vs ${axis.composerLeft})`);
    assert.ok(Math.abs(axis.statusRight - axis.composerRight) <= 0.5,
      `header status must sit on the composer right edge (${axis.statusRight} vs ${axis.composerRight})`);
  }
  assert.equal(metadata.liveAssertions.lightTheme.theme, "light");
  assert.equal(metadata.liveAssertions.lightTheme.colorScheme, "light");
  assert.equal(metadata.liveAssertions.lightTheme.titlebarIconMatchesToken, true);
  assert.equal(metadata.liveAssertions.lightTheme.activeTabMatchesToken, true);
  assert.equal(metadata.liveAssertions.modalStack.toastParentIsBody, true);
  assert.equal(metadata.liveAssertions.modalStack.toastVisible, true);
  assert.equal(metadata.liveAssertions.modalStack.toastOutsideInertTree, true);
  assert.equal(metadata.liveAssertions.modalStack.toastAboveModal, true);
  assert.ok(metadata.liveAssertions.modalStack.toastZIndex > metadata.liveAssertions.modalStack.modalZIndex);
  assert.deepEqual(
    {
      sidebarLeft: metadata.liveAssertions.desktop.rects.sidebar.left,
      sidebarTop: metadata.liveAssertions.desktop.rects.sidebar.top,
      sidebarWidth: metadata.liveAssertions.desktop.rects.sidebar.width,
      sidebarBottomInset: metadata.liveAssertions.desktop.viewport.height
        - metadata.liveAssertions.desktop.rects.sidebar.bottom,
      sidebarGap: metadata.liveAssertions.desktop.sidebarGap,
      mainLeft: metadata.liveAssertions.desktop.rects.main.left,
    },
    {
      sidebarLeft: 8,
      sidebarTop: 40,
      sidebarWidth: 260,
      sidebarBottomInset: 8,
      sidebarGap: 8,
      mainLeft: 276,
    },
  );
  assert.ok(metadata.liveAssertions.mobile.viewport.width <= 760);
  assert.equal(metadata.liveAssertions.mobile.breakpointActive, true);
  assert.equal(metadata.liveAssertions.mobile.open.sidebarVisible, true);
  assert.equal(metadata.liveAssertions.mobile.open.backdropVisible, true);
  assert.equal(metadata.liveAssertions.mobile.open.sidebarComputedVisible, true);
  assert.equal(metadata.liveAssertions.mobile.open.backdropComputedVisible, true);
  assert.equal(metadata.liveAssertions.mobile.open.sidebarIntersectsViewport, true);
  assert.equal(metadata.liveAssertions.mobile.open.backdropIntersectsViewport, true);
  assert.notEqual(metadata.liveAssertions.mobile.open.sidebarStyle.display, "none");
  assert.notEqual(metadata.liveAssertions.mobile.open.backdropStyle.display, "none");
  assert.notEqual(metadata.liveAssertions.mobile.open.sidebarStyle.visibility, "hidden");
  assert.notEqual(metadata.liveAssertions.mobile.open.backdropStyle.visibility, "hidden");
  assert.ok(metadata.liveAssertions.mobile.open.sidebarStyle.opacity > 0);
  assert.ok(metadata.liveAssertions.mobile.open.backdropStyle.opacity > 0);
  assert.equal(metadata.liveAssertions.mobile.closed.sidebarHidden, true);
  assert.equal(metadata.liveAssertions.mobile.closed.mainVisible, true);
  assert.equal(metadata.liveAssertions.mobile.closed.mainMatchesViewport, true);
  assert.equal(metadata.liveAssertions.mobile.closed.viewportEdgeTolerance, 1);
  assert.ok(Object.values(metadata.liveAssertions.mobile.closed.mainEdgeDeltas)
    .every((delta) => delta <= metadata.liveAssertions.mobile.closed.viewportEdgeTolerance));
  assert.equal(metadata.liveAssertions.mobile.closed.composerVisible, true);
  assert.equal(metadata.liveAssertions.mobile.closed.composerContained, true);
  assert.equal(metadata.liveAssertions.mobile.closed.modelTriggerVisible, true);
  assert.equal(metadata.liveAssertions.mobile.closed.sendVisible, true);
  assert.equal(metadata.liveAssertions.mobile.closed.sendContained, true);
  assert.equal(metadata.liveAssertions.mobile.closed.controlsNonOverlapping, true);
  assert.deepEqual(metadata.liveAssertions.settings.large.viewport, { width: 1280, height: 820 });
  assert.ok(metadata.liveAssertions.settings.large.populatedRowCount > 0);
  assert.equal(metadata.liveAssertions.settings.large.dialog.width, 980);
  assert.equal(metadata.liveAssertions.settings.large.rail.width, 240);
  assert.deepEqual(metadata.liveAssertions.settings.compact.viewport, { width: 720, height: 650 });
  assert.equal(metadata.liveAssertions.settings.compact.dialog.width, 704);
  assert.equal(metadata.liveAssertions.settings.compact.rail.width, 200);
  for (const placement of [
    metadata.liveAssertions.settings.large,
    metadata.liveAssertions.settings.compact,
  ]) {
    assert.equal(placement.centered, true);
    assert.ok(placement.centerDelta.x <= 1);
    assert.ok(placement.centerDelta.y <= 1);
    assert.ok(placement.layerPadding.top >= placement.windowControlsHeight);
    assert.equal(placement.dialogClearsWindowControls, true);
    assert.equal(placement.layerCoversViewport, true);
    assert.equal(placement.dialogFitsViewport, true);
    assert.equal(placement.backdropVisible, true);
    assert.equal(placement.twoPane, true);
    assert.equal(placement.rail.right, placement.pane.left);
  }
  const phoneSettings = metadata.liveAssertions.settings.phone;
  assert.ok(phoneSettings.viewport.width >= 320 && phoneSettings.viewport.width <= 430);
  assert.equal(phoneSettings.fullScreen, true);
  assert.equal(phoneSettings.railConnected, true);
  assert.equal(phoneSettings.rail.width, 52);
  assert.equal(phoneSettings.railButtonCount, 14);
  assert.equal(phoneSettings.railButtonsAccessible, true);
  assert.equal(phoneSettings.closeTouchTarget, true);
  assert.ok(phoneSettings.rowCount > 0);
  assert.ok(phoneSettings.filledValueControlCount > 0);
  assert.equal(phoneSettings.sharedValueAxis, true);
  assert.equal(phoneSettings.controlsContained, true);
  assert.equal(phoneSettings.controlsRightAligned, true);
  assert.equal(phoneSettings.labelsSeparated, true);
  assert.equal(phoneSettings.valuesFillColumn, true);
  assert.equal(phoneSettings.overflowFree, true);
  assert.deepEqual(phoneSettings.categories.map((category) => category.label), [
    'General', 'Models', 'Workflows', 'Output style', 'Providers', 'Channels',
    'Connection', 'MCP', 'Plugins', 'Hooks', 'Skills', 'Memory', 'System', 'Shortcuts',
  ]);
  for (const category of phoneSettings.categories) {
    assert.equal(category.overflowFree, true, `${category.label} phone settings must not overflow`);
    assert.equal(category.controlsContained, true, `${category.label} controls must stay inside rows`);
    assert.equal(category.controlsRightAligned, true, `${category.label} controls must share the row edge`);
    assert.equal(category.labelsSeparated, true, `${category.label} labels must not overlap controls`);
  }
  assert.equal(
    metadata.imageMeasuredSidebar.method,
    metadata.captureMethod === "desktopCapturer" ? "horizontal-pixel-scan" : "dom-geometry-fallback",
  );
  assert.equal(metadata.imageMeasuredSidebar.scanlineY, 600);
  assert.equal(metadata.imageMeasuredSidebar.left, 8);
  assert.equal(metadata.imageMeasuredSidebar.right, 267);
  assert.equal(metadata.imageMeasuredSidebar.width, 260);
  assert.equal(metadata.imageMeasuredSidebar.leftInset, 8);
  assert.deepEqual(metadata.imageMeasuredSidebar.rightGap, { left: 268, right: 275, width: 8 });
  assert.deepEqual(metadata.imageMeasuredSidebar.sidebarExcludedRuns, { leftInset: true, rightGap: true });
  assert.deepEqual(metadata.domSidebarGeometry, {
    left: 8,
    top: 40,
    right: 268,
    bottom: 679,
    width: 260,
    bottomInset: 8,
    mainLeft: 276,
    gap: 8,
  });
  assert.equal(metadata.imageMeasuredSidebar.left, metadata.domSidebarGeometry.left);
  assert.equal(metadata.imageMeasuredSidebar.right, metadata.domSidebarGeometry.right - 1);
  assert.equal(metadata.imageMeasuredSidebar.width, metadata.domSidebarGeometry.width);
  assert.equal(metadata.imageMeasuredSidebar.rightGap.left, metadata.domSidebarGeometry.right);
  assert.equal(metadata.imageMeasuredSidebar.rightGap.right, metadata.domSidebarGeometry.mainLeft - 1);
  assert.equal(metadata.imageMeasuredSidebar.rightGap.width, metadata.domSidebarGeometry.gap);
  assert.equal(metadata.imageMeasuredSidebar.sampledColors.interior, "#201e1c");
  assert.equal(
    metadata.imageMeasuredSidebar.sampledColors.leftBorder,
    metadata.imageMeasuredSidebar.sampledColors.rightBorder,
  );
  const assertShellTopEdge = (sample, { band, sheet }) => {
    assert.equal(sample.yStart, 34);
    assert.equal(sample.yEnd, 44);
    // The sheet sits flush under the titlebar band. Its .5px elevation ring
    // may antialias into 1-2 blended rows, or disappear entirely under the
    // opaque band — accept a clean edge OR a short blend, never more.
    const colors = sample.colors;
    const firstSheet = colors.indexOf(sheet);
    assert.ok(firstSheet > 0 && firstSheet <= 8, `${sample.theme} shell top edge must reach the sheet within the sample.`);
    const transition = colors.slice(0, firstSheet).filter((color) => color !== band);
    assert.ok(transition.length <= 2,
      `${sample.theme} shell top edge must be a clean or briefly blended band→sheet boundary.`);
    assert.ok(transition.every((color) => color !== sheet && color !== band));
    assert.ok(colors.slice(0, firstSheet - transition.length).every((color) => color === band),
      `${sample.theme} rows above the hairline must stay on the window band.`);
    assert.ok(colors.slice(firstSheet).every((color) => color === sheet),
      `${sample.theme} rows below the hairline must be the workspace sheet.`);
  };
  assertShellTopEdge(metadata.shellTopEdges.dark, { band: "#201e1c", sheet: "#282623" });
  assertShellTopEdge(metadata.shellTopEdges.light, { band: "#f1efec", sheet: "#faf8f5" });
  assert.equal(metadata.pixelSamples.titlebar.color, "#201e1c");
  assert.equal(metadata.pixelSamples.base.color, "#282623");
  assert.equal(metadata.pixelSamples.sidebar.color, "#201e1c");
  // Dictation E2E (fake Chromium mic + stubbed engine transcription): the
  // whole renderer chain must land the transcript in the draft and settle.
  assert.equal(metadata.dictationSmoke.transcriptApplied, true,
    'dictation smoke must append the stubbed transcript to the draft');
  assert.equal(metadata.dictationSmoke.micIdle, true, 'mic button must settle back to idle');
  assert.equal(metadata.dictationSmoke.notice, '', 'dictation smoke must not raise a composer notice');
  // Tool presentation E2E: the injected rich transcript must render every
  // card archetype through the real transcript renderer, and the capture
  // artifact ships alongside the main PNG for visual review.
  const toolsOutput = windowOutput.replace(/\.png$/i, "-tools.png");
  const toolsTopOutput = windowOutput.replace(/\.png$/i, "-tools-top.png");
  const [toolsPng, toolsStat, toolsTopPng, toolsTopStat] = await Promise.all([
    readFile(toolsOutput), stat(toolsOutput), readFile(toolsTopOutput), stat(toolsTopOutput),
  ]);
  assert.ok(toolsStat.mtimeMs >= startedAt && toolsStat.mtimeMs <= completedAt,
    "Tool showcase capture mtime is outside the current run window.");
  assert.deepEqual([...toolsPng.subarray(1, 4)], [0x50, 0x4e, 0x47], "Tool showcase capture is not a PNG.");
  assert.equal(toolsPng.readUInt32BE(16), 1113, "Tool showcase capture width is not 1113.");
  assert.equal(toolsPng.readUInt32BE(20), 687, "Tool showcase capture height is not 687.");
  assert.ok(toolsTopStat.mtimeMs >= startedAt && toolsTopStat.mtimeMs <= completedAt,
    "Tool showcase top capture mtime is outside the current run window.");
  assert.deepEqual([...toolsTopPng.subarray(1, 4)], [0x50, 0x4e, 0x47], "Tool showcase top capture is not a PNG.");
  assert.equal(metadata.toolShowcase.toolCards, 4, "tool showcase must render all four tool cards");
  assert.equal(metadata.toolShowcase.failedCards, 1, "failed shell card must carry the failed state");
  assert.equal(metadata.toolShowcase.settledCards, 3, "completed cards must settle; the running card must not");
  assert.equal(metadata.toolShowcase.shellOutputs, 3,
    "completed shell cards (2) plus the running card's live tail must render command output blocks");
  assert.equal(metadata.toolShowcase.diffFiles, 1, "edit card must render a parsed diff file");
  assert.equal(metadata.toolShowcase.reviewBar, true, "turn review bar must summarize the edit diff");
  assert.equal(metadata.toolShowcase.runningCommandVisible, true,
    "running shell card header must surface the bare command");
  assert.equal(metadata.toolShowcase.editInputBlocks, 0,
    "edit cards with a rendered diff must not show the raw Input JSON block");
  assert.match(metadata.toolShowcase.runningElapsed, /^\d+s$/,
    "running shell card must tick a live elapsed readout");
  assert.equal(metadata.toolShowcase.liveOutputVisible, true,
    "running shell card must stream the live output tail");
  assert.ok(metadata.toolShowcase.liveOutputText.startsWith("$ npm test"),
    "live output must lead with the command line");
  console.log(`CAPTURE_TOOLS_PNG=${toolsOutput}`);
  console.log(`CAPTURE_TOOLS_TOP_PNG=${toolsTopOutput}`);
  console.log(`CAPTURE_STARTUP_GEOMETRY=${JSON.stringify(metadata.startupGeometry?.deltas ?? null)}`);
  console.log(`CAPTURE_PNG=${windowOutput}`);
  console.log(`CAPTURE_JSON=${metadataOutput}`);
  console.log(`CAPTURE_SCHEMA=${metadata.schemaVersion}; CAPTURE_ID=${metadata.captureId}`);
  console.log(`CAPTURED_AT=${metadata.capturedAt}`);
  console.log(`DIMENSIONS=${JSON.stringify({
    source: metadata.sourceDimensions,
    finalBounds: metadata.nativeWindow.finalBounds,
    output: metadata.outputDimensions,
    resizeApplied: metadata.resizeApplied,
  })}`);
  console.log(`IMAGE_SIDEBAR=${JSON.stringify(metadata.imageMeasuredSidebar)}`);
  console.log(`PIXELS=${JSON.stringify(metadata.pixelSamples)}`);
  console.log(`LIVE_ASSERTIONS=${JSON.stringify(metadata.liveAssertions)}`);
  }
} finally {
  // Electron's crashpad handler can hold DIPS/lock files for a short window
  // after process exit; EBUSY here must not fail an otherwise green capture.
  try {
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    console.warn(`capture-ui: temp profile cleanup deferred (${error?.code || error}): ${userData}`);
  }
}
