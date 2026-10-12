import type React from 'react';
import { lazy, Suspense, useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { OPEN_DOCTOR_EVENT } from '../command-surface-doctor-event';
import type { SettingsSection as SlashSettingsSection } from '../slash-commands';
import type { DesktopModelSelection, DesktopSessionSummary } from '../../shared/contract';
import { SessionSearchHost } from '../SessionSearchDialog';
import { EMPTY_SNAPSHOT, type Snapshot } from '../desktop-types';
import type { WorkspaceSelection, WorkspaceTab } from '../navigation';
import { navigationKey } from '../text-format';
import type { PaneLeaf } from '../pane-layout';
import { TooltipLayer } from '../TooltipLayer';
import {
  UnsavedChangesDialog,
  WorkbenchQuickAccess,
  type WorkbenchQuickAccessMode,
} from '../workbench-overlays-loader';
import { DesktopToastRegion, DesktopUpdateDialog } from '../notifications';
import { DesktopLoadingSurface } from '../RendererRecovery';
import { OnboardingWizard, SettingsView } from '../app-shell-components';
import { loadCommandSurfaceModule } from '../command-surface-loader';
import { t } from '../i18n';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { useDesktopUpdater } from '../use-desktop-updater';
import type { WorkbenchCommand } from '../WorkbenchOverlays';
import { BRIDGE_UNAVAILABLE_ERROR } from './use-app-invocation';

const CommandSurface = lazy(() => loadCommandSurfaceModule().then((module) => ({ default: module.CommandSurface })));

export interface AppShellOverlaysProps {
  quickAccessMode: WorkbenchQuickAccessMode | null;
  quickAccessProjectPath: string;
  quickAccessRecentFiles: string[];
  workbenchCommands: WorkbenchCommand[];
  openFileTab: (project: string, rel: string, line?: number) => void;
  setQuickAccessMode: (mode: WorkbenchQuickAccessMode | null) => void;

  sessions: readonly DesktopSessionSummary[];
  openSearchSession: (sessionId: string) => void;

  tabSwitcher: { keys: string[]; index: number } | null;
  focusedLeafForShortcuts: PaneLeaf | null | undefined;
  stripTitleFor: (key: string, selection: WorkspaceSelection) => string;

  pendingUnsavedClose: { tab: WorkspaceTab } | null;
  unsavedCloseBusy: boolean;
  unsavedCloseError: string;
  saveAndClosePendingTab: () => Promise<void> | void;
  discardAndClosePendingTab: () => void;
  cancelPendingTabClose: () => void;

  settingsOpen: boolean;
  settingsSection: ComponentProps<typeof SettingsView>['initialSection'];
  settingsMounted: React.RefObject<boolean>;
  settingsPrewarmed: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Routes a /doctor fix to its settings page, like the typed slash command. */
  openSettings?: (section?: SlashSettingsSection | null) => void;

  commandSurface: string | null;
  commandSurfaceSessionId: string;
  commandSurfaceLane: Snapshot | null | undefined;
  setCommandSurface: ReturnType<typeof useAppShellPanels>['setCommandSurface'];
  setCommandSurfaceSessionId: (id: string) => void;
  replaceWithInheritedSession: (
    sessionId: string,
    route: DesktopModelSelection,
    options?: { compact: boolean }
  ) => Promise<void>;

  onboardingOpen: boolean;
  setOnboardingOpen: (open: boolean) => void;

  updateDialogOpen: boolean;
  updaterState: ReturnType<typeof useDesktopUpdater>['state'];
  closeDesktopUpdate: () => void;
  installDesktopUpdate: () => void;

  error: string;
  connected: boolean;
  setError: (err: string) => void;
  snapshot: Snapshot;
}

export function AppShellOverlays({
  quickAccessMode,
  quickAccessProjectPath,
  quickAccessRecentFiles,
  workbenchCommands,
  openFileTab,
  setQuickAccessMode,
  sessions,
  openSearchSession,
  tabSwitcher,
  focusedLeafForShortcuts,
  stripTitleFor,
  pendingUnsavedClose,
  unsavedCloseBusy,
  unsavedCloseError,
  saveAndClosePendingTab,
  discardAndClosePendingTab,
  cancelPendingTabClose,
  settingsOpen,
  settingsSection,
  settingsMounted,
  settingsPrewarmed,
  setSettingsOpen,
  openSettings,
  commandSurface,
  commandSurfaceSessionId,
  commandSurfaceLane,
  setCommandSurface,
  setCommandSurfaceSessionId,
  replaceWithInheritedSession,
  onboardingOpen,
  setOnboardingOpen,
  updateDialogOpen,
  updaterState,
  closeDesktopUpdate,
  installDesktopUpdate,
  error,
  connected,
  setError,
  snapshot,
}: AppShellOverlaysProps) {
  const mountedCommandSurfaces = useRef(new Set<string>());
  if (commandSurface) mountedCommandSurfaces.current.add(commandSurface);

  // Settings → System → Doctor opens the same /doctor dialog instead of
  // running the checks where their result has nowhere to show.
  useEffect(() => {
    const openDoctor = () => {
      setSettingsOpen(false);
      setCommandSurfaceSessionId('');
      setCommandSurface('doctor');
    };
    window.addEventListener(OPEN_DOCTOR_EVENT, openDoctor);
    return () => window.removeEventListener(OPEN_DOCTOR_EVENT, openDoctor);
  }, [setCommandSurface, setCommandSurfaceSessionId, setSettingsOpen]);

  const closeSettings = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);
  const composeFromSettings = useCallback(
    (text: string) => {
      setSettingsOpen(false);
      window.dispatchEvent(new CustomEvent('mixdog:composer-draft', { detail: text }));
    },
    [setSettingsOpen]
  );

  return (
    <>
      {quickAccessMode && (
        <WorkbenchQuickAccess
          key={quickAccessMode}
          mode={quickAccessMode}
          projectPath={quickAccessProjectPath}
          recentFiles={quickAccessRecentFiles}
          commands={workbenchCommands}
          onOpenFile={(rel, line) => {
            if (quickAccessProjectPath) openFileTab(quickAccessProjectPath, rel, line);
          }}
          onClose={() => setQuickAccessMode(null)}
        />
      )}
      <SessionSearchHost sessions={sessions} onOpenSession={openSearchSession} />
      {tabSwitcher && (
        <div className="workspace-tab-switcher" role="listbox" aria-label={t('Open tabs, most recent first')}>
          {tabSwitcher.keys.map((key, index) => {
            const selection = focusedLeafForShortcuts?.tabs.find((entry) => navigationKey(entry) === key);
            if (!selection) return null;
            return (
              <div
                key={key}
                role="option"
                tabIndex={-1}
                aria-selected={index === tabSwitcher.index}
                className={index === tabSwitcher.index ? 'active' : ''}
              >
                {stripTitleFor(key, selection)}
              </div>
            );
          })}
        </div>
      )}
      {pendingUnsavedClose && (
        <UnsavedChangesDialog
          title={pendingUnsavedClose.tab.title.replace(/^●\s*/, '')}
          busy={unsavedCloseBusy}
          error={unsavedCloseError}
          onSave={() => {
            void saveAndClosePendingTab();
          }}
          onDiscard={discardAndClosePendingTab}
          onCancel={cancelPendingTabClose}
        />
      )}
      <Suspense
        fallback={
          !settingsOpen && (commandSurface || onboardingOpen) ? (
            <DesktopLoadingSurface label={t('Loading view…')} overlay />
          ) : null
        }
      >
        {(settingsOpen || settingsMounted.current || settingsPrewarmed) && (
          <SettingsView
            open={settingsOpen}
            initialSection={settingsSection}
            onCompose={composeFromSettings}
            onClose={closeSettings}
          />
        )}
        {(['context', 'doctor', 'inherit', 'stats'] as const).map((surface) => {
          const isMounted = commandSurface === surface || mountedCommandSurfaces.current.has(surface);
          if (!isMounted) return null;

          const isSessionScoped = surface === 'context' || surface === 'inherit';
          const key = isSessionScoped ? `${surface}:${commandSurfaceSessionId}` : surface;
          const sessionId = isSessionScoped ? commandSurfaceSessionId : '';
          const surfaceSnapshot = isSessionScoped ? (commandSurfaceLane ?? EMPTY_SNAPSHOT) : snapshot;

          return (
            <CommandSurface
              key={key}
              surface={surface}
              open={commandSurface === surface}
              sessionId={sessionId}
              snapshot={surfaceSnapshot}
              onInherit={surface === 'inherit' ? replaceWithInheritedSession : undefined}
              onOpenSettings={surface === 'doctor' ? openSettings : undefined}
              onClose={() => {
                setCommandSurface(null);
                setCommandSurfaceSessionId('');
              }}
            />
          );
        })}
        {onboardingOpen && <OnboardingWizard api={window.mixdogDesktop} onDone={() => setOnboardingOpen(false)} />}
      </Suspense>
      {updateDialogOpen && updaterState.status === 'ready' && (
        <DesktopUpdateDialog
          version={updaterState.version}
          onCancel={closeDesktopUpdate}
          onConfirm={installDesktopUpdate}
        />
      )}
      <DesktopToastRegion
        bridgeError={error || (!connected ? BRIDGE_UNAVAILABLE_ERROR : '')}
        toasts={Array.isArray(snapshot.toasts) ? snapshot.toasts : []}
        onDismissBridgeError={() => setError('')}
      />
      <TooltipLayer />
    </>
  );
}
