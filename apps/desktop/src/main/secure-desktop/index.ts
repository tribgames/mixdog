/**
 * Main-process entry point for the Mixdog secure-desktop bridge. The upcoming
 * WebRTC remote-desktop effort imports from here to obtain frames of, and send
 * input to, the current input desktop — including the secure desktop (UAC
 * consent, lock / sign-in screen) — through the LocalSystem helper.
 *
 * Everything is a no-op when the service is not installed, and nothing installs
 * automatically (not on app install, update or start): the remote-screen
 * wiring calls `SecureDesktopInstaller.request()` (one UAC prompt) only when
 * the paired phone asks for the helper. The app uninstaller removes it.
 */

export {
  ELEVATION_DECLINED_EXIT,
  SECURE_DESKTOP_BUSY_EXIT,
  SECURE_DESKTOP_OTHER_USER_EXIT,
  SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT,
  SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT,
  SecureDesktopClient,
  createSecureDesktopClient,
  elevateSecureDesktop,
  installStateFromCheckExit,
  secureDesktopInstallState,
  secureDesktopStatus,
  startSecureDesktopService,
  verifySecureDesktopImage,
  type SecureDesktopClientOptions,
  type SecureDesktopImageCheck,
  type SecureDesktopInstallState,
  type SecureDesktopEvents,
  type SecureDesktopGrant,
  type SecureDesktopGrantChallenge,
  type SecureDesktopSession,
  type SecureDesktopStatus,
  type SecureDesktopTransport,
  type ServerHello,
} from './client';
export {
  createSecureDesktopInstaller,
  installOfferFor,
  secureDesktopInstallerFor,
  type SecureDesktopInstallOffer,
  type SecureDesktopInstallOutcome,
  type SecureDesktopInstallResult,
  type SecureDesktopInstaller,
  type SecureDesktopInstallerOptions,
  type SecureDesktopInstallerPort,
} from './install-request';
export {
  SERVICE_PIPE_NAME,
  secureDesktopExePath,
  stateFilePath,
  type SecureDesktopEnvironment,
} from './paths';
export type {
  ControlMessage,
  DesktopName,
  DirtyRect,
  FrameHeader,
  InputEvent,
  PointerButton,
} from './protocol';
