// IPC channels that exist only for the core port hand-off. Kept apart from DESKTOP_IPC, which lists the channels of
// DesktopApi members; the host extras (enableAllowAllActions, observeSignIn, PC quota) use their DESKTOP_IPC
// channels, which main/ipc-host-extras.ts registers.

export const HOST_EXTRA_IPC = {
  corePortOpen: 'mixdog:core-port:open',
  corePort: 'mixdog:core-port',
} as const;
