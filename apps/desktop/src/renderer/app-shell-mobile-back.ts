import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import type { DesktopUpdaterState } from '../shared/contract';
import { useMobileRemoteSurface } from './mobile-surface';
import { registerMobileBack, useMobileBack } from './mobile-back';
import type { WorkbenchQuickAccessMode } from './workbench-overlays-loader';

interface MobileBackProps {
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
  useMobileBack(sidebarOpen, () => applySidebarOpen(false));
  useMobileBack(bottomPanelOpen, () => setBottomPanelOpen(false));
  useMobileBack(focusedPaneDockOpen, closeFocusedPaneDock);

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

  useMobileBack(onboardingOpen, () => setOnboardingOpen(false));

  const closeQuickAccessRef = useRef(closeQuickAccess);
  closeQuickAccessRef.current = closeQuickAccess;
  useEffect(() => {
    if (!quickAccessMode) return undefined;
    return registerMobileBack(() => closeQuickAccessRef.current());
  }, [quickAccessMode]);

  useMobileBack(pendingUnsavedClose, cancelPendingTabClose);
  useMobileBack(updateDialogOpen && updaterState.status === 'ready', closeDesktopUpdate);
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
  // Re-armed when the layout leaves the phone grammar, so a tablet→phone
  // switch (rotation, split view) also starts with the layers folded.
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
