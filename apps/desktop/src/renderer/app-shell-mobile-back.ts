import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import type { DesktopUpdaterState } from '../shared/contract';
import { isMobileRemoteSurface } from './MobileTabOverview';
import { registerMobileBack } from './mobile-back';
import type { WorkbenchQuickAccessMode } from './workbench-overlays-loader';

export interface MobileBackProps {
  sidebarOpen: boolean;
  applySidebarOpen: (open: boolean, motion?: 'animated' | 'instant') => void;
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
  sidebarOpen,
  applySidebarOpen,
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
    const onHome = () => applySidebarOpenRef.current(!sidebarOpen);
    window.addEventListener('mixdog:mobile-home', onHome);
    return () => window.removeEventListener('mixdog:mobile-home', onHome);
  }, [sidebarOpen]);

  // Each transient mobile layer owns a history sentinel so hardware back
  // closes that layer instead of leaving the PWA. registerMobileBack is
  // inactive outside the projected phone surface.
  // Closures are stored in refs to prevent re-registration and history thrash
  // when snapshots cause renders while a layer stays open.
  const closeSidebarRef = useRef(() => applySidebarOpen(false));
  closeSidebarRef.current = () => applySidebarOpen(false);
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    return registerMobileBack(() => closeSidebarRef.current());
  }, [sidebarOpen]);

  const closeBottomPanelRef = useRef(() => setBottomPanelOpen(false));
  closeBottomPanelRef.current = () => setBottomPanelOpen(false);
  useEffect(() => {
    if (!bottomPanelOpen) return undefined;
    return registerMobileBack(() => closeBottomPanelRef.current());
  }, [bottomPanelOpen]);

  const closeFocusedPaneDockRef = useRef(closeFocusedPaneDock);
  closeFocusedPaneDockRef.current = closeFocusedPaneDock;
  useEffect(() => {
    if (!focusedPaneDockOpen) return undefined;
    return registerMobileBack(() => closeFocusedPaneDockRef.current());
  }, [focusedPaneDockOpen]);

  const closeSettingsRef = useRef(() => setSettingsOpen(false));
  closeSettingsRef.current = () => setSettingsOpen(false);
  useLayoutEffect(() => {
    if (!settingsOpen) return undefined;
    return registerMobileBack(() => closeSettingsRef.current());
  }, [settingsOpen]);

  const closeCommandSurfaceRef = useRef(closeCommandSurface);
  closeCommandSurfaceRef.current = closeCommandSurface;
  useEffect(() => {
    if (!commandSurface) return undefined;
    return registerMobileBack(() => closeCommandSurfaceRef.current());
  }, [commandSurface]);

  const closeOnboardingRef = useRef(() => setOnboardingOpen(false));
  closeOnboardingRef.current = () => setOnboardingOpen(false);
  useEffect(() => {
    if (!onboardingOpen) return undefined;
    return registerMobileBack(() => closeOnboardingRef.current());
  }, [onboardingOpen]);

  const closeQuickAccessRef = useRef(closeQuickAccess);
  closeQuickAccessRef.current = closeQuickAccess;
  useEffect(() => {
    if (!quickAccessMode) return undefined;
    return registerMobileBack(() => closeQuickAccessRef.current());
  }, [quickAccessMode]);

  const cancelPendingTabCloseRef = useRef(cancelPendingTabClose);
  cancelPendingTabCloseRef.current = cancelPendingTabClose;
  useEffect(() => {
    if (!pendingUnsavedClose) return undefined;
    return registerMobileBack(() => cancelPendingTabCloseRef.current());
  }, [pendingUnsavedClose]);

  const closeDesktopUpdateRef = useRef(closeDesktopUpdate);
  closeDesktopUpdateRef.current = closeDesktopUpdate;
  const updateReady = updateDialogOpen && updaterState.status === 'ready';
  useEffect(() => {
    if (!updateReady) return undefined;
    return registerMobileBack(() => closeDesktopUpdateRef.current());
  }, [updateReady]);
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
  // Initialize mobile with drawer, docks, and bottom panel closed once per
  // load. Apply before first paint so a persisted desktop layout never flashes.
  const mobileStartedClosed = useRef(false);
  useLayoutEffect(() => {
    if (mobileStartedClosed.current || !isMobileRemoteSurface()) return;
    mobileStartedClosed.current = true;
    applySidebarOpen(false, 'instant');
    closeFocusedPaneDock(focusedLeafIdRef.current);
    setBottomPanelOpen(false, 'instant');
  }, [applySidebarOpen, closeFocusedPaneDock, focusedLeafIdRef, setBottomPanelOpen]);
}
