// The scenario of record-sensitive-carry.mjs (Node) and replay-sensitive-carry.mjs (the core): a value marked sensitive in
// one session leaves every other session its text reached. Three Lead conversations in one profile, each with its own code:
//   1. the worker marks the code, then reports it (its report reaches the Lead with the marker);
//   2. the worker reports the code unmarked, the Lead sends it a follow-up, and the worker marks it (the mark reaches the Lead
//      after the report was stored there);
//   3. a chain of three sessions: the first worker reports the code unmarked, the Lead quotes it in a second worker's brief,
//      and later the first worker marks it (the mark reaches the Lead and, from the Lead, the second worker). A worker cannot
//      spawn a sub-agent in either runtime (Node: `agent` is Lead-only for agent workers, pre-dispatch-deny.mjs), so this is
//      the three-level chain the agent tool can make.
// Completions are not woken (`autoWakeCompletions: false`): a queued report reaches its owner at the owner's next turn. Each
// step after the first waits until the completions it needs are queued for the Lead. Every value is a test value.

export const MODEL = 'sensitive-carry-model';
export const CODES = { s1: '482913', s2: '730215', s3: '915604' };
/** The `agent` definition every worker runs (`<data>/agents/helper/AGENT.md`). */
export const AGENT = 'helper';
export const AGENT_MD = '---\nname: helper\ndescription: Does what it is asked.\n---\nYou do what you are asked.\n';

const fill = (id, code) => ({ id, name: 'browser', args: { action: 'fill', input: { ref: 'e1', text: code, sensitive: true } } });
const spawn = (id, tag, prompt) => ({ id, name: 'agent', args: { type: 'spawn', agent: AGENT, tag, provider: '<provider>', model: MODEL, prompt } });
const send = (id, tag, message) => ({ id, name: 'agent', args: { type: 'send', tag, message } });

/**
 * Each conversation's replies, keyed by the text its first user message starts with; the reply a request gets is the one at
 * the number of assistant messages it already holds (the conversations run at once, so a call's place in the provider's
 * order is not fixed). `<provider>` is the provider id of the run (Node's recording and the core take it under different ids).
 */
export const CONVERSATIONS = {
  'S1 lead.': [{ calls: [spawn('s1a', 's1h', 'S1 brief: fill the code and report it.')] }, { text: 'Asked.' }],
  'S1 brief:': [{ calls: [fill('s1f', CODES.s1)] }, { text: `I used ${CODES.s1}.` }],
  'S2 lead.': [
    { calls: [spawn('s2a', 's2h', 'S2 brief: report the code.')] },
    { text: 'Asked.' },
    { calls: [send('s2s', 's2h', 'S2 follow-up: fill the code.')] },
    { text: 'Sent.' },
  ],
  'S2 brief:': [{ text: `The code is ${CODES.s2}.` }, { calls: [fill('s2f', CODES.s2)] }, { text: 'Filled.' }],
  'S3 lead.': [
    { calls: [spawn('s3a', 's3h', 'S3 brief: report the code.')] },
    { text: 'Asked.' },
    { calls: [spawn('s3b', 's3k', `S3 keeper brief: keep the code ${CODES.s3}.`)] },
    { text: 'Asked another.' },
    { calls: [send('s3s', 's3h', 'S3 follow-up: fill the code.')] },
    { text: 'Sent.' },
  ],
  'S3 brief:': [{ text: `The code is ${CODES.s3}.` }, { calls: [fill('s3f', CODES.s3)] }, { text: 'Filled.' }],
  'S3 keeper brief:': [{ text: 'Kept.' }],
};
/** The reply past a conversation's script: when a runtime hands a queued report to a turn that has answered, it asks again. */
const DEFAULT_REPLY = { text: 'Noted.' };

/**
 * The Lead turns, in order. `waitFor` names how many completions must have been queued for a session before the turn starts:
 * `lead` the step's Lead, a tag the worker of that tag (counted from the start of the run).
 */
export const STEPS = [
  { lead: 'S1 lead.', prompt: 'S1 lead. Ask a helper for the code.' },
  { lead: 'S1 lead.', prompt: 'What did it report?', waitFor: { lead: 1 } },
  { lead: 'S2 lead.', prompt: 'S2 lead. Ask a helper for the code.' },
  { lead: 'S2 lead.', prompt: 'Have it fill the code.', waitFor: { lead: 1 } },
  { lead: 'S2 lead.', prompt: 'What now?', waitFor: { lead: 2 } },
  { lead: 'S3 lead.', prompt: 'S3 lead. Ask a helper for the code.' },
  { lead: 'S3 lead.', prompt: 'Give the code to a keeper.', waitFor: { lead: 1 } },
  { lead: 'S3 lead.', prompt: 'Have the first helper fill the code.', waitFor: { lead: 2 } },
  { lead: 'S3 lead.', prompt: 'What now?', waitFor: { lead: 3 } },
];

