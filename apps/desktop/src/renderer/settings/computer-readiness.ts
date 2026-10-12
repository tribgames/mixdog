// Computer Use readiness as list rows: one pure mapping from what the main
// process reads (Linux capabilities, macOS grants) to what the detail dialog
// shows. Windows needs no grant, so it maps to no rows.
import type {
  DesktopComputerCapability,
  DesktopComputerPermissionPane,
  DesktopComputerReadiness,
  DesktopLinuxComputerReadiness,
} from '../../shared/contract';
import { t } from '../i18n';

export type ComputerReadinessIcon = 'pointer' | 'window' | 'clipboard' | 'text' | 'monitor' | 'accessibility';

export type ComputerReadinessAction =
  | { kind: 'allow_input'; label: string }
  | { kind: 'retry'; label: string }
  | { kind: 'install_how'; label: string; package: string }
  | { kind: 'open_settings'; label: string; pane: DesktopComputerPermissionPane };

export interface ComputerReadinessRow {
  id: string;
  icon: ComputerReadinessIcon;
  title: string;
  description: string;
  status: string;
  /** `muted` for optional and unsupported rows, `warn` for what blocks work. */
  tone: 'warn' | 'muted';
  /** True while the user (or the app) can still make this ready. */
  needsSetup: boolean;
  optional: boolean;
  action?: ComputerReadinessAction;
}

const MACOS_GRANT_REQUIRED = new Set(['not-determined', 'denied', 'restricted']);

function desktopName(desktop: DesktopLinuxComputerReadiness['desktop']): string {
  if (desktop === 'gnome') return 'GNOME';
  if (desktop === 'kde') return 'KDE';
  if (desktop === 'sway') return 'Sway';
  if (desktop === 'hyprland') return 'Hyprland';
  return t('This desktop');
}

/** The first of several capabilities that is not ready (they share one row). */
function firstPending(...capabilities: DesktopComputerCapability[]): DesktopComputerCapability {
  return capabilities.find((capability) => capability.state !== 'ready') ?? capabilities[0];
}

function linuxRows(linux: DesktopLinuxComputerReadiness): ComputerReadinessRow[] {
  const { capabilities } = linux;
  const rows: ComputerReadinessRow[] = [];
  const pending = (capability: DesktopComputerCapability) =>
    capability.state === 'needs_setup' || capability.state === 'unsupported';
  const base = (capability: DesktopComputerCapability) => {
    const optional = capability.optional === true;
    const needsSetup = capability.state === 'needs_setup';
    let status = t('Needed');
    if (capability.state === 'unsupported') status = t('Not supported');
    else if (optional) status = t('Optional add-on');
    return {
      status,
      tone: (optional || !needsSetup ? 'muted' : 'warn') as 'warn' | 'muted',
      needsSetup,
      optional,
    };
  };

  const input = firstPending(capabilities.pointer, capabilities.keyboard);
  if (pending(input)) {
    const row = {
      id: 'input',
      icon: 'pointer' as const,
      title: t('Mouse and keyboard'),
      description: t(
        'The agent uses the mouse and keyboard for you. Enter the administrator password once and it will not ask again.'
      ),
      ...base(input),
    };
    rows.push(
      input.fix === 'allow_input'
        ? { ...row, status: t('Allow needed'), action: { kind: 'allow_input', label: t('Allow') } }
        : row
    );
  }

  const windows = capabilities.windows;
  if (windows.state === 'unsupported') {
    rows.push({
      id: 'windows',
      icon: 'window',
      title: t('Window reading and switching'),
      description: t('Not supported on {{desktop}} yet. Screen viewing and mouse/keyboard still work.', {
        desktop: desktopName(linux.desktop),
      }),
      ...base(windows),
    });
  } else if (windows.state === 'needs_setup' && windows.fix === 'relogin') {
    rows.push({
      id: 'windows',
      icon: 'window',
      title: t('Window helper'),
      description: t(
        'Sign out and back in to turn it on. Until then only screen viewing and mouse/keyboard are used.'
      ),
      ...base(windows),
      status: t('Sign-in needed again'),
    });
  } else if (windows.state === 'needs_setup') {
    rows.push({
      id: 'windows',
      icon: 'window',
      title: t('Window helper'),
      description: t("Finds, reads and switches other apps' windows."),
      ...base(windows),
      ...(windows.fix === 'enable_window_helper' ? { action: { kind: 'retry', label: t('Try again') } } : {}),
    });
  }

  const sight = capabilities.capture;
  if (pending(sight)) {
    rows.push({
      id: 'capture',
      icon: 'monitor',
      title: t('Screen viewing'),
      description: t('Looks at the screen to see what is on it.'),
      ...base(sight),
    });
  }
  const elements = firstPending(capabilities.accessibility, capabilities.semanticActions);
  if (pending(elements)) {
    rows.push({
      id: 'accessibility',
      icon: 'accessibility',
      title: t('On-screen elements'),
      description: t('Reads buttons and fields in apps so they can be used directly.'),
      ...base(elements),
    });
  }
  for (const [id, capability, icon, title, description] of [
    [
      'clipboard',
      capabilities.clipboard,
      'clipboard',
      t('Copy and paste'),
      t('Types long text quickly by pasting it. Most tasks work without it.'),
    ],
    [
      'ocr',
      capabilities.ocr,
      'text',
      t('Text recognition'),
      t('Reads text on the screen. Most tasks work without it.'),
    ],
  ] as const) {
    if (!pending(capability)) continue;
    const row = { id, icon, title, description, ...base(capability) };
    rows.push(
      capability.fix === 'install_package' && capability.package
        ? { ...row, action: { kind: 'install_how', label: t('How to install'), package: capability.package } }
        : row
    );
  }
  return rows;
}

