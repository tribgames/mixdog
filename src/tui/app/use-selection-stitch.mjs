/**
 * use-selection-stitch.mjs — stitch buffer for transcript selections.
 * Accumulates harvested selection rows across scroll positions so Ctrl+C
 * copies the FULL drag even after it auto-scrolled past the viewport. Keyed
 * by scroll-invariant content row = screenY - scrollTarget at harvest time;
 * value = { text, sw } (sw = soft-wrap continuation). Only transcript-region
 * drags accumulate.
 */
import { useCallback, useEffect, useRef } from 'react';

function storeStitchRows(buffer, rows, scroll) {
  for (const row of rows) {
    if (!row || typeof row.y !== 'number') continue;
    // Store text AND the soft-wrap continuation flag so the stitch join can
    // rejoin word-wrapped rows into their logical line (mirrors output.js).
    buffer.set(row.y - scroll, {
      text: typeof row.text === 'string' ? row.text : '',
      sw: row.sw === true,
    });
  }
}

export function useSelectionStitchBuffer({ store, dragRef, scrollTargetRef }) {
  const stitchBufferRef = useRef(new Map());
  const stitchHarvestTimerRef = useRef(null);
  // Scroll offset captured at the SCHEDULE (paint) time of the pending
  // harvest — the deferred timer must key rows by the frame's scroll, not by
  // whatever scrollTargetRef holds when the timer eventually fires (a scroll
  // in between would mis-key the rows). Latest schedule wins.
  const stitchHarvestScrollRef = useRef(0);

  useEffect(
    () => () => {
      if (stitchHarvestTimerRef.current) clearTimeout(stitchHarvestTimerRef.current);
      stitchHarvestTimerRef.current = null;
    },
    []
  );

  const clearStitchBuffer = useCallback(() => {
    stitchBufferRef.current.clear();
    if (stitchHarvestTimerRef.current) {
      clearTimeout(stitchHarvestTimerRef.current);
      stitchHarvestTimerRef.current = null;
    }
  }, []);

  // Deferred (like rememberSelectionTextSoon) harvest of the currently visible
  // selection rows. Runs on EVERY transcript selection paint AND on
  // scroll-shift repaints (the rememberText:false path) so rows revealed only
  // mid-scroll are captured. A later harvest of a key overwrites, handling
  // partial↔full endpoint rows on retraction.
  const harvestStitchRowsSoon = useCallback(() => {
    if (dragRef.current.region !== 'transcript') return;
    // Capture the scroll offset for THIS paint (schedule time). If a timer is
    // already pending, only refresh the captured offset to the latest frame
    // and reuse the existing timer.
    stitchHarvestScrollRef.current = Number(scrollTargetRef.current) || 0;
    if (stitchHarvestTimerRef.current) return;
    stitchHarvestTimerRef.current = setTimeout(() => {
      stitchHarvestTimerRef.current = null;
      if (dragRef.current.region !== 'transcript') return;
      const rows = store.getRenderSelectionRows?.();
      if (!Array.isArray(rows)) return;
      storeStitchRows(stitchBufferRef.current, rows, stitchHarvestScrollRef.current);
    }, 0);
  }, [store]);

  // Synchronous sibling: snapshot the rows CURRENTLY under the selection
  // immediately, keyed by the given (pre-scroll) offset. Called right before
  // a scroll shifts those rows out of view — the deferred harvest could never
  // see rows that a fast drag/wheel scrolled past between paint and its
  // setTimeout. selectionRows is harvested by the renderer UNCONDITIONALLY
  // (even on captureText:false motion paints, output.js), so this works
  // mid-drag.
  const harvestStitchRowsNow = useCallback(
    (scroll) => {
      if (dragRef.current.region !== 'transcript') return;
      const rows = store.getRenderSelectionRows?.();
      if (!Array.isArray(rows)) return;
      storeStitchRows(stitchBufferRef.current, rows, Number(scroll) || 0);
    },
    [store]
  );

  // Map the CURRENT rect + current scrollTarget onto the content-key range and
  // join buffered rows sorted by key. `complete` is true only when the
  // harvested keys cover the selection's [lo..hi] range with no hole (interior
  // AND both endpoints): a gap (a scrolled-off row that was never harvested)
  // would otherwise yield a mangled, shorter-than-real copy that callers
  // preferred purely on length, and an endpoint-missing stitch is internally
  // contiguous yet drops a boundary line. Callers must gate on `complete`
  // before preferring the stitch; { text: '', complete: false } means unusable.
  const getStitchedSelectionText = useCallback(() => {
    const empty = { text: '', complete: false };
    const buf = stitchBufferRef.current;
    if (!buf.size) return empty;
    if (dragRef.current.region !== 'transcript') return empty;
    const rect = dragRef.current.rect;
    if (!rect) return empty;
    const y1 = Number(rect.y1);
    const y2 = Number(rect.y2);
    if (!Number.isFinite(y1) || !Number.isFinite(y2)) return empty;
    const scroll = Number(scrollTargetRef.current) || 0;
    const lo = Math.min(y1, y2) - scroll;
    const hi = Math.max(y1, y2) - scroll;
    const keys = [...buf.keys()].filter((k) => k >= lo && k <= hi).sort((a, b) => a - b);
    if (!keys.length) return empty;
    // Keys are filtered to [lo..hi] and unique, so a count equal to the range
    // size means every selected row is present.
    const complete = keys.length === hi - lo + 1;
    // SOFT-WRAP JOIN (same rule as output.js getSelectedText): a row whose sw
    // flag is set is a word-wrap continuation — concatenate it onto the prior
    // logical line WITHOUT a newline; only source/hard breaks emit '\n'. Blank
    // inner rows ('' text) survive as empty logical lines (paragraph gaps).
    // Trailing whitespace is trimmed once per logical-line end.
    const logical = [];
    for (const k of keys) {
      const entry = buf.get(k);
      if (entry == null) continue;
      const t = typeof entry === 'string' ? entry : (entry.text ?? '');
      const sw = typeof entry === 'string' ? false : entry.sw === true;
      if (sw && logical.length > 0) logical[logical.length - 1] += t;
      else logical.push(t);
    }
    const text = logical.map((l) => l.replace(/\s+$/u, '')).join('\n');
    return text.trim() ? { text, complete } : empty;
  }, []);

  return { clearStitchBuffer, harvestStitchRowsSoon, harvestStitchRowsNow, getStitchedSelectionText };
}
