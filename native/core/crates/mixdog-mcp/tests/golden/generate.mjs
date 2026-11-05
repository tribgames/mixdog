// Regenerates node.json from today's Node product. Run from the Node repo root:
//   MIXDOG_NODE_SRC=. node <path>/generate.mjs > node.json
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const src = pathToFileURL(resolve(process.env.MIXDOG_NODE_SRC || '.')).href;
const { providerSafeMcpToolName } = await import(`${src}/src/runtime/agent/orchestrator/mcp/client-config.mjs`);
const { normalizeMcpToolResult, capMcpResult } = await import(`${src}/src/runtime/agent/orchestrator/mcp/client.mjs`);
const rows = (n, w = 0) => Array.from({ length: n }, (_, i) => `line ${i + 1}${'x'.repeat(w)}`).join('\n');
const names = [
  ['fs', 'read_file'], ['my server', 'do it!'], ['srv', 'a'.repeat(80)], ['srv', `${'a'.repeat(80)}b`],
  ['a_b', 't'], ['x'.repeat(50), 'tool'], ['', 't'], ['s', 'é'], ['My.Server', 'Tool-Name_1'], ['gmail-2', 'describe_emails'],
  ['__lead', 'x'], ['a__b', 'tool'], ['-x-', 'tool'],
];
const normalize = [
  { content: [{ type: 'text', text: 'hi' }] },
  { content: [{ type: 'text', text: 'hi' }], structuredContent: { a: 1 } },
  { structuredContent: { a: 1 } },
  { content: 'plain string' },
  { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
  { isError: true, content: [{ type: 'text', text: 'boom' }] },
  { isError: true, content: [{ type: 'text', text: 'Error: already' }] },
  { isError: true, content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] },
  { isError: true, content: [{ type: 'text', text: 'x' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }] },
  { content: [{ type: 'image', data: 'aGk=', mimeType: 'IMAGE/PNG; charset=x' }] },
  { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/svg+xml' }] },
  { content: [{ type: 'image', data: '', mimeType: 'image/png' }] },
  { content: [{ type: 'audio', data: '', mimeType: 'audio/wav' }] },
  { content: [{ type: 'resource', resource: { uri: 'file:///x', text: 'RT' } }] },
  { content: [{ type: 'resource', resource: { uri: 'file:///x' } }] },
  { content: [{ type: 'resource_link', uri: 'u', name: 'n' }] },
  { content: [{ type: 'weird', k: 1 }, 'bare'] },
  { content: [{ type: 'text' }] },
];
const caps = [
  { parts: [{ rows: 1999 }] }, { parts: [{ rows: 2000 }] }, { parts: [{ rows: 2001 }] },
  { parts: [{ rows: 2500 }] }, { parts: [{ rows: 1000, width: 100 }] }, { parts: [{ rows: 3000, width: 30 }] },
  { parts: [{ bigLine: 204800 }] },
  { parts: [{ rows: 1500 }, { image: true }, { rows: 1500 }] },
  { parts: [{ rows: 50 }, { rows: 2400 }, { rows: 50 }] },
];
const build = (spec) => spec.parts.map((p) => p.image ? { type: 'image', data: 'aGk=', mimeType: 'image/png' }
  : { type: 'text', text: p.bigLine ? 'x'.repeat(p.bigLine) : rows(p.rows, p.width || 0) });
const spill = (t) => t.replace(/spilled to [^\]]+\]/, 'spilled to <SPILL>]');
const { classifyOutboundCall, classifyAsDelete } = await import(`${src}/src/runtime/agent/orchestrator/session/human-gate/outbound-policy.mjs`);
const { isRemoteDeleteInRun } = await import(`${src}/src/runtime/agent/orchestrator/session/human-gate/run-policy.mjs`);
// The gate's rule for one connector call: the classification, then the remote-delete floor.
function gateKind(server, tool, args, annotations) {
  const name = `mcp__${server}__${tool}`;
  const ann = { ...annotations, mcpToolName: tool };
  let classified = classifyOutboundCall({ name, args, annotations: ann });
  if (isRemoteDeleteInRun({ name, annotations: ann }, classified) && classified?.category !== 'delete' && classified?.category !== 'payment') {
    classified = classifyAsDelete({ name, args });
  }
  return classified?.category ?? null;
}
const toolNames = [
  'send_email', 'send-mail', 'Send_Message', 'reply_to_message', 'forward_email', 'list_payments', 'get_purchase', 'create_payment',
  'charge_card', 'place_order', 'send_money', 'delete_message', 'remove_member', 'destroy_item', 'erase_data', 'wipe_disk', 'purge_cache',
  'empty_trash', 'trash_emails', 'delete_file', 'delete_file_permanently', 'hard_delete_row', 'list_deleted_items', 'search_removed',
  'create_post', 'publish_post', 'post_tweet', 'submit_form', 'add_issue_comment', 'create_pull_request_review', 'do_thing', 'sync',
  'send', 'reply', 'gmail_send', 'describe_emails', 'checkout', 'buy_now', 'transfer_funds', 'delete_event', 'update_row', 'readme',
];
const servers = ['slack', 'gmail', 'my-mail', 'github', 'drive', 'stripe', 'x'];
const argSets = [{}, { permanent: true }, { permanent: 'true' }];
const hintSets = [{}, { readOnlyHint: true }, { outboundHint: true }, { readOnlyHint: true, outboundHint: true }];
const outbound = [];
for (const server of servers) for (const tool of toolNames) for (const args of argSets) for (const hints of hintSets) {
  outbound.push({ server, tool, args, hints, expected: gateKind(server, tool, args, hints) });
}
const { buildSkillManifest } = await import(`${src}/src/runtime/agent/orchestrator/context/skill-catalog.mjs`);
const long = 'Use this skill whenever the user wants to deploy, roll back, or inspect releases; also when asked about environments, canary rollouts, and feature flags across regions, with detailed notes. ';
const mkSkills = (n, deps) => Array.from({ length: n }, (_, i) => ({
  name: `skill-${String(n - i).padStart(3, '0')}`,
  whenToUse: i % 3 === 0 ? long : i % 3 === 1 ? 'short trigger' : '',
  toolDependencies: deps && i % 2 === 0 ? [{ type: 'tool', value: 'read' }, { type: 'mcp', value: 'github' }, { type: 'tool', value: 'bad value!' }, { type: 'http', value: 'x' }] : [],
}));
const manifestCases = [
  { skills: mkSkills(3, true), options: {} },
  { skills: mkSkills(5, false), options: {} },
  { skills: mkSkills(90, false), options: {} },
  { skills: mkSkills(30, true), options: { charBudget: 1500 } },
  { skills: mkSkills(12, true), options: { limit: 5 } },
  { skills: [], options: {} },
];
const manifests = manifestCases.map((c) => ({ ...c, expected: buildSkillManifest(c.skills, c.options) }));
const out = {
  manifests,
  outbound,
  names: names.map(([server, tool]) => ({ server, tool, expected: providerSafeMcpToolName(server, tool) })),
  normalize: await Promise.all(normalize.map(async (input) => {
    const r = await normalizeMcpToolResult(input);
    return { input, expected: r === undefined ? null : r };
  })),
  caps: caps.map((spec) => {
    const r = capMcpResult({ content: build(spec) });
    return { spec, expected: r.content.map((p) => (p.type === 'text' ? { ...p, text: spill(p.text) } : p)) };
  }),
};
console.log(JSON.stringify(out, null, 1));
process.exit(0);



