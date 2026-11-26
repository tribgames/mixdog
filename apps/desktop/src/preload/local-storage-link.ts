// Chromium replaces the profile's Local Storage database once its commits keep failing; the page's connection to the
// backend is then gone for the life of the renderer process (writes are never acknowledged or saved). Only a new
// renderer process connects again, so a page that loses the link hands main everything it holds (main/local-storage-rescue.ts).
import type { IpcRenderer } from 'electron';

import { DESKTOP_IPC } from '../shared/contract-ipc';

/** The probe written to Local Storage: its `storage` event is raised by the backend's acknowledgement alone. */
const LINK_KEY = 'mixdog.local-storage-link';
/** The probe written to session storage at the same moment: its `storage` event needs no backend, so hearing it shows
 *  that the frame hears at all and that the page's tasks ran. */
const PAGE_KEY = 'mixdog.local-storage-link.page';
/** How often the link is probed: a lost link is noticed within two periods. */
const PROBE_PERIOD_MS = 30_000;

export interface LinkWatchDeps {
  /** Writes both probes, or neither. */
  probe(): void;
  /** The link is lost. Called once, and the watch ends. */
  lost(): void;
  /** The watch ended (lost or gave up on a replacement); stop probing. */
  onEnd?(): void;
  /** This page already is the replacement of a lost one. */
  replacement: boolean;
}

export interface LinkWatch {
  /** A probe's `storage` event arrived: the `page`'s own, or the `backend`'s acknowledgement. */
  heard(from: 'page' | 'backend'): void;
  /** Once at the start and once per period: judges the period that ended and probes again. */
  tick(): void;
}

/** A period counts against the link only when the page's own probe was heard and no acknowledgement was: a busy page,
 *  or one whose frame hears nothing, proves nothing. Two such periods in a row are a loss. A replacement whose link
 *  never answered at all is left as it is: another process would not connect either. */
export function createLinkWatch(deps: LinkWatchDeps): LinkWatch {
  const since = { page: false, backend: false };
  let probed = false;
  let up = false;
  let silent = 0;
  let over = false;
  return {
    heard(from) {
      if (over) return;
      since[from] = true;
      if (from === 'backend') up = true;
    },
    tick() {
      if (over) return;
      if (probed) {
        if (since.backend) silent = 0;
        else if (since.page && ++silent === 2) {
          over = true;
          deps.onEnd?.();
          if (up || !deps.replacement) deps.lost();
          return;
        }
      }
      since.page = since.backend = false;
      probed = true;
      deps.probe();
    },
  };
}

/** `none`: main holds no rescue for this window. Otherwise this page is a replacement whose storage now is the `whole`
 *  rescue, or one whose storage `refused` it. */
export type Restored = 'none' | 'whole' | 'refused';

/** Makes the storage the rescue main holds for this window, and tells main once it is. The lost page held the newest
 *  value of every key, so the rescue replaces the area: emptied first, the area never holds more than the rescue, which
 *  fit. Main keeps the rescue until then, so a page whose storage refused it leaves it for the next page load. */
export function restoreRescuedLocalStorage(
  ipcRenderer: Pick<IpcRenderer, 'send' | 'sendSync'>,
  storage: Pick<Storage, 'setItem' | 'clear'>
): Restored {
  const rescued = ipcRenderer.sendSync(DESKTOP_IPC.takeLocalStorageRescue) as [string, string][] | null;
  if (!rescued) return 'none';
  try {
    storage.clear();
    for (const [key, value] of rescued) storage.setItem(key, value);
  } catch {
    return 'refused';
  }
  ipcRenderer.send(DESKTOP_IPC.localStorageRestored);
  return 'whole';
}

export function watchLink(
  ipcRenderer: Pick<IpcRenderer, 'sendSync'>,
  storage: Storage,
  replacement: boolean
): () => void {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  document.documentElement.append(frame);
  const inner = frame.contentWindow;
  if (!inner) {
    frame.remove();
    return () => {};
  }
  // A frame's storage areas exist, and hear the page's writes, only once they were read.
  void inner.localStorage.length;
  void inner.sessionStorage.length;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const onStorage = (event: StorageEvent): void => {
    if (event.key === LINK_KEY) watch.heard('backend');
    else if (event.key === PAGE_KEY) watch.heard('page');
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    inner.removeEventListener('storage', onStorage);
    window.removeEventListener('pagehide', stop);
    window.removeEventListener('unload', stop);
    frame.remove();
  };
  const watch = createLinkWatch({
    replacement,
    probe: () => {
      const value = String(Date.now());
      try {
        storage.setItem(LINK_KEY, value);
      } catch {
        // A full area takes no probe, so there is nothing to acknowledge: the page's own probe is not written either.
        return;
      }
      window.sessionStorage.setItem(PAGE_KEY, value);
    },
    onEnd: stop,
    // The page stops here: main ends this process instead of answering, so nothing is written after what it was given.
    lost: () =>
      void ipcRenderer.sendSync(
        DESKTOP_IPC.localStorageLost,
        Object.keys(storage)
          .filter((key) => key !== LINK_KEY)
          .map((key) => [key, storage.getItem(key) ?? ''])
      ),
  });
  inner.addEventListener('storage', onStorage);
  window.addEventListener('pagehide', stop, { once: true });
  window.addEventListener('unload', stop, { once: true });
  watch.tick();
  if (!stopped) timer = setInterval(watch.tick, PROBE_PERIOD_MS);
  return stop;
}

/** Restores a rescue now, before the page's scripts run, and watches the link from the first document on. */
export function installLocalStorageLink(ipcRenderer: Pick<IpcRenderer, 'send' | 'sendSync'>): void {
  let storage: Storage;
  try {
    storage = window.localStorage;
    void window.sessionStorage;
  } catch {
    // A page without storage has no link to lose.
    return;
  }
  const restored = restoreRescuedLocalStorage(ipcRenderer, storage);
  // A storage that refused the rescue is not the whole of what the window held: it is not watched, so main's rescue is
  // never replaced by less.
  if (restored === 'refused') return;
  let stopWatch: (() => void) | null = null;
  const start = (): void => {
    stopWatch = watchLink(ipcRenderer, storage, restored === 'whole');
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    window.addEventListener(
      'unload',
      () => {
        document.removeEventListener('DOMContentLoaded', start);
        stopWatch?.();
      },
      { once: true }
    );
  } else {
    start();
  }
}
