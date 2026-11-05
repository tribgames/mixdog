import { useEffect, useMemo } from 'react';
import { publishAutoEffort } from '../auto-effort-store';
import { record } from '../record-utils';
import { useSection } from '../section-store';
import type { RecordValue } from './capability-data';

// Auto reasoning downloads its judge model in the background (boot or a settings install). The core pushes the
// tool-module state in its `toolModules` section, so the card turns from "Installing…" into a switch the moment the
// core says so, and the model picker learns the result at the same moment. The section is the only source: it arrives
// with the app snapshot.
export function useAutoEffortStatus(): RecordValue {
  const pushed = record(useSection<RecordValue>('toolModules')).autoEffort;
  const live = useMemo(() => record(pushed), [pushed]);
  useEffect(() => {
    if (pushed) publishAutoEffort({ autoEffort: live });
  }, [pushed, live]);
  return live;
}


