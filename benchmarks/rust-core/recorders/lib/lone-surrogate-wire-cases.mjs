// The cases of the lone-surrogate wire recording (record-lone-surrogate-wire.mjs) and its replay against the core: a client's
// string holding an unpaired UTF-16 surrogate (`\ud83d`, half of an emoji) where it becomes an HTTP header, a URL query, a
// language-server request, or a value whose serialised size is limited. Node runs each through its own code (`node`); the core
// gets the request a client sends for it (`core`: method and params, `opId` added by the client library).
//
// A case with `refused` is one the core refuses by decision before any service runs (mixdog-app-protocol free_text.rs: the field
// is not free text); `refused` is the field the core names. Node's answer is recorded beside it as the declared difference. Every
// other case is compared whole with Node's answer.
import { join } from 'node:path';

/** The scratch world (fixed paths: they are in the answers). */
export const ROOT = 'D:\\mixdog-build\\tmp\\lone-surrogate-wire-world';
export const PROJECT = join(ROOT, 'project');
/** The local HTTP server both sides talk to (a fixed port: the address is in the answers). */
export const PORT = 47815;
export const ORIGIN = `http://127.0.0.1:${PORT}`;

const HIGH = '\ud83d';
const LOW = '\ude00';
const header = { 'X-Token': `abc${HIGH}` };
const provider = (extra) => ({ name: 'Lone', protocol: 'openai-chat', baseURL: `${ORIGIN}/v1`, auth: 'none', schemaVersion: 2, ...extra });
const mcpServer = (name) => ({ name, type: 'http', url: `${ORIGIN}/mcp`, headers: header });
const lsp = (method, params) => ({ projectPath: PROJECT, root: PROJECT, relPath: 'a.rs', languageId: 'rust', method, params });
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };
const codeAction = {
  range,
  context: { diagnostics: [{ range, severity: 2, message: `unused variable: \`x${HIGH}\``, source: 'rustc', code: 'unused_variables' }], triggerKind: 1 },
};

/** What the core's lone refusal of `field` (`<method>.params<pointer>`) is to its client: the JSON-RPC error (mixdog-app-server
 *  server.rs `lone_refusal`), as protocol-client's `ClientFailure` detail carries it. */
export function loneRefusal(field) {
  const expected = `text without unpaired surrogates (a lone \\ud800-\\udfff escape) in ${field}`;
  return { kind: 'rpc', code: -32602, reason: 'invalidParams', message: 'invalidParams', data: { reason: 'invalidParams', path: field, expected } };
}

