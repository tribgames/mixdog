import type React from 'react';
import { lazy, Suspense, useRef, type ComponentProps } from 'react';
import type { DesktopModelSelection } from '../../shared/contract';
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

  commandSurface: string | null;
  commandSurfaceSessionId: string;
  commandSurfaceLane: Snapshot | null | undefined;
  setCommandSurface: ReturnType<typeof useAppShellPanels>['setCommandSurface'];
  setCommandSurfaceSessionId: (id: string) => void;
  replaceWithInheritedSession: (sessionId: string, route: DesktopModelSelection) => Promise<void>;

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
      {tabSwitcher && (
        <div className="workspace-tab-switcher" role="listbox" aria-label={t('Open tabs, most recent first')}>
          {tabSwitcher.keys.map((key, index) => {
            const selection = focusedLeafForShortcuts?.tabs.find((entry) => navigationKey(entry) === key);
            if (!selection) return null;
            return (
              <div
                key={key}
                role="option"
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
            <DesktopLoadingSurface label="Loading view…" overlay />
          ) : null
        }
      >
        {(settingsOpen || settingsMounted.current || settingsPrewarmed) && (
          <SettingsView
            open={settingsOpen}
            initialSection={settingsSection}
            onCompose={(text) => {
              setSettingsOpen(false);
              window.dispatchEvent(new CustomEvent('mixdog:composer-draft', { detail: text }));
            }}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {(['context', 'usage', 'doctor', 'inherit', 'stats'] as const).map((surface) => {
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
