// The matrix of `record-lead-request.mjs`: each scenario is a desktop user's settings (the config file, the files of the data directory and
// of the workspace) and the route the lead thread is on. A replay seeds the same settings into the composed core's profile.
export const PROMPT_TOKEN = 'LEAD-REQUEST-PROMPT';

/** The routes: a loopback `custom` provider on each wire (the Anthropic one carries `cache_control`, the OpenAI chat one has none). */
export const ROUTES = {
  anthropic: { provider: 'custom-lead', protocol: 'anthropic', wire: 'anthropic', model: 'claude-sonnet-4-5' },
  openai: { provider: 'custom-lead', protocol: 'openai-chat', wire: 'openai', model: 'gpt-5.5' },
};

// A stdio MCP server of one tool: what a user's connected server is, without a network or a package. `{DATA}` in a setting is the data
// directory of the side that reads it.
export const mcpStub = ({ instructions, description = 'Echo the text back.' } = {}) => `import { createInterface } from 'node:readline';
const tools = [{ name: 'echo', description: ${JSON.stringify(description)}, inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to echo.' } }, required: ['text'] } }];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' }, ...(${JSON.stringify(instructions ?? null)} === null ? {} : { instructions: ${JSON.stringify(instructions ?? null)} }) });
  else if (message.method === 'tools/list') reply(message.id, { tools });
  else if (message.method === 'tools/call') reply(message.id, { content: [{ type: 'text', text: message.params.arguments.text }] });
  else if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } }) + '\\n');
}
`;

const skill = (name, description, whenToUse) => `---\nname: ${name}\ndescription: ${description}\nwhen_to_use: ${whenToUse}\n---\n\n# ${name}\n\nDo the ${name} thing.\n`;
const en = { agent: { profile: { language: 'en' } } };
const withAgent = (agent, top = {}) => ({ ...top, agent: { ...agent, profile: { language: 'en', ...agent.profile } } });

/**
 * `route` names a ROUTES entry; `config` is the settings file (the providers are the recorder's), `data` and `workspace` are files by path
 * (the data directory's and the workspace's), `gitInit` makes the workspace a repository (`git init -b main`), `mcp` is true when the profile's servers are connected, `path` names what the PATH holds
 * besides the system folders (`node`).
 */
