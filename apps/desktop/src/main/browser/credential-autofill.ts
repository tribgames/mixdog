import type { WebContents } from 'electron';

import type { BrowserCredentialValue } from './profile-import';

export interface BrowserCredentialFillResult {
  usernameFilled: boolean;
  passwordFilled: boolean;
  reason?: 'no-password-field' | 'password-field-unavailable';
}

/** Runs only in a CDP-created isolated world. Credentials arrive as a
 * Runtime.callFunctionOn argument, never as renderer IPC data or source text. */
export const BROWSER_CREDENTIAL_AUTOFILL_FUNCTION = String.raw`async function(credential) {
  const collectInputs = () => {
    const inputs = [];
    const visit = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element instanceof HTMLInputElement) inputs.push(element);
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    return inputs;
  };
  const visible = (element) => {
    if (!element || element.disabled || element.readOnly || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const style = getComputedStyle(element);
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || (style.opacity !== '' && Number(style.opacity) === 0)
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const autocompleteTokens = (element) =>
    String(element.autocomplete || element.getAttribute('autocomplete') || '')
      .toLowerCase().split(/\s+/).filter(Boolean);
  const inputs = collectInputs();
  const passwordFields = inputs.filter((element) => {
    if (!visible(element) || String(element.type || '').toLowerCase() !== 'password') return false;
    return !autocompleteTokens(element).includes('new-password');
  });
  const active = document.activeElement;
  const passwordField = active instanceof HTMLInputElement && passwordFields.includes(active)
    ? active
    : passwordFields[0];
  if (!passwordField) {
    return { usernameFilled: false, passwordFilled: false, reason: 'no-password-field' };
  }
  const scope = passwordField.form
    ? inputs.filter((element) => element.form === passwordField.form)
    : inputs;
  const usernameField = scope
    .filter((element) => {
      const type = String(element.type || 'text').toLowerCase();
      return visible(element) && ['text', 'email', 'tel', 'url'].includes(type);
    })
    .map((element) => {
      const tokens = autocompleteTokens(element);
      const identity = String(element.name || '') + ' '
        + String(element.id || '') + ' '
        + String(element.getAttribute('aria-label') || '');
      let score = 0;
      if (tokens.includes('username')) score += 120;
      if (tokens.includes('email')) score += 100;
      if (String(element.type || '').toLowerCase() === 'email') score += 60;
      if (/(?:user|email|login|identifier|account)/i.test(identity)) score += 50;
      if (element.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING) score += 15;
      return { element, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.element || null;

  const setValue = async (element, value) => {
    if (!element || typeof value !== 'string' || !value) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    element.focus();
    await Promise.resolve();
    const dispatch = (event) => {
      try { element.dispatchEvent(event); } catch { /* unsupported synthetic event */ }
    };
    dispatch(new FocusEvent('focusin', { bubbles: true }));
    dispatch(new KeyboardEvent('keydown', { bubbles: true }));
    try {
      dispatch(new InputEvent('beforeinput', {
        bubbles: true,
        inputType: 'insertText',
        data: null,
      }));
    } catch { /* older pages may not expose InputEvent */ }
    setter.call(element, value);
    try {
      dispatch(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: null,
      }));
    } catch {
      dispatch(new Event('input', { bubbles: true }));
    }
    dispatch(new KeyboardEvent('keyup', { bubbles: true }));
    dispatch(new Event('change', { bubbles: true }));
    return element.value === value;
  };

  const usernameFilled = await setValue(usernameField, credential?.username);
  const passwordFilled = await setValue(passwordField, credential?.password);
  return {
    usernameFilled,
    passwordFilled,
    ...(passwordFilled ? {} : { reason: 'password-field-unavailable' }),
  };
}`;

export interface BrowserCredentialFillHost {
  guestDebugger(guest: WebContents): Promise<Electron.Debugger>;
  sendCdp<T>(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  /** Remember the password so replies redact it; returns the live secret set. */
  rememberSecret(guest: WebContents, secret: string): unknown;
  forgetSecret(guest: WebContents, secret: string): void;
  redactText(guest: WebContents, value: unknown): string;
}

/** Fill a stored credential through an isolated world, so the page script
 *  never sees the values as source text or renderer IPC. */
export function createBrowserCredentialFill(host: BrowserCredentialFillHost) {
  const { guestDebugger, sendCdp, rememberSecret, forgetSecret, redactText } = host;

  async function fillCredentialInGuest(
    guest: WebContents,
    credential: Readonly<BrowserCredentialValue>,
  ): Promise<BrowserCredentialFillResult> {
    const cdp = await guestDebugger(guest);
    const frameTree = await sendCdp<{
      frameTree?: { frame?: { id?: string } };
    }>(guest, cdp, 'Page.getFrameTree');
    const frameId = String(frameTree.frameTree?.frame?.id || '');
    if (!frameId) throw new Error('The current page frame is unavailable.');
    const world = await sendCdp<{ executionContextId?: number }>(
      guest,
      cdp,
      'Page.createIsolatedWorld',
      {
        frameId,
        worldName: 'mixdog-browser-credential-fill',
        grantUniveralAccess: false,
      },
    );
    if (!world.executionContextId) throw new Error('The secure credential fill context is unavailable.');
    rememberSecret(guest, credential.password);
    const response = await sendCdp<{
      result?: { value?: BrowserCredentialFillResult };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      guest,
      cdp,
      'Runtime.callFunctionOn',
      {
        executionContextId: world.executionContextId,
        functionDeclaration: BROWSER_CREDENTIAL_AUTOFILL_FUNCTION,
        arguments: [{
          value: {
            username: credential.username,
            password: credential.password,
          },
        }],
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
    );
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text || 'credential fill failed';
      throw new Error(redactText(guest, detail.split('\n')[0]));
    }
    const result = response.result?.value;
    if (!result || typeof result.passwordFilled !== 'boolean') {
      throw new Error('The secure credential fill returned an invalid result.');
    }
    if (!result.passwordFilled) forgetSecret(guest, credential.password);
    return result;
  }

  return { fillCredentialInGuest };
}
