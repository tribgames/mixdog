// Desktop-only OS integrations, as a browser can answer them: inert where
// Electron owns the capability outright, and a browser equivalent where one
// exists. Every remaining DesktopApi member forwards over the relay socket and
// therefore stays with the shim's connection.
import type { DesktopApi, DesktopUpdaterState } from '../shared/contract';
import { saveUrlOnDevice } from './file-download-transfer';
import { openImageLightbox } from './image-lightbox-host';
import { normalizeRemoteExternalUrl } from './remote-pairing-recovery';

/** The last path segment of a URL, the name a saved link gets. */
function linkFileName(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1) || '';
    return decodeURIComponent(segment) || 'download';
  } catch {
    return 'download';
  }
}

const DISABLED_UPDATER: DesktopUpdaterState = { status: 'disabled' };
// Recoverable trash is an Electron API a host without remoteParity cannot
// reach. Reporting that keeps a remote action honest instead of doing nothing.
const DESKTOP_ONLY_TRASH = 'Moving items to the trash is available in the desktop app only.';

/** What a host that does not advertise `remoteParity` gets for the methods it
 *  lacks (it answers `unknown method`). The shim picks these per call. */
export const LEGACY_HOST_FALLBACKS = {
  getUpdaterState: (): Promise<DesktopUpdaterState> => Promise.resolve(DISABLED_UPDATER),
  checkForDesktopUpdate: (): Promise<DesktopUpdaterState> => Promise.resolve(DISABLED_UPDATER),
  showDesktopUpdate: (): Promise<DesktopUpdaterState> => Promise.resolve(DISABLED_UPDATER),
  trashProjectEntry: (): Promise<void> => Promise.reject(new Error(DESKTOP_ONLY_TRASH)),
  browserReleasePage: (): Promise<void> => Promise.resolve(),
};

type RemoteBrowserFallbacks = Pick<
  DesktopApi,
  | 'chooseProject'
  | 'chooseFile'
  | 'chooseFiles'
  | 'openProjectInExplorer'
  | 'openExternal'
  | 'chooseWorkspace'
  | 'folderPathForFile'
  | 'rendererReady'
  | 'openAttachmentImage'
  | 'saveFileAs'
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
  chooseWorkspace: () => Promise.resolve(null),
  // Only Electron's webUtils can name an OS-dropped file. A browser drop
  // carries the File itself, which the composer reads without a path.
  folderPathForFile: () => '',
  // No perfLog: the Composer's keystroke paint sampler keys on its presence,
  // and a phone should not pay a double-rAF per keystroke to feed a no-op.
  rendererReady: () => {},
  // No `revealFile` / `openFilePath`: a device has no file manager or default
  // app of the PC's. Their absence is what hides "Show in Explorer" and sends
  // "Open with default program" to the download path (openEditorFileExternally).
  // A browser owns no OS image handler and a popup tab is blocked on phones:
  // the app's own lightbox shows the picture in place.
  openAttachmentImage: (dataUrl, name) => {
    return openImageLightbox({ src: String(dataUrl), name: name || 'image' });
  },
  // No dialog of ours to show, and the host's would appear on another
  // machine: the bytes are fetched and saved on this device (native save,
  // share sheet or download link).
  saveFileAs: async (source, suggestedName) => {
    if (!/^(?:data|https?):/i.test(source)) throw new TypeError('url protocol is unsupported.');
    // Fetched, then saved through this device's sink; the answer is the real
    // outcome (a dismissed share sheet is not a save). A cross-origin URL
    // that refuses CORS fails here instead of navigating the app away.
    const result = await saveUrlOnDevice(source, suggestedName || linkFileName(source));
    return result !== 'dismissed';
  },
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
