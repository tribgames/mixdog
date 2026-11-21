export const RENDERER_PROBE_FLAG_FILE = 'renderer-profile.on';
export const RENDERER_PROBE_LOG_FILE = 'renderer-perf.jsonl';

export interface DesktopRendererProbeScript {
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  sourceCharPosition: number;
  duration: number;
  forcedStyleAndLayoutDuration: number;
}

/** One frame over the long-frame threshold. */
export interface DesktopRendererProbeFrame {
  kind: 'frame';
  entryType: 'long-animation-frame' | 'longtask';
  duration: number;
  blockingDuration: number;
  styleAndLayoutDuration: number;
  scripts: DesktopRendererProbeScript[];
}

/** One summary window. `frames` counts the animation frames delivered while
 *  the probe asked for each one. */
export interface DesktopRendererProbeSummary {
  kind: 'summary';
  windowMs: number;
  frames: number;
  longFrames: number;
  blockedMs: number;
  /** IPC messages received per channel in the window. */
  ipc: Record<string, number>;
}

export type DesktopRendererProbeRecord = DesktopRendererProbeFrame | DesktopRendererProbeSummary;

export interface DesktopRendererProbeApi {
  /** Whether the flag file exists now. */
  enabled(): Promise<boolean>;
  /** Counts the IPC messages each channel receives (on), or stops and forgets. */
  countIpc(on: boolean): void;
  /** The per-channel counts since the previous take. */
  takeIpcCounts(): Record<string, number>;
  /** Appends one record to the probe log while the flag exists. */
  write(record: DesktopRendererProbeRecord): void;
}
