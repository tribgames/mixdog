import React from 'react';
import { PassThrough } from 'node:stream';
import { Box, measureElement, render } from 'ink';
import { Item } from '../src/tui/components/TranscriptItem.jsx';
import { useTranscriptWindow } from '../src/tui/app/use-transcript-window.mjs';
import {
  streamingMeasuredRowsById,
} from '../src/tui/app/transcript-window.mjs';
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
globalThis.__mixdogTailGrowthProbe = null;
let commit = 0;
const identity = (value) => value;
const noop = () => {};

function Harness({ text, step }) {
  const [scrollOffset, setScrollOffset] = React.useState(INITIAL_SCROLL);
  const [measuredRowsVersion, setMeasuredRowsVersion] = React.useState(0);
  const transcriptAnchorRef = React.useRef(null);
  const transcriptAnchorDirtyRef = React.useRef(true);
  const scrollTargetRef = React.useRef(INITIAL_SCROLL);
  const scrollPositionRef = React.useRef(INITIAL_SCROLL);
  const maxScrollRowsRef = React.useRef(0);
  const transcriptGeomRef = React.useRef({});
  const followingRef = React.useRef(false);
  const dragRef = React.useRef({ active: false, rect: null });
  const transcriptViewportRef = React.useRef({ top: 0 });
  const selectionLayoutRef = React.useRef(null);
  const contentRef = React.useRef(null);
  const tailRef = React.useRef(null);
  const streamingTail = React.useMemo(() => ({
    id: STREAM_ID,
    kind: 'assistant',
    text,
    streaming: true,
  }), [text]);
  const transcriptItems = React.useMemo(() => [...HISTORY, streamingTail], [streamingTail]);

  const preHookEntry = streamingMeasuredRowsById.get(STREAM_ID);
  const preHookMeasuredRows = preHookEntry?.rows ?? null;
  const preHookEstimateRows = preHookEntry?.estimateRows ?? null;

  const {
    transcriptWindow,
    renderedTranscriptItems,
    transcriptMeasureRef,
  } = useTranscriptWindow({
    items: HISTORY,
    structureRevision: 1,
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
    paintSelectionRect: noop,
    stopSmoothScroll: noop,
    measuredRowsVersion,
    setMeasuredRowsVersion,
  });

  const growthProbe = globalThis.__mixdogTailGrowthProbe;
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
    frames.push({
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
      growthLive: growthProbe?.live ?? null,
      growthBaseline: growthProbe?.baseline ?? null,
      growthDelta: growthProbe?.delta ?? null,
      suppressMeasured: geometry.suppressMeasuredRowHeights === true,
      measuredRowsVersion,
      preHookMeasuredRows,
      preHookEstimateRows,
      postHarvestMeasuredRows: streamingMeasuredRowsById.get(STREAM_ID)?.rows ?? null,
      postHarvestEstimateRows: streamingMeasuredRowsById.get(STREAM_ID)?.estimateRows ?? null,
      scrollTarget: scrollTargetRef.current,
      following: followingRef.current,
      anchor: transcriptAnchorRef.current?.id || '-',
    });
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
          const hookRef = item.id === STREAM_ID ? combinedTailRef : transcriptMeasureRef(item);
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

function assertStreamingMarkdownPartsCache() {
  const key = 'streaming-parts-cache-coverage';
  const longText = 'Settled paragraph.\n\n```js\nconst value = 1;';
  const initial = resolveStreamingMarkdownParts(longText, key);
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
streamingMeasuredRowsById.delete(STREAM_ID);
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
    + ` mountedDelta=${frame.mountedDelta} helper(live/base/delta)=${frame.growthLive}/${frame.growthBaseline}/${frame.growthDelta}`
    + ` suppressMeasured=${frame.suppressMeasured ? 1 : 0}`
    + ` measuredVersion=${frame.measuredRowsVersion}`
    + ` baseline(measured/estimate)=${frame.preHookMeasuredRows}/${frame.preHookEstimateRows}`
    + ` harvest(measured/estimate)=${frame.postHarvestMeasuredRows}/${frame.postHarvestEstimateRows}`
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
console.log('tui-transcript-jitter-harness: ok');




