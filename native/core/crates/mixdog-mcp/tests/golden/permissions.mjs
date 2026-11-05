// Records, from today's Node product, what the connector permission lookups answer
// (agent-connectors.mjs `agentMcpToolPermission` and `projectMcpToolDisabled`) over data
// directories holding the policy files in many shapes, as the golden the Rust port replays.
// Usage: node permissions.mjs <repo-root> <out.json>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
const base = mkdtempSync(join(tmpdir(), 'perm-golden-'));
process.env.MIXDOG_DATA_DIR = join(base, 'unused');
const load = (p) => import(pathToFileURL(join(root, 'src', 'runtime', p)).href);
const connectors = await load('agent/orchestrator/mcp/agent-connectors.mjs');
const { rememberServerConnector } = await load('agent/orchestrator/mcp/server-connectors.mjs');
process.stderr.write = () => true;

const SERVERS = { gmail: 'gmail', 'gmail-2': 'gmail', 'gmail-10': 'gmail', calendar: 'google-calendar', notion: 'notion', plain: null, 'gmail-x': null, 'unknown-3': null, plugin_mixdog_mixdog: null };
const TOOLS = [
  'mcp__gmail__send_email', 'mcp__gmail__read_email', 'mcp__gmail-2__send_email', 'mcp__gmail-2__read_email', 'mcp__gmail-10__send_email',
  'mcp__calendar__delete_event', 'mcp__calendar__list_events', 'mcp__notion__search', 'mcp__plain__send_email', 'mcp__gmail-x__send_email',
  'mcp__unknown-3__any', 'mcp__plugin_mixdog_mixdog__recall', 'read', 'shell', '', 'functions.mcp__gmail__send_email', 'mcp__gmail__', 'mcp__gmail',
  'mcp____x__y', 'mcp__a__b__c', 'mcp__gmail__send_email\nx',
];
const AGENTS = ['lead', 'worker', 'Reviewer.3', 'bot-1', '.hidden', 'a b', 'a/b', '', 'x'.repeat(5), 'Reviewer.2'];

const j = (v) => JSON.stringify(v);
const agentJson = (connectorsField, extra = {}) => j({ name: 'x', ...extra, ...(connectorsField === undefined ? {} : { connectors: connectorsField }) });
const PERMS = { auto: 'auto', ask: 'needs_approval', off: 'disabled' };

