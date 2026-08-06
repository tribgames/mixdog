(() => {
  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { y: Math.round(box.y), b: Math.round(box.bottom), h: Math.round(box.height), w: Math.round(box.width) };
  };
  const pane = document.querySelector('.pane-chat-surface') || document;
  const viewport = pane.querySelector('.transcript');
  const rows = [...(viewport?.querySelectorAll('.transcript-virtual-row') || [])];
  const reviewRow = rows.find((row) => row.querySelector('.turn-review-slot'));
  const lastContentRow = [...rows].reverse().find((row) => !row.querySelector('.turn-review-slot'));
  const slot = pane.querySelector('.turn-review-slot');
  const bar = pane.querySelector('.turn-review-bar');
  const composer = pane.querySelector('.composer-region');
  const space = viewport?.querySelector('.transcript-virtual-space');
  const slotStyle = slot ? getComputedStyle(slot) : null;
  const rowContent = slot?.closest('.transcript-virtual-row-content');
  const rowStyle = rowContent ? getComputedStyle(rowContent) : null;
  const spinners = [...document.querySelectorAll(
    '.live-activity-spinner, [data-component="progress-spinner"], .progress-spinner, .tab-spinner, .workspace-tab svg circle',
  )].slice(0, 6).map((element) => {
    const style = getComputedStyle(element);
    return {
      node: element.tagName.toLowerCase() + '.' + String(element.getAttribute('class') || '').split(/\s+/)[0],
      name: style.animationName,
      duration: style.animationDuration,
      state: style.animationPlayState,
      iteration: style.animationIterationCount,
    };
  });
  return {
    viewport: rect(viewport),
    space: rect(space),
    lastContentRow: rect(lastContentRow),
    reviewRow: rect(reviewRow),
    bar: rect(bar),
    composer: rect(composer),
    slotMargins: slotStyle ? `${slotStyle.marginTop} / ${slotStyle.marginBottom}` : null,
    rowContentPadding: rowStyle ? `${rowStyle.paddingTop} / ${rowStyle.paddingBottom}` : null,
    gapContentToReview: lastContentRow && reviewRow
      ? Math.round(reviewRow.getBoundingClientRect().top - lastContentRow.getBoundingClientRect().bottom)
      : null,
    gapReviewToViewportBottom: reviewRow && viewport
      ? Math.round(viewport.getBoundingClientRect().bottom - reviewRow.getBoundingClientRect().bottom)
      : null,
    gapViewportToComposer: viewport && composer
      ? Math.round(composer.getBoundingClientRect().top - viewport.getBoundingClientRect().bottom)
      : null,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    spinners,
  };
})()
