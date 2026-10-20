// Characterization of the agent / workflow editor surfaces of the
// workflow-agents API against a real data directory: catalog listing, custom
// agent create/update/delete (including starter tombstones and fixed-role
// overrides), and workflow pack create/save/delete with active fallback.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import test from 'node:test';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import {
  AGENT_DELETED_MARKER,
  FIXED_AGENT_SLOTS,
  clearAgentDefinitionCache,
  createWorkflowHelpers,
  createWorkflowRouteHelpers,
  workflowIdFromName,
} from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { readMarkdownDocument, normalizeAgentPermissionOrNone } from '../runtime/shared/markdown-frontmatter.mjs';
import { isContactAgentId } from '../runtime/shared/agent-route-config.mjs';

const MAIN = { provider: 'openai', model: 'main-model' };

function fixture(t, extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-workflow-agents-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const helpers = createWorkflowHelpers({
    rootDir: join(process.cwd(), 'src'),
    dataDir,
    readMarkdownDocument,
    normalizeAgentPermissionOrNone,
  });
  const routeHelpers = createWorkflowRouteHelpers({ findPreset: () => null });
  const state = { config: { workflow: { active: 'default' } }, refreshes: 0 };
  const api = createWorkflowAgentsApi({
    ...helpers,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod: { getPluginData: () => dataDir },
    STANDALONE_DATA_DIR: dataDir,
    resolveRoute: (_config, requested) => (Object.keys(requested).length ? { ...requested } : { ...MAIN }),
    agentRouteFromConfig: routeHelpers.agentRouteFromConfig,
    saveConfigAndAdopt: (value) => {
      state.config = value;
    },
    lookupModelMeta: async () => ({}),
    ensureProvidersReady: async () => {},
    refreshEmptySessionToolPolicy: async () => {
      state.refreshes += 1;
      return { appliedToCurrentSession: true };
    },
    invalidateContextStatusCache() {},
    ...extra,
  });
  return { dataDir, helpers, state, api };
}

test('listAgents reports the fixed roles first with the effective Main route, then every custom agent', (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const agents = api.listAgents();
  const fixed = agents.slice(0, FIXED_AGENT_SLOTS.length);
  assert.deepEqual(
    fixed.map((agent) => [agent.id, agent.locked, agent.userOverride, agent.disabled]),
    FIXED_AGENT_SLOTS.map((agent) => [agent.id, true, false, false])
  );
  assert.deepEqual(fixed[0].route, { ...MAIN });
  // Main is only the fallback: no agent claims it as a route of its own.
  assert.ok(agents.every((agent) => agent.routeConfigured === false));
  const customIds = helpers.listCustomAgentIds(dataDir);
  assert.ok(customIds.length > 0, 'starter agents ship as custom agents');
  assert.deepEqual(
    agents.slice(FIXED_AGENT_SLOTS.length).map((agent) => agent.id),
    customIds
  );
  for (const agent of agents.slice(FIXED_AGENT_SLOTS.length)) {
    assert.equal(agent.custom, true);
    assert.equal(agent.userOverride, false);
    assert.equal(agent.label, agent.definition?.name || agent.id);
  }
});

test('kind: agent marks a Workflows-page agent at creation; it survives edits and never changes; unmarked agents stay bots', async (t) => {
  const { dataDir, api } = fixture(t);
  const isContact = (row) => isContactAgentId(row.id, row.kind);
  const role = await api.saveAgentDefinition({ name: 'Triage', body: 'Sort issues.', kind: 'agent' });
  assert.equal(role.kind, 'agent');
  const file = join(dataDir, 'agents', role.id, 'AGENT.md');
  assert.match(readFileSync(file, 'utf8'), /^---\nname: Triage\nkind: agent\n---\n/);
  const bot = await api.saveAgentDefinition({ name: 'Concierge', body: 'Plan my day.' });
  assert.equal(bot.kind, null);
  // A legacy custom agent on disk without the marker keeps meaning a bot.
  const legacyDir = join(dataDir, 'agents', 'watcher');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'AGENT.md'), '---\nname: Watcher\n---\nWatch GitHub.\n');
  const rows = new Map(api.listAgents().map((row) => [row.id, row]));
  assert.equal(isContact(rows.get(role.id)), false, 'the workflow agent is no contact');
  assert.equal(isContact(rows.get(bot.id)), true, 'a bot is a contact');
  assert.equal(isContact(rows.get('watcher')), true, 'an unmarked legacy agent is a contact');
  assert.equal(isContact(rows.get('worker')), false, 'shipped roles stay agents');
  // Edits keep the marker; a kind is never changed or given to an existing agent.
  const edited = await api.saveAgentDefinition({ id: role.id, name: 'Triage 2', body: 'Sort and label issues.' });
  assert.equal(edited.kind, 'agent');
  assert.match(readFileSync(file, 'utf8'), /kind: agent/);
  await assert.rejects(
    api.saveAgentDefinition({ id: bot.id, body: 'x', kind: 'agent' }),
    /kind is set when it is created/
  );
  await assert.rejects(api.saveAgentDefinition({ name: 'Odd', body: 'x', kind: 'bot' }), /agent kind must be "agent"/);
  assert.equal(api.getAgentDefinition(bot.id).kind, null);
});