function macRows(readiness: DesktopComputerReadiness): ComputerReadinessRow[] {
  const rows: ComputerReadinessRow[] = [];
  const grant = (
    id: string,
    icon: ComputerReadinessIcon,
    title: string,
    description: string,
    pane: DesktopComputerPermissionPane
  ) =>
    rows.push({
      id,
      icon,
      title,
      description,
      status: t('Allow needed'),
      tone: 'warn',
      needsSetup: true,
      optional: false,
      action: { kind: 'open_settings', label: t('Open settings'), pane },
    });
  if (MACOS_GRANT_REQUIRED.has(readiness.screen_capture)) {
    grant(
      'screen',
      'monitor',
      t('Screen Recording'),
      t(
        'Turn on Mixdog in System Settings → Privacy & Security → Screen Recording. You may need to restart Mixdog afterwards.'
      ),
      'screen'
    );
  }
  if (MACOS_GRANT_REQUIRED.has(readiness.accessibility)) {
    grant(
      'accessibility',
      'accessibility',
      t('Accessibility'),
      t('Turn on Mixdog in System Settings → Privacy & Security → Accessibility.'),
      'accessibility'
    );
  }
  return rows;
}

/** The rows the "Readiness" section lists; empty when nothing is pending.
 *  Optional add-ons appear only next to a required row, never on their own. */
export function computerReadinessRows(readiness: DesktopComputerReadiness | null): ComputerReadinessRow[] {
  if (!readiness) return [];
  if (readiness.platform === 'linux' && readiness.linux) {
    const rows = linuxRows(readiness.linux);
    return rows.some((row) => !row.optional) ? rows : [];
  }
  if (readiness.platform === 'darwin') return macRows(readiness);
  return [];
}

/** Something the user (or the app) can still fix: keeps the list polling. */
export function computerReadinessPending(rows: readonly ComputerReadinessRow[]): boolean {
  return rows.some((row) => row.needsSetup);
}

/** The rail's "Setup needed" tag: only what blocks work, never an optional tool. */
export function computerReadinessBlocking(rows: readonly ComputerReadinessRow[]): boolean {
  return rows.some((row) => row.needsSetup && !row.optional);
}

/** Info facts' engine and platform for the session this Linux desktop runs. */
export function linuxPlatformFacts(linux: DesktopLinuxComputerReadiness): Array<readonly [string, string]> {
  const session = linux.session === 'wayland' ? 'Wayland' : 'X11';
  const desktop = linux.desktop === 'other' ? '' : `${desktopName(linux.desktop)}, `;
  return [
    ['Engine', `AT-SPI · ${session}`],
    ['Platform', `Linux · ${desktop}${session}`],
  ];
}
