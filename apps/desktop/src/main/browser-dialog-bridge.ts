export const DIALOG_BRIDGE_HOST = 'mixdog-dialog-bridge.invalid';
export const DIALOG_BRIDGE_PATH = '/.well-known/mixdog-dialog-bridge';
export const DIALOG_BRIDGE_PATTERN = `*://*${DIALOG_BRIDGE_PATH}*`;

export const DIALOG_BRIDGE_SCRIPT = `(() => {
  if (window.__mixdogDialogBridgeInstalled) return;
  window.__mixdogDialogBridgeInstalled = true;
  window.__mixdogDialogBridgeOriginals = {
    alert: window.alert,
    confirm: window.confirm,
    prompt: window.prompt,
  };
  const endpoint = (() => {
    try {
      return new URL(${JSON.stringify(DIALOG_BRIDGE_PATH)}, location.href).href;
    } catch {
      return ${JSON.stringify(`http://${DIALOG_BRIDGE_HOST}${DIALOG_BRIDGE_PATH}`)};
    }
  })();
  const ask = (type, message, defaultPrompt) => {
    try {
      const query = new URLSearchParams({
        type: String(type || ''),
        message: String(message == null ? '' : message),
        defaultPrompt: String(defaultPrompt == null ? '' : defaultPrompt),
      });
      const request = new XMLHttpRequest();
      request.open('GET', endpoint + '?' + query.toString(), false);
      request.send(null);
      const body = request.responseText || '';
      if (!body && request.status !== 200) return null;
      return JSON.parse(body || 'null');
    } catch {
      return null;
    }
  };
  window.alert = (message) => { ask('alert', message, ''); };
  window.confirm = (message) => Boolean(ask('confirm', message, '')?.accept);
  window.prompt = (message, defaultPrompt) => {
    const result = ask('prompt', message, defaultPrompt == null ? '' : defaultPrompt);
    return result?.accept ? String(result.promptText == null ? '' : result.promptText) : null;
  };
})()`;

export const DIALOG_BRIDGE_UNINSTALL_SCRIPT = `(() => {
  const originals = window.__mixdogDialogBridgeOriginals;
  if (originals) {
    window.alert = originals.alert;
    window.confirm = originals.confirm;
    window.prompt = originals.prompt;
  }
  delete window.__mixdogDialogBridgeOriginals;
  delete window.__mixdogDialogBridgeInstalled;
})()`;

export function parseDialogBridgeRequest(rawUrl: string): {
  type: string;
  message: string;
  defaultPrompt: string;
} | null {
  const parsed = new URL(rawUrl);
  if (parsed.pathname !== DIALOG_BRIDGE_PATH) return null;
  const rawType = parsed.searchParams.get('type') || 'dialog';
  const type = ['alert', 'confirm', 'prompt'].includes(rawType) ? rawType : 'dialog';
  return {
    type,
    message: (parsed.searchParams.get('message') || '').slice(0, 4_000),
    defaultPrompt: (parsed.searchParams.get('defaultPrompt') || '').slice(0, 2_000),
  };
}

export function dialogBridgeFulfillParams(
  requestId: string,
  accept: boolean,
  promptText: string,
): Record<string, unknown> {
  const body = Buffer.from(JSON.stringify({ accept, promptText }));
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
