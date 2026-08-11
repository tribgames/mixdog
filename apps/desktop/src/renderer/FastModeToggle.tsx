import { t } from './i18n';
import { MxIcon } from './MxIcon';

export function FastModeIndicator({ ariaLabel = 'Fast On' }: {
  ariaLabel?: string;
}) {
  return <span className="fast-mode-indicator" role="img"
    aria-label={t(ariaLabel)} data-tooltip={t('Fast On')} data-tooltip-side="top">
    <MxIcon name="zap" size={12} fill="currentColor" />
  </span>;
}

export function FastModeToggle({ enabled, disabled = false, ariaLabel = 'Fast mode', onChange }: {
  enabled: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onChange(enabled: boolean): void;
}) {
  const stateLabel = t(enabled ? 'Fast On' : 'Fast Off');
  return <button type="button"
    className={`fast-mode-toggle${enabled ? ' is-on' : ''}`}
    aria-label={t(ariaLabel)}
    aria-pressed={enabled}
    disabled={disabled}
    data-tooltip={stateLabel}
    data-tooltip-side="top"
    onClick={() => onChange(!enabled)}>
    <MxIcon name="zap" size={14} fill={enabled ? 'currentColor' : 'none'} />
    <span className="sr-only">{stateLabel}</span>
  </button>;
}
