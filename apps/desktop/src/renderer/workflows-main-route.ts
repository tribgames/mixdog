import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import type { DesktopApi, SessionSnapshot } from '../shared/contract';
import type { RecordValue } from './desktop-types';
import { draftModelSelectionFromSnapshot, leadRouteFrom } from './draft-pane-prefs-store';
import { listPresetsShared, newestOnly, subscribePresetsPushes } from './sidebar-reference-cache';
import { subscribeSetupChanges } from './setup-change-refresh';

export { leadFallbacksOf, leadRouteFrom } from './draft-pane-prefs-store';

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
    let shown = false;
    const newest = newestOnly();
    const routeOf = (snapshot: SessionSnapshot | undefined, presets: unknown) =>
      leadRouteFrom({ ...draftModelSelectionFromSnapshot(snapshot) }, presets);
    const read = () => {
      const snapshot = Promise.resolve(api.getSnapshot?.());
      void newest(Promise.all([snapshot, listPresetsShared(api)]))
        .then(({ current, value: [snapshotValue, presets] }) => {
          if (!live || !current) return;
          shown = true;
          setMainRoute(routeOf(snapshotValue, presets?.value));
        })
        // A preset read that fails before any route showed: the host's own route
        // stands in, without counting as applied, so a pending full read still lands.
        .catch(() =>
          snapshot.then((snapshotValue) => {
            if (live && !shown) setMainRoute(routeOf(snapshotValue, undefined));
          })
        )
        .catch(() => {});
    };
    read();
    // A New task pick (or any setup/settings change) rewrites the Lead preset.
    const unsubscribe = subscribeSetupChanges(read);
    // The core publishes a saved Lead after the save answers: the first re-read can still see the old preset.
    const unfollow = subscribePresetsPushes(api, read);
    return () => {
      live = false;
      unsubscribe();
      unfollow();
    };
  }, [active, api]);
  return [mainRoute, setMainRoute];
}
