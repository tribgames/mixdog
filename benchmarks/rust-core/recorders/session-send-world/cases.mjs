// The cases of a `session` tool send in a whole app (world.mjs records them on Node, replay.mjs replays them on the core), and what both
// sides share: the model endpoint's script (`createModel`), the data folder a case starts from (`prepareData`), the case's driver
// (`runSteps`) over a side's app (Node's `DesktopServiceClient`, the core's desktop service lane), and the recording's normal form
// (`normalized`).
//
// The model endpoint answers each turn's request by what the request asks, never by its order:
//   a tool's result     the model got a tool's answer: it ends its turn (`Done.`), or, for a `FAILNEXT` turn, the endpoint refuses the
//                       request (HTTP 400, `invalid_request_error`): a failure no retry repeats, so the turn fails at once
//   `NOTES:`            an earlier turn the model answers with the padding (`PAD`) a compaction summarizes: Node keeps the latest
//                       request verbatim, and stores a prompt this long as an attachment the compaction does not measure
//   a mark              the latest user message names the step: `KICK` calls the `session` tool with the case's `call` (aliases `@X` become
//                       session ids), `COMPACTME` calls it with `{action: 'compact'}`, `WORK:` is the sent turn (the case's `work` answer),
//                       `BUSY:` a turn held until a step lets it go, `QUEUED:` a prompt queued behind it
//   a compaction        the request that summarizes a conversation (its last user message asks for the summary): `SUMMARY OF THE WORK.`
//   anything else       `Noted.` (a task's first turn, a bot's wake turn on a report)
// An answer marked `hold` waits until a step releases it (or the daemon that asked goes away).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:\\mixdog-build\\tmp\\session-send-world\\cases';
export const caseRoot = (c) => join(ROOT, c.name);
export const FINAL = 'The final answer of the sent turn.';
export const SUMMARY = 'SUMMARY OF THE WORK.';
export const MODEL = { provider: 'custom-harness', model: 'harness-model' };
/** Every wait of a step: the longest a Node or core step took on this PC is well under it. */
const STEP_MS = 120_000;
/** A conversation long enough that a compaction asks the model for its summary: Node summarizes once the conversation reaches
 *  `conversationThresholdTokens` (fresh-context.mjs: at most 20 000 tokens), below it the compaction is rules only and asks nothing. */
export const PAD = Array.from({ length: 9000 }, (_, i) => `filler ${i}.`).join(' ');
const PAD_RUN = /filler \d+\.?(?: filler \d+\.?)*/g;

/** The text of one chat message as the model gets it (a string, or its text parts joined). */
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '');

/** The settings and the bots a case's data folder starts with, on either side. */
export function prepareData(dataDir, baseURL, c) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'mixdog-config.json'),
    JSON.stringify({
      agent: {
        providers: { [MODEL.provider]: { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL, auth: 'none', enabled: true, modelOverrides: { [MODEL.model]: { manual: true } } } },
        default: 'main',
        presets: [{ id: 'main', name: 'main', ...MODEL }],
      },
    }),
  );
  for (const bot of c.bots ?? []) {
    const dir = join(dataDir, 'agents', bot.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ name: bot.name }));
    writeFileSync(join(dir, 'AGENT.md'), `---\nkind: bot\n---\n\n${bot.name} helps with builds.\n`);
  }
}

const MARKS = ['KICK', 'COMPACTME', 'WORK:', 'BUSY:', 'QUEUED:', 'FAILNEXT', 'NOTES:'];

