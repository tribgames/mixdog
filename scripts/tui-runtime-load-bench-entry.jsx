import React from 'react';
import { Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Box, render } from 'ink';

import { Item } from '../src/tui/components/TranscriptItem.jsx';
import { useTranscriptWindow } from '../src/tui/app/use-transcript-window.mjs';
import { createTranscriptWriter } from '../src/runtime/shared/transcript-writer.mjs';
import {
  drainPathSync,
  getBufferedAppenderStats,
  hasInFlightWrite,
} from '../src/runtime/shared/buffered-appender.mjs';

/**
 * Headless TUI/runtime load-regression bench.
 *
 * Each measured frame covers producer state updates, React reconciliation,
 * production transcript windowing, TranscriptItem rendering, Yoga layout,
 * measured-height harvest/re-render, Ink serialization, and the final write
 * callback on a capture TTY. Producer records go through the production
 * transcript writer/appender and the same text is appended to rendered state.
 *
 * Gate precedence is explicit CLI/env override, then the checked-in baseline
 * p95 times a fixed margin, then the 16.67 ms absolute fallback. Warm-up
 * calibration is informational only: a render regression cannot raise its own
 * threshold. Re-record the baseline intentionally with --update-baseline after
 * a hardware/runner change, never as part of an ordinary regression run.
 */
const DEFAULTS = Object.freeze({
  items: 10_000,
  frames: 120,
  producers: 8,
  burst: 12,
  columns: 120,
  viewportRows: 40,
  thresholdFloorMs: 16.67,
  calibrationFrames: 8,
  baselineRegressionMargin: 1.5,
});
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(PROJECT_ROOT, 'bench-results', 'tui-runtime-load-baseline.json');
const identity = (value) => value;
const noop = () => {};

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const prefix = `${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

function positiveInt(name, fallback) {
  const value = Number.parseInt(argValue(name, String(fallback)), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optionalPositiveNumber(name, envName) {
  const cli = argValue(name, null);
  const raw = cli ?? process.env[envName] ?? null;
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}/${envName} must be a positive number`);
  }
  return { value, source: cli != null ? name : envName };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function readPinnedBaselineP95(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const value = Number(parsed?.frame_time?.p95_ms);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function makeTranscriptItems(count) {
  const items = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const id = `history-${index}`;
    switch (index % 10) {
      case 0:
      case 5:
        items[index] = { id, kind: 'user', text: `Investigate session ${index} and preserve behavior.` };
        break;
      case 1:
      case 4:
      case 7:
        items[index] = {
          id,
          kind: 'assistant',
          text: `Completed transcript item ${index}.\n\n- checked runtime state\n- retained ordering`,
          streaming: false,
        };
        break;
      case 2:
      case 6:
      case 8:
        items[index] = {
          id,
          kind: 'tool',
          name: index % 2 ? 'agent' : 'shell',
          args: JSON.stringify({ task_id: `task-${index}`, status: 'completed', path: `src/file-${index % 31}.mjs` }),
          result: `result ${index}: ok`,
          completedCount: 1,
          count: 1,
        };
        break;
      case 3:
        items[index] = { id, kind: 'notice', tone: 'plain', text: `agent session ${index} completed` };
        break;
      default:
        items[index] = { id, kind: 'turndone', elapsedMs: 100 + index };
        break;
    }
  }
  return items;
}

function makeProducer({ writer, lane, burst }) {
  return async function produce(frame) {
    await Promise.resolve();
    const chunks = [];
    let recordCount = 0;
    for (let entry = 0; entry < burst; entry += 1) {
      const text = `lane=${lane} frame=${frame} chunk=${entry} ${'stream '.repeat(6)}\n`;
      writer.appendAssistant(text);
      chunks.push(text);
      recordCount += 1;
    }
    const stateItems = [{
      id: `producer-${lane}-frame-${frame}`,
      kind: 'assistant',
      text: chunks.join(''),
      streaming: false,
    }];
    if (frame % 6 === lane % 6) {
      const command = `producer-${lane}-frame-${frame}`;
      const result = `producer ${lane} frame ${frame} complete`;
      writer.appendToolUse('shell', { command });
      writer.appendToolResult({ stdout: result, exitCode: 0 });
      recordCount += 2;
      stateItems.push({
        id: `producer-tool-${lane}-frame-${frame}`,
        kind: 'tool',
        name: 'shell',
        args: JSON.stringify({ command }),
        result,
        count: 1,
        completedCount: 1,
      });
    }
    return { lane, chunks, recordCount, stateItems };
  };
}

