import { useLayoutEffect } from 'react';
import { markBootStage } from './boot-metrics';
import { useAppWorkspaceShell } from './app-root/use-app-workspace-shell';
import { useAppNavigationShell } from './app-root/use-app-navigation-shell';
import { useAppSessionLifecycle } from './app-root/use-app-session-lifecycle';
import { useAppSessionCommands } from './app-root/use-app-session-commands';
import { useAppSelectionContext } from './app-root/use-app-selection-context';
import { useAppTabWorkflow } from './app-root/use-app-tab-workflow';
import { useAppWorkbenchHubs } from './app-root/use-app-workbench-hubs';
import { useAppPaneSurfaces } from './app-root/use-app-pane-surfaces';
import { useAppWorkbenchViewWiring } from './app-root/use-app-workbench-view-wiring';
import { AppShellLayout } from './app-root/AppShellLayout';

export function App() {
  markBootStage('app-render');
  useLayoutEffect(() => {
    markBootStage('react-committed');
    window.dispatchEvent(new Event('mixdog:react-committed'));
  }, []);
  const shell = useAppWorkspaceShell();
  const nav = useAppNavigationShell(shell);
  const lifecycle = useAppSessionLifecycle(shell, nav);
  const commands = useAppSessionCommands(shell, nav, lifecycle);
  const context = useAppSelectionContext(shell, nav, lifecycle, commands);
  const tabWorkflow = useAppTabWorkflow(shell, nav, lifecycle, commands, context);
  const hubs = useAppWorkbenchHubs(shell, nav, lifecycle, commands, context, tabWorkflow);
  const surfaces = useAppPaneSurfaces(shell, nav, lifecycle, commands, context, tabWorkflow, hubs);
  const views = useAppWorkbenchViewWiring(
    shell,
    nav,
    lifecycle,
    commands,
    context,
    tabWorkflow,
    hubs,
    surfaces.desktopBootReady
  );

  return (
    <AppShellLayout
      shell={shell}
      nav={nav}
      lifecycle={lifecycle}
      commands={commands}
      context={context}
      tabWorkflow={tabWorkflow}
      hubs={hubs}
      surfaces={surfaces}
      views={views}
    />
  );
}

export { ApprovalCard } from './ApprovalCard';
export { DesktopUpdateDialog } from './notifications';
export { TranscriptRow } from './transcript-row';
export { ContextUsageIndicator } from './transcript-status';
