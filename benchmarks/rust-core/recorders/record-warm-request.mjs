#!/usr/bin/env node
// What a cache warm replays (WP-AI-CORE): the REAL `sideQuestionRequestSnapshot` (the request the
// side-question store keeps of a send: the messages BEFORE the tail reminder, which
// `sendWithRecovery` adds to its own copy) and the REAL `cacheWarmSend` (the warm's send: the same
// messages with the ephemeral tail reminder, the model, `tools` undefined when empty, the
// options with `maxOutputTokensOverride: 1`). Rust must keep the same request and build the same
// warm.
//
//   node benchmarks/rust-core/recorders/record-warm-request.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/warm-request/golden.json. The reminder text of a context is the
// tail-reminder golden's business (fixtures/agent/tail_reminder); here only its place in the warm
// request matters, so each case records the whole warm message list. Every user directory is a
// fresh temp one BEFORE any product module loads.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'warm-request-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'warm-request');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-warm-request.mjs';
const S = 'src/runtime/agent/orchestrator/session';
const { sideQuestionRequestSnapshot } = await importFrom(tree, `${S}/side-question-store.mjs`);
const { cacheWarmSend } = await importFrom(tree, `${S}/cache-warm.mjs`);

const KO = { id: 'ko', name: '한국어' };
const EN = { id: 'en', name: 'English' };
const SESSIONS = [
  { role: 'lead', session: (provider, language) => ({ id: 's1', provider, responseLanguage: language }) },
  { role: 'bot', session: (provider, language) => ({ id: 's1', provider, sessionMode: 'agent', responseLanguage: language }) },
  { role: 'worker', session: (provider, language) => ({ id: 's1', provider, owner: 'agent', responseLanguage: language }) },
];
// The one tail-reminder rule is Claude Opus 5.5 + Korean + lead/bot, so those models (also in the
// dotted and gateway-prefixed spellings the family fold accepts) are where a reminder appears.
const PROVIDERS = [
  ['anthropic-oauth', 'claude-opus-4-7'],
  ['anthropic', 'claude-sonnet-4-6'],
  ['openai', 'gpt-5.4'],
  ['gemini', 'gemini-2.5-pro'],
  ['anthropic-oauth', 'claude-opus-5-5'],
  ['anthropic', 'claude-opus-5.5'],
  ['openrouter', 'anthropic/claude-opus-5-5-20260101'],
];
const TOOLS = [
  { name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } },
  { name: 'write', description: 'Write a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } },
];
const MESSAGES = [
  { role: 'system', content: 'You are the bot.' },
  { role: 'user', content: 'Check the feed.' },
  { role: 'assistant', content: 'All quiet.' },
  { role: 'user', content: 'And now?' },
];

const cases = [];
for (const [provider, model] of PROVIDERS) {
  for (const { role, session } of SESSIONS) {
    for (const [languageName, language] of [['ko', KO], ['en', EN], ['none', null]]) {
      for (const tools of [[], TOOLS]) {
        const opts = { session: session(provider, language), fast: false, effort: 'high' };
        const request = { provider: { name: provider }, model, ...sideQuestionRequestSnapshot({ provider: { name: provider }, model, messages: MESSAGES, tools, opts }) };
        const send = cacheWarmSend(request, { signal: undefined });
        cases.push({
          provider,
          model,
          role,
          language: languageName,
          messages: MESSAGES,
          tools: tools.map((t) => t.name),
          saved: { messages: request.messages, tools: request.tools.map((t) => t.name) },
          warm: {
            messages: send.messages.map((m) => ({ role: m.role, content: m.content, source: m.meta?.source ?? null })),
            model: send.model,
            tools: send.tools ? send.tools.map((t) => t.name) : null,
            maxOutputTokensOverride: send.opts.maxOutputTokensOverride,
          },
        });
      }
    }
  }
}
writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, { set: 'warm-request', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
