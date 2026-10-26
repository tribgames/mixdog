// The one MCP server of a multi-account connector (connector-catalog.mjs
// connectorAccountsOf): Gmail, Google Calendar or Google Drive with every
// connected account behind one tool set. Answered in-process like the
// one-account servers it fronts (google-mcp.mjs, gmail-app-password.mjs):
// each tool takes `account` (the account's address), and the call goes to
// that account's own endpoint with that account's own credentials (its OAuth
// tokens, or its app password from the keychain). With one account
// `account` may be left out; with several, a call naming none is refused
// with the list, so the model asks the user. An account that fails stays
// listed with why (connectorAccountHealth); the server only fails to start
// when no account can be used.
import { accountsOfInstructions, connectorAccountsInstructions } from '../shared/connector-accounts.mjs';
import { connectorById } from '../shared/connector-catalog.mjs';
import { gmailAppPasswordTools } from './gmail-app-password.mjs';
import { googleMcpTools } from './google-mcp.mjs';

const PROTOCOL_VERSION = '2025-06-18';

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

const ACCOUNT_PROPERTY = Object.freeze({
  type: 'string',
  description:
    'The account to act as (its email address). May be left out when one account is connected; required when several are.',
});

const SERVICE_OF = { gmail: 'gmail', 'google-calendar': 'calendar', 'google-drive': 'drive' };

/** The tools of `connector` over `accounts`, each taking `account`. Gmail on
 *  an app password has the larger set (IMAP); a Google sign-in Gmail account
 *  answers the tools it has and refuses the others. */
function connectorTools(connector, accounts, { hidden = false } = {}) {
  const tools =
    connector === 'gmail' && accounts.some((account) => account.appPassword)
      ? gmailAppPasswordTools({ hidden })
      : googleMcpTools(SERVICE_OF[connector]);
  return tools.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...(tool.inputSchema?.properties || {}), account: ACCOUNT_PROPERTY },
    },
  }));
}

class AccountChoiceError extends Error {}

const labelOf = (account) => account.email || account.name;

/** The account a call names (by address, or by its account name), or its
 *  only account; throws the account list otherwise. */
function pickAccount(accounts, value, service) {
  const list = accounts.map(labelOf).join(', ');
  const wanted = text(value).toLowerCase();
  if (wanted) {
    const found = accounts.find(
      (account) => account.email.toLowerCase() === wanted || account.name.toLowerCase() === wanted
    );
    if (!found) throw new AccountChoiceError(`Unknown ${service} account "${text(value)}". Accounts: ${list}.`);
    return found;
  }
  if (accounts.length === 1) return accounts[0];
  throw new AccountChoiceError(
    `Several ${service} accounts are connected: ${list}. Ask the user which one, then pass it as \`account\`.`
  );
}

const noteOf = (state) => (state.authRequired ? 'needs sign-in' : 'unavailable');

/**
 * A `fetch` answering the accounts server of `connector` in-process. Each of
 * `accounts` is `{ name, email, appPassword, request(message, { signal }) }`:
 * `request` sends one JSON-RPC message to that account's own endpoint with its own
 * credentials and resolves the JSON-RPC reply; it throws when the account
 * cannot be reached (an `authRequired` error when it needs a sign-in).
 */
export function withConnectorAccountsMcp({ connector, accounts }) {
  const service = connectorById(connector)?.name || connector;
  const listed = connectorTools(connector, accounts);
  const callable = connectorTools(connector, accounts, { hidden: true });
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
  // Each account's own initialize: whether it can be used, and its address.
  const probe = async (account, signal) => {
    try {
      const reply = await account.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { signal });
      if (reply?.error) return failure(account, new Error(reply.error.message || 'The account did not start'));
      const [email = ''] = accountsOfInstructions(reply?.result?.instructions);
      const state = { email: account.email || email };
      record(account, state);
      return state;
    } catch (error) {
      return failure(account, error);
    }
  };
  // The calls in flight by JSON-RPC id, so a `notifications/cancelled` for one
  // aborts its downstream request.
  const inflight = new Map();
  async function rpc(message, transportSignal) {
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
      return reply({
        protocolVersion: text(params?.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `mixdog-${connector}`, version: '1.0.0' },
        instructions: connectorAccountsInstructions(
          accounts.map((account, index) => ({
            email: labelOf(account),
            ...(states[index].error ? { note: noteOf(states[index]) } : {}),
          }))
        ),
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: listed });
    if (method === 'tools/call') {
      const name = params?.name;
      if (!callable.some((tool) => tool.name === name)) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
      const { account: chosen, ...args } = params?.arguments || {};
      let account;
      try {
        account = pickAccount(accounts, chosen, service);
      } catch (error) {
        return reply(errorResult(error.message));
      }
      const cancel = new AbortController();
      const signal = transportSignal ? AbortSignal.any([transportSignal, cancel.signal]) : cancel.signal;
      inflight.set(id, cancel);
      try {
        const answer = await account.request(
          { jsonrpc: '2.0', id, method, params: { name, arguments: args } },
          { signal }
        );
        if (answer?.error) return reply(errorResult(`${labelOf(account)}: ${answer.error.message}`));
        if (health.get(account.name)?.error) record(account, {});
        return reply(answer?.result ?? errorResult(`${labelOf(account)}: no answer`));
      } catch (error) {
        // A cancelled call says nothing about the account's health.
        if (signal.aborted) return reply(errorResult(`${labelOf(account)}: cancelled`));
        const state = failure(account, error);
        return reply(errorResult(`${labelOf(account)}: ${state.error}`));
      } finally {
        inflight.delete(id);
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  return async (input, init) => {
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
    const replies = (await Promise.all(batch.map((one) => (one?.id === undefined ? null : rpc(one, signal))))).filter(
      Boolean
    );
    if (!replies.length) return new Response(null, { status: 202 });
    return json(200, Array.isArray(message) ? replies : replies[0]);
  };
}

/** `request` for an account answered at `url` through `fetchImpl` (its
 *  credentials applied there) with `headers`: one JSON-RPC POST, its reply. */
export function connectorAccountRequest(url, fetchImpl, headers = {}) {
  return async (message, { signal } = {}) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(message),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The account's server answered ${response.status}`);
    }
    return response.json();
  };
}