/** The model endpoint: answers by the case's script, records every request it answered (`requests`), and lets the driver wait on what it saw. */
export function createModel(c) {
  const trace = [];
  const requests = [];
  const held = new Map();
  const wakers = new Set();
  const aliases = new Map();
  const stir = () => {
    for (const wake of [...wakers]) wake();
  };
  const started = Date.now();
  const note = (what) => {
    trace.push(what);
    process.stderr.write(`${c.name} +${Date.now() - started}ms: ${what}\n`);
  };
  const resolveAliases = (value) => JSON.parse(JSON.stringify(value).replace(/"@([A-Z][A-Za-z0-9]*)"/g, (_, alias) => JSON.stringify(aliases.get(alias) ?? `@${alias}`)));
  const classify = (messages) => {
    const lastUser = textOf([...messages].reverse().find((m) => m.role === 'user')?.content);
    // The compaction summary request quotes the conversation, marks included: isolated (`buildCompactionPrompt`) or forked from the
    // session's own request (`forkedCompactionPrompt`), compact/summary.mjs.
    if (lastUser.includes('<conversation-history>') || lastUser.includes('<compaction-request>')) return 'compaction';
    const mark = MARKS.find((each) => lastUser.includes(each));
    if (messages.at(-1)?.role === 'tool') return mark === 'FAILNEXT' ? 'fail' : 'tool-result';
    return mark ? mark.replace(':', '').toLowerCase() : 'other';
  };
  const answerOf = (kind) => {
    const scripted = c.answers?.[kind];
    if (scripted) return { ...scripted, args: scripted.args && resolveAliases(scripted.args) };
    if (kind === 'tool-result') return { text: 'Done.' };
    if (kind === 'kick') return { tool: 'session', args: resolveAliases(c.call) };
    if (kind === 'compactme' || kind === 'failnext') return { tool: 'session', args: { action: 'compact' } };
    if (kind === 'fail') return { status: 400 };
    if (kind === 'notes') return { text: PAD };
    if (kind === 'work') return { text: FINAL };
    if (kind === 'busy') return { hold: true, text: 'Busy done.' };
    if (kind === 'compaction') return { text: SUMMARY };
    return { text: 'Noted.' };
  };
  const stream = (res, answer, streamed = true) => {
    if (!streamed && !answer.status) {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ id: 'chatcmpl-send', object: 'chat.completion', model: MODEL.model, choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    }
    if (answer.status) {
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: 'The harness endpoint refused this turn.', type: 'invalid_request_error' } }));
    }
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-send', object: 'chat.completion.chunk', created: 1700000000, model: MODEL.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(chunk({ role: 'assistant', content: '' }));
    if (answer.tool) {
      res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: answer.tool, arguments: JSON.stringify(answer.args) } }] }));
      res.write(chunk({}, 'tool_calls'));
    } else {
      res.write(chunk({ content: answer.text }));
      res.write(chunk({}, 'stop'));
    }
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-send', object: 'chat.completion.chunk', model: MODEL.model, choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  return {
    trace,
    requests,
    aliases,
    stir,
    note,
    serve(req, res) {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        if (req.method === 'HEAD') return void res.end();
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json');
          return void res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL.model, object: 'model' }] }));
        }
        const body = JSON.parse(raw || '{}');
        const messages = (body.messages ?? []).filter((m) => m.role !== 'system');
        const kind = classify(messages);
        // A failing turn's unstreamed recovery (`recoverCompatNonStreaming`) fails as its streamed request did.
        if (body.stream !== true && kind !== 'compaction' && kind !== 'fail') {
          // A title: not part of a case.
          note(`unstreamed request: ${JSON.stringify(messages.map((m) => `${m.role}: ${textOf(m.content).slice(0, 160)}`))}`);
          res.setHeader('content-type', 'application/json');
          return void res.end(JSON.stringify({ id: 'chatcmpl-send', object: 'chat.completion', model: MODEL.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Title' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
        const answer = answerOf(kind);
        // Two sessions asking at once arrive in either order; `after` has the endpoint take this request only once a request of that
        // kind was taken, so the recorded order is the endpoint's own.
        if (answer.after && !requests.some((r) => r.kind === answer.after)) {
          const wake = () => {
            if (!requests.some((r) => r.kind === answer.after)) return;
            wakers.delete(wake);
            take();
          };
          wakers.add(wake);
          return;
        }
        take();
        function take() {
        requests.push({
          kind,
          messages: messages.map((m) => ({ role: m.role, text: textOf(m.content), ...(m.tool_calls ? { calls: m.tool_calls.map((t) => ({ name: t.function?.name, args: t.function?.arguments })) } : {}) })),
        });
        const n = requests.length;
        note(`request ${n}: ${kind}${body.stream === true ? '' : ' (unstreamed)'}`);
        res.once('close', () => note(`request ${n}: ${kind} answered ${res.statusCode}${res.writableFinished ? '' : ' (closed by its caller first)'}`));
        if (answer.hold) {
          const go = () => stream(res, answer, body.stream === true);
          held.set(kind, go);
          res.once('close', () => {
            if (held.get(kind) !== go) return;
            note(`request ${requests.length}: ${kind} closed by its caller while held`);
            held.delete(kind);
            stir();
          });
          stir();
          return;
        }
        stir();
        stream(res, answer, body.stream === true);
        }
      });
    },
    held: (kind) => held.has(kind),
    release(kind) {
      const go = held.get(kind);
      if (!go) throw new Error(`${c.name}: nothing held for ${kind}`);
      held.delete(kind);
      go();
    },
    /** Resolves once `ready()` holds, re-checked whenever the endpoint or a session state stirs; fails naming `what` after `ms`. */
    until(ready, what, ms = STEP_MS) {
      return new Promise((resolve, reject) => {
        const check = () => {
          let value;
          try {
            value = ready();
          } catch (error) {
            done();
            return reject(error);
          }
          if (!value) return;
          done();
          resolve(value);
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error(`${c.name}: ${what}: not within ${ms} ms; seen: ${trace.slice(-12).join(' | ')}`));
        }, ms);
        const done = () => {
          clearTimeout(timer);
          wakers.delete(check);
        };
        wakers.add(check);
        check();
      });
    },
  };
}

