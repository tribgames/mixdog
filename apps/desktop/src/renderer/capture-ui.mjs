import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const timeoutMs = Number.parseInt(process.env.MIXDOG_CAPTURE_TIMEOUT_MS || "30000", 10);
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
await stat(captureEntry);
const startedAt = Date.now();

try {
  const exitCode = await new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(electronPath, [captureEntry, windowOutput, captureId], {
      env: {
        ...process.env,
        MIXDOG_CAPTURE_USER_DATA: userData,
        MIXDOG_HOME: isolatedHome,
        MIXDOG_DATA_DIR: join(isolatedHome, "data"),
        MIXDOG_RUNTIME_ROOT: isolatedRuntimeRoot,
      },
      stdio: "inherit",
      windowsHide: false,
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`Capture timed out after ${timeoutMs}ms.`);
      const terminate = () => {
        child.kill();
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
  // Matches DESKTOP_BACKGROUND_COLOR in src/main/window-options.ts — the
  // overlay is composited against the custom dark titlebar, not transparent.
  assert.equal(metadata.sharedOptions.titleBarOverlay.color, "#080808");
  assert.equal(metadata.sharedOptions.titleBarOverlay.symbolColor, "#e5e5e5");
  assert.equal(metadata.sharedOptions.backgroundColor, "#080808");
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
      sidebarTop: 42,
      sidebarWidth: 286,
      sidebarBottomInset: 8,
      sidebarGap: 8,
      mainLeft: 302,
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
  for (const placement of Object.values(metadata.liveAssertions.settings)) {
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
  assert.equal(
    metadata.imageMeasuredSidebar.method,
    metadata.captureMethod === "desktopCapturer" ? "horizontal-pixel-scan" : "dom-geometry-fallback",
  );
  assert.equal(metadata.imageMeasuredSidebar.scanlineY, 600);
  assert.equal(metadata.imageMeasuredSidebar.left, 8);
  assert.equal(metadata.imageMeasuredSidebar.right, 293);
  assert.equal(metadata.imageMeasuredSidebar.width, 286);
  assert.equal(metadata.imageMeasuredSidebar.leftInset, 8);
  assert.deepEqual(metadata.imageMeasuredSidebar.rightGap, { left: 294, right: 301, width: 8 });
  assert.deepEqual(metadata.imageMeasuredSidebar.sidebarExcludedRuns, { leftInset: true, rightGap: true });
  assert.deepEqual(metadata.domSidebarGeometry, {
    left: 8,
    top: 42,
    right: 294,
    bottom: 679,
    width: 286,
    bottomInset: 8,
    mainLeft: 302,
    gap: 8,
  });
  assert.equal(metadata.imageMeasuredSidebar.left, metadata.domSidebarGeometry.left);
  assert.equal(metadata.imageMeasuredSidebar.right, metadata.domSidebarGeometry.right - 1);
  assert.equal(metadata.imageMeasuredSidebar.width, metadata.domSidebarGeometry.width);
  assert.equal(metadata.imageMeasuredSidebar.rightGap.left, metadata.domSidebarGeometry.right);
  assert.equal(metadata.imageMeasuredSidebar.rightGap.right, metadata.domSidebarGeometry.mainLeft - 1);
  assert.equal(metadata.imageMeasuredSidebar.rightGap.width, metadata.domSidebarGeometry.gap);
  assert.equal(metadata.imageMeasuredSidebar.sampledColors.interior, "#1b1b1e");
  assert.equal(
    metadata.imageMeasuredSidebar.sampledColors.leftBorder,
    metadata.imageMeasuredSidebar.sampledColors.rightBorder,
  );
  const assertShellTopEdge = (sample, { band, hairline, sheet }) => {
    assert.equal(sample.yStart, 36);
    assert.equal(sample.yEnd, 44);
    assert.deepEqual(
      sample.colors,
      [band, band, band, band, band, hairline, sheet, sheet, sheet],
      `${sample.theme} shell top edge must show the window band, hairline, then sheet.`,
    );
  };
  const capturePage = metadata.captureMethod === "webContents.capturePage";
  assertShellTopEdge(metadata.shellTopEdges.dark, capturePage
    ? { band: "#080808", hairline: "#212121", sheet: "#161616" }
    : { band: "#181212", hairline: "#514f53", sheet: "#1b1b1e" });
  // The light palette is injected from the bundled TUI registry regardless of
  // capture method, so the sampled band/hairline/sheet are the real light
  // colors (the old capture-page branch predated renderer palette injection).
  assertShellTopEdge(metadata.shellTopEdges.light, { band: "#f6f8fa", hairline: "#c8cfd4", sheet: "#ffffff" });
  assert.equal(metadata.pixelSamples.titlebar.color, capturePage ? "#080808" : "#181212");
  assert.equal(metadata.pixelSamples.base.color, capturePage ? "#161616" : "#1b1b1e");
  assert.equal(metadata.pixelSamples.sidebar.color, capturePage ? "#161616" : "#1b1b1e");
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
} finally {
  await rm(userData, { recursive: true, force: true });
}
