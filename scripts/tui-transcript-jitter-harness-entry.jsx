import React from 'react';
import { PassThrough } from 'node:stream';
import { Box, measureElement, render } from 'ink';
import { Item } from '../src/tui/components/TranscriptItem.jsx';
import { AssistantMessage } from '../src/tui/components/Message.jsx';
import { useTranscriptWindow } from '../src/tui/app/use-transcript-window.mjs';
import { resolveAnchorScrollOffset } from '../src/tui/app/transcript-window.mjs';
import {
  resetAllStreamingMarkdownStablePrefixes,
  resetStreamingMarkdownStablePrefix,
  resolveStreamingMarkdownParts,
} from '../src/tui/markdown/streaming-markdown.mjs';

const COLUMNS = 42;
const VIEW_ROWS = 8;
const INITIAL_SCROLL = 8;
// Every scenario renders its own ink instance, each registering a beforeExit
// listener; the default cap of 10 only produces a spurious warning here.
process.setMaxListeners(32);
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
  viewRows = VIEW_ROWS,
  floatingPanelRows = 0,
  releasedSelection = null,
  onPaint = noop,
  onFrame = noop,
  onScrollStateDispatch = noop,
  recordFrame = true,
  history = HISTORY,
}) {
  const [scrollOffset, setScrollOffset] = React.useState(initialScroll);
  const [measuredRowsVersion, setMeasuredRowsVersion] = React.useState(0);
  const onScrollStateDispatchRef = React.useRef(onScrollStateDispatch);
  onScrollStateDispatchRef.current = onScrollStateDispatch;
  const dispatchScrollOffset = React.useCallback((next) => {
    onScrollStateDispatchRef.current(next);
    setScrollOffset(next);
  }, []);
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
  const transcriptItems = React.useMemo(() => [...history, streamingTail], [history, streamingTail]);

  const {
    transcriptWindow,
    renderedTranscriptItems,
    transcriptMeasureRef,
  } = useTranscriptWindow({
    items: history,
    structureRevision: 1,
    sessionKey,
    streamingTail,
    themeEpoch: 0,
    frameColumns: COLUMNS,
    toolOutputExpanded: false,
    transcriptContentHeight: viewRows,
    transcriptBottomSlackRows: 1,
    transcriptGuardRows: 1,
    floatingPanelRows,
    overlayHintRequested: false,
    scrollOffset,
    setScrollOffset: dispatchScrollOffset,
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
    const visibleTopIndexed = transcriptWindow.totalRows - renderScrollOffset - viewRows;
    const visibleTopPhysical = physicalRows - renderScrollOffset - viewRows;
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
  }, [step, text, viewRows, measuredRowsVersion, transcriptWindow.totalRows, transcriptWindow.effectiveScrollOffset,
    transcriptAnchorRef, transcriptGeomRef]);

  return (
    <Box flexDirection="column" width={COLUMNS} height={viewRows} overflow="hidden" justifyContent="flex-end">
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

function assertDeepToolAnchorToggleRoundTrip() {
  const items = [
    { id: 'before-tool' },
    { id: 'expanded-tool' },
    { id: 'after-tool' },
  ];
  const anchor = { id: 'expanded-tool', offset: 15 };
  const viewRows = 8;
  const geometries = [
    { curPrefix: [0, 10, 30, 130], totalRows: 130 },
    { curPrefix: [0, 10, 13, 113], totalRows: 113 },
    { curPrefix: [0, 10, 30, 130], totalRows: 130 },
  ];
  const positions = geometries.map(({ curPrefix, totalRows }) => {
    const maxRows = totalRows - viewRows;
    const scrollOffset = resolveAnchorScrollOffset({
      anchor,
      items,
      curPrefix,
      totalRows,
      viewRows,
      maxRows,
    });
    return {
      scrollOffset,
      visibleTop: totalRows - viewRows - scrollOffset,
    };
  });
  if (positions.some(({ visibleTop }) => visibleTop !== 25)
    || positions[0].scrollOffset !== positions[2].scrollOffset) {
    throw new Error(`deep tool anchor moved across expand/collapse: ${JSON.stringify(positions)}`);
  }
}

assertStreamingMarkdownPartsCache();
assertDeepToolAnchorToggleRoundTrip();
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
if (suppressValues.size !== 1 || !suppressValues.has(false)) {
  throw new Error('reading mode changed the settled-prefix geometry authority');
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

// Structural append repro: generated tool/status rows join the settled prefix
// while the live assistant remains followed. Their first real Yoga height must
// be consumed before paint; carrying only the estimate until follow is released
// makes the whole transcript jump on the next scroll gesture.
const appendedTool = {
  id: 'pinned-appended-tool',
  kind: 'tool',
  name: 'agent',
  args: JSON.stringify({
    task_id: 'worker-follow',
    status: 'completed',
    path: 'src/tui/app/use-transcript-window.mjs',
  }),
  result: 'worker completed with a generated row',
  count: 1,
  completedCount: 1,
};
const appendFrames = [];
const appendBaseProps = {
  text: 'followed live tail',
  initialScroll: 0,
  streamId: 'pinned-append-tail',
  sessionKey: 'pinned-append-session',
  following: true,
  recordFrame: false,
  onFrame: (frame) => appendFrames.push(frame),
};
const appendInstance = render(
  <Harness {...appendBaseProps} step={0} history={HISTORY} />,
  { stdout: fakeTty(COLUMNS, VIEW_ROWS), stderr: fakeTty(COLUMNS, VIEW_ROWS), stdin: fakeTty(COLUMNS, VIEW_ROWS), interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000 },
);
await settle(appendInstance);
const framesBeforeAppend = appendFrames.length;
appendInstance.rerender(
  <Harness {...appendBaseProps} step={1} history={[...HISTORY, appendedTool]} />,
);
await settle(appendInstance);
appendInstance.unmount();
await appendInstance.waitUntilExit();
appendInstance.cleanup();
const generatedRowFrames = appendFrames.slice(framesBeforeAppend);
const generatedRowSettled = generatedRowFrames.at(-1);
if (!generatedRowFrames.length
  || generatedRowFrames.some((frame) => frame.renderScrollOffset !== 0)
  || generatedRowFrames.some((frame) => frame.suppressMeasured)
  || !generatedRowSettled
  || generatedRowSettled.visibleTopPhysical !== generatedRowSettled.visibleTopIndexed
  || generatedRowSettled.mountedDelta !== 0) {
  throw new Error(`bottom-follow generated row did not settle in one pinned geometry: ${JSON.stringify(generatedRowFrames)}`);
}

// Popup/picker geometry must not count as transcript interaction. While a
// floating panel opens, remains in use, and closes, a followed live tail keeps
// advancing at offset zero and consumes the final viewport size immediately.
const popupFollowFrames = [];
const popupFollowProps = {
  initialScroll: 0,
  streamId: 'popup-follow-tail',
  sessionKey: 'popup-follow-session',
  following: true,
  recordFrame: false,
  onFrame: (frame) => popupFollowFrames.push(frame),
};
const popupFollowInstance = render(
  <Harness {...popupFollowProps} text="popup follow seed" step={0} />,
  { stdout: fakeTty(COLUMNS, VIEW_ROWS), stderr: fakeTty(COLUMNS, VIEW_ROWS), stdin: fakeTty(COLUMNS, VIEW_ROWS), interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000 },
);
await settle(popupFollowInstance);
const popupFramesStart = popupFollowFrames.length;
popupFollowInstance.rerender(
  <Harness {...popupFollowProps} text={'popup follow seed\npanel opened output'} step={1}
    viewRows={VIEW_ROWS - 2} floatingPanelRows={2} />,
);
await settle(popupFollowInstance);
popupFollowInstance.rerender(
  <Harness {...popupFollowProps} text={'popup follow seed\npanel opened output\npanel browsing output'} step={2}
    viewRows={VIEW_ROWS - 2} floatingPanelRows={2} />,
);
await settle(popupFollowInstance);
popupFollowInstance.rerender(
  <Harness {...popupFollowProps} text={'popup follow seed\npanel opened output\npanel browsing output\npanel closed output'} step={3} />,
);
await settle(popupFollowInstance);
popupFollowInstance.unmount();
await popupFollowInstance.waitUntilExit();
popupFollowInstance.cleanup();
const popupActiveFrames = popupFollowFrames.slice(popupFramesStart);
const popupFinalFrame = popupActiveFrames.at(-1);
if (!popupActiveFrames.length
  || popupActiveFrames.some((frame) => !frame.following
    || frame.renderScrollOffset !== 0
    || frame.suppressMeasured)
  || !popupFinalFrame
  || popupFinalFrame.visibleTopPhysical !== popupFinalFrame.visibleTopIndexed
  || popupFinalFrame.mountedDelta !== 0) {
  throw new Error(`popup interaction interrupted bottom follow: ${JSON.stringify(popupActiveFrames)}`);
}

const layoutTransitionFrames = [];
const layoutTransitionStateDispatches = [];
const layoutTransitionInstance = render(
  <Harness
    text={SCRIPT}
    step={0}
    initialScroll={INITIAL_SCROLL}
    streamId="layout-transition-tail"
    sessionKey="layout-transition-session"
    recordFrame={false}
    onFrame={(frame) => layoutTransitionFrames.push(frame)}
    onScrollStateDispatch={(next) => layoutTransitionStateDispatches.push(next)}
  />,
  { stdout: fakeTty(COLUMNS, VIEW_ROWS), stderr: fakeTty(COLUMNS, VIEW_ROWS), stdin: fakeTty(COLUMNS, VIEW_ROWS), interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000 },
);
await settle(layoutTransitionInstance);
const dispatchesBeforeLayoutTransition = layoutTransitionStateDispatches.length;
const framesBeforeLayoutTransition = layoutTransitionFrames.length;
layoutTransitionInstance.rerender(
  <Harness
    text={`${SCRIPT}\nlayout transition growth`}
    step={1}
    initialScroll={INITIAL_SCROLL}
    streamId="layout-transition-tail"
    sessionKey="layout-transition-session"
    viewRows={VIEW_ROWS - 2}
    floatingPanelRows={2}
    recordFrame={false}
    onFrame={(frame) => layoutTransitionFrames.push(frame)}
    onScrollStateDispatch={(next) => layoutTransitionStateDispatches.push(next)}
  />,
);
await settle(layoutTransitionInstance);
layoutTransitionInstance.unmount();
await layoutTransitionInstance.waitUntilExit();
layoutTransitionInstance.cleanup();
const transitionFrames = layoutTransitionFrames.slice(framesBeforeLayoutTransition);
const transitionTopRows = new Set(transitionFrames.map((frame) => frame.visibleTopPhysical));
const transitionStateDispatches = layoutTransitionStateDispatches.slice(dispatchesBeforeLayoutTransition);
if (!transitionFrames.length || transitionTopRows.size !== 1) {
  throw new Error(`layout + transcript transition did not keep one anchored top row: ${JSON.stringify(transitionFrames)}`);
}
if (transitionStateDispatches.length > 0) {
  throw new Error(`anchored layout + transcript transition fed its resolved offset back into React state: ${JSON.stringify(transitionStateDispatches)}`);
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

// Compaction repro: the reader is anchored in history when a mid-turn compaction
// trims everything above the live turn. The anchored row disappears with it, so
// the transcript must drop the lock, return to the tail and RE-ARM follow —
// keeping the anchor pinned the target above zero and auto-scroll stayed
// released for the rest of the session (user: 컴팩션된 이후로 자동 스크롤이 풀린다).
const COMPACTION_STREAM_ID = 'compaction-trim-tail';
const compactionFrames = [];
const compactionProps = {
  initialScroll: INITIAL_SCROLL,
  streamId: COMPACTION_STREAM_ID,
  sessionKey: 'compaction-session',
  recordFrame: false,
  onFrame: (frame) => compactionFrames.push(frame),
};
const compactionInstance = render(
  <Harness {...compactionProps} text={SCRIPT} step={0} history={HISTORY} />,
  { stdout: fakeTty(COLUMNS, VIEW_ROWS), stderr: fakeTty(COLUMNS, VIEW_ROWS), stdin: fakeTty(COLUMNS, VIEW_ROWS), interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000 },
);
await settle(compactionInstance);
// One growth commit first: the anchor is captured by the row-delta effect, not
// at mount (the first commit has no previous geometry to compare against).
compactionInstance.rerender(
  <Harness {...compactionProps} text={`${SCRIPT}\nreading while the turn streams`} step={1} history={HISTORY} />,
);
await settle(compactionInstance);
const anchoredBeforeCompaction = compactionFrames.at(-1);
const framesBeforeCompaction = compactionFrames.length;
compactionInstance.rerender(
  <Harness
    {...compactionProps}
    text={`${SCRIPT}\nreading while the turn streams`}
    step={2}
    history={[{ id: 'compaction-status', kind: 'notice', tone: 'plain', text: 'Compact complete' }]}
  />,
);
await settle(compactionInstance);
compactionInstance.unmount();
await compactionInstance.waitUntilExit();
compactionInstance.cleanup();
const compactedFrames = compactionFrames.slice(framesBeforeCompaction);
const compactedSettled = compactedFrames.at(-1);
if (!anchoredBeforeCompaction || anchoredBeforeCompaction.anchor === '-') {
  throw new Error(`compaction repro never anchored before the trim: ${JSON.stringify(anchoredBeforeCompaction)}`);
}
if (!compactedFrames.length
  || !compactedSettled
  || compactedSettled.following !== true
  || compactedSettled.scrollTarget !== 0
  || compactedSettled.anchor !== '-') {
  throw new Error(`compaction left the transcript locked to a deleted anchor: ${JSON.stringify({
    anchoredBeforeCompaction,
    compactedFrames,
  })}`);
}

// Auto-scroll rule (a viewport that cannot scroll clears
// userScrolled): once a trim leaves the transcript SHORTER than the viewport
// there is no reading position left to protect, so follow re-arms.
const NO_OVERFLOW_STREAM_ID = 'no-overflow-tail';
const noOverflowFrames = [];
const noOverflowProps = {
  initialScroll: 4,
  streamId: NO_OVERFLOW_STREAM_ID,
  sessionKey: 'no-overflow-session',
  recordFrame: false,
  onFrame: (frame) => noOverflowFrames.push(frame),
};
const noOverflowInstance = render(
  <Harness {...noOverflowProps} text={SCRIPT} step={0} history={HISTORY} />,
  { stdout: fakeTty(COLUMNS, VIEW_ROWS), stderr: fakeTty(COLUMNS, VIEW_ROWS), stdin: fakeTty(COLUMNS, VIEW_ROWS), interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 1000 },
);
await settle(noOverflowInstance);
noOverflowInstance.rerender(
  <Harness {...noOverflowProps} text={`${SCRIPT}\nstill reading history`} step={1} history={HISTORY} />,
);
await settle(noOverflowInstance);
const framesBeforeShrink = noOverflowFrames.length;
noOverflowInstance.rerender(
  <Harness {...noOverflowProps} streamId="no-overflow-short-tail" text="short tail" step={2} history={[]} />,
);
await settle(noOverflowInstance);
await settle(noOverflowInstance);
noOverflowInstance.unmount();
await noOverflowInstance.waitUntilExit();
noOverflowInstance.cleanup();
const shrunkFrames = noOverflowFrames.slice(framesBeforeShrink);
const shrunkSettled = shrunkFrames.at(-1);
if (!shrunkFrames.length
  || !shrunkSettled
  || shrunkSettled.following !== true
  || shrunkSettled.scrollTarget !== 0) {
  throw new Error(`a transcript that no longer overflows kept auto-scroll released: ${JSON.stringify(shrunkFrames)}`);
}
console.log('tui-transcript-jitter-harness: ok');




