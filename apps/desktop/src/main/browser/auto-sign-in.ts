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
 * Steps: a sign-in page with a password field is filled and submitted; a page
 * that shows only a username/email field (on a page that says sign-in, with
 * that one text field alone) gets the username, Enter, and then, once the
 * next page shows its password field, the password and Enter. When the step
 * after the password shows a one-time-code field (one input or one box per
 * digit) and the vault holds an authenticator key for the account, the host
 * makes the current code, types it into that field and presses Enter. All of
 * it is one attempt of at most three steps (username, password, code); the
 * code is a secret like the password and never reaches the model.
 *
 * The answer: many sites submit through their own script (an encrypted form,
 * a key fetch) and answer with a redirect chain, so a page right after Enter
 * still shows the filled form. After the password (and after the code) the
 * host waits for the site's answer, up to ~15 s, polling: it ends at once on
 * a challenge or the next step's field, on a sign-in error the page did not
 * show before the submit, or on the form sent back as a new document, and
 * once the page has left the sign-in form (at a new address, or the same
 * formless page on two readings), nothing loading. Signed in means that page
 * holds no sign-in form, code field or challenge, and no challenge wording
 * where its address still says sign-in (an account page may well mention
 * 2-step or passkeys). The reply's snapshot is taken of that page.
 *
 * Accounts: with several saved logins for the site the host uses the one whose
 * username is the identifier already prefilled on the page, else the one last
 * used for the site, else the most recently saved. When that identifier fits
 * several logins that differ only by username case and none exactly, none is
 * guessed: nothing is filled and the sign-in is handed to the user. The agent's
 * explicit `savedAccount` fill is a separate path and always wins. A successful
 * sign-in records the account as last used (vault metadata, never a secret).
 *
 * Guardrails: on by the `browserAutoSignIn` setting (default on); HTTPS only;
 * one attempt per site per turn (a routine run is one turn), never a retry
 * loop; a page that already shows a challenge is left alone; a CAPTCHA, a
 * passkey, an SMS or email code, a code without a stored key, or any step
 * that does not finish stops here and the reply hands the sign-in to the user
 * (the takeover card, or a routine's "sign-in required"). Every fill and
 * submit re-checks the page address first. The submit follows the bot's
 * browser approval policy (`approveSubmit`) with the saved login as the
 * user's consent: a policy that would only ask lets it through, a block (or a
 * denied action) sends nothing and hands the sign-in to the user.
 */
import type { WebContents } from 'electron';

