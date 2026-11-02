import { t } from './i18n';
import { navigationKey } from './text-format';
import type { PaneLeaf } from './pane-layout';
import type { MediaAsset } from './studio-support';

export interface StudioAssetGroup {
  id: 'today' | 'yesterday' | 'week' | 'earlier';
  label: string;
  assets: MediaAsset[];
}

const DAY_MS = 86_400_000;

/** Works (newest first) grouped by local calendar day: Today, Yesterday, the
 *  rest of the last seven days, Earlier. Empty groups are left out. */
export function groupStudioAssets(assets: readonly MediaAsset[], now = Date.now()): StudioAssetGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const groups: StudioAssetGroup[] = [
    { id: 'today', label: t('Today'), assets: [] },
    { id: 'yesterday', label: t('Yesterday'), assets: [] },
    { id: 'week', label: t('This week'), assets: [] },
    { id: 'earlier', label: t('Earlier'), assets: [] },
  ];
  for (const asset of assets) {
    const created = Number(asset.createdAt) || 0;
    const index = created >= today ? 0 : created >= today - DAY_MS ? 1 : created >= today - 6 * DAY_MS ? 2 : 3;
    groups[index]?.assets.push(asset);
  }
  return groups.filter((group) => group.assets.length > 0);
}

/** The works whose prompt contains `query` (case-insensitive); all when it is blank. */
export function filterStudioAssets(assets: readonly MediaAsset[], query: string): MediaAsset[] {
  const needle = query.trim().toLowerCase();
  return needle ? assets.filter((asset) => asset.prompt.toLowerCase().includes(needle)) : [...assets];
}

/** The Studio tab a rail click brings forward: the focused pane's active
 *  Studio tab, else a pane's active one, else the focused pane's newest, else
 *  any pane's newest. Null when no Studio tab is open. */
export function findStudioTab(
  leaves: readonly PaneLeaf[],
  focusedLeafId: string
): { leafId: string; key: string } | null {
  const studioKeys = (leaf: PaneLeaf) =>
    leaf.tabs.filter((tab) => tab.kind === 'studio').map((tab) => navigationKey(tab));
  const ordered = [
    ...leaves.filter((leaf) => leaf.id === focusedLeafId),
    ...leaves.filter((leaf) => leaf.id !== focusedLeafId),
  ];
  for (const leaf of ordered) {
    if (studioKeys(leaf).includes(leaf.activeKey)) return { leafId: leaf.id, key: leaf.activeKey };
  }
  for (const leaf of ordered) {
    const newest = studioKeys(leaf).at(-1);
    if (newest) return { leafId: leaf.id, key: newest };
  }
  return null;
}
