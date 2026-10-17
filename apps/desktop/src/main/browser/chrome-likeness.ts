/**
 * What a page of the browser partition reads to tell Chrome from an embedded
 * Chromium, made to read as Chrome's own. Runs in the page's world before its
 * scripts, in every frame, and defines no global of its own:
 *
 * - `window.chrome` carries `loadTimes`, `csi` and `app` as Chrome does, with
 *   values derived from the page's own navigation timing.
 * - A permission nobody decided reads as Chrome's default, `prompt`
 *   (`default` for `Notification.permission`), rather than the `denied` the
 *   embedding answers until a person allows it. The host says which are
 *   undecided; a permission a person refused stays `denied`. The engine's own
 *   answer is kept everywhere Chrome would say `denied` too: an insecure page
 *   and a cross-origin frame.
 *
 * Each function is a call trap over a function of the engine, so `toString`
 * prints native code and names, arities and prototypes stay the engine's.
 */

/** Permissions a fresh Chrome profile answers `prompt` for, as a
 *  `PermissionStatus` names them (the engine's own names, which differ from
 *  the query names for some: `camera` is `video_capture`). Any other (one
 *  Chrome grants by default, or one it does not know) keeps the engine's
 *  answer. */
export const BROWSER_PROMPT_PERMISSIONS = [
  'audio_capture',
  'captured_surface_control',
  'clipboard_read',
  'display_capture',
  'durable_storage',
  'geolocation',
  'idle_detection',
  'keyboard_lock',
  'local_fonts',
  'midi',
  'notifications',
  'pointer_lock',
  'push',
  'speaker_selection',
  'storage-access',
  'top-level-storage-access',
  'video_capture',
  'window-management',
] as const;

const PERMISSION_STATE_HOST = 'mixdog-permission-state.invalid';
export const PERMISSION_STATE_PATH = '/.well-known/mixdog-permission-state';
export const PERMISSION_STATE_PATTERN = `*://*${PERMISSION_STATE_PATH}*`;

/** The permission name a page's state question asks about, or null for any
 *  other request. */
export function parsePermissionStateRequest(rawUrl: string): { origin: string; name: string } | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.pathname !== PERMISSION_STATE_PATH) return null;
    return { origin: parsed.origin, name: parsed.searchParams.get('name') || '' };
  } catch {
    return null;
  }
}

/** The answer to a state question: `prompt` only when the permission is
 *  undecided for the asking page; a refusal stays what the engine says. */
export function permissionStateFulfillParams(requestId: string, prompt: boolean): Record<string, unknown> {
  const body = Buffer.from(JSON.stringify({ prompt }));
  return {
    requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Content-Length', value: String(body.length) },
      { name: 'Cache-Control', value: 'no-store' },
    ],
    body: body.toString('base64'),
  };
}