test('saveAgentDefinition creates a custom agent (id from name, AGENT.md + manifest, optional route) and delete removes it everywhere', async (t) => {
  const { dataDir, state, api } = fixture(t);
  const created = await api.saveAgentDefinition({
    name: 'Release  Captain',
    description: 'Ships\nreleases',
    body: 'Cut releases carefully.',
    route: { provider: 'anthropic', model: 'claude' },
  });
  assert.equal(created.custom, true);
  assert.equal(created.userOverride, true);
  assert.equal(created.name, 'Release Captain');
  assert.equal(created.description, 'Ships releases');
  assert.equal(created.body, 'Cut releases carefully.');
  assert.equal(created.disabled, false);
  const savedRoute = { provider: 'anthropic', model: 'claude', fast: false, modelParameters: {} };
  assert.deepEqual(created.route, savedRoute);
  assert.equal(created.routeConfigured, true);
  const dir = join(dataDir, 'agents', created.id);
  assert.match(
    readFileSync(join(dir, 'AGENT.md'), 'utf8'),
    /^---\nname: Release Captain\ndescription: Ships releases\n---\n/
  );
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')), {
    name: 'Release Captain',
    description: 'Ships releases',
  });
  assert.deepEqual(state.config.agents[created.id], savedRoute);
  assert.ok(api.listAgents().some((agent) => agent.id === created.id && agent.custom));

  const renamed = await api.saveAgentDefinition({ id: created.id, name: 'Captain', body: 'Updated.' });
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.name, 'Captain');
  assert.equal(renamed.body, 'Updated.');
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')), 'description'), false);

  assert.deepEqual(await api.deleteAgentDefinition(created.id), {
    id: created.id,
    deleted: true,
    revertedToBuiltIn: false,
  });
  // Archived: gone from every surface, its name and face kept for its chat,
  // its AGENT.md moved aside and its model kept, so a restore is exact.
  assert.equal(existsSync(join(dir, 'AGENT.md')), false);
  assert.equal(existsSync(join(dir, 'AGENT.md.archived')), true);
  assert.equal(existsSync(join(dir, AGENT_DELETED_MARKER)), true);
  assert.deepEqual(state.config.agents[created.id], savedRoute);
  assert.throws(() => api.getAgentDefinition(created.id), /not found/);
  assert.equal(
    api.listAgents().some((agent) => agent.id === created.id),
    false
  );
  assert.deepEqual(api.agentDefinitionPresence([created.id]), { [created.id]: 'deleted' });
  assert.deepEqual(api.archivedAgentIdentities([created.id, 'worker']), {
    [created.id]: { name: 'Captain', avatar: null },
    worker: null,
  });
  await assert.rejects(api.deleteAgentDefinition(created.id), /not found/);
  // A new bot of the same name never takes over the archived one's id (or chat).
  const again = await api.saveAgentDefinition({ name: 'Release Captain', body: 'New.' });
  assert.equal(again.id, `${created.id}-2`);
  // Deleted again from 보관됨: everything it left goes for good.
  assert.deepEqual(await api.purgeAgentDefinition(created.id), { id: created.id, purged: true });
  assert.equal(existsSync(dir), false);
  assert.equal(Object.hasOwn(state.config.agents || {}, created.id), false, 'its model goes with it');
  assert.deepEqual(api.archivedAgentIdentities([created.id]), { [created.id]: null });
  // A live agent is never purged.
  assert.deepEqual(await api.purgeAgentDefinition(again.id), { id: again.id, purged: false });
  assert.ok(api.getAgentDefinition(again.id));
});

