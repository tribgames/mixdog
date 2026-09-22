// Desktop-only OS integrations, as a browser can answer them: inert where
// Electron owns the capability outright, and a browser equivalent where one
// exists. Every remaining DesktopApi member forwards over the relay socket and
// therefore stays with the shim's connection.
import type { DesktopApi, DesktopUpdaterState } from '../shared/contract';
import { normalizeRemoteExternalUrl } from './remote-pairing-recovery';

const DISABLED_UPDATER: DesktopUpdaterState = { status: 'disabled' };
// Recoverable trash is an Electron API the daemon behind the relay cannot
// reach. Reporting that keeps a remote action honest instead of doing nothing.
const DESKTOP_ONLY_TRASH = 'Moving items to the trash is available in the desktop app only.';

export type RemoteBrowserFallbacks = Pick<
  DesktopApi,
  | 'chooseProject'
  | 'chooseFile'
  | 'chooseFiles'
  | 'openProjectInExplorer'
  | 'openExternal'
  | 'trashProjectEntry'
  | 'chooseWorkspace'
  | 'folderPathForFile'
  | 'rendererReady'
  | 'revealFile'
  | 'openFilePath'
  | 'openAttachmentImage'
  | 'getUpdaterState'
  | 'subscribeUpdaterState'
  | 'checkForDesktopUpdate'
  | 'showDesktopUpdate'
  | 'getZoomFactor'
  | 'setZoomFactor'
  | 'onZoomFactorChanged'
  | 'applyTitleBarTheme'
  | 'setTitleBarDim'
  | 'quit'
>;

export const REMOTE_BROWSER_FALLBACKS: RemoteBrowserFallbacks = {
  chooseProject: () => Promise.resolve(null),
  chooseFile: () => Promise.resolve(null),
  chooseFiles: () => Promise.resolve(null),
  openProjectInExplorer: () => Promise.resolve(),
  openExternal: (url) => {
    const target = normalizeRemoteExternalUrl(url);
    if (!target) return Promise.reject(new TypeError('url protocol is unsupported.'));
    try {
      window.open(target, '_blank', 'noopener');
    } catch {
      /* popup blocked */
    }
    return Promise.resolve();
  },
  trashProjectEntry: () => Promise.reject(new Error(DESKTOP_ONLY_TRASH)),
  chooseWorkspace: () => Promise.resolve(null),
  // Only Electron's webUtils can name an OS-dropped file. A browser drop
  // carries the File itself, which the composer reads without a path.
  folderPathForFile: () => '',
  // No perfLog: the Composer's keystroke paint sampler keys on its presence,
  // and a phone should not pay a double-rAF per keystroke to feed a no-op.
  rendererReady: () => {},
  revealFile: () => Promise.resolve(),
  openFilePath: () => Promise.resolve(),
  // A browser tab owns no OS handler, so a blob tab is the closest
  // equivalent. The data URL cannot be opened directly: Chrome blocks a
  // top-level navigation to `data:`.
  openAttachmentImage: (dataUrl) => {
    try {
      const value = String(dataUrl);
      const separator = value.indexOf(',');
      const type = /^data:([^;,]+)/.exec(value.slice(0, separator))?.[1] || 'image/png';
      const binary = atob(value.slice(separator + 1));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      /* popup blocked or a malformed preview */
    }
    return Promise.resolve();
  },
  getUpdaterState: () => Promise.resolve(DISABLED_UPDATER),
  subscribeUpdaterState: () => () => {},
  checkForDesktopUpdate: () => Promise.resolve(DISABLED_UPDATER),
  showDesktopUpdate: () => Promise.resolve(DISABLED_UPDATER),
  getZoomFactor: () => Promise.resolve(1),
  setZoomFactor: () => {
    document.documentElement.style.removeProperty('zoom');
    try {
      window.localStorage.removeItem('mixdog.web-zoom');
    } catch {
      /* private storage */
    }
    return Promise.resolve(1);
  },
  onZoomFactorChanged: () => () => {},
  applyTitleBarTheme: () => Promise.resolve(),
  setTitleBarDim: () => Promise.resolve(),
  quit: () => Promise.resolve(),
};
