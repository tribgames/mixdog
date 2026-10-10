// Effect hooks that wire one browser pane to its guest page. They hold no JSX;
// BrowserPane.lazy.tsx keeps the chrome markup and composes these.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DesktopBrowserCredentialSuggestion, DesktopBrowserHistoryEntry } from '../shared/contract';
import { scheduleBrowserForegroundRepaint, watchBrowserForegroundReturns } from './browser-foreground-lifecycle';
import type { BrowserPageElement } from './browser-page-client';
import { bindRequestedAddress } from './browser-page-request';
import {
  browserViewportEmulation,
  readBrowserViewportPreset,
  resolveBrowserViewportPreset,
  type BrowserViewportPreset,
} from './browser-viewport-mode';

type DesktopApi = typeof window.mixdogDesktop;
type GuestRef = RefObject<BrowserPageElement | null>;
type AgentViewport = { width: number; height: number };

/** Device metrics the agent's `emulate` command put on this session's guest.
 *  The pane frames the page at that size, centered, exactly like a picker
 *  preset. The pane's own configure echoes back through the same event and
 *  reads as "no override". */
export function useAgentViewport(sessionId: string, webviewRef: GuestRef) {
  const [agentViewport, setAgentViewport] = useState<AgentViewport | null>(null);
  const agentViewports = useRef(new Map<number, AgentViewport | null>());
  useEffect(
    () =>
      window.mixdogDesktop?.onBrowserGuestViewportChanged?.((change) => {
        if (change.sessionId !== sessionId) return;
        const view = webviewRef.current;
        if (!view) return;
        let currentId: number;
        try {
          currentId = view.getWebContentsId();
        } catch {
          return;
        }
        const pageId = change.webContentsId ?? currentId;
        const preset = resolveBrowserViewportPreset(readBrowserViewportPreset(window.localStorage, sessionId).id);
        const ownPreset =
          change.viewport !== null &&
          change.viewport.width === preset.width &&
          change.viewport.height === preset.height;
        const viewport = ownPreset ? null : change.viewport;
        agentViewports.current.set(pageId, viewport);
        if (pageId === currentId) setAgentViewport(viewport);
      }),
    [sessionId, webviewRef]
  );
  return { agentViewport, agentViewports, setAgentViewport };
}

/** The nav row's measured width, which decides which optional buttons fit. */
export function useToolbarWidth() {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarWidth, setToolbarWidth] = useState(0);
  useEffect(() => {
    const node = toolbarRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setToolbarWidth(Math.round(node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { toolbarRef, toolbarWidth };
}

/** A device frame taller or wider than the pane scales down to fit, staying
 *  centered on both axes. The guest keeps its real metrics; only the
 *  composited frame shrinks. */
export function useFrameFit(frameWidth: number | null, frameHeight: number | null) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [frameScale, setFrameScale] = useState(1);
  // Layout effect: the fitted scale lands in the same paint as the new frame
  // size, so a preset switch never shows one oversized frame first.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || frameWidth === null || frameHeight === null) {
      setFrameScale(1);
      return undefined;
    }
    const fit = () => {
      const styles = window.getComputedStyle(content);
      const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const roomWidth = content.clientWidth - padX;
      const roomHeight = content.clientHeight - padY;
      if (roomWidth <= 0 || roomHeight <= 0) return;
      const scale = Math.min(1, roomWidth / frameWidth, roomHeight / frameHeight);
      setFrameScale((current) => (Math.abs(current - scale) < 0.001 ? current : scale));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    return () => observer.disconnect();
  }, [frameWidth, frameHeight]);
  return { contentRef, frameScale };
}

/** Reports this pane's guest as the session's active one, re-reporting on
 *  attach, dom-ready and foreground returns; clears the report on teardown. */