/** `run` over every item, `jobs` at a time; the first failure is thrown once every started run has ended. */
export async function eachAtOnce(items, jobs, run) {
  const queue = [...items];
  const failures = [];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await run(item);
      } catch (error) {
        failures.push(error);
        queue.length = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  if (failures.length) throw failures[0];
}

/** One deadline per wait, naming what it waits for. */
export const within = (ms, promise, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
};

/** An app call's answer, or its refusal (the message), as the step's record. */
const outcome = async (promise, what) => {
  try {
    return { answer: (await within(STEP_MS, promise, what)) ?? null };
  } catch (error) {
    if (/not within/.test(error.message)) throw error;
    return { refused: String(error?.message ?? error) };
  }
};

/** What a client shows of a session's conversation: each row's kind and the fields a person reads or a step depends on. */
const ROW_FIELDS = ['kind', 'text', 'status', 'sender', 'fromAgent', 'hop', 'botChain', 'archived', 'compacted', 'level'];
export const rowsOf = (snapshot) =>
  (snapshot?.items ?? []).map((item) => Object.fromEntries(ROW_FIELDS.filter((key) => item[key] !== undefined && item[key] !== '').map((key) => [key, item[key]])));

/** Runs a case's steps over one side's app; the recording is what each step observed. */
export async function runSteps(c, app, model) {
  const steps = [];
  const count = (kind) => model.requests.filter((r) => r.kind === kind).length;
  const id = (alias) => model.aliases.get(alias) ?? `sess_missing_${alias.toLowerCase()}`;
  const rows = (alias) => rowsOf(app.snapshot(id(alias)));
  // The window's submission ids (the renderer's `nextComposerSubmissionId`), scripted in submission order.
  let submitted = 0;
  const submissionId = (alias) => `desktop-submit-${alias}-${(submitted += 1)}`;
  await app.open(within);
  try {
    await runEach(c, app, model, steps, count, id, rows, submissionId);
  } catch (error) {
    // What each client showed when a step failed: the failure's evidence.
    error.shown = Object.fromEntries([...model.aliases.keys()].map((alias) => [alias, { busy: app.busy(id(alias)), rows: rows(alias) }]));
    throw error;
  }
  // What each client is shown at the end, then what is stored: the conversation a client reads once the app started again.
  const shown = Object.fromEntries([...model.aliases.keys()].map((alias) => [alias, rows(alias)]));
  await app.quit(within);
  await app.open(within);
  const stored = {};
  for (const alias of model.aliases.keys()) stored[alias] = (await outcome(app.read(id(alias)).then(rowsOf), `readSessionTranscript ${alias}`));
  await app.quit(within);
  return { steps, requests: model.requests, shown, stored, aliases: Object.fromEntries(model.aliases), root: caseRoot(c), userData: app.userData };
}

