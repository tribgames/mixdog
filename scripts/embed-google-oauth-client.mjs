#!/usr/bin/env node

// Release packaging step: write Mixdog's Google OAuth "Desktop app" client from
// MIXDOG_GOOGLE_OAUTH_CLIENT_ID / MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET (repository
// secrets) into the generated, gitignored file that googleOAuthClient() reads.
// Run it before `npm pack` and before apps/desktop `prepare:runtime`, so the
// npm package and every runtime.asar include the file.
//
//   --require   fail when either value is missing (release and publish jobs).
//               Without it a missing value is skipped, so PR, fork and local
//               builds go on without a built-in Google sign-in.
//
// The values are never printed.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { GOOGLE_OAUTH_CLIENT_FILE } from '../src/runtime/shared/google-oauth-client.mjs';

const text = (value) => String(value || '').trim();

/** Write the client file; returns false when skipped for missing values. */
export function embedGoogleOAuthClient({ env = process.env, file = GOOGLE_OAUTH_CLIENT_FILE, required = false } = {}) {
  const clientId = text(env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID);
  const clientSecret = text(env.MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    if (!required) return false;
    throw new Error(
      'MIXDOG_GOOGLE_OAUTH_CLIENT_ID and MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET must both be set: ' +
        'a release without them ships no built-in Google sign-in. Add them as repository secrets.'
    );
  }
  writeFileSync(file, `${JSON.stringify({ clientId, clientSecret }, null, 2)}\n`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const embedded = embedGoogleOAuthClient({ required: process.argv.includes('--require') });
    console.log(
      embedded
        ? 'Embedded the Google OAuth client for this build.'
        : 'No Google OAuth client configured; this build has no built-in Google sign-in.'
    );
  } catch (error) {
    console.error(`::error title=Google OAuth client missing::${error.message}`);
    process.exitCode = 1;
  }
}