test('a deleted bot restores exactly under its own id, even after a new bot took its name', async (t) => {
  const { dataDir, state, api } = fixture(t);
  const bot = await api.saveAgentDefinition({
    name: 'Watcher',
    description: 'Watches PRs',
    body: 'Watch pull requests.',
    persona: 'Brief and calm.',
    route: { provider: 'anthropic', model: 'claude' },
  });
  await api.setAgentRoute(bot.id, { disabled: true });
  const dir = join(dataDir, 'agents', bot.id);
  const before = readFileSync(join(dir, 'AGENT.md'), 'utf8');
  await api.deleteAgentDefinition(bot.id);
  const newcomer = await api.saveAgentDefinition({ name: 'Watcher', body: 'Someone else.' });
  assert.equal(newcomer.id, `${bot.id}-2`);

  const restored = await api.restoreAgentDefinition(bot.id);
  assert.equal(restored.id, bot.id, 'its own id, not the newcomer');
  assert.equal(readFileSync(join(dir, 'AGENT.md'), 'utf8'), before);
  assert.deepEqual(
    [restored.name, restored.description, restored.body, restored.persona, restored.disabled],
    ['Watcher', 'Watches PRs', 'Watch pull requests.', 'Brief and calm.', true]
  );
  assert.equal(restored.routeConfigured, true);
  assert.equal(state.config.agents[bot.id].model, 'claude');
  assert.equal(existsSync(join(dir, AGENT_DELETED_MARKER)), false);
  assert.equal(existsSync(join(dir, 'AGENT.md.archived')), false);
  assert.deepEqual(api.agentDefinitionPresence([bot.id]), { [bot.id]: 'present' });
  assert.deepEqual(api.archivedAgentIdentities([bot.id]), { [bot.id]: null });
  assert.equal(api.getAgentDefinition(newcomer.id).body, 'Someone else.', 'the newcomer is untouched');
  // Only an archived agent restores; a live one, a fixed role or an unknown id never does.
  await assert.rejects(api.restoreAgentDefinition(bot.id), /is not deleted/);
  await assert.rejects(api.restoreAgentDefinition('maintainer'), /unknown agent/);
  await assert.rejects(api.restoreAgentDefinition('never-existed'), /is not deleted/);
  // One archived before its AGENT.md was kept has nothing to restore from.
  const legacy = join(dataDir, 'agents', 'legacy-bot');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'agent.json'), '{"name":"Legacy"}\n');
  writeFileSync(join(legacy, AGENT_DELETED_MARKER), 'deleted\n');
  await assert.rejects(api.restoreAgentDefinition('legacy-bot'), /cannot be restored/);
  assert.equal(existsSync(join(legacy, AGENT_DELETED_MARKER)), true);
});

test('a new agent made under an archived id (never restored) drops the kept model', async (t) => {
  const { state, api } = fixture(t);
  const bot = await api.saveAgentDefinition({
    name: 'Scout',
    body: 'Scout.',
    route: { provider: 'anthropic', model: 'claude' },
  });
  await api.deleteAgentDefinition(bot.id);
  const again = await api.saveAgentDefinition({ id: bot.id, name: 'Scout', body: 'New scout.' });
  assert.equal(again.routeConfigured, false);
  assert.equal(Object.hasOwn(state.config.agents || {}, bot.id), false);
});

test('agentDefinitionPresence proves a deletion per id from the files, never from a failed read', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const created = await api.saveAgentDefinition({ name: 'Watcher', body: 'Watch.' });
  const starter = helpers.listCustomAgentIds(dataDir).find((id) => id !== created.id);
  assert.deepEqual(api.agentDefinitionPresence([created.id, starter, 'never-existed']), {
    [created.id]: 'present',
    [starter]: 'present',
    'never-existed': 'deleted',
  });
  await api.deleteAgentDefinition(created.id);
  await api.deleteAgentDefinition(starter);
  // A removed user agent and a tombstoned starter are both proven gone.
  assert.deepEqual(api.agentDefinitionPresence([created.id, starter]), {
    [created.id]: 'deleted',
    [starter]: 'deleted',
  });
  // Malformed ids are never judged.
  assert.deepEqual(api.agentDefinitionPresence(['Not An Id']), { 'Not An Id': 'unknown' });

  // A directory-read fault (EIO/EACCES) answers 'unknown', even for a gone agent.
  const failing = fixture(t, {
    statSync: () => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    },
  });
  assert.deepEqual(failing.api.agentDefinitionPresence(['never-existed']), { 'never-existed': 'unknown' });
});

test('saving an off agent with a picked model stores the model and keeps the agent off', async (t) => {
  const { state, api } = fixture(t);
  const created = await api.saveAgentDefinition({
    name: 'Quiet Reviewer',
    body: 'Review quietly.',
    route: { disabled: true },
  });
  assert.equal(created.disabled, true);
  const saved = await api.saveAgentDefinition({
    id: created.id,
    name: 'Quiet Reviewer',
    body: 'Review quietly.',
    route: { provider: 'anthropic', model: 'claude', disabled: true },
  });
  assert.equal(saved.disabled, true);
  const savedRoute = { provider: 'anthropic', model: 'claude', fast: false, modelParameters: {} };
  assert.deepEqual(saved.route, savedRoute);
  assert.deepEqual(state.config.agents[created.id], savedRoute);
});

