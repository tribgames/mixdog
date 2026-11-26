import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import type { DesktopUpdaterState } from '../shared/contract';
import { drawerIntentOpen } from './drawer-intent';
import { useMobileRemoteSurface } from './mobile-surface';
import { registerMobileBack, useMobileBack, type MobileBackCloseHandler } from './mobile-back';
import type { WorkbenchQuickAccessMode } from './workbench-overlays-loader';

/** Whether a tab selection is a conversation home surface (where Back with no
 *  open overlays may background the Android app) vs a non-conversation view. */
export function isConversationTabSelection(selection: { kind: string } | null | undefined): boolean {
  return !selection || selection.kind === 'new' || selection.kind === 'session' || selection.kind === 'project';
}

interface MobileBackProps {
  nonConversationTabOpen?: boolean;
  returnFromNonConversationTab?: MobileBackCloseHandler;
  sidebarOpen: boolean;
  applySidebarOpen: (open: boolean, motion?: 'animated' | 'instant') => void;
  sidebarSubPanelOpen?: boolean;
  closeSidebarSubPanel?: () => void;
  bottomPanelOpen: boolean;
  setBottomPanelOpen: (open: boolean, motion?: 'animated' | 'instant') => void;
  focusedPaneDockOpen: boolean;
  closeFocusedPaneDock: () => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  commandSurface: string | null;
  closeCommandSurface: () => void;
  onboardingOpen: boolean;
  setOnboardingOpen: (open: boolean) => void;
  quickAccessMode: WorkbenchQuickAccessMode | null;
  closeQuickAccess: () => void;
  pendingUnsavedClose: boolean;
  cancelPendingTabClose: () => void;
  updateDialogOpen: boolean;
  updaterState: DesktopUpdaterState;
  closeDesktopUpdate: () => void;
}

export function useAppMobileBack({
  nonConversationTabOpen = false,
  returnFromNonConversationTab,
  sidebarOpen,
  applySidebarOpen,
  sidebarSubPanelOpen = false,
  closeSidebarSubPanel,
  bottomPanelOpen,
  setBottomPanelOpen,
  focusedPaneDockOpen,
  closeFocusedPaneDock,
  settingsOpen,
  setSettingsOpen,
  commandSurface,
  closeCommandSurface,
  onboardingOpen,
  setOnboardingOpen,
  quickAccessMode,
  closeQuickAccess,
  pendingUnsavedClose,
  cancelPendingTabClose,
  updateDialogOpen,
  updaterState,
  closeDesktopUpdate,
}: MobileBackProps) {
  // Phone strip home intent: the strip renders the brand-mark home button
  // but does not own the session drawer, so the intent rides a window event
  // instead of prop-drilling through the pane tree.
  const applySidebarOpenRef = useRef(applySidebarOpen);
  applySidebarOpenRef.current = applySidebarOpen;
  useEffect(() => {
    const onHome = () => applySidebarOpenRef.current(!drawerIntentOpen(sidebarOpen));
    window.addEventListener('mixdog:mobile-home', onHome);
    return () => window.removeEventListener('mixdog:mobile-home', onHome);
  }, [sidebarOpen]);

  // Lowest tier: sits below shell drawers/docks and in-pane overlays even if a
  // non-conversation tab opens from an open drawer or stays open across closeTab.
  const returnFromTabRef = useRef(returnFromNonConversationTab);
  returnFromTabRef.current = returnFromNonConversationTab;
  useLayoutEffect(() => {
    if (!nonConversationTabOpen) return undefined;
    return registerMobileBack(() => returnFromTabRef.current?.(), 'tab');
  }, [nonConversationTabOpen]);

  useMobileBack(sidebarOpen, () => applySidebarOpen(false), 'shell');
  useMobileBack(Boolean(sidebarOpen && sidebarSubPanelOpen), () => closeSidebarSubPanel?.(), 'shell-sub');
  useMobileBack(bottomPanelOpen, () => setBottomPanelOpen(false), 'shell');
  useMobileBack(focusedPaneDockOpen, closeFocusedPaneDock, 'shell');

  const closeSettingsRef = useRef(() => setSettingsOpen(false));
  closeSettingsRef.current = () => setSettingsOpen(false);
  useLayoutEffect(() => {
    if (!settingsOpen) return undefined;
    return registerMobileBack(() => closeSettingsRef.current(), 'overlay');
  }, [settingsOpen]);

  const closeCommandSurfaceRef = useRef(closeCommandSurface);
  closeCommandSurfaceRef.current = closeCommandSurface;
  useEffect(() => {
    if (!commandSurface) return undefined;
    return registerMobileBack(() => closeCommandSurfaceRef.current(), 'overlay');
  }, [commandSurface]);

  useMobileBack(onboardingOpen, () => setOnboardingOpen(false), 'overlay');

  const closeQuickAccessRef = useRef(closeQuickAccess);
  closeQuickAccessRef.current = closeQuickAccess;
  useEffect(() => {
    if (!quickAccessMode) return undefined;
    return registerMobileBack(() => closeQuickAccessRef.current(), 'overlay');
  }, [quickAccessMode]);

  useMobileBack(pendingUnsavedClose, cancelPendingTabClose, 'modal');
  useMobileBack(updateDialogOpen && updaterState.status === 'ready', closeDesktopUpdate, 'modal');
}

export function useAppMobileInitialClose({
  applySidebarOpen,
  closeFocusedPaneDock,
  setBottomPanelOpen,
  focusedLeafIdRef,
}: {
  applySidebarOpen: (open: boolean, motion?: 'animated' | 'instant') => void;
  closeFocusedPaneDock: (leafId: string) => void;
  setBottomPanelOpen: (open: boolean, motion?: 'animated' | 'instant') => void;
  focusedLeafIdRef: MutableRefObject<string>;
}) {
  const mobile = useMobileRemoteSurface();
  const mobileStartedClosed = useRef(false);
  useLayoutEffect(() => {
    if (!mobile) {
      mobileStartedClosed.current = false;
      return;
    }
    if (mobileStartedClosed.current) return;
    mobileStartedClosed.current = true;
    applySidebarOpen(false, 'instant');
    closeFocusedPaneDock(focusedLeafIdRef.current);
    setBottomPanelOpen(false, 'instant');
  }, [mobile, applySidebarOpen, closeFocusedPaneDock, focusedLeafIdRef, setBottomPanelOpen]);
}