export function useActiveGuestReport({
  webviewRef,
  desktopApi,
  sessionId,
  active,
}: {
  webviewRef: GuestRef;
  desktopApi: DesktopApi;
  sessionId: string;
  active: boolean;
}) {
  useEffect(() => {
    const view = webviewRef.current;
    const setGuestActive = desktopApi?.browserSetActiveGuest;
    if (!view || !setGuestActive) return undefined;
    let reportedId = 0;
    const report = () => {
      try {
        const webContentsId = view.getWebContentsId();
        if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return;
        reportedId = webContentsId;
        void setGuestActive(sessionId, webContentsId, active).catch(() => {});
      } catch {
        /* guest not attached yet; did-attach/dom-ready retries */
      }
    };
    report();
    const stopForegroundReturnReporting = active ? watchBrowserForegroundReturns(window, document, report) : () => {};
    const stopSettledForegroundRepaint = active ? scheduleBrowserForegroundRepaint(window, report) : () => {};
    view.addEventListener('did-attach', report);
    view.addEventListener('dom-ready', report);
    return () => {
      stopForegroundReturnReporting();
      stopSettledForegroundRepaint();
      view.removeEventListener('did-attach', report);
      view.removeEventListener('dom-ready', report);
      if (reportedId) void setGuestActive(sessionId, reportedId, false).catch(() => {});
    };
  }, [active, desktopApi, sessionId, webviewRef]);
}

/** Stored-credential suggestions for the page, the fill action, and the
 *  transient success/error status the menu shows. */
export function useBrowserCredentials(desktopApi: DesktopApi, sessionId: string) {
  const [credentialSuggestions, setCredentialSuggestions] = useState<DesktopBrowserCredentialSuggestion[]>([]);
  const [credentialMenuOpen, setCredentialMenuOpen] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialStatus, setCredentialStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const refreshCredentialSuggestions = useCallback(() => {
    if (!desktopApi?.browserCredentialSuggestions) {
      setCredentialSuggestions([]);
      return;
    }
    void desktopApi
      .browserCredentialSuggestions(sessionId)
      .then((suggestions) => {
        setCredentialSuggestions(suggestions);
        if (!suggestions.length) setCredentialMenuOpen(false);
      })
      .catch(() => {
        setCredentialSuggestions([]);
        setCredentialMenuOpen(false);
      });
  }, [desktopApi, sessionId]);
  useEffect(() => {
    if (credentialStatus === 'idle') return undefined;
    const timer = window.setTimeout(() => setCredentialStatus('idle'), 2500);
    return () => window.clearTimeout(timer);
  }, [credentialStatus]);
  const fillStoredCredential = useCallback(
    (credentialId: string) => {
      if (!desktopApi?.browserCredentialFill || credentialBusy) return;
      setCredentialBusy(true);
      setCredentialMenuOpen(false);
      setCredentialStatus('idle');
      void desktopApi
        .browserCredentialFill(sessionId, credentialId)
        .then((result) => {
          setCredentialStatus(result.passwordFilled ? 'success' : 'error');
        })
        .catch(() => setCredentialStatus('error'))
        .finally(() => setCredentialBusy(false));
    },
    [credentialBusy, desktopApi, sessionId]
  );
  return {
    credentialBusy,
    credentialMenuOpen,
    credentialStatus,
    credentialSuggestions,
    fillStoredCredential,
    refreshCredentialSuggestions,
    setCredentialMenuOpen,
    setCredentialStatus,
  };
}