test('an archived agent keeps its disabled-roster entry until purged, and a recreated agent of that id starts enabled', async (t) => {
  const { dataDir, helpers, state, api } = fixture(t);
  const starter = helpers.listCustomAgentIds(dataDir)[0];
  state.config = { ...state.config, disabledAgents: [starter, 'other-agent'] };
  await api.deleteAgentDefinition(starter);
  // Kept for an exact restore; deleting it for good clears it.
  assert.deepEqual(state.config.disabledAgents, [starter, 'other-agent']);
  await api.purgeAgentDefinition(starter);
  assert.deepEqual(state.config.disabledAgents, ['other-agent']);

  state.config = { ...state.config, disabledAgents: [starter, 'other-agent'] };
  await api.saveAgentDefinition({ id: starter, name: 'Recreated', body: 'Recreated prompt.' });
  assert.equal(api.listAgents().find((agent) => agent.id === starter).disabled, false);
  assert.deepEqual(state.config.disabledAgents, ['other-agent']);

  await api.saveAgentDefinition({ id: starter, name: 'Recreated', body: 'Edited prompt.' });
  state.config = { ...state.config, disabledAgents: [starter] };
  await api.saveAgentDefinition({ id: starter, name: 'Recreated', body: 'Edited again.' });
  assert.equal(api.listAgents().find((agent) => agent.id === starter).disabled, true);
});

test('agent editor validation: empty body, bad id, missing name, hidden roles', async (t) => {
  const { api } = fixture(t);
  await assert.rejects(api.saveAgentDefinition({ name: 'x' }), /AGENT.md body must not be empty/);
  await assert.rejects(api.saveAgentDefinition({ id: '///', body: 'b' }), /agent id must contain letters\/numbers/);
  await assert.rejects(api.saveAgentDefinition({ body: 'b' }), /agent name must not be empty/);
  assert.throws(() => api.getAgentDefinition('   '), /unknown agent/);
  await assert.rejects(api.deleteAgentDefinition('does-not-exist'), /not found/);
});

test('deleting a shipped starter agent leaves a tombstone; a fixed role needs an override to reset and then reverts', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const starter = helpers.listCustomAgentIds(dataDir)[0];
  const result = await api.deleteAgentDefinition(starter);
  assert.deepEqual(result, { id: starter, deleted: true, revertedToBuiltIn: false });
  assert.equal(existsSync(join(dataDir, 'agents', starter, AGENT_DELETED_MARKER)), true);
  assert.equal(helpers.loadAgentDefinition(dataDir, starter), null);
  assert.equal(helpers.listCustomAgentIds(dataDir).includes(starter), false);

  const fixed = FIXED_AGENT_SLOTS[0].id;
  await assert.rejects(api.deleteAgentDefinition(fixed), /has no user override to reset/);
  const override = await api.saveAgentDefinition({ id: fixed, body: 'Custom maintainer prompt.' });
  assert.equal(override.custom, false);
  assert.equal(override.userOverride, true);
  assert.equal(api.listAgents().find((agent) => agent.id === fixed).userOverride, true);
  assert.deepEqual(await api.deleteAgentDefinition(fixed), { id: fixed, deleted: true, revertedToBuiltIn: true });
  assert.equal(api.getAgentDefinition(fixed).userOverride, false);
});

test('an editor save keeps frontmatter the editor does not show: shipped first, then the user copy', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const shipped = helpers.loadAgentDefinition(dataDir, 'maintainer');
  assert.equal(shipped.permission, 'read-write');
  await api.saveAgentDefinition({ id: 'maintainer', name: shipped.name, body: 'Edited maintainer prompt.' });
  assert.equal(helpers.loadAgentDefinition(dataDir, 'maintainer').permission, 'read-write');

  // A value the user set by hand in their copy survives the next editor save.
  const file = join(dataDir, 'agents', 'maintainer', 'AGENT.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('permission: read-write', 'permission: read'));
  clearAgentDefinitionCache('maintainer');
  await api.saveAgentDefinition({ id: 'maintainer', name: shipped.name, body: 'Edited again.' });
  const saved = helpers.loadAgentDefinition(dataDir, 'maintainer');
  assert.equal(saved.permission, 'read');
  assert.equal(saved.body, 'Edited again.');
});

