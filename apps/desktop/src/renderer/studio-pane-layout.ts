import { useMemo } from 'react';
import { t } from './i18n';
import type { StudioMediaJob } from './studio-media-state';
import { groupStudioAssets } from './studio-panel-model';
import {
  type JustifiedTile,
  justifiedRows,
  type MediaAsset,
  type MediaKind,
  mediaFrameRatio,
  shouldKeepMediaJobSlot,
  STUDIO_GRID_GAP,
  STUDIO_GRID_MAX_WIDTH,
} from './studio-support';

// Pending run slots plus gallery tiles, solved into justified rows.
export function useStudioGridRows({
  frameRatiosSource,
  gridWidth,
  jobs,
  kind,
  rowHeight,
  visibleAssets,
}: {
  frameRatiosSource: Record<string, number>;
  gridWidth: number;
  jobs: StudioMediaJob[];
  kind: MediaKind;
  rowHeight: number;
  visibleAssets: MediaAsset[];
}) {
  // Every queued run holds its own slot in the grid, sized from its REQUESTED
  // aspect ratio so the finished asset lands without the tile changing shape
  // (user: 비율이 기존 비율이랑 다르다).
  const pendingJobs = useMemo(
    () => jobs.filter((entry) => shouldKeepMediaJobSlot(entry, visibleAssets, kind)),
    [jobs, visibleAssets, kind]
  );
  // Requested metadata is available before image/video thumbnail hydration.
  // Use it as the first-frame authority so poster decode never resizes a tile.
  const frameRatios = useMemo(() => {
    const next = { ...frameRatiosSource };
    for (const asset of visibleAssets) {
      if (!next[asset.id]) next[asset.id] = mediaFrameRatio(asset);
    }
    return next;
  }, [frameRatiosSource, visibleAssets]);
  // Results are grouped by day (Today, Yesterday, This week, Earlier), runs in
  // flight leading Today. Each day's rows are solved against the MEASURED
  // width so the last tile lands exactly on the right edge at every size.
  const layoutSections = useMemo((): StudioGridSection[] => {
    const tileRatios = { ...frameRatios };
    for (const entry of pendingJobs) tileRatios[entry.id] = mediaFrameRatio(entry);
    const groups = groupStudioAssets(visibleAssets);
    if (pendingJobs.length) {
      const pending = pendingJobs.map((entry) => ({ id: entry.id, kind: entry.kind }) as unknown as MediaAsset);
      const today = groups[0]?.id === 'today' ? groups[0] : null;
      if (today) today.assets.unshift(...pending);
      else groups.unshift({ id: 'today', label: t('Today'), assets: pending });
    }
    return groups.map((group) => ({
      id: group.id,
      label: group.label,
      rows: justifiedRows(group.assets, tileRatios, gridWidth, rowHeight, STUDIO_GRID_GAP, STUDIO_GRID_MAX_WIDTH),
    }));
  }, [pendingJobs, visibleAssets, frameRatios, gridWidth, rowHeight]);
  return { layoutSections, pendingJobs };
}

export interface StudioGridSection {
  id: string;
  label: string;
  rows: JustifiedTile[][];
}
