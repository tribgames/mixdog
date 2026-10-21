import type { StudioModelEntry } from './StudioRouteMenu';
import { laneCatalogStatus, type MediaKind, type MediaLane } from './studio-support';

/** The anchored model picker's rows: every authenticated lane's models for the
 *  active kind, grouped by provider, then each signed-in lane whose catalog is
 *  still loading or failed, listed with that state. */
export function studioModelEntries(
  available: readonly MediaLane[],
  kind: MediaKind,
  lanes: readonly MediaLane[]
): StudioModelEntry[] {
  return [
    ...available.flatMap((entry) => {
      const kindSpec = kind === 'video' ? entry.video : entry.image;
      return (kindSpec?.models || []).map((option) => ({
        lane: entry.id,
        laneLabel: entry.label,
        authType: entry.authType,
        model: option.id,
        label: option.label,
        description: option.description,
      }));
    }),
    // A signed-in lane whose catalog is still loading or failed is listed
    // with that state, never silently dropped from the picker.
    ...lanes.flatMap((entry) => {
      const status = laneCatalogStatus(entry, kind);
      return status
        ? [
            {
              lane: entry.id,
              laneLabel: entry.label,
              authType: entry.authType,
              model: '',
              label: entry.label,
              unavailable: status,
            },
          ]
        : [];
    }),
  ];
}
