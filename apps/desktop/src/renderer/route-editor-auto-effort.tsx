import { t } from './i18n';

export function RouteAutoEffortToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange(enabled: boolean): void;
}) {
  return (
    <label className="route-sheet-row route-sheet-toggle">
      <span className="route-sheet-label">{t('Auto reasoning')}</span>
      <span className="mixdog-settings__switch compact-switch">
        <input
          type="checkbox"
          aria-label={t('Auto reasoning')}
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span aria-hidden="true" />
      </span>
    </label>
  );
}
