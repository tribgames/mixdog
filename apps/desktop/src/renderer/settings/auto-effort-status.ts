import { useEffect, useMemo } from 'react';
import { publishAutoEffort } from '../auto-effort-store';
import { record } from '../record-utils';
import { useSection } from '../section-store';
import type { RecordValue } from './capability-data';

// Auto reasoning downloads its judge model in the background (boot or a settings install). The core pushes the
// tool-module state in its `toolModules` section, so the card turns from "Installing…" into a switch the moment the
// core says so. Hosts without the section supply the same entry in the requested status.
export function useAutoEffortStatus(fallback?: unknown): RecordValue {
  const entry = record(useSection<RecordValue>('toolModules')).autoEffort ?? fallback;
  const live = useMemo(() => record(entry), [entry]);
  useEffect(() => {
    if (entry) publishAutoEffort({ autoEffort: live });
  }, [entry, live]);
  return live;
}
