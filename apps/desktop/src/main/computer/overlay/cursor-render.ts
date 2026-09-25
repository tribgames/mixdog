/**
 * Drawing one cursor event. The virtual pointer travels from where it was
 * last drawn to the action point and plays the action effect only once it has
 * arrived, mirroring where the worker then acts. A background cursor sits
 * just above its exact target window, never raising or activating it; a
 * foreground cursor rides above everything. Every stage leaves a diagnostic
 * so an invisible cursor can be explained afterwards.
 */
import type { BrowserWindow } from 'electron';
import { screen } from 'electron';

import { recordCursorDiagnostic } from './cursor-diagnostics';
import { glideAllowed, glideFinished, glidePosition, type GlidePlan, planGlide } from './cursor-glide';
import {
  type CursorSurface,
  cursorBoundsDip,
  dipPoint,
  displayAreaFor,
  ensureCursorWindow,
  stopGlide,
} from './cursor-surface';
import type { ComputerUseCursorPresentation } from './model';

const GLIDE_FRAME_MS = 16;
const GLIDE_ZORDER_MS = 80;

export interface CursorRenderContext {
  surfaceFor(sessionId: string): CursorSurface;
  /** Whether the surface still belongs to the overlay. */
  ownsSurface(sessionId: string, surface: CursorSurface): boolean;
  /** Whether this event is still the one the session should be showing. */
  showsEvent(sessionId: string, eventId: number): boolean;
  userControlActive(): boolean;
}

async function applyCursorEffect(
  window: BrowserWindow,
  cursor: ComputerUseCursorPresentation,
  effect: string
): Promise<void> {
  const serialized = JSON.stringify({ ...cursor, effect }).replaceAll('<', '\\u003c');
  const evidence = await window.webContents.executeJavaScript(
    `(() => {
        if (typeof window.mixdogAgentCursor !== 'function') return { handler: false };
        window.mixdogAgentCursor(${serialized});
        const ring = document.getElementById('ring');
        return { handler: true, ring: Boolean(ring), opacity: ring ? Number(getComputedStyle(ring).opacity) : 0 };
      })()`
  );
  recordCursorDiagnostic(evidence?.handler ? 'handler_called' : 'handler_missing');
  recordCursorDiagnostic(evidence?.ring ? 'ring_present' : 'ring_missing');
  // Animated effects start their keyframes at zero opacity, so reading the
  // style in the same frame says nothing about whether they became visible.
  const animated = ['click', 'type', 'scroll', 'prepare'].includes(effect);
  const unseenRing = animated ? 'ring_animation_start' : 'ring_transparent_style';
  recordCursorDiagnostic(evidence?.opacity > 0 ? 'ring_visible_style' : unseenRing);
}

/** Place only the feedback above its target, never raise or activate the target. */
function pinAboveTarget(window: BrowserWindow, windowId: string): void {
  window.moveAbove(`window:${BigInt(windowId.slice(5)).toString()}:0`);
}

function showCursorWindow(window: BrowserWindow, cursor: ComputerUseCursorPresentation): void {
  if (cursor.mode === 'background') {
    if (!cursor.windowId || !/^hwnd:0x[0-9a-f]+$/i.test(cursor.windowId)) {
      window.hide();
      throw new Error('background cursor requires an exact target window');
    }
    window.setAlwaysOnTop(false);
    try {
      if (!window.isVisible()) window.showInactive();
      pinAboveTarget(window, cursor.windowId);
    } catch (error) {
      window.hide();
      throw error;
    }
  } else {
    window.setAlwaysOnTop(true, 'screen-saver');
    if (!window.isVisible()) window.showInactive();
  }
}

/** Move the pointer frame by frame; the action effect plays on arrival. */
function startGlide(
  window: BrowserWindow,
  surface: CursorSurface,
  cursor: ComputerUseCursorPresentation,
  plan: GlidePlan,
  current: () => boolean
): void {
  recordCursorDiagnostic('glide_started');
  const startedAt = Date.now();
  let lastPin = startedAt;
  // Only a background cursor is stacked against one window; a foreground one
  // already rides above everything and has no target to follow.
  const pinned = cursor.mode === 'background';
  const windowId = cursor.windowId as string;
  const timer = setInterval(() => {
    if (!current() || surface.glide?.timer !== timer) {
      clearInterval(timer);
      if (surface.glide?.timer === timer) surface.glide = undefined;
      recordCursorDiagnostic('glide_superseded');
      return;
    }
    const now = Date.now();
    const elapsed = now - startedAt;
    const point = glidePosition(plan, elapsed);
    surface.shown = point;
    window.setBounds(cursorBoundsDip(point), false);
    // The target may be restacked while the pointer travels; keep the feedback just above it.
    if (pinned && now - lastPin >= GLIDE_ZORDER_MS) {
      lastPin = now;
      try {
        pinAboveTarget(window, windowId);
      } catch {
        // A closed target ends the travel silently; the arrival check below decides visibility.
      }
    }
    if (!glideFinished(plan, elapsed)) return;
    clearInterval(timer);
    surface.glide = undefined;
    recordCursorDiagnostic('glide_completed');
    void applyCursorEffect(window, cursor, cursor.effect).catch(() => {
      recordCursorDiagnostic('render_failed');
    });
  }, GLIDE_FRAME_MS);
  timer.unref?.();
  surface.glide = { eventId: cursor.eventId, timer };
}

function recordPlacement(window: BrowserWindow): void {
  recordCursorDiagnostic(window.isVisible() ? 'window_visible' : 'window_not_visible');
  const bounds = window.getBounds();
  const onDisplay = screen.getAllDisplays().some((display) => {
    const area = display.bounds;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
  recordCursorDiagnostic(onDisplay ? 'window_on_display' : 'window_off_display');
}

export async function renderCursor(context: CursorRenderContext, cursor: ComputerUseCursorPresentation): Promise<void> {
  const surface = context.surfaceFor(cursor.sessionId);
  if (cursor.eventId <= surface.lastEventId) return;
  surface.lastEventId = cursor.eventId;
  stopGlide(surface);
  recordCursorDiagnostic('render_started');
  const source = { x: cursor.x, y: cursor.y };
  surface.position = source;
  const window = await ensureCursorWindow(surface, () => context.ownsSurface(cursor.sessionId, surface));
  const current = (): boolean =>
    context.ownsSurface(cursor.sessionId, surface) &&
    !window.isDestroyed() &&
    surface.lastEventId === cursor.eventId &&
    context.showsEvent(cursor.sessionId, cursor.eventId);
  if (!current()) {
    recordCursorDiagnostic('render_superseded');
    return;
  }
  const target = dipPoint(source);
  const plan = glideAllowed(cursor) ? planGlide(surface.shown, target, displayAreaFor(target)) : null;
  const start = plan ? glidePosition(plan, 0) : target;
  surface.shown = start;
  window.setBounds(cursorBoundsDip(start), false);
  await applyCursorEffect(window, cursor, plan ? 'move' : cursor.effect);
  if (!current() || context.userControlActive()) return;
  showCursorWindow(window, cursor);
  if (plan) startGlide(window, surface, cursor, plan, current);
  recordPlacement(window);
}
