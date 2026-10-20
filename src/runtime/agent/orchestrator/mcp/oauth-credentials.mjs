import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock, writeFileAtomicAsync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { canForceAccountChoice } from './oauth-account.mjs';
import { reauthenticationRequired } from './oauth-shared.mjs';

// Same lease as the provider OAuth refresh (openai-oauth-tokens.mjs): a
// refresh is a network exchange plus keychain persistence. The lock file
// itself holds no credential (they live in the keychain).
const CREDENTIAL_LOCK_OPTIONS = Object.freeze({ timeoutMs: 120_000, staleMs: 120_000 });

export const credentialFile = (account, extension) => join(resolvePluginData(), 'mcp-oauth', `${account}.${extension}`);

// Serializes refreshes, logins and log-outs of one account across processes.
export function withCredentialLock(account, fn) {
  return withFileLock(credentialFile(account, 'lock'), fn, CREDENTIAL_LOCK_OPTIONS);
}

// A non-secret marker of the stored entry's revision ('deleted' when there is
// none) and whether the entry holds tokens (a client registration alone does
// not sign in), written under the credential lock before every change of the
// entry. Every process compares it before sending a cached token, so a refresh
// or log-out elsewhere is observed without reading the keychain per request.
export const TOKENS_FLAG = '+tokens';
const markerOf = (revision, hasTokens) => {
  if (revision === null) return 'deleted';
  return hasTokens ? `${revision}${TOKENS_FLAG}` : revision;
};
export function writeRevisionMarker(account, revision, hasTokens = false) {
  return writeFileAtomicAsync(credentialFile(account, 'rev'), markerOf(revision, hasTokens));
}
// Missing or unreadable (null) never matches: the caller re-reads the keychain.
function readRevisionMarker(account) {
  return readFile(credentialFile(account, 'rev'), 'utf8').catch(() => null);
}

