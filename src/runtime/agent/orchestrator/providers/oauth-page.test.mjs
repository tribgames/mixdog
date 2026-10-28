import assert from 'node:assert/strict';
import test from 'node:test';
import { oauthErrorHtml, oauthSuccessHtml } from './lib/oauth-page.mjs';
import {
  oauthFailureReason,
  oauthHttpError,
  oauthNetworkCause,
  oauthRequestError,
  oauthResponseJson,
  scrubOAuthSecrets,
} from './lib/oauth-token-utils.mjs';
import {
  AUTH_CODE,
  ESCAPED_SECRET_BODY,
  MALFORMED_TOKEN_BODY,
  SECRET_BODIES,
  SECRET_FIELDS,
  SECRET_RE,
} from './oauth-secret-fields.fixtures.mjs';

test('the shared redaction removes every secret field from JSON and form-encoded bodies', () => {
  const [json] = SECRET_BODIES;
  const form = SECRET_BODIES.at(-1);
  // Cut off mid-value, and bare values in malformed JSON.
  const truncated = '{"error":"x","refresh_token":"SECRET-REFRESH-CUT';
  const bare = '{"error":"x","id_token": SECRET-BARE, "client_secret":SECRET-BARE2}';
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl';
  for (const body of [...SECRET_BODIES, truncated, bare, `upstream echoed ${jwt}`]) {
    const scrubbed = scrubOAuthSecrets(body, [AUTH_CODE]);
    assert.doesNotMatch(scrubbed, SECRET_RE, body);
    assert.ok(!scrubbed.includes(jwt));
  }
  assert.match(scrubOAuthSecrets(json, [AUTH_CODE]), /"error":"invalid_grant"/);
  assert.match(scrubOAuthSecrets(form, [AUTH_CODE]), /error=invalid_grant/);
  assert.equal(scrubOAuthSecrets('{"token_type":"Bearer"}'), '{"token_type":"Bearer"}');
});

test('JSON is redacted on its decoded keys, nested in objects and arrays, keeping everything else', () => {
  const scrubbed = scrubOAuthSecrets(ESCAPED_SECRET_BODY);
  assert.doesNotMatch(scrubbed, SECRET_RE);
  assert.deepEqual(JSON.parse(scrubbed), {
    error: {
      code: 400,
      details: [{ client_secret: '[REDACTED]', Refresh_Token: '[REDACTED]' }, ['x', { id_token: '[REDACTED]' }]],
      meta: { api_key: '[REDACTED]', access_token: '[REDACTED]' },
    },
  });
  // Other escapes in values, a Bearer token inside a string, and exact numbers.
  const mixed = String.raw`{"msg":"Bearer\u0020abc.def","id":12345678901234567890,"ratio":1.50,"x":"\"q\"\n"}`;
  assert.equal(
    scrubOAuthSecrets(mixed),
    '{"msg":"Bearer [REDACTED]","id":12345678901234567890,"ratio":1.50,"x":"\\"q\\"\\n"}'
  );
  // An untouched body comes back byte for byte.
  const clean = '{ "error": "invalid_grant", "error_description": "expired" }';
  assert.equal(scrubOAuthSecrets(clean), clean);
});

test('secrets inside JSON string values are redacted: form-encoded, query strings and nested JSON', () => {
  const formValue = '{"detail":"access_token=OPAQUE_TOKEN&client_secret=OPAQUE_SECRET","n":12345678901234567890}';
  assert.equal(
    scrubOAuthSecrets(formValue),
    '{"detail":"access_token=[REDACTED]&client_secret=[REDACTED]","n":12345678901234567890}'
  );
  const query = '{"error_uri":"https://auth.example/cb?client_secret=OPAQUE_QUERY&state=ok"}';
  assert.equal(scrubOAuthSecrets(query), '{"error_uri":"https://auth.example/cb?client_secret=[REDACTED]&state=ok"}');
  const nested = JSON.stringify({
    detail: JSON.stringify({
      error: 'x',
      refresh_token: 'OPAQUE_NESTED',
      inner: String.raw`{"client\u005fsecret":"OPAQUE_DEEP"}`,
    }),
  });
  const scrubbed = scrubOAuthSecrets(nested);
  assert.doesNotMatch(scrubbed, /OPAQUE/);
  const detail = JSON.parse(JSON.parse(scrubbed).detail);
  assert.equal(detail.error, 'x');
  assert.equal(detail.refresh_token, '[REDACTED]');
  assert.deepEqual(JSON.parse(detail.inner), { client_secret: '[REDACTED]' });
  // A key holding form-encoded secrets is redacted too.
  assert.doesNotMatch(scrubOAuthSecrets('{"token=OPAQUE_KEY":1}'), /OPAQUE/);
  // Strings without secrets leave the body byte-identical.
  const plain = '{ "detail": "state=ok&error=invalid_grant", "uri": "https://x.example/?code=403" }';
  assert.equal(scrubOAuthSecrets(plain), plain);
});

