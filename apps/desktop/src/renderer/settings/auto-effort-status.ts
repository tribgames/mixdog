import { useEffect, useState } from 'react';
import { publishAutoEffort } from '../auto-effort-store';
import { record } from '../record-utils';
import type { CapabilityApi, RecordValue } from './capability-data';

// Auto reasoning downloads its judge model in the background (boot or a
// settings install). While that runs, the card follows the live status every
// second so it turns from "Installing…" into a switch without a reload, and
// the model picker learns the result at the same moment.
export function useAutoEffortStatus(api: CapabilityApi, snapshot: unknown): RecordValue {
  const [live, setLive] = useState<RecordValue | null>(null);
  const installing = record(live ?? snapshot).installing === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot is the trigger: a fresh settings snapshot discards the live override.
  useEffect(() => {
    setLive(null);
  }, [snapshot]);
  useEffect(() => {
    if (!installing || !api.invokeCapability) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await api.invokeCapability!({ capability: 'getToolModuleSettings', args: [] });
        const value = record(result.value);
        if (!disposed && value.autoEffort && typeof value.autoEffort === 'object') {
          setLive(record(value.autoEffort));
          publishAutoEffort(value);
        }
      } catch {
        /* a status read failure is not an installation failure */
      }
      if (!disposed) timer = setTimeout(poll, 1_000);
    };
    timer = setTimeout(poll, 1_000);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api.invokeCapability, installing]);
  return live ?? record(snapshot);
}
