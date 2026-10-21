// The browser pane's place in the workspace (BrowserPane.lazy.tsx): following
// the agent's tab, Escape out of the expanded view, and the main tab's page
// report for persistence.
import { type RefObject, useEffect, useMemo, useState } from 'react';
import { createBrowserAgentFollow } from './browser-agent-follow';
import type { BrowserPageElement } from './browser-page-client';
import { onBrowserPaneRevealed } from './browser-page-request';

/** The shown tab follows the page the agent drives (see browser-agent-follow). */
export function useBrowserAgentFollow(sessionId: string, webviewRef: RefObject<BrowserPageElement | null>) {
  const agentFollow = useMemo(
    () =>
      // The tab may close before this lands; the follower retries a failure.
      createBrowserAgentFollow((tabId, follow) => webviewRef.current?.selectTab(tabId, follow)),
    [webviewRef]
  );
  useEffect(() => onBrowserPaneRevealed(sessionId, agentFollow.resume), [sessionId, agentFollow]);
  useEffect(() => {
    const view = webviewRef.current;
    return view ? agentFollow.attach(view) : undefined;
  }, [webviewRef, agentFollow]);
}

/** Whether the session's page is in element fullscreen (a video's own button):
 *  the host made the window fullscreen and the pane fills it until the page
 *  leaves; Esc is handled there, not by the page or this pane. */
export function useBrowserFullscreen(sessionId: string): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(
    () =>
      window.mixdogDesktop?.onBrowserFullscreenChanged?.((change) => {
        if (change.sessionId === sessionId) setFullscreen(change.active);
      }),
    [sessionId]
  );
  return fullscreen;
}

/** Escape restores an expanded pane (not while a dialog over it is open). */
export function useEscapeRestore(enabled: boolean, onToggleExpanded: (() => void) | undefined) {
  useEffect(() => {
    if (!enabled || !onToggleExpanded) return undefined;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      onToggleExpanded();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [enabled, onToggleExpanded]);
}

/** A main tab reports its page's address and title for persistence. */
export function useMainTabPageReport(
  mainTab: boolean,
  currentUrl: string,
  title: string,
  onPageChange: ((url: string, title: string) => void) | undefined
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: onPageChange is a fresh callback per parent render; the page reports only when its address or title changes.
  useEffect(() => {
    if (mainTab && currentUrl) onPageChange?.(currentUrl, title);
  }, [mainTab, currentUrl, title]);
}
