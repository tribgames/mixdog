import { markCompactWire } from '../main/state-delta';

/** The compact payload shape is announced by the envelope that carries it
 *  rather than repeated inside every frame; a full snapshot keeps its own
 *  marker and must not be re-read as a patch. */
export const markCompactPayload = (wire: unknown): void => {
  if (wire && typeof wire === 'object' && !Object.hasOwn(wire, '__itemsRevision')) {
    markCompactWire(wire as Record<string, unknown>);
  }
};

export interface CompactTranscriptExpander {
  /** The canonical `sessionState` frame this compact envelope stands for, or
   *  null when this browser's handle map disagrees with the desktop's. */
  expand(frame: Record<string, unknown>): Record<string, unknown> | null;
  /** Handles are per desktop leg; a new challenge starts a new map. */
  reset(): void;
}

// Compact transcript envelope. The desktop addresses a session by handle
// and sends its name once, so a live frame no longer repeats the nested
// event/payload/sessionId trio around ~30 bytes of new text. Expanding it
// here keeps ONE downstream code path for both shapes.
export const createCompactTranscriptExpander = (): CompactTranscriptExpander => {
  const sessionNames = new Map<number, string>();
  return {
    expand(frame) {
      const handle = Number(frame.s);
      if (!Number.isSafeInteger(handle)) return null;
      const name = typeof frame.n === 'string' && frame.n ? frame.n : sessionNames.get(handle);
      if (!name) return null;
      sessionNames.set(handle, name);
      const wire = frame.w;
      markCompactPayload(wire);
      return {
        event: 'sessionState',
        payload: {
          sessionId: name,
          wire,
          frameSource: frame.f ?? 'live',
          ...(typeof frame.le === 'string' && frame.le ? { laneEnd: frame.le } : {}),
          ...(frame.pp !== undefined ? { perfProbe: frame.pp } : {}),
          ...(typeof frame.cr === 'number' ? { contentRevision: frame.cr } : {}),
        },
      };
    },
    reset() {
      sessionNames.clear();
    },
  };
};
