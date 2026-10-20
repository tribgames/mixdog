import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomicSync } from '../../../../src/runtime/shared/atomic-file.mjs';

const GPU_CRASH_WINDOW_MS = 30_000;
const GPU_CRASH_THRESHOLD = 3;
const GPU_FALLBACK_SCHEMA_VERSION = 1;
const GPU_FALLBACK_MARKER_FILE = 'gpu-rendering-fallback.json';
const GPU_CRASH_REASONS = new Set(['abnormal-exit', 'crashed', 'launch-failed']);

export interface GpuFallbackEnvironment {
  appVersion: string;
  electronVersion: string;
  platform: NodeJS.Platform;
}

interface GpuFallbackMarker {
  schemaVersion: number;
  engagedAt: number;
  crashesInWindow: number;
  appVersion: string;
  electronVersion: string;
  platform: 'win32';
}

interface GpuFallbackDecision {
  crashes: number[];
  action: 'none' | 'engage';
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, GPU_FALLBACK_MARKER_FILE);
}

function clearMarker(userDataPath: string): void {
  try {
    rmSync(markerPath(userDataPath), { force: true });
  } catch {
    // A stale marker is revalidated on every launch.
  }
}

export function gpuFallbackDecision(
  previousCrashes: readonly number[],
  details: { platform: NodeJS.Platform; type?: string; reason: string },
  now = Date.now()
): GpuFallbackDecision {
  const crashes = previousCrashes.filter((at) => Number.isFinite(at) && now >= at && now - at <= GPU_CRASH_WINDOW_MS);
  const candidate =
    details.platform === 'win32' &&
    String(details.type || '').toLowerCase() === 'gpu' &&
    GPU_CRASH_REASONS.has(details.reason);
  if (!candidate) return { crashes, action: 'none' };
  crashes.push(now);
  return {
    crashes,
    action: crashes.length >= GPU_CRASH_THRESHOLD ? 'engage' : 'none',
  };
}

export function readActiveGpuFallbackMarker(
  userDataPath: string,
  environment: GpuFallbackEnvironment
): GpuFallbackMarker | null {
  const path = markerPath(userDataPath);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GpuFallbackMarker>;
    const valid =
      parsed.schemaVersion === GPU_FALLBACK_SCHEMA_VERSION &&
      Number.isFinite(parsed.engagedAt) &&
      Number.isFinite(parsed.crashesInWindow) &&
      parsed.platform === 'win32' &&
      typeof parsed.appVersion === 'string' &&
      typeof parsed.electronVersion === 'string';
    if (
      !valid ||
      environment.platform !== 'win32' ||
      parsed.appVersion !== environment.appVersion ||
      parsed.electronVersion !== environment.electronVersion
    ) {
      clearMarker(userDataPath);
      return null;
    }
    return parsed as GpuFallbackMarker;
  } catch {
    if (existsSync(path)) clearMarker(userDataPath);
    return null;
  }
}

export function writeGpuFallbackMarker(
  userDataPath: string,
  info: { engagedAt: number; crashesInWindow: number },
  environment: GpuFallbackEnvironment & { platform: 'win32' }
): void {
  const marker: GpuFallbackMarker = {
    schemaVersion: GPU_FALLBACK_SCHEMA_VERSION,
    engagedAt: info.engagedAt,
    crashesInWindow: info.crashesInWindow,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: 'win32',
  };
  // Published whole and flushed: this marker is written while the GPU process
  // keeps crashing, and a torn one would drop the fallback it records.
  writeJsonAtomicSync(markerPath(userDataPath), marker, { compact: true });
}
