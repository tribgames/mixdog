// Records from Node at b6f10295a what its own TUI modules answer for the provider rows and the `/mcp login` flows of
// cases.mjs, into node-oracle.golden.json:
//   node record.mjs <node-repo> [out.json]
// The flows run twice: with the runtime's sign-in actions as a plain store, and composed with Node's real session
// extensions API (as Node's own test did), to show the plain store is equivalent.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportNodeTree } from '../../components/status-line/footer-golden/node-tree.mjs';
import { MCP_FLOWS, PROVIDER_ROWS, runMcpFlow, setupWith } from './cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const out = process.argv[3] || join(here, 'node-oracle.golden.json');
if (!repo) throw new Error('usage: node record.mjs <node-repo> [out.json]');
const { tree, commit } = exportNodeTree(repo);
const load = (path) => import(pathToFileURL(join(tree, path)).href);

const { providerSetupHasUsableProvider } = await load('src/tui/app/app-format.mjs');
const { providerStatusFooter } = await load('src/tui/app/provider-setup/provider-items.mjs');
const { createMcpLogin } = await load('src/tui/app/extension-pickers/mcp-login.mjs');
const { submitProviderPrompt } = await load('src/tui/app/prompt-submit/provider-prompts.mjs');
const { createSessionExtensionsApi } = await load('src/tui/session/session-api/extensions.mjs');

const customRows = JSON.parse(readFileSync(join(here, '..', 'provider-usable-golden', 'node-rows.golden.json'), 'utf8'));
const rows = [...PROVIDER_ROWS, customRows.invalid, customRows.valid];
const providers = rows.map((row) => {
  const [footer] = providerStatusFooter(row);
  return { row, usable: providerSetupHasUsableProvider(setupWith(row)), glyph: footer.glyph, text: footer.text };
});

const plain = (runtime, pushNotice) => ({ ...runtime, pushNotice });
const composed = (runtime, pushNotice) => {
  let state = { commandBusy: false, stats: {} };
  const api = createSessionExtensionsApi({
    runtime,
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    pushNotice,
    resetStatsAndSyncContext: () => {},
    routeState: () => ({}),
  });
  return { ...api, pushNotice };
};
const flows = [];
for (const flow of MCP_FLOWS) {
  const common = { createMcpLogin, submitProviderPrompt };
  flows.push({
    name: flow.name,
    plain: await runMcpFlow(flow, { ...common, makeStore: plain }),
    composed: await runMcpFlow(flow, { ...common, makeStore: composed }),
  });
}
writeFileSync(out, `${JSON.stringify({ recordedFrom: commit, providers, flows }, null, 1)}\n`);
process.exit(0);
