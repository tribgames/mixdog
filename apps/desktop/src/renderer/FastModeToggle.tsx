import { t } from './i18n';
import { MxIcon } from './MxIcon';

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
    <MxIcon name="zap" size={16} />
    <span className="sr-only">{stateLabel}</span>
  </button>;
}
