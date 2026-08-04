// Mirror of vendor/ink/build/ink.js shouldClearTerminalForFrame, with the
// Windows branch parameterized so the harness can probe both platforms without
// relying on process.platform. Kept byte-faithful to the source predicate so
// the harness reflects real clear decisions.
export function shouldClearTerminalForFrameProbe({
  isTty, viewportRows, previousViewportRows, previousOutputHeight,
  nextOutputHeight, isUnmounting, isWindows,
}) {
  if (!isTty) return false;
  const priorViewportRows = previousViewportRows ?? viewportRows;
  const hadPreviousFrame = previousOutputHeight > 0;
  const wasFullscreen = previousOutputHeight >= priorViewportRows;
  const wasOverflowing = previousOutputHeight > priorViewportRows;
  const isOverflowing = nextOutputHeight > viewportRows;
  const isFullscreen = nextOutputHeight >= viewportRows;
  const isLeavingFullscreen = wasFullscreen && nextOutputHeight < viewportRows;
  const isShrinkingAtViewport = hadPreviousFrame &&
    nextOutputHeight < previousOutputHeight &&
    (wasFullscreen || isFullscreen || wasOverflowing || isOverflowing);
  const shouldClearOnUnmount = isUnmounting && wasFullscreen;
  const viewportResized = previousViewportRows != null && previousViewportRows !== viewportRows;
  if (isWindows && (wasFullscreen || isFullscreen) &&
      (viewportResized || isShrinkingAtViewport || isLeavingFullscreen)) {
    return true;
  }
  return (
    wasOverflowing ||
    (isOverflowing && hadPreviousFrame) ||
    isLeavingFullscreen ||
    isShrinkingAtViewport ||
    shouldClearOnUnmount);
}
