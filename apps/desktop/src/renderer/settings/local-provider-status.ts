import { useEffect, useState } from 'react';
import { record } from '../record-utils';
import type { CapabilityApi, RecordValue } from './capability-data';

export function localProviderInstallation(status: RecordValue, phase: string, modelId?: string): RecordValue {
  const entries = Array.isArray(status.installations) ? status.installations.map(record) : [];
  return entries.find((entry) => entry.phase === phase && entry.state === 'running'
    && (!modelId || entry.modelId === modelId)) || {};
}

export function installationPercent(installation: RecordValue): number | null {
  const value = installation.percent;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

// Read independently of the pending installation command. A slow download
// must not block progress reads; failed reads retain the last good snapshot.
export function useLocalProviderStatus(api: CapabilityApi, snapshot: unknown, active: boolean) {
  const [live, setLive] = useState<RecordValue | null>(null);
  useEffect(() => {
    setLive(null);
    if (!active || (!api.readCapabilities && !api.invokeCapability)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const request = { capability: 'getToolModuleSettings' as const, args: [] };
        let value: unknown;
        if (api.readCapabilities) {
          const [result] = await api.readCapabilities([request]);
          if (!result?.ok) throw new Error('Local Provider status unavailable');
          value = result.value;
        } else {
          value = (await api.invokeCapability!(request)).value;
        }
        const status = record(value).localProvider;
        if (!disposed && status && typeof status === 'object') setLive(record(status));
      } catch { /* a status read failure is not an installation failure */ }
      if (!disposed) timer = setTimeout(poll, 1_000);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api.readCapabilities, api.invokeCapability, snapshot, active]);
  return active && live ? live : record(snapshot);
}