test('an avatar round-trips through agent.json, keeping manifest keys and frontmatter the editor does not show', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const avatar = { kind: 'mascot', species: 'shepherd', accessory: 'collar', expression: 'calm', color: '#5b9bff' };
  const created = await api.saveAgentDefinition({ name: 'GitHub Watcher', body: 'Watch.', avatar });
  const dir = join(dataDir, 'agents', created.id);
  const manifestFile = join(dir, 'agent.json');
  assert.deepEqual(JSON.parse(readFileSync(manifestFile, 'utf8')), { name: 'GitHub Watcher', avatar });
  assert.deepEqual(created.avatar, avatar);
  assert.deepEqual(api.listAgents().find((agent) => agent.id === created.id).avatar, avatar);

  // Keys set by hand elsewhere survive every editor save.
  writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(readFileSync(manifestFile, 'utf8')), team: 'infra' }));
  const doc = join(dir, 'AGENT.md');
  writeFileSync(
    doc,
    readFileSync(doc, 'utf8').replace('name: GitHub Watcher', 'name: GitHub Watcher\npermission: read')
  );
  clearAgentDefinitionCache(created.id);
  // An older `variant` pick is saved as its mapped look.
  const next = { kind: 'mascot', variant: 'folded-happy-plain', color: '#F2C94C' };
  await api.saveAgentDefinition({ id: created.id, name: 'GitHub Watcher', body: 'Watch more.', avatar: next });
  assert.deepEqual(JSON.parse(readFileSync(manifestFile, 'utf8')), {
    name: 'GitHub Watcher',
    team: 'infra',
    avatar: { kind: 'mascot', species: 'terrier', accessory: 'none', expression: 'happy', color: '#f2c94c' },
  });
  assert.equal(helpers.loadAgentDefinition(dataDir, created.id).permission, 'read');

  // A save without `avatar` keeps it; null clears it; a bad one is refused.
  await api.saveAgentDefinition({ id: created.id, name: 'GitHub Watcher', body: 'Watch.' });
  assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).avatar.species, 'terrier');
  // A manifest still holding an old `variant` reads as its mapped look.
  writeFileSync(
    manifestFile,
    JSON.stringify({ name: 'GitHub Watcher', team: 'infra', avatar: { ...next, variant: 'perky-calm-collar' } })
  );
  clearAgentDefinitionCache(created.id);
  assert.deepEqual(api.getAgentDefinition(created.id).avatar, { ...avatar, color: '#f2c94c' });
  await assert.rejects(
    api.saveAgentDefinition({ id: created.id, name: 'x', body: 'b', avatar: { kind: 'mascot', variant: 'nope' } }),
    /agent avatar/
  );
  const cleared = await api.saveAgentDefinition({
    id: created.id,
    name: 'GitHub Watcher',
    body: 'Watch.',
    avatar: null,
  });
  assert.equal(cleared.avatar, null);
  assert.deepEqual(JSON.parse(readFileSync(manifestFile, 'utf8')), { name: 'GitHub Watcher', team: 'infra' });
});

