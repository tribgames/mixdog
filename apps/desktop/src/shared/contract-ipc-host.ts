// IPC channels that exist only for the host half of the desktop bridge and for the core port
// hand-off. Kept apart from DESKTOP_IPC, which lists the channels of DesktopApi members.

export const HOST_EXTRA_IPC = {
  enableAllowAllActions: 'mixdog:host:enable-allow-all-actions',
  observeSignIn: 'mixdog:host:observe-sign-in',
  pcQuotaInvoke: 'mixdog:host:pc-quota-invoke',
  pcQuotaRead: 'mixdog:host:pc-quota-read',
  corePortOpen: 'mixdog:core-port:open',
  corePort: 'mixdog:core-port',
} as const;
