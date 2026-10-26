import { reportRendererFailure } from './RendererRecovery';

/** Tell the host a browser pane started or stopped reading a session's pages.
 *  A rejected report is a real failure (the host then misjudges the panel), so
 *  it goes to the renderer diagnostics rather than being dropped. */
export function reportBrowserPanelShown(sessionId: string, shown: boolean, pane: string): void {
  void window.mixdogDesktop?.browserPanelShown?.(sessionId, shown, pane).catch((error: unknown) => {
    reportRendererFailure('unhandled-rejection', error);
  });
}