/** A real PNG `side`² (an APNG when animated: it carries an acTL chunk). */
function png(side, animated = false, height = side) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(animated ? [chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))] : []),
    chunk('IDAT', deflateSync(Buffer.alloc((side * 4 + 1) * height))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const pngUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;

test('custom avatar images are stored per state under avatar/, checked, read back on demand and pruned', async (t) => {
  const { dataDir, api } = fixture(t);
  const moving = png(64, true);
  const poster = png(64);
  const still = png(128);
  const created = await api.saveAgentDefinition({
    name: 'Painter',
    body: 'Paint.',
    avatar: { kind: 'custom', states: { idle: { data: pngUrl(moving), poster: pngUrl(poster) } } },
  });
  const dir = join(dataDir, 'agents', created.id);
  const { avatar } = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'));
  assert.deepEqual(Object.keys(avatar.states), ['idle']);
  assert.match(avatar.states.idle, /^idle-[0-9a-f]{12}\.png$/);
  assert.deepEqual(readFileSync(join(dir, 'avatar', avatar.states.idle)), moving);
  assert.deepEqual(readFileSync(join(dir, 'avatar', avatar.states.idle.replace('.png', '.poster.png'))), poster);
  // The catalog carries only file names; the bytes come from their own read.
  assert.deepEqual(api.listAgents().find((agent) => agent.id === created.id).avatar, avatar);
  assert.deepEqual(api.getAgentAvatarImage(created.id), {
    states: { idle: { file: avatar.states.idle, url: pngUrl(moving), poster: pngUrl(poster) } },
  });

  // Add a still typing image, keeping idle by name.
  const save = (states) =>
    api.saveAgentDefinition({ id: created.id, name: 'Painter', body: 'Paint.', avatar: { kind: 'custom', states } });
  const typed = await save({ idle: avatar.states.idle, typing: { data: pngUrl(still) } });
  assert.equal(typed.avatar.states.idle, avatar.states.idle);
  assert.match(typed.avatar.states.typing, /^typing-[0-9a-f]{12}\.png$/);
  assert.deepEqual(api.getAgentAvatarImage(created.id).states.typing, {
    file: typed.avatar.states.typing,
    url: pngUrl(still),
    poster: '',
  });

  // Refused: markup, a lying data URL, odd sizes, an animation without its
  // first frame, no idle, a kept name that does not exist.
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="x()"/>').toString('base64')}`;
  const fake = `data:image/png;base64,${Buffer.from('<svg onload="x()"/>'.padEnd(64)).toString('base64')}`;
  const gifAsPng = `data:image/gif;base64,${still.toString('base64')}`;
  for (const [states, problem] of [
    [{ idle: { data: svg } }, /PNG, GIF or WebP/],
    [{ idle: { data: fake } }, /PNG, GIF or WebP/],
    [{ idle: { data: gifAsPng } }, /PNG, GIF or WebP/],
    [{ idle: { data: pngUrl(png(300, false, 200)) } }, /square/],
    [{ idle: { data: pngUrl(png(600)) } }, /512px/],
    [{ idle: { data: pngUrl(Buffer.concat([still, Buffer.alloc(1024 * 1024)])) } }, /1 MB/],
    [{ idle: { data: pngUrl(moving) } }, /first frame/],
    [{ idle: { data: pngUrl(moving), poster: pngUrl(moving) } }, /still PNG/],
    [{ typing: { data: pngUrl(still) } }, /idle/],
    [{ idle: 'idle-000000000000.png' }, /not found/],
  ]) {
    await assert.rejects(save(states), problem, JSON.stringify(Object.keys(states)));
  }
  assert.deepEqual(api.getAgentDefinition(created.id).avatar, typed.avatar, 'a refused save writes nothing');

  // Leaving a state out resets it (back to idle) and drops its file.
  await save({ idle: avatar.states.idle });
  assert.equal(existsSync(join(dir, 'avatar', typed.avatar.states.typing)), false);
  // Switching back to a mascot drops every image.
  await api.saveAgentDefinition({
    id: created.id,
    name: 'Painter',
    body: 'Paint.',
    avatar: { kind: 'mascot', species: 'labrador', color: '#e6e6e6' },
  });
  assert.deepEqual(readdirSync(join(dir, 'avatar')), []);
  assert.equal(api.getAgentAvatarImage(created.id), null);
});

test('the older single image avatar reads as the idle image and is replaced cleanly', async (t) => {
  const { dataDir, api } = fixture(t);
  const created = await api.saveAgentDefinition({ name: 'Old Face', body: 'Work.' });
  const dir = join(dataDir, 'agents', created.id);
  const old = png(256);
  writeFileSync(join(dir, 'avatar-0123456789ab.png'), old);
  const manifest = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'));
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({ ...manifest, avatar: { kind: 'image', file: 'avatar-0123456789ab.png' } })
  );
  clearAgentDefinitionCache(created.id);
  const migrated = { kind: 'custom', states: { idle: 'avatar-0123456789ab.png' } };
  assert.deepEqual(api.getAgentDefinition(created.id).avatar, migrated);
  assert.deepEqual(api.getAgentAvatarImage(created.id), {
    states: { idle: { file: 'avatar-0123456789ab.png', url: pngUrl(old), poster: '' } },
  });
  // Kept by name while a typing image is added beside it.
  const kept = await api.saveAgentDefinition({
    id: created.id,
    name: 'Old Face',
    body: 'Work.',
    avatar: { kind: 'custom', states: { idle: 'avatar-0123456789ab.png', typing: { data: pngUrl(png(64)) } } },
  });
  assert.equal(kept.avatar.states.idle, 'avatar-0123456789ab.png');
  assert.equal(existsSync(join(dir, 'avatar-0123456789ab.png')), true);
  // The older upload shape still saves: as a new idle image, the old file gone.
  const replaced = await api.saveAgentDefinition({
    id: created.id,
    name: 'Old Face',
    body: 'Work.',
    avatar: { kind: 'image', data: pngUrl(png(32)) },
  });
  assert.match(replaced.avatar.states.idle, /^idle-[0-9a-f]{12}\.png$/);
  assert.equal(existsSync(join(dir, 'avatar-0123456789ab.png')), false);
});

test('PERSONA.md is written beside AGENT.md, read back, kept when absent and removed when cleared', async (t) => {
  const { dataDir, api } = fixture(t);
  const created = await api.saveAgentDefinition({
    name: 'Buddy',
    body: 'Help.',
    persona: '  반말로, 재영님이라고 부릅니다.  ',
  });
  const file = join(dataDir, 'agents', created.id, 'PERSONA.md');
  assert.equal(readFileSync(file, 'utf8'), '반말로, 재영님이라고 부릅니다.\n');
  assert.equal(created.persona, '반말로, 재영님이라고 부릅니다.');
  assert.equal(api.getAgentDefinition(created.id).persona, '반말로, 재영님이라고 부릅니다.');
  // A save without `persona` (e.g. Mixy's setup tool) leaves it alone.
  await api.saveAgentDefinition({ id: created.id, name: 'Buddy', body: 'Help more.' });
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(join(dataDir, 'agents', created.id, 'AGENT.md'), 'utf8').includes('Help more.'), true);
  const cleared = await api.saveAgentDefinition({ id: created.id, name: 'Buddy', body: 'Help more.', persona: '' });
  assert.equal(existsSync(file), false);
  assert.equal(cleared.persona, '');
  assert.equal(existsSync(join(dataDir, 'agents', created.id, 'agent.json')), true);
});

