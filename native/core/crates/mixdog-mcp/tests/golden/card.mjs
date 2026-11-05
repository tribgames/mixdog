// Records, from today's Node product, what the Gmail `describe_emails` lookup puts on an
// outbound approval card (human-gate/gate.mjs `describeEmails`, run through the real
// `humanGateDecision`), as the golden the Rust CardEnricher replays.
// Usage: node card.mjs <repo-root> <out.json>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
const dataRoot = mkdtempSync(join(tmpdir(), 'card-golden-'));
process.env.MIXDOG_DATA_DIR = dataRoot;
mkdirSync(join(dataRoot, 'agents', 'mailer'), { recursive: true });
writeFileSync(join(dataRoot, 'agents', 'mailer', 'AGENT.md'), '---\nkind: bot\n---\nYou are mailer.\n');
const load = (p) => import(pathToFileURL(join(root, 'src', 'runtime', 'agent', 'orchestrator', p)).href);
const { _registerMcpServerForTest, disconnectAll } = await load('mcp/client.mjs');
const { rememberServerConnector } = await load('mcp/server-connectors.mjs');
const { humanGateDecision } = await load('session/human-gate/gate.mjs');
const { createHumanGateStore, setHumanGateStore } = await load('session/human-gate/store.mjs');

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const doc = (value) => text(JSON.stringify(value));
const mail = (extra = {}) => ({ from: 'Kim <kim@example.com>', subject: 'Hello', date: '2026-01-02', ...extra });

