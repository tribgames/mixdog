/**
 * Saved-login sign-in: when a page asks for a password and the Browser Use
 * profile holds a saved login for exactly that origin (HTTPS, no lookalikes:
 * profile-import.ts credentialSuggestions), the host signs in by itself with
 * the existing stored-credential fill (credential-autofill.ts), then submits.
 * The password goes into the page from this process only; the model, the
 * transcript and the logs see "signed in to <site>" and nothing more.
 *
 * Human check (best effort): a sign-in page often carries a Turnstile,
 * reCAPTCHA or hCaptcha widget that solves itself a few seconds after load.
 * Its token lands in a hidden response field and its frame may sit in a closed
 * shadow root, so the probe reads only light-DOM markers, hidden ones too, in
 * every frame and open shadow root, each element on its own: a response field
 * (cf-turnstile-response, g-recaptcha-response, h-captcha-response) that is
 * empty, or a provider container (.cf-turnstile, .g-recaptcha, .h-captcha)
 * with no filled field inside it, is pending. Nothing suppresses anything
 * else: an unresolved `execute`/invisible widget is pending too and ends in a
 * hand-off. A reCAPTCHA badge, a bare site key, a script and widget frames
 * are not evidence; a visible challenge frame (image grid, generic CAPTCHA)
 * is an immediate hand-off. The host fills only after the check holds its
 * token (the token is bound to the widget, not to the form values), waits at
 * most ~20 s, polling, and probes again right before the fill and right
 * before the submit, whatever the first probe saw. A page with no widget gets
 * a short grace to render one. A token that resets, a challenge that mounts,
 * or a widget that vanishes without a token means no submit and a hand-off.
 * Known misses: explicit render into an unmarked container with a custom
 * field name, and a widget that appears after the grace.
 *
 * Guardrails: on by the `browserAutoSignIn` setting (default on); one attempt
 * per site per turn (a routine run is one turn), never a retry loop; one
 * saved account only (several: the agent picks with `savedAccount`); a page
 * that already shows a challenge is left alone; a password field, 2FA code,
 * CAPTCHA or passkey step after the submit stops here and the reply hands the
 * sign-in to the user (the takeover card, or a routine's "sign-in required").
 * The submit is a sign-in, not an outbound action, so it needs no approval.
 */
import type { WebContents } from 'electron';

import type { BrowserCommandResult } from './command';
import { BROWSER_DOCUMENT_ROOTS } from './documents';
import type { BrowserCredentialFillResult } from './credential-autofill';
import type { BrowserCredentialValue } from './profile-import';
import { pause } from './settle';

/** What the page shows: a sign-in password field, a challenge input or frame
 *  (one-time code, an interactive CAPTCHA), challenge wording (2FA, passkey),
 *  and the human-check state: `pending` when any response field is empty or
 *  any provider container holds no filled field of its own, `solved` when
 *  such elements exist and none is pending, `none` without any. Each element
 *  is judged alone; the reCAPTCHA badge and its contents are skipped. */
