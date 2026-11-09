// Node b6f10295a src/runtime/agent/orchestrator/providers/devin-auth.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./oauth-failure-copy.test.0.recorded.json', import.meta.url), 'utf8'));
export const DEVIN_OAUTH_FAILURE_CODES = replay(table, "DEVIN_OAUTH_FAILURE_CODES");
export const REAUTH_GUIDANCE = replay(table, "REAUTH_GUIDANCE");
export const beginDevinOAuthLogin = replay(table, "beginDevinOAuthLogin");
export const describeDevinOAuthCredentials = replay(table, "describeDevinOAuthCredentials");
export const devinTokenExpiry = replay(table, "devinTokenExpiry");
export const devinTokenIdentity = replay(table, "devinTokenIdentity");
export const exchangeDevinCode = replay(table, "exchangeDevinCode");
export const forgetDevinOAuthCredentials = replay(table, "forgetDevinOAuthCredentials");
export const generateDevinOAuthParams = replay(table, "generateDevinOAuthParams");
export const hasDevinOAuthCredentials = replay(table, "hasDevinOAuthCredentials");
export const loginDevinOAuth = replay(table, "loginDevinOAuth");
export const resolveDevinOAuthAccessToken = replay(table, "resolveDevinOAuthAccessToken");
