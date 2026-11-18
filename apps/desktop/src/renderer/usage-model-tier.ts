import { t } from './i18n';
import type { Row } from './usage-stats-model';

function speedTier(row: Row) {
  switch (row.speedTier) {
    case 'standard':
    case 'fast':
    case 'ultrafast':
      return row.speedTier;
    default:
      return row.fast === true ? 'fast' : 'standard';
  }
}

export const usageModelId = (row: Row) => String(row.modelId || row.model || row.key || '');
export const usageModelKey = (row: Row) => `${usageModelId(row)}\u0000${speedTier(row)}`;

export function usageTierBadge(row: Row) {
  switch (speedTier(row)) {
    case 'fast':
      return { label: t('Fast'), className: 'model-route-label-fast' };
    case 'ultrafast':
      return { label: t('Ultrafast'), className: 'model-route-label-ultra' };
    default:
      return null;
  }
}