async function runEach(c, app, model, steps, count, id, rows, submissionId) {
  for (const step of c.steps) {
    model.note(`step ${JSON.stringify(step)}`);
    // A window shows every session a case opened: their states reach the client from the moment each exists.
    const showAll = () => within(STEP_MS, app.watch([...model.aliases.values()]), 'setVisibleSessions');
    if (step.do === 'home') {
      model.aliases.set(step.as, await within(STEP_MS, app.openHome(step.agent), `openAgentHome ${step.agent}`));
      await showAll();
    } else if (step.do === 'task') {
      const before = count('other');
      model.aliases.set(step.as, await within(STEP_MS, app.newTask(step.prompt, submissionId(step.as)), `submitNewTask ${step.as}`));
      await showAll();
      await model.until(() => count('other') > before, `the first turn of ${step.as}`);
      await model.until(() => app.snapshot(id(step.as)) && !app.busy(id(step.as)), `${step.as} idle after its first turn`);
    } else if (step.do === 'say') steps.push({ say: step.to, ...(await outcome(app.say(id(step.to), step.prompt, { ...step.options, id: submissionId(step.to) }), `submitToSession ${step.to}`)) });
    else if (step.do === 'until') await model.until(() => count(step.request) >= (step.n ?? 1), `request ${step.request} #${step.n ?? 1}`);
    else if (step.do === 'held') await model.until(() => model.held(step.request), `${step.request} held`);
    else if (step.do === 'release') model.release(step.request);
    else if (step.do === 'watch') await within(STEP_MS, app.watch(step.who.map(id)), 'setVisibleSessions');
    else if (step.do === 'idle')
      await model.until(() => {
        const shown = rows(step.who);
        return !app.busy(id(step.who)) && shown.length >= (step.rows ?? 0) && shown.at(-1)?.kind === 'turndone';
      }, `${step.who} idle`);
    else if (step.do === 'shows') await model.until(() => rows(step.who).some((row) => row.kind === step.kind && (!step.text || String(row.text).includes(step.text))), `${step.who} shows ${step.kind} ${step.text ?? ''}`);
    else if (step.do === 'restart') {
      await (step.killed ? app.kill(within) : app.quit(within));
      await app.open(within);
      await within(STEP_MS, app.watch([...model.aliases.values()]), 'setVisibleSessions after the restart');
    } else if (step.do === 'archive') steps.push({ archive: step.who, ...(await outcome(app.archive(id(step.who), true), `setSessionArchived ${step.who}`)) });
    else if (step.do === 'remove') steps.push({ remove: step.who, ...(await outcome(app.remove(id(step.who)), `deleteSession ${step.who}`)) });
    else if (step.do === 'abort') steps.push({ abort: step.who, ...(await outcome(app.abort(id(step.who)), `abortSession ${step.who}`)) });
    else if (step.do === 'alias') model.aliases.set(step.as, step.id);
    else if (step.do === 'settle') await new Promise((resolve) => setTimeout(resolve, step.ms));
    else throw new Error(`${c.name}: no step ${step.do}`);
  }
}

/** A recording in its normal form: session ids by alias, every other minted id numbered by first appearance. */
export function normalized(recorded) {
  let text = JSON.stringify(recorded).replace(PAD_RUN, (run) => (run === PAD ? '<pad>' : `<pad part ${run.length} chars>`));
  for (const [alias, id] of Object.entries(recorded.aliases)) text = text.replaceAll(id, `@${alias}`);
  // The app's user-data folder (where the unclassified workspace lies), then the case's own folder, as the recording spells them:
  // in a string, and in a JSON text a string holds (a tool result).
  for (const [path, name] of [
    [recorded.userData, '<userData>'],
    [recorded.root, '<case>'],
  ]) {
    const once = JSON.stringify(path).slice(1, -1);
    text = text.replaceAll(JSON.stringify(once).slice(1, -1), name).replaceAll(once, name);
  }
  const numbered = new Map();
  text = text.replace(/\b(atask|msg|sess_desktop|call|it)_[0-9a-zA-Z-]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (found, prefix) => {
    const key = found;
    if (!numbered.has(key)) numbered.set(key, `<${prefix ?? 'uuid'}:${[...numbered.keys()].filter((k) => k.startsWith(prefix ?? '')).length + 1}>`);
    return numbered.get(key);
  });
  // A compaction handoff's digest (`compactHeader`, compact/messages.mjs) hashes the summarized messages' `at`, `elapsedMs` and
  // `attemptId`: minted from each side's own clock and uuids, it is numbered as they are.
  const digests = new Map();
  text = text.replace(/(messages=\d+ sha256=)([0-9a-f]{16})/g, (_, head, digest) => {
    if (!digests.has(digest)) digests.set(digest, `<handoff:${digests.size + 1}>`);
    return head + digests.get(digest);
  });
  const out = JSON.parse(text);
  delete out.aliases;
  delete out.root;
  delete out.userData;
  return out;
}