const SEND = 'send_email';
const TRASH = 'trash_emails';
const scenarios = [
  { name: 'send, plain', tool: SEND, args: { to: 'a@b.c' }, result: doc({ account: 'a@example.com', emails: [] }) },
  { name: 'send, account trimmed', tool: SEND, args: { account: '  b-account  ' }, result: doc({ account: 'b@example.com', emails: [] }) },
  { name: 'send, account blank', tool: SEND, args: { account: '   ' }, result: doc({ account: 'a@example.com' }) },
  { name: 'send, account not a string', tool: SEND, args: { account: 5 }, result: doc({ account: 'a@example.com' }) },
  { name: 'send, account with no-break spaces', tool: SEND, args: { account: '\u00a0b\u2003' }, result: doc({ account: 'b@example.com' }) },
  { name: 'send, ids are ignored', tool: SEND, args: { ids: ['1', '2'] }, result: doc({ account: 'a@example.com', emails: [mail()] }) },
  { name: 'trash, two messages', tool: TRASH, args: { ids: ['1', '2'] }, result: doc({ account: 'a@example.com', emails: [mail({ subject: 'S1' }), mail({ subject: 'S2', from: 'Lee' })] }) },
  { name: 'trash, five ids show three', tool: TRASH, args: { ids: ['1', '2', '3', '4', '5'] }, result: doc({ account: 'a@example.com', emails: [mail(), mail(), mail()] }) },
  { name: 'trash, exactly three ids', tool: TRASH, args: { ids: ['1', '2', '3'] }, result: doc({ account: 'a@example.com', emails: [mail()] }) },
  { name: 'trash, ids of other types become strings', tool: TRASH, args: { ids: [1, null, { a: 1 }, ['x', null], true, 'z'] }, result: doc({ account: 'a@example.com', emails: [] }) },
  { name: 'trash, ids not an array', tool: TRASH, args: { ids: '1' }, result: doc({ account: 'a@example.com', emails: [mail()] }) },
  { name: 'trash, empty ids', tool: TRASH, args: { ids: [] }, result: doc({ account: 'a@example.com', emails: [] }) },
  { name: 'trash, account and ids', tool: TRASH, args: { ids: ['9'], account: 'b-account' }, result: doc({ account: 'b@example.com', emails: [mail()] }) },
  { name: 'mail fields: missing, empty, falsy', tool: TRASH, args: { ids: ['1', '2', '3'] }, result: doc({ account: 'a@example.com', emails: [{}, { from: '', subject: 0, date: false }, { from: null, subject: 'only' }] }) },
  { name: 'mail fields: odd types', tool: TRASH, args: { ids: ['1', '2', '3'] }, result: doc({ account: 'a@example.com', emails: [{ from: 5, subject: { x: 1 }, date: 20260102 }, { from: ['a', null, 'b'], subject: true, date: [1, 2] }, { from: 1.5, subject: [], date: { y: 1 } }] }) },
  { name: 'mail fields: long date and astral text', tool: TRASH, args: { ids: ['1', '2'] }, result: doc({ account: 'a@example.com', emails: [mail({ date: '2026-01-02T10:00:00Z' }), mail({ date: '😀😀😀😀😀😀', subject: '😀' })] }) },
  { name: 'mail fields: non-breaking text is kept', tool: TRASH, args: { ids: ['1'] }, result: doc({ account: 'a@example.com', emails: [mail({ subject: '\u00a0 padded \u2003' })] }) },
  { name: 'emails list with a null entry', tool: TRASH, args: { ids: ['1', '2'] }, result: doc({ account: 'a@example.com', emails: [mail(), null] }) },
  { name: 'emails list with primitive entries', tool: TRASH, args: { ids: ['1', '2', '3'] }, result: doc({ account: 'a@example.com', emails: [5, 'str', [1]] }) },
  { name: 'more emails than ids are all listed', tool: TRASH, args: { ids: ['1'] }, result: doc({ account: 'a@example.com', emails: [mail(), mail(), mail(), mail(), mail()] }) },
  { name: 'emails null', tool: TRASH, args: { ids: ['1'] }, result: doc({ account: 'a@example.com', emails: null }) },
  { name: 'emails a string', tool: TRASH, args: { ids: ['1'] }, result: doc({ account: 'a@example.com', emails: 'x' }) },
  { name: 'emails an object', tool: TRASH, args: { ids: ['1'] }, result: doc({ account: 'a@example.com', emails: { 0: mail() } }) },
  { name: 'account 0', tool: SEND, args: {}, result: doc({ account: 0, emails: [] }) },
  { name: 'account false', tool: SEND, args: {}, result: doc({ account: false }) },
  { name: 'account null', tool: SEND, args: {}, result: doc({ account: null }) },
  { name: 'account a number', tool: SEND, args: {}, result: doc({ account: 12 }) },
  { name: 'account true', tool: SEND, args: {}, result: doc({ account: true }) },
  { name: 'account an object', tool: SEND, args: {}, result: doc({ account: { a: 1 } }) },
  { name: 'account an array', tool: SEND, args: {}, result: doc({ account: ['q', null, 'r'] }) },
  { name: 'account empty string', tool: SEND, args: {}, result: doc({ account: '' }) },
  { name: 'reply is JSON null', tool: TRASH, args: { ids: ['1', '2', '3', '4'] }, result: text('null') },
  { name: 'reply is a JSON number', tool: TRASH, args: { ids: ['1', '2', '3', '4'] }, result: text('5') },
  { name: 'reply is a JSON string', tool: TRASH, args: { ids: ['1', '2', '3', '4'] }, result: text('"abc"') },
  { name: 'reply is a JSON array', tool: TRASH, args: { ids: ['1', '2', '3', '4'] }, result: text('[]') },
  { name: 'reply is JSON true', tool: TRASH, args: { ids: ['1', '2', '3', '4'] }, result: text('true') },
  { name: 'reply is an empty object', tool: TRASH, args: { ids: ['1', '2', '3', '4'] }, result: text('{}') },
  { name: 'reply is not JSON', tool: TRASH, args: { ids: ['1'] }, result: text('nope') },
  { name: 'reply is empty text', tool: TRASH, args: { ids: ['1'] }, result: text('') },
  { name: 'reply has surrounding space', tool: TRASH, args: { ids: ['1'] }, result: text(`\n \u00a0${JSON.stringify({ account: 'a@example.com', emails: [mail()] })}\n`) },
  { name: 'reply has a byte order mark', tool: TRASH, args: { ids: ['1'] }, result: text(`\ufeff${JSON.stringify({ account: 'a@example.com' })}`) },
  { name: 'reply is an error result with JSON', tool: TRASH, args: { ids: ['1'] }, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ account: 'x@example.com', emails: [mail()] }) }] } },
  { name: 'reply is an error result with text', tool: TRASH, args: { ids: ['1'] }, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } },
  { name: 'reply in two text parts', tool: TRASH, args: { ids: ['1'] }, result: { content: [{ type: 'text', text: '{"account":' }, { type: 'text', text: '"a@example.com"}' }] } },
  { name: 'reply with an image part', tool: TRASH, args: { ids: ['1'] }, result: { content: [{ type: 'text', text: JSON.stringify({ account: 'a@example.com' }) }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] } },
  { name: 'reply with structured content only', tool: TRASH, args: { ids: ['1'] }, result: { structuredContent: { account: 'a@example.com', emails: [mail()] } } },
  { name: 'reply with empty content', tool: TRASH, args: { ids: ['1'] }, result: { content: [] } },
  { name: 'reply with no content', tool: TRASH, args: { ids: ['1'] }, result: {} },
  { name: 'the lookup fails', tool: TRASH, args: { ids: ['1'] }, throws: 'down' },
  { name: 'a server with another connector', tool: SEND, args: {}, server: 'other', connector: 'notion', result: doc({ account: 'x@example.com' }) },
  { name: 'a server with no connector', tool: SEND, args: {}, server: 'plain', connector: null, result: doc({ account: 'x@example.com' }) },
  { name: 'a server name holding a double underscore', tool: SEND, args: {}, server: 'gm__ail', connector: 'gmail', result: doc({ account: 'x@example.com' }) },
  { name: 'a server that is not connected', tool: SEND, args: {}, server: 'ghost', connector: 'gmail', skipRegister: true, result: doc({ account: 'x@example.com' }) },
];

