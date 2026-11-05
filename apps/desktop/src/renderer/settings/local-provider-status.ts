import { useMemo } from 'react';
import { record } from '../record-utils';
import { useSection } from '../section-store';
import type { RecordValue } from './capability-data';

export function localProviderFileSize(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${(value / 1_000_000_000).toFixed(1)} GB`;
}

export function localProviderInstallation(status: RecordValue, phase: string, modelId?: string): RecordValue {
  const entries = Array.isArray(status.installations) ? status.installations.map(record) : [];
  return (
    entries.find(
      (entry) => entry.phase === phase && entry.state === 'running' && (!modelId || entry.modelId === modelId)
    ) || {}
  );
}

/** A running or cancelling job still owns its model and blocks new operations. */
export function installationActive(installation: RecordValue): boolean {
  return ['running', 'cancelling'].includes(String(installation.state));
}

export function installationPercent(installation: RecordValue): number | null {
  const value = installation.percent;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

/** Installation progress is the core's `toolModules` section (`localProvider`), pushed on every change; it is the only
 *  source, so it never waits for the pending installation command and a slow download never blocks it. */
export function useLocalProviderStatus(): RecordValue {
  const pushed = record(useSection<RecordValue>('toolModules')).localProvider;
  return useMemo(() => record(pushed), [pushed]);
}