const scenarios = [
  { name: 'no files at all', files: {} },
  { name: 'agent without connectors field', files: { 'agents/worker/agent.json': agentJson(undefined) } },
  { name: 'connectors null', files: { 'agents/worker/agent.json': agentJson(null) } },
  { name: 'off list', files: { 'agents/worker/agent.json': agentJson({ off: ['gmail', ' notion ', '', 5, null, 'gmail'] }) } },
  { name: 'off list switches an account of a group only by its own id', files: { 'agents/worker/agent.json': agentJson({ off: ['gmail-2'] }) } },
  { name: 'tools overrides', files: { 'agents/worker/agent.json': agentJson({ tools: { gmail: { send_email: 'auto', read_email: 'needs_approval' }, calendar: { delete_event: 'disabled' }, notion: { search: 'bogus', ' pad ': 'auto' } } }) } },
  { name: 'tools stored under accounts; lowest number wins', files: { 'agents/worker/agent.json': agentJson({ tools: { 'gmail-2': { send_email: 'disabled' }, 'gmail-10': { send_email: 'auto' }, 'gmail-x': { send_email: 'auto' } } }) } },
  { name: 'tools under the group and an account', files: { 'agents/worker/agent.json': agentJson({ tools: { gmail: { send_email: 'auto' }, 'gmail-2': { send_email: 'disabled' } } }) } },
  { name: 'off and tools together', files: { 'agents/worker/agent.json': agentJson({ off: ['notion'], tools: { notion: { search: 'auto' }, gmail: { send_email: 'auto' } } }) } },
  { name: 'empty policy object', files: { 'agents/worker/agent.json': agentJson({}) } },
  { name: 'legacy list', files: { 'agents/worker/agent.json': agentJson([{ id: 'gmail', enabled: true, tools: { send_email: 'auto' } }, { id: 'notion', enabled: false }, { id: ' calendar ', enabled: true }, { enabled: true }, null, { id: 'plain', enabled: 'true' }]) } },
  { name: 'legacy list, empty', files: { 'agents/worker/agent.json': agentJson([]) } },
  { name: 'unknown policy key', files: { 'agents/worker/agent.json': agentJson({ off: [], allow: ['gmail'] }) } },
  { name: 'off not a list', files: { 'agents/worker/agent.json': agentJson({ off: 'gmail' }) } },
  { name: 'off null', files: { 'agents/worker/agent.json': agentJson({ off: null, tools: { gmail: { send_email: 'auto' } } }) } },
  { name: 'tools not an object', files: { 'agents/worker/agent.json': agentJson({ tools: [] }) } },
  { name: 'tools of a server not an object', files: { 'agents/worker/agent.json': agentJson({ tools: { gmail: 'auto', notion: { search: 'disabled' } } }) } },
  { name: 'connectors a string', files: { 'agents/worker/agent.json': agentJson('gmail') } },
  { name: 'connectors a number', files: { 'agents/worker/agent.json': agentJson(5) } },
  { name: 'connectors false', files: { 'agents/worker/agent.json': agentJson(false) } },
  { name: 'agent.json is an array', files: { 'agents/worker/agent.json': '[]' } },
  { name: 'agent.json is null', files: { 'agents/worker/agent.json': 'null' } },
  { name: 'agent.json is empty', files: { 'agents/worker/agent.json': '' } },
  { name: 'agent.json is spaces', files: { 'agents/worker/agent.json': '  \n\t ' } },
  { name: 'agent.json is NUL filled', files: { 'agents/worker/agent.json': '\u0000\u0000\u0000' } },
  { name: 'agent.json is torn', files: { 'agents/worker/agent.json': '{"connectors":{"off":["gm' } },
  { name: 'agent.json has a byte order mark', files: { 'agents/worker/agent.json': `\ufeff${agentJson({ off: ['gmail'] })}` } },
  { name: 'damaged with a good backup', files: { 'agents/worker/agent.json': '{"connectors":', 'agents/worker/agent.json.bak': agentJson({ off: ['gmail'] }) } },
  { name: 'damaged with a damaged backup', files: { 'agents/worker/agent.json': '{"connectors":', 'agents/worker/agent.json.bak': '{' } },
  { name: 'damaged with a backup of a bad policy', files: { 'agents/worker/agent.json': '{"connectors":', 'agents/worker/agent.json.bak': agentJson({ nope: 1 }) } },
  { name: 'bad policy with a good backup', files: { 'agents/worker/agent.json': agentJson({ nope: 1 }), 'agents/worker/agent.json.bak': agentJson({ off: ['gmail'] }) } },
  { name: 'backup alone', files: { 'agents/worker/agent.json.bak': agentJson({ off: ['gmail'] }) } },
  { name: 'agent.json is a directory', dirs: ['agents/worker/agent.json'] },
  { name: 'the agent folder is a file', files: { 'agents/worker': 'x' } },
  { name: 'mixy policy before the bot store', files: { 'agents/lead/agent.json': agentJson({ off: ['gmail'] }), 'bots/mixy/agent.json': agentJson({ off: ['notion'] }) } },
  { name: 'mixy policy once the bot store is active', files: { 'bots/migration.json': j({ version: 1, bots: ['bot-1'] }), 'agents/lead/agent.json': agentJson({ off: ['gmail'] }), 'bots/mixy/agent.json': agentJson({ off: ['notion'] }) } },
  { name: 'a store bot reads its bots folder', files: { 'bots/migration.json': j({ version: 1, bots: ['bot-1'] }), 'bots/bot-1/agent.json': agentJson({ off: ['gmail'] }), 'agents/bot-1/agent.json': agentJson({ off: ['notion'] }) } },
  { name: 'a bot folder not in the manifest still counts when it exists', files: { 'bots/migration.json': j({ version: 1, bots: [] }), 'bots/bot-1/agent.json': agentJson({ off: ['gmail'] }), 'agents/bot-1/agent.json': agentJson({ off: ['notion'] }) } },
  { name: 'a hidden id', files: { 'bots/migration.json': j({ version: 1, bots: ['.hidden'] }), 'bots/.hidden/agent.json': agentJson({ off: ['gmail'] }) } },
  { name: 'bot store manifest of another version', files: { 'bots/migration.json': j({ version: 2, bots: ['bot-1'] }), 'bots/bot-1/agent.json': agentJson({ off: ['gmail'] }), 'agents/bot-1/agent.json': agentJson({ off: ['notion'] }) } },
  { name: 'bot store manifest is damaged', files: { 'bots/migration.json': '{', 'bots/bot-1/agent.json': agentJson({ off: ['gmail'] }), 'agents/bot-1/agent.json': agentJson({ off: ['notion'] }) } },
  { name: 'mixed-case agent id', files: { 'agents/Reviewer.2/agent.json': agentJson({ off: ['gmail'] }), 'agents/Reviewer.3/agent.json': agentJson({ off: ['notion'] }) } },
  { name: 'agent ids with odd characters', files: { 'agents/a b/agent.json': agentJson({ off: ['gmail'] }), 'agents/.hidden/agent.json': agentJson({ off: ['gmail'] }) } },
  { name: 'project file absent' , files: {} },
  { name: 'project file off entries', files: { 'project-connectors.json': j({ projects: { '$DIR/proj/a': { off: ['gmail', 'notion'] }, '$DIR/proj/b': { off: [] }, '  ': { off: ['gmail'] }, '$DIR/proj/c': {} } }) } },
  { name: 'project root with padding', files: { 'project-connectors.json': j({ projects: { '  $DIR/proj/a  ': { off: ['gmail'] } } }) } },
  { name: 'project root nested', files: { 'project-connectors.json': j({ projects: { '$DIR/proj': { off: ['notion'] } } }) } },
  { name: 'project root with a trailing separator', files: { 'project-connectors.json': j({ projects: { '$DIR/proj/a/': { off: ['gmail'] } } }) } },
  { name: 'project file without projects', files: { 'project-connectors.json': '{}' } },
  { name: 'project file projects null', files: { 'project-connectors.json': j({ projects: null }) } },
  { name: 'project file projects an array', files: { 'project-connectors.json': j({ projects: [] }) } },
  { name: 'project file an array', files: { 'project-connectors.json': '[]' } },
  { name: 'project file null', files: { 'project-connectors.json': 'null' } },
  { name: 'project entry not an object', files: { 'project-connectors.json': j({ projects: { '$DIR/proj/a': 'x' } }) } },
  { name: 'project off not a list', files: { 'project-connectors.json': j({ projects: { '$DIR/proj/a': { off: 'gmail' } } }) } },
  { name: 'project off null', files: { 'project-connectors.json': j({ projects: { '$DIR/proj/a': { off: null } } }) } },
  { name: 'project file damaged', files: { 'project-connectors.json': '{"projects":' } },
  { name: 'project file damaged with a good backup', files: { 'project-connectors.json': '{"projects":', 'project-connectors.json.bak': j({ projects: { '$DIR/proj/a': { off: ['gmail'] } } }) } },
  { name: 'project file empty', files: { 'project-connectors.json': '' } },
  { name: 'project file is a directory', dirs: ['project-connectors.json'] },
];

