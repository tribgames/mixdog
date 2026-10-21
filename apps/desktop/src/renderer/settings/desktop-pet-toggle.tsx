// Settings → Bots, this PC's desktop window only: the representative bot
// overlay, a small window that is a side chat with the representative bot
// (Mixy's agent id, whatever it is named). Every overlay option lives here,
// the same ones its right-click menu shows, kept in sync through main.
import { DESKTOP_PET_SCALES, type DesktopPetOption } from '../../shared/desktop-pet';
import {
  resetDesktopPetPosition,
  setDesktopPetEnabled,
  setDesktopPetOption,
  setDesktopPetScale,
  useDesktopPetConfig,
} from '../desktop-pet-publisher';
import { t } from '../i18n';
import { useMixyCreated } from '../mixy-first';
import { ActionButton, Group, SelectRow, ToggleRow } from './capability-controls';

const SCALE_OPTIONS = DESKTOP_PET_SCALES.map((scale) => ({ value: String(scale), label: `${scale}%` }));

export function DesktopPetToggle() {
  const config = useDesktopPetConfig();
  // The same answer the Bots page and the overlay use (mixy-first.tsx).
  const created = useMixyCreated(window.mixdogDesktop);
  if (!config) return null;
  // No representative bot: the overlay cannot appear, so nothing here can
  // change; the stored setting is left as it is.
  const missing = created === false;
  const off = !config.enabled || missing;
  const option = (name: DesktopPetOption) => (on: boolean) => void setDesktopPetOption(name, on).catch(() => {});
  return (
    <Group
      title={t('Representative bot overlay')}
      description={
        missing
          ? t('Create the representative bot to use the overlay.')
          : t('Always overlay the representative bot on your screen.')
      }
      actions={
        <ActionButton disabled={off} onClick={() => void resetDesktopPetPosition().catch(() => {})}>
          {t('Reset position')}
        </ActionButton>
      }
    >
      <ToggleRow
        title={t('Representative bot overlay')}
        checked={config.enabled}
        disabled={missing}
        onChange={(enabled) => void setDesktopPetEnabled(enabled).catch(() => {})}
      />
      <ToggleRow
        title={t('Pin above the message box')}
        checked={config.pinned}
        disabled={off}
        onChange={option('pinned')}
      />
      <ToggleRow title={t('Pin here')} checked={config.pinnedHere} disabled={off} onChange={option('pinnedHere')} />
      <ToggleRow
        title={t('Keep above other windows')}
        checked={config.keepAbove}
        disabled={off}
        onChange={option('keepAbove')}
      />
      <ToggleRow
        title={t('Collapse bubble')}
        checked={config.collapsed}
        disabled={off}
        onChange={option('collapsed')}
      />
      <ToggleRow
        title={t('Auto-advance long replies')}
        checked={config.autoAdvance}
        disabled={off}
        onChange={option('autoAdvance')}
      />
      <ToggleRow
        title={t('Close replies automatically')}
        checked={config.autoClose}
        disabled={off}
        onChange={option('autoClose')}
      />
      <SelectRow
        title={t('Size')}
        value={String(config.scale)}
        disabled={off}
        options={SCALE_OPTIONS}
        onChange={(value) => void setDesktopPetScale(Number(value)).catch(() => {})}
      />
    </Group>
  );
}

/** The Bots page. */
export function BotsPanel() {
  return <DesktopPetToggle />;
}
