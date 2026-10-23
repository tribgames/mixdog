/**
 * Turning ON "Allow all actions" (developer option `allowAllActions`) removes
 * the approval cards an agent would otherwise meet, so an agent must never be
 * able to do it to itself. The renderer's own confirmation is not enough: Computer Use
 * can click a toggle and then its ordinary in-page confirmation. Enabling is
 * therefore confirmed here, in the main process, under the human-only
 * approval lock (human-only-approval.ts): while the native dialog is open
 * Computer Use refuses every new operation, as for a Browser Use approval
 * card, so only the person can answer it. Turning the option off needs none.
 */
import type { BrowserWindow, Dialog } from 'electron';
import { withHumanOnlyApproval } from './human-only-approval';

/** Whether a capability call turns ON "Allow all actions". */
export function isAllowAllActionsEnable(capability: string, args: readonly unknown[] = []): boolean {
  return capability === 'setDeveloperOption' && args[0] === 'allowAllActions' && args[1] === true;
}

/** The person's confirmation to turn on "Allow all actions", resolved true only
 *  when they accept the risk. Text mirrors the runtime registry entry
 *  (src/runtime/shared/developer-options.mjs); a test keeps them equal. */
export function createAllowAllActionsConfirm(deps: {
  dialog: Pick<Dialog, 'showMessageBox'>;
  window: BrowserWindow;
  nativeT: (key: string) => string;
}): () => Promise<boolean> {
  const { dialog, window, nativeT } = deps;
  return () =>
    withHumanOnlyApproval(async () => {
      if (window.isDestroyed()) return false;
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: nativeT('Allow all actions'),
        message: nativeT('Allow all actions'),
        detail: nativeT(
          'Turning this on lets agents act without asking you first, except for payments and permanent deletes. Use it only if you accept that risk.'
        ),
        buttons: [nativeT('Accept risk and turn on'), nativeT('Cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return response === 0;
    });
}
