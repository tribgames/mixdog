/**
 * HTML panes are iframes of the main window, so their console output, network
 * and frame navigations arrive on its webContents; the service keeps only what
 * belongs to a displayed page.
 */
import type { WebContents, WebFrameMain } from 'electron';

import { OUTSIDE_NETWORK_URL_PATTERNS } from '../../shared/visualize-network-policy';
import type { RequesterFrame, VisualizeService } from './service';

type PageProblemSink = Pick<
  VisualizeService,
  'reportConsole' | 'guardNavigation' | 'guardRequest' | 'reportAssetFailure' | 'reportNavigation' | 'reportLoadFailure'
>;

type RequestDetails = {
  webContentsId?: number;
  frame?: WebFrameMain | null;
  referrer: string;
};

const isAsset = (type: string) => type !== 'mainFrame' && type !== 'subFrame';

/** The URLs of a frame and its ancestors, nearest first. */
function frameChain(start: WebFrameMain | null | undefined): RequesterFrame[] {
  const chain: RequesterFrame[] = [];
  try {
    for (let frame = start; frame && !frame.isDestroyed(); frame = frame.parent) {
      chain.push({ url: frame.url, id: frame.frameTreeNodeId });
    }
  } catch {
    // A frame going away mid-request: judge by what was read.
  }
  return chain;
}

/** The session is shared by every webContents using it, so a request counts
 *  only when `contents` made it: the URLs of its requesting frame and that
 *  frame's ancestors (and the referrer). Another webContents' requests yield
 *  none and are never judged or reported. */
function requesterOrigins(contentsId: number, details: RequestDetails): RequesterFrame[] {
  if (details.webContentsId !== contentsId) return [];
  const chain = frameChain(details.frame);
  if (details.referrer) chain.push(details.referrer);
  return chain;
}

function watchConsole(contents: WebContents, service: Pick<PageProblemSink, 'reportConsole'>): void {
  contents.on('console-message', (event) => {
    const frame = event.frame;
    service.reportConsole({
      level: event.level,
      message: event.message,
      sourceId: event.sourceId,
      lineNumber: event.lineNumber,
      frameUrl: frame && !frame.isDestroyed() ? frame.url : '',
    });
  });
}

/** A pane frame may not navigate itself away from its lease (a link, a
 *  `location` assignment, a `blob:`/`data:` URL): that would hand the page
 *  an origin the request guard no longer recognizes by URL. Navigations the
 *  app starts itself (it points the iframe) are initiated by the main frame. */
function guardNavigations(contents: WebContents, service: Pick<PageProblemSink, 'guardNavigation'>): void {
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || !event.frame) return;
    const appInitiated = event.initiator ? event.initiator.parent === null : false;
    if (service.guardNavigation(frameChain(event.frame), event.url, appInitiated)) event.preventDefault();
  });
}

/** Pages run scripts, so their outside network is cut here, in main, where
 *  the page cannot reach: a request is refused when the frame that made it
 *  (or an ancestor, or its referrer) is a visualize lease whose tab has not
 *  allowed network. Every other request — the app, the browser panel, other
 *  windows — is left alone. Chromium logs a failed subresource load to the
 *  devtools console only, never to `console-message`; the network layer is
 *  the reliable source for a page's missing styles, scripts, images and fonts. */
function watchRequests(
  contents: WebContents,
  service: Pick<PageProblemSink, 'guardRequest' | 'reportAssetFailure'>
): void {
  const requests = contents.session.webRequest;
  requests.onBeforeRequest({ urls: OUTSIDE_NETWORK_URL_PATTERNS }, (details, callback) => {
    callback({
      cancel: service.guardRequest(requesterOrigins(contents.id, details), {
        url: details.url,
        resourceType: details.resourceType,
      }),
    });
  });
  requests.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    if (details.statusCode >= 400 && isAsset(details.resourceType)) {
      service.reportAssetFailure(details.url, `${details.statusCode}`, requesterOrigins(contents.id, details));
    }
  });
  requests.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    // An aborted request is a navigation or a removed element, not a missing file.
    if (isAsset(details.resourceType) && details.error !== 'net::ERR_ABORTED') {
      service.reportAssetFailure(details.url, details.error, requesterOrigins(contents.id, details));
    }
  });
}

function watchLoads(contents: WebContents, service: Pick<PageProblemSink, 'reportNavigation' | 'reportLoadFailure'>) {
  contents.on('did-frame-navigate', (_event, url, httpResponseCode, _statusText, isMainFrame) => {
    if (!isMainFrame) service.reportNavigation(url, httpResponseCode);
  });
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 is a navigation that was superseded, not a failure.
    if (!isMainFrame && code !== -3) service.reportLoadFailure(url, description);
  });
}

/** Wires `contents`' page problems into `service`. Call once per webContents. */
export function watchPageProblems(contents: WebContents, service: PageProblemSink): void {
  watchConsole(contents, service);
  guardNavigations(contents, service);
  watchRequests(contents, service);
  watchLoads(contents, service);
}
