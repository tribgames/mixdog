/**
 * Saved-login sign-in: when a page asks for a password and the Browser Use
 * profile holds a saved login for exactly that origin (HTTPS, no lookalikes:
 * profile-import.ts credentialSuggestions), the host signs in by itself with
 * the existing stored-credential fill (credential-autofill.ts), then submits.
 * The password goes into the page from this process only; the model, the
 * transcript and the logs see "signed in to <site>" and nothing more.
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

/** What the page shows: a sign-in password field, a challenge input or frame
 *  (one-time code, CAPTCHA), and challenge wording (2FA, passkey). */
const SIGN_IN_STATE = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  let password = false;
  let challenge = false;
  for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
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
      if (/captcha|turnstile|challenges\\.cloudflare/i.test(String(frame.src || ''))) challenge = true;
    }
  }
  const text = String(document.body?.innerText || '').slice(0, 20000);
  const wording = /captcha|passkey|two-factor|2-step|verification code|security code|인증 ?코드|보안 ?문자|패스키|2단계/i.test(text);
  return { password, challenge, wording };
})()`;

type SignInState = { password: boolean; challenge: boolean; wording: boolean };

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
    };
  };

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
    let filled = false;
    try {
      const result = await deps.withCredential(
        url,
        saved[0].id,
        (credential) => {
          if (guest.isDestroyed() || guest.getURL() !== url) {
            throw new Error('The page changed before stored credential input; input was not sent.');
          }
          return deps.fill(guest, credential, signal);
        },
        signal
      );
      filled = result.passwordFilled;
      if (filled) {
        deps.invalidate(guest);
        await deps.submit(guest, signal);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
    }
    const after = await input.observe();
    const now = filled ? await state(guest, signal).catch(() => null) : null;
    const signedIn = Boolean(now && !now.password && !now.challenge && !now.wording);
    const note = signedIn
      ? `${SAVED_SIGN_IN_DONE}${site} with its saved login (the password never left the host).`
      : `${SAVED_SIGN_IN_NEEDS_USER}${site}: one try with its saved login did not finish the sign-in ` +
        '(a code, CAPTCHA, passkey or an error). Do not retry; hand the sign-in to the user.';
    return { ...after, text: `${note}\n\n${after.text}` };
  }

  return { afterCommand };
}
