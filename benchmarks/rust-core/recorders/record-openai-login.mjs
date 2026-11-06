#!/usr/bin/env node
// OpenAI browser-PKCE login (WP-AI-OPENAI): the REAL Node `createOpenAIOAuthLogin`
// (openai-oauth-login.mjs) against a loopback fake issuer, once per token shape.
// Records the authorize URL parameters, the form-encoded code exchange and the
// credential Node saves. Tokens are the recorders' stable placeholders: a JWT-shaped
// `h.<claims>.s` (the form record-ai-account.mjs uses; it carries the claims Node reads
// and trips no secret scan), or an opaque string.
//
//   node benchmarks/rust-core/recorders/record-openai-login.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/oracles/openai-login-golden.json (listed in
// providers/MANIFEST.json; refresh it with verify-manifests.mjs --refresh providers).
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const AUTH = 'https://api.openai.com/auth';
const PROFILE = 'https://api.openai.com/profile';
const NOW = 1_700_000_000_000;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims) => `h.${b64(claims)}.s`;

const SCENARIOS = {
  withExpiresIn: {
    access: jwt({ exp: 1_700_003_600, [AUTH]: { chatgpt_account_id: 'acct-1' }, sub: 'sub-access' }),
    id: jwt({ sub: 'sub-1', email: 'me@example.com', [AUTH]: { chatgpt_account_id: 'acct-1' } }),
    expires_in: 7200,
  },
  jwtExpiryOnly: {
    access: jwt({ exp: 1_700_003_600, [AUTH]: { chatgpt_account_id: 'acct-2' }, sub: 'sub-2', [PROFILE]: { email: 'p@example.com' } }),
    id: null,
    expires_in: undefined,
  },
  opaqueTokens: { access: 'opaque-access', id: null, expires_in: undefined },
};

export async function recordOpenAiLogin(tree, outFile) {
  const { createOpenAIOAuthLogin } = await importFrom(tree, `${P}/openai-oauth-login.mjs`);
  const real = await importFrom(tree, `${P}/openai-oauth-tokens.mjs`);
  const tokensMod = await importFrom(tree, `${P}/lib/oauth-token-utils.mjs`);
  const realNow = Date.now;
  const scenarios = {};
  for (const [name, s] of Object.entries(SCENARIOS)) {
    const requests = [];
    const saved = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body });
        if (req.url.startsWith('/api/accounts/')) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: s.access,
          refresh_token: 'refresh-1',
          ...(s.id ? { id_token: s.id } : {}),
          ...(s.expires_in ? { expires_in: s.expires_in } : {}),
        }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const issuer = `http://127.0.0.1:${server.address().port}`;
    const { beginOAuthLogin } = createOpenAIOAuthLogin({
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      originator: 'codex_cli_rs',
      extractAccountId: real.extractAccountId,
      identityFromTokens: real.identityFromTokens,
      expiryFromAccessToken: tokensMod.expiryFromAccessToken,
      saveTokens: (t) => saved.push(t),
      issuer,
    });
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    Date.now = () => NOW;
    let login;
    try {
      login = await beginOAuthLogin({ openBrowser: false });
      var url = new URL(login.url);
      await login.completeCode('code 123');
    } finally {
      Date.now = realNow;
      process.stderr.write = stderr;
      server.close();
    }
    const params = [...url.searchParams.entries()];
    const token = requests.find((r) => r.url === '/oauth/token');
    const form = [...new URLSearchParams(token.body).entries()];
    const verifier = form.find(([k]) => k === 'code_verifier')[1];
    const state = params.find(([k]) => k === 'state')[1];
    const credential = JSON.parse(JSON.stringify(saved[0]));
    scenarios[name] = {
      tokens: { access_token: s.access, id_token: s.id, expires_in: s.expires_in ?? null },
      nowMs: NOW,
      authorizeUrlBase: `${url.origin}${url.pathname}`,
      authorizeParamOrder: params.map(([k]) => k),
      authorizeFixed: Object.fromEntries(params.filter(([k]) => !['code_challenge', 'state'].includes(k))),
      stateShape: { length: state.length, hex: /^[0-9a-f]+$/.test(state) },
      challengeLength: params.find(([k]) => k === 'code_challenge')[1].length,
      verifierLength: verifier.length,
      tokenRequest: {
        method: token.method,
        contentType: token.contentType,
        order: form.map(([k]) => k),
        fixed: Object.fromEntries(form.filter(([k]) => k !== 'code_verifier')),
      },
      saved: credential,
      savedKeyOrder: Object.keys(credential),
    };
  }
  writeJson(outFile, {
    _doc: 'Recorded from src/runtime/agent/orchestrator/providers/openai-oauth-login.mjs (createOpenAIOAuthLogin, browser flow, loopback fake issuer, clock pinned to nowMs). Tokens are placeholders: h.<base64url claims>.s, or opaque.',
    recorder: 'benchmarks/rust-core/recorders/record-openai-login.mjs',
    scenarios,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tree = resolveTree(parseArgs());
  await recordOpenAiLogin(tree, join(FIXTURES_ROOT, 'providers', 'oracles', 'openai-login-golden.json'));
  console.log('recorded openai-login-golden');
  process.exit(0);
}
