import { useEffect } from 'react';
import { errorText, laneSpec, type MediaAsset, type MediaKind, type MediaLane } from './studio-support';

/** The open asset's neighbours in gallery order, and its route named with the
 *  catalog's labels instead of lane and model ids. Paging toward the end of
 *  the loaded list pulls the next page, so a swipe through a long gallery
 *  never dead-ends at a page boundary. */
export function useStudioDetailPaging({
  selected,
  visibleAssets,
  lanes,
  kind,
  loadMoreAssets,
  setError,
}: {
  selected: MediaAsset | null;
  visibleAssets: MediaAsset[];
  lanes: readonly MediaLane[];
  kind: MediaKind;
  loadMoreAssets(kind: MediaKind): Promise<unknown>;
  setError(error: string): void;
}) {
  const selectedIndex = selected ? visibleAssets.findIndex((asset) => asset.id === selected.id) : -1;
  const selectedLane = selected ? lanes.find((entry) => entry.id === selected.lane) || null : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: setError is a state setter
  useEffect(() => {
    if (selectedIndex < 0 || selectedIndex < visibleAssets.length - 3) return;
    void loadMoreAssets(kind).catch((reason) => setError(errorText(reason)));
  }, [kind, loadMoreAssets, selectedIndex, visibleAssets.length]);
  return {
    previousAsset: selectedIndex > 0 ? visibleAssets[selectedIndex - 1] || null : null,
    nextAsset: selectedIndex >= 0 ? visibleAssets[selectedIndex + 1] || null : null,
    selectedLane,
    selectedModelLabel: selected
      ? laneSpec(selectedLane, selected.kind)?.models.find((entry) => entry.id === selected.model)?.label ||
        selected.model
      : '',
  };
}
