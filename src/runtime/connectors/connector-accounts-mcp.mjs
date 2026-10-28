// The one MCP server of a catalog connector (connector-catalog.mjs
// connectorAccountsOf): every connected account of Gmail, Notion, Postgres…
// behind one tool set, answered in-process. Underneath, each account is its
// own ordinary MCP connection with its own credentials (client-transport.mjs
// connectorAccountClient), and its tools are the ones its backend lists. This
// server lists their union (a tool whose schema differs between accounts is
// left out), each with one more optional argument, `account` (an account's
// address or name), which never reaches the account.
//
// The account a call uses: the one it names; else the one last used in its
// conversation, else the connector's last-used account (connectorAccountInUse),
// else the topmost connected account. A named or remembered account that is
// switched off, removed or needs a sign-in fails the call with the usable
// accounts listed; no other account ever stands in for it. A conversation's
// call (`_meta[CONVERSATION_META]`) makes its account the last used, for the
// conversation and the connector. Every result of a call made on an account,
// errors included, says which account answered. A name binds a call to one
// account; an address or label two accounts share binds none.
// An account that fails stays listed with why (connectorAccountHealth); the
// server only fails to start when no account can be used.
import { join } from 'node:path';
import { readJsonStateSync, updateJsonAtomicSync } from '../shared/atomic-file.mjs';
import { accountsOfInstructions, connectorAccountsInstructions } from '../shared/connector-accounts.mjs';
import { connectorById } from '../shared/connector-catalog.mjs';
import { resolvePluginData } from '../shared/plugin-paths.mjs';

const PROTOCOL_VERSION = '2025-06-18';
/** The `_meta` key of a tools/call that names the conversation it is made in. */
export const CONVERSATION_META = 'mixdog/conversation';

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// account name → `{ email, error, authRequired }` as the last connect or call
// of that account found it; the status rows read it (session-runtime
// mcp-glue/server-catalog.mjs).
const health = new Map();

/** What the last connect or call of account `name` found, or null. */
export function connectorAccountHealth(name) {
  return health.get(name) || null;
}

/** Forget account `name`'s recorded state (it was removed). */
export function forgetConnectorAccountHealth(name) {
  health.delete(name);
}

// ── The last-used account ───────────────────────────────────────────────────
// Per connector, in the data dir (every runtime reads the same one); per
// conversation, in memory (the newest conversations kept).
const ACCOUNTS_IN_USE_FILE = 'connector-accounts-in-use.json';
const inUseFile = () => join(resolvePluginData(), ACCOUNTS_IN_USE_FILE);
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validInUse = (value) => {
  if (!isRecord(value)) throw new Error('the accounts in use must be an object');
  return value;
};

/** The name of the account catalog connector `connector` used last, '' when
 *  none was recorded. */
export function connectorAccountInUse(connector) {
  const stored = readJsonStateSync(inUseFile(), { validate: validInUse, fallback: {} });
  return typeof stored[connector] === 'string' ? stored[connector] : '';
}

function rememberAccountInUse(connector, name) {
  if (connectorAccountInUse(connector) === name) return;
  updateJsonAtomicSync(inUseFile(), (current) => ({ ...(isRecord(current) ? current : {}), [connector]: name }));
}

const CONVERSATIONS_KEPT = 500;
// conversation → (connector → account name), oldest first.
const conversations = new Map();

/** Account `name` of `connector` was removed: wherever it is the last used it
 *  stays a removed account, so a call that would default to it keeps failing
 *  closed, even once a new account is given the same name. */
export function retireConnectorAccount(connector, name) {
  const removed = `${name} (removed)`;
  for (const own of conversations.values()) if (own.get(connector) === name) own.set(connector, removed);
  if (connectorAccountInUse(connector) === name) rememberAccountInUse(connector, removed);
}

function rememberConversationAccount(conversation, connector, name) {
  const own = conversations.get(conversation) || new Map();
  conversations.delete(conversation);
  own.set(connector, name);
  conversations.set(conversation, own);
  if (conversations.size > CONVERSATIONS_KEPT) conversations.delete(conversations.keys().next().value);
}

const ACCOUNT_PROPERTY = Object.freeze({
  type: 'string',
  description: 'The account to use (its email address or account name). Left out: the account used last.',
});

/** `value` as JSON with every object's keys sorted, so equal schemas compare
 *  equal whatever order their keys were written in. */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** The tools every account lists, once each, with `account` added; a tool
 *  two accounts list with different schemas is left out. */