/** Debounced history lookup for the address being typed. */
export function useHistorySuggestions(desktopApi: DesktopApi, address: string, addressHasFocus: boolean) {
  const [historySuggestions, setHistorySuggestions] = useState<DesktopBrowserHistoryEntry[]>([]);
  useEffect(() => {
    if (!addressHasFocus || !address.trim() || !desktopApi?.browserHistorySearch) {
      setHistorySuggestions([]);
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void desktopApi
        .browserHistorySearch?.(address)
        .then((entries) => {
          if (live) setHistorySuggestions(entries);
        })
        .catch(() => {
          if (live) setHistorySuggestions([]);
        });
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [address, addressHasFocus, desktopApi]);
  return { historySuggestions, setHistorySuggestions };
}

/** Applies a viewport preset's device metrics to the current guest. Metrics
 *  and touch apply live; only a user-agent change needs the page to load
 *  again, because reloading on every size step blanked the page for a beat. */
export function useViewportPresetConfigurator(webviewRef: GuestRef, desktopApi: DesktopApi, sessionId: string) {
  const appliedViewportPreset = useRef(new Map<number, string>());
  const viewportConfigurationRequest = useRef(0);
  return useCallback(
    async (preset: BrowserViewportPreset, reload: boolean): Promise<boolean> => {
      const view = webviewRef.current;
      if (!view) return false;
      const configKey = `${sessionId}\u0000${preset.id}`;
      let webContentsId = 0;
      try {
        webContentsId = view.getWebContentsId();
      } catch {
        return false;
      }
      if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return false;
      const previousPreset = appliedViewportPreset.current.get(webContentsId);
      if (previousPreset === configKey) return true;
      const previousUserAgent = previousPreset
        ? resolveBrowserViewportPreset(previousPreset.split('\u0000')[1]).userAgent
        : null;
      const userAgentChanged = previousUserAgent !== (preset.userAgent ?? null);
      const configure = desktopApi?.browserConfigureGuestViewport;
      if (!configure) {
        appliedViewportPreset.current.set(webContentsId, configKey);
        return true;
      }
      const request = ++viewportConfigurationRequest.current;
      try {
        await configure(sessionId, webContentsId, browserViewportEmulation(preset));
      } catch (error) {
        console.error('Browser viewport emulation failed.', error);
        return false;
      }
      if (request !== viewportConfigurationRequest.current) return false;
      appliedViewportPreset.current.set(webContentsId, configKey);
      if (reload && userAgentChanged) {
        try {
          if (view.getURL() && view.getURL() !== 'about:blank') view.reload();
        } catch {
          /* detached guest; its next attach applies the preset */
        }
      }
      return true;
    },
    [desktopApi, sessionId, webviewRef]
  );
}

/** A page card in the transcript hands its address to this session's pane.
 *  The card usually opens the pane in the same press, so the address tends to
 *  arrive before the guest exists. The latest address stays pending until
 *  whichever guest element the pane has now is ready and starts loading it;
 *  every render re-checks the current element, so a replaced guest is covered. */
export function useRequestedAddress(webviewRef: GuestRef, sessionId: string, navigate: (url: string) => boolean) {
  const binding = useRef<ReturnType<typeof bindRequestedAddress> | null>(null);
  useEffect(() => {
    const bound = bindRequestedAddress(sessionId, () => webviewRef.current, navigate);
    binding.current = bound;
    return () => {
      bound.dispose();
      binding.current = null;
    };
  }, [sessionId, navigate, webviewRef]);
  // No dependency list: the guest element is replaced without a prop change.
  useEffect(() => {
    binding.current?.sync();
  });
}

/** A main tab's page opens at its last address when the guest has none: a
 *  brand-new tab, or a restart that lost the live page. A guest that already
 *  shows a page (remount) keeps it. */
export function useInitialAddress(
  webviewRef: GuestRef,
  mainTab: boolean,
  initialUrl: string | undefined,
  navigate: (url: string) => void
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the address is read once, at mount; later changes are the page's own.
  useEffect(() => {
    const view = webviewRef.current;
    if (!mainTab || !initialUrl || !view) return undefined;
    const openInitial = () => {
      view.removeEventListener('dom-ready', openInitial);
      const shown = view.getURL();
      if (!shown || shown === 'about:blank') navigate(initialUrl);
    };
    view.addEventListener('dom-ready', openInitial);
    try {
      if (Number(view.getWebContentsId()) > 0) openInitial();
    } catch {
      /* guest still attaching; its first dom-ready opens the address */
    }
    return () => view.removeEventListener('dom-ready', openInitial);
  }, []);
}

/** False until the surface has its first document (or a load failure): the
 *  loading placeholder covers the page, which keeps the native view hidden. */
export function useGuestPainted(webviewRef: GuestRef) {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const view = webviewRef.current;
    if (!view) return undefined;
    const markPainted = () => setPainted(true);
    // A committed navigation already replaces the previous document; the page
    // then paints progressively like any browser, so waiting for dom-ready
    // held a finished-looking placeholder over a page that was already drawing.
    const events = ['did-navigate', 'dom-ready', 'did-stop-loading', 'did-finish-load', 'did-fail-load'];
    for (const name of events) view.addEventListener(name, markPainted);
    // A remounted surface reattaches a guest that already shows its page and
    // fires none of the events above again: reveal it at once.
    try {
      const shown = view.getURL();
      if (shown && shown !== 'about:blank') markPainted();
    } catch {
      /* guest still attaching; its first navigation reveals it */
    }
    // Never let the placeholder outlast a slow first byte: after a beat the
    // page's own loading state is the better feedback.
    const fallback = window.setTimeout(markPainted, 1000);
    return () => {
      window.clearTimeout(fallback);
      for (const name of events) view.removeEventListener(name, markPainted);
    };
  }, [webviewRef]);
  return painted;
}
