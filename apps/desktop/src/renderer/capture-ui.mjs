import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const captureEntry = join(here, "../../out/main/capture-window.js");
const windowOutput = join(here, "../../artifacts/mixdog-desktop-window-1113x687.png");
const metadataOutput = windowOutput.replace(/\.png$/i, ".json");
const timeoutMs = Number.parseInt(process.env.MIXDOG_CAPTURE_TIMEOUT_MS || "30000", 10);
const userData = await mkdtemp(join(tmpdir(), "mixdog-capture-"));
const captureId = randomUUID();

await rm(windowOutput, { force: true });
await rm(metadataOutput, { force: true });
await stat(captureEntry);
const startedAt = Date.now();

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [captureEntry, windowOutput, captureId], {
      env: { ...process.env, MIXDOG_CAPTURE_USER_DATA: userData },
      stdio: "inherit",
      windowsHide: false,
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Capture timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`Capture exited on signal ${signal}.`));
      else resolve(code);
    });
  });
  assert.equal(exitCode, 0, `Capture exited with code ${exitCode}.`);
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
  assert.equal(metadata.captureMethod, "desktopCapturer");
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
      sidebarTop: 36,
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
  assert.equal(metadata.imageMeasuredSidebar.method, "horizontal-pixel-scan");
  assert.equal(metadata.imageMeasuredSidebar.scanlineY, 600);
  assert.equal(metadata.imageMeasuredSidebar.left, 8);
  assert.equal(metadata.imageMeasuredSidebar.right, 293);
  assert.equal(metadata.imageMeasuredSidebar.width, 286);
  assert.equal(metadata.imageMeasuredSidebar.leftInset, 8);
  assert.deepEqual(metadata.imageMeasuredSidebar.rightGap, { left: 294, right: 301, width: 8 });
  assert.deepEqual(metadata.imageMeasuredSidebar.sidebarExcludedRuns, { leftInset: true, rightGap: true });
  assert.deepEqual(metadata.domSidebarGeometry, {
    left: 8,
    top: 36,
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
  assert.ok(
    ["#3a383a", "#3b393b"].includes(metadata.imageMeasuredSidebar.sampledColors.leftOutside),
    "Sidebar left inset is not the base surface or its one-step native edge blend.",
  );
  assert.equal(metadata.imageMeasuredSidebar.sampledColors.rightGap, "#3a383a");
  assert.equal(metadata.pixelSamples.titlebar.color, "#181212");
  assert.equal(metadata.pixelSamples.base.color, "#1b1b1e");
  assert.equal(metadata.pixelSamples.sidebar.color, "#1b1b1e");
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