test('a save carrying a stale revision is refused as a conflict; a fresh one or none saves', async (t) => {
  const { api } = fixture(t);
  const created = await api.saveAgentDefinition({ name: 'Watcher', description: 'one', body: 'Work.' });
  const loaded = api.getAgentDefinition(created.id);
  assert.match(loaded.revision, /^[0-9a-f]{24}$/);
  // Another surface (the Workflows editor, the setup tool) saves meanwhile, with no revision.
  const other = await api.saveAgentDefinition({ id: created.id, name: 'Watcher', description: 'two', body: 'Work.' });
  assert.equal(other.description, 'two', 'a save without a revision still wins');
  assert.notEqual(other.revision, loaded.revision);
  await assert.rejects(
    api.saveAgentDefinition({
      id: created.id,
      expectedRevision: loaded.revision,
      name: 'Watcher',
      description: 'stale',
      body: 'Work.',
    }),
    (error) => error.code === 'AGENT_DEFINITION_CONFLICT' && /AGENT_DEFINITION_CONFLICT/.test(error.message)
  );
  assert.equal(api.getAgentDefinition(created.id).description, 'two', 'the stale save wrote nothing');
  const fresh = await api.saveAgentDefinition({
    id: created.id,
    expectedRevision: other.revision,
    name: 'Watcher',
    description: 'three',
    persona: '짧게',
    body: 'Work.',
  });
  assert.equal(fresh.description, 'three');
  assert.notEqual(fresh.revision, other.revision, 'PERSONA.md is part of the revision');
});

test("Mixy's persona is agents/lead/PERSONA.md: saved, read back and removed when cleared", async (t) => {
  const { dataDir, api } = fixture(t);
  assert.equal(api.getLeadPersona(), '');
  assert.equal(api.saveLeadPersona('  존댓말로 짧게 답합니다.  '), '존댓말로 짧게 답합니다.');
  const file = join(dataDir, 'agents', 'lead', 'PERSONA.md');
  assert.equal(readFileSync(file, 'utf8'), '존댓말로 짧게 답합니다.\n');
  assert.equal(api.getLeadPersona(), '존댓말로 짧게 답합니다.');
  assert.ok(!api.listAgents().some((agent) => agent.id === 'lead'), 'the persona never makes Mixy a custom agent');
  assert.equal(api.saveLeadPersona(''), '');
  assert.equal(existsSync(file), false);
  assert.throws(() => api.saveLeadPersona('x'.repeat(256 * 1024 + 1)), /256 KB/);
});

test("Mixy's 일하는 방식 is agents/lead/AGENT.md: saved, read back and removed when cleared", async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  assert.equal(api.getLeadAgentBody(), '');
  assert.equal(api.saveLeadAgentBody('  일정부터 챙깁니다.  '), '일정부터 챙깁니다.');
  const file = join(dataDir, 'agents', 'lead', 'AGENT.md');
  assert.equal(readFileSync(file, 'utf8'), '일정부터 챙깁니다.\n');
  assert.equal(api.getLeadAgentBody(), '일정부터 챙깁니다.');
  assert.ok(!api.listAgents().some((agent) => agent.id === 'lead'), 'its AGENT.md never makes Mixy a custom agent');
  assert.ok(!helpers.listCustomAgentIds(dataDir).includes('lead'));
  assert.equal(api.saveLeadAgentBody(''), '');
  assert.equal(existsSync(file), false);
  assert.throws(() => api.saveLeadAgentBody('x'.repeat(256 * 1024 + 1)), /256 KB/);
});

test("Mixy's created flag lives in agents/lead/agent.json: undecided, then set, keeping the other keys", async (t) => {
  const { dataDir, api } = fixture(t);
  assert.deepEqual(api.getLeadStatus(), { created: null, name: '', avatar: null });
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{ "keep": 1 }\n');
  assert.deepEqual(api.setLeadCreated(false), { created: false, name: '', avatar: null });
  assert.deepEqual(api.setLeadCreated(true, '  기본 비서 '), { created: true, name: '', avatar: null });
  const manifest = JSON.parse(readFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), 'utf8'));
  assert.equal(manifest.created, true);
  assert.equal(manifest.description, '기본 비서');
  assert.equal(manifest.keep, 1, 'the other keys are kept');
  assert.ok(!api.listAgents().some((agent) => agent.id === 'lead'), 'the flag never makes Mixy a custom agent');
  assert.throws(() => api.setLeadCreated('yes'), /boolean/);
});

