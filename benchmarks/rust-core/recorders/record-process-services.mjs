#!/usr/bin/env node
// What Rust `run_host::{vault, local_models, host_info}` (`ProcessServices::production`) must
// answer as Node does, recorded from Node's own code:
//
//  - host.json: the User-Agent platform tuple `codexUserAgent()` builds from `os.type()`,
//    `os.release()` and `os.arch()` (codex-client-meta.mjs `_osType`, `_arch`), for fixed inputs.
//  - secrets.json: the keychain files `lib/keychain-cjs.cjs` writes and reads. `dpapi` is what
//    Windows `setSecret` stores (`secrets/<account>.dpapi`, the base64 of a DPAPI blob) with the
//    value `getSecret` answers; only the blob header (`filePrefix`, user-independent) is kept,
//    because a blob decrypts only for the user who made it: the Rust test encrypts with the same
//    PowerShell DPAPI call at test time. `fallback` is the Linux
//    private file (`secrets/<encodeURIComponent(account)>.secret`) of a host with no keychain
//    provider, recorded by running the same code as `linux` with no `secret-tool` on PATH.
//  - local-models.json: `localProviderModelEntry`, the registered-models index Node writes and
//    `localModelState(model).capabilities.tools` after a model load.
//
//   node benchmarks/rust-core/recorders/record-process-services.mjs [--tree <dir>]
//
// Output: native/core/fixtures/process-services/.
process.env.TZ = 'UTC';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
if (process.platform !== 'win32') throw new Error('the DPAPI golden is recorded on Windows');
const finalDir = join(FIXTURES_ROOT, 'process-services');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-process-services.mjs';
const at = (path) => importFrom(tree, path);
const scratch = () => mkdtempSync(join(tmpdir(), 'process-services-'));

// ---- host ------------------------------------------------------------------------------

process.env.MIXDOG_DATA_DIR = scratch();
delete process.env.TERM_PROGRAM;
delete process.env.MIXDOG_CODEX_USER_AGENT;
delete process.env.MIXDOG_CODEX_ORIGINATOR;
const meta = await at('src/runtime/agent/orchestrator/providers/codex-client-meta.mjs');
const real = { type: os.type, release: os.release, arch: os.arch };
const platformOf = (userAgent) => userAgent.slice(userAgent.indexOf('(') + 1, userAgent.lastIndexOf(')'));
const hostCases = [
  ['Windows_NT', '10.0.26100', 'x64'],
  ['Windows_NT', '10.0.22631', 'arm64'],
  ['Darwin', '24.1.0', 'arm64'],
  ['Darwin', '23.6.0', 'x64'],
  ['Linux', '6.8.0-45-generic', 'x64'],
  ['Linux', '5.15.0-1052-aws', 'arm64'],
  ['Linux', '6.1.0-13-686', 'ia32'],
  ['Linux', '4.19.0', 'arm'],
  ['FreeBSD', '14.1-RELEASE', 'x64'],
].map(([type, release, arch]) => {
  os.type = () => type;
  os.release = () => release;
  os.arch = () => arch;
  return { type, release, arch, platform: platformOf(meta.codexUserAgent()) };
});
Object.assign(os, real);
writeJson(join(stage, 'host.json'), { cases: hostCases });

// ---- secrets ---------------------------------------------------------------------------

const keychain = (await at('src/lib/keychain-cjs.cjs')).default;
const values = [
  ['agent.openrouter.apiKey', 'sk-DUMMY-openrouter-0123456789'],
  ['agent.custom-acme.apiKey.k1', 'sk-DUMMY-additional'],
  ['agent.unicode.apiKey', 'sk-DUMMY-키-ключ-\u{1F511}'],
  ['agent.padded.apiKey', '  sk-DUMMY-padded \n'],
  ['agent.lines.apiKey', 'sk-DUMMY-first\nsk-DUMMY-second'],
  ['agent.long.apiKey', `sk-DUMMY-${'0123456789abcdef'.repeat(250)}`],
  ['mcp-oauth.0f1e2d', '{"tokens":{"access_token":"DUMMY","refresh_token":"DUMMY"}}'],
];

// The DPAPI blob header (version, provider GUID) is the same for every user; the rest is not.
const FILE_PREFIX = 28;
const dpapiDir = scratch();
process.env.MIXDOG_DATA_DIR = dpapiDir;
const dpapi = values.map(([account, value]) => {
  keychain.setSecret(account, value);
  return {
    account,
    value,
    expected: keychain.getSecret(account),
    filePrefix: readFileSync(join(dpapiDir, 'secrets', `${account}.dpapi`), 'utf8').slice(0, FILE_PREFIX),
  };
});

