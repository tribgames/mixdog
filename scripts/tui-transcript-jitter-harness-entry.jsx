import React from 'react';
import { PassThrough } from 'node:stream';
import { Box, measureElement, render } from 'ink';
import { Item } from '../src/tui/components/TranscriptItem.jsx';
import { AssistantMessage } from '../src/tui/components/Message.jsx';
import { useTranscriptWindow } from '../src/tui/app/use-transcript-window.mjs';
import {
  resetAllStreamingMarkdownStablePrefixes,
  resetStreamingMarkdownStablePrefix,
  resolveStreamingMarkdownParts,
} from '../src/tui/markdown/streaming-markdown.mjs';

const COLUMNS = 42;
const VIEW_ROWS = 8;
const INITIAL_SCROLL = 8;
const STREAM_ID = 'jitter-fence-tail';
const HISTORY = Array.from({ length: 8 }, (_, index) => ({
  id: `history-${index}`,
  kind: 'notice',
  tone: 'plain',
  text: `H${index} stable history row`,
}));
const SCRIPT = [
  'Here is the script:',
  '',
  '```js',
  'const first = `',
  'alpha',
  '`;',
  'const second = `',
  'beta',
  '`;',
  'console.log(first, second);',
  '```',
  '',
  'Done.',
].join('\n');

const frames = [];
let commit = 0;
const identity = (value) => value;
const noop = () => {};

function Harness({
  text,
  step,
  initialScroll = INITIAL_SCROLL,
  streamId = STREAM_ID,
  sessionKey = 'jitter-session',
  following = false,
  releasedSelection = null,
  onPaint = noop,
  onFrame = noop,
  recordFrame = true,
}) {
  const [scrollOffset, setScrollOffset] = React.useState(initialScroll);
  const [measuredRowsVersion, setMeasuredRowsVersion] = React.useState(0);
  const transcriptAnchorRef = React.useRef(null);
  const transcriptAnchorDirtyRef = React.useRef(true);
  const scrollTargetRef = React.useRef(initialScroll);
  const scrollPositionRef = React.useRef(initialScroll);
  const maxScrollRowsRef = React.useRef(0);
  const transcriptGeomRef = React.useRef({});
  const followingRef = React.useRef(following);
  const dragRef = React.useRef({ active: false, rect: releasedSelection });
  const transcriptViewportRef = React.useRef({ top: 0 });
  const selectionLayoutRef = React.useRef(null);
  const contentRef = React.useRef(null);
  const tailRef = React.useRef(null);
  const streamingTail = React.useMemo(() => ({
    id: streamId,
    kind: 'assistant',
    text,
    streaming: true,
  }), [text]);
  const transcriptItems = React.useMemo(() => [...HISTORY, streamingTail], [streamingTail]);

  const {
    transcriptWindow,
    renderedTranscriptItems,
    transcriptMeasureRef,
  } = useTranscriptWindow({
    items: HISTORY,
    structureRevision: 1,
    sessionKey,
    streamingTail,
    themeEpoch: 0,
    frameColumns: COLUMNS,
    toolOutputExpanded: false,
    transcriptContentHeight: VIEW_ROWS,
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
    paintSelectionRect: onPaint,
    stopSmoothScroll: noop,
    measuredRowsVersion,
    setMeasuredRowsVersion,
  });

  const tailHookRef = transcriptMeasureRef(streamingTail);
  const combinedTailRef = React.useCallback((element) => {
    tailHookRef?.(element);
    tailRef.current = element;
  }, [tailHookRef]);

  React.useLayoutEffect(() => {
    const geometry = transcriptGeomRef.current || {};
    const prefix = geometry.prefixRows || [];
    const physicalRows = measureElement(contentRef.current).height;
    const tailYogaRows = measureElement(tailRef.current).height;
    const renderScrollOffset = transcriptWindow.effectiveScrollOffset;
    const visibleTopIndexed = transcriptWindow.totalRows - renderScrollOffset - VIEW_ROWS;
    const visibleTopPhysical = physicalRows - renderScrollOffset - VIEW_ROWS;
    const frame = {
      commit: ++commit,
      step,
      char: text.at(-1) === '\n' ? '\\n' : (text.at(-1) || ''),
      totalRows: transcriptWindow.totalRows,
      renderScrollOffset,
      visibleTopIndexed,
      visibleTopPhysical,
      physicalRows,
      tailIndexedRows: prefix.length > 1 ? prefix.at(-1) - prefix.at(-2) : -1,
      tailYogaRows,
      mountedDelta: tailYogaRows - (prefix.length > 1 ? prefix.at(-1) - prefix.at(-2) : -1),
      suppressMeasured: geometry.suppressMeasuredRowHeights === true,
      measuredRowsVersion,
      scrollTarget: scrollTargetRef.current,
      following: followingRef.current,
      anchor: transcriptAnchorRef.current?.id || '-',
    };
    if (recordFrame) frames.push(frame);
    onFrame(frame);
  }, [step, text, measuredRowsVersion, transcriptWindow.totalRows, transcriptWindow.effectiveScrollOffset,
    transcriptAnchorRef, transcriptGeomRef]);

  return (
    <Box flexDirection="column" width={COLUMNS} height={VIEW_ROWS} overflow="hidden" justifyContent="flex-end">
      <Box
        ref={contentRef}
        flexDirection="column"
        width="100%"
        flexShrink={0}
        marginBottom={-transcriptWindow.effectiveScrollOffset}
      >
        {renderedTranscriptItems.map((item, index, all) => {
          const hookRef = item.id === streamId ? combinedTailRef : transcriptMeasureRef(item);
          return (
            <Box key={item.id} ref={hookRef} flexDirection="column" flexShrink={0}>
              <Item
                item={item}
                prevKind={index > 0 ? all[index - 1].kind : null}
                columns={COLUMNS}
                toolOutputExpanded={false}
              />
            </Box>
          );
        })}
        {transcriptWindow.bottomSpacerRows > 0
          ? <Box height={transcriptWindow.bottomSpacerRows} flexShrink={0} />
          : null}
      </Box>
    </Box>
  );
}

