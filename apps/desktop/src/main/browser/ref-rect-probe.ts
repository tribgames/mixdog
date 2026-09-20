/**
 * The box a ref occupies on screen, for a screenshot crop rather than a
 * gesture. A picture dispatches nothing, so the cross-origin frame offset is
 * taken without the hit test that guards input against a covered frame.
 */
import type { WebContents } from 'electron';

import { BrowserActionabilityError } from './actionability';
import type { BrowserRefPointHost } from './ref-points';
import { BROWSER_REF_RECT, browserRefRectExpression } from './ref-rect';

export type RefRectProbeHost = Pick<
  BrowserRefPointHost,
  'callAccessibilityRef' | 'evaluate' | 'frameOffsetForSession' | 'accessibilityRefs'
>;

export interface RefRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RefRectMeasurement {
  error?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function refRectFailure(ref: string, measured: RefRectMeasurement | undefined): Error {
  if (measured?.error === 'moving') {
    return new BrowserActionabilityError(`ref ${ref} is still moving; wait briefly and try again`, 'moving');
  }
  if (measured?.error === 'not-visible') {
    return new BrowserActionabilityError(`ref ${ref} is not visible; take a fresh snapshot first`, 'hidden');
  }
  return new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
}

export async function probeRefRect(
  host: RefRectProbeHost,
  guest: WebContents,
  ref: string,
  signal?: AbortSignal
): Promise<RefRect> {
  const accessibility = await host.callAccessibilityRef<RefRectMeasurement>(
    guest,
    ref,
    `async function() { return (${BROWSER_REF_RECT})(this); }`,
    [],
    signal
  );
  let measured: RefRectMeasurement;
  if (accessibility.handled) {
    const target = host.accessibilityRefs.get(guest)?.refs.get(ref);
    if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
    measured = accessibility.value;
    if (!measured?.error && typeof measured?.x === 'number' && typeof measured?.y === 'number') {
      // The page measured its own realm; only the cross-origin frame offset
      // is left to add.
      const frameOffset = await host.frameOffsetForSession(guest, target.sessionId, signal);
      measured = { ...measured, x: frameOffset.x + measured.x, y: frameOffset.y + measured.y };
    }
  } else {
    measured = await host.evaluate<RefRectMeasurement>(guest, browserRefRectExpression(ref), signal);
  }
  if (
    !measured ||
    measured.error ||
    typeof measured.x !== 'number' ||
    typeof measured.y !== 'number' ||
    !measured.width ||
    !measured.height
  ) {
    throw refRectFailure(ref, measured);
  }
  return { x: measured.x, y: measured.y, width: measured.width, height: measured.height };
}
