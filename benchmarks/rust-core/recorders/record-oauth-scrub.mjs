#!/usr/bin/env node
// Golden twin of `scrubOAuthSecrets(text, secretValues)` (providers/lib/oauth-token-utils.mjs): what
// every provider error text, response excerpt and log line is cleaned with before it leaves the
// process. Node's real function runs over inputs covering the JSON path (parsed redaction, escaped
// keys, key order, number source text, nested JSON in strings), the text path (JSON-like and
// form fields, Bearer, `sk-ant-`, JWT) and the given secret values.
//
// The given values are found through the canonical view of node-patches/node-fix-scrub-canonical-credential.patch (whatever the
// text's escapes, a short value as a whole token): the golden is recorded from b6f10295a with the four scrub patches applied.
//
//   node benchmarks/rust-core/recorders/record-oauth-scrub.mjs --tree <export of b6f10295a with the patches applied> --patch <patch>[,<patch>…] [--out <dir>]
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, nodeTreeIdentity, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const cli = parseArgs();
const tree = resolveTree(cli);
const identity = nodeTreeIdentity(cli, tree, NODE_COMMIT);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'oauth-scrub');
const { scrubOAuthSecrets, oauthBodySummary } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/lib/oauth-token-utils.mjs');
const { scrubMuseSecrets } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/muse-code-oauth-tokens.mjs');

const JWT = 'eyJhbGciOiJ.eyJzdWIiO.c2lnbmF0';
const cases = [
  ['hello', []],
  ['', []],
  ['   ', []],
  ['{"apiKey":"abc","n":1}', []],
  ['{ "a" : 1 }', []],
  ['  {"key" : "v"}  ', []],
  ['{"a":[{"access_token":"x"},{"token":5}]}', []],
  ['{"token":123,"key":null,"secret":true}', []],
  ['{"client\\u005fsecret":"zzz"}', []],
  ['{"b":1,"2":2,"1":3,"password":"p"}', []],
  ['{"a":1,"a":2,"key":"k"}', []],
  ['{"n":1.10,"m":1e5,"big":12345678901234567890,"neg":-0,"password":"p"}', []],
  ['{"msg":"token=abc&x=1"}', []],
  ['{"h":"Bearer abc.def"}', []],
  [`{"jwt":"${JWT}"}`, []],
  ['{"t":"line\\nbreak \\u2028 \\u00e9 \\ud83d\\ude00 tab\\t \\/ \\b\\f","key":"k"}', []],
  ['{"t":"\\u0001\\u001f\\u007f","key":"k"}', []],
  ['"abc"', []],
  ['123', []],
  ['null', []],
  ['[{"token":"t"}]', []],
  ['[]', []],
  ['{"access_token":"abc', []],
  ['{"api_key": abc123, "x": 1}', []],
  ['{"token": 123, oops', []],
  ['{"token": true, oops', []],
  ['{"token": truex, oops', []],
  ['{"token": -5x, oops', []],
  ['{"token": null}, "key": "v"', []],
  ['{"password":"p", "x":', []],
  ['{"password":"a\\"b","y":1', []],
  ['a=1&access_token=abc&b=2', []],
  ['token=abc', []],
  ['xtoken=abc&_key=q&client_secret=s"x', []],
  ['code=abc&Code_Verifier=v', []],
  ['Authorization: Bearer abc.DEF-123 end', []],
  ['authorization: bearer lower.case', []],
  ['x sk-ant-api03-ABC_def.1 y', []],
  [`stack ${JWT} tail eyJabc.def`, []],
  ['my secret abc here abc', ['abc']],
  ['nothing here', ['', 'zzz']],
  ['{"msg":"contains abc"}', ['abc']],
  ['{"abc":1}', ['abc']],
  ['{"API_KEY":"x","Token":"y","ACCESSTOKEN":"z","Access-Token":"w"}', []],
  ['{"code":"abc","tokens":"x","keys":"y","apiKeyId":"i"}', []],
  ['{"body":"{\\"api_key\\":\\"sk\\"}"}', []],
  ['{"body":"a=1&password=p"}', []],
  ['{"__proto__":{"a":1},"key":"k"}', []],
  ['{"":1,"key":"k"}', []],
  ['{"😀":"x","key":"k"}', []],
  ['{"a":{"b":{"c":{"secret":"s"}}}}', []],
  ['{"a":"b"}\n{"key":"k"}', []],
  ['{"list":["Bearer x.y",{"token":"t"},[{"key":"k"}]]}', []],
  ['{"k":"x"} trailing', []],
  ['{"Key": "v", "KEY": "w"}', []],
  ['{"key":"v","key":"w"}', []],
  ['{"1":{"token":"t"},"01":2,"4294967295":3,"4294967294":4}', []],
  ['  \t{"a":1}\n', []],
  ['{"token" :\n "v"}', []],
  ['"token":"v" and "key":"w"', []],
  ['{"token":"v\\u00e9 \\"q\\""}', []],
  ['{"é":"x","password":"p"}', []],
  ['{"a":"xabcx"}', ['abc', 'abc']],
  ['Bearer ', []],
  ['Bearer a Bearer b', []],
  ['sk-ant- and sk-ant-x', []],
  ['{"api_key" : "k1", "x":1} and "api_key":"k2" and "api_key":""', []],
  ['plain "api_key" : "abc" text', []],
  ['a   b\n\tc  ', []],
  ['\u00a0 padded \u3000 and \ufeff', []],
  ['x'.repeat(600), []],
  ['{"error":"bad   request","detail":"line1\\nline2"}', []],
  ['token=abc  \n def', ['def']],
  // An encoded value, found through the canonical view; a short value only as a whole token.
  ['refused long%252Fkey%252Bvalue and long&#47;key&#x2B;value', ['long/key+value']],
  ['{"msg":"long\\u002fkey+value"}', ['long/key+value']],
  ['Bearer-less abc1234, xabc1234 and abc12345', ['abc1234']],
];
const out = cases.map(([text, secrets]) => ({ text, secrets, scrubbed: scrubOAuthSecrets(text, secrets), muse: scrubMuseSecrets(text, secrets), summary: oauthBodySummary(text, secrets) }));
writeJson(join(outDir, 'golden.json'), { domain: 'oauth-scrub', recorder: 'benchmarks/rust-core/recorders/record-oauth-scrub.mjs', cases: out });
writeSetManifest(outDir, {
  set: 'oauth-scrub',
  recorder: 'benchmarks/rust-core/recorders/record-oauth-scrub.mjs',
  command: `node benchmarks/rust-core/recorders/record-oauth-scrub.mjs --tree <export of ${NODE_COMMIT}${cli.get('patch') ? ` with ${cli.get('patch')} applied` : ''}>${cli.get('patch') ? ` --patch ${cli.get('patch')}` : ''}`,
  identity,
});
console.log(`recorded ${out.length} cases, ${out.filter((c) => c.scrubbed !== c.text).length} changed`);