test("Mixy's name and face are `name` and `avatar` in agents/lead/agent.json; empty goes back to the defaults", async (t) => {
  const { dataDir, api } = fixture(t);
  const face = {
    kind: 'custom',
    states: { idle: { data: `data:image/png;base64,${png(64).toString('base64')}` } },
  };
  const status = api.saveLeadIdentity({ name: '  Navi  ', avatar: face });
  assert.equal(status.name, 'Navi');
  assert.match(status.avatar.states.idle, /^idle-[0-9a-f]{12}\.png$/);
  const file = join(dataDir, 'agents', 'lead', 'agent.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(manifest.name, 'Navi', 'the key the runtime identity line reads');
  assert.deepEqual(manifest.avatar, status.avatar);
  assert.equal(api.getAgentAvatarImage('lead').states.idle.file, status.avatar.states.idle);
  // Only the keys given change; null drops the images too.
  api.setLeadCreated(true);
  assert.equal(api.saveLeadIdentity({ avatar: null }).name, 'Navi');
  assert.deepEqual(readdirSync(join(dataDir, 'agents', 'lead', 'avatar')), []);
  assert.deepEqual(api.saveLeadIdentity({ name: '' }), { created: true, name: '', avatar: null });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).created, true);
  assert.throws(() => api.saveLeadIdentity({ avatar: { kind: 'mascot', variant: 'nope' } }), /mascot/);
});

test('a starter saved unchanged but with an avatar keeps a user copy instead of folding back to shipped', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const starter = helpers.listCustomAgentIds(dataDir)[0];
  const shipped = api.getAgentDefinition(starter);
  const avatar = { kind: 'mascot', species: 'labrador', accessory: 'none', expression: 'calm', color: '#9a9a9a' };
  await api.saveAgentDefinition({
    id: starter,
    name: shipped.name,
    description: shipped.description,
    body: shipped.body,
    avatar,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'agents', starter, 'agent.json'), 'utf8')).avatar, avatar);
  assert.deepEqual(api.getAgentDefinition(starter).avatar, avatar);
});

test('workflow packs: create derives a free id, save/list/set round-trip, delete falls the active workflow back to Default', async (t) => {
  const { dataDir, state, api } = fixture(t);
  const first = await api.createWorkflow({ name: 'Review  Flow', description: 'Two\nlines', body: 'Review first.' });
  assert.equal(first.id, workflowIdFromName('Review Flow'));
  assert.deepEqual(first, {
    id: first.id,
    name: 'Review Flow',
    description: 'Two lines',
    source: 'user',
    body: 'Review first.',
    userOverride: true,
  });
  const second = await api.createWorkflow({ name: 'Review Flow', body: 'Again.' });
  assert.notEqual(second.id, first.id, 'a taken id yields the next available one');
  await assert.rejects(api.createWorkflow({ id: first.id, name: 'Dup', body: 'x' }), /already exists/);
  await assert.rejects(api.createWorkflow({ name: '   ', body: 'x' }), /workflow name must not be empty/);
  await assert.rejects(api.saveWorkflowPack({ id: first.id, body: '  ' }), /WORKFLOW.md body must not be empty/);

  assert.deepEqual(
    api.listWorkflows().map((workflow) => [workflow.id, workflow.active]),
    [
      ['default', true],
      [first.id, false],
      [second.id, false],
    ]
  );
  const applied = await api.setWorkflow(first.id);
  assert.equal(applied.appliedToCurrentSession, true);
  assert.equal(state.config.workflow.active, first.id);
  assert.equal(state.refreshes, 1);
  await assert.rejects(api.setWorkflow('nope'), /workflow "nope" not found/);

  assert.deepEqual(await api.deleteWorkflow(first.id), { id: first.id, deleted: true, revertedToBuiltIn: false });
  assert.equal(state.config.workflow.active, 'default', 'a removed active pack falls back to Default');
  assert.equal(existsSync(join(dataDir, 'workflows', first.id)), false);
  assert.throws(() => api.getWorkflowPack(first.id), /not found/);
  await assert.rejects(api.deleteWorkflow(first.id), /not found/);
  assert.throws(() => api.getWorkflowPack(''), /unknown workflow/);
});

test('a built-in workflow cannot be deleted until a user override exists; deleting the override reverts it', async (t) => {
  const { dataDir, api } = fixture(t);
  await assert.rejects(api.deleteWorkflow('default'), /built-in and cannot be deleted/);
  const builtIn = api.getWorkflowPack('default');
  assert.equal(builtIn.userOverride, false);
  const saved = await api.saveWorkflowPack({ id: 'default', body: 'Overridden default.' });
  assert.equal(saved.userOverride, true);
  assert.equal(saved.name, 'default', 'a missing name falls back to the id');
  assert.match(
    readFileSync(join(dataDir, 'workflows', 'default', 'WORKFLOW.md'), 'utf8'),
    /^---\nid: default\nname: default\n---\n/
  );
  assert.deepEqual(await api.deleteWorkflow('default'), { id: 'default', deleted: true, revertedToBuiltIn: true });
  assert.equal(api.getWorkflowPack('default').body, builtIn.body);
});
