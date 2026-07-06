/**
 * use-native-scroll-router.mjs — wheel-scroll router for NATIVE mouse mode.
 *
 * In native mode mixdog releases SGR mouse tracking so the terminal owns
 * selection/copy. Windows Terminal's alternate-scroll mode (DECSET 1007) then
 * converts each wheel notch into a BURST of identical Up/Down arrow sequences
 * that all arrive inside a single stdin readable-drain. This hook taps ink's
 * parsed-input bus and, only while native mode is active, detects such bursts
 * (>=2 identical up/down arrows in one synchronous batch) and routes them to
 * transcript scroll instead of prompt history / cursor movement. A single arrow
 * (normal keypress) is replayed untouched, so keyboard behavior is unchanged.
 *
 * The tap is a thin wrapper around inkInput.emit installed once; it is fully
 * inert in app mode (straight passthrough) and restored on unmount.
 */
import { useEffect } from 'react';
import { overlayBlocksGlobalTranscriptScroll } from './slash-commands.mjs';

// Temporary diagnostics (MIXDOG_TUI_SCROLL_DEBUG=1): append every emit the
// router sees + each flush decision to <tmp>/mixdog-scroll-debug.log so we can
// inspect exactly what Windows Terminal delivers for a wheel notch in native
// mode. Remove once the native wheel path is confirmed working.
const SCROLL_DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_SCROLL_DEBUG || ''));
let debugLog = null;
if (SCROLL_DEBUG) {
  try {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.tmpdir(), 'mixdog-scroll-debug.log');
    debugLog = (line) => {
      try { fs.appendFileSync(file, `${Date.now()} ${line}\n`); } catch { /* ignore */ }
    };
    debugLog('--- scroll debug session start ---');
  } catch { debugLog = null; }
}

// CSI (\x1b[A/B) and SS3 (\x1bOA/B) forms of Up/Down that WT emits for wheel.
const UP_SEQS = new Set(['\x1b[A', '\x1bOA']);
const DOWN_SEQS = new Set(['\x1b[B', '\x1bOB']);
// Rows per wheel notch — mirrors use-mouse-input.mjs STEP=3 semantics.
const STEP = 3;

export function useNativeScrollRouter({
  inkInput,
  mouseModeRef,
  scrollFocusRef,
  queueScrollCoalesced,
}) {
  useEffect(() => {
    if (!inkInput || typeof inkInput.emit !== 'function') return undefined;
    const origEmit = inkInput.emit.bind(inkInput);
    let batch = null; // buffered 'input' sequences awaiting burst classification
    let scheduled = false;

    const flush = () => {
      scheduled = false;
      const items = batch || [];
      batch = null;
      if (items.length === 0) return;
      let up = 0;
      let down = 0;
      let arrows = 0;
      for (const s of items) {
        if (UP_SEQS.has(s)) { up += 1; arrows += 1; }
        else if (DOWN_SEQS.has(s)) { down += 1; arrows += 1; }
      }
      // A wheel burst = every buffered event is an arrow, at least THREE of them
      // (Windows Terminal emits 3 per notch), all pointing the same direction.
      // Requiring >=3 keeps keyboard auto-repeat and single/double presses as
      // real input: they always fail this test and replay untouched. True
      // per-stdin-chunk grouping isn't observable at ink's emit seam (chunks are
      // dispatched event-by-event with no boundary marker, and the parser can't
      // be tapped without a vendor change), so we group per readable-drain and
      // lean on the >=3 threshold to avoid misreading interleaved keystrokes.
      const isBurst = arrows >= 3 && arrows === items.length && (up === 0 || down === 0);
      if (debugLog) {
        const blocked = overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current);
        debugLog(`flush items=${JSON.stringify(items)} arrows=${arrows} up=${up} down=${down} isBurst=${isBurst} overlayBlocked=${blocked}`);
      }
      if (isBurst && !overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) {
        queueScrollCoalesced((up - down) * STEP); // swallow: do NOT re-emit
        return;
      }
      for (const s of items) origEmit('input', s);
    };

    const wrapped = function wrappedEmit(event, ...args) {
      if (debugLog) {
        const a = args[0];
        const desc = typeof a === 'string'
          ? JSON.stringify(a)
          : (a && typeof a === 'object' ? `{kind:${a.kind},name:${a.name},seq:${JSON.stringify(a.sequence ?? '')}}` : String(a));
        debugLog(`emit event=${event} mode=${mouseModeRef.current} arg=${desc}`);
      }
      // Inert in app mode and for every non-'input' channel (mouse/paste/etc).
      if (mouseModeRef.current !== 'native' || event !== 'input') {
        return origEmit(event, ...args);
      }
      const seq = args[0];
      const isArrow = UP_SEQS.has(seq) || DOWN_SEQS.has(seq);
      // Fast path: nothing buffered and this isn't an arrow → passthrough.
      if (batch === null && !isArrow) return origEmit('input', seq);
      // Once buffering starts, hold every event to preserve order; the batch
      // drains on the next microtask (after ink's synchronous readable loop).
      if (batch === null) batch = [];
      batch.push(seq);
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
      return true;
    };

    inkInput.emit = wrapped;
    return () => {
      inkInput.emit = origEmit;
      if (batch && batch.length) { for (const s of batch) origEmit('input', s); }
      batch = null;
    };
  }, [inkInput, mouseModeRef, scrollFocusRef, queueScrollCoalesced]);
}
