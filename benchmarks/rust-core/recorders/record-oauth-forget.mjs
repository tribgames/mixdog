#!/usr/bin/env node
// `forget<Provider>OAuthCredentials()` of the ten OAuth providers: the real functions over a
// credential file seeded in a temp data dir. Each scenario records what the function answered
// (`removed`) and what the file holds afterwards (absent, or its content): Anthropic drops only the
// `claudeAiOauth` key, Antigravity overwrites the file with `{}`, the others delete the file. Rust
// `mixdog_core_domains::domains::ai_account::production` (`OAuthProvider::forget`) must answer and
// leave the same.
//
//   node benchmarks/rust-core/recorders/record-oauth-forget.mjs [--tree <dir>]
//
// Output: native/core/fixtures/oauth-forget/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'oauth-forget');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-oauth-forget.mjs';
const dataDir = mkdtempSync(join(tmpdir(), 'oauth-forget-rec-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'oauth-forget-home-'));
// Anthropic also looks in the user's own Claude folder; keep that inside the temp folder.
process.env.HOME = process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'oauth-forget-user-'));
const at = (path) => importFrom(tree, path);
const P = 'src/runtime/agent/orchestrator/providers/';
const modules = {
  'openai-oauth': { m: await at(`${P}openai-oauth-tokens.mjs`), fn: 'forgetOpenAIOAuthCredentials', file: 'openai-oauth.json', env: 'OPENAI_OAUTH_CREDENTIALS_PATH' },
  'anthropic-oauth': { m: await at(`${P}anthropic-oauth-credentials.mjs`), fn: 'forgetAnthropicOAuthCredentials', file: 'anthropic-oauth-credentials.json', env: 'ANTHROPIC_OAUTH_CREDENTIALS_PATH' },
  'grok-oauth': { m: await at(`${P}grok-oauth-tokens.mjs`), fn: 'forgetGrokOAuthCredentials', file: 'grok-oauth.json', env: 'GROK_OAUTH_CREDENTIALS_PATH' },
  'muse-code-oauth': { m: await at(`${P}muse-code-oauth-tokens.mjs`), fn: 'forgetMuseCodeOAuthCredentials', file: 'muse-code-oauth.json', env: 'MUSE_CODE_OAUTH_CREDENTIALS_PATH' },
  'command-code-oauth': { m: await at(`${P}command-code-oauth-tokens.mjs`), fn: 'forgetCommandCodeOAuthCredentials', file: 'command-code-oauth.json', env: 'COMMAND_CODE_OAUTH_CREDENTIALS_PATH' },
  'opencode-go-oauth': { m: await at(`${P}opencode-go-oauth-tokens.mjs`), fn: 'forgetOpenCodeGoOAuthCredentials', file: 'opencode-go-oauth.json', env: 'OPENCODE_GO_OAUTH_CREDENTIALS_PATH' },
  'mimo-oauth': { m: await at(`${P}mimo-oauth-tokens.mjs`), fn: 'forgetMimoOAuthCredentials', file: 'mimo-oauth.json', env: 'MIMO_OAUTH_CREDENTIALS_PATH' },
  'cursor-oauth': { m: await at(`${P}cursor-auth.mjs`), fn: 'forgetCursorOAuthCredentials', file: 'cursor-oauth.json', env: 'CURSOR_OAUTH_CREDENTIALS_PATH' },
  'devin-oauth': { m: await at(`${P}devin-auth.mjs`), fn: 'forgetDevinOAuthCredentials', file: 'devin-oauth.json', env: 'DEVIN_OAUTH_CREDENTIALS_PATH' },
  'antigravity-oauth': { m: await at(`${P}antigravity-oauth-tokens.mjs`), fn: 'forgetAntigravityOAuthCredentials', file: 'antigravity-oauth.json', env: 'ANTIGRAVITY_OAUTH_CREDENTIALS_PATH' },
};

const SIGNED_IN = { access_token: 'a-1', refresh_token: 'r-1', expires_at: 4_000_000_000_000, extra: 'kept?' };
const CASES = {
  default: [
    ['signed in', SIGNED_IN],
    ['no file', null],
    ['an empty document', {}],
  ],
  'anthropic-oauth': [
    ['signed in beside other keys', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 4_000_000_000_000 }, mcpOAuth: { s: 1 } }],
    ['signed in, nothing else', { claudeAiOauth: { accessToken: 'a' } }],
    ['no sign-in in the file', { mcpOAuth: { s: 1 } }],
    ['no file', null],
  ],
};

// The CLI's own credentials file: Node's forget never looks at it.
const claudeFile = join(process.env.HOME, '.claude', '.credentials.json');
const CLAUDE_SIDE = { claudeAiOauth: { accessToken: 'cli-token', refreshToken: 'cli-refresh', expiresAt: 4_000_000_000_000 } };
const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const scenarios = [];
for (const [provider, { m, fn, file, env }] of Object.entries(modules)) {
  const path = join(dataDir, file);
  process.env[env] = path;
  for (const [name, content] of CASES[provider] ?? CASES.default) {
    mkdirSync(dirname(path), { recursive: true });
    if (content !== null) writeFileSync(path, JSON.stringify(content));
    if (provider === 'anthropic-oauth') {
      mkdirSync(dirname(claudeFile), { recursive: true });
      writeFileSync(claudeFile, JSON.stringify(CLAUDE_SIDE));
    }
    const answer = await m[fn]();
    scenarios.push({ provider, name, before: content, answer: typeof answer === 'boolean' ? { removed: answer } : answer, after: read(path), ...(provider === 'anthropic-oauth' ? { cliFileBefore: CLAUDE_SIDE, cliFileAfter: read(claudeFile) } : {}) });
    if (existsSync(path)) writeFileSync(path, '{}');
    try {
      (await import('node:fs')).rmSync(path, { force: true });
    } catch {}
  }
  delete process.env[env];
}
writeJson(join(stage, 'golden.json'), { scenarios });
writeSetManifest(stage, { set: 'oauth-forget', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
