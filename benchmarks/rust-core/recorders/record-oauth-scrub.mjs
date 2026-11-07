#!/usr/bin/env node
// `scrubOAuthSecrets(text, secretValues)` (providers/lib/oauth-token-utils.mjs): the real function
// over bodies that carry tokens and secrets in every form a refusal arrives in: JSON (nested,
// escaped keys, raw numbers, repeated and integer-like keys, secrets inside string values),
// truncated or malformed JSON, form-encoded and query text, bearer / JWT / Anthropic tokens and
// given secret values. Rust `mixdog_ai::oauth::scrub::scrub_oauth_secrets` must answer the same
// text for each.
//
//   node benchmarks/rust-core/recorders/record-oauth-scrub.mjs [--tree <dir>]
//
// Output: native/core/fixtures/oauth-scrub/golden.json.
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'oauth-scrub');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-oauth-scrub.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'oauth-scrub-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'oauth-scrub-home-'));
const { scrubOAuthSecrets } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/lib/oauth-token-utils.mjs');

// Short header and signature keep the fixture from looking like a real token to a secret scanner.
const jwt = 'eyJhbGci.eyJzdWIiOiJ1MSJ9.sig-part';
const CASES = [
  // JSON bodies
  ['{"access_token":"abc123","token_type":"Bearer","expires_in":3600}', []],
  ['{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', []],
  ['{"refreshToken":"r-1","accessToken":"a-1","idToken":"i-1","client_secret":"cs","code":"ok"}', []],
  ['{"nested":{"api_key":"k","list":[{"password":"p"},{"keep":"v"}]},"n":1.50,"big":12345678901234567890,"e":1E5,"neg":-0}', []],
  ['{"message":"visit https://x.test/cb?code_verifier=abc&state=s now"}', []],
  ['{"detail":"{\\"access_token\\":\\"inner\\"}"}', []],
  ['{"client\\u005fsecret":"escaped","ok":true,"nothing":null}', []],
  ['{"a":"x","a":"y","access_token":"first","access_token":"second"}', []],
  ['{"10":"ten","2":"two","b":"bee","1":"one"}', []],
  ['{"10":"Bearer abcdef","2":"two"}', []],
  ['{"éclair":"é\\u00e9 \\/ \\" \\\\ \\n \\t","emoji":"😀 \\ud83d\\ude00 Bearer tok"}', []],
  ['{"msg":"Bearer abc.def-ghi"}', []],
  ['{"msg":"sk-ant-oat01-abc"}', []],
  ['{"msg":"' + jwt + '"}', []],
  ['{"msg":"the secret-value is here"}', ['secret-value']],
  ['{"key":123,"token":true,"secret":null,"password":["a"]}', []],
  ['{"key":{"a":1},"token":"t"}', []],
  ['  {  "access_token" : "spaced" , "x" : [ 1 , 2 ]  }  ', []],
  ['{"plain":"nothing secret","n":1.0,"arr":[1,2,3]}', []],
  ['[{"access_token":"in-array"},"Bearer zzz",3,null,true]', []],
  ['[]', []],
  ['{}', []],
  ['{"":"empty key","access_token":""}', []],
  ['{"KEY":"upper","Token":"mixed","API_KEY":"snake"}', []],
  ['{"apikey":"a","api-key":"b","device_code":"d","codeVerifier":"v","code_challenge":"c","assertion":"x"}', []],
  // Not an object or array
  ['"just a string with Bearer abc.def"', []],
  ['"access_token=abc"', []],
  ['12345', []],
  ['true', []],
  ['null', []],
  ['', []],
  ['plain text with no secret', []],
  // Malformed or truncated JSON
  ['{"access_token":"abc', []],
  ['{"access_token":"abc","refresh_token":"def"', []],
  ['{"access_token": abc-bare, "x": 1}', []],
  ['{"access_token": 123, "other": "v"', []],
  ['{"access_token": true, "k": null,', []],
  ['{"id_token":"a\\"b","x":"y"} trailing', []],
  ['<html><body>{"access_token":"in-html"}</body></html>', []],
  ['{"api_key":"k1"} {"api_key":"k2"}', []],
  // Form-encoded and query text
  ['grant_type=refresh_token&refresh_token=r-tok&client_id=cid&client_secret=cs', []],
  ['access_token=abc&token_type=bearer', []],
  ['?code_verifier=xyz&state=1', []],
  ['x-token=notakey', []],
  ['my_key=1 key=2 "key=3"', []],
  ['Error: request to https://a.test/token?code=authcode&client_secret=s failed', []],
  // Tokens anywhere
  ['Authorization: Bearer abc.DEF-ghi_123 rejected', []],
  ['bearer lowercase.token', []],
  ['upstream said sk-ant-api03-AAAA and ' + jwt + ' ok', []],
  ['jwt without third part eyJhbGci.eyJzdWIiOiJ1MSJ9 end', []],
  ['not a jwt eyJshort.eyJshort', []],
  // Given secret values
  ['the code authcode-1 was used, authcode-1 twice', ['authcode-1']],
  ['values a b and ab', ['a', 'b', '']],
  ['nothing to hide', ['absent']],
  ['{"msg":"authcode-2 inside"}', ['authcode-2']],
  ['{"authcode-3":"as a key"}', ['authcode-3']],
  ['first=1 refresh_token=also-secret-value', ['also-secret-value']],
];

const scenarios = CASES.map(([text, secrets]) => ({ text, secrets, scrubbed: scrubOAuthSecrets(text, secrets) }));
writeJson(join(stage, 'golden.json'), { scenarios });
writeSetManifest(stage, { set: 'oauth-scrub', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
