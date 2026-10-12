import type { DesktopApi, DesktopWorkspace, DesktopWorkspaceFolder } from '../shared/contract';
import { t } from './i18n';
import { isRemoteHostRenderer } from './remote-ui-projection';

/** Save the workspace. The host's save dialog is invisible to a remote
 *  surface, so it asks for the destination path on the host computer; a
 *  null path lets the host show its own dialog. Returns null when cancelled. */
export async function saveWorkspaceFlow(
  api: Pick<DesktopApi, 'saveWorkspace'>,
  folders: DesktopWorkspaceFolder[],
  ask: (message: string) => string | null = (message) => window.prompt(message)
): Promise<DesktopWorkspace | null> {
  let target: string | null = null;
  if (isRemoteHostRenderer()) {
    const typed = ask(t('Save workspace file to this path on the host computer (.code-workspace):'))?.trim();
    if (!typed) return null;
    target = typed;
  }
  return (await api.saveWorkspace?.(target, folders)) ?? null;
}
