// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/runtime/agent/orchestrator/providers/devin-auth.mjs, recorded from apps/desktop/src/renderer/oauth-failure-copy.test.mjs of that commit run against an exact export of it (record/record.mjs).
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
