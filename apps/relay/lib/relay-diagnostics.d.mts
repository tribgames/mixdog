export interface LoopDelayWindow {
  p50: number;
  p99: number;
  max: number;
}

export interface LoopDelayProbe {
  start(): void;
  stop(): void;
  take(): LoopDelayWindow;
}

export interface SocketSample {
  name: string;
  bufferedAmount: number;
}

export declare const SOCKET_REPORT_INTERVAL_MS: number;
export declare function bytesLabel(bytes: number): string;
export declare function createLoopDelayProbe(): LoopDelayProbe;
export declare function collectSockets(liveDesktops: Map<string, unknown>): { phones: number; sockets: SocketSample[] };
export declare function formatSocketReport(report: {
  phones: number;
  sockets: SocketSample[];
  loop: LoopDelayWindow;
  intervalMs: number;
}): string;
export declare function startSocketDiagnostics(options: {
  liveDesktops: Map<string, unknown>;
  intervalMs?: number;
  write?: (line: string) => void;
  loopDelay?: LoopDelayProbe;
  setTimer?: (tick: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): { stop(): void };
