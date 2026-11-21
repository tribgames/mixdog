import { useEffect } from 'react';
import { laneSpec, type MediaAsset, type MediaKind, type MediaLane } from './studio-support';
import { errorMessage } from './editor-pane-session-errors';

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
    void loadMoreAssets(kind).catch((reason) => setError(errorMessage(reason)));
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
