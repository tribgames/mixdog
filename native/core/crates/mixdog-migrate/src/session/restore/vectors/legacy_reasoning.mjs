// Regenerates legacy_reasoning.json: the Responses `input` items Node's legacy path
// (`openai-responses-input.mjs` `pushReasoningItems`, 1.4.5 = this file unchanged) emits for
// an assistant message that carries `reasoningItems` and no `providerReplay`, from Node's own
// `convertMessagesToResponsesInput`.
//
//   node legacy_reasoning.mjs <mixdog repo root> <migration corpus> > legacy_reasoning.json
//
// The corpus has no message with `reasoningItems` (1.4.5 keeps them only beside no
// `providerReplay`, and its writers always add one), so each case is a corpus assistant
// message with its replay fields removed and the same `reasoningItems` set, as a session of a
// version before 0.9.152 stores it. Options are `buildRequestBody`'s
// (`openai-responses-payload.mjs:232-240`) for the message's provider: `codexWireParity` only
// for `openai-oauth` (the default of a message without `accountRouting`), native tool search
// and encrypted reasoning replay on. Each entry's `items` are the message's own items (the
// call outputs `ensureResponsesCallOutputs` synthesizes for its unanswered calls removed).
// The script also replays every case as a `providerReplay` of those items and fails unless
// Node then sends exactly the same items.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, corpus] = process.argv.slice(2);
const { convertMessagesToResponsesInput } = await import(
  pathToFileURL(join(repo, 'src/runtime/agent/orchestrator/providers/openai-responses-input.mjs')).href
);

const REASONING_ITEMS = [
  { id: 'rs_before', encrypted_content: 'ENC_BEFORE', summary: [{ type: 'summary_text', text: 'plan' }] },
  { id: '', encrypted_content: 'ENC_NO_ID' },
  { type: 'reasoning', id: 'rs_after', encrypted_content: 'ENC_AFTER', summary: [], afterText: true },
  { id: 'rs_no_content', summary: [] },
  { type: 'message', id: 'msg_not_reasoning', encrypted_content: 'ENC_SKIPPED' },
];

function corpusMessage(file, index) {
  const session = JSON.parse(readFileSync(join(corpus, 'v145', 'sessions', file), 'utf8'));
  return session.messages[index];
}

function legacy(message, provider, change = (m) => m) {
  const { providerReplay, assistantBlocks, thinkingBlocks, providerMetadata, ...rest } = message;
  const out = change({ ...rest });
  if (provider) out.providerMetadata = { accountRouting: { provider } };
  out.reasoningItems = REASONING_ITEMS;
  return out;
}

const TEXT_CALLS = ['sess_daemon_1793103478485_a6d73552104e4655ad3c5045f7e90530.json', 5];
const CALL_ONLY = ['sess_daemon_1793265746767_1482e78a13ea4815a6818a9aca474c9c.json', 8];
const TEXT_ONLY = ['sess_daemon_1793265746767_1482e78a13ea4815a6818a9aca474c9c.json', 22];
const source = ([file, index]) => `v145/${file}#${index}`;

const cases = [
  { name: 'text and tool calls, no accountRouting', source: source(TEXT_CALLS), message: legacy(corpusMessage(...TEXT_CALLS)) },
  { name: 'text and tool calls, public openai', source: source(TEXT_CALLS), message: legacy(corpusMessage(...TEXT_CALLS), 'openai') },
  { name: 'tool call, empty text', source: source(CALL_ONLY), message: legacy(corpusMessage(...CALL_ONLY), 'openai-oauth') },
  { name: 'text only', source: source(TEXT_ONLY), message: legacy(corpusMessage(...TEXT_ONLY), 'openai-oauth') },
  {
    name: 'synthetic: native search, custom and namespaced calls with a phase',
    source: source(CALL_ONLY),
    message: legacy(corpusMessage(...CALL_ONLY), 'openai-oauth', (m) => ({
      ...m,
      content: 'Loading the tools first.',
      phase: 'commentary',
      toolCalls: [
        { id: 'call_search', name: 'load_tool', arguments: { names: ['shell'] }, nativeType: 'tool_search_call' },
        { id: 'call_patch', name: 'apply_patch', arguments: { patch: '*** Begin Patch' }, nativeType: 'custom_tool_call' },
        { id: 'call_ns', name: 'tool_search', namespace: 'ns', arguments: { q: 1.5 } },
      ],
    })),
  },
];

function lower(message) {
  const provider = message.providerMetadata?.accountRouting?.provider || 'openai-oauth';
  const input = convertMessagesToResponsesInput([message], {
    nativeToolSearchProvider: provider,
    nativeToolSearch: true,
    replayEncryptedReasoning: true,
    codexWireParity: provider === 'openai-oauth',
  });
  return input.filter((item) => !String(item?.type || '').endsWith('_output'));
}

const out = cases.map(({ name, source, message }) => {
  const items = lower(message);
  const { reasoningItems, ...rest } = message;
  const replayed = lower({ ...rest, providerReplay: { version: 1, provider: 'openai-responses', items } });
  if (JSON.stringify(replayed) !== JSON.stringify(items)) {
    throw new Error(`${name}: the replayed envelope sends ${JSON.stringify(replayed)}`);
  }
  return { name, source, message, items };
});
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