function captureTty(columns, rows) {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      stream.capturedBytes += Buffer.byteLength(chunk);
      stream.writeCalls += 1;
      callback();
    },
  });
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  stream.capturedBytes = 0;
  stream.writeCalls = 0;
  stream.getColorDepth = () => 1;
  stream.hasColors = () => false;
  stream.setRawMode = () => stream;
  return stream;
}

function TranscriptHarness({ settledItems, streamingTail, structureRevision, columns, viewportRows }) {
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const [measuredRowsVersion, setMeasuredRowsVersion] = React.useState(0);
  const transcriptAnchorRef = React.useRef(null);
  const transcriptAnchorDirtyRef = React.useRef(false);
  const scrollTargetRef = React.useRef(0);
  const scrollPositionRef = React.useRef(0);
  const maxScrollRowsRef = React.useRef(0);
  const transcriptGeomRef = React.useRef({});
  const followingRef = React.useRef(true);
  const dragRef = React.useRef({ active: false, rect: null });
  const transcriptViewportRef = React.useRef({ top: 0 });
  const selectionLayoutRef = React.useRef(null);

  const {
    transcriptWindow,
    renderedTranscriptItems,
    transcriptTailPinned,
    transcriptMeasureRef,
  } = useTranscriptWindow({
    items: settledItems,
    structureRevision,
    streamingTail,
    themeEpoch: 0,
    frameColumns: columns,
    toolOutputExpanded: false,
    transcriptContentHeight: viewportRows,
    transcriptBottomSlackRows: 1,
    transcriptGuardRows: 1,
    floatingPanelRows: 0,
    overlayHintRequested: false,
    scrollOffset,
    setScrollOffset,
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    scrollTargetRef,
    scrollPositionRef,
    maxScrollRowsRef,
    transcriptGeomRef,
    followingRef,
    dragRef,
    transcriptViewportRef,
    selectionLayoutRef,
    withSelectionClip: identity,
    paintSelectionRect: noop,
    stopSmoothScroll: noop,
    measuredRowsVersion,
    setMeasuredRowsVersion,
  });

  return (
    <Box flexDirection="column" width={columns} height={viewportRows} overflow="hidden" justifyContent="flex-end">
      <Box
        flexDirection="column"
        width="100%"
        flexShrink={0}
        marginBottom={-transcriptWindow.effectiveScrollOffset}
      >
        {renderedTranscriptItems.map((item, index, all) => {
          const measureRef = transcriptMeasureRef(item);
          const itemNode = (
            <Item
              item={item}
              prevKind={index > 0 ? all[index - 1].kind : null}
              columns={columns}
              toolOutputExpanded={false}
              streamingWindowRows={transcriptTailPinned && item.id === streamingTail?.id
                ? viewportRows + 4
                : 0}
            />
          );
          return measureRef ? (
            <Box key={item.id} ref={measureRef} flexDirection="column" flexShrink={0}>
              {itemNode}
            </Box>
          ) : <React.Fragment key={item.id}>{itemNode}</React.Fragment>;
        })}
        {transcriptWindow.bottomSpacerRows > 0
          ? <Box height={transcriptWindow.bottomSpacerRows} flexShrink={0} />
          : null}
      </Box>
    </Box>
  );
}

async function flushFrame(instance) {
  // The first wait covers the requested React/Ink commit and terminal callback;
  // the second covers a measured-height harvest update scheduled by layout
  // effects, matching the production two-commit correction path when it fires.
  await instance.waitUntilRenderFlush();
  await instance.waitUntilRenderFlush();
}