const QUERY_PATHS = [['$DIR/proj/a'], ['$DIR/proj/a/sub'], ['$DIR/proj/b'], ['$DIR/proj/ab'], ['$DIR/other'], ['$DIR/proj/a', '$DIR/other'], ['$DIR/other', '$DIR/proj/c'], ['$DIR/PROJ/A'], []];

const records = [];
for (const scenario of scenarios) {
  const dir = mkdtempSync(join(base, 's-'));
  const norm = (text) => text.replaceAll('$DIR', dir.replaceAll('\\', '/'));
  for (const d of scenario.dirs || []) mkdirSync(join(dir, d), { recursive: true });
  for (const [file, text] of Object.entries(scenario.files || {})) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, norm(text));
  }
  for (const [name, connector] of Object.entries(SERVERS)) rememberServerConnector(name, connector ? { connector } : {});
  records.push({ name: scenario.name, files: scenario.files || {}, dirs: scenario.dirs || [], agents: null, _dir: dir });
}
// Agent lookups read `resolvePluginData()` on every call; run each scenario with its own data dir.
for (const record of records) {
  process.env.MIXDOG_DATA_DIR = record._dir;
  record.agents = AGENTS.map((agent) => ({ agent, perms: TOOLS.map((tool) => connectors.agentMcpToolPermission(agent, tool)) }));
  record.projects = [];
  for (const paths of QUERY_PATHS) {
    const real = paths.map((p) => p.replaceAll('$DIR', record._dir.replaceAll('\\', '/')));
    const session = { cwd: real[0], workspace: real[1] ? { projectPath: real[1] } : undefined };
    record.projects.push({ paths, disabled: TOOLS.map((tool) => connectors.projectMcpToolDisabled(session, tool, record._dir)) });
  }
  delete record._dir;
}
process.env.MIXDOG_DATA_DIR = join(base, 'unused');
rmSync(base, { recursive: true, force: true });
writeFileSync(out, `${JSON.stringify({ servers: SERVERS, tools: TOOLS, agents: AGENTS, queryPaths: QUERY_PATHS, scenarios: records })}\n`);
console.log(`recorded ${records.length} scenarios`);
