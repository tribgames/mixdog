/**
 * Main-process entry point for the Mixdog secure-desktop bridge. The upcoming
 * WebRTC remote-desktop effort imports from here to obtain frames of, and send
 * input to, the current input desktop — including the secure desktop (UAC
 * consent, lock / sign-in screen) — through the LocalSystem helper.
 *
 * Everything is a no-op when the service is not installed, and nothing installs
 * automatically: the UI layer calls `installSecureDesktop` (one UAC prompt)
 * only on explicit user opt-in.
 */

export {
  SecureDesktopClient,
  createSecureDesktopClient,
  installSecureDesktop,
  secureDesktopStatus,
  uninstallSecureDesktop,
  type SecureDesktopClientOptions,
  type SecureDesktopEvents,
  type SecureDesktopSession,
  type SecureDesktopStatus,
  type SecureDesktopTransport,
  type ServerHello,
} from './client';
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
