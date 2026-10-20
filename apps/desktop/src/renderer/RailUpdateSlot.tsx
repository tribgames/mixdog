import { ArrowDown } from 'lucide-react';

import type { DesktopUpdaterState } from '../shared/contract';
import { downloadPercent, isAppUpdatePending, useNativeAppUpdate } from './AppUpdateBanner';
import { t } from './i18n';

// One update button for the rail's foot, above Usage and Settings. Two state
// sources feed it: the Android shell's own app update (the phone app shows the
// PC's renderer, so the PC's updater is not what the user can act on there) and
// the desktop updater of the Electron app.

export type RailUpdateSettingsTarget = 'update';

export interface RailUpdate {
  kind: 'ready' | 'downloading' | 'available';
  label: string;
  /** 0-100 while downloading, when known. */
  percent?: number;
  disabled?: boolean;
  press(): void;
}

function railLabel(app: string, kind: RailUpdate['kind'], version: string, percent?: number): string {
  if (kind === 'ready') return t('{{app}} v{{version}} install', { app, version });
  if (kind === 'available') return t('{{app}} v{{version}} update', { app, version });
  return percent === undefined
    ? t('{{app}} v{{version}} downloading', { app, version })
    : t('{{app}} v{{version}} downloading {{percent}}%', { app, version, percent });
}

function usePhoneRailUpdate(openSettings: (section: RailUpdateSettingsTarget) => void): {
  bridge: boolean;
  update: RailUpdate | null;
} {
  const { bridge, state, apply } = useNativeAppUpdate();
  const native = bridge?.call;
  if (!native) return { bridge: false, update: null };
  if (!state || !isAppUpdatePending(state)) return { bridge: true, update: null };
  const app = t('Phone app');
  const version = state.version ?? '';
  const act = (request: Promise<unknown>) => void request.then(apply).catch(() => undefined);
  if (state.status === 'downloading') {
    const percent = downloadPercent(state);
    return {
      bridge: true,
      update: {
        kind: 'downloading',
        label: railLabel(app, 'downloading', version, percent),
        percent,
        press: () => openSettings('update'),
      },
    };
  }
  if (state.status === 'available') {
    return {
      bridge: true,
      update: {
        kind: 'available',
        label: railLabel(app, 'available', version),
        press: () => act(native('startAppUpdate')),
      },
    };
  }
  return {
    bridge: true,
    update: {
      kind: 'ready',
      label: railLabel(app, 'ready', version),
      disabled: state.status === 'installing',
      press: () => act(native('installAppUpdate')),
    },
  };
}

function useDesktopRailUpdate(
  state: DesktopUpdaterState | undefined,
  install: (() => void) | undefined,
  openSettings: (section: RailUpdateSettingsTarget) => void
): RailUpdate | null {
  if (!state || !('version' in state)) return null;
  const app = 'Mixdog';
  if (state.status === 'downloading') {
    return {
      kind: 'downloading',
      label: railLabel(app, 'downloading', state.version, state.percent),
      percent: state.percent,
      press: () => openSettings('update'),
    };
  }
  return {
    kind: 'ready',
    label: railLabel(app, 'ready', state.version),
    disabled: state.status === 'installing' || !install,
    press: () => install?.(),
  };
}

export function useRailUpdate(
  desktopState: DesktopUpdaterState | undefined,
  installDesktop: (() => void) | undefined,
  openSettings: (section: RailUpdateSettingsTarget) => void
): RailUpdate | null {
  const phone = usePhoneRailUpdate(openSettings);
  const desktop = useDesktopRailUpdate(desktopState, installDesktop, openSettings);
  // Inside the phone app the PC's renderer is shown: only the phone's own
  // update counts there, never the PC's.
  return phone.bridge ? phone.update : desktop;
}

const RING_RADIUS = 15;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Height of one rail cell (06-activity-rail.css): the pinned usage stack reserves it. */
export const RAIL_UPDATE_SLOT_HEIGHT = 44;

export function RailUpdateSlot({ update }: { update: RailUpdate | null }) {
  if (!update) return null;
  return (
    <button
      type="button"
      className="rail-update-slot"
      data-kind={update.kind}
      aria-label={update.label}
      data-tooltip={update.label}
      disabled={update.disabled}
      onClick={update.press}
    >
      {update.kind === 'downloading' ? null : <ArrowDown size={16} aria-hidden="true" />}
      {update.kind === 'downloading' ? (
        <svg className="rail-update-ring" viewBox="0 0 34 34" aria-hidden="true">
          <circle cx="17" cy="17" r={RING_RADIUS} className="rail-update-ring-track" />
          {update.percent === undefined ? null : (
            <circle
              cx="17"
              cy="17"
              r={RING_RADIUS}
              className="rail-update-ring-fill"
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={RING_LENGTH * (1 - update.percent / 100)}
            />
          )}
        </svg>
      ) : null}
    </button>
  );
}