export const LEAD_SCENARIOS = [
  { name: 'default-anthropic', route: 'anthropic', config: en },
  { name: 'default-openai', route: 'openai', config: en },
  { name: 'style-detailed', route: 'anthropic', config: withAgent({}, { outputStyle: 'detailed' }) },
  { name: 'style-minimal-openai', route: 'openai', config: withAgent({}, { outputStyle: 'minimal' }) },
  { name: 'style-extreme-minimal', route: 'anthropic', config: withAgent({}, { outputStyle: 'extreme-minimal' }) },
  { name: 'language-korean-with-preferences', route: 'anthropic', config: withAgent({ profile: { language: 'ko', title: 'Boss', experienceLevel: 'expert' } }) },
  { name: 'language-japanese-junior', route: 'openai', config: withAgent({ profile: { language: 'ja', experienceLevel: 'junior' } }) },
  { name: 'workflow-headless', route: 'anthropic', config: withAgent({ workflow: { active: 'headless' } }) },
  {
    name: 'workflow-user-pack',
    route: 'anthropic',
    config: withAgent({ workflow: { active: 'review' } }),
    data: { 'workflows/review/WORKFLOW.md': '---\nid: review\nname: Review\ndescription: "Review first."\n---\n\n# Review\n\nRead the change, then say what is wrong with it.\n' },
  },
  { name: 'settings-route-default', route: 'anthropic', settingsRoute: true, config: en },
  { name: 'settings-route-git-module-off', route: 'anthropic', settingsRoute: true, config: withAgent({ modules: { git: { enabled: false } } }) },
  { name: 'fresh-profile-nothing-installed', route: 'anthropic', config: withAgent({ builtins: {} }) },
  { name: 'builtins-office-and-tidy-installed', route: 'anthropic', config: withAgent({ builtins: { office: { installed: true }, tidy: { installed: true } } }) },
  { name: 'git-and-media-modules-off', route: 'anthropic', config: withAgent({ modules: { git: { enabled: false }, media: { enabled: false } } }) },
  { name: 'instruction-files-default', route: 'openai', config: en, workspace: { 'AGENTS.md': '# Rules\n\nAsk before deleting.\n' } },
  {
    name: 'git-repository-workspace',
    route: 'anthropic',
    config: en,
    gitInit: true,
    workspace: { 'README.md': '# project\n', 'src/lib.rs': 'pub fn f() {}\n', '.gitignore': 'target/\n' },
  },  { name: 'orchestration-none', route: 'anthropic', config: withAgent({ orchestrationMode: 'none' }) },
  { name: 'orchestration-focused-openai', route: 'openai', config: withAgent({ orchestrationMode: 'focused' }) },
  { name: 'orchestration-swarm', route: 'anthropic', config: withAgent({ orchestrationMode: 'swarm' }) },
  {
    name: 'skills-present',
    route: 'anthropic',
    config: en,
    data: { 'skills/tidy/SKILL.md': skill('tidy', 'Tidy code.', 'Clean up, format or lint code.'), 'skills/notes/SKILL.md': skill('notes', 'Keep notes.', 'The user wants notes kept.') },
  },
  { name: 'skills-disabled-by-user', route: 'anthropic', config: withAgent({ skills: { disabled: ['tidy'] } }), data: { 'skills/tidy/SKILL.md': skill('tidy', 'Tidy code.', 'Clean up, format or lint code.') } },
  { name: 'memory-tools-off', route: 'anthropic', config: withAgent({ memoryTools: { enabled: false } }) },
  { name: 'web-search-off-openai', route: 'openai', config: withAgent({ modules: { webSearch: { enabled: false } } }) },
  {
    name: 'instruction-files',
    route: 'anthropic',
    config: withAgent({ instructionFiles: 'all' }),
    workspace: { 'AGENTS.md': '# Project rules\n\nUse tabs. Run the formatter before you finish.\n', 'src/main.rs': 'fn main() {}\n' },
  },
  {
    name: 'mcp-connected',
    route: 'anthropic',
    mcp: true,
    path: ['node'],
    config: withAgent({ mcpServers: { stub: { command: 'node', args: ['{DATA}/mcp-stub.mjs'] } } }),
    data: { 'mcp-stub.mjs': mcpStub() },
  },
  // The one-line entry of a connected server in the deferred listing: the first sentence of its MCP instructions (without an account sentence, `<`/`>`
  // and the closing stop), else its first tool's description; and the line is cut at 98 characters.
  {
    name: 'mcp-server-instructions',
    route: 'anthropic',
    mcp: true,
    path: ['node'],
    config: withAgent({ mcpServers: { stub: { command: 'node', args: ['{DATA}/mcp-stub.mjs'] } } }),
    data: { 'mcp-stub.mjs': mcpStub({ instructions: 'Echo text back to the user. Use it only when asked to repeat something.' }) },
  },
  {
    name: 'mcp-servers-instructions-account-and-long',
    route: 'openai',
    mcp: true,
    path: ['node'],
    config: withAgent({
      mcpServers: {
        alpha: { command: 'node', args: ['{DATA}/mcp-alpha.mjs'] },
        beta: { command: 'node', args: ['{DATA}/mcp-beta.mjs'] },
        gamma: { command: 'node', args: ['{DATA}/mcp-gamma.mjs'] },
      },
    }),
    data: {
      'mcp-alpha.mjs': mcpStub({ instructions: 'Account: someone@example.com. Echo <b>any text</b> that the user wants repeated back to them exactly as written, in the same order, for any reason whatsoever. Second sentence.' }),
      'mcp-beta.mjs': mcpStub({ description: 'Repeats the text it is given. Has no other use.' }),
      'mcp-gamma.mjs': mcpStub({ instructions: '   ' }),
    },
  },
  // The `visualize open` paragraph of the delivery rules is in the prompt only while the visualize tool is available (the desktop's bridge is up, or
  // the feature switch is on), and the tool joins the lists with it.
  { name: 'visualize-available', route: 'anthropic', env: { MIXDOG_FEATURE_VISUALIZE: '1' }, config: en },
  { name: 'visualize-available-openai', route: 'openai', env: { MIXDOG_FEATURE_VISUALIZE: '1' }, config: en },
  { name: 'visualize-available-headless', route: 'anthropic', env: { MIXDOG_FEATURE_VISUALIZE: '1' }, config: withAgent({ workflow: { active: 'headless' } }) },
  { name: 'visualize-switched-off', route: 'anthropic', env: { MIXDOG_FEATURE_VISUALIZE: '0' }, config: en },
  {
    name: 'user-agents',
    route: 'anthropic',
    config: en,
    data: {
      'agents/scout/AGENT.md': '---\nname: scout\n---\nScout finds things in the code and reports where they are.\n',
      'agents/scout/agent.json': JSON.stringify({ name: 'Scout', description: 'Finds code. Reports locations only.' }),
    },
  },
];