export const CASES = [
  // ── MCP: a header value is sent on every request to the server. Node saves the server and its fetch refuses the value when it
  //    connects (a ByteString holds no unit over 255), sending nothing: the call answers the status with that failure, and the server
  //    is listed with it. `after`: the server's name, whose status and config are read after the call ──
  {
    name: 'mcp-add-header-lone',
    node: { run: 'mcpRuntime', op: 'addMcpServer', input: mcpServer('lone-header') },
    core: { method: 'mcp/addMcpServer', params: { input: mcpServer('lone-header') } },
    after: 'lone-header',
  },
  {
    name: 'mcp-save-header-lone',
    node: { run: 'mcpRuntime', op: 'saveMcpServer', input: mcpServer('lone-header-save') },
    core: { method: 'mcp/saveMcpServer', params: { input: mcpServer('lone-header-save') } },
    after: 'lone-header-save',
  },
  // ── the auth probe never sends a configured header: any header is configured authentication ──
  {
    name: 'mcp-probe-header-lone',
    node: { run: 'mcpProbe', cfg: { type: 'http', url: `${ORIGIN}/mcp`, headers: header } },
    core: { method: 'mcp/probeMcpServerAuth', params: { cfg: { type: 'http', url: `${ORIGIN}/mcp`, headers: header } } },
  },
  // ── a custom provider's header value: Node's check refuses any value outside Latin-1 with its message ──
  ...['save', 'test', 'discover'].map((op) => ({
    name: `custom-${op}-header-lone`,
    node: { run: 'custom', op, input: provider({ headers: header }) },
    core: { method: `account/${op === 'discover' ? 'discoverCustomProviderModels' : `${op}CustomProvider`}`, params: { input: provider({ headers: header }) } },
  })),
  // ── a custom provider's extra body: Node measures `JSON.stringify(requestBody).length` (16384 at most), where a lone unit is
  //    the six characters of its escape and a real U+FFFD one: {"x":"…"} is 8 + the value ──
  ...[
    ['save', 'body-3000-lone', { x: HIGH.repeat(3000) }],
    ['test', 'body-3000-lone', { x: HIGH.repeat(3000) }],
    ['discover', 'body-3000-lone', { x: HIGH.repeat(3000) }],
    ['discover', 'body-2730-lone', { x: LOW.repeat(2730) }],
    ['discover', 'body-2729-lone', { x: LOW.repeat(2729) }],
    ['discover', 'body-16376-real-replacement', { x: '\ufffd'.repeat(16376) }],
    ['discover', 'body-one-lone-beside-real-replacements', { x: `${HIGH}${'\ufffd'.repeat(16371)}` }],
    ['discover', 'body-lone-in-two-values', { x: HIGH.repeat(1500), y: `${LOW}${'a'.repeat(7360)}` }],
  ].map(([op, what, requestBody]) => ({
    name: `custom-${op}-${what}`,
    node: { run: 'custom', op, input: provider({ requestBody }) },
    core: { method: `account/${op === 'discover' ? 'discoverCustomProviderModels' : `${op}CustomProvider`}`, params: { input: provider({ requestBody }) } },
  })),
  // ── a Hugging Face model search: the query is a URL query (URLSearchParams). Replayed by the core's own test (mixdog-services
  //    local_provider/hugging_face.rs), which reads the URL Node fetched ──
  { name: 'hf-search-lone', node: { run: 'hfSearch', query: `a${HIGH}b` } },
  // ── language-server requests a person's typing reaches: Node forwards the params to the server as JSON (the server reads the
  //    escape); the core refuses a rename's new name, a symbol query and a command (identifiers the server looks up or runs) ──
  {
    name: 'lsp-rename-lone',
    node: { run: 'lsp', input: lsp('textDocument/rename', { position: { line: 0, character: 3 }, newName: `x${HIGH}` }) },
    core: { method: 'lsp/request', params: { projectPath: PROJECT, root: PROJECT, request: { relPath: 'a.rs', languageId: 'rust', method: 'textDocument/rename', params: { position: { line: 0, character: 3 }, newName: `x${HIGH}` } } } },
    refused: 'lsp/request.params/request/params/newName',
  },
  {
    name: 'lsp-workspace-symbol-lone',
    node: { run: 'lsp', input: lsp('workspace/symbol', { query: `m${HIGH}` }) },
    core: { method: 'lsp/request', params: { projectPath: PROJECT, root: PROJECT, request: { relPath: 'a.rs', languageId: 'rust', method: 'workspace/symbol', params: { query: `m${HIGH}` } } } },
    refused: 'lsp/request.params/request/params/query',
  },
  {
    name: 'lsp-execute-command-lone',
    node: { run: 'lsp', input: lsp('workspace/executeCommand', { command: `stub.run${HIGH}`, arguments: [] }) },
    core: { method: 'lsp/request', params: { projectPath: PROJECT, root: PROJECT, request: { relPath: 'a.rs', languageId: 'rust', method: 'workspace/executeCommand', params: { command: `stub.run${HIGH}`, arguments: [] } } } },
    refused: 'lsp/request.params/request/params/command',
  },
  // ── a code action request as the editor sends it (apps/desktop/src/renderer/editor-lsp-providers.ts: each marker's message,
  //    source and code), for a diagnostic whose message quotes document text holding a lone unit: forwarded by both. `lone`:
  //    Node's answer holds the unit the server read back, the core's U+FFFD (the manifest's normalisation) ──
  {
    name: 'lsp-code-action-diagnostic-lone',
    node: { run: 'lsp', input: lsp('textDocument/codeAction', codeAction) },
    core: { method: 'lsp/request', params: { projectPath: PROJECT, root: PROJECT, request: { relPath: 'a.rs', languageId: 'rust', method: 'textDocument/codeAction', params: codeAction } } },
    lone: true,
  },
];
