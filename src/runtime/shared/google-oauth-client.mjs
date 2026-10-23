// Mixdog's own Google OAuth client (a "Desktop app" client, marked "Use this
// client for an AI-powered agent"), used by the Gmail, Google Calendar and
// Google Drive catalog connectors instead of dynamic client registration,
// which Google does not offer. Google treats desktop clients as public: the
// id and its non-confidential secret ship with the app, and every sign-in
// uses PKCE (S256), state and a loopback redirect
// (developers.google.com/identity/protocols/oauth2/native-app).
//
// The source ships no client. The values come from the environment first
// (MIXDOG_GOOGLE_OAUTH_CLIENT_ID / _SECRET: a developer's override, and what
// `npm run dev:isolated` passes through), then from the generated, gitignored
// google-oauth-client.generated.json beside this file. Release packaging
// writes that file from the repository secrets
// (scripts/embed-google-oauth-client.mjs) before the npm package and every
// desktop runtime.asar are built, so each shipped build carries it. A build
// with neither offers no built-in Google sign-in (the user's own Google
// client still works).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The generated file release packaging writes (see the header). */
export const GOOGLE_OAUTH_CLIENT_FILE = fileURLToPath(new URL('./google-oauth-client.generated.json', import.meta.url));

const text = (value) => String(value || '').trim();

function embeddedClient(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const { clientId, clientSecret } = JSON.parse(source);
  return text(clientId) ? { clientId: text(clientId), clientSecret: text(clientSecret) } : null;
}

/** `{ clientId, clientSecret }` of Mixdog's Google client, or null when this
 *  build has none. The environment wins over the generated file as a whole:
 *  the two are never mixed. */
export function googleOAuthClient({ env = process.env, file = GOOGLE_OAUTH_CLIENT_FILE } = {}) {
  const clientId = text(env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID);
  if (clientId) return { clientId, clientSecret: text(env.MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET) };
  return embeddedClient(file);
}

/** Google issues a refresh token only for `access_type=offline`. */
export const GOOGLE_AUTH_PARAMS = Object.freeze({ access_type: 'offline' });
