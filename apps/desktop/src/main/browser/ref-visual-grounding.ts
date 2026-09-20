/**
 * Coordinates read off a screenshot are accepted only while that screenshot
 * still describes the page: the same snapshot id, taken recently, the same
 * document revision, and an unchanged URL and viewport. Anything else is
 * refused rather than scaled onto a page that has moved on.
 */
import type { WebContents } from 'electron';

import type { BrowserCommand } from './command';
import type { GuestSlot } from './guest-state';
import type { BrowserRefPointHost } from './ref-points';
import type { BrowserRefSet } from './ref-recovery';

/** The screenshot a coordinate action is allowed to be expressed in. */
export interface VisualGrounding {
  snapshotId: string;
  revision?: string;
  capturedAt?: number;
  url: string;
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export type VisualGroundingHost = Pick<BrowserRefPointHost, 'evaluate' | 'visualGrounding' | 'revision'>;

const VISUAL_GROUNDING_TTL_MS = 30_000;

export function bindVisualGrounding(
  slot: GuestSlot<VisualGrounding>,
  guest: WebContents,
  refSet: BrowserRefSet,
  capture: { width: number; height: number }
): void {
  slot.set(guest, {
    snapshotId: refSet.snapshotId,
    revision: refSet.revision,
    capturedAt: Date.now(),
    url: refSet.url,
    imageWidth: capture.width,
    imageHeight: capture.height,
    viewportWidth: refSet.viewportWidth,
    viewportHeight: refSet.viewportHeight,
  });
}

/** The grounding the command names, still within its lifetime and revision. */
async function currentGrounding(
  host: VisualGroundingHost,
  guest: WebContents,
  command: BrowserCommand,
  label: string,
  signal?: AbortSignal
): Promise<VisualGrounding> {
  const grounding = host.visualGrounding.get(guest);
  if (!grounding || !command.snapshotId || command.snapshotId !== grounding.snapshotId) {
    throw new Error(`${label} requires snapshotId from the latest snapshot(mode=both) or locate result`);
  }
  if (
    !grounding.capturedAt ||
    Date.now() - grounding.capturedAt > VISUAL_GROUNDING_TTL_MS ||
    (host.revision && grounding.revision !== (await host.revision(guest, signal)))
  ) {
    host.visualGrounding.delete(guest);
    throw new Error(`${label} visual grounding is stale; take a fresh snapshot(mode=both)`);
  }
  return grounding;
}

function imagePoint(grounding: VisualGrounding, xValue: unknown, yValue: unknown, label: string) {
  const x = Number(xValue);
  const y = Number(yValue);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} requires finite screenshot x and y coordinates`);
  }
  if (x < 0 || y < 0 || x >= grounding.imageWidth || y >= grounding.imageHeight) {
    throw new Error(
      `${label} coordinates must be inside the ${grounding.imageWidth}x${grounding.imageHeight} screenshot`
    );
  }
  return { x, y };
}

async function assertPageUnchanged(
  host: VisualGroundingHost,
  guest: WebContents,
  grounding: VisualGrounding,
  label: string,
  signal?: AbortSignal
): Promise<void> {
  const current = await host.evaluate<{ url: string; width: number; height: number }>(
    guest,
    `(() => ({
      url: String(location.href),
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
    }))()`,
    signal
  );
  if (
    current.url !== grounding.url ||
    current.width !== grounding.viewportWidth ||
    current.height !== grounding.viewportHeight
  ) {
    host.visualGrounding.delete(guest);
    throw new Error(
      `${label} visual grounding is stale because the page or viewport changed; call snapshot with mode=both again`
    );
  }
}

/** A screenshot coordinate as a CSS point in the current viewport. */
export async function visualPoint(
  host: VisualGroundingHost,
  guest: WebContents,
  command: BrowserCommand,
  xValue: unknown,
  yValue: unknown,
  label: string,
  signal?: AbortSignal
): Promise<{ x: number; y: number }> {
  const grounding = await currentGrounding(host, guest, command, label, signal);
  const { x, y } = imagePoint(grounding, xValue, yValue, label);
  await assertPageUnchanged(host, guest, grounding, label, signal);
  return {
    x: (x * grounding.viewportWidth) / grounding.imageWidth,
    y: (y * grounding.viewportHeight) / grounding.imageHeight,
  };
}
