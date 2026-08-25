import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const captureEntry = join(here, "../../out/main/capture-window.js");
const windowOutput = join(here, "../../artifacts/mixdog-desktop-window-1113x687.png");
const metadataOutput = windowOutput.replace(/\.png$/i, ".json");
const errorOutput = `${windowOutput}.error.txt`;
const jitterProbeOutput = join(here, "../../artifacts/jitter-probe.json");
const jitterEntryMode = process.env.MIXDOG_JITTER_PROBE === "entry";
const jitterKeysMode = process.env.MIXDOG_JITTER_PROBE === "keys";
const jitterSwitchMode = process.env.MIXDOG_JITTER_PROBE === "switch";
// Diagnosis pass: measure transcript stability across a real window-width
// drag. Reports only — the metrics are read by a human while chasing a jump.
const jitterWidthMode = process.env.MIXDOG_JITTER_PROBE === "width";
const jitterProbeMode = process.env.MIXDOG_JITTER_PROBE === "1"
  || jitterEntryMode || jitterKeysMode || jitterSwitchMode || jitterWidthMode;
const timeoutMs = Number.parseInt(process.env.MIXDOG_CAPTURE_TIMEOUT_MS || "30000", 10);
const captureOwnerFile = "capture-owner.json";
const captureHeartbeatMs = 5_000;
const legacyCaptureStaleMs = 15 * 60 * 1000;
const liveOwnerMaxStaleMs = 24 * 60 * 60 * 1000;

function pathIsInside(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}

function capturePostmasterPid(userDataRoot) {
  try {
    const raw = readFileSync(
      join(userDataRoot, "mixdog-home", "data", "pgdata", "postmaster.pid"),
      "utf8",
    );
    const pid = Number.parseInt(raw.split(/\r?\n/, 1)[0], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function capturePgCtl(userDataRoot) {
  const runtimeBase = join(userDataRoot, "mixdog-home", "data", "runtime");
  const executable = process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl";
  const candidates = [];
  try {
    const version = readFileSync(join(runtimeBase, "active-version"), "utf8").trim();
    if (version) candidates.push(join(runtimeBase, `runtime-${version}`, "bin", executable));
  } catch {}
  try {
    for (const entry of readdirSync(runtimeBase, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("runtime-")) {
        candidates.push(join(runtimeBase, entry.name, "bin", executable));
      }
    }
  } catch {}
  return candidates.find((candidate) => existsSync(candidate) && pathIsInside(userDataRoot, candidate)) || null;
}

function captureProcessPath(pid) {
  try {
    if (process.platform === "win32") {
      const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ExecutablePath`;
      return execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    }
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/exe`);
    return execFileSync(
      "ps",
      ["-o", "comm=", "-p", String(pid)],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    ).trim();
  } catch {
    return "";
  }
}

// PostgreSQL daemonizes outside Electron's process tree. Always stop the
// instance by its isolated pgdata before deleting a capture profile; if
// pg_ctl is unavailable, force-stop only a PID whose executable resolves
// inside that exact profile.
function stopCapturePostgresSync(userDataRoot) {
  const pid = capturePostmasterPid(userDataRoot);
  if (!pid) return false;
  const pgdata = join(userDataRoot, "mixdog-home", "data", "pgdata");
  const pgctl = capturePgCtl(userDataRoot);
  if (pgctl) {
    try {
      execFileSync(pgctl, ["stop", "-m", "fast", "-w", "-D", pgdata], {
        timeout: 12_000,
        windowsHide: true,
        stdio: "ignore",
      });
      return true;
    } catch {}
  }
  const executable = captureProcessPath(pid);
  if (!executable || !pathIsInside(userDataRoot, executable)) return false;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        timeout: 8_000,
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
    return true;
  } catch {
    return false;
  }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// A hard-killed capture cannot run its own finally block. The next capture
// reclaims profiles whose owner is dead, while retaining fresh or merely
// suspended live owners. Legacy unowned profiles receive a conservative age
// grace so concurrent captures from older builds are never interrupted.
async function sweepStaleCaptureProfiles(now = Date.now()) {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith("mixdog-capture-")) return;
    const profile = join(tmpdir(), entry.name);
    let owner = null;
    let ageMs = 0;
    try {
      const ownerPath = join(profile, captureOwnerFile);
      owner = JSON.parse(await readFile(ownerPath, "utf8"));
      ageMs = now - (await stat(ownerPath)).mtimeMs;
    } catch {
      try { ageMs = now - (await stat(profile)).mtimeMs; } catch { return; }
    }
    const ownerPid = Number(owner?.pid);
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      if (pidIsAlive(ownerPid) && ageMs <= liveOwnerMaxStaleMs) return;
    } else if (ageMs <= legacyCaptureStaleMs) {
      return;
    }
    stopCapturePostgresSync(profile);
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {}
  }));
}