function unionTools(states) {
  const first = new Map();
  const differs = new Set();
  for (const { tools = [] } of states) {
    for (const tool of tools) {
      const seen = first.get(tool.name);
      if (!seen) first.set(tool.name, tool);
      else if (canonical(seen.inputSchema) !== canonical(tool.inputSchema)) differs.add(tool.name);
    }
  }
  return [...first.values()]
    .filter((tool) => !differs.has(tool.name))
    .map((tool) => ({
      ...tool,
      inputSchema: {
        type: 'object',
        ...tool.inputSchema,
        properties: { ...(tool.inputSchema?.properties || {}), account: ACCOUNT_PROPERTY },
      },
    }));
}

const noteOf = (state) => (state.authRequired ? 'needs sign-in' : 'unavailable');
const usable = (account) => health.get(account.name)?.authRequired !== true;

/** `result` saying which account answered it (`label`). */
const withAccountNote = (result, service, label) => ({
  ...result,
  content: [
    ...(Array.isArray(result?.content) ? result.content : []),
    { type: 'text', text: `(${service} account: ${label})` },
  ],
});

/**
 * A `fetch` answering the accounts server of `connector` in-process. Each of
 * `accounts` is `{ name, email, connect(signal), callTool(params, { signal, onprogress }) }`:
 * `connect` resolves `{ instructions, tools }` of that account's own MCP
 * connection, `callTool` sends it one tools/call (reporting its progress to
 * `onprogress`, when given) and resolves the result; both
 * throw when the account cannot be reached (an `authRequired` error when it
 * needs a sign-in). The fetch carries `connectorAccounts`: `{ connector,
 * choose({ tool, wanted, conversation }) }`, `{ name, label }` of the account
 * such a call would use (it throws the refusal otherwise), for binding a call
 * to its account (by its unique name) before it is approved.
 */
