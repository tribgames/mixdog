#!/usr/bin/env node
// Host-side Anthropic OAuth preflight on the Rust core: the K1 replacement of anthropic_oauth_preflight.mjs, which
// loaded the Node core's anthropic-oauth-credentials.mjs.
//
// The credential's state is read from the user's own running `mixdogd` through its account status (the
// `providerSetup` section of the app feed: `usable`, `reauthRequired`, `expiresAt` of the `anthropic-oauth` row), and
// the lease is checked against it. The snapshot a container gets is the credentials file without its rotating refresh
// token, as before. What the Node preflight also did and this does not: refresh a token that expires inside the
// lease. The Rust core refreshes a credential when it uses it and has no call that forces one, so a short lease is
// reported with that instruction (see the K1 table, row "anthropic_oauth_preflight").
//
// Like its predecessor this file is copied into a TEMP harness snapshot, so it finds the repository through
// MIXDOG_TB_REPO_ROOT (the agent passes it) and falls back to the in-repo layout.
// Usage: anthropic_oauth_preflight_rust.mjs --output <snapshot> --minimum-validity-ms <ms>
//        env: ANTHROPIC_OAUTH_CREDENTIALS_PATH, MIXDOG_RUNTIME_ROOT (the running core's runtime root)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROVIDER = 'anthropic-oauth';

/** Secret-shaped text and the exact secret values, replaced by `[redacted]`. */
export function scrubTokens(text, secretValues = []) {
  let out = String(text ?? '');
  for (const secret of secretValues) if (secret && String(secret).length >= 8) out = out.split(String(secret)).join('[redacted]');
  return out
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{8,})/g, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/("?(?:access|refresh|id)_?[Tt]oken"?\s*[:=]\s*"?)[A-Za-z0-9._~+/=-]{8,}/g, '$1[redacted]');
}

/** The `anthropic-oauth` row of a `providerSetup` section value. */
export function anthropicRow(setup) {
  return (setup?.oauth ?? []).find((row) => row?.id === PROVIDER);
}

/** The lease the status gives, or the reason it cannot satisfy `requiredMs`. */
export function leaseOf(row, requiredMs, now) {
  if (!row) throw new Error('the core lists no anthropic-oauth provider.');
  if (!row.authenticated) throw new Error('Anthropic OAuth host preflight found no credentials. Open /providers in mixdog to sign in.');
  if (row.reauthRequired) throw new Error(`Anthropic OAuth needs a new sign-in (${row.status}). Open /providers in mixdog to sign in.`);
  if (row.usable !== true) throw new Error(`Anthropic OAuth credentials are not usable (${row.status}).`);
  const expiresAt = Number(row.expiresAt);
  const remainingMs = Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt - now : 0;
  if (remainingMs < requiredMs) {
    throw new Error(
      `Anthropic OAuth host preflight cannot satisfy the ${Math.ceil(requiredMs / 1000)}s credential lease `
        + `(the credential has ${Math.max(0, Math.floor(remainingMs / 1000))}s). Use Mixdog on this host so its core refreshes the token, then rerun.`,
    );
  }
  return { expiresAt, remainingMs };
}

/** The credentials document a container may hold: no refresh token, ever. */
export function snapshotOf(raw) {
  const copy = JSON.parse(JSON.stringify(raw));
  if (copy?.claudeAiOauth) {
    delete copy.claudeAiOauth.refreshToken;
    delete copy.claudeAiOauth.refresh_token;
  }
  return copy;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

export async function preflight({ credentialsPath, minimumValidityMs, snapshotPath, attach, now = () => Date.now() }) {
  const raw = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  if (!raw?.claudeAiOauth?.accessToken) {
    throw new Error(`Anthropic OAuth host preflight found no credentials at ${credentialsPath}. Open /providers in mixdog to sign in.`);
  }
  const core = await attach();
  try {
    const { waitStore } = await core.library();
    await core.client.call('account/refreshProviderSetup', { force: true, refresh: true });
    await core.client.subscribeApp();
    const setup = await waitStore(core.client, () => core.client.store.section('providerSetup')?.value);
    const lease = leaseOf(anthropicRow(setup), minimumValidityMs, now());
    writeFileSync(snapshotPath, `${JSON.stringify(snapshotOf(raw), null, 2)}\n`, { mode: 0o600 });
    return lease;
  } finally {
    await core.client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = valueAfter('--output');
  const minimumValidityMs = Number(valueAfter('--minimum-validity-ms'));
  const credentialsPath = process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH;
  if (!output || !credentialsPath || !Number.isFinite(minimumValidityMs) || minimumValidityMs < 0) {
    process.stderr.write('usage: anthropic_oauth_preflight_rust.mjs --output <snapshot> --minimum-validity-ms <milliseconds>\n');
    process.exitCode = 2;
  } else {
    try {
      const root = process.env.MIXDOG_TB_REPO_ROOT ? resolve(process.env.MIXDOG_TB_REPO_ROOT) : fileURLToPath(new URL('../../..', import.meta.url));
      const lib = await import(pathToFileURL(resolve(root, 'scripts/rust-core/lib/core-session.mjs')).href);
      const runtimeRoot = process.env.MIXDOG_RUNTIME_ROOT;
      if (!runtimeRoot) throw new Error('MIXDOG_RUNTIME_ROOT must name the runtime root of the running core.');
      const result = await preflight({
        credentialsPath,
        minimumValidityMs,
        snapshotPath: resolve(output),
        attach: async () => ({ ...(await lib.attachCore({ runtimeRoot, clientName: 'anthropic-oauth-preflight' })), library: async () => lib }),
      });
      process.stdout.write(`Anthropic OAuth host preflight ready (${Math.floor(result.remainingMs / 1000)}s lease).\n`);
    } catch (error) {
      process.stderr.write(`Anthropic OAuth host preflight failed: ${scrubTokens(error?.message || String(error)).slice(0, 500)}\n`);
      process.exitCode = 1;
    }
  }
}