const ann = [{ id: 'ann', name: 'Ann' }];
const send = (to = '@R') => ({ action: 'send', session_id: to, prompt: 'WORK: check the build.' });
const start = [
  { do: 'home', agent: 'ann', as: 'H' },
  { do: 'task', as: 'R', prompt: 'You are the recipient.' },
  { do: 'watch', who: ['H', 'R'] },
  // The recipient's first turn has ended: what is said to it next is a turn of its own, not steering into that one.
  { do: 'idle', who: 'R' },
];
const kick = [{ do: 'say', to: 'H', prompt: 'KICK: send it.' }, { do: 'until', request: 'tool-result' }];
/** A recipient with a conversation long enough to summarize, whose next turn schedules its compaction and then fails. */
const notes = [
  { do: 'task', as: 'R', prompt: 'You are the recipient.' },
  { do: 'idle', who: 'R' },
  { do: 'say', to: 'R', prompt: 'NOTES: take notes.' },
  { do: 'until', request: 'notes' },
  { do: 'idle', who: 'R' },
  { do: 'say', to: 'R', prompt: 'FAILNEXT: compact yourself, then fail.' },
];
/** The report reached the sender: its wake turn ran. */
const reported = [{ do: 'until', request: 'other', n: 2 }, { do: 'idle', who: 'H' }];

