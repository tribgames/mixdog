/**
 * app-view/transcript-viewport/transcript-rows.jsx — the scrolled item column
 * inside the transcript viewport: the scroll offset, the windowed items and
 * the bottom spacer that holds the scroll coordinate for older history.
 */
import React from 'react';
import { Box } from 'ink';
import { TRANSCRIPT_WINDOW_TAIL_OVERSCAN_ROWS } from '../../transcript-window.mjs';
import { Item } from '../../../components/TranscriptItem.jsx';

export function renderTranscriptRows(ctx) {
  const {
    frameColumns,
    guardHintWidth,
    inputHint,
    inputHintTone,
    overlayHintAttachItemIndex,
    overlayHintOnLastItem,
    renderedTranscriptItems,
    state,
    toolOutputExpanded,
    transcriptContentHeight,
    transcriptMeasureRef,
    transcriptTailPinned,
    transcriptWindow,
    transientStatusWidth,
  } = ctx;
  return (
    /* Wheel scroll: with the viewport bottom-anchored (flex-end), a NEGATIVE
       marginBottom pushes the transcript column DOWN past the bottom edge,
       bringing older content above the window into view (overflow hidden
       clips the newest rows that slide below). 0 = newest content pinned to
       the bottom. (marginTop has no effect under flex-end — the bottom edge
       stays fixed — so the scroll axis here is marginBottom, not marginTop.)
       scrollOffset is clamped ≥ 0 by the wheel handler; a new turn snaps it
       back to 0. */
    <Box flexDirection="column" width="100%" flexShrink={0} marginBottom={-transcriptWindow.effectiveScrollOffset}>
      {/*
       * Transcript windowing: render only the rows around the viewport rather
       * than the full state.items list. A cheap bottom spacer preserves the
       * same scroll coordinate when the visible window is in older history;
       * items above the window are off-screen and omitted entirely.
       * MAX cap: TRANSCRIPT_WINDOW_MAX_ITEMS items (env MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS).
       * OVERSCAN: TRANSCRIPT_WINDOW_OVERSCAN_ROWS extra rows above the viewport so
       * fast wheel scrolls don't show a blank gap before re-render.
       */}
      {renderedTranscriptItems.map((item, i, arr) => {
        const measureRef = transcriptMeasureRef(item);
        const attachOverlayHint = overlayHintOnLastItem && i === overlayHintAttachItemIndex;
        const itemNode = (
          <Item
            item={item}
            prevKind={
              i > 0
                ? arr[i - 1].kind
                : ((state.transcriptViewItems || state.items)[transcriptWindow.startIndex - 1]?.kind ?? null)
            }
            columns={frameColumns}
            toolOutputExpanded={toolOutputExpanded}
            rightMessage={attachOverlayHint ? inputHint : ''}
            rightTone={attachOverlayHint ? inputHintTone : 'info'}
            rightMessageWidth={attachOverlayHint ? guardHintWidth || transientStatusWidth || 24 : 24}
            themeEpoch={state.themeEpoch || 0}
            streamingWindowRows={
              transcriptTailPinned && item.id === state.streamingTail?.id
                ? transcriptContentHeight + TRANSCRIPT_WINDOW_TAIL_OVERSCAN_ROWS
                : 0
            }
          />
        );
        // When measured-rows is on, wrap each row in a zero-cost flex column
        // whose ref exposes the row's REAL Yoga height to the harvest effect.
        // The wrapper adds no rows of its own (it shrink-wraps the child) and
        // is omitted entirely when the feature is disabled so the default
        // render tree is byte-for-byte unchanged on the off path.
        return measureRef ? (
          <Box key={item.id} ref={measureRef} flexDirection="column" flexShrink={0}>
            {itemNode}
          </Box>
        ) : (
          <React.Fragment key={item.id}>{itemNode}</React.Fragment>
        );
      })}
      {transcriptWindow.bottomSpacerRows > 0 ? <Box height={transcriptWindow.bottomSpacerRows} flexShrink={0} /> : null}
    </Box>
  );
}
