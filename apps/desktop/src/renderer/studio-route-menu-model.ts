import { t } from './i18n';
import { ROUTE_SHEET_ROW_HEIGHT } from './route-editor-logic';
import { preferredFlyoutWidth, ROUTE_MODEL_FLYOUT_MAX_HEIGHT } from './route-editor-panes';

export interface StudioModelEntry {
  lane: string;
  laneLabel: string;
  authType?: string;
  model: string;
  label: string;
  description?: string;
  /** Muted note replacing the check: the row is listed but cannot be chosen. */
  unavailable?: string;
}

/** One lane option (aspect, resolution, …) surfaced as a sheet row. */
export interface StudioOptionRow {
  id: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  valueLabel: string;
  disabled?: boolean;
  onPick(value: string): void;
}

/** Continuous duration lanes keep their slider, hosted inside a pane. */
export interface StudioSliderRow {
  label: string;
  min: number;
  max: number;
  value: number;
  disabled?: boolean;
  onChange(value: number): void;
}

export interface StudioModelLane {
  id: string;
  label: string;
  authType?: string;
  items: StudioModelEntry[];
}

export function authTypeLabel(authType: unknown): string {
  if (authType === 'oauth') return t('Account');
  return authType === 'api-key' ? t('API key') : '';
}

/** Height caps; a side flyout sizes to its content below them. */
export function studioFlyoutSize(id: string, rows: StudioOptionRow[]): { maxHeight: number; width?: number } {
  if (id === 'model') return { maxHeight: ROUTE_MODEL_FLYOUT_MAX_HEIGHT, width: preferredFlyoutWidth('model') };
  if (id === 'slider') return { maxHeight: 76 };
  const count = rows.find((row) => row.id === id)?.options.length || 0;
  return { maxHeight: Math.min(300, Math.max(44, count * ROUTE_SHEET_ROW_HEIGHT + 34)) };
}

/** The model list as shown for a search: entries grouped by lane in first-seen
 *  order, each lane keeping only the entries the query matches, and whether
 *  the model-less Auto choice still matches. */
export function studioModelLanes(
  entries: StudioModelEntry[],
  modelQuery: string,
  autoLabel: string | undefined
): { autoVisible: boolean; visibleLanes: StudioModelLane[] } {
  const lanes: StudioModelLane[] = [];
  for (const entry of entries) {
    const bucket = lanes.find((group) => group.id === entry.lane);
    if (bucket) bucket.items.push(entry);
    else lanes.push({ id: entry.lane, label: entry.laneLabel, authType: entry.authType, items: [entry] });
  }
  const normalizedModelQuery = modelQuery.trim().toLocaleLowerCase();
  const autoVisible = Boolean(
    autoLabel !== undefined && (!normalizedModelQuery || autoLabel.toLocaleLowerCase().includes(normalizedModelQuery))
  );
  const visibleLanes = lanes
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (entry) =>
          !normalizedModelQuery ||
          `${entry.label} ${entry.model} ${entry.laneLabel}`.toLocaleLowerCase().includes(normalizedModelQuery)
      ),
    }))
    .filter((group) => group.items.length > 0);
  return { autoVisible, visibleLanes };
}