const fallbackDir = scratch();
process.env.MIXDOG_DATA_DIR = fallbackDir;
const savedPath = process.env.PATH;
process.env.PATH = '';
Object.defineProperty(process, 'platform', { value: 'linux' });
const fallbackAccounts = [
  ['agent.openai.apiKey', 'sk-DUMMY-fallback'],
  ['agent.custom-é.apiKey.k 1', '  sk-DUMMY-spaced\n'],
  ['mcp-oauth.a/b?c', 'sk-DUMMY-odd-account'],
];
const fallback = fallbackAccounts.map(([account, value]) => {
  keychain.setSecret(account, value);
  return { account, value, hasFallback: keychain.hasFallbackSecret(account), expected: keychain.getSecret(account) };
});
const files = Object.fromEntries(readdirSync(join(fallbackDir, 'secrets')).map((name) => [name, readFileSync(join(fallbackDir, 'secrets', name), 'utf8')]));
const absent = { account: 'agent.never.apiKey', hasFallback: keychain.hasFallbackSecret('agent.never.apiKey') };
Object.defineProperty(process, 'platform', { value: 'win32' });
process.env.PATH = savedPath;
writeJson(join(stage, 'secrets.json'), {
  dpapi: { filePrefix: FILE_PREFIX, cases: dpapi },
  fallback: { cases: fallback, files, absent },
});

// ---- local models ----------------------------------------------------------------------

const dataDir = scratch();
process.env.MIXDOG_DATA_DIR = dataDir;
const catalog = await at('src/runtime/local-provider/catalog.mjs');
const registered = await at('src/runtime/local-provider/registered-models.mjs');
const state = await at('src/runtime/local-provider/model-state.mjs');
const registeredEntry = (n, extra) => {
  const id = `hf-${n.toString(16).padStart(24, '0')}`;
  const [repository, revision, remoteFilename] = ['owner/name', 'a'.repeat(40), 'dir/m q.gguf'];
  return {
    id,
    filename: `${id}.gguf`,
    remoteFilename,
    repository,
    revision,
    url: registered.huggingFaceFileUrl(repository, revision, remoteFilename),
    size: 100,
    sha256: 'b'.repeat(64),
    contextWindow: 16384,
    estimatedVramBytes: 200,
    minimumVramBytes: 200,
    ...extra,
  };
};
const hf = [
  registeredEntry(1, { name: 'owner/name · m q.gguf', supportsFunctionCalling: null }),
  registeredEntry(2, { name: 'Tool model', supportsFunctionCalling: true }),
  registeredEntry(3, { name: 'No tool model', supportsFunctionCalling: false }),
  registeredEntry(4, {}),
];
for (const entry of hf) registered.registerLocalModel(entry, dataDir);
const ids = [...catalog.LOCAL_PROVIDER_MANIFEST.models.map((m) => m.id), ...hf.map((m) => m.id), 'hf-unknown', ''];
const entries = ids.map((id) => {
  const entry = catalog.localProviderModelEntry(id, dataDir);
  return { id, entry: entry && { name: entry.name ?? null, supportsFunctionCalling: entry.supportsFunctionCalling ?? null } };
});
const loads = [
  { id: 'load-none', props: undefined },
  { id: 'load-empty', props: {} },
  { id: 'load-both', props: { chat_template_caps: { supports_tools: true, supports_tool_calls: true } } },
  { id: 'load-tools-only', props: { chat_template_caps: { supports_tools: true } } },
  { id: 'load-calls-denied', props: { chat_template_caps: { supports_tools: true, supports_tool_calls: false } } },
  { id: 'load-tools-denied', props: { chat_template_caps: { supports_tools: false, supports_tool_calls: true } } },
  { id: 'load-strings', props: { chat_template_caps: { supports_tools: 'true', supports_tool_calls: 'true' } } },
].map(({ id, props }) => {
  state.recordLocalModelLoad(id, props, 12);
  return { id, props: props ?? null, tools: state.localModelState(id).capabilities.tools };
});
const never = { id: 'never-loaded', capabilities: state.localModelState('never-loaded').capabilities ?? null };
writeJson(join(stage, 'local-models.json'), {
  index: readFileSync(join(dataDir, 'local-provider', 'registered-models.json'), 'utf8'),
  entries,
  loads,
  never,
});

writeSetManifest(stage, { set: 'process-services', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