async function waitForAppender(paths, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const stats = paths.map((path) => ({
      path,
      inFlight: hasInFlightWrite(path),
      ...getBufferedAppenderStats(path),
    }));
    if (stats.every((entry) => !entry.inFlight && entry.bufferedBytes === 0)) {
      return { settled: true, stats };
    }
    if (performance.now() >= deadline) return { settled: false, stats };
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function readPersistedRecords(paths) {
  let records = 0;
  let malformed = 0;
  let bytes = 0;
  for (const path of paths) {
    const content = readFileSync(path, 'utf8');
    bytes += Buffer.byteLength(content);
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      try {
        JSON.parse(line);
        records += 1;
      } catch {
        malformed += 1;
      }
    }
  }
  return { records, malformed, bytes };
}

function usage() {
  process.stdout.write(`tui-runtime-load-bench

Headless production React/Ink + transcript-writer stress bench. Gate precedence:
--threshold-ms / MIXDOG_TUI_LOAD_THRESHOLD_MS, then checked-in baseline p95 *
${DEFAULTS.baselineRegressionMargin}, then ${DEFAULTS.thresholdFloorMs}ms. Warm-up calibration is informational
only. Run --update-baseline intentionally after changing hardware/runner; normal
runs never rewrite the checked-in baseline.

Options:
  --items N          settled transcript items (default ${DEFAULTS.items})
  --frames N         measured frames (default ${DEFAULTS.frames})
  --producers N      concurrent session-like writers (default ${DEFAULTS.producers})
  --burst N          assistant records per producer/frame (default ${DEFAULTS.burst})
  --threshold-ms N   explicit p95 gate (env MIXDOG_TUI_LOAD_THRESHOLD_MS)
  --update-baseline  replace bench-results/tui-runtime-load-baseline.json on PASS
  --json             print JSON only
  --output PATH      also save the JSON result
`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage();
  process.exit(0);
}

const thresholdOverride = optionalPositiveNumber('--threshold-ms', 'MIXDOG_TUI_LOAD_THRESHOLD_MS');
const pinnedBaselineP95 = readPinnedBaselineP95(BASELINE_PATH);
const updateBaseline = process.argv.includes('--update-baseline');
const config = {
  items: positiveInt('--items', DEFAULTS.items),
  frames: positiveInt('--frames', DEFAULTS.frames),
  producers: positiveInt('--producers', DEFAULTS.producers),
  burst: positiveInt('--burst', DEFAULTS.burst),
  columns: positiveInt('--columns', DEFAULTS.columns),
  viewportRows: positiveInt('--viewport-rows', DEFAULTS.viewportRows),
  thresholdFloorMs: DEFAULTS.thresholdFloorMs,
  calibrationFrames: DEFAULTS.calibrationFrames,
  baselineRegressionMargin: DEFAULTS.baselineRegressionMargin,
};
const jsonOnly = process.argv.includes('--json');
const outputPath = argValue('--output', updateBaseline ? BASELINE_PATH : null);
const root = mkdtempSync(join(tmpdir(), 'mixdog-tui-load-bench-'));
const mixdogHome = join(root, 'home');
const cwd = join(root, 'project');
mkdirSync(cwd, { recursive: true });

let result;
let exitCode = 1;
let instance = null;
let rssTimer = null;
const pathsToDrain = [];
const startedAt = performance.now();
try {
  let settledItems = makeTranscriptItems(config.items);
  const writers = Array.from({ length: config.producers }, (_, lane) => {
    const writer = createTranscriptWriter({
      mixdogHome,
      sessionId: `bench-agent-${lane}`,
      cwd,
      pid: process.pid * 100 + lane,
    });
    writer.ensureTranscriptFile();
    pathsToDrain.push(writer.transcriptPath);
    return writer;
  });
  const producers = writers.map((writer, lane) => makeProducer({ writer, lane, burst: config.burst }));
  const droppedBytesAtStart = getBufferedAppenderStats(pathsToDrain[0]).totalDroppedBytes;

  let peakRss = process.memoryUsage().rss;
  const sampleRss = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  rssTimer = setInterval(sampleRss, 5);
  rssTimer.unref?.();

  const stdout = captureTty(config.columns, config.viewportRows);
  const stderr = captureTty(config.columns, config.viewportRows);
  const stdin = captureTty(config.columns, config.viewportRows);
  let inkRenderCalls = 0;
  let streamingText = 'Synthetic live response\n';
  let streamingTail = { id: 'bench-live-tail', kind: 'assistant', text: streamingText, streaming: true };
  let structureRevision = 1;

  instance = render(
    <TranscriptHarness
      settledItems={settledItems}
      streamingTail={streamingTail}
      structureRevision={structureRevision}
      columns={config.columns}
      viewportRows={config.viewportRows}
    />,
    {
      stdout,
      stderr,
      stdin,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: 1000,
      onRender: () => { inkRenderCalls += 1; },
    },
  );
  await flushFrame(instance);

  const calibrationTimes = [];
  for (let index = 0; index < config.calibrationFrames; index += 1) {
    const begin = performance.now();
    streamingTail = { ...streamingTail, text: `${streamingText}calibration ${index}\n` };
    instance.rerender(
      <TranscriptHarness
        settledItems={settledItems}
        streamingTail={streamingTail}
        structureRevision={structureRevision}
        columns={config.columns}
        viewportRows={config.viewportRows}
      />,
    );
    await flushFrame(instance);
    calibrationTimes.push(performance.now() - begin);
  }
  const rawCalibrationP95 = percentile([...calibrationTimes].sort((a, b) => a - b), 0.95);
  const effectiveThresholdMs = thresholdOverride?.value
    ?? (pinnedBaselineP95 != null
      ? pinnedBaselineP95 * config.baselineRegressionMargin
      : config.thresholdFloorMs);
  const thresholdSource = thresholdOverride?.source
    || (pinnedBaselineP95 != null
      ? `checked-in baseline p95 * ${config.baselineRegressionMargin}`
      : 'absolute fallback (checked-in baseline unavailable)');

  const frameTimes = [];
  let expectedRecords = 0;
  let producerItemsRendered = 0;
  let framesWithoutInkRender = 0;
  let framesWithoutTerminalWrite = 0;
  for (let frame = 0; frame < config.frames; frame += 1) {
    const frameStarted = performance.now();
    const priorRenderCalls = inkRenderCalls;
    const priorTerminalBytes = stdout.capturedBytes;
    const produced = await Promise.all(producers.map((produce) => produce(frame)));
    const newItems = produced.flatMap((lane) => lane.stateItems);
    const frameText = produced.flatMap((lane) => lane.chunks).join('');
    expectedRecords += produced.reduce((sum, lane) => sum + lane.recordCount, 0);
    producerItemsRendered += newItems.length;
    settledItems = [...settledItems, ...newItems];
    structureRevision += 1;
    streamingText += frameText;
    streamingTail = { ...streamingTail, text: streamingText };

    instance.rerender(
      <TranscriptHarness
        settledItems={settledItems}
        streamingTail={streamingTail}
        structureRevision={structureRevision}
        columns={config.columns}
        viewportRows={config.viewportRows}
      />,
    );
    await flushFrame(instance);
    const elapsed = performance.now() - frameStarted;
    frameTimes.push(elapsed);
    if (inkRenderCalls === priorRenderCalls) framesWithoutInkRender += 1;
    if (stdout.capturedBytes === priorTerminalBytes) framesWithoutTerminalWrite += 1;
    sampleRss();
  }

  instance.unmount();
  await instance.waitUntilExit();
  instance.cleanup();
  instance = null;

  const appender = await waitForAppender(pathsToDrain);
  const persisted = readPersistedRecords(pathsToDrain);
  const endAppenderStats = getBufferedAppenderStats(pathsToDrain[0]);
  const droppedBytes = endAppenderStats.totalDroppedBytes - droppedBytesAtStart;
  const bufferedBytes = appender.stats.reduce((sum, entry) => sum + entry.bufferedBytes, 0);
  sampleRss();

  const sorted = [...frameTimes].sort((a, b) => a - b);
  const rawP50 = percentile(sorted, 0.50);
  const rawP95 = percentile(sorted, 0.95);
  const rawMax = sorted.at(-1) || 0;
  const stats = {
    p50_ms: round(rawP50),
    p95_ms: round(rawP95),
    max_ms: round(rawMax),
    over_threshold_frames: frameTimes.filter((ms) => ms > effectiveThresholdMs).length,
  };
  const failures = [];
  // Compare the unrounded percentile; rounded values are reporting only.
  if (rawP95 > effectiveThresholdMs) {
    failures.push(`raw p95 ${rawP95}ms exceeds ${effectiveThresholdMs}ms threshold`);
  }
  if (!appender.settled) failures.push('buffered appender did not settle within 5s');
  if (persisted.records !== expectedRecords) {
    failures.push(`persisted record count ${persisted.records} != expected ${expectedRecords}`);
  }
  if (persisted.malformed !== 0) failures.push(`${persisted.malformed} malformed transcript records`);
  if (droppedBytes !== 0) failures.push(`buffered appender dropped ${droppedBytes} bytes`);
  if (bufferedBytes !== 0) failures.push(`buffered appender retained ${bufferedBytes} bytes`);
  if (framesWithoutInkRender !== 0) failures.push(`${framesWithoutInkRender} frames skipped Ink rendering`);
  if (framesWithoutTerminalWrite !== 0) failures.push(`${framesWithoutTerminalWrite} frames skipped terminal flush`);

  result = {
    bench: 'tui-runtime-load',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    threshold: {
      metric: 'raw_p95_ms',
      max_ms: round(effectiveThresholdMs),
      source: thresholdSource,
      host_dependent: true,
      baseline_path: 'bench-results/tui-runtime-load-baseline.json',
      baseline_p95_ms: pinnedBaselineP95,
      baseline_regression_margin: config.baselineRegressionMargin,
      calibration_p95_ms: round(rawCalibrationP95),
      calibration_role: 'informational only',
    },
    config,
    load: {
      transcript_items: settledItems.length + 1,
      producer_state_items: producerItemsRendered,
      expected_records: expectedRecords,
      persisted_records: persisted.records,
      malformed_records: persisted.malformed,
      persisted_bytes: persisted.bytes,
      dropped_buffer_bytes: droppedBytes,
      buffered_bytes_after_settle: bufferedBytes,
      ink_render_calls: inkRenderCalls,
      terminal_write_calls: stdout.writeCalls,
      terminal_bytes: stdout.capturedBytes,
    },
    frame_time: stats,
    peak_rss_mb: round(peakRss / (1024 * 1024), 1),
    wall_ms: round(performance.now() - startedAt, 1),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    failures,
  };
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  result = {
    bench: 'tui-runtime-load',
    status: 'FAIL',
    config,
    wall_ms: round(performance.now() - startedAt, 1),
    failures: [error?.stack || String(error)],
  };
  exitCode = 1;
} finally {
  if (rssTimer) clearInterval(rssTimer);
  if (instance) {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
  for (const path of pathsToDrain) {
    try { drainPathSync(path); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath && (!updateBaseline || exitCode === 0)) {
  const destination = resolve(outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, serialized);
} else if (updateBaseline && exitCode !== 0) {
  process.stderr.write('FAIL: refusing to replace baseline with a failed run\n');
}
if (jsonOnly) {
  process.stdout.write(serialized);
} else {
  const frame = result.frame_time || {};
  process.stdout.write(
    `tui-runtime-load: ${result.status} items=${result.load?.transcript_items ?? config.items} `
    + `frames=${config.frames} producers=${config.producers}\n`
    + `frame ms: p50=${frame.p50_ms ?? '-'} p95=${frame.p95_ms ?? '-'} max=${frame.max_ms ?? '-'} `
    + `(p95 threshold=${result.threshold?.max_ms ?? '-'}ms, over=${frame.over_threshold_frames ?? '-'})\n`
    + `peak RSS=${result.peak_rss_mb ?? '-'} MB records=${result.load?.persisted_records ?? 0}/`
    + `${result.load?.expected_records ?? 0} dropped=${result.load?.dropped_buffer_bytes ?? '-'} `
    + `wall=${result.wall_ms}ms\n`,
  );
  for (const failure of result.failures || []) process.stderr.write(`FAIL: ${failure}\n`);
}
process.exitCode = exitCode;
