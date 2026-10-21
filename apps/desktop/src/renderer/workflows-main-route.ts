import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import type { DesktopApi } from '../shared/contract';
import type { RecordValue, Snapshot } from './desktop-types';
import { draftModelSelectionFromSnapshot } from './draft-pane-prefs-store';
import { record } from './record-utils';
import { subscribeSetupChanges } from './setup-change-refresh';

/** `{ fallbacks }` of the Lead preset (workflow-lead) in a presets list; nothing when it has none. */
export function leadFallbacksOf(presets: unknown): { fallbacks?: RecordValue[] } {
  const lead = (Array.isArray(presets) ? presets : []).find((entry) => record(entry).id === 'workflow-lead');
  const fallbacks = record(lead).fallbacks;
  return Array.isArray(fallbacks) && fallbacks.length ? { fallbacks: fallbacks as RecordValue[] } : {};
}

/** The Lead route the runtime uses for new sessions: the stored Lead preset
 *  (workflow-lead) when there is one, else the host's current route. A New
 *  task pick rewrites that preset, so this follows it. */
export function leadRouteFrom(snapshotRoute: RecordValue, presets: unknown): RecordValue {
  const lead = (Array.isArray(presets) ? presets : []).find((entry) => record(entry).id === 'workflow-lead');
  const stored = record(lead);
  if (!stored.provider || !stored.model) return snapshotRoute;
  const { id: _id, name: _name, type: _type, tools: _tools, ...route } = stored;
  return { ...route, ...leadFallbacksOf(presets) };
}

/** The Lead's model is the Main route: what a new coding session starts on.
 *  Nothing is stored here; it is read from, and written back to, the host. */
export function useLeadMainRoute(
  active: boolean,
  api: Partial<Pick<DesktopApi, 'invokeCapability' | 'getSnapshot'>> | undefined
): [RecordValue, Dispatch<SetStateAction<RecordValue>>] {
  const [mainRoute, setMainRoute] = useState<RecordValue>({});
  useEffect(() => {
    if (!active || !api?.getSnapshot) return;
    let live = true;
    const read = () =>
      void Promise.all([
        api.getSnapshot?.(),
        Promise.resolve(api.invokeCapability?.<unknown[]>({ capability: 'listPresets' })).catch(() => undefined),
      ])
        .then(([snapshot, presets]) => {
          if (live)
            setMainRoute(
              leadRouteFrom({ ...draftModelSelectionFromSnapshot(snapshot as unknown as Snapshot) }, presets?.value)
            );
        })
        .catch(() => {});
    read();
    // A New task pick (or any setup/settings change) rewrites the Lead preset.
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [active, api]);
  return [mainRoute, setMainRoute];
}
