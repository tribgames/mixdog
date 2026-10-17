import { t } from './i18n';
import './initial-surface.css';

const INITIAL_ROW_KEYS = ['row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6', 'row-7', 'row-8', 'row-9', 'row-10'];

/** A neutral first-read state, never a claim that the result is empty.
 * Cached content stays with its owner; these slots are only for cold reads. */
export function InitialSurface({ variant = 'list' }: { variant?: 'list' | 'control' | 'icon' | 'rows' }) {
  if (variant === 'rows') {
    // Row-height placeholders (3 workflow rows, 3 default agents, 4 agents)
    // so the rows that replace them do not shift the layout.
    return (
      <div className="initial-surface initial-surface--rows" role="status" aria-label={t('Loading…')} aria-busy="true">
        {INITIAL_ROW_KEYS.map((key, index) => (
          <span key={key} className={index < 3 ? 'initial-surface-row' : 'initial-surface-row tall'} aria-hidden="true">
            <i />
          </span>
        ))}
      </div>
    );
  }
  return (
    <div
      className={`initial-surface initial-surface--${variant}`}
      role="status"
      aria-label={t('Loading…')}
      aria-busy="true"
    >
      <span className="initial-surface-shapes" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
