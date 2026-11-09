export const HEARTBEAT_INTERVAL_CHOICES: readonly number[];
export const DEFAULT_HEARTBEAT_INTERVAL_MINUTES: number;
export function normalizeHeartbeatIntervalMinutes(value: unknown): number;
export function requireHeartbeatIntervalMinutes(value: unknown): number;
