#!/usr/bin/env node
// Recording of src/runtime/browser-bridge/mail-links.test.mjs and apps/desktop/src/main/browser/mail-link-navigation.test.mjs
// (b6f10295a): the links of a mail the runtime read through its own Gmail connector, who may open them, and the `mail_link` the
// browser tool hands the desktop on a navigate. Node's answers to each operation are recorded in order (lib/mail-link-scenarios.mjs).
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-mail-link-navigation.mjs --tree <export of b6f10295a with node_modules>
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { mailLinkScenarios } from './lib/mail-link-scenarios.mjs';
import { FIXED_NOW, openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';

const crates = 'native/core/crates/';
REPLAY_TARGETS['mail-link-navigation'] = {
  rust: [
    { path: `${crates}mixdog-tools/src/desktop/mail_links.rs`, line: 168, name: 'mail_links::record' },
    { path: `${crates}mixdog-tools/src/desktop/mail_links.rs`, line: 189, name: 'mail_links::link_for' },
    { path: `${crates}mixdog-mcp/src/mail_reads.rs`, line: 30, name: 'mail_reads::record' },
    { path: `${crates}mixdog-tools/src/desktop/browser.rs`, line: 639, name: 'BrowserTool (Tool::call, action navigate)' },
  ],
  missing: [],
};
const set = openSet('mail-link-navigation', import.meta.url);
const load = async (rel) => set.load(rel);
const { Readable } = await import('node:stream');
const { parseEnvelope } = await load('node_modules/imapflow/dist/esm/tools.js');
const mcpClient = await load('src/runtime/agent/orchestrator/mcp/client.mjs');
const mailLinks = await load('src/runtime/browser-bridge/mail-links.mjs');
const { dispatchToolCall } = await load('src/runtime/agent/orchestrator/session/loop/tool-exec/dispatch.mjs');
const { withGmailAppPasswordMcp } = await load('src/runtime/connectors/gmail-app-password.mjs');
const { GMAIL_APP_PASSWORD } = await load('src/runtime/shared/connector-catalog.mjs');
const { executeBrowserTool } = await load('src/runtime/browser-bridge/client.mjs');
const { createBrowserAgentBridge } = await load('apps/desktop/src/main/browser/agent-bridge.ts');
const { createBrowserUrlAdmission } = await load('apps/desktop/src/main/browser/url-admission.ts');
const { bridgeDiscoveryDirectory } = await load('apps/desktop/src/main/bridge/discovery-file.ts');

/** The runtime's browser client against the real desktop bridge, whose navigate admits URLs exactly as actions/navigation.ts does. */
async function withBridge() {
  const admission = createBrowserUrlAdmission({ policy: {}, lookupAddresses: async () => [{ address: '93.184.216.34' }] });
  const seen = [];
  const { promise: ready, resolve } = Promise.withResolvers();
  const bridge = createBrowserAgentBridge({
    chains: new Map(),
    pendingReads: new Map(),
    execute: async (command) => {
      seen.push(command);
      return { text: `Navigated to ${await admission.validatedAgentUrl(command.url, command.mail_link)}` };
    },
    finishTurn: () => 0,
    beginTurn: () => {},
    secretInput: async () => ({ text: 'blocked' }),
    handoffPage: async () => ({}),
    visibleGuests: () => [],
    lifecycle: { attachDebuggerEagerly() {}, reclaimIdleBackgroundPages() {}, destroyAllBackgroundPages() {} },
    onDiagnostic: (event) => event === 'browser-bridge-ready' && resolve(),
    redactSecrets: (_session, text) => text,
  });
  bridge.start();
  await ready;
  // Date.now is held at FIXED_NOW for the whole recording, and the runtime trusts a discovery file only while it is fresh by that
  // clock: the file is dated by it, as a heartbeat would date it.
  const stamp = FIXED_NOW / 1000;
  utimesSync(join(bridgeDiscoveryDirectory(), 'browser-bridge.json'), stamp, stamp);
  return {
    seen,
    navigate: async (sessionId, input) => {
      const result = await executeBrowserTool({ action: 'navigate', input }, { sessionId });
      return { text: result.content[0].text, isError: result.isError === true };
    },
    stop: async () => bridge.stop(),
  };
}

const scenarios = mailLinkScenarios({
  Readable,
  parseEnvelope,
  withGmailAppPasswordMcp,
  GMAIL_APP_PASSWORD,
  recordMailLinks: mailLinks.recordMailLinks,
  mailLinkFor: mailLinks.mailLinkFor,
  MAIL_LINK_WINDOW_MS: mailLinks.MAIL_LINK_WINDOW_MS,
  registerServer: mcpClient._registerMcpServerForTest,
  disconnectAll: mcpClient.disconnectAll,
  dispatchToolCall,
  withBridge,
});
for (const [name, scenario] of Object.entries(scenarios)) await set.run(name, scenario);

await set.finish({
  entry: 'mail_links::record / link_for (the mails read for a session and the link offered for a URL), mail_reads::record (which tool results are a built-in mail read), the browser tool\'s navigate (the mail_link it hands the host command)',
  replay: { entry: 'each case\'s operations in recorded order: record / dispatch / probe / navigate, every answer compared whole (a link is {url, from_domain, read_at}; a navigate hands the host exactly the recorded command\'s fields beside action and session_id)', normalised: {} },
  exclusions: {
    connectorLinks: 'the `links` the Node connector extracted from each scripted message (HTML hyperlinks and text URIs) are recorded as an observation and not replayed: the core has no Gmail IMAP reader, so the recorded read_email results are the inputs of the replay',
    navigateText: 'the text and isError of a navigate the desktop answered (Navigated to / refused by the secret-token rule) belong to the desktop host, which stays (apps/desktop/src/main/browser/url-policy.ts mailLinkAdmits, covered by url-policy.test.mjs); the replay compares them only where the runtime itself refused (a claimed mail_link) and where nothing reached the host',
    'the desktop checks the runtime-set link against the URL and the sender itself': 'the second test of mail-link-navigation.test.mjs forges a bridge command with a mail_link naming another URL: only the desktop receives such a command, the core never builds one; not recorded',
  },
});
process.exit(0);