test('error and status codes survive; only the authorization code is removed', () => {
  assert.equal(scrubOAuthSecrets('{"code":403}'), '{"code":403}');
  const rpcStatus = JSON.stringify({
    error: {
      code: 403,
      message: 'The caller does not have permission',
      status: 'PERMISSION_DENIED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
    },
  });
  assert.equal(scrubOAuthSecrets(rpcStatus), rpcStatus);
  assert.equal(scrubOAuthSecrets(JSON.stringify({ code: 3, message: 'bad' })), '{"code":3,"message":"bad"}');
  const errorCode = '{"error":{"code":"token_expired","message":"x"}}';
  assert.equal(scrubOAuthSecrets(errorCode), errorCode);
  // Malformed JSON keeps numeric codes too.
  assert.equal(scrubOAuthSecrets('{"code": 403, "key": 7'), '{"code": 403, "key": 7');
  // The known authorization code goes wherever it appears.
  for (const body of [
    `{"code":"${AUTH_CODE}","error":"invalid_grant"}`,
    `code=${AUTH_CODE}&error=invalid_grant`,
    `bad code ${AUTH_CODE}`,
  ]) {
    const scrubbed = scrubOAuthSecrets(body, [AUTH_CODE]);
    assert.ok(!scrubbed.includes(AUTH_CODE), body);
    assert.match(scrubbed, /invalid_grant|bad code/);
  }
});

test('an HTTP failure names its status and a redacted body; a malformed body names its status only', async () => {
  const error = oauthHttpError('[x] token exchange', 400, JSON.stringify({ error: 'bad', ...SECRET_FIELDS }), [
    AUTH_CODE,
  ]);
  assert.match(error.message, /^\[x\] token exchange 400: \{"error":"bad"/);
  assert.doesNotMatch(error.message, SECRET_RE);
  assert.match(oauthFailureReason('Failed.', error), /^Failed\.\n\[x\] token exchange 400/);

  const malformed = await oauthResponseJson(
    new Response(MALFORMED_TOKEN_BODY, { status: 200 }),
    '[x] token exchange'
  ).then(
    () => assert.fail('a malformed body must reject'),
    (caught) => caught
  );
  assert.equal(malformed.message, '[x] token exchange returned a malformed response (HTTP 200)');
  assert.equal(oauthFailureReason('Failed.', malformed), `Failed.\n${malformed.message}`);
});

const fetchFailed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });

test('a network failure is named by its error code only', () => {
  const connectTimeout = fetchFailed(
    Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
  );
  assert.equal(oauthNetworkCause(connectTimeout), 'UND_ERR_CONNECT_TIMEOUT');
  // Nested cause with a numeric code above it (a refused proxy tunnel).
  const tunnel = fetchFailed(Object.assign(new Error('x'), { code: 0, cause: { code: 'UND_ERR_ABORTED' } }));
  assert.equal(oauthNetworkCause(tunnel), 'UND_ERR_ABORTED');
  assert.equal(oauthNetworkCause(fetchFailed({ code: 'ENOTFOUND' })), 'ENOTFOUND');
  assert.equal(oauthNetworkCause(fetchFailed(new Error('secret'))), 'network error');
  assert.equal(oauthNetworkCause(new DOMException('t', 'TimeoutError')), 'timed out');
  assert.equal(oauthNetworkCause(new DOMException('a', 'AbortError')), null);
  assert.equal(oauthNetworkCause(new Error('token exchange 400')), null);

  const wrapped = oauthRequestError('[x] token exchange', fetchFailed({ code: 'ECONNRESET', message: 'secret' }));
  assert.equal(
    wrapped.message,
    '[x] token exchange request failed (ECONNRESET). Check your proxy/VPN: Mixdog uses the system proxy, or HTTPS_PROXY.'
  );
  const http = new Error('[x] token exchange 400: nope');
  assert.equal(oauthRequestError('[x] token exchange', http), http);
});

test('the failure reason quotes only page-safe errors, never a raw or parser message', () => {
  const network = oauthRequestError('[x] token exchange', fetchFailed({ code: 'ECONNRESET' }));
  assert.equal(oauthFailureReason('Failed.', network), `Failed.\n${network.message}`);
  let parserError;
  try {
    JSON.parse('{"access_token":"SECRET-ACCESS" oops');
  } catch (caught) {
    parserError = caught;
  }
  assert.equal(oauthFailureReason('Failed.', parserError), 'Failed.');
  assert.equal(oauthFailureReason('Failed.', new Error('raw SECRET-ACCESS')), 'Failed.');
  assert.equal(oauthFailureReason('Failed.', new DOMException('a', 'AbortError')), 'Failed.');
  assert.equal(oauthFailureReason('Failed.', null), 'Failed.');
});

test('the success page is branded, bilingual and offers a close button', () => {
  const html = oauthSuccessHtml('Codex');
  assert.match(html, /<svg[\s\S]*<\/svg>/);
  assert.match(html, /로그인 완료/);
  assert.match(html, /Codex 로그인이 완료되었습니다\. 이 탭을 닫고 Mixdog로 돌아가 주세요\./);
  assert.match(html, /You can close this tab and return to Mixdog/);
  assert.match(html, /<button type="button" onclick="window\.close\(\)">닫기 · Close<\/button>/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.doesNotMatch(html, /<a\s/);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);
});

test('a known language renders a single copy', () => {
  const ko = oauthSuccessHtml('X', { lang: 'ko' });
  assert.match(ko, /<html lang="ko">/);
  assert.doesNotMatch(ko, /You can close/);
  const en = oauthErrorHtml('boom', { lang: 'en' });
  assert.match(en, /Sign-in failed/);
  assert.doesNotMatch(en, /로그인 실패/);
});

test('the failure page shows the escaped reason', () => {
  const html = oauthErrorHtml('<img src=x onerror=alert(1)> & "q"');
  assert.match(html, /로그인 실패/);
  assert.match(html, /Sign-in failed/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /window\.close\(\)/);
});

test('provider names are escaped on the success page', () => {
  const html = oauthSuccessHtml('<b>x</b>');
  assert.ok(!html.includes('<b>x'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});
