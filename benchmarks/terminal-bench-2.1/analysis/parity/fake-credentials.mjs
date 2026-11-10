// The fake signed-in credentials of the four providers, written under an isolated data directory only (never the user's,
// never a real token): both halves of the wire parity check read the same files, and the expiry is far enough ahead
// that no refresh is ever attempted.
import { join } from 'node:path';

export const FAKE = 'fake-credential-not-a-secret';
/** 2100-01-01T00:00:00Z in epoch milliseconds. */
export const FAR = 4_102_444_800_000;

/** Writes the credential files of the four routes through `write(file, value)`. */
export function writeFakeCredentials(dataDir, write) {
  write(join(dataDir, 'anthropic-oauth-credentials.json'), { claudeAiOauth: { accessToken: FAKE, refreshToken: FAKE, expiresAt: FAR, scopes: ['user:inference'] } });
  write(join(dataDir, 'openai-oauth.json'), { access_token: FAKE, refresh_token: FAKE, account_id: 'fake', expires_at: FAR });
  write(join(dataDir, 'grok-oauth.json'), { access_token: FAKE, refresh_token: FAKE, expires_at: FAR });
  write(join(dataDir, 'gemini-api-key.json'), { apiKey: FAKE });
}
