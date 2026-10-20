// Mixdog's own Google OAuth client (a "Desktop app" client, marked "Use this
// client for an AI-powered agent"), used by the Gmail, Google Calendar and
// Google Drive catalog connectors instead of dynamic client registration,
// which Google does not offer. Google treats desktop clients as public: the
// id and its non-confidential secret ship with the app, and every sign-in
// uses PKCE (S256), state and a loopback redirect
// (developers.google.com/identity/protocols/oauth2/native-app).
//
// The values come only from the environment; the source ships none, so a
// build without them offers no built-in Google sign-in (the user's own
// Google client still works).

const value = (name) => String(process.env[name] || '').trim();

/** `{ clientId, clientSecret }` of Mixdog's Google client, or null when this
 *  build has none. */
export function googleOAuthClient() {
  const clientId = value('MIXDOG_GOOGLE_OAUTH_CLIENT_ID');
  if (!clientId) return null;
  return { clientId, clientSecret: value('MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET') };
}

/** Google issues a refresh token only for `access_type=offline`. */
export const GOOGLE_AUTH_PARAMS = Object.freeze({ access_type: 'offline' });