export const CHROME_LIKENESS_SCRIPT = `(() => {
  const win = window;
  const define = Object.defineProperty;
  const describe = Object.getOwnPropertyDescriptor;
  const apply = Reflect.apply;
  const trap = (target, call) => new Proxy(target, call ? { apply: call } : {});

  const performance = win.performance;
  const entriesByType = performance.getEntriesByType.bind(performance);
  const entriesByName = performance.getEntriesByName.bind(performance);
  const now = performance.now.bind(performance);
  const origin = performance.timeOrigin;
  const navigation = () => entriesByType('navigation')[0] || {};
  const seconds = (offset) => (offset ? (origin + offset) / 1000 : 0);
  const loadTimes = trap(function () {
    const entry = navigation();
    const protocol = String(entry.nextHopProtocol || '');
    const multiplexed = protocol === 'h2' || protocol === 'h3' || protocol.startsWith('hq');
    const paint = entriesByName('first-paint')[0];
    return {
      requestTime: origin / 1000,
      startLoadTime: origin / 1000,
      commitLoadTime: seconds(entry.responseStart),
      finishDocumentLoadTime: seconds(entry.domContentLoadedEventEnd),
      finishLoadTime: seconds(entry.loadEventEnd),
      firstPaintTime: paint ? seconds(paint.startTime) : 0,
      firstPaintAfterLoadTime: 0,
      navigationType: entry.type === 'reload' ? 'Reload' : entry.type === 'back_forward' ? 'BackForward' : 'Other',
      wasFetchedViaSpdy: multiplexed,
      wasNpnNegotiated: multiplexed,
      npnNegotiatedProtocol: multiplexed ? protocol : 'unknown',
      wasAlternateProtocolAvailable: false,
      connectionInfo: protocol || 'http/1.1',
    };
  });
  const csi = trap(function () {
    const entry = navigation();
    return {
      startE: Math.round(origin),
      onloadT: Math.round(origin + (entry.domContentLoadedEventEnd || 0)),
      pageT: now(),
      tran: entry.type === 'reload' ? 16 : entry.type === 'back_forward' ? 6 : 15,
    };
  });
  const InstallState = { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' };
  const RunningState = { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' };
  const app = {
    isInstalled: false,
    getDetails: trap(function () { return null; }),
    getIsInstalled: trap(function () { return false; }),
    installState: trap(function (callback) {
      if (typeof callback === 'function') setTimeout(callback, 0, InstallState.NOT_INSTALLED);
    }),
    runningState: trap(function () { return RunningState.CANNOT_RUN; }),
    InstallState,
    RunningState,
  };
  let chrome = win.chrome;
  if (!chrome || typeof chrome !== 'object') {
    chrome = {};
    define(win, 'chrome', { value: chrome, writable: true, enumerable: true, configurable: true });
  }
  if (!('loadTimes' in chrome)) chrome.loadTimes = loadTimes;
  if (!('csi' in chrome)) chrome.csi = csi;
  if (!('app' in chrome)) chrome.app = app;

  let sameOriginTop = false;
  try {
    sameOriginTop = win === win.top || win.top.location.origin === win.location.origin;
  } catch {
    sameOriginTop = false;
  }
  if (!win.isSecureContext || !sameOriginTop) return;
  const undecided = new Set(${JSON.stringify(BROWSER_PROMPT_PERMISSIONS)});
  // The engine answers denied for an undecided permission and for one a
  // person refused alike. The host knows which: it is asked, and only a
  // permission it says nobody decided reads as prompt. Without an answer the
  // engine's stays.
  const Request = XMLHttpRequest;
  const { open, send } = Request.prototype;
  const responseText = describe(Request.prototype, 'responseText')?.get;
  const Query = URLSearchParams;
  const queryText = Query.prototype.toString;
  const parse = JSON.parse;
  const endpoint = (() => {
    try {
      return new URL(${JSON.stringify(PERMISSION_STATE_PATH)}, win.location.href).href;
    } catch {
      return ${JSON.stringify(`http://${PERMISSION_STATE_HOST}${PERMISSION_STATE_PATH}`)};
    }
  })();
  const undecidedNow = (permissionName) => {
    try {
      const request = new Request();
      const query = new Query({ name: String(permissionName) });
      apply(open, request, ['GET', endpoint + '?' + apply(queryText, query, []), false]);
      apply(send, request, [null]);
      const answer = parse((responseText ? apply(responseText, request, []) : request.responseText) || 'null');
      return Boolean(answer) && answer.prompt === true;
    } catch {
      return false;
    }
  };
  const Status = win.PermissionStatus && win.PermissionStatus.prototype;
  const state = Status && describe(Status, 'state');
  const name = Status && describe(Status, 'name');
  if (state && state.get && name && name.get) {
    const readName = name.get;
    define(Status, 'state', {
      ...state,
      get: trap(state.get, (target, self, args) => {
        const value = apply(target, self, args);
        if (value !== 'denied') return value;
        const permissionName = apply(readName, self, []);
        return undecided.has(permissionName) && undecidedNow(permissionName) ? 'prompt' : value;
      }),
    });
  }
  const permission = win.Notification && describe(win.Notification, 'permission');
  if (permission && permission.get) {
    define(win.Notification, 'permission', {
      ...permission,
      get: trap(permission.get, (target, self, args) => {
        const value = apply(target, self, args);
        return value === 'denied' && undecidedNow('notifications') ? 'default' : value;
      }),
    });
  }
})()`;