// Who the stored sign-in belongs to, beside the entry (never a credential), so
// the status lists it without decrypting the keychain:
// `{ account, workspace, forcedChoice }`; absent when unknown or signed out.
export function writeIdentityFile(account, creds) {
  const file = credentialFile(account, 'who');
  if (!creds?.tokens) return rm(file, { force: true });
  const identity = creds.identity || {};
  return writeFileAtomicAsync(
    file,
    JSON.stringify({
      account: identity.account || '',
      workspace: identity.workspace || '',
      forcedChoice: canForceAccountChoice(creds.discovery?.authorizationServerMetadata?.authorization_endpoint),
    })
  );
}
export function readIdentityFile(account) {
  try {
    const value = JSON.parse(readFileSync(credentialFile(account, 'who'), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// The stored value as another process may have just written it, not this
// process's cached copy.
export function readStoredCredentials(credentialStore, account) {
  credentialStore.invalidateSecretCache?.(account);
  return credentialStore.getSecretAsync(account);
}

// Every write stores a fresh random revision; null stands for no entry.
const revisionOf = (saved) => (saved ? (JSON.parse(saved).revision ?? '') : null);

/**
 * One connection's view of its stored OAuth entry. `creds` holds the cached
 * values: `observed` is the revision of the stored entry this process last
 * read or wrote (null: there was none, undefined: unknown after a log-out
 * here); `loaded` is the pending or completed first read.
 */
export function createCredentialCache({ url, credentialStore, account }) {
  const creds = {
    tokens: undefined,
    clientInformation: undefined,
    redirectUrl: undefined,
    discovery: undefined,
    identity: undefined,
    observed: undefined,
    loaded: undefined,
  };
  // Every token this connection held: an error or result echoing the token a
  // request was sent with stays scrubbed after a refresh or log-out.
  const held = new Set();
  const hold = () => {
    for (const token of [creds.tokens?.access_token, creds.tokens?.refresh_token]) if (token) held.add(token);
  };
  const adopt = (saved) => {
    const value = saved ? JSON.parse(saved) : {};
    if (saved && value.url !== url) throw reauthenticationRequired();
    ({
      tokens: creds.tokens,
      clientInformation: creds.clientInformation,
      redirectUrl: creds.redirectUrl,
      discovery: creds.discovery,
      identity: creds.identity,
    } = value);
    creds.observed = revisionOf(saved);
    hold();
  };
  // Whether the stored entry is still the one this process last read or wrote:
  // its revision marker says so without a keychain read (on Windows each read
  // is a DPAPI PowerShell round trip of ~250 ms). Every writer changes the
  // marker under the credential lock before the entry, so under that lock an
  // unchanged marker is an unchanged entry.
  const unchanged = async (expected = creds.observed) =>
    expected !== undefined &&
    expected === creds.observed &&
    (await readRevisionMarker(account)) === markerOf(expected, Boolean(creds.tokens));
  // The stored entry as of now, adopted (skipped when unchanged).
  async function adoptStored() {
    if (await unchanged()) return;
    adopt(await readStoredCredentials(credentialStore, account));
  }
  // A failed read (locked keychain) is retried by the next request.
  const ready = () =>
    (creds.loaded ??= credentialStore
      .getSecretAsync(account)
      .then(adopt)
      .catch((error) => {
        creds.loaded = undefined;
        throw error;
      }));
  // The only writer of the stored entry. Under the cross-process lock it
  // changes the entry only while it still has the revision the caller observed
  // (by default the one this process last read or wrote); otherwise it adopts
  // the newer entry, or its deletion by a log-out, and changes nothing.
  function update(change, { expected = creds.observed, remove = false } = {}) {
    return withCredentialLock(account, async () => {
      let exists = creds.observed !== null;
      if (!(await unchanged(expected))) {
        const saved = await readStoredCredentials(credentialStore, account);
        if (revisionOf(saved) !== expected) {
          adopt(saved);
          return false;
        }
        exists = Boolean(saved);
      }
      change();
      hold();
      if (remove) {
        await writeRevisionMarker(account, null);
        if (exists) await credentialStore.deleteSecretAsync(account);
        await writeIdentityFile(account, null);
        creds.observed = null;
      } else {
        const revision = randomBytes(16).toString('hex');
        await writeRevisionMarker(account, revision, Boolean(creds.tokens));
        const { tokens, clientInformation, redirectUrl, discovery, identity } = creds;
        await credentialStore.setSecretAsync(
          account,
          JSON.stringify({ url, revision, tokens, clientInformation, redirectUrl, discovery, identity })
        );
        await writeIdentityFile(account, creds);
        creds.observed = revision;
      }
      return true;
    });
  }
  // Before a cached token is sent: adopt a change another process made (a
  // refresh, a log-out) since this process last read or wrote the entry.
  async function observeStoredRevision() {
    if ((await readRevisionMarker(account)) === markerOf(creds.observed, Boolean(creds.tokens))) return;
    await withCredentialLock(account, async () => {
      adopt(await readStoredCredentials(credentialStore, account));
      // Repair a missing or stale marker (an entry stored before markers or
      // the tokens flag existed, an interrupted change) so the next request
      // reads no keychain.
      if ((await readRevisionMarker(account)) !== markerOf(creds.observed, Boolean(creds.tokens))) {
        await writeRevisionMarker(account, creds.observed, Boolean(creds.tokens));
      }
    });
  }
  // Forget the in-memory credentials; the next request re-reads the keychain.
  function clear() {
    creds.tokens = creds.clientInformation = creds.redirectUrl = creds.discovery = creds.identity = undefined;
    creds.loaded = creds.observed = undefined;
  }
  return {
    creds,
    held,
    ready,
    adopt,
    adoptStored,
    update,
    observeStoredRevision,
    clear,
    readStored: () => readStoredCredentials(credentialStore, account),
    withLock: (fn) => withCredentialLock(account, fn),
  };
}
