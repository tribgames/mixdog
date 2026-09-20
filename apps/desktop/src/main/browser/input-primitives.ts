/**
 * The units every input driver speaks in: the port that delivers one CDP
 * input event and reports whether a dialog swallowed it, CSS points, mouse
 * buttons, and the modifier mask CDP expects.
 */
import type { WebContents } from 'electron';

export type BrowserInputOutcome = 'completed' | 'dialog';
export type BrowserMouseButton = 'left' | 'right' | 'middle';
export type BrowserKeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export type SendBrowserInput = (
  guest: WebContents,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<BrowserInputOutcome>;

export interface Point {
  x: number;
  y: number;
}

export const SHIFT_MODIFIER = 8;

export function cssPoint(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export function browserImagePointToCss(point: Point, zoomFactor: number): Point {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return { x: point.x / zoom, y: point.y / zoom };
}

export function normalizeMouseButton(value: unknown): BrowserMouseButton {
  const button = String(value || 'left')
    .trim()
    .toLowerCase();
  if (button === 'left' || button === 'right' || button === 'middle') return button;
  throw new Error('click button must be left, right, or middle');
}

export function normalizeModifierMask(value: unknown): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value)) throw new Error('click modifiers must be an array');
  let mask = 0;
  for (const raw of value) {
    const modifier = String(raw || '')
      .trim()
      .toLowerCase();
    if (modifier === 'alt') mask |= 1;
    else if (modifier === 'control' || modifier === 'ctrl') mask |= 2;
    else if (modifier === 'meta' || modifier === 'command' || modifier === 'cmd') mask |= 4;
    else if (modifier === 'shift') mask |= SHIFT_MODIFIER;
    else throw new Error(`unsupported click modifier "${String(raw)}"`);
  }
  return mask;
}