await sweepStaleCaptureProfiles();
const userData = await mkdtemp(join(tmpdir(), `mixdog-capture-${process.pid}-`));
const ownerPath = join(userData, captureOwnerFile);
const writeOwnerHeartbeat = () => writeFile(
  ownerPath,
  `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  "utf8",
).catch(() => {});
await writeOwnerHeartbeat();
const ownerHeartbeat = setInterval(() => { void writeOwnerHeartbeat(); }, captureHeartbeatMs);
ownerHeartbeat.unref?.();
let activeCaptureChild = null;
// Last-resort self-destruct: if any cleanup/teardown path wedges past the
// capture deadline (locked temp profiles, zombie Electron descendants), kill
// this process outright so the calling shell never waits out its own
// deadline. unref'd — never delays a normal exit.
const hardExitWatchdog = setTimeout(() => {
  console.error(`[capture-ui] hard-exit watchdog fired ${timeoutMs + 30_000}ms after start; forcing exit 3.`);
  clearInterval(ownerHeartbeat);
  stopCapturePostgresSync(userData);
  if (activeCaptureChild?.pid) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(activeCaptureChild.pid), "/T", "/F"], {
          timeout: 8_000,
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        activeCaptureChild.kill("SIGKILL");
      }
    } catch {}
  }
  try { rmSync(userData, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch {}
  process.exit(3);
}, timeoutMs + 30_000);
if (typeof hardExitWatchdog.unref === "function") hardExitWatchdog.unref();
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
    return new Promise((resolveKill) => {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        timeout: 8_000,
        windowsHide: true,
      }, () => resolveKill());
    });
  }
  child.kill("SIGKILL");
  return Promise.resolve();
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
    activeCaptureChild = child;
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`Capture timed out after ${timeoutMs}ms.`);
      const terminate = async () => {
        stopCapturePostgresSync(userData);
        await killCaptureTree(child);
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
      if (activeCaptureChild === child) activeCaptureChild = null;
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
    // Print BEFORE the assertions: a single failing metric must not hide the
    // rest of the measurement run.
    console.log(`JITTER_PROBE_JSON=${jitterProbeOutput}`);
    console.log(`JITTER_PROBE_SUMMARY=${JSON.stringify(summary)}`);
    assert.ok(reportStat.mtimeMs >= startedAt && reportStat.mtimeMs <= Date.now(),
      "Jitter probe output mtime is outside the current run window.");
    if (jitterWidthMode) {
      // Reporting pass only.
    } else if (jitterKeysMode) {
      // Keyboard paging: every press must move the transcript and hold the
      // new offset (no spring-back to where the key started).
      for (const key of ["spaceFromTop", "spaceAgain", "pageDown", "spaceStreaming", "spaceStreamingAgain"]) {
        const pass = summary[key] || {};
        assert.equal(pass.focused, true, `${key}: the transcript must own keyboard focus.`);
        assert.ok(Number(pass.moved) >= Number(pass.clientHeight) / 2,
          `${key}: paging moved only ${pass.moved}px.`);
        assert.ok(Number(pass.snapBack) <= 8,
          `${key}: the transcript sprang back ${pass.snapBack}px after paging.`);
      }
    } else if (jitterSwitchMode) {
      assert.ok(Number(summary.frames) > 0, "rapid switching must produce measured frames.");
      assert.equal(Number(summary.wrongSessionFrames), 0,
        "a target title must never paint with another session's transcript.");
      assert.equal(summary.finalTitle, "Switch C");
      assert.match(String(summary.finalTranscript || ""), /Switch C transcript/);
      assert.equal(summary.panels?.length, 4,
        "left/right panel open/close must all be measured.");
      for (const panel of summary.panels || []) {
        assert.ok(Number(panel.geometryDelta) >= 20,
          `${panel.phase}: workspace geometry did not move with the rail.`);
        assert.ok(Number(panel.postHandoverShift) <= 1,
          `${panel.phase}: workspace moved ${panel.postHandoverShift}px at the final handover.`);
      }
    } else if (jitterEntryMode) {
      const entry = summary.coldEntry || {};
      const reentry = summary.coldReentry || {};
      const diag = summary.coldEntryDiag || {};
      assert.equal(diag.coldVisible, true, "cold history session must be on screen.");
      assert.ok(Number(diag.toolCards) > 0, "cold history session must render tool cards.");
      // Source-shaped fallback blocks stay visible while
      // async Markdown work is pending. They may appear during cold loading,
      // but must be fully promoted after the entry settles.
      assert.equal(Number(diag.settledMarkdownPlainFallbacks), 0,
        "cold history must not retain the plain Markdown fallback after settlement.");
      assert.ok(Number(entry.frames) > 0, "the first-entry pass must produce frames.");
      for (const [label, pass] of [["first entry", entry], ["re-entry", reentry]]) {
        assert.ok(Number(pass.maxDistance) <= 8,
          `${label}: the transcript must land pinned to the bottom.`);
        assert.ok(Number(pass.maxRowShift) <= 2,
          `${label}: the visible rows moved ${pass.maxRowShift}px after entry.`);
        assert.ok(Number(pass.settleMs) <= 200,
          `${label}: a late layout correction landed ${pass.settleMs}ms after entry.`);
      }
      const delayedReview = summary.delayedReview || {};
      assert.equal(delayedReview.appeared, true, "the delayed review bar must appear during the probe.");
      assert.equal(Number(delayedReview.height), 28,
        "the collapsed review bar must retain its readable 28px row.");
      assert.equal(Number(delayedReview.maxOverlap), 0,
        "the delayed review bar must not overlap the transcript viewport.");
      assert.ok(Number(delayedReview.settledThinkingGap) >= 18,
        `the settled review bar left only ${delayedReview.settledThinkingGap}px below thinking.`);
      assert.ok(Number(delayedReview.settledComposerGap) >= 7,
        `the settled review bar left only ${delayedReview.settledComposerGap}px above the composer.`);
      assert.ok(Number(delayedReview.settledMaxDistance) <= 8,
        `the delayed review bar settled ${delayedReview.settledMaxDistance}px off bottom.`);
      assert.ok(Number(delayedReview.correctionFrames) >= 0
        && Number(delayedReview.correctionFrames) <= 1,
        `the delayed review bar needed ${delayedReview.correctionFrames} frames to retain layout.`);
      assert.equal(Number(delayedReview.motion?.reversals), 0,
        "the bottom-stack expansion must not bounce back.");
      assert.ok(Number(delayedReview.motion?.movingFrames) <= 2,
        `the bottom-stack expansion moved across ${delayedReview.motion?.movingFrames} frames.`);
      assert.ok(Number(delayedReview.motion?.maxRowShift) <= 40,
        `the bottom-stack expansion moved rows ${delayedReview.motion?.maxRowShift}px.`);
      assert.ok(Number(delayedReview.motion?.offBottomFrames) <= 1,
        "the delayed review bar must correct its pre-paint layout within one sample.");
      for (const [label, pass, expanded] of [
        ["review expand", summary.reviewExpand || {}, true],
        ["review collapse", summary.reviewCollapse || {}, false],
      ]) {
        assert.equal(pass.clicked, true, `${label}: the review control was not found.`);
        assert.equal(pass.expanded, expanded, `${label}: the review did not reach its target state.`);
        assert.equal(Number(pass.maxOverlap), 0,
          `${label}: the review panel overlapped the transcript viewport.`);
        assert.ok(Number(pass.settledThinkingGap) >= 18,
          `${label}: the settled review panel left only ${pass.settledThinkingGap}px below thinking.`);
        assert.ok(Number(pass.settledComposerGap) >= 7,
          `${label}: the settled review panel left only ${pass.settledComposerGap}px above the composer.`);
        assert.ok(Number(pass.settledMaxDistance) <= 8,
          `${label}: the transcript settled ${pass.settledMaxDistance}px off bottom.`);
        assert.equal(Number(pass.motion?.reversals), 0,
          `${label}: the transcript bounced during the review transition.`);
        assert.ok(Number(pass.motion?.movingFrames) <= 1,
          `${label}: the review disclosure spread geometry over ${pass.motion?.movingFrames} frames.`);
        assert.ok(Number(pass.motion?.offBottomFrames) <= 1,
          `${label}: the review disclosure stayed off-bottom for ${pass.motion?.offBottomFrames} samples.`);
        assert.equal(pass.followingAfter, true,
          `${label}: the review disclosure released transcript auto-follow.`);
        assert.ok(Math.abs(Number(pass.finalDistance)) <= 8,
          `${label}: the review disclosure finished ${pass.finalDistance}px off bottom.`);
      }
      const expandedReentry = summary.expandedToolReentry || {};
      assert.equal(Number(expandedReentry.openTools), 1,
        "a touched tool card must restore its disclosure state after session re-entry.");
      assert.ok(Number(expandedReentry.motion?.maxRowShift) <= 2,
        `expanded-tool re-entry moved rows ${expandedReentry.motion?.maxRowShift}px.`);
      for (const key of [
        "toolTogglePinnedExpand",
        "toolTogglePinnedExpandAgain",
        "toolTogglePinnedCollapse",
      ]) {
        const pass = summary[key] || {};
        assert.equal(pass.clicked, true, `${key}: no tool card was toggled.`);
        assert.equal(pass.openAfter, pass.targetExpanded ? "true" : "false",
          `${key}: the tool disclosure did not reach its target state.`);
        // The disclosure's DOM row, virtual spacer and scroll position must
        // advance in one pre-paint transaction. Waiting for ResizeObserver
        // leaves these values describing different layouts for one frame and
        // can make the follow hook interpret the correction as reader intent.
        assert.ok(Math.abs(Number(pass.rowGeometryError)) <= 1,
          `${key}: the virtual row height missed the card delta by ${pass.rowGeometryError}px.`);
        assert.ok(Math.abs(Number(pass.spaceGeometryError)) <= 1,
          `${key}: the virtual spacer missed the card delta by ${pass.spaceGeometryError}px.`);
        assert.ok(Math.abs(Number(pass.scrollError)) <= 1,
          `${key}: bottom scrollTop missed the height delta by ${pass.scrollError}px.`);
        assert.equal(Number(pass.motion?.reversals), 0,
          `${key}: the toggle bounced ${pass.motion?.reversals} times.`);
        assert.ok(Number(pass.motion?.movingFrames) <= 1,
          `${key}: the toggle moved the transcript across ${pass.motion?.movingFrames} frames.`);
        assert.equal(Number(pass.motion?.offBottomFrames), 0,
          `${key}: the toggle stayed off-bottom for ${pass.motion?.offBottomFrames} samples.`);
        assert.equal(pass.followingAfter, true,
          `${key}: a pinned tool toggle released transcript auto-follow.`);
        assert.ok(Math.abs(Number(pass.finalDistance)) <= 8,
          `${key}: a pinned tool toggle finished ${pass.finalDistance}px off bottom.`);
      }
      const assertDisclosureRoundTrip = (label, first, second) => {
        assert.equal(first.subjectKey, second.subjectKey,
          `${label}: the return toggle targeted a different virtual row.`);
        for (const metric of [
          "scrollDelta",
          "scrollHeightDelta",
          "spaceHeightDelta",
          "rowHeightDelta",
          "cardHeightDelta",
        ]) {
          const error = Number(first[metric]) + Number(second[metric]);
          assert.ok(Math.abs(error) <= 1,
            `${label}: ${metric} returned with ${error}px error.`);
        }
      };
      assertDisclosureRoundTrip(
        "pinned tool disclosure round trip",
        summary.toolTogglePinnedCollapse || {},
        summary.toolTogglePinnedExpandAgain || {},
      );
      const pinnedAppend = summary.toolTogglePinnedAppend || {};
      assert.equal(pinnedAppend.followingAfter, true,
        "output appended after a tool toggle did not retain auto-follow.");
      assert.ok(Math.abs(Number(pinnedAppend.finalDistance)) <= 8,
        `output appended after a tool toggle finished ${pinnedAppend.finalDistance}px off bottom.`);
      for (const key of ["toolToggleExpand", "toolToggleCollapse"]) {
        const pass = summary[key] || {};
        assert.equal(pass.clicked, true, `${key}: no tool card was toggled.`);
        assert.equal(pass.openAfter, pass.targetExpanded ? "true" : "false",
          `${key}: the tool disclosure did not reach its target state.`);
        assert.ok(Math.abs(Number(pass.cardShift)) <= 2,
          `${key}: the toggled tool card moved ${pass.cardShift}px while reading.`);
        assert.ok(Math.abs(Number(pass.scrollError)) <= 1,
          `${key}: the reading scrollTop moved ${pass.scrollError}px.`);
        assert.ok(Math.abs(Number(pass.rowGeometryError)) <= 1,
          `${key}: the virtual row height missed the card delta by ${pass.rowGeometryError}px.`);
        assert.ok(Math.abs(Number(pass.spaceGeometryError)) <= 1,
          `${key}: the virtual spacer missed the card delta by ${pass.spaceGeometryError}px.`);
        assert.equal(Number(pass.motion?.reversals), 0,
          `${key}: the toggle bounced back and forth.`);
        assert.equal(pass.followingAfter, false,
          `${key}: an off-bottom tool toggle unexpectedly resumed auto-follow.`);
      }
      assertDisclosureRoundTrip(
        "reading tool disclosure round trip",
        summary.toolToggleExpand || {},
        summary.toolToggleCollapse || {},
      );
    } else {
    assert.equal(summary.reversals, 0, "followed transcript must not reverse direction while streaming.");
    assert.equal(summary.offBottomFrames, 0, "followed transcript must remain pinned to the bottom.");
    assert.ok(Number(summary.maxDistance) <= 8, "followed transcript drifted away from the bottom.");
    assert.equal(summary.partialFrames, 0,
      "remote resume must never paint the persisted last-user-only transcript.");
    assert.ok(Number(summary.finishFrames) > 0,
      "completion settlement must produce measured frames.");
    assert.equal(summary.finishMissingTailFrames, 0,
      "the visible completion tail must remain mounted throughout settlement.");
    assert.equal(summary.finishWrongTailFrames, 0,
      "hidden completion metadata must never replace the final visible tail anchor.");
    assert.equal(summary.finishOffBottomFrames, 0,
      "completion settlement must remain pinned to the bottom.");
    assert.ok(Number(summary.finishMaxBodyShift) <= 1,
      "completion settlement must not move the final response body.");
    }
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
    host: "CaptureService",
    sessionMode: "empty-session",
  });
  assert.deepEqual(metadata.sourceDimensions, { width: 1113, height: 687 });
  assert.deepEqual(
    { width: metadata.nativeWindow.finalBounds.width, height: metadata.nativeWindow.finalBounds.height },
    { width: 1113, height: 687 },
  );
  assert.deepEqual(metadata.outputDimensions, { width: 1113, height: 687 });
  assert.equal(metadata.resizeApplied, false);
  assert.equal(metadata.sharedOptions.titleBarOverlay.color, "#151518");
  assert.equal(metadata.sharedOptions.titleBarOverlay.symbolColor, "white");
  assert.equal(metadata.sharedOptions.titleBarOverlay.height, 40);
  assert.equal(metadata.sharedOptions.backgroundColor, "#151518");
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
  assert.equal(metadata.liveAssertions.desktop.sidebarGap, 0);
  // Pane title and controls now share the group tab strip; both must remain
  // inside the focused pane and the control cluster owns its right edge.
  {
    const axis = metadata.liveAssertions.desktop.headerAxis;
    const paneLeft = metadata.liveAssertions.desktop.rects.main.left;
    const paneRight = metadata.liveAssertions.desktop.rects.main.right;
    assert.ok(axis.titleLeft >= paneLeft && axis.titleLeft < axis.statusRight,
      `active tab title must stay inside the focused pane (${axis.titleLeft}, ${paneLeft}…${axis.statusRight})`);
    assert.ok(Math.abs(axis.statusRight - (paneRight - 4)) <= 0.5,
      `pane controls must sit 4px inside the focused pane (${axis.statusRight} vs ${paneRight} - 4)`);
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
      sidebarLeft: 0,
      sidebarTop: 41,
      sidebarWidth: 260,
      sidebarBottomInset: 0,
      sidebarGap: 0,
      mainLeft: 260,
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
  assert.equal(metadata.liveAssertions.settings.large.fullBleed, false);
  assert.equal(metadata.liveAssertions.settings.large.dialogClearsWindowControls, true);
  assert.deepEqual(metadata.liveAssertions.settings.compact.viewport, { width: 720, height: 650 });
  assert.equal(metadata.liveAssertions.settings.compact.dialog.width, 720);
  assert.equal(metadata.liveAssertions.settings.compact.dialog.height, 650);
  assert.equal(metadata.liveAssertions.settings.compact.rail.width, 200);
  assert.equal(metadata.liveAssertions.settings.compact.fullBleed, true);
  for (const placement of [
    metadata.liveAssertions.settings.large,
    metadata.liveAssertions.settings.compact,
  ]) {
    assert.equal(placement.centered, true);
    assert.ok(placement.centerDelta.x <= 1);
    assert.ok(placement.centerDelta.y <= 1);
    assert.equal(placement.contentClearsWindowControls, true);
    assert.equal(placement.layerCoversViewport, true);
    assert.equal(placement.dialogFitsViewport, true);
    assert.equal(placement.backdropVisible, true);
    assert.equal(placement.twoPane, true);
    assert.equal(placement.rail.right, placement.pane.left);
  }
  assert.ok(metadata.liveAssertions.settings.large.layerPadding.top
    >= metadata.liveAssertions.settings.large.windowControlsHeight);
  const narrowSettings = metadata.liveAssertions.settings.narrow;
  assert.deepEqual(narrowSettings.viewport, { width: 360, height: 600 });
  assert.equal(narrowSettings.fullScreen, true);
  assert.equal(narrowSettings.railConnected, true);
  assert.equal(narrowSettings.rail.width, 48);
  assert.equal(narrowSettings.railButtonCount, metadata.expectedSettingsCategoryLabels.length);
  assert.equal(narrowSettings.railButtonsAccessible, true);
  assert.equal(narrowSettings.closeTouchTarget, true);
  assert.ok(narrowSettings.rowCount > 0);
  assert.ok(narrowSettings.filledValueControlCount > 0);
  assert.equal(narrowSettings.sharedValueAxis, true);
  assert.equal(narrowSettings.controlsContained, true);
  assert.equal(narrowSettings.controlsRightAligned, true);
  assert.equal(narrowSettings.labelsSeparated, true);
  assert.equal(narrowSettings.valuesFillColumn, true);
  assert.equal(narrowSettings.overflowFree, true);
  assert.deepEqual(
    narrowSettings.categories.map((category) => category.label),
    metadata.expectedSettingsCategoryLabels,
  );
  for (const category of narrowSettings.categories) {
    assert.equal(category.overflowFree, true, `${category.label} narrow settings must not overflow`);
    assert.equal(category.controlsContained, true, `${category.label} narrow controls must stay inside rows`);
    assert.equal(category.controlsRightAligned, true, `${category.label} narrow controls must share the row edge`);
    assert.equal(category.labelsSeparated, true, `${category.label} narrow labels must not overlap controls`);
  }
  assert.equal(
    metadata.imageMeasuredSidebar.method,
    metadata.captureMethod === "desktopCapturer" ? "horizontal-pixel-scan" : "dom-geometry-fallback",
  );
  assert.equal(metadata.imageMeasuredSidebar.scanlineY, 600);
  assert.equal(metadata.imageMeasuredSidebar.left, 0);
  assert.equal(metadata.imageMeasuredSidebar.right, 259);
  assert.equal(metadata.imageMeasuredSidebar.width, 260);
  assert.equal(metadata.imageMeasuredSidebar.leftInset, 0);
  assert.deepEqual(metadata.imageMeasuredSidebar.rightGap, { left: 260, right: 259, width: 0 });
  assert.deepEqual(metadata.imageMeasuredSidebar.sidebarExcludedRuns, { leftInset: true, rightGap: true });
  assert.deepEqual(metadata.domSidebarGeometry, {
    left: 0,
    top: 41,
    right: 260,
    bottom: 687,
    width: 260,
    bottomInset: 0,
    mainLeft: 260,
    gap: 0,
  });
  assert.equal(metadata.imageMeasuredSidebar.left, metadata.domSidebarGeometry.left);
  assert.equal(metadata.imageMeasuredSidebar.right, metadata.domSidebarGeometry.right - 1);
  assert.equal(metadata.imageMeasuredSidebar.width, metadata.domSidebarGeometry.width);
  assert.equal(metadata.imageMeasuredSidebar.rightGap.left, metadata.domSidebarGeometry.right);
  assert.equal(metadata.imageMeasuredSidebar.rightGap.right, metadata.domSidebarGeometry.mainLeft - 1);
  assert.equal(metadata.imageMeasuredSidebar.rightGap.width, metadata.domSidebarGeometry.gap);
  assert.equal(metadata.imageMeasuredSidebar.sampledColors.interior, "#151518");
  assert.equal(metadata.imageMeasuredSidebar.sampledColors.leftBorder, "#151518");
  assert.equal(metadata.imageMeasuredSidebar.sampledColors.rightGap, "#1c1c1f");
  const assertShellTopEdge = (sample, { band, sheet }) => {
    assert.equal(sample.yStart, 70);
    assert.equal(sample.yEnd, 82);
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
  assertShellTopEdge(metadata.shellTopEdges.dark, { band: "#151518", sheet: "#1c1c1f" });
  assertShellTopEdge(metadata.shellTopEdges.light, { band: "#f0f0f0", sheet: "#fafafa" });
  assert.equal(metadata.pixelSamples.titlebar.color, "#151518");
  assert.equal(metadata.pixelSamples.base.color, "#1c1c1f");
  assert.equal(metadata.pixelSamples.sidebar.color, "#151518");
  // Dictation E2E (stubbed setup + fake Chromium mic + stubbed transcription):
  // the install consent must precede recording, then the transcript must land.
  assert.equal(metadata.dictationSmoke.installPromptShown, true,
    'dictation smoke must ask before installing the voice runtime');
  assert.equal(metadata.dictationSmoke.transcriptApplied, true,
    'dictation smoke must append the stubbed transcript to the draft');
  assert.equal(metadata.dictationSmoke.micIdle, true, 'mic button must settle back to idle');
  assert.equal(metadata.dictationSmoke.notice, '', 'dictation smoke must not raise a composer notice');
  // Tool presentation E2E: every card archetype renders through the real
  // transcript renderer. Cards intentionally stay collapsed; live shell
  // output and diff bodies must never auto-grow the transcript.
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
  assert.equal(metadata.toolShowcase.collapsedCards, 4, "tool cards must default to collapsed");
  assert.equal(metadata.toolShowcase.detailRows, 0, "collapsed tool cards must not mount detail rows");
  assert.equal(metadata.toolShowcase.failedCards, 1, "failed shell card must carry the failed state");
  assert.equal(metadata.toolShowcase.settledCards, 3, "completed cards must settle; the running card must not");
  assert.equal(metadata.toolShowcase.reviewBar, true, "turn review bar must summarize the edit diff");
  assert.equal(metadata.toolShowcase.runningCommandVisible, true,
    "running shell card header must surface the bare command");
  assert.equal(metadata.toolShowcase.runningStatusVisible, true,
    "running shell card must expose an accessible running status");
  assert.equal(metadata.toolShowcase.editInputBlocks, 0,
    "collapsed edit cards must not mount a raw Input block");
  assert.equal(metadata.toolShowcase.legacyBodyBlocks, 0,
    "collapsed cards must not mount legacy shell, diff, or live-output bodies");
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
  clearInterval(ownerHeartbeat);
  clearTimeout(hardExitWatchdog);
  stopCapturePostgresSync(userData);
  if (activeCaptureChild) await killCaptureTree(activeCaptureChild);
  // Electron's crashpad handler can hold DIPS/lock files for a short window
  // after process exit; EBUSY here must not fail an otherwise green capture.
  try {
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    console.warn(`capture-ui: temp profile cleanup deferred (${error?.code || error}): ${userData}`);
  }
}