const records = [];
for (const scenario of scenarios) {
  const server = scenario.server ?? 'gmail-acct';
  const connector = scenario.connector === undefined ? 'gmail' : scenario.connector;
  const run = async (answer) => {
    const dir = mkdtempSync(join(tmpdir(), 'card-golden-store-'));
    const store = createHumanGateStore(dir);
    setHumanGateStore(store);
    const scopeId = 'card-golden';
    const asked = [];
    if (!scenario.skipRegister) {
      _registerMcpServerForTest(scopeId, server, [{ name: SEND }, { name: TRASH }], {
        callTool: async ({ name, arguments: args }) => {
          asked.push({ name, args });
          if (answer.throws) throw new Error(answer.throws);
          return answer.result;
        },
      });
    }
    rememberServerConnector(server, connector ? { connector } : {});
    try {
      const decided = await humanGateDecision(
        { name: `mcp__${server}__${scenario.tool}`, args: scenario.args },
        null,
        { sessionId: 'sess_home_mailer', store, annotations: {}, mcpScopeId: scopeId }
      );
      const outbound = decided.request?.outbound;
      return { asked, category: outbound?.category ?? null, account: outbound?.account ?? null, details: outbound?.details ?? null };
    } finally {
      rememberServerConnector(server, {});
      disconnectAll({ scopeId });
      setHumanGateStore(null);
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const baseline = await run({ throws: 'baseline' });
  const withReply = await run(scenario);
  records.push({
    name: scenario.name,
    server,
    connector,
    tool: scenario.tool,
    args: scenario.args,
    result: scenario.result ?? null,
    throws: scenario.throws ?? null,
    baseline: { category: baseline.category, account: baseline.account, details: baseline.details },
    asked: withReply.asked,
    card: { account: withReply.account, details: withReply.details },
  });
}
rmSync(dataRoot, { recursive: true, force: true });
writeFileSync(out, `${JSON.stringify({ cases: records }, null, 1)}\n`);
console.log(`recorded ${records.length} cases`);
