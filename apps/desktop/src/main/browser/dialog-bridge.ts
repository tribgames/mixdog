const DIALOG_BRIDGE_HOST = 'mixdog-dialog-bridge.invalid';
export const DIALOG_BRIDGE_PATH = '/.well-known/mixdog-dialog-bridge';
export const DIALOG_BRIDGE_PATTERN = `*://*${DIALOG_BRIDGE_PATH}*`;
/** The dialogs the bridge carries; a leave confirmation stays Chromium's own. */
export const BRIDGED_DIALOG_TYPES: ReadonlySet<string> = new Set(['alert', 'confirm', 'prompt']);
/** First argument of the console call the bridge makes for a dialog that
 *  never reached the host, so the host can say it was dismissed. */
const DIALOG_DISMISSED_NOTICE = '__mixdogDialogDismissed';

/** Runs in the page's own world before its scripts, and leaves nothing a page
 *  could tell apart from Chrome's own dialogs: no global of its own, and each
 *  dialog function stays the browser's function behind a call trap, so its
 *  name, arity and native source text are the ones Chrome reports. Everything
 *  the bridge uses is captured before the page can replace it. */
export const DIALOG_BRIDGE_SCRIPT = `(() => {
  const win = window;
  const endpoint = (() => {
    try {
      return new URL(${JSON.stringify(DIALOG_BRIDGE_PATH)}, location.href).href;
    } catch {
      return ${JSON.stringify(`http://${DIALOG_BRIDGE_HOST}${DIALOG_BRIDGE_PATH}`)};
    }
  })();
  const apply = Reflect.apply;
  const Request = XMLHttpRequest;
  const { open, send } = Request.prototype;
  const responseText = Object.getOwnPropertyDescriptor(Request.prototype, 'responseText')?.get;
  const Query = URLSearchParams;
  const queryText = Query.prototype.toString;
  const parse = JSON.parse;
  // Bound before any page script runs, so the page cannot intercept it.
  const reportDismissed = console.debug.bind(console, ${JSON.stringify(DIALOG_DISMISSED_NOTICE)});
  // A request that never reaches the host (a page CSP refusing connect-src,
  // for one) is answered as dismissed, and reported as such. The page's own
  // dialog is never the fallback: in Electron that is an OS dialog box
  // outside the pane.
  const ask = (type, message, defaultPrompt) => {
    let answer = null;
    try {
      const query = new Query({
        type: String(type || ''),
        message: String(message == null ? '' : message),
        defaultPrompt: String(defaultPrompt == null ? '' : defaultPrompt),
      });
      const request = new Request();
      apply(open, request, ['GET', endpoint + '?' + apply(queryText, query, []), false]);
      apply(send, request, [null]);
      answer = parse((responseText ? apply(responseText, request, []) : request.responseText) || 'null');
    } catch {
      /* no host answer: treated as dismissed below */
    }
    if (answer && typeof answer.accept === 'boolean') return answer;
    reportDismissed(String(type || ''), String(message == null ? '' : message));
    return null;
  };
  const answers = {
    alert: (message) => {
      ask('alert', message, '');
    },
    confirm: (message) => Boolean(ask('confirm', message, '')?.accept),
    prompt: (message, defaultPrompt) => {
      const initial = defaultPrompt == null ? '' : String(defaultPrompt);
      const result = ask('prompt', message, initial);
      if (!result?.accept) return null;
      // The host shows a bounded copy of the default; accepting it unchanged
      // keeps the page's own value rather than that copy.
      if (result.keepDefault) return initial;
      return String(result.promptText == null ? '' : result.promptText);
    },
  };
  for (const name of ['alert', 'confirm', 'prompt']) {
    const own = typeof win[name] === 'function' ? win[name] : function () {};
    const answer = answers[name];
    win[name] = new Proxy(own, { apply: (_target, _self, args) => answer(args[0], args[1]) });
  }
})()`;

const dialogType = (raw: string) => (BRIDGED_DIALOG_TYPES.has(raw) ? raw : 'dialog');
const dialogMessage = (raw: string) => raw.slice(0, 4_000);

export function parseDialogBridgeRequest(rawUrl: string): {
  type: string;
  message: string;
  defaultPrompt: string;
} | null {
  const parsed = new URL(rawUrl);
  if (parsed.pathname !== DIALOG_BRIDGE_PATH) return null;
  return {
    type: dialogType(parsed.searchParams.get('type') || ''),
    message: dialogMessage(parsed.searchParams.get('message') || ''),
    defaultPrompt: (parsed.searchParams.get('defaultPrompt') || '').slice(0, 2_000),
  };
}

/** The dialog a `Runtime.consoleAPICalled` event reports as dismissed
 *  because its bridge request never reached the host; null for any other
 *  console call. */
export function parseDialogBridgeNotice(params: Record<string, unknown>): { type: string; message: string } | null {
  const args = Array.isArray(params.args) ? (params.args as Array<{ value?: unknown } | null>) : [];
  const text = (index: number) => {
    const value = args[index]?.value;
    return typeof value === 'string' ? value : '';
  };
  if (params.type !== 'debug' || text(0) !== DIALOG_DISMISSED_NOTICE) return null;
  return { type: dialogType(text(1)), message: dialogMessage(text(2)) };
}

/** `keepDefault`: the answer is the prompt's default as shown, so the page
 *  keeps its full default instead of the shown (bounded, redacted) copy. */
export function dialogBridgeFulfillParams(
  requestId: string,
  accept: boolean,
  promptText: string,
  keepDefault = false
): Record<string, unknown> {
  const body = Buffer.from(JSON.stringify({ accept, promptText, ...(keepDefault ? { keepDefault: true } : {}) }));
  return {
    requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Content-Length', value: String(body.length) },
      { name: 'Cache-Control', value: 'no-store' },
    ],
    body: body.toString('base64'),
  };
}