export const CASES = [
  // The plain send, the reference the others differ from.
  { name: 'send-reported', bots: ann, call: send(), answers: { work: { after: 'tool-result', text: FINAL } }, steps: [...start, ...kick, { do: 'until', request: 'work' }, ...reported] },

  // Reported home exactly once.
  {
    name: 'sender-archived-before-answer',
    bots: ann,
    call: send(),
    answers: { work: { hold: true, text: FINAL } },
    steps: [...start, ...kick, { do: 'idle', who: 'H' }, { do: 'held', request: 'work' }, { do: 'archive', who: 'H' }, { do: 'release', request: 'work' }, { do: 'idle', who: 'R' }, { do: 'settle', ms: 6000 }],
  },
  {
    name: 'sender-deleted-before-answer',
    bots: ann,
    call: send(),
    answers: { work: { hold: true, text: FINAL } },
    steps: [...start, ...kick, { do: 'idle', who: 'H' }, { do: 'held', request: 'work' }, { do: 'remove', who: 'H' }, { do: 'release', request: 'work' }, { do: 'idle', who: 'R' }, { do: 'settle', ms: 6000 }],
  },
  {
    name: 'sender-compacted-before-answer',
    bots: ann,
    call: send(),
    answers: { work: { hold: true, text: FINAL } },
    steps: [
      ...start,
      ...kick,
      { do: 'idle', who: 'H' },
      { do: 'held', request: 'work' },
      { do: 'say', to: 'H', prompt: 'NOTES: take notes.' },
      { do: 'until', request: 'notes' },
      { do: 'idle', who: 'H' },
      { do: 'say', to: 'H', prompt: 'COMPACTME: compact yourself.' },
      { do: 'until', request: 'tool-result', n: 2 },
      { do: 'idle', who: 'H' },
      { do: 'settle', ms: 3000 },
      { do: 'release', request: 'work' },
      ...reported,
    ],
  },
  {
    name: 'restart-before-recipient-turn',
    bots: ann,
    call: send(),
    // Ended from outside: an app's own stop ends the running turn and drops the queued send, and whether that process still reports it
    // before it exits is a race inside Node's stop.
    // The restart restores the queued send (`restoreLeadSteeringFromDisk`) and it runs.
    steps: [...start, { do: 'say', to: 'R', prompt: 'BUSY: hold on.' }, { do: 'held', request: 'busy' }, ...kick, { do: 'idle', who: 'H' }, { do: 'restart', killed: true }, ...reported, { do: 'settle', ms: 6000 }],
  },
  {
    name: 'restart-during-recipient-turn',
    bots: ann,
    call: send(),
    answers: { work: { hold: true, text: FINAL } },
    steps: [...start, ...kick, { do: 'idle', who: 'H' }, { do: 'held', request: 'work' }, { do: 'restart' }, { do: 'settle', ms: 6000 }],
  },
  {
    name: 'restart-after-recipient-turn',
    bots: ann,
    call: send(),
    steps: [...start, ...kick, { do: 'until', request: 'work' }, { do: 'idle', who: 'R' }, { do: 'restart' }, ...reported],
  },

  // `session action=status` of another session (`readSessionStatus`, daemon-session-control.mjs:203): idle, busy, missing.
  { name: 'status-idle', bots: ann, call: { action: 'status', session_id: '@R' }, steps: [...start, ...kick, { do: 'idle', who: 'H' }] },
  {
    name: 'status-busy',
    bots: ann,
    call: { action: 'status', session_id: '@R' },
    steps: [...start, { do: 'say', to: 'R', prompt: 'BUSY: hold on.' }, { do: 'held', request: 'busy' }, ...kick, { do: 'idle', who: 'H' }, { do: 'release', request: 'busy' }, { do: 'idle', who: 'R' }],
  },
  { name: 'status-missing', bots: ann, call: { action: 'status', session_id: 'sess_gone' }, steps: [...start, ...kick, { do: 'idle', who: 'H' }] },

  // The recipient at the send.
  {
    name: 'recipient-busy',
    bots: ann,
    call: send(),
    steps: [...start, { do: 'say', to: 'R', prompt: 'BUSY: hold on.' }, { do: 'held', request: 'busy' }, ...kick, { do: 'idle', who: 'H' }, { do: 'release', request: 'busy' }, { do: 'until', request: 'work' }, ...reported],
  },
  {
    name: 'recipient-queued',
    bots: ann,
    call: send(),
    steps: [...start, { do: 'say', to: 'R', prompt: 'BUSY: hold on.' }, { do: 'held', request: 'busy' }, { do: 'say', to: 'R', prompt: 'QUEUED: then this.' }, ...kick, { do: 'idle', who: 'H' }, { do: 'release', request: 'busy' }, { do: 'until', request: 'work' }, ...reported],
  },
  {
    name: 'recipient-compaction-scheduled',
    bots: ann,
    call: send(),
    answers: { compaction: { hold: true, text: SUMMARY } },
    steps: [
      ...start,
      { do: 'say', to: 'R', prompt: 'NOTES: take notes.' },
      { do: 'until', request: 'notes' },
      { do: 'idle', who: 'R' },
      { do: 'say', to: 'R', prompt: 'COMPACTME: compact yourself.' },
      { do: 'until', request: 'tool-result' },
      { do: 'held', request: 'compaction' },
      { do: 'say', to: 'H', prompt: 'KICK: send it.' },
      { do: 'until', request: 'tool-result', n: 2 },
      { do: 'settle', ms: 2000 },
      { do: 'release', request: 'compaction' },
      { do: 'until', request: 'work' },
      ...reported,
    ],
  },

  // A failed turn's retry while the compaction its turn scheduled runs: it waits, then runs once on the compacted conversation; or a stop
  // while it waits.
  {
    name: 'retry-waits-for-scheduled-compaction',
    answers: { compaction: { hold: true, text: SUMMARY } },
    steps: [
      ...notes,
      { do: 'held', request: 'compaction' },
      { do: 'say', to: 'R', prompt: 'Continue from where you left off.', options: { retryFailedTurn: true } },
      { do: 'settle', ms: 2000 },
      { do: 'release', request: 'compaction' },
      { do: 'until', request: 'other', n: 2 },
      { do: 'idle', who: 'R' },
    ],
  },
  {
    name: 'retry-cancelled-while-compaction-waits',
    answers: { compaction: { hold: true, text: SUMMARY } },
    steps: [
      ...notes,
      { do: 'held', request: 'compaction' },
      { do: 'say', to: 'R', prompt: 'Continue from where you left off.', options: { retryFailedTurn: true } },
      { do: 'settle', ms: 2000 },
      { do: 'abort', who: 'R' },
      { do: 'settle', ms: 2000 },
      { do: 'release', request: 'compaction' },
      { do: 'settle', ms: 4000 },
    ],
  },
  { name: 'recipient-archived', bots: ann, call: send(), answers: { work: { after: 'tool-result', text: FINAL } }, steps: [...start, { do: 'archive', who: 'R' }, ...kick, { do: 'until', request: 'work' }, ...reported] },
  { name: 'recipient-missing', bots: ann, call: send('sess_gone'), steps: [...start, ...kick, { do: 'idle', who: 'H' }] },
  {
    name: 'recipient-deleted-in-flight',
    bots: ann,
    call: send(),
    answers: { work: { hold: true, text: FINAL } },
    steps: [...start, ...kick, { do: 'idle', who: 'H' }, { do: 'held', request: 'work' }, { do: 'remove', who: 'R' }, { do: 'settle', ms: 6000 }, { do: 'idle', who: 'H' }],
  },
];
