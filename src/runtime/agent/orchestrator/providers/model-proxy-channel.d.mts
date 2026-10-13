export const MODEL_PROXY_REQUEST_EVENT: 'model-proxy-request';
export const MODEL_PROXY_OPERATIONS: Readonly<{
  claim: 'modelProxyClaim';
  event: 'modelProxyEvent';
  resolve: 'modelProxyResolve';
  heartbeat: 'modelProxyHeartbeat';
}>;
export type ModelProxyMethod = 'send' | 'listModels' | 'refreshModels' | 'isAvailable' | 'providerConfig';
export const MODEL_PROXY_METHODS: ReadonlyArray<ModelProxyMethod>;
export const MODEL_PROXY_HEARTBEAT_MS: number;
export const MODEL_PROXY_LEASE_MS: number;

export interface ModelProxyRequestDescriptor {
  id: string;
  provider: string;
  method: string;
  model: string | null;
}
export interface ModelProxySnapshot {
  requests: ModelProxyRequestDescriptor[];
  cancelled: string[];
}
export interface ModelProxyErrorRecord {
  name: string;
  message: string;
  props: Record<string, unknown>;
}

export class ModelProxyUnavailableError extends Error {
  code: 'MODEL_PROXY_UNAVAILABLE';
  constructor(detail: string);
}

export function modelProxyWireValue(value: unknown): unknown;
export function encodeModelProxyWire(value: unknown): string;
export function decodeModelProxyWire(text: unknown): unknown;
export function modelProxyErrorToWire(error: unknown): ModelProxyErrorRecord;
export function modelProxyErrorFromWire(record: unknown): Error;
export function splitModelProxySendOptions(opts: unknown): {
  options: Record<string, unknown>;
  callbacks: Record<string, (...args: unknown[]) => unknown>;
};
export function stripModelProxySecrets<T>(value: T): T;

export class ModelProxyChannel {
  constructor(options?: { now?: () => number; claimTimeoutMs?: number; leaseMs?: number; sweepMs?: number });
  readonly connected: boolean;
  readonly generation: number;
  whenConnected(timeoutMs: number): Promise<boolean>;
  attachPublisher(publish: (snapshot: ModelProxySnapshot) => void): () => void;
  disconnect(reason?: string): void;
  setClientPresent(present: boolean): void;
  request(
    call: Record<string, unknown>,
    options?: { signal?: AbortSignal | null; callbacks?: Record<string, (...args: unknown[]) => unknown> }
  ): Promise<unknown>;
  handlesOperation(name: string): boolean;
  handleOperation(name: string, args?: unknown[]): unknown;
  claim(id: unknown): { payload: string } | null;
  event(id: unknown, eventsText: unknown): Promise<{ cancelled: boolean; results: string }>;
  resolve(id: unknown, ok: boolean, valueText: unknown, errorText: unknown): boolean;
  heartbeat(ids: unknown): { cancelled: string[] };
  snapshot(): ModelProxySnapshot;
  sweep(): void;
}

export function getModelProxyChannel(): ModelProxyChannel;
