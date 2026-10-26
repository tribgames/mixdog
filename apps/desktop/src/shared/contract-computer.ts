// Computer Use readiness: what the OS still needs before every capability runs.

export type DesktopComputerCapabilityState = 'ready' | 'needs_setup' | 'unsupported' | 'unknown';

export interface DesktopComputerCapability {
  state: DesktopComputerCapabilityState;
  fix?: 'allow_input' | 'relogin' | 'enable_window_helper' | 'install_package';
  package?: string;
  optional?: boolean;
}

export type DesktopComputerCapabilityName =
  | 'capture'
  | 'windows'
  | 'accessibility'
  | 'semanticActions'
  | 'pointer'
  | 'keyboard'
  | 'clipboard'
  | 'ocr';

export interface DesktopLinuxComputerReadiness {
  session: 'wayland' | 'x11';
  desktop: 'gnome' | 'kde' | 'sway' | 'hyprland' | 'other';
  capabilities: Record<DesktopComputerCapabilityName, DesktopComputerCapability>;
}

/** The OS grants Computer Use runs under, as the main process reads them.
 *  `linux` is present on Linux only; macOS reports TCC statuses
 *  ('granted' | 'denied' | 'not-determined' | 'restricted'). */
export interface DesktopComputerReadiness {
  platform: string;
  screen_capture: string;
  accessibility: string;
  input: string;
  linux?: DesktopLinuxComputerReadiness;
  /** Windows only: the secure-desktop helper ("PC access"), relative to the
   *  controller keys the paired phones delivered. */
  pcAccess?: DesktopPcAccessReadiness;
}

/** "PC access" (the secure-desktop helper) as the readiness row reads it:
 *  - `not-installed`: no helper (or an outdated one): Approve installs it
 *    enrolling every delivered phone key, under one UAC prompt;
 *  - `needs-enroll`: installed, and a paired phone's delegated enroll was
 *    refused in a way only elevation fixes: Approve new phone enrolls it;
 *  - `revocations-unknown`: installed, but the record of revocations owed
 *    was damaged or lost; nothing is enrolled until Approve reinstalls with
 *    the current pairings' keys;
 *  - `ready`: installed, nothing for the person at the PC to approve;
 *  - `other-user`: another Windows account owns it (informational);
 *  - `unavailable`: not offered on this PC (no row). */
export interface DesktopPcAccessReadiness {
  state: 'not-installed' | 'needs-enroll' | 'revocations-unknown' | 'ready' | 'other-user' | 'unavailable';
}

/** How an Approve on the PC access row ended. `detail` is an English
 *  diagnostic for logs, never shown as copy. */
export interface DesktopPcAccessApproval {
  outcome: 'done' | 'nothing-to-do' | 'declined' | 'failed' | 'in-progress' | 'other-user' | 'unavailable';
  detail?: string;
}

/** Linux, non-.deb installs: one polkit prompt installs the /dev/uinput access rule. */
export type DesktopComputerInputAccess =
  | { ok: true }
  // `access_unavailable` = repair ran but /dev/uinput is still not writable; `detail` and `exitCode` let the UI pick a translated line.
  // `message` is English, for logs/diagnostics only.
  | {
      ok: false;
      reason: 'cancelled' | 'pkexec_missing' | 'failed' | 'access_unavailable';
      detail?: 'relogin' | 'no-module';
      exitCode?: number;
      message?: string;
    };

export type DesktopComputerPermissionPane = 'screen' | 'accessibility';