export function withConnectorAccountsMcp({ connector, accounts }) {
  const service = connectorById(connector)?.name || connector;
  // account name → the names of the tools it lists (set once it answered).
  const toolsOf = new Map();
  let listed = [];
  const same = (a, b) => Boolean(a) && a.toLowerCase() === b.toLowerCase();
  /** What an account is called to the model: its address, with its name when
   *  another account shares that address. */
  const labelOf = (account) => {
    if (!account.email) return account.name;
    const shared = accounts.some((other) => other !== account && same(other.email, account.email));
    return shared ? `${account.email} (${account.name})` : account.email;
  };
  /** The account a call uses (see the header); throws the refusal. */
  const choose = ({ tool, wanted, conversation }) => {
    const refuse = (why) => {
      const list = accounts.filter(usable).map(labelOf).join(', ') || 'none';
      return new Error(`${why} Usable ${service} accounts: ${list}. Pass one as \`account\`.`);
    };
    const named = text(wanted);
    let account;
    if (named) {
      // Its unique name, else the one account its address or label is.
      let matches = accounts.filter((one) => same(one.name, named));
      if (!matches.length) matches = accounts.filter((one) => same(one.email, named) || same(labelOf(one), named));
      if (!matches.length) throw refuse(`No connected ${service} account is "${named}".`);
      if (matches.length > 1) {
        const names = matches.map((one) => one.name).join(', ');
        throw refuse(`"${named}" is more than one ${service} account (${names}); name one.`);
      }
      [account] = matches;
    } else {
      const remembered =
        (conversation && conversations.get(conversation)?.get(connector)) || connectorAccountInUse(connector);
      account = remembered ? accounts.find((one) => one.name === remembered) : accounts[0];
      if (!account) throw refuse(`The ${service} account used last (${remembered}) is not connected now.`);
    }
    if (!usable(account)) throw refuse(`${labelOf(account)} needs a sign-in in Connectors.`);
    const has = toolsOf.get(account.name);
    if (has && !has.has(tool) && listed.some((one) => one.name === tool)) {
      throw refuse(`${labelOf(account)} has no ${tool} tool.`);
    }
    return account;
  };
  const record = (account, state) => {
    if (state.email) account.email = state.email;
    health.set(account.name, {
      email: account.email,
      error: state.error || '',
      authRequired: state.authRequired === true,
    });
  };
  const failure = (account, error) => {
    const state = { error: error?.message || String(error), authRequired: error?.authRequired === true };
    record(account, state);
    return state;
  };
  // Each account's own connection: whether it can be used, its address and tools.
  const probe = async (account, signal) => {
    try {
      const { instructions, tools } = await account.connect(signal);
      toolsOf.set(account.name, new Set(tools.map((tool) => tool.name)));
      const [email = ''] = accountsOfInstructions(instructions);
      const state = { email: account.email || email, instructions, tools };
      record(account, state);
      return state;
    } catch (error) {
      return failure(account, error);
    }
  };
  // The calls in flight by JSON-RPC id, so a `notifications/cancelled` for one
  // aborts its downstream request.
  const inflight = new Map();
  /** One JSON-RPC request's reply; `notify` sends a notification ahead of it
   *  (a tools/call's progress). */
  async function rpc(message, transportSignal, notify = null) {
    const { id, method, params } = message || {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      const states = await Promise.all(accounts.map((account) => probe(account, transportSignal)));
      if (!states.some((state) => !state.error)) {
        const first = states[0];
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32001, message: first?.error || `No ${service} account is connected` },
        };
      }
      listed = unionTools(states);
      // What the accounts' own servers tell the model (an in-process Google
      // account's only names its address, which the account list says).
      const own = [
        ...new Set(
          states.map((state) => text(state.instructions)).filter((one) => one && !accountsOfInstructions(one).length)
        ),
      ];
      const accountsLine = connectorAccountsInstructions(
        accounts.map((account, index) => ({
          email: labelOf(account),
          ...(states[index].error ? { note: noteOf(states[index]) } : {}),
        }))
      );
      return reply({
        protocolVersion: text(params?.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `mixdog-${connector}`, version: '1.0.0' },
        instructions: [accountsLine, ...own].filter(Boolean).join('\n\n') || undefined,
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: listed });
    if (method === 'tools/call') {
      const name = params?.name;
      const { account: wanted, ...args } = params?.arguments || {};
      const conversation = text(params?._meta?.[CONVERSATION_META]);
      let account;
      try {
        account = choose({ tool: name, wanted, conversation });
        if (conversation) {
          rememberConversationAccount(conversation, connector, account.name);
          rememberAccountInUse(connector, account.name);
        }
      } catch (error) {
        return reply(errorResult(error?.message || String(error)));
      }
      const cancel = new AbortController();
      const signal = transportSignal ? AbortSignal.any([transportSignal, cancel.signal]) : cancel.signal;
      inflight.set(id, cancel);
      // The account's progress reaches the caller under the caller's own token,
      // so it resets the call's deadline as a direct server's progress does.
      const progressToken = params?._meta?.progressToken;
      const onprogress =
        notify && progressToken !== undefined
          ? (progress) => notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { ...progress, progressToken } })
          : undefined;
      try {
        // An unlisted tool (one only the approval gate calls) is the account's to answer.
        const result = await account.callTool({ name, arguments: args }, { signal, onprogress });
        if (health.get(account.name)?.error) record(account, {});
        return reply(withAccountNote(result, service, labelOf(account)));
      } catch (error) {
        // A cancelled call says nothing about the account's health.
        const why = signal.aborted ? 'cancelled' : failure(account, error).error;
        return reply(withAccountNote(errorResult(why), service, labelOf(account)));
      } finally {
        inflight.delete(id);
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  const fetchImpl = async (input, init) => {
    const request = input instanceof Request ? input : null;
    if (String(request?.method || init?.method || 'GET').toUpperCase() !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }
    const body = request ? await request.text() : init?.body;
    let message;
    try {
      message = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
    } catch {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const batch = Array.isArray(message) ? message : [message];
    const signal = init?.signal ?? request?.signal;
    for (const one of batch) {
      if (one?.method === 'notifications/cancelled') inflight.get(one.params?.requestId)?.abort();
    }
    // A call asking for progress is answered as an event stream: its progress
    // notifications, then its reply.
    if (!Array.isArray(message) && message?.id !== undefined && message.params?._meta?.progressToken !== undefined) {
      const encoder = new TextEncoder();
      let open = true;
      const stream = new ReadableStream({
        start(controller) {
          const send = (payload) => {
            if (open) controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`));
          };
          void rpc(message, signal, send).then((answer) => {
            send(answer);
            if (open) controller.close();
            open = false;
          });
        },
        // The caller stopped reading (its call was aborted).
        cancel() {
          open = false;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const replies = (await Promise.all(batch.map((one) => (one?.id === undefined ? null : rpc(one, signal))))).filter(
      Boolean
    );
    if (!replies.length) return new Response(null, { status: 202 });
    return json(200, Array.isArray(message) ? replies : replies[0]);
  };
  fetchImpl.connectorAccounts = {
    connector,
    choose: (call) => {
      const account = choose(call);
      return { name: account.name, label: labelOf(account) };
    },
  };
  return fetchImpl;
}
