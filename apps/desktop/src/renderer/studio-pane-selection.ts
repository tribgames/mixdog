import { type Dispatch, type SetStateAction, useCallback, useState } from 'react';
import { t } from './i18n';
import type { StudioCleanupRequest } from './studio-cleanup';
import { removeStudioAssetReferences, type StudioReferenceStore } from './studio-draft-cache';
import type { StudioMediaJob } from './studio-media-state';
import { callCapability, errorText, type MediaAsset, type MediaKind, type StudioApi } from './studio-support';

// Selection mode for bulk delete: a tile click toggles its check instead of
// opening the detail.
export function useStudioSelection({
  api,
  kind,
  referenceStore,
  reloadAssetKind,
  selected,
  setError,
  setHoverId,
  setJobs,
  setSelected,
}: {
  api: StudioApi | undefined;
  kind: MediaKind;
  referenceStore: StudioReferenceStore | undefined;
  reloadAssetKind: (assetKind: MediaKind, removedIds: readonly string[]) => Promise<unknown>;
  selected: MediaAsset | null;
  setError: (message: string) => void;
  setHoverId: (id: string) => void;
  setJobs: Dispatch<SetStateAction<StudioMediaJob[]>>;
  setSelected: (asset: MediaAsset | null) => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  const exitSelection = useCallback(() => {
    setSelecting(false);
    setCheckedIds(new Set());
  }, []);
  const toggleChecked = (asset: MediaAsset) =>
    setCheckedIds((current) => {
      const next = new Set(current);
      if (!next.delete(asset.id)) next.add(asset.id);
      return next;
    });
  /** Select all means the whole tab, not just the pages scrolled in so far:
   *  deleting a loaded-only selection let the next page refill the grid. */
  const selectAll = async () => {
    try {
      const preview = (await callCapability(api, 'deleteMediaAssets', [{ all: true, kind, dryRun: true }])) as
        | { ids?: string[] }
        | undefined;
      setCheckedIds(new Set(Array.isArray(preview?.ids) ? preview.ids : []));
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  /** Bulk cleanup: the runtime names the matching ids first, the user confirms
   *  that exact count, and only those ids are deleted. */
  const cleanUp: StudioCleanupRequest = async (filter, confirmText) => {
    setHoverId('');
    try {
      const preview = (await callCapability(api, 'deleteMediaAssets', [{ ...filter, kind, dryRun: true }])) as
        | { ids?: string[] }
        | undefined;
      const ids = Array.isArray(preview?.ids) ? preview.ids : [];
      if (!ids.length) {
        window.alert(t('No items to delete.'));
        return;
      }
      if (!window.confirm(confirmText(ids.length))) return;
      const result = (await callCapability(api, 'deleteMediaAssets', [{ ids }])) as { ids?: string[] } | undefined;
      const removed = Array.isArray(result?.ids) ? result.ids : [];
      const gone = new Set(removed);
      await Promise.all(removed.map((id) => removeStudioAssetReferences(id, referenceStore)));
      if (selected && gone.has(selected.id)) setSelected(null);
      setJobs((current) => current.filter((entry) => !(entry.assetId && gone.has(entry.assetId))));
      exitSelection();
      await reloadAssetKind(kind, removed);
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  return { checkedIds, cleanUp, exitSelection, selectAll, selecting, setSelecting, toggleChecked };
}