export const SIGN_IN_STATE = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const TOKEN_FIELDS = 'input[name^="cf-turnstile-response"],input[name^="h-captcha-response"],textarea[name^="h-captcha-response"],input[name^="g-recaptcha-response"],textarea[name^="g-recaptcha-response"]';
  const WIDGET_BOXES = '.cf-turnstile,.g-recaptcha,.h-captcha';
  const WIDGET_FRAME = /turnstile|challenges\\.cloudflare|recaptcha|hcaptcha/i;
  const BADGE = '.grecaptcha-badge';
  const filled = (field) => String(field.value || '').trim() !== '';
  let password = false;
  let challenge = false;
  let found = false;
  let pending = false;
  for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
    for (const field of root.querySelectorAll(TOKEN_FIELDS)) {
      if (field.closest(BADGE)) continue;
      found = true;
      if (!filled(field)) pending = true;
    }
    for (const box of root.querySelectorAll(WIDGET_BOXES)) {
      if (box.closest(BADGE)) continue;
      found = true;
      // A badge's own field inside the box is not this widget's token.
      const own = Array.from(box.querySelectorAll(TOKEN_FIELDS)).filter((field) => !field.closest(BADGE));
      if (!own.some(filled)) pending = true;
    }
    for (const input of root.querySelectorAll('input')) {
      if (!visible(input) || input.disabled) continue;
      const type = String(input.type || '').toLowerCase();
      const complete = String(input.autocomplete || '').toLowerCase();
      if (type === 'password' && !complete.includes('new-password')) password = true;
      const identity = String(input.name || '') + ' ' + String(input.id || '');
      if (complete.includes('one-time-code') || /otp|totp|2fa|mfa|one.?time|verif\\w*.?code|auth\\w*.?code/i.test(identity)) {
        challenge = true;
      }
    }
    for (const frame of root.querySelectorAll('iframe')) {
      const src = String(frame.src || '');
      if (WIDGET_FRAME.test(src)) {
        // A widget's popup frame (image grid) needs a person; its anchor frame is no evidence.
        if (/bframe|frame=challenge/i.test(src) && visible(frame)) challenge = true;
      } else if (/captcha/i.test(src) && visible(frame)) challenge = true;
    }
  }
  const check = pending ? 'pending' : found ? 'solved' : 'none';
  const text = String(document.body?.innerText || '').slice(0, 20000);
  const wording = /captcha|passkey|two-factor|2-step|verification code|security code|인증 ?코드|보안 ?문자|패스키|2단계/i.test(text);
  return { password, challenge, wording, check };
})()`;

type HumanCheck = 'none' | 'pending' | 'solved';
type SignInState = { password: boolean; challenge: boolean; wording: boolean; check: HumanCheck };

/** How long a sign-in waits for a human check to solve itself, how long it
 *  looks for a late-rendered widget on a page with none, and how often it
 *  looks (one cheap probe per tick). */
const HUMAN_CHECK_WAIT_MS = 20_000;
const HUMAN_CHECK_GRACE_MS = 1_500;
const HUMAN_CHECK_POLL_MS = 500;

export interface BrowserAutoSignInDeps {
  /** The `browserAutoSignIn` setting. */
  enabled: () => boolean;
  /** Saved logins for exactly `url`'s HTTPS origin (masked labels only). */
  suggestions: (url: string) => Promise<Array<{ id: string; label: string }>>;
  /** Hands the stored login `id` for `url`'s origin to `use`, never anywhere else. */
  withCredential: <T>(
    url: string,
    id: string,
    use: (credential: Readonly<BrowserCredentialValue>) => Promise<T>,
    signal?: AbortSignal
  ) => Promise<T>;
  fill: (
    guest: WebContents,
    credential: Readonly<BrowserCredentialValue>,
    signal?: AbortSignal
  ) => Promise<BrowserCredentialFillResult>;
  submit: (guest: WebContents, signal?: AbortSignal) => Promise<void>;
  collect: <T>(guest: WebContents, expression: string, signal?: AbortSignal) => Promise<T[]>;
  invalidate: (guest: WebContents) => void;
  /** Bounds for the human-check wait (defaults: 20 s wait, 1.5 s grace for a
   *  late widget, polled every 500 ms). */
  humanCheck?: { waitMs?: number; graceMs?: number; pollMs?: number };
}

/** The reply line of a sign-in made with a saved login; the transcript shows
 *  it as "<site>에 저장된 로그인으로 로그인했습니다". */
export const SAVED_SIGN_IN_DONE = 'Saved sign-in: signed in to ';
/** The reply line of one that needs the user (routines fail as sign-in required). */
export const SAVED_SIGN_IN_NEEDS_USER = 'Saved sign-in: the site still needs the user at ';

const ATTEMPT_MEMORY = 500;

export function createBrowserAutoSignIn(deps: BrowserAutoSignInDeps) {
  /** `${sessionId}\0${turnId}\0${origin}`: tried once this turn. */
  const attempted = new Set<string>();
  const state = async (guest: WebContents, signal?: AbortSignal): Promise<SignInState> => {
    const frames = await deps.collect<SignInState>(guest, SIGN_IN_STATE, signal);
    return {
      password: frames.some((frame) => frame?.password === true),
      challenge: frames.some((frame) => frame?.challenge === true),
      wording: frames.some((frame) => frame?.wording === true),
      // Any unsolved widget in any frame holds the whole page.
      check: frames.some((frame) => frame?.check === 'pending')
        ? 'pending'
        : frames.some((frame) => frame?.check === 'solved')
          ? 'solved'
          : 'none',
    };
  };

  /** Whether the sign-in may go on after this probe: the form is still there,
   *  no challenge stands, and any human check seen on this attempt holds its
   *  token (a widget that vanished without one is not a success). */
  const mayGoOn = (now: SignInState, seen: { check: boolean }): boolean => {
    if (now.check !== 'none') seen.check = true;
    return now.password && !now.challenge && now.check !== 'pending' && (!seen.check || now.check === 'solved');
  };

  /** Waits for the page's human check: up to the wait bound while a token is
   *  missing, or a short grace for a late-rendered widget when none is there
   *  yet. False when it never finishes, vanishes without a token, a challenge
   *  appears or the form is gone; a cancelled command throws. */
  async function humanCheckCleared(
    guest: WebContents,
    signal: AbortSignal | undefined,
    first: HumanCheck,
    seen: { check: boolean }
  ): Promise<boolean> {
    if (first === 'solved') return true;
    const waitMs = deps.humanCheck?.waitMs ?? HUMAN_CHECK_WAIT_MS;
    const graceMs = deps.humanCheck?.graceMs ?? HUMAN_CHECK_GRACE_MS;
    const pollMs = deps.humanCheck?.pollMs ?? HUMAN_CHECK_POLL_MS;
    let deadline = Date.now() + (first === 'pending' ? waitMs : graceMs);
    for (;;) {
      await pause(pollMs, signal);
      if (guest.isDestroyed()) return false;
      const now = await state(guest, signal);
      if (!now.password || now.challenge) return false;
      if (now.check === 'solved') {
        seen.check = true;
        return true;
      }
      if (now.check === 'pending' && !seen.check) {
        // A widget rendered during the grace: from here on it needs its token.
        seen.check = true;
        deadline = Date.now() + waitMs;
      } else if (now.check === 'none' && seen.check) return false;
      if (Date.now() >= deadline) return !seen.check;
    }
  }

  /** After one agent command: sign in when the page asks for it and a saved
   *  login fits; returns the reply to send instead, or null to keep `result`. */
  async function afterCommand(input: {
    guest: WebContents;
    sessionId: string;
    turnId: number;
    signal?: AbortSignal;
    /** A fresh settled observation of the page. */
    observe: () => Promise<BrowserCommandResult>;
  }): Promise<BrowserCommandResult | null> {
    const { guest, signal } = input;
    if (!deps.enabled() || guest.isDestroyed()) return null;
    const url = guest.getURL();
    let origin = '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') origin = parsed.origin;
    } catch {}
    if (!origin) return null;
    const key = `${input.sessionId}\0${input.turnId}\0${origin}`;
    if (attempted.has(key)) return null;
    const before = await state(guest, signal);
    if (!before.password || before.challenge) return null;
    const saved = await deps.suggestions(url);
    // One account only: several are the agent's choice (fill savedAccount).
    if (!saved.length || new Set(saved.map((entry) => entry.label)).size !== 1) return null;
    attempted.add(key);
    if (attempted.size > ATTEMPT_MEMORY) attempted.delete(attempted.values().next().value as string);
    const site = new URL(origin).host;
    let submitted = false;
    const seen = { check: before.check !== 'none' };
    try {
      // The password stays on the host until the page's human check has its token.
      if (!(await humanCheckCleared(guest, signal, before.check, seen))) {
        throw new Error('The human check did not finish; nothing was sent.');
      }
      const result = await deps.withCredential(
        url,
        saved[0].id,
        async (credential) => {
          // Last awaited step: the page may have changed state since the wait.
          if (!mayGoOn(await state(guest, signal), seen)) {
            throw new Error('The human check changed before stored credential input; input was not sent.');
          }
          // Nothing is awaited between this check and the fill call.
          if (signal?.aborted || guest.isDestroyed() || guest.getURL() !== url) {
            throw new Error('The page changed before stored credential input; input was not sent.');
          }
          return deps.fill(guest, credential, signal);
        },
        signal
      );
      if (result.passwordFilled) {
        deps.invalidate(guest);
        // The fill itself may have reset the token or mounted a challenge.
        if (!mayGoOn(await state(guest, signal), seen) || guest.isDestroyed() || guest.getURL() !== url) {
          throw new Error('The human check changed before the submit; nothing was submitted.');
        }
        submitted = true;
        await deps.submit(guest, signal);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
    }
    const after = await input.observe();
    const now = submitted ? await state(guest, signal).catch(() => null) : null;
    const signedIn = Boolean(now && !now.password && !now.challenge && !now.wording);
    const note = signedIn
      ? `${SAVED_SIGN_IN_DONE}${site} with its saved login (the password never left the host).`
      : `${SAVED_SIGN_IN_NEEDS_USER}${site}: one try with its saved login did not finish the sign-in ` +
        '(a human check that did not finish, a code, CAPTCHA, passkey or an error). Do not retry; hand the sign-in to the user.';
    return { ...after, text: `${note}\n\n${after.text}` };
  }

  return { afterCommand };
}
