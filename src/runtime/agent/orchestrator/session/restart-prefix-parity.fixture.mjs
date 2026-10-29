// Child process of restart-prefix-parity.slow.test.mjs: one phase of a scripted
// anthropic-oauth session in its own process, so a "restart" is a real new
// process reading the data dir the previous one left. The fake provider
// records the request body the real OAuth builder makes for every main-loop
// send (providers/anthropic-oauth.mjs buildRequestBody, after the same
// tool-pair sanitize its send path runs) and answers from a script.
//
//   node restart-prefix-parity.fixture.mjs <phase> <dataDir> <outFile> [sessionId]
//   phase idle    two complete turns, then exit
//   phase killtool    one complete turn; the second turn's second request is
//                     answered with a tool call whose run settles the journal,
//                     prints READY and hangs until the parent kills the process
//   phase killrequest the same, but it hangs in the second request itself
//                     (sent, never answered)
//   phase resume  one turn on the stored session (crash recovery included)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [phase, dataDir, outFile, resumeId] = process.argv.slice(2);
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const workDir = join(dataDir, '..', 'work');
mkdirSync(workDir, { recursive: true });
// The response language defaults to the system locale, and only a Korean one
// gets Opus 5.5's turn-scoped tail reminder (tail-reminder-rules.mjs), so the
// language is pinned: every host sends the same requests. The resume phase
// reads what the first phase wrote.
if (phase !== 'resume') {
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { profile: { language: 'ko' } } }));
}
// One file per call: a repeated read is answered from the read cache, which
// never reaches the tool run the midturn phase hangs in.
for (const name of ['call_1', 'call_2', 'call_3']) writeFileSync(join(workDir, `${name}.txt`), `${name}\n`);

const { createSession } = await import('./manager/session-lifecycle.mjs');
const { askSession } = await import('./manager/ask-session.mjs');
const { settleTurnCheckpointWrites } = await import('./manager/turn-checkpoint.mjs');
const { sanitizeToolPairs } = await import('./context-utils.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../providers/registry.mjs');
const { _buildRequestBodyForCacheSmoke } = await import('../providers/anthropic-oauth.mjs');
const { modelToolSchemaAllowlist } = await import('../runtime-core/tool-profile.mjs');
const { anthropicPrefixChanges, anthropicPrefixFingerprint, anthropicPrefixSessionId, recordAnthropicPrefix } =
  await import('../providers/lib/anthropic-prefix-trace.mjs');

const MODEL = 'claude-opus-5-5';
const USAGE = { inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 };
const thinking = (id) => [{ type: 'thinking', thinking: `plan ${id}`, signature: `sig-${id}` }];
const toolStep = (id) => async () => ({
  content: 'Reading.',
  thinkingBlocks: thinking(id),
  hasThinkingContent: true,
  toolCalls: [{ id, name: 'read', arguments: { path: `${id}.txt` } }],
  stopReason: 'tool_use',
  usage: USAGE,
});
const textStep = (text) => async () => ({
  content: text,
  thinkingBlocks: thinking(text),
  hasThinkingContent: true,
  stopReason: 'end_turn',
  usage: USAGE,
});

const bodies = [];
const changes = [];
let warmBody = null;
let script = [];
let sessionId = resumeId || null;
const provider = {
  name: 'anthropic-oauth',
  contextWindow: 200_000,
  async send(messages, model, tools, opts) {
    if (opts?.requestKind && opts.requestKind !== 'turn') return { content: 'Title', usage: USAGE };
    const body = await _buildRequestBodyForCacheSmoke(sanitizeToolPairs(messages), model, tools || [], opts);
    bodies.push(JSON.parse(JSON.stringify(body)));
    // The diagnostic fingerprint the real send records, and what it reports
    // against the previous request (the record's, after a restart).
    recordAnthropicPrefix(anthropicPrefixSessionId(opts), anthropicPrefixFingerprint(body));
    changes.push(anthropicPrefixChanges(anthropicPrefixSessionId(opts)));
    const step = script.shift();
    if (!step) throw new Error(`unscripted send #${bodies.length}`);
    return step();
  },
};

// Where the interrupted turn stops: the checkpoint made durable, the recorded
// bodies handed over, and nothing ever finishes (the parent kills the process).
const hang = async () => {
  await settleTurnCheckpointWrites(sessionId);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settleTurnCheckpointWrites(sessionId);
  writeFileSync(outFile, JSON.stringify({ sessionId, bodies, changes }));
  process.stdout.write('READY\n');
  return new Promise(() => {});
};
// killtool: in the second tool run of the turn (after its second request settled).
let toolRuns = 0;
const hangInSecondTool = async () => {
  toolRuns += 1;
  if (toolRuns >= 2) await hang();
};

await _withRegisteredProviderForTestAsync('anthropic-oauth', provider, async () => {
  if (phase === 'resume') {
    // The cache warm a restart re-arms (cache-warm.mjs rearmCacheWarmsAfterRestart)
    // replays this request, built before the next turn touches the session.
    const { lastSentMainRequest } = await import('./side-question.mjs');
    const { cacheWarmSend } = await import('./cache-warm.mjs');
    const request = lastSentMainRequest(sessionId);
    if (request) {
      const send = cacheWarmSend(request);
      warmBody = await _buildRequestBodyForCacheSmoke(
        sanitizeToolPairs(send.messages),
        send.model,
        send.tools || [],
        send.opts
      );
    }
    script = [textStep('resumed')];
    await askSession(sessionId, 'third task', null, null, null, null, {});
    return;
  }
  const session = createSession({
    provider: 'anthropic-oauth',
    model: MODEL,
    cwd: workDir,
    skipSkills: true,
    schemaAllowedTools: modelToolSchemaAllowlist('headless'),
    workflow: { id: 'headless', delegatesAgents: false },
  });
  sessionId = session.id;
  if (phase === 'idle') {
    script = [toolStep('call_1'), textStep('done one'), toolStep('call_2'), textStep('done two')];
    await askSession(sessionId, 'first task', null, null, null, null, {});
    await askSession(sessionId, 'second task', null, null, null, null, {});
    return;
  }
  // killrequest: while the turn's second request is on the wire.
  const killTool = phase === 'killtool';
  script = [toolStep('call_1'), textStep('done one'), toolStep('call_2'), killTool ? toolStep('call_3') : hang];
  await askSession(sessionId, 'first task', null, null, null, null, {});
  await askSession(
    sessionId,
    'second task',
    null,
    null,
    null,
    null,
    killTool ? { beforeToolExecution: hangInSecondTool } : {}
  );
});

writeFileSync(outFile, JSON.stringify({ sessionId, bodies, changes, warmBody }));
process.exit(0);