function fakeTty(columns, rows) {
  const stream = new PassThrough();
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  stream.getColorDepth = () => 1;
  stream.hasColors = () => false;
  stream.setRawMode = () => stream;
  stream.on('data', () => {});
  return stream;
}

async function settle(instance) {
  await instance.waitUntilRenderFlush();
  await new Promise((resolve) => setTimeout(resolve, 2));
  await instance.waitUntilRenderFlush();
}

function AssistantSettleHeightProbe({ text, streaming, assistantId, onHeight }) {
  const ref = React.useRef(null);
  React.useLayoutEffect(() => {
    if (ref.current) onHeight(measureElement(ref.current).height);
  }, [onHeight, streaming, text]);
  return (
    <Box ref={ref} width={COLUMNS} flexDirection="column">
      <AssistantMessage
        text={text}
        streaming={streaming}
        columns={COLUMNS}
        assistantId={assistantId}
      />
    </Box>
  );
}

async function assertAssistantSettleHeight(text, assistantId) {
  let latestHeight = 0;
  const onHeight = (height) => { latestHeight = height; };
  const stdout = fakeTty(COLUMNS, VIEW_ROWS);
  const stderr = fakeTty(COLUMNS, VIEW_ROWS);
  const stdin = fakeTty(COLUMNS, VIEW_ROWS);
  const instance = render(
    <AssistantSettleHeightProbe
      text={text}
      streaming
      assistantId={assistantId}
      onHeight={onHeight}
    />,
    { stdout, stderr, stdin, interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000 },
  );
  await settle(instance);
  const streamingHeight = latestHeight;
  instance.rerender(
    <AssistantSettleHeightProbe
      text={text}
      streaming={false}
      assistantId={assistantId}
      onHeight={onHeight}
    />,
  );
  await settle(instance);
  const settledHeight = latestHeight;
  instance.unmount();
  await instance.waitUntilExit();
  instance.cleanup();
  if (settledHeight !== streamingHeight) {
    throw new Error(`assistant markdown changed height on settle: ${JSON.stringify({
      assistantId,
      streamingHeight,
      settledHeight,
    })}`);
  }
}