import type { BrowserCommandResult } from './command';
import { BROWSER_DOCUMENT_ROOTS } from './documents';
import type { BrowserCredentialFillResult } from './credential-autofill';
import type { VaultSignInAccount } from './credential-vault';
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
  const TEXT_LIKE = ['text', 'email', 'tel', 'search', 'url', 'number'];
  const IDENTIFIER = /^(?:user(?:_?name)?|user_?id|login(?:_?id)?|identifier(?:id)?|loginfmt|j_username|email(?:_?address)?|account|아이디)$/i;
  let password = false;
  let challenge = false;
  let code = false;
  let captcha = false;
  let found = false;
  let pending = false;
  let editable = 0;
  const candidates = [];
  let digitBoxes = 0;
  let invalid = false;
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
      if (String(input.getAttribute('aria-invalid') || '').toLowerCase() === 'true') invalid = true;
      const identity = String(input.name || '') + ' ' + String(input.id || '');
      if (complete.includes('one-time-code') || /otp|totp|2fa|mfa|one.?time|verif\\w*.?code|auth\\w*.?code/i.test(identity)) {
        challenge = true;
        code = true;
      }
      // One box per digit of a code.
      if (input.maxLength === 1 && String(input.inputMode || '').toLowerCase() === 'numeric') digitBoxes += 1;
      if (!input.readOnly && TEXT_LIKE.includes(type)) {
        editable += 1;
        if (['email', 'text', 'tel'].includes(type)
          && (/\\b(?:username|email)\\b/.test(complete) || IDENTIFIER.test(String(input.name || '')) || IDENTIFIER.test(String(input.id || '')))) {
          candidates.push(input);
        }
      }
    }
    for (const frame of root.querySelectorAll('iframe')) {
      const src = String(frame.src || '');
      if (WIDGET_FRAME.test(src)) {
        // A widget's popup frame (image grid) needs a person; its anchor frame is no evidence.
        if (/bframe|frame=challenge/i.test(src) && visible(frame)) challenge = captcha = true;
      } else if (/captcha/i.test(src) && visible(frame)) challenge = captcha = true;
    }
  }
  if (digitBoxes >= 4) {
    challenge = true;
    code = true;
  }
  // A username-only first step: no password field, and one text field alone
  // on the page that is a username/email field with real sign-in evidence:
  // autocomplete "username", or an email/text field whose own form says
  // sign in (its controls, headings, id/action) or whose page does (URL path,
  // title, headings) — and a form that says subscribe/sign up never. An email
  // field alone (autocomplete "email", a newsletter box) is no evidence.
  const SIGN_IN_WORDS = /sign.?in|log.?in|log.?on|sign.?on|로그인|ログイン|登录|登入/i;
  const NOT_SIGN_IN = /subscri|newsletter|sign.?up|register|join|구독|뉴스레터|가입/i;
  const words = (nodes) => Array.from(nodes).map((node) => String(node.value || node.textContent || '')).join(' ');
  let username = false;
  if (!password && !code && editable === 1 && candidates.length === 1) {
    const field = candidates[0];
    const explicit = /\\busername\\b/.test(String(field.autocomplete || '').toLowerCase());
    const form = field.form;
    const formText = form
      ? words(form.querySelectorAll('button,input[type=submit],input[type=button],[role=button],legend,h1,h2,h3,label'))
        + ' ' + [form.id, form.getAttribute('action'), form.getAttribute('aria-label')].join(' ')
      : '';
    const pageText = location.pathname + ' ' + document.title + ' ' + words(document.querySelectorAll('h1,h2'));
    // A form that says subscribe or sign up never qualifies, whatever else it carries.
    username = !NOT_SIGN_IN.test(formText) && (explicit || SIGN_IN_WORDS.test(formText) || SIGN_IN_WORDS.test(pageText));
  }
  const identifier = String((candidates.find((input) => String(input.value || '').trim()) || {}).value || '').trim();
  const check = pending ? 'pending' : found ? 'solved' : 'none';
  const text = String(document.body?.innerText || '').slice(0, 20000);
  const wording = /captcha|passkey|two-factor|2-step|verification code|security code|인증 ?코드|보안 ?문자|패스키|2단계/i.test(text);
  // A code the site sends by SMS or email is no authenticator code.
  const sent = /sms|text message|texted|emailed|sent (?:a|the|you)[^.]{0,40}code|문자|이메일로/i.test(text)
    && !/authenticator|authentication app|인증 ?앱/i.test(text);
  // A refused sign-in: a field the page marks invalid, or the words of a
  // refused password. The host compares it with the page before the submit.
  const error = invalid
    || /incorrect|invalid (?:password|user|e-?mail|credential|login)|wrong (?:password|user|e-?mail)|(?:does not|doesn.t|did not|didn.t) match|(?:could not|couldn.t|cannot|can.t|unable to) (?:sign|log) (?:you )?in|try again|잘못 입력|일치하지 않|올바르지 않|다시 (?:입력|시도)|正しくありません|错误|錯誤/i.test(text);
  return { password, challenge, wording, check, code, captcha, username, identifier, sent, error };
})()`;

type HumanCheck = 'none' | 'pending' | 'solved';
type SignInState = {
  password: boolean;
  /** A code field or a CAPTCHA/challenge frame: the user's step. */
  challenge: boolean;
  wording: boolean;
  check: HumanCheck;
  /** A one-time-code field (single or one box per digit). */
  code: boolean;
  /** A challenge frame (image grid, generic CAPTCHA). */
  captcha: boolean;
  /** A username-only first step. */
  username: boolean;
  /** An identifier already prefilled in the page's username field. */
  identifier: string;
  /** The page says the code comes by SMS or email. */
  sent: boolean;
  /** A field marked invalid, or the words of a refused sign-in. */
  error: boolean;
};
type Phase = 'username' | 'password' | 'code';
type Reading = { now: SignInState; document: string };

/** How long a sign-in waits for a human check to solve itself, how long it
 *  looks for a late-rendered widget on a page with none, and how often it
 *  looks (one cheap probe per tick). */
const HUMAN_CHECK_WAIT_MS = 20_000;
const HUMAN_CHECK_GRACE_MS = 1_500;
const HUMAN_CHECK_POLL_MS = 500;
/** How long the next step's page gets to show its field after a submit. */
const STEP_WAIT_MS = 8_000;
/** How long a submitted password or code gets for the site's answer: its own
 *  script and redirect chain take seconds before the next page shows. */
const SUBMIT_WAIT_MS = 15_000;
/** Readings in a row of the same formless page, at the address the step was
 *  submitted on, before that page counts as the answer. */
const SETTLED_READINGS = 2;
/** An address that still says sign-in, verification or a challenge. */
const SIGN_IN_ADDRESS =
  /log[-_.]?[io]n|sign[-_.]?[io]n|auth|sso|session|challenge|verif|two[-_]?factor|2fa|mfa|passkey|webauthn/i;

function signInAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SIGN_IN_ADDRESS.test(parsed.hostname + parsed.pathname);
  } catch {
    return true;
  }
}

/** Whether `now`, read at `url` after the last submit, shows the sign-in done. */
const signedInOn = (now: SignInState, url: string): boolean =>
  !now.password && !now.username && !now.challenge && !(now.wording && signInAddress(url));

export interface BrowserAutoSignInDeps {
  /** The `browserAutoSignIn` setting. */
  enabled: () => boolean;
  /** Saved logins for exactly `url`'s HTTPS origin (masked labels only), the
   *  one to use first: the account whose username is the identifier already
   *  `prefilled` on the page, then the one last used for the site, then the
   *  most recently saved (credential-vault.ts preferredAccountsFor). A head
   *  marked `ambiguous` is not a choice: the identifier fits several logins
   *  that differ only by case, and the sign-in is handed to the user. */
  suggestions: (url: string, prefilled?: string) => Promise<VaultSignInAccount[]>;
  /** Hands the stored login `id` for `url`'s origin to `use`, never anywhere else. */
  withCredential: <T>(
    url: string,
    id: string,
    use: (credential: Readonly<BrowserCredentialValue>) => Promise<T>,
    signal?: AbortSignal
  ) => Promise<T>;
  /** Fills the page's sign-in form; `step: 'username'` types the username
   *  alone into a username-only first step (the password is not passed). */
  fill: (
    guest: WebContents,
    credential: Readonly<BrowserCredentialValue>,
    signal?: AbortSignal,
    step?: 'username',
    /** The main-frame document the step was read on (document): the fill is
     *  refused unless the page still shows exactly that document. */
    document?: string
  ) => Promise<BrowserCredentialFillResult>;
  /** The page's main-frame document now (frame id + loader id; '' when the
   *  browser reports none). Every step is bound to the document its state was
   *  read on. */
  document?: (guest: WebContents, signal?: AbortSignal) => Promise<string>;
  /** `beforeDispatch` runs right before the key is sent and throws when the
   *  page is no longer the one the sign-in was checked on. */
  submit: (guest: WebContents, signal?: AbortSignal, beforeDispatch?: () => void) => Promise<void>;
  /** The bot's browser approval policy for the sign-in submit (a form submit):
   *  resolves when it may go, throws (never dispatched) when a bot blocks it.
   *  Saving the login is the user's consent, so a policy that would only ask
   *  lets it through. Absent only on older wiring, where the submit is sent
   *  without asking. */
  approveSubmit?: (guest: WebContents, signal?: AbortSignal) => Promise<void>;
  /** The saved login `id` signed in: remembered as the site's last used
   *  account (metadata, never the secret). */
  recordUsed?: (url: string, id: string) => Promise<void>;
  /** One-time codes from the stored authenticator key of login `id`:
   *  `value` makes the current code on the host ('' without a key), `fill`
   *  binds the code field of the page and types it (false: no code field).
   *  The code is a secret like the password and goes nowhere else. */
  code?: {
    value: (url: string, id: string) => Promise<string>;
    fill: (
      guest: WebContents,
      code: string,
      signal?: AbortSignal,
      boundUrl?: string,
      document?: string
    ) => Promise<boolean>;
  };
  collect: <T>(guest: WebContents, expression: string, signal?: AbortSignal) => Promise<T[]>;
  invalidate: (guest: WebContents) => void;
  /** Bounds for the human-check wait (defaults: 20 s wait, 1.5 s grace for a
   *  late widget, polled every 500 ms), for the next step's page to show its
   *  field after a submit (default 8 s) and for the site's answer to a
   *  submitted password or code (default 15 s). */
  humanCheck?: { waitMs?: number; graceMs?: number; pollMs?: number; stepMs?: number; submitMs?: number };
}

/** The reply line of a sign-in made with a saved login; the transcript shows
 *  it as "<site>에 저장된 로그인으로 로그인했습니다". */
export const SAVED_SIGN_IN_DONE = 'Saved sign-in: signed in to ';
/** The reply line of one that needs the user (routines fail as sign-in required). */
export const SAVED_SIGN_IN_NEEDS_USER = 'Saved sign-in: the site still needs the user at ';

const ATTEMPT_MEMORY = 500;
/** The username step, the password step and the code step: no more in one attempt. */
const MAX_STEPS = 3;

/** The page guard of a submit: throws once the guest is gone or left `url`. */
function submitGuard(guest: WebContents, url: string): () => void {
  return () => {
    if (guest.isDestroyed() || guest.getURL() !== url) {
      throw new Error('The page changed before the submit; nothing was submitted.');
    }
  };
}

/** Whether the form of `phase` is on the page. */
const formThere = (now: SignInState, phase: Phase): boolean => {
  if (phase === 'username') return now.username && !now.password;
  if (phase === 'code') return now.code && !now.password;
  return now.password;
};
/** Whether a challenge stands in the way of `phase` (a code is the code step's own field). */
const challenged = (now: SignInState, phase: Phase): boolean => (phase === 'code' ? now.captcha : now.challenge);

export function createBrowserAutoSignIn(deps: BrowserAutoSignInDeps) {
  /** `${sessionId}\0${turnId}\0${origin}`: tried once this turn. */
  const attempted = new Set<string>();
  const state = async (guest: WebContents, signal?: AbortSignal): Promise<SignInState> => {
    const frames = await deps.collect<SignInState>(guest, SIGN_IN_STATE, signal);
    const any = (key: 'password' | 'challenge' | 'wording' | 'code' | 'captcha' | 'username' | 'sent' | 'error') =>
      frames.some((frame) => frame?.[key] === true);
    // Any unsolved widget in any frame holds the whole page.
    const checkOf = (): SignInState['check'] => {
      if (frames.some((frame) => frame?.check === 'pending')) return 'pending';
      if (frames.some((frame) => frame?.check === 'solved')) return 'solved';
      return 'none';
    };
    return {
      password: any('password'),
      challenge: any('challenge'),
      wording: any('wording'),
      code: any('code'),
      captcha: any('captcha'),
      username: any('username'),
      sent: any('sent'),
      error: any('error'),
      identifier: String(
        frames.find((frame) => typeof frame?.identifier === 'string' && frame.identifier)?.identifier || ''
      ),
      check: checkOf(),
    };
  };

  /** The main-frame document now; '' when unavailable. */
  const documentOf = async (guest: WebContents, signal?: AbortSignal): Promise<string> =>
    deps.document ? deps.document(guest, signal).catch(() => '') : '';

  /** The page state together with the document it was read on: the document
   *  is read before and after, and a page that moved in between is no reading
   *  (null), as is one whose document the browser does not report. */
  const read = async (guest: WebContents, signal?: AbortSignal): Promise<Reading | null> => {
    const first = await documentOf(guest, signal);
    const now = await state(guest, signal);
    const second = await documentOf(guest, signal);
    if (first !== second || (deps.document && !first)) return null;
    return { now, document: first };
  };

  /** A reading while the page may be moving: a probe whose document went
   *  away mid-read (a redirect) is no reading this time. A cancelled command
   *  still throws. */
  const readMoving = async (guest: WebContents, signal?: AbortSignal): Promise<Reading | null> => {
    try {
      return await read(guest, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      return null;
    }
  };

  /** Whether the sign-in may go on after this probe: the step's form is still
   *  there, no challenge stands, and any human check seen on this attempt holds
   *  its token (a widget that vanished without one is not a success). */
  const mayGoOn = (now: SignInState, seen: { check: boolean }, phase: Phase): boolean => {
    if (now.check !== 'none') seen.check = true;
    return (
      formThere(now, phase) &&
      !challenged(now, phase) &&
      now.check !== 'pending' &&
      (!seen.check || now.check === 'solved')
    );
  };

  /** Waits for the page's human check: up to the wait bound while a token is
   *  missing, or a short grace for a late-rendered widget when none is there
   *  yet. False when it never finishes, vanishes without a token, a challenge
   *  appears or the form is gone; a cancelled command throws. */
  async function humanCheckCleared(
    guest: WebContents,
    signal: AbortSignal | undefined,
    first: HumanCheck,
    seen: { check: boolean },
    phase: Phase
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
      if (!formThere(now, phase) || challenged(now, phase)) return false;
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

  /** Waits for the sign-in's next page to show its password field. */
  async function passwordShown(guest: WebContents, signal: AbortSignal | undefined): Promise<Reading | null> {
    const pollMs = deps.humanCheck?.pollMs ?? HUMAN_CHECK_POLL_MS;
    const deadline = Date.now() + (deps.humanCheck?.stepMs ?? STEP_WAIT_MS);
    for (;;) {
      if (guest.isDestroyed()) return null;
      const reading = await readMoving(guest, signal);
      if (reading?.now.challenge) return null;
      if (reading?.now.password) return reading;
      if (Date.now() >= deadline) return null;
      await pause(pollMs, signal);
    }
  }

  /** Waits for the site's answer to a submitted password or code, up to the
   *  bound while the step's own form stands unanswered. It ends at once on a
   *  challenge or another step's field, on an error the page did not show
   *  before the submit, or on the form sent back as a new document; and once
   *  the page has left the form with nothing loading: at a new address at
   *  once, at the submitted one after the same formless document reads so
   *  again. The last reading, or null without any. */
  async function submitAnswered(
    guest: WebContents,
    signal: AbortSignal | undefined,
    phase: Phase,
    submitted: { url: string; document: string; error: boolean }
  ): Promise<Reading | null> {
    const pollMs = deps.humanCheck?.pollMs ?? HUMAN_CHECK_POLL_MS;
    const deadline = Date.now() + (deps.humanCheck?.submitMs ?? SUBMIT_WAIT_MS);
    let last: Reading | null = null;
    let quiet = { document: '', count: 0 };
    for (;;) {
      if (guest.isDestroyed()) return null;
      const reading = await readMoving(guest, signal);
      if (reading) {
        last = reading;
        const { now, document } = reading;
        const loading = guest.isLoading();
        if (formThere(now, phase)) {
          quiet = { document: '', count: 0 };
          if (challenged(now, phase) || (now.error && !submitted.error)) return reading;
          if (document !== submitted.document && !loading) return reading;
        } else if (now.password || now.username || now.challenge) {
          return reading;
        } else if (loading) {
          quiet = { document: '', count: 0 };
        } else {
          quiet = { document, count: quiet.document === document ? quiet.count + 1 : 1 };
          if (guest.getURL() !== submitted.url || quiet.count >= SETTLED_READINGS) return reading;
        }
      }
      if (Date.now() >= deadline) return last;
      await pause(pollMs, signal);
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
    const startUrl = guest.getURL();
    let origin = '';
    try {
      const parsed = new URL(startUrl);
      if (parsed.protocol === 'https:') origin = parsed.origin;
    } catch {
      // An unparseable address has no origin; handled just below.
    }
    if (!origin) return null;
    const key = `${input.sessionId}\0${input.turnId}\0${origin}`;
    if (attempted.has(key)) return null;
    const initial = await read(guest, signal);
    if (!initial) return null;
    const before = initial.now;
    let first: Phase | null = null;
    if (before.password) first = 'password';
    else if (before.username) first = 'username';
    if (!first || before.challenge) return null;
    // An unreadable vault only means no saved login can be used: the page the
    // command opened stays as it is, and the sign-in is left to the user.
    let saved: VaultSignInAccount[];
    try {
      saved = await deps.suggestions(startUrl, before.identifier);
    } catch {
      return null;
    }
    if (!saved.length) return null;
    attempted.add(key);
    if (attempted.size > ATTEMPT_MEMORY) attempted.delete(attempted.values().next().value as string);
    const site = new URL(origin).host;
    // The page's identifier fits several saved logins that differ only by
    // username case and none exactly: no account is guessed, nothing is filled.
    if (saved[0].ambiguous) {
      const page = await input.observe();
      return {
        ...page,
        text:
          `${SAVED_SIGN_IN_NEEDS_USER}${site}: the identifier on the page fits several of its saved logins that differ ` +
          `only by letter case, so none was chosen and nothing was filled. Do not retry; hand the sign-in to the user.\n\n${page.text}`,
      };
    }
    // Several accounts: the vault's order already put the right one first.
    const account = saved[0].id;
    /** The site's answer to the last submitted password or code (`outcome`,
     *  read at `url`), and that step: its phase and what it was submitted on. */
    const attempt: {
      outcome: Reading | null;
      url: string;
      last: { phase: Phase; submitted: { url: string; document: string; error: boolean } } | null;
      steps: number;
    } = { outcome: null, url: '', last: null, steps: 0 };
    /** After the password: a code field, with an authenticator key to answer
     *  it, is one more step; anything else ends the attempt. */
    const codeStep = (next: Reading): boolean =>
      Boolean(deps.code && next.now.code && !next.now.captcha && !next.now.password && !next.now.sent);
    const onOrigin = (url: string): boolean => {
      try {
        const parsed = new URL(url);
        return parsed.origin === origin && parsed.protocol === 'https:';
      } catch {
        return false;
      }
    };

    /** One step on `url`: wait out its human check, give the page this
     *  step's secret and press Enter. The page as it stood right before the
     *  submit, or null when there was nothing to send. */
    const step = async (
      phase: Phase,
      url: string,
      now: SignInState,
      bound: string,
      twoStep: boolean
    ): Promise<SignInState | null> => {
      const seen = { check: now.check !== 'none' };
      const guardPage = (message: string) => {
        if (signal?.aborted || guest.isDestroyed() || guest.getURL() !== url) throw new Error(message);
      };
      // The secret stays on the host until the page's human check has its token.
      if (!(await humanCheckCleared(guest, signal, now.check, seen, phase))) {
        throw new Error('The human check did not finish; nothing was sent.');
      }
      let filled: boolean;
      if (phase === 'code') {
        const code = deps.code ? await deps.code.value(url, account) : '';
        // No stored key: the code is the user's.
        if (!code) return null;
        if (!mayGoOn(await state(guest, signal), seen, phase)) {
          throw new Error('The human check changed before stored credential input; input was not sent.');
        }
        guardPage('The page changed before stored credential input; input was not sent.');
        filled = await deps.code!.fill(guest, code, signal, url, bound || undefined);
      } else {
        const result = await deps.withCredential(
          url,
          account,
          async (credential) => {
            // Last awaited step: the page may have changed state since the wait.
            if (!mayGoOn(await state(guest, signal), seen, phase)) {
              throw new Error('The human check changed before stored credential input; input was not sent.');
            }
            // Nothing is awaited between this check and the fill call.
            guardPage('The page changed before stored credential input; input was not sent.');
            if (phase === 'username') {
              return deps.fill(
                guest,
                { username: credential.username, password: '' },
                signal,
                'username',
                bound || undefined
              );
            }
            return deps.fill(
              guest,
              twoStep ? { username: '', password: credential.password } : credential,
              signal,
              undefined,
              bound || undefined
            );
          },
          signal
        );
        filled = phase === 'username' ? result.usernameFilled : result.passwordFilled;
      }
      if (!filled) return null;
      deps.invalidate(guest);
      // The fill itself may have reset the token or mounted a challenge.
      const ready = await state(guest, signal);
      if (!mayGoOn(ready, seen, phase) || guest.isDestroyed() || guest.getURL() !== url) {
        throw new Error('The human check changed before the submit; nothing was submitted.');
      }
      // The submit is a form submit: it follows the bot's approval policy, and
      // a block hands the sign-in to the user like any other.
      if (deps.approveSubmit) await deps.approveSubmit(guest, signal);
      guardPage('The page changed before the submit; nothing was submitted.');
      await deps.submit(guest, signal, submitGuard(guest, url));
      return ready;
    };

    /** The steps from `start`, on the page `now` and `bound` read at `url`;
     *  all of them count toward the attempt's bound. */
    const runSteps = async (start: Phase, startAt: string, startNow: SignInState, startBound: string) => {
      let phase = start;
      let url = startAt;
      let now = startNow;
      let bound = startBound;
      try {
        while (attempt.steps < MAX_STEPS) {
          attempt.steps += 1;
          const ready = await step(phase, url, now, bound, first === 'username');
          if (!ready) return;
          let next: Reading | null;
          if (phase === 'username') next = await passwordShown(guest, signal);
          else {
            attempt.last = { phase, submitted: { url, document: bound, error: ready.error } };
            next = attempt.outcome = await submitAnswered(guest, signal, phase, attempt.last.submitted);
            attempt.url = guest.getURL();
          }
          if (!next || phase === 'code') return;
          if (phase === 'username') phase = 'password';
          else if (codeStep(next)) phase = 'code';
          else return;
          const nextUrl = guest.getURL();
          if (!onOrigin(nextUrl)) return;
          url = nextUrl;
          now = next.now;
          bound = next.document;
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
      }
    };

    await runSteps(first, startUrl, before, initial.document);
    // The page the attempt ended on. The answer stands only if the page still
    // reads the same after it was observed (same document, same verdict): a
    // redirect or a code page that renders meanwhile is waited for again and
    // answered as the attempt would (a code step goes on, a challenge hands off).
    let after = await input.observe();
    let signedIn = false;
    for (let check = 0; attempt.outcome && attempt.last; check += 1) {
      const verdict = signedInOn(attempt.outcome.now, attempt.url);
      const again = await readMoving(guest, signal);
      if (again && again.document === attempt.outcome.document && signedInOn(again.now, guest.getURL()) === verdict) {
        signedIn = verdict;
        break;
      }
      if (check >= 2) break;
      const { phase, submitted } = attempt.last;
      const settled = await submitAnswered(guest, signal, phase, submitted);
      attempt.outcome = settled;
      attempt.url = guest.getURL();
      if (settled && phase === 'password' && codeStep(settled) && onOrigin(attempt.url)) {
        await runSteps('code', attempt.url, settled.now, settled.document);
      }
      after = await input.observe();
    }
    if (signedIn && deps.recordUsed) await deps.recordUsed(startUrl, account).catch(() => undefined);
    const note = signedIn
      ? `${SAVED_SIGN_IN_DONE}${site} with its saved login (the password never left the host).`
      : `${SAVED_SIGN_IN_NEEDS_USER}${site}: one try with its saved login did not finish the sign-in ` +
        '(a human check that did not finish, a code, CAPTCHA, passkey or an error). Do not retry; hand the sign-in to the user.';
    return { ...after, text: `${note}\n\n${after.text}` };
  }

  return { afterCommand };
}
