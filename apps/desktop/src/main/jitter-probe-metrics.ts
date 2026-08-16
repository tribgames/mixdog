import type { BrowserWindow, NativeImage } from 'electron';

export interface RowSample {
  t: number;
  st: number;
  sh?: number;
  ch?: number;
  space?: number;
  dist: number;
  following?: boolean;
  bands?: number[];
  plain?: number;
  queueHeight?: number;
  review?: {
    height: number;
    overlap: number;
    thinkingGap: number | null;
    composerGap: number | null;
  } | null;
  subject?: {
    open: boolean;
    rowHeight: number;
    cardHeight: number;
  } | null;
  rows: Array<{ i: number; top: number }>;
}

export interface ContentMotion {
  frames: number;
  maxRowShift: number;
  totalTravel: number;
  movingFrames: number;
  reversals: number;
  maxDistance: number;
  offBottomFrames: number;
  settleMs: number;
}

export interface PaintProbeBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface PaintFrameSample {
  t: number;
  phase: string;
  luma: number;
}

function sampledFrameLuma(image: NativeImage, bounds: PaintProbeBounds): number | null {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0
    || bounds.viewportWidth <= 0 || bounds.viewportHeight <= 0) return null;
  const bitmap = image.toBitmap();
  if (bitmap.length < size.width * size.height * 4) return null;
  const scaleX = size.width / bounds.viewportWidth;
  const scaleY = size.height / bounds.viewportHeight;
  const left = Math.max(0, Math.min(size.width - 1, Math.floor(bounds.left * scaleX)));
  const top = Math.max(0, Math.min(size.height - 1, Math.floor(bounds.top * scaleY)));
  const right = Math.max(left + 1, Math.min(
    size.width,
    Math.ceil((bounds.left + bounds.width) * scaleX),
  ));
  const bottom = Math.max(top + 1, Math.min(
    size.height,
    Math.ceil((bounds.top + bounds.height) * scaleY),
  ));
  let total = 0;
  let count = 0;
  const columns = 16;
  const rows = 10;
  for (let row = 0; row < rows; row += 1) {
    const y = Math.min(bottom - 1, top + Math.floor(((row + 0.5) / rows) * (bottom - top)));
    for (let column = 0; column < columns; column += 1) {
      const x = Math.min(right - 1, left
        + Math.floor(((column + 0.5) / columns) * (right - left)));
      const offset = (y * size.width + x) * 4;
      total += (bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / (3 * 255);
      count += 1;
    }
  }
  return count > 0 ? Math.round((total / count) * 10_000) / 10_000 : null;
}

export function beginPaintFrameProbe(window: BrowserWindow, bounds: PaintProbeBounds) {
  const startedAt = performance.now();
  const samples: PaintFrameSample[] = [];
  let phase = 'session';
  window.webContents.beginFrameSubscription(false, (image) => {
    if (samples.length >= 240) return;
    const luma = sampledFrameLuma(image, bounds);
    if (luma === null) return;
    samples.push({
      t: Math.round((performance.now() - startedAt) * 10) / 10,
      phase,
      luma,
    });
  });
  return {
    mark(nextPhase: string) {
      phase = nextPhase;
    },
    stop(): PaintFrameSample[] {
      window.webContents.endFrameSubscription();
      return samples;
    },
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function summarizeWarmPaint(samples: PaintFrameSample[]) {
  const phaseLuma = (phase: string) => samples
    .filter((sample) => sample.phase === phase)
    .map((sample) => sample.luma);
  const sessionLuma = median(phaseLuma('session'));
  const newTaskLuma = median(phaseLuma('new-task'));
  const reentry = samples.filter((sample) => sample.phase === 'reentry');
  const low = Math.min(sessionLuma ?? 0, newTaskLuma ?? sessionLuma ?? 0);
  const high = Math.max(sessionLuma ?? 0, newTaskLuma ?? sessionLuma ?? 0);
  const brightnessExcursion = reentry.reduce((peak, sample) => Math.max(
    peak,
    sample.luma < low ? low - sample.luma
      : sample.luma > high ? sample.luma - high
        : 0,
  ), 0);
  const stableTolerance = 0.025;
  const firstStableIndex = sessionLuma === null
    ? -1
    : reentry.findIndex((sample) => Math.abs(sample.luma - sessionLuma) <= stableTolerance);
  return {
    frames: samples.length,
    sessionFrames: phaseLuma('session').length,
    newTaskFrames: phaseLuma('new-task').length,
    reentryFrames: reentry.length,
    sessionLuma,
    newTaskLuma,
    maxBrightnessExcursion: Math.round(brightnessExcursion * 10_000) / 10_000,
    firstStablePaintFrame: firstStableIndex < 0 ? null : firstStableIndex + 1,
    samples,
  };
}

export function contentMotion(samples: RowSample[], shiftThreshold = 4): ContentMotion {
  let maxRowShift = 0;
  let totalTravel = 0;
  let movingFrames = 0;
  let reversals = 0;
  let lastDirection = 0;
  let settleAt = samples.length > 0 ? samples[0].t : 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = new Map(samples[index - 1].rows.map((row) => [row.i, row.top]));
    const deltas: number[] = [];
    for (const row of samples[index].rows) {
      const before = previous.get(row.i);
      if (before === undefined) continue;
      deltas.push(row.top - before);
    }
    if (deltas.length === 0) continue;
    deltas.sort((a, b) => a - b);
    const medianShift = deltas[Math.floor(deltas.length / 2)];
    const peak = Math.max(...deltas.map((value) => Math.abs(value)));
    maxRowShift = Math.max(maxRowShift, peak);
    totalTravel += Math.abs(medianShift);
    if (peak > shiftThreshold) {
      movingFrames += 1;
      settleAt = samples[index].t;
    }
    if (Math.abs(medianShift) > shiftThreshold) {
      const direction = Math.sign(medianShift);
      if (lastDirection !== 0 && direction !== lastDirection) reversals += 1;
      lastDirection = direction;
    }
  }
  const distances = samples.map((sample) => sample.dist);
  return {
    frames: samples.length,
    maxRowShift,
    totalTravel: Math.round(totalTravel),
    movingFrames,
    reversals,
    maxDistance: distances.length ? Math.max(...distances) : 0,
    offBottomFrames: distances.filter((value) => value > 8).length,
    settleMs: samples.length ? Math.max(0, settleAt - samples[0].t) : 0,
  };
}