function assertStreamingMarkdownPartsCache() {
  const key = 'streaming-parts-cache-coverage';
  const longText = 'Settled paragraph.\n\n```js\nconst value = 1;';
  const initial = resolveStreamingMarkdownParts(longText, key);
  if (!Array.isArray(initial.stableChunks) || initial.stableChunks.join('') !== initial.stablePrefix) {
    throw new Error('stable markdown chunks do not reconstruct the stable prefix');
  }
  const repeated = resolveStreamingMarkdownParts(`${longText}\n\n`, key);
  if (repeated !== initial) {
    throw new Error('normalized-equivalent stream text did not reuse its resolved parts');
  }

  const regressed = resolveStreamingMarkdownParts('plain text', key);
  if (regressed === initial || regressed.stablePrefix || regressed.unstableSuffix !== 'plain text') {
    throw new Error('text regression served a stale streaming-markdown split');
  }

  const recomputed = resolveStreamingMarkdownParts(longText, key);
  if (recomputed === initial) {
    throw new Error('text change did not evict the prior streaming-markdown snapshot');
  }

  const resetSeed = recomputed;
  resetStreamingMarkdownStablePrefix(key);
  if (resolveStreamingMarkdownParts(longText, key) === resetSeed) {
    throw new Error('streaming-markdown reset did not clear its resolved-parts snapshot');
  }
}

assertStreamingMarkdownPartsCache();
resetAllStreamingMarkdownStablePrefixes();
await assertAssistantSettleHeight('```js\nconst value = 1;\n```', 'settle-complete-fence');
await assertAssistantSettleHeight('```js\nconst value = 1;\n``', 'settle-partial-fence');
resetAllStreamingMarkdownStablePrefixes();
const stdout = fakeTty(COLUMNS, VIEW_ROWS);
const stderr = fakeTty(COLUMNS, VIEW_ROWS);
const stdin = fakeTty(COLUMNS, VIEW_ROWS);
const instance = render(<Harness text={SCRIPT.slice(0, 1)} step={1} />, {
  stdout,
  stderr,
  stdin,
  interactive: true,
  patchConsole: false,
  exitOnCtrlC: false,
  maxFps: 1000,
});
await settle(instance);
for (let step = 2; step <= SCRIPT.length; step++) {
  instance.rerender(<Harness text={SCRIPT.slice(0, step)} step={step} />);
  await settle(instance);
}
instance.unmount();
await instance.waitUntilExit();
instance.cleanup();

const byStep = new Map();
for (const frame of frames) {
  const list = byStep.get(frame.step) || [];
  list.push(frame);
  byStep.set(frame.step, list);
}
const dips = [];
let previousSettled = null;
for (const [step, list] of [...byStep.entries()].sort((a, b) => a[0] - b[0])) {
  const first = list[0];
  const settled = list.at(-1);
  if (previousSettled
    && first.visibleTopPhysical !== previousSettled.visibleTopPhysical
    && settled.visibleTopPhysical === previousSettled.visibleTopPhysical) {
    dips.push({ previous: previousSettled, transient: first, corrected: settled });
  }
  previousSettled = settled;
}

const print = (label, frame) => {
  console.log(`${label} c${frame.commit} step=${frame.step} char=${JSON.stringify(frame.char)}`
    + ` totalRows=${frame.totalRows} renderScrollOffset=${frame.renderScrollOffset}`
    + ` visibleTop=${frame.visibleTopPhysical} indexedTop=${frame.visibleTopIndexed}`
    + ` physicalRows=${frame.physicalRows} tail(index/yoga)=${frame.tailIndexedRows}/${frame.tailYogaRows}`
    + ` mountedDelta=${frame.mountedDelta}`
    + ` suppressMeasured=${frame.suppressMeasured ? 1 : 0}`
    + ` measuredVersion=${frame.measuredRowsVersion}`
    + ` target=${frame.scrollTarget} following=${frame.following ? 1 : 0} anchor=${frame.anchor}`);
};

