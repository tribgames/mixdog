import { t } from './i18n';

// A provider sign-in failure leads its message with `<PROVIDER>_OAUTH_<CODE>:`
// (devin-auth.mjs), the way `GMAIL_APP_PASSWORD_<CODE>` leads a Gmail one. The
// code, never the English sentence behind it, picks the cause and remedy shown
// here; the sentence stays in the error's details.
const OAUTH_FAILURES = new Map<string, { cause: () => string; remedy: () => string }>([
  [
    'DEVIN_OAUTH_CALLBACK_PORT_IN_USE',
    {
      cause: () => t('Another program is using the local port Devin sign-in needs.'),
      remedy: () => t('Close that program or any other Devin sign-in in progress, then try again.'),
    },
  ],
  [
    'DEVIN_OAUTH_CALLBACK_SERVER_FAILED',
    {
      cause: () => t('The local callback server for the Devin sign-in failed.'),
      remedy: () => t('Start the sign-in again. If it keeps failing, try again later.'),
    },
  ],
  [
    'DEVIN_OAUTH_LOGIN_TIMED_OUT',
    {
      cause: () => t('The Devin sign-in was not finished in time.'),
      remedy: () => t('Start the sign-in again and finish it in the browser within five minutes.'),
    },
  ],
  [
    'DEVIN_OAUTH_AUTHORIZATION_DENIED',
    {
      cause: () => t('Devin did not authorize this sign-in.'),
      remedy: () => t('Start the sign-in again and approve the request in the browser.'),
    },
  ],
  [
    'DEVIN_OAUTH_STATE_MISMATCH',
    {
      cause: () => t('The pasted address belongs to a different Devin sign-in.'),
      remedy: () => t('Paste the address from the sign-in page this dialog opened, or start the sign-in again.'),
    },
  ],
  [
    'DEVIN_OAUTH_CODE_REQUIRED',
    {
      cause: () => t('The pasted address has no authorization code.'),
      remedy: () => t('Paste the full address you were redirected to after signing in.'),
    },
  ],
  [
    'DEVIN_OAUTH_TOKEN_EXCHANGE_FAILED',
    {
      cause: () => t('Devin could not complete the sign-in.'),
      remedy: () => t('Start the sign-in again. If it keeps failing, try again later.'),
    },
  ],
]);

const OAUTH_FAILURE_CODE = /\b([A-Z][A-Z0-9]*_OAUTH_[A-Z0-9_]+):/;

/** The cause and remedy of a coded provider sign-in failure in the UI
 *  language; null for any other message. */
export function localizeOAuthFailure(text: string): { summary: string; recovery: string } | null {
  const code = OAUTH_FAILURE_CODE.exec(text)?.[1];
  const copy = code ? OAUTH_FAILURES.get(code) : undefined;
  return copy ? { summary: copy.cause(), recovery: copy.remedy() } : null;
}