/** The conversation a provider request belongs to: the key its first user message holds (a runtime may put text of its own
 *  around a worker's brief). */
export function conversationOf(firstUserText) {
  const text = String(firstUserText ?? '');
  return Object.keys(CONVERSATIONS)
    .filter((key) => text.includes(key))
    .sort((a, b) => b.length - a.length)[0] ?? null;
}

/** The reply to a request of conversation `key` already holding `assistants` assistant messages, `<provider>` filled in. */
export function replyFor(key, assistants, providerId) {
  if (!CONVERSATIONS[key]) return null;
  const step = CONVERSATIONS[key][assistants] ?? DEFAULT_REPLY;
  return JSON.parse(JSON.stringify(step).split('<provider>').join(providerId));
}

/** The text of an OpenAI-chat message: its content and its tool calls' arguments. */
const messageText = (m) =>
  (typeof m.content === 'string' ? m.content : (m.content ?? []).map((part) => part.text ?? '').join('')) +
  (m.tool_calls ?? []).map((c) => c.function?.arguments ?? '').join('');

/**
 * The scripted OpenAI-chat provider both runtimes call (Node's recording through its custom provider, the core likewise):
 * each request is answered by `replyFor` and recorded in `calls` as its conversation, its place in it and what it shows of
 * the codes. An unscripted request is recorded with its text and answered `unscripted`.
 */
export async function scriptedProvider(calls, providerId, { held = () => null } = {}) {
  const { createServer } = await import('node:http');
  const chunk = (delta, finish = null) => ({ id: 's', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
  const usage = { id: 's', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  const server = createServer((req, res) => {
    const body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', async () => {
      if (req.method === 'GET' || !body.length) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      }
      const messages = JSON.parse(Buffer.concat(body).toString('utf8')).messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
      const key = conversationOf(messageText(messages.find((m) => m.role === 'user') ?? {}));
      const at = messages.filter((m) => m.role === 'assistant').length;
      const text = messages.map(messageText).join('\n');
      const step = key ? replyFor(key, at, providerId) : null;
      calls.push({ key, at, ...exposure(text), ...(step && !process.env.SENSITIVE_CARRY_TEXT ? {} : { text }) });
      // A worker's call is answered once its Lead is idle (`held`), so a report never lands while the Lead's turn runs.
      await held(key);
      const out = !step
        ? [chunk({ role: 'assistant', content: 'unscripted' }), chunk({}, 'stop')]
        : step.calls
          ? [chunk({ role: 'assistant', tool_calls: step.calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }), chunk({}, 'tool_calls')]
          : [chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop')];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of [...out, usage]) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { baseURL: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(c); }) };
}

/** The Lead a conversation belongs to (its own key for a Lead's): the scenario's number. */
export const leadOf = (key) => `${String(key).slice(0, 2)} lead.`;

/**
 * The harness side of `scriptedProvider`'s `held`: `turn(lead, run)` marks the Lead busy while `run()` runs, and `held(key)`
 * resolves once the conversation's Lead is not (at once for a Lead's own calls).
 */
export function leadTurns() {
  const busy = new Map();
  return {
    async turn(lead, run) {
      let done;
      busy.set(lead, new Promise((resolve) => { done = resolve; }));
      try {
        return await run();
      } finally {
        busy.delete(lead);
        done();
      }
    },
    held(key) {
      const lead = leadOf(key);
      return key === lead ? null : (busy.get(lead) ?? null);
    },
  };
}

/** The calls of a run in a fixed order (conversation, then place), for comparing two runs whose calls interleave. */
export const orderedCalls = (calls) => [...calls].sort((x, y) => String(x.key).localeCompare(String(y.key)) || x.at - y.at);

/** What a request's text shows of the codes: per code whether it is there in plain, and how many markers it holds. */
export function exposure(text) {
  return { plain: Object.fromEntries(Object.entries(CODES).map(([k, code]) => [k, text.includes(code)])), markers: text.split('[redacted]').length - 1 };
}
