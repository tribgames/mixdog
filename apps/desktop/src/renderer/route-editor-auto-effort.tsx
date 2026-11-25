import { t } from './i18n';
import type { SubmenuItemProps } from './submenu';

type RouteSheetSwitchProps = {
  enabled: boolean;
  disabled: boolean;
  /** Its place among the sheet's pane rows: resting on it closes an open pane. */
  itemProps?: SubmenuItemProps;
  onChange(enabled: boolean): void;
};

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
  itemProps,
  onChange,
}: RouteSheetSwitchProps & { label: string; description?: string; dataRow?: string }) {
  return (
    <label
      className="route-sheet-row route-sheet-toggle"
      title={description}
      data-route-toggle={dataRow}
      {...itemProps}
    >
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
