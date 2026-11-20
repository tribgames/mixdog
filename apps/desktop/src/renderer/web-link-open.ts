import { errorMessageText } from './ErrorNotice';
import { showDesktopToast } from './desktop-toasts';
import { t } from './i18n';
import { browserPageRequestsAvailable, requestBrowserPage } from './browser-page-request';
import { linkOpenTarget } from './link-open-target';
import { isRemoteHostRenderer } from './remote-ui-projection';
import type { ScmContextMenuState } from './ScmContextMenu';
import { copyTextToClipboard } from './text-format';

export function reportOpenFailure(error: unknown) {
  showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
}

/** Open a web page (a web URL or a served local page) where linkOpenTarget
 *  says: the session's browser pane, or the system browser. Rejects when the
 *  system browser cannot be opened. */
export async function openWebLink(
  sessionId: string | undefined,
  url: string,
  external?: boolean,
  newTab?: boolean
): Promise<void> {
  if (linkOpenTarget({ sessionId, paneAvailable: browserPageRequestsAvailable(), external, url }) === 'pane') {
    requestBrowserPage(sessionId as string, url, newTab ? { newTab: true } : undefined);
    return;
  }
  const api = window.mixdogDesktop;
  if (api?.openExternal) {
    await api.openExternal(url);
    return;
  }
  // Only a surface without the desktop bridge opens a tab itself.
  window.open(url, '_blank', 'noopener');
}

/** Ctrl/Cmd-click and middle-click on a web link: the system browser. */
export function openWebLinkInSystemBrowser(sessionId: string | undefined, url: string): void {
  void openWebLink(sessionId, url, true).catch(reportOpenFailure);
}

/** File name offered by "Save link as": the URL's last path segment. */
function linkSaveName(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1) || '';
    return decodeURIComponent(segment) || 'download';
  } catch {
    return 'download';
  }
}

/** The right-click menu of a web link, shared by chat links and page cards.
 *  The browser-pane entries exist only where linkOpenTarget picks the pane. */
export function webLinkMenu(
  sessionId: string | undefined,
  url: string,
  point: { x: number; y: number }
): ScmContextMenuState {
  const pane = linkOpenTarget({ sessionId, paneAvailable: browserPageRequestsAvailable() }) === 'pane';
  const run = (action: Promise<unknown>) => void action.catch(reportOpenFailure);
  return {
    label: t('Open in'),
    heading: t('Open in'),
    ...point,
    items: [
      ...(pane
        ? [
            { id: 'open-mixdog-browser', label: t('Mixdog Browser'), onSelect: () => run(openWebLink(sessionId, url)) },
            {
              id: 'open-mixdog-browser-new-tab',
              label: t('Mixdog Browser (New Tab)'),
              onSelect: () => run(openWebLink(sessionId, url, false, true)),
            },
          ]
        : []),
      { id: 'open-system-browser', label: t('System Browser'), onSelect: () => run(openWebLink(sessionId, url, true)) },
      {
        id: 'copy-link',
        label: t('Copy link'),
        separatorBefore: true,
        onSelect: () => run(copyTextToClipboard(url)),
      },
      // A paired browser can only fetch same-origin/CORS URLs, which a chat
      // link almost never is: no dead entry there.
      ...(isRemoteHostRenderer()
        ? []
        : [
            {
              id: 'save-link-as',
              label: t('Save link as…'),
              onSelect: () =>
                run(
                  (async () => {
                    const save = window.mixdogDesktop?.saveFileAs;
                    if (!save) throw new Error(t('Desktop file access is unavailable.'));
                    await save(url, linkSaveName(url));
                  })()
                ),
            },
          ]),
    ],
  };
}
