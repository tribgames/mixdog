import type { BrowserWindow } from 'electron';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transcript tool disclosure: a single tool card, or the grouped tool
 *  activity that now wraps consecutive calls. */
export const TOOL_DISCLOSURE = '.tool-card, .tool-activity';
/** The toggle row that opens or closes each disclosure above. */
export const TOOL_DISCLOSURE_HEADERS = '.tool-card > .tool-header, .tool-activity > .tool-activity-header';
export const TOOL_DISCLOSURE_OPEN = '.tool-card[data-open="true"], .tool-activity[data-open="true"]';

/** Renderer expression for `(state, snapshot) => void`: records the PAINTED
 *  state of the transcript. Each rAF takes a default snapshot for its frame; a
 *  ResizeObserver created after mount (so it runs after virtual-core's
 *  observer) replaces it with the post-layout snapshot of the same frame; the
 *  frame's final snapshot is committed to `state.samples` at the next rAF.
 *  Viewport scroll events and viewport style mutations replace it as well.
 *  `state.stop()` disconnects the observers and commits the last frame. */
export const PAINTED_SAMPLER = `((state, snapshot) => {
  const selector = [
    '.transcript-virtual-space',
    '.transcript-virtual-row',
    '.transcript-virtual-row-content',
    '.composer-island-slot',
    '.composer-queue-tray',
  ].join(',');
  let pending = null;
  let ro = null;
  let space = null;
  let seen = new WeakSet();
  const observeAll = () => {
    if (!ro) return;
    for (const node of document.querySelectorAll(selector)) {
      if (seen.has(node)) continue;
      seen.add(node);
      ro.observe(node);
    }
  };
  // The observer is (re)created once the entered session's virtual space has
  // mounted, in a frame after its mount: observers of one depth run in
  // creation order, so this one then runs after virtual-core's.
  const rebuild = () => {
    const current = document.querySelector('.transcript-virtual-space');
    if (!current || current === space) return;
    space = current;
    if (ro) ro.disconnect();
    seen = new WeakSet();
    ro = new ResizeObserver(() => {
      const next = snapshot();
      if (next) pending = next;
    });
    observeAll();
  };
  const mo = new MutationObserver(observeAll);
  // Scroll and visibility-only changes of the viewport do not resize anything,
  // yet can land after this frame's rAF snapshot: replace it for them too.
  const viewportSelector = '[role=log][data-session-key]';
  const replace = () => {
    const next = snapshot();
    if (next) pending = next;
  };
  const onScroll = (event) => {
    if (event.target instanceof Element && event.target.matches(viewportSelector)) replace();
  };
  document.addEventListener('scroll', onScroll, true);
  const viewportMo = new MutationObserver((records) => {
    if (records.some((record) => record.target instanceof Element && record.target.matches(viewportSelector))) {
      replace();
    }
  });
  viewportMo.observe(document.body, { attributes: true, attributeFilter: ['style'], subtree: true });
  const commit = () => {
    if (pending) state.samples.push(pending);
    pending = null;
  };
  const frame = () => {
    commit();
    rebuild();
    pending = snapshot();
    state.raf = requestAnimationFrame(frame);
  };
  rebuild();
  mo.observe(document.body, { childList: true, subtree: true });
  state.stop = () => {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    if (ro) ro.disconnect();
    mo.disconnect();
    viewportMo.disconnect();
    document.removeEventListener('scroll', onScroll, true);
    commit();
  };
  state.raf = requestAnimationFrame(frame);
})`;

/** Renderer expression resolving to the sidebar row of `id`: the session list
 *  arrives asynchronously after boot, so the row is awaited, not assumed. */
export function waitForProbeSessionRow(id: string, missing: string): string {
  return `await (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = document.querySelector('[data-session-id="${id}"]');
      if (row instanceof HTMLElement) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(${JSON.stringify(missing)});
  })()`;
}

export async function clickProbeSession(window: BrowserWindow, id: string, waitMs: number): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    const row = ${waitForProbeSessionRow(id, `Missing switch probe row: ${id}`)};
    row.click();
    await new Promise((resolve) => setTimeout(resolve, ${waitMs}));
    return true;
  })()`);
}

export const COLLECT_SWITCH_FRAMES_SCRIPT = `(() => {
  cancelAnimationFrame(window.__switchProbe.raf);
  return window.__switchProbe.frames;
})()`;
