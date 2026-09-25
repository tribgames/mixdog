/**
 * visible-items.mjs — the on-screen slice of the transcript and where the
 * overlay hint attaches to it.
 */
import { shouldSuppressFullyFailedToolItem } from '../../transcript-tool-failures.mjs';

/**
 * The window memo is keyed on a structure signature that intentionally
 * ignores per-character growth of the streaming assistant text, so its
 * `items` slice can hold a STALE reference to the streaming item between
 * height changes. Re-slice the live `items` over the memo's stable bounds so
 * the on-screen text is always current while the windowing stays warm.
 */
export function visibleTranscriptItems(transcriptItems, transcriptWindow, streamingTailItem) {
  const visible = (transcriptItems || []).slice(transcriptWindow.startIndex, transcriptWindow.endIndex);
  if (streamingTailItem && visible.length > 0) {
    const last = visible.length - 1;
    if (visible[last]?.id === streamingTailItem.id) visible[last] = streamingTailItem;
  }
  return visible;
}

export function overlayHintPlacement(
  renderedItems,
  transcriptWindow,
  { overlayHintRequested, floatingPanelRows, transcriptGuardRows }
) {
  let attachItemIndex = -1;
  for (let i = renderedItems.length - 1; i >= 0; i--) {
    const item = renderedItems[i];
    if (item?.kind === 'tool' && shouldSuppressFullyFailedToolItem(item)) continue;
    attachItemIndex = i;
    break;
  }
  const tailPinned = Math.max(0, Number(transcriptWindow.effectiveScrollOffset) || 0) === 0;
  const onLastItem =
    overlayHintRequested &&
    floatingPanelRows <= 0 &&
    transcriptWindow.bottomSpacerRows === 0 &&
    tailPinned &&
    attachItemIndex >= 0;
  const fallbackRow = overlayHintRequested && floatingPanelRows <= 0 && transcriptGuardRows > 0 && !onLastItem;
  return { attachItemIndex, tailPinned, onLastItem, fallbackRow };
}