console.log(`# scrolled-up fenced-script frame repro columns=${COLUMNS} viewRows=${VIEW_ROWS} initialScroll=${INITIAL_SCROLL}`);
console.log(`# append-only characters=${SCRIPT.length} commits=${frames.length} dip-snap events=${dips.length}`);
for (const event of dips.slice(0, 4)) {
  print('before   ', event.previous);
  print('transient', event.transient);
  print('harvest  ', event.corrected);
  console.log('');
}
const suppressValues = new Set(frames.map((frame) => frame.suppressMeasured));
console.log(`# suppressMeasuredRowHeights values during repro: ${[...suppressValues].map(Number).join(',')}`);
if (dips.length > 0) {
  throw new Error(`expected no visible-top dip/snap while fenced script streams; observed ${dips.length}`);
}
if (suppressValues.size !== 1 || !suppressValues.has(true)) {
  throw new Error('repro unexpectedly toggled suppressMeasuredRowHeights');
}

const PINNED_STREAM_ID = 'pinned-fence-tail';
const pinnedFrames = [];
resetAllStreamingMarkdownStablePrefixes();
const pinnedInstance = render(
  <Harness
    text={SCRIPT.slice(0, 1)}
    step={1}
    initialScroll={0}
    streamId={PINNED_STREAM_ID}
    sessionKey="pinned-jitter-session"
    following
    recordFrame={false}
    onFrame={(frame) => pinnedFrames.push(frame)}
  />,
  { stdout: fakeTty(COLUMNS, VIEW_ROWS), stderr: fakeTty(COLUMNS, VIEW_ROWS), stdin: fakeTty(COLUMNS, VIEW_ROWS), interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000 },
);
await settle(pinnedInstance);
for (let step = 2; step <= SCRIPT.length; step++) {
  pinnedInstance.rerender(
    <Harness
      text={SCRIPT.slice(0, step)}
      step={step}
      initialScroll={0}
      streamId={PINNED_STREAM_ID}
      sessionKey="pinned-jitter-session"
      following
      recordFrame={false}
      onFrame={(frame) => pinnedFrames.push(frame)}
    />,
  );
  await settle(pinnedInstance);
}
pinnedInstance.unmount();
await pinnedInstance.waitUntilExit();
pinnedInstance.cleanup();

const pinnedSettledByStep = new Map();
for (const frame of pinnedFrames) pinnedSettledByStep.set(frame.step, frame);
const pinnedGeometryFaults = [];
let previousPinned = null;
for (const frame of pinnedSettledByStep.values()) {
  const physicalDelta = previousPinned ? frame.physicalRows - previousPinned.physicalRows : 0;
  const indexedDelta = previousPinned ? frame.totalRows - previousPinned.totalRows : 0;
  if (frame.mountedDelta !== 0
    || frame.visibleTopPhysical !== frame.visibleTopIndexed
    || physicalDelta < 0
    || physicalDelta !== indexedDelta) {
    pinnedGeometryFaults.push({
      previous: previousPinned,
      current: frame,
      physicalDelta,
      indexedDelta,
    });
  }
  previousPinned = frame;
}
console.log(`# bottom-pinned fenced-script frames=${pinnedFrames.length} geometry-faults=${pinnedGeometryFaults.length}`);
for (const fault of pinnedGeometryFaults.slice(0, 4)) {
  if (fault.previous) print('before   ', fault.previous);
  print('fault    ', fault.current);
  console.log(`delta physical/indexed=${fault.physicalDelta}/${fault.indexedDelta}\n`);
}
if (pinnedGeometryFaults.length > 0) {
  throw new Error(`expected one geometry authority while a bottom-pinned fenced script streams; observed ${pinnedGeometryFaults.length} faults`);
}

