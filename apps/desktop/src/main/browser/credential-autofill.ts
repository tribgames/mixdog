import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { BrowserCredentialValue } from './profile-import';

export interface BrowserCredentialFillResult {
  usernameFilled: boolean;
  passwordFilled: boolean;
  /** page-changed: a login takeover's bound page left its address or origin
   *  before the login reached it (host-agent.ts fillBoundLogin). */
  reason?: 'no-password-field' | 'password-field-unavailable' | 'page-changed';
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
  // A sign-in's username-only first step (credential.usernameOnly): no
  // password field is wanted, and none is typed.
  const usernameOnly = credential?.usernameOnly === true;
  if (!passwordField && !usernameOnly) {
    return { usernameFilled: false, passwordFilled: false, reason: 'no-password-field' };
  }
  if (passwordField && usernameOnly) {
    return { usernameFilled: false, passwordFilled: false, reason: 'password-field-unavailable' };
  }
  const scope = passwordField && passwordField.form
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
      if (passwordField && element.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING) score += 15;
      return { element, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.element || null;

  const setValue = async (element, value) => {
    if (!element || typeof value !== 'string' || !value) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    element.focus();
    await Promise.resolve();
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      inputType: 'insertText',
      data: null,
    }));
    setter.call(element, value);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: null,
    }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value === value;
  };

  const usernameFilled = await setValue(usernameField, credential?.username);
  if (usernameOnly) {
    return { usernameFilled, passwordFilled: false, ...(usernameFilled ? {} : { reason: 'password-field-unavailable' }) };
  }
  const passwordFilled = await setValue(passwordField, credential?.password);
  return {
    usernameFilled,
    passwordFilled,
    ...(passwordFilled ? {} : { reason: 'password-field-unavailable' }),
  };
}`;

/** One element a secret fill writes, bound at request time: its CDP backend
 *  node id (the browser's own identity for that node) and its input type. */
export interface BrowserSecretTarget {
  node: number;
  type: string;
}

/** A secret's field as the page shows it (no value): its form (a sign-in
 *  with a username field, a lone or new password, a one-time code), for a
 *  code how many characters it takes, and the exact elements a fill will
 *  write with the main-frame document they belong to (inspectSecretField). */
export interface BrowserSecretFieldInfo {
  form: '' | 'login' | 'password' | 'new-password' | 'otp';
  length?: number;
  /** In order: the field, then its username, its confirmation, or one box
   *  per character of a split code. */
  targets?: BrowserSecretTarget[];
  /** The main frame's document at request time (mainDocumentOf). */
  document?: string;
}

export interface BrowserSecretFillResult {
  filled: boolean;
  usernameFilled?: boolean;
  /** A bound element is gone, in another document, hidden, disabled or of
   *  another type now: nothing was typed, and no other field was tried. */
  stale?: boolean;
}

const SECRET_FORMS: ReadonlySet<string> = new Set(['login', 'password', 'new-password', 'otp']);

/** A page that left the address or document a fill was bound to: nothing
 *  was sent to it. */
export class BrowserPageChangedError extends Error {
  constructor() {
    super('The page changed before stored credential input; input was not sent.');
    this.name = 'BrowserPageChangedError';
  }
}

/** Runs only in a CDP-created isolated world, at request time: which field a
 *  secret goes to — a one-time code (autocomplete one-time-code, a short
 *  numeric field, a code-named field or one box per digit), a new password
 *  (with its confirmation), or a password and its username (on a sign-in's
 *  username-only first step, `form: 'login'` binds the username alone).
 *  `hint` is the agent's field label, matched against the field's own names
 *  first; else the focused field, else the first of the requested kind.
 *  Answers the exact elements a fill will write, in order (null for none),
 *  carrying `form`, `types` (each one's input type) and, for a code,
 *  `codeLength`; the host binds their node ids (inspectSecretField). */
export const BROWSER_SECRET_FIELD_FUNCTION = String.raw`async function(request) {
  const inputs = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element instanceof HTMLInputElement) inputs.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  const visible = (element) => {
    if (!element || element.disabled || element.readOnly || element.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || (style.opacity !== '' && Number(style.opacity) === 0)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const tokens = (element) => String(element.autocomplete || element.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const type = (element) => String(element.type || 'text').toLowerCase();
  const identity = (element) => [
    element.name, element.id, element.placeholder, element.getAttribute('aria-label'),
    ...[...(element.labels || [])].map((label) => label.textContent),
  ].map((part) => String(part || '')).join(' ');
  const maxLength = (element) => (element.maxLength > 0 ? element.maxLength : 0);
  // A name split into lowercase words (camelCase, snake_case, kebab-case).
  const words = (value) => String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ');
  // Words that name a one-time code, never a bare "verif" or "code": a
  // verification_email, a promo or postal code is no code to type here.
  const CODE_WORDS = /\b(?:otp|totp|hotp|mfa|2fa|pass ?code|one ?time ?(?:code|pass(?:word|code)?|pin)|sms ?(?:code|token)|(?:verification|verify|auth|authentication|login|two ?factor|two ?step|2 ?step) ?code)\b/;
  const CODE_LABEL = /인증 ?(?:번호|코드)|일회용 ?(?:비밀번호|코드)/;
  const short = (element) => maxLength(element) === 1 || (maxLength(element) >= 4 && maxLength(element) <= 8);
  // Only explicit signals make a code field: autocomplete one-time-code, a
  // short numeric field (inputmode numeric or a digits pattern), or a name or
  // id that says so. Any other autocomplete purpose (email, tel, postal-code,
  // cc-csc, ...) is not a code.
  const kindOf = (element) => {
    const kind = type(element);
    if (kind === 'password') return tokens(element).includes('new-password') ? 'new-password' : 'password';
    if (!['text', 'tel', 'number', 'search'].includes(kind)) return '';
    if (tokens(element).includes('one-time-code')) return 'otp';
    if (tokens(element).some((token) => token !== 'on' && token !== 'off')) return '';
    if ([element.name, element.id].some((part) => CODE_WORDS.test(words(part)))) return 'otp';
    const numeric = String(element.inputMode || element.getAttribute('inputmode') || '').toLowerCase() === 'numeric'
      || /^\^?\[?(?:\\d|0-9)\]?[*+{]/.test(String(element.getAttribute('pattern') || ''));
    return numeric && short(element) ? 'otp' : '';
  };
  // The field the agent names (its label, name, id or placeholder): the
  // focused one among its matches, else the first in document order. It takes
  // a code only when it reads as one: one box or 4–8 characters long, or
  // labeled as a code; a generic text or email field it names is never a code
  // field.
  const hint = String(request?.hint || '').trim().toLowerCase();
  const named = hint
    ? inputs.filter((element) => visible(element) && ['text', 'tel', 'number', 'search', 'password'].includes(type(element))
      && identity(element).toLowerCase().includes(hint))
    : [];
  const hinted = named.find((element) => element === document.activeElement) || named[0] || null;
  const labelText = (element) => [
    element.placeholder, element.getAttribute('aria-label'), ...[...(element.labels || [])].map((label) => label.textContent),
  ].map((part) => String(part || '')).join(' ');
  const hintedCode = Boolean(hinted) && type(hinted) !== 'password' && !kindOf(hinted)
    && !tokens(hinted).some((token) => token !== 'on' && token !== 'off')
    && (short(hinted) || CODE_WORDS.test(words(labelText(hinted))) || CODE_LABEL.test(labelText(hinted)));
  const kindFor = (element) => kindOf(element) || (element === hinted && hintedCode ? 'otp' : '');
  const fields = inputs.filter((element) => visible(element) && kindFor(element));
  const wanted = request?.form === 'login' ? 'password' : String(request?.form || '');
  const active = document.activeElement instanceof HTMLInputElement && fields.includes(document.activeElement)
    ? document.activeElement : null;
  // Request time may rank: the named field, else the focused one, else the
  // first of the wanted kind. The choice is pinned to this document and to
  // these very elements (their node ids), so nothing is chosen at fill time.
  const pick = () => {
    const ordered = [hinted, active, ...fields].filter(Boolean);
    if (wanted) return ordered.find((element) => kindFor(element) === wanted) || null;
    if (hinted || active) return hinted || active;
    for (const kind of ['password', 'new-password', 'otp']) {
      const found = ordered.find((element) => kindFor(element) === kind);
      if (found) return found;
    }
    return null;
  };
  // The best username candidate of a form (or of the document).
  const usernameIn = (list) => list.filter((element) => visible(element) && ['text', 'email', 'tel'].includes(type(element)) && !kindOf(element))
    .sort((left, right) => {
      const score = (element) => (tokens(element).includes('username') ? 4 : 0) + (tokens(element).includes('email') ? 3 : 0)
        + (/(?:user|email|login|identifier|account|아이디)/i.test(identity(element)) ? 2 : 0);
      return score(right) - score(left);
    })[0] || null;
  const field = pick();
  if (!field) {
    // A sign-in's username-only first step (no password field on the page):
    // the username field alone, bound for this step.
    const first = request?.form === 'login' ? usernameIn(inputs) : null;
    return first ? Object.assign([first], { form: 'login', types: type(first) }) : null;
  }
  const kind = kindFor(field);
  const scope = field.form ? inputs.filter((element) => element.form === field.form) : inputs;
  // A code split into one box per character: its boxes, in order.
  const boxes = kind === 'otp' && maxLength(field) === 1
    ? scope.filter((element) => visible(element) && kindOf(element) === 'otp' && maxLength(element) === 1)
    : [field];
  const username = kind === 'password' ? usernameIn(scope) : null;
  // The exact elements a fill will write, in the order it writes them.
  const form = kind === 'password' && username ? 'login' : kind;
  const targets = form === 'login' ? [field, username]
    : kind === 'otp' && boxes.length > 1 ? boxes
    : kind === 'new-password' ? scope.filter((element) => visible(element) && kindOf(element) === 'new-password')
    : [field];
  const length = boxes.length > 1 ? boxes.length : maxLength(field);
  return Object.assign(targets, {
    form,
    types: targets.map(type).join(' '),
    ...(kind === 'otp' ? { codeLength: length >= 4 && length <= 10 ? length : 6 } : {}),
  });
}`;

/** Runs only in a CDP-created isolated world, at fill time: writes the value
 *  into exactly `targets`, the elements bound at request time (resolved from
 *  their node ids), in their order — a code's boxes one character each, a new
 *  password and its confirmation, a password then its username. Nothing is
 *  picked here: unless every target is still an input of this document,
 *  usable and of the type it had then (`request.types`), it answers stale
 *  and types nothing. */
export const BROWSER_SECRET_FILL_FUNCTION = String.raw`async function(request, ...targets) {
  const visible = (element) => {
    if (element.disabled || element.readOnly || element.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || (style.opacity !== '' && Number(style.opacity) === 0)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const type = (element) => String(element.type || 'text').toLowerCase();
  const types = String(request?.types || '').split(' ').filter(Boolean);
  const bound = targets.length > 0 && targets.length === types.length && targets.every((element, index) =>
    element instanceof HTMLInputElement && element.isConnected && element.ownerDocument === document
    && type(element) === types[index] && visible(element));
  if (!bound) return { filled: false, stale: true };
  const setValue = async (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!element || !setter || typeof value !== 'string' || !value) return false;
    element.focus();
    await Promise.resolve();
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: null }));
    setter.call(element, value);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value === value;
  };
  const value = String(request.value || '');
  if (request.form === 'otp' && targets.length > 1) {
    const chars = [...value];
    let all = chars.length === targets.length;
    for (const [index, box] of targets.entries()) all = (await setValue(box, chars[index] || '')) && all;
    return { filled: all };
  }
  if (request.form === 'new-password') {
    // The new password and its confirmation take the same value.
    let all = true;
    for (const target of targets) all = (await setValue(target, value)) && all;
    return { filled: all };
  }
  if (request.form !== 'login') return { filled: await setValue(targets[0], value) };
  const usernameFilled = request.username && targets[1] ? await setValue(targets[1], request.username) : false;
  return { filled: await setValue(targets[0], value), usernameFilled };
}`;

interface BrowserCredentialFillHost {
  cdp: BrowserCdpPort;
  /** Remember the password so replies redact it; returns the live secret set. */
  rememberSecret(guest: WebContents, secret: string): unknown;
  forgetSecret(guest: WebContents, secret: string): void;
  redactText(guest: WebContents, value: unknown): string;
  /** The elements a secret is about to be typed into (their backend node
   *  ids): captures are refused while they hold a value (visual-privacy.ts). */
  protectNodes?(guest: WebContents, nodes: number[]): void;
}

/** Fill a stored credential through an isolated world, so the page script
 *  never sees the values as source text or renderer IPC. */
export function createBrowserCredentialFill(host: BrowserCredentialFillHost) {
  const { cdp, rememberSecret, forgetSecret, redactText, protectNodes } = host;

  let objectGroups = 0;

  /** A fresh isolated world of the guest's main frame. `check` runs before
   *  every dispatch into it, the last one included, and refuses once the page
   *  left `bound.url` (the address the caller checked, before it read the
   *  vault, say; else its address now): nothing is sent to a page it went to
   *  meanwhile. With `bound.document` (or `pin`) the world is pinned to the
   *  main frame's document, as the browser reports it (mainDocumentOf): it
   *  must be `bound.document` when given, and still be the same once the
   *  world exists, so the world belongs to that document; a later navigation
   *  destroys the world, and every call into it fails. `run` calls a function
   *  there with CDP arguments, answering its value (or, not by value, the
   *  remote object it returned, held in this world's object group until
   *  `release`). */
  async function openIsolatedWorld(
    guest: WebContents,
    signal: AbortSignal | undefined,
    bound: { url?: string; document?: string; pin?: boolean } = {}
  ) {
    signal?.throwIfAborted();
    const url = bound.url || guest.getURL();
    const check = () => {
      signal?.throwIfAborted();
      if (guest.isDestroyed() || guest.getURL() !== url) throw new BrowserPageChangedError();
    };
    const dispatch = <R>(method: string, params: Record<string, unknown>): Promise<R> => {
      check();
      return cdp.call<R>(guest, method, params, signal, { beforeDispatch: check });
    };
    const readFrame = async () => {
      const tree = await dispatch<MainFrameTree>('Page.getFrameTree', {});
      return { frameId: String(tree.frameTree?.frame?.id || ''), document: mainDocumentOf(tree) };
    };
    const frame = await readFrame();
    if (!frame.frameId) throw new Error('The current page frame is unavailable.');
    const pinned = bound.pin === true || bound.document !== undefined;
    if (pinned && !frame.document) throw new Error('The current page document is unavailable.');
    if (bound.document !== undefined && frame.document !== bound.document) throw new BrowserPageChangedError();
    const world = await dispatch<{ executionContextId?: number }>('Page.createIsolatedWorld', {
      frameId: frame.frameId,
      worldName: 'mixdog-browser-credential-fill',
      grantUniveralAccess: false,
    });
    check();
    const contextId = world.executionContextId;
    if (!contextId) throw new Error('The secure credential fill context is unavailable.');
    /** Whether the main frame shows another document than the pinned one now. */
    const documentChanged = () =>
      readFrame().then(
        (now) => now.document !== frame.document,
        (error) => error instanceof BrowserPageChangedError
      );
    if (pinned && (await documentChanged())) throw new BrowserPageChangedError();
    const objectGroup = `mixdog-browser-credential-fill-${++objectGroups}`;
    const run = async <T>(functionDeclaration: string, args: unknown[], returnByValue = true) => {
      const response = await dispatch<{
        result?: { value?: T; objectId?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>('Runtime.callFunctionOn', {
        executionContextId: contextId,
        functionDeclaration,
        arguments: args,
        returnByValue,
        objectGroup,
        awaitPromise: true,
        userGesture: true,
      });
      signal?.throwIfAborted();
      if (response.exceptionDetails) {
        const detail =
          response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text ||
          'credential fill failed';
        throw new Error(redactText(guest, detail.split('\n')[0]));
      }
      return response.result;
    };
    return {
      contextId,
      objectGroup,
      document: frame.document,
      check,
      dispatch,
      run,
      /** A failure of a pinned world's call: a page change when its document
       *  is gone, else the failure itself. */
      async failure(error: unknown): Promise<unknown> {
        if (!pinned || signal?.aborted || error instanceof BrowserPageChangedError) return error;
        return (await documentChanged()) ? new BrowserPageChangedError() : error;
      },
      /** The world lets go of the page objects it held (no page data moves). */
      release(): void {
        void cdp.call(guest, 'Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
      },
    };
  }

  /** Auto sign-in and the agent's stored-login fill: the login form of the
   *  page as it is at fill time. `boundUrl`: the page address checked before
   *  the stored login was read; the fill is refused unless the page is still
   *  there (openIsolatedWorld). The login card's saved-login handoff binds
   *  its elements at request time instead (fillSecretField). */
  async function fillCredentialInGuest(
    guest: WebContents,
    credential: Readonly<BrowserCredentialValue>,
    signal?: AbortSignal,
    boundUrl = '',
    /** A sign-in's username-only first step: only the username is typed. */
    usernameOnly = false,
    /** The main-frame document (pageDocument) the step was bound to. */
    boundDocument?: string
  ): Promise<BrowserCredentialFillResult> {
    // The world is pinned to the main frame's document (frame id + loader id)
    // as it is looked up, and to `boundDocument` when the caller has one: a
    // same-address navigation in between sends nothing to the new document.
    const world = await openIsolatedWorld(guest, signal, { url: boundUrl, document: boundDocument, pin: true });
    if (credential.password) rememberSecret(guest, credential.password);
    let result: BrowserCredentialFillResult | undefined;
    try {
      result = (
        await world.run<BrowserCredentialFillResult>(BROWSER_CREDENTIAL_AUTOFILL_FUNCTION, [
          {
            value: {
              username: credential.username,
              password: usernameOnly ? '' : credential.password,
              ...(usernameOnly ? { usernameOnly: true } : {}),
            },
          },
        ])
      )?.value;
    } catch (error) {
      throw await world.failure(error);
    }
    if (!result || typeof result.passwordFilled !== 'boolean') {
      throw new Error('The secure credential fill returned an invalid result.');
    }
    if (!result.passwordFilled) forgetSecret(guest, credential.password);
    return result;
  }

  /** The guest's main-frame document as the browser reports it now
   *  (mainDocumentOf); '' when it reports none. */
  async function pageDocument(guest: WebContents, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return mainDocumentOf(await cdp.call<MainFrameTree>(guest, 'Page.getFrameTree', {}, signal));
  }

  /** Request time: which field a secret would go to on the guest's page, and
   *  the exact elements a fill will write (each one's CDP backend node id and
   *  type) with the document they belong to, for the fill to be bound to; no
   *  value moves. */
  async function inspectSecretField(
    guest: WebContents,
    request: { form?: string; hint?: string },
    signal?: AbortSignal
  ): Promise<BrowserSecretFieldInfo> {
    const world = await openIsolatedWorld(guest, signal, { pin: true });
    try {
      const picked = await world.run<unknown>(
        BROWSER_SECRET_FIELD_FUNCTION,
        [{ value: { form: request.form || '', hint: request.hint || '' } }],
        false
      );
      if (!picked?.objectId) return { form: '' };
      const { result: properties = [] } = await world.dispatch<{
        result?: Array<{ name: string; value?: { value?: unknown; objectId?: string } }>;
      }>('Runtime.getProperties', { objectId: picked.objectId, ownProperties: true });
      const own = (name: string) => properties.find((property) => property.name === name)?.value;
      const form = String(own('form')?.value || '');
      const types = String(own('types')?.value || '')
        .split(' ')
        .filter(Boolean);
      if (!SECRET_FORMS.has(form) || !types.length) return { form: '' };
      const targets: BrowserSecretTarget[] = [];
      for (const [index, type] of types.entries()) {
        const objectId = String(own(String(index))?.objectId || '');
        if (!objectId) return { form: '' };
        const described = await world.dispatch<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId });
        const node = Number(described.node?.backendNodeId) || 0;
        if (!node) return { form: '' };
        targets.push({ node, type });
      }
      const length = Number(own('codeLength')?.value) || 0;
      return {
        form: form as BrowserSecretFieldInfo['form'],
        ...(length ? { length } : {}),
        targets,
        document: world.document,
      };
    } finally {
      world.release();
    }
  }

  /** Fill a secret the user typed into exactly the elements bound at request
   *  time (`targets` of `document`, from inspectSecretField): an OTP, a new
   *  password, or a password with its username; registered for redaction.
   *  Another document throws BrowserPageChangedError before anything is sent;
   *  a target gone, or changed, answers stale with nothing typed — never
   *  another field. */
  async function fillSecretField(
    guest: WebContents,
    request: {
      form: string;
      value: string;
      username?: string;
      targets: BrowserSecretTarget[];
      document: string;
      /** The page address the caller checked (before it read the vault, say). */
      url?: string;
    },
    signal?: AbortSignal
  ): Promise<BrowserSecretFillResult> {
    const stale: BrowserSecretFillResult = { filled: false, stale: true };
    if (!request.document || !request.targets.length) return stale;
    const world = await openIsolatedWorld(guest, signal, { document: request.document, url: request.url });
    try {
      const elements: Array<{ objectId: string }> = [];
      for (const target of request.targets) {
        let objectId = '';
        try {
          const resolved = await world.dispatch<{ object?: { objectId?: string } }>('DOM.resolveNode', {
            backendNodeId: target.node,
            executionContextId: world.contextId,
            objectGroup: world.objectGroup,
          });
          objectId = String(resolved.object?.objectId || '');
        } catch (error) {
          // The node is gone, unless the page itself moved (said as such).
          const failure = await world.failure(error);
          if (failure instanceof BrowserPageChangedError || signal?.aborted) throw failure;
        }
        if (!objectId) return stale;
        elements.push({ objectId });
      }
      world.check();
      // Not a login's username, nor a username step: those are no secret.
      const secretNodes = request.targets
        .filter((_target, index) => request.form !== 'username' && !(request.form === 'login' && index > 0))
        .map((target) => target.node);
      if (secretNodes.length) protectNodes?.(guest, secretNodes);
      // A username is no secret: only passwords, codes and the like are registered.
      if (request.value && request.form !== 'username') rememberSecret(guest, request.value);
      let result: BrowserSecretFillResult | undefined;
      try {
        result = (
          await world.run<BrowserSecretFillResult>(BROWSER_SECRET_FILL_FUNCTION, [
            {
              value: {
                form: request.form,
                value: request.value,
                username: request.username || '',
                types: request.targets.map((target) => target.type).join(' '),
              },
            },
            ...elements,
          ])
        )?.value;
      } catch (error) {
        throw await world.failure(error);
      }
      if (!result || typeof result.filled !== 'boolean') {
        throw new Error('The secure credential fill returned an invalid result.');
      }
      if (!result.filled && request.form !== 'username') forgetSecret(guest, request.value);
      return result;
    } finally {
      world.release();
    }
  }

  return { fillCredentialInGuest, pageDocument, inspectSecretField, fillSecretField };
}

interface MainFrameTree {
  frameTree?: { frame?: { id?: string; loaderId?: string } };
}

/** The main frame's document as the browser reports it: the frame's id and
 *  the loader id of the document it shows, new for every document it loads
 *  (a reload of the same address included), like ref-upload.ts binds an
 *  upload to its frame's document. '' when either is not reported. */
function mainDocumentOf(tree: MainFrameTree): string {
  const frame = tree.frameTree?.frame;
  return frame?.id && frame.loaderId ? `${frame.id}:${frame.loaderId}` : '';
}
