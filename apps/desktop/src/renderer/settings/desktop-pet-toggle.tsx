// Settings → Bots: regular check-ins and reactions, plus (this PC's desktop
// window only) the representative bot overlay, a small window that is a side
// chat with the representative bot (Mixy's agent id, whatever it is named).
// Every overlay option lives here, the same ones its right-click menu shows,
// kept in sync through main.
import { useState } from 'react';
import { isSshConnectionWindow } from '../desktop-connection';
import { record } from '../record-utils';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import type { PanelContext } from './capability-data';
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
  // A placement write in flight: the next choice waits for main's answer, so
  // it is always made against the placement actually in effect.
  const [placing, setPlacing] = useState(false);
  if (!config) return null;
  // No representative bot: the overlay cannot appear, so nothing here can
  // change; the stored setting is left as it is.
  const missing = created === false;
  const off = !config.enabled || missing;
  const option = (name: DesktopPetOption) => (on: boolean) => void setDesktopPetOption(name, on).catch(() => {});
  const position = config.pinned ? 'pinned' : config.pinnedHere ? 'pinnedHere' : config.onScreen ? 'onScreen' : 'free';
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
        title={t('Show on screen')}
        checked={config.enabled}
        disabled={missing}
        onChange={(enabled) => void setDesktopPetEnabled(enabled).catch(() => {})}
      />
      <SelectRow
        title={t('Position')}
        value={position}
        disabled={off || placing}
        options={[
          { value: 'pinned', label: t('Pin above the message box') },
          { value: 'pinnedHere', label: t('Pin here') },
          { value: 'free', label: t('Free in the app window') },
          { value: 'onScreen', label: t('Free on screen') },
        ]}
        onChange={(value) => {
          if (value === position) return;
          const name = (value === 'free' ? position : value) as DesktopPetOption;
          setPlacing(true);
          void setDesktopPetOption(name, value !== 'free')
            .catch(() => {})
            .finally(() => setPlacing(false));
        }}
      />
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

/** The Bots page: bot behavior on every surface, the overlay options only in
 *  this PC's own desktop window (the overlay is a window on this PC). */
export function BotsPanel({ data, pending, run }: PanelContext) {
  const busy = Boolean(pending);
  return (
    <>
      <Group title={t('Bot activity')}>
        <ToggleRow
          title={t('Regular check-ins')}
          description={t(
            'Every 30 minutes, checks your bots and sessions and lets you know only when something needs attention.'
          )}
          checked={record(data.heartbeat).heartbeat !== false}
          disabled={busy}
          onChange={(enabled) => void run('setHeartbeatEnabled', [enabled])}
        />
        <ToggleRow
          title={t('Reactions')}
          description={t('Bots can react to your messages with an emoji when it fits.')}
          checked={record(data.reactions).reactions !== false}
          disabled={busy}
          onChange={(enabled) => void run('setReactionsEnabled', [enabled])}
        />
      </Group>
      {!isRemoteHostRenderer() && !isSshConnectionWindow() && <DesktopPetToggle />}
    </>
  );
}