const SELECTION_STREAM_ID = 'released-selection-tail';
const releasedSelection = { mode: 'linear', x1: 0, y1: 3, x2: 4, y2: 3 };
const selectionHarvests = [];
const selectionFrames = [];
const selectionInstance = render(
  <Harness
    text="seed"
    step={0}
    initialScroll={1}
    streamId={SELECTION_STREAM_ID}
    releasedSelection={releasedSelection}
    recordFrame={false}
    onPaint={(rect, options) => {
      if (rect && options?.rememberText === false) selectionHarvests.push({ y1: rect.y1, y2: rect.y2 });
    }}
    onFrame={(frame) => selectionFrames.push(frame)}
  />,
  { stdout: fakeTty(COLUMNS, VIEW_ROWS), stderr: fakeTty(COLUMNS, VIEW_ROWS), stdin: fakeTty(COLUMNS, VIEW_ROWS), interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000 },
);
await settle(selectionInstance);
const harvestsBeforeGrowth = selectionHarvests.length;
const framesBeforeGrowth = selectionFrames.length;
selectionInstance.rerender(
  <Harness
    text={'seed\none\nsecond\nthird'}
    step={1}
    initialScroll={1}
    streamId={SELECTION_STREAM_ID}
    releasedSelection={releasedSelection}
    recordFrame={false}
    onPaint={(rect, options) => {
      if (rect && options?.rememberText === false) selectionHarvests.push({ y1: rect.y1, y2: rect.y2 });
    }}
    onFrame={(frame) => selectionFrames.push(frame)}
  />,
);
await settle(selectionInstance);
selectionInstance.unmount();
await selectionInstance.waitUntilExit();
selectionInstance.cleanup();
const growthFrames = selectionFrames.slice(framesBeforeGrowth);
if (!growthFrames.some((frame) => frame.scrollTarget > 1)) {
  throw new Error('released-selection repro did not apply anchored growth at offset 1');
}
const growthHarvests = selectionHarvests.slice(harvestsBeforeGrowth);
const initialRenderOffset = selectionFrames[framesBeforeGrowth - 1]?.renderScrollOffset ?? 0;
const maxGrowthRenderOffset = Math.max(
  initialRenderOffset,
  ...growthFrames.map((frame) => frame.renderScrollOffset),
);
const maxExpectedSelectionY = releasedSelection.y1 + maxGrowthRenderOffset - initialRenderOffset;
const doubleCountedHarvest = growthHarvests.find(
  (harvest) => harvest.y1 > maxExpectedSelectionY || harvest.y2 > maxExpectedSelectionY,
);
const finalHarvest = growthHarvests.at(-1);
if (
  doubleCountedHarvest
  || !finalHarvest
  || finalHarvest.y1 !== releasedSelection.y1
  || finalHarvest.y2 !== releasedSelection.y2
) {
  throw new Error(`released selection harvested wrong row during anchored growth: ${JSON.stringify({
    doubleCountedHarvest,
    finalHarvest,
    expectedFinal: releasedSelection,
    maxExpectedSelectionY,
  })}`);
}

const SESSION_SWITCH_STREAM_ID = 'session-switch-tail';
const sessionSwitchFrames = [];
const sessionSwitchInstance = render(
  <Harness
    text={SCRIPT}
    step={0}
    initialScroll={INITIAL_SCROLL}
    streamId={SESSION_SWITCH_STREAM_ID}
    sessionKey="session-before"
    recordFrame={false}
    onFrame={(frame) => sessionSwitchFrames.push(frame)}
  />,
  { stdout: fakeTty(COLUMNS, VIEW_ROWS), stderr: fakeTty(COLUMNS, VIEW_ROWS), stdin: fakeTty(COLUMNS, VIEW_ROWS), interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000 },
);
await settle(sessionSwitchInstance);
const framesBeforeSessionSwitch = sessionSwitchFrames.length;
sessionSwitchInstance.rerender(
  <Harness
    text={SCRIPT}
    step={1}
    initialScroll={INITIAL_SCROLL}
    streamId={SESSION_SWITCH_STREAM_ID}
    sessionKey="session-after"
    recordFrame={false}
    onFrame={(frame) => sessionSwitchFrames.push(frame)}
  />,
);
await settle(sessionSwitchInstance);
sessionSwitchInstance.unmount();
await sessionSwitchInstance.waitUntilExit();
sessionSwitchInstance.cleanup();
const switchedFrames = sessionSwitchFrames.slice(framesBeforeSessionSwitch);
const staleSessionGeometry = switchedFrames.find((frame) =>
  frame.renderScrollOffset !== 0
  || frame.scrollTarget !== 0
  || frame.following !== true
  || frame.anchor !== '-');
if (!switchedFrames.length || staleSessionGeometry) {
  throw new Error(`session switch reused outgoing transcript geometry: ${JSON.stringify({
    switchedFrames,
    staleSessionGeometry,
  })}`);
}
console.log('tui-transcript-jitter-harness: ok');




