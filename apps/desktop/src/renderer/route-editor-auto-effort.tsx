import { t } from './i18n';

type RouteSheetSwitchProps = {
  enabled: boolean;
  disabled: boolean;
  onChange(enabled: boolean): void;
};

export function RouteAutoEffortToggle(props: RouteSheetSwitchProps) {
  return <RouteSheetSwitch label={t('Auto reasoning')} {...props} />;
}

/** Daybreak Blue for this route only (unlike Auto, which is global). The
 *  product name stays untranslated; the hint carries the meaning. */
export function RouteDaybreakToggle(props: RouteSheetSwitchProps) {
  return (
    <RouteSheetSwitch
      label="Daybreak Blue"
      description={t('Broader access for defensive cybersecurity work')}
      dataRow="daybreak"
      {...props}
    />
  );
}

function RouteSheetSwitch({
  label,
  description,
  dataRow,
  enabled,
  disabled,
  onChange,
}: RouteSheetSwitchProps & { label: string; description?: string; dataRow?: string }) {
  return (
    <label className="route-sheet-row route-sheet-toggle" title={description} data-route-toggle={dataRow}>
      <span className="route-sheet-label">{label}</span>
      <span className="mixdog-settings__switch compact-switch">
        <input
          type="checkbox"
          aria-label={label}
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span aria-hidden="true" />
      </span>
    </label>
  );
}
