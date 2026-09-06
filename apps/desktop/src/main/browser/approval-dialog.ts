import { dialog, type BrowserWindow } from 'electron';
import { withHumanOnlyApproval } from '../human-only-approval';
import type { BrowserApprovalRequest } from './action-approval';
import { redactBrowserUrl } from './redaction';
import { nativeT } from '../native-i18n';

export function requestBrowserApproval(window: BrowserWindow, request: BrowserApprovalRequest, signal?: AbortSignal) {
  return withHumanOnlyApproval(async () => {
    const remaining = request.expiresAt - Date.now();
    if (remaining <= 0 || signal?.aborted || window.isDestroyed()) return false;
    const timeout = AbortSignal.timeout(remaining);
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: nativeT('Browser Use approval'),
      message: nativeT('Allow this action once?'),
      detail: [
        `${nativeT('Session')}: ${request.sessionId}`,
        `${nativeT('Action')}: ${request.action}`,
        `${nativeT('Page')}: ${redactBrowserUrl(request.url)}`,
        `${nativeT('Target')}: ${request.target}`,
        ...request.paths,
      ].join('\n'),
      buttons: [nativeT('Cancel'), nativeT('Allow once')],
      defaultId: 0, cancelId: 0, noLink: true,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return result.response === 1 && !timeout.aborted;
  });
}
