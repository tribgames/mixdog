#!/usr/bin/env node
// Golden twin of the session side of a conversation import (`imported-session.mjs`
// `createImportedSession`, over the real `createSession`/`saveSessionAsync` of the session
// store, with a stub provider that fails if a turn ever runs): for each conversation the stored
// session as Node leaves it (identity, placement, provenance, title, the plain user/assistant
// rows after the system layer) and the calls made on the way (content-search ingest, provider
// sends). The random ids (session id, `msg_<32 hex>`) are checked by shape and recorded by their
// position; every other value is recorded as stored. Rust `session::import_sessions` must store
// the same header fields and rows.
//
//   node benchmarks/rust-core/recorders/record-import-session.mjs --tree <dir>
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

export const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

// Every path the recorded code sees is this one, on both sides.
export const PIN = join(parse(tmpdir()).root, 'mixdog-twin', 'import-session');
rmSync(PIN, { recursive: true, force: true });
const data = join(PIN, 'data');
mkdirSync(data, { recursive: true });
process.env.MIXDOG_DATA_DIR = data;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const tree = resolveTree(parseArgs());
const dir = 'src/runtime/agent/orchestrator';
const { createSession } = await importFrom(tree, `${dir}/session/manager/session-lifecycle.mjs`);
const { loadSession } = await importFrom(tree, `${dir}/session/store.mjs`);
const { _withRegisteredProviderForTestAsync } = await importFrom(tree, `${dir}/providers/registry.mjs`);
const { convertConversationText } = await importFrom(tree, `${dir}/session/conversation-import/convert.mjs`);
const { buildImportOrigin, createImportedSession, importedSessionOptions } = await importFrom(tree, `${dir}/session/conversation-import/imported-session.mjs`);

const providerName = 'conversation-import-twin';
let sends = 0;
const provider = {
  name: providerName,
  contextWindow: 128000,
  async send() {
    sends += 1;
    throw new Error('no turn runs during import');
  },
};
const leadOptions = { provider: providerName, model: 'fake-model', owner: 'cli', agent: 'lead', lane: 'cli', sourceType: 'lead', sourceName: 'main', skipSkills: true };

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n');
const codex = (id, cwd, ...turns) =>
  jsonl([
    { type: 'session_meta', payload: { id, cwd } },
    ...turns.map(([role, text]) => ({
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] },
    })),
  ]);
const CASES = [
  { name: 'project-with-tools', source: 'codex', path: 'rollout-a.jsonl', cwd: join(PIN, 'project'), text: () => jsonl([
    { type: 'session_meta', payload: { id: 'foreign-1', cwd: join(PIN, 'project') } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Earlier reply' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next step please' }] } },
  ]) },
  { name: 'task-no-cwd', source: 'codex', path: 'rollout-b.jsonl', cwd: null, text: () => codex('foreign-2', '', ['user', 'Hello there'], ['assistant', 'Hi!']) },
];

const ID = /^[0-9a-zA-Z_-]{8,}$/;
const MSG = /^msg_[0-9a-f]{32}$/;
const out = [];
mkdirSync(join(PIN, 'project'), { recursive: true });
await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
  for (const c of CASES) {
    const conversation = convertConversationText(c.source, c.text());
    const origin = buildImportOrigin({
      source: c.source,
      sourcePath: join(PIN, c.path),
      foreignSessionId: conversation.foreignSessionId,
      sourceCwd: conversation.cwd,
      importedAt: FIXED_NOW,
    });
    const desktopSession = c.cwd ? { classification: 'project', projectPath: c.cwd } : { classification: 'task', projectPath: null };
    const ingested = [];
    const created = await createImportedSession({ leadOptions, conversation, origin, cwd: c.cwd, desktopSession, ingestFn: (s) => ingested.push([s.id, s.messages.length]) });
    const reference = createSession(importedSessionOptions(leadOptions, { cwd: c.cwd, desktopSession }));
    const systemCount = reference.messages.filter((m) => m.role === 'system').length;
    const stored = loadSession(created.id);
    if (!ID.test(created.id)) throw new Error(`session id ${created.id} has an unexpected shape`);
    const rows = stored.messages.slice(systemCount).map((m) => {
      if (!MSG.test(m.meta.transcript.messageId)) throw new Error(`message id ${m.meta.transcript.messageId} has an unexpected shape`);
      return { role: m.role, content: m.content, meta: { ...m.meta, transcript: { ...m.meta.transcript, messageId: '<msg_32hex>' } } };
    });
    const header = {};
    for (const key of ['owner', 'agent', 'lane', 'sourceType', 'sourceName', 'parentSessionId', 'ownerSessionId', 'visibility', 'clientHostPid', 'mcpScopeId', 'cwd', 'desktopSession', 'provider', 'model', 'title', 'importOrigin']) {
      header[key] = stored[key] === undefined ? { absent: true } : stored[key];
    }
    out.push({
      name: c.name,
      input: { source: c.source, text: c.text(), cwd: c.cwd, sourcePath: origin.sourcePath, importedAt: FIXED_NOW },
      header,
      rows,
      systemRowsFirst: stored.messages.slice(0, systemCount).every((m) => m.role === 'system'),
      ingested: ingested.map(([, count]) => ({ idIsSession: true, messages: count - systemCount, withSystem: count })),
      ingestedId: ingested.length === 1 && ingested[0][0] === created.id,
      providerSends: sends,
    });
  }
});
writeJson(join(FIXTURES_ROOT, 'services', 'import-session-twin.json'), { domain: 'import-session-twin', recorder: 'benchmarks/rust-core/recorders/record-import-session.mjs', pin: PIN, clock: FIXED_NOW, cases: out });
console.log(`recorded ${out.length} imports`);
// The session writer still holds its lock file; the sandbox is swept on the next run.
process.exit(0);
