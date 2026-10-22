import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  holdsNoData,
  parseJsonText,
  readJsonStateSync,
  writeFileAtomicSync,
  writeJsonAtomicSync,
} from '../../runtime/shared/atomic-file.mjs';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { hasOwn } from '../../runtime/shared/object.mjs';
import { serializeFrontmatterDoc } from '../../runtime/shared/markdown-frontmatter.mjs';
import { isHiddenAgent } from '../../runtime/agent/orchestrator/internal-agents.mjs';
import {
  AGENT_DELETED_MARKER,
  FIXED_AGENT_SLOTS,
  availableAgentId,
  clearAgentDefinitionCache,
} from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import {
  BOT_AGENT_KIND,
  canonicalizeAgentRouteStorage,
  isAgentDisabled,
  WORKFLOW_AGENT_KIND,
  withAgentDisabled,
} from '../../runtime/shared/agent-route-config.mjs';
import { agentEditorId, effectiveAgentRoute, oneLine, resolveDataDir } from './shared.mjs';
import { publishAgentProfileChange } from '../agent-profile-changes.mjs';
import { absorbSaveEqualToShipped } from '../../runtime/shared/shipped-definitions.mjs';
import {
  AGENT_AVATAR_DIR,
  AGENT_AVATAR_IMAGE_FILE,
  AGENT_AVATAR_STATES,
  agentAvatarImageProblem,
  agentAvatarStatePath,
  avatarImageInfo,
  avatarPosterFile,
  normalizeAgentAvatar,
} from '../../runtime/shared/agent-avatar.mjs';
import {
  parseConnectorPolicy,
  readConnectorsFile,
  storedConnectorPolicy,
  assertConnectorPolicyNotWidened,
} from '../../runtime/agent/orchestrator/mcp/agent-connectors.mjs';

/** A policy given to save → its stored form (null removes the field). Only a
 *  deny-list policy `{ off, tools? }` is accepted; anything else throws. */
function connectorPolicyInput(value) {
  if (Array.isArray(value)) throw new Error('connectors must be { off: [connector id…], tools? } or null');
  return storedConnectorPolicy(parseConnectorPolicy(value));
}
import { STANDALONE_ROOT } from '../runtime-paths.mjs';
import { homeThreadEvidence } from '../../runtime/shared/agent-kind.mjs';
import { migrateAgentKinds } from '../../runtime/shared/agent-kind-migration.mjs';
import { BOT_SPLIT_BACKUP_DIRS, migrateBotsToOwnStore } from '../../runtime/shared/bot-split-migration.mjs';
import { backupUserData } from '../../runtime/shared/user-data-guard.mjs';
import { normalizeWorkflowRoute } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import {
  botDir,
  botStoreActive,
  migratedBotIds,
  mixyIdentityDir,
  readBotRoute,
  readMixyRoute,
  userDefinitionDir,
} from '../../runtime/shared/agent-store.mjs';

const isFixedAgent = (id) => FIXED_AGENT_SLOTS.some((agent) => agent.id === id);
const userDir = userDefinitionDir;
const hasUserAgentFile = (dataDir, id) => existsSync(join(userDir(dataDir, id), 'AGENT.md'));
// An archived (deleted) agent's AGENT.md, moved aside beside the tombstone:
// no loader reads it, and restoring moves it back.
const ARCHIVED_AGENT_FILE = 'AGENT.md.archived';

// Frontmatter the editor does not show (e.g. `permission`), taken from the
// definition in effect: the user's own copy if any, else the shipped one.
function hiddenFrontmatter(definition) {
  const { name: _name, description: _description, ...rest } = definition?.frontmatter || {};
  return rest;
}

// The definition's kind (isContactAgentId reads it), or null: the explicit
// marker bot creation (`kind: bot`) or the Workflows page (`kind: agent`)
// wrote, else the read-only decision for an unmarked one (agent-kind.mjs).
function kindOf(definition) {
  return definition?.kind || null;
}

// A save's `kind`: given only when creating, as the bot or workflow-agent
// marker. Unmarked agents are workflow agents; a kind never changes later.
function creationKind(payload, existed) {
  if (!hasOwn(payload, 'kind')) return null;
  if (existed) throw new Error("an agent's kind is set when it is created and cannot change");
  if (payload.kind !== BOT_AGENT_KIND && payload.kind !== WORKFLOW_AGENT_KIND) {
    throw new Error(`agent kind must be "${BOT_AGENT_KIND}", "${WORKFLOW_AGENT_KIND}" or absent`);
  }
  return payload.kind;
}

function readManifest(dir) {
  return readManifestStrict(join(dir, 'agent.json')) || {};
}

// Definition files are user-authored: every write is atomic (a crash never
// leaves one torn or NUL-filled) and keeps the replaced copy as `<file>.bak`.
const DEFINITION_WRITE = Object.freeze({ backup: true, mode: 0o644 });
const writeDefinitionText = (file, text) => writeFileAtomicSync(file, text, DEFINITION_WRITE);
const writeManifest = (file, manifest) => writeJsonAtomicSync(file, manifest, DEFINITION_WRITE);

// The manifest object at `file`, or null when it is missing, unreadable, holds
// no data (empty, or NUL-filled by a crash) or is not a JSON object.
function readManifestStrict(file) {
  try {
    const text = readFileSync(file, 'utf8');
    if (holdsNoData(text)) return null;
    const value = parseJsonText(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// A read-only agent.json is a standing refusal, not a transient lock: the
// atomic write's rename onto it fails with EPERM and is retried for seconds,
// synchronously on the host's event loop. Refuse it up front (one stat, no wait),
// in the same synchronous stretch as the write so no-widen checks stay atomic.
function assertManifestWritable(file) {
  try {
    accessSync(file, fsConstants.W_OK);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error(`${file} is not writable (${error?.code || error}); make it writable, then save again`);
  }
}

function requireManifestObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('not a JSON object');
  return value;
}

// The manifest to modify and write back: {} when agent.json is missing. A
// damaged one (NUL-filled or torn by a crash, not an object) first gets its
// last good copy back (agent.json.bak; the damaged bytes are kept aside as
// agent.json.corrupt-<ts>). With no good copy it stays where it is and the
// write is refused: the keys it held (connectors, avatar, route…) are unknown,
// and rewriting from {} would drop a connector deny list — a manifest without
// one means "every connector on".
function readManifestForUpdate(dir) {
  const file = join(dir, 'agent.json');
  const manifest = readJsonStateSync(file, {
    validate: requireManifestObject,
    keepWithoutBackup: true,
    mode: DEFINITION_WRITE.mode,
  });
  if (manifest) return manifest;
  if (!existsSync(file)) return {};
  throw new Error(
    `${file} is damaged and has no good copy to restore; it was left untouched. Fix or delete the file, then save again`
  );
}

// A text file's trimmed content; '' when it is missing, unreadable or holds no
// data (a crash can leave it NUL-filled, which trim() keeps).
function readTextOrEmpty(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return holdsNoData(text) ? '' : text.trim();
  } catch {
    return '';
  }
}

// Manifest keys the editor does not show (e.g. `avatar`). `entry` and `id`
// go: the editor always writes AGENT.md, and the directory names the agent.
function hiddenManifest(manifest) {
  const { id: _id, name: _name, description: _description, entry: _entry, ...rest } = manifest;
  return rest;
}

const PERSONA_FILE = 'PERSONA.md';
const LEAD_AGENT_ID = 'lead';
/** The code (and message prefix, which survives IPC) of a stale save. */
export const AGENT_DEFINITION_CONFLICT = 'AGENT_DEFINITION_CONFLICT';
const LEAD_PERSONA_MAX_BYTES = 256 * 1024;

function readPersona(dir) {
  return readTextOrEmpty(join(dir, PERSONA_FILE));
}

const IMAGE_DATA_URL = /^data:image\/(png|gif|webp);base64,/;

// One uploaded image (a data URL) as checked bytes. Only a real PNG, GIF or
// WebP whose bytes match its declared type passes: no markup (SVG) is ever
// stored, and the image is never inlined anywhere but an <img>.
function avatarImageUpload(dataUrl, label) {
  const match = typeof dataUrl === 'string' ? IMAGE_DATA_URL.exec(dataUrl) : null;
  if (!match) throw new Error(`${label} must be a PNG, GIF or WebP image`);
  const bytes = Buffer.from(dataUrl.slice(match[0].length), 'base64');
  const problem = agentAvatarImageProblem(bytes);
  if (problem) throw new Error(`${label} ${problem}`);
  const info = avatarImageInfo(bytes);
  if (info.format !== match[1]) throw new Error(`${label} must be a PNG, GIF or WebP image`);
  return { bytes, info };
}

// The `avatar` of a save → the record to store and the image files to write
// (paths under the agent's folder). A custom avatar's state is either a kept
// file name or a new upload `{ data, poster? }`: an animated upload brings its
// still first frame (a PNG) for reduced motion and paused views. The older
// `{ kind: 'image', data }` is an upload of idle alone. null clears the avatar.
function avatarUpdate(value, dir) {
  if (value == null) return { avatar: null, writes: [] };
  const custom =
    value.kind === 'image' && typeof value.data === 'string'
      ? { kind: 'custom', states: { idle: { data: value.data } } }
      : value;
  const writes = [];
  let avatar;
  if (custom.kind === 'custom' && custom.states && typeof custom.states === 'object') {
    const states = {};
    for (const state of AGENT_AVATAR_STATES) {
      const entry = custom.states[state];
      if (entry == null || typeof entry === 'string') {
        if (entry) states[state] = entry;
        continue;
      }
      const label = `agent avatar ${state} image`;
      const { bytes, info } = avatarImageUpload(entry?.data, label);
      const file = `${state}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${info.format}`;
      writes.push({ path: agentAvatarStatePath(file), bytes });
      if (info.animated) {
        const poster = avatarImageUpload(entry.poster, `${label}'s first frame`);
        if (poster.info.format !== 'png' || poster.info.animated)
          throw new Error(`${label}'s first frame must be a still PNG`);
        writes.push({ path: agentAvatarStatePath(avatarPosterFile(file)), bytes: poster.bytes });
      }
      states[state] = file;
    }
    avatar = normalizeAgentAvatar({ kind: 'custom', states });
    if (!avatar) throw new Error('agent avatar needs an idle image');
  } else {
    avatar = normalizeAgentAvatar(value);
    if (!avatar) throw new Error('agent avatar must be a known mascot or an uploaded image');
  }
  const written = new Set(writes.map((write) => write.path));
  for (const file of avatar.kind === 'custom' ? Object.values(avatar.states) : []) {
    const path = agentAvatarStatePath(file);
    if (!written.has(path) && !existsSync(join(dir, path))) throw new Error('agent avatar image was not found');
  }
  return { avatar, writes };
}

// Writes an update's images, then drops every avatar image the stored avatar
// no longer names (the older single image beside AGENT.md included).
function syncAvatarFiles(dir, avatar, writes) {
  for (const { path, bytes } of writes) {
    mkdirSync(join(dir, AGENT_AVATAR_DIR), { recursive: true });
    writeFileAtomicSync(join(dir, path), bytes, { mode: 0o644 });
  }
  const keep = new Set(
    avatar?.kind === 'custom'
      ? Object.values(avatar.states).flatMap((file) => [
          agentAvatarStatePath(file),
          agentAvatarStatePath(avatarPosterFile(file)),
        ])
      : []
  );
  for (const name of readdirSync(dir)) {
    if (AGENT_AVATAR_IMAGE_FILE.test(name) && !keep.has(name)) rmSync(join(dir, name), { force: true });
  }
  if (!existsSync(join(dir, AGENT_AVATAR_DIR))) return;
  for (const name of readdirSync(join(dir, AGENT_AVATAR_DIR))) {
    if (!keep.has(`${AGENT_AVATAR_DIR}/${name}`)) rmSync(join(dir, AGENT_AVATAR_DIR, name), { force: true });
  }
}

// One state image as a data URL, with its still first frame ('' when it has
// none): checked again on read, so a hand-placed file never reaches an <img>
// unless it is an image the editor would have accepted.
function readAvatarImage(dir, file) {
  const read = (path) => {
    try {
      const bytes = readFileSync(join(dir, path));
      if (agentAvatarImageProblem(bytes)) return null;
      const info = avatarImageInfo(bytes);
      return { info, url: `data:image/${info.format};base64,${bytes.toString('base64')}` };
    } catch {
      return null;
    }
  };
  const image = read(agentAvatarStatePath(file));
  if (!image) return null;
  const poster =
    image.info.animated && !AGENT_AVATAR_IMAGE_FILE.test(file)
      ? read(agentAvatarStatePath(avatarPosterFile(file)))
      : null;
  return {
    file,
    url: image.url,
    poster: poster && poster.info.format === 'png' && !poster.info.animated ? poster.url : '',
  };
}

const stableJson = (value) =>
  JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]])
  );

function writeAgentFiles(dir, { name, description, body, extra = {}, manifest = {} }) {
  const meta = { name, ...(description ? { description } : {}) };
  mkdirSync(dir, { recursive: true });
  writeDefinitionText(join(dir, 'AGENT.md'), serializeFrontmatterDoc({ ...meta, ...extra }, body));
  // loadAgentDefinition prefers the manifest for name/description.
  writeManifest(join(dir, 'agent.json'), { ...meta, ...manifest });
  rmSync(join(dir, AGENT_DELETED_MARKER), { force: true });
  rmSync(join(dir, ARCHIVED_AGENT_FILE), { force: true });
}

const isArchivedAgent = (dataDir, id) => existsSync(join(userDir(dataDir, id), AGENT_DELETED_MARKER));

// A save's avatar and connectors applied to `manifest` (in place); returns the
// avatar update (its image writes), null when the save gives no avatar.
function applyManifestEdits(manifest, payload, dir, options) {
  // New custom images arrive as checked bytes, stored under content hashes.
  const update = hasOwn(payload, 'avatar') ? avatarUpdate(payload.avatar, dir) : null;
  if (update?.avatar) manifest.avatar = update.avatar;
  else if (update) delete manifest.avatar;
  // Connectors: a policy replaces the saved one, null removes the field
  // (every connector on), absent leaves it as saved.
  if (hasOwn(payload, 'connectors')) {
    const connectors = connectorPolicyInput(payload.connectors);
    // For a remote client: against the manifest just read, in the same synchronous stretch as its write.
    if (options?.noWiden) assertConnectorPolicyNotWidened(manifest.connectors ?? null, connectors);
    if (connectors) manifest.connectors = connectors;
    else delete manifest.connectors;
  }
  return update;
}

// A saved definition's files in `dir`: AGENT.md and agent.json, PERSONA.md
// (`persona` '' removes it, null leaves it) and the avatar images.
function writeSavedDefinition(dir, files, persona, update) {
  writeAgentFiles(dir, files);
  if (persona) writeDefinitionText(join(dir, PERSONA_FILE), `${persona}\n`);
  else if (persona === '') rmSync(join(dir, PERSONA_FILE), { force: true });
  // Only the images the manifest names stay.
  syncAvatarFiles(dir, normalizeAgentAvatar(files.manifest.avatar), update?.writes ?? []);
}

// A save's id, name and description: a new agent's id comes from its name.
function resolveSaveTarget(loadAgentDefinition, payload, dataDir) {
  const id = agentEditorId(clean(payload.id));
  if (hasOwn(payload, 'id') && !id) {
    throw new Error('agent id must contain letters/numbers (dashes and dots allowed)');
  }
  if (id && isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be edited`);
  const name = oneLine(payload.name);
  if (!name && !id) throw new Error('agent name must not be empty');
  return {
    // An archived agent keeps its id: its chat is never handed to a new one.
    id:
      id ||
      availableAgentId(
        name,
        (candidate) =>
          Boolean(loadAgentDefinition(dataDir, candidate)) ||
          isArchivedAgent(dataDir, candidate) ||
          // An id the split copied stays the bot's, even once purged; a
          // folder in either store keeps its id too.
          migratedBotIds(dataDir).has(candidate) ||
          (botStoreActive(dataDir) &&
            (existsSync(join(dataDir, 'agents', candidate)) || existsSync(botDir(dataDir, candidate))))
      ),
    name,
    description: oneLine(payload.description),
  };
}

/** The name and face an archived (deleted) agent left, per id; null for
 *  any id that is not archived. Its chat lists under them. */
function archivedIdentities(dataDir, agentIds) {
  const ids = Array.isArray(agentIds) ? agentIds.filter((id) => typeof id === 'string') : [];
  return Object.fromEntries(
    ids.map((agentId) => {
      const id = agentEditorId(agentId);
      if (!id || id !== agentId || !isArchivedAgent(dataDir, id)) return [agentId, null];
      const manifest = readManifest(userDir(dataDir, id));
      return [agentId, { name: oneLine(manifest.name) || id, avatar: normalizeAgentAvatar(manifest.avatar) ?? null }];
    })
  );
}

// A custom avatar's images as data URLs by state, read from `dir`; null
// without an idle image.
function customAvatarImages(dir, avatar) {
  const states = {};
  for (const [state, file] of Object.entries(avatar.states)) {
    const image = readAvatarImage(dir, file);
    if (image) states[state] = image;
  }
  return states.idle ? { states } : null;
}

// Mixy (the Lead) has no agent definition to edit: only its PERSONA.md
// (성격) and AGENT.md (일하는 방식, agent mode only), read by the runtime
// from Mixy's identity folder: bots/mixy once the bot store is active,
// agents/lead before (mixyIdentityDir, agent-store.mjs). Saved empty, the
// file goes. `dataDirOf()` resolves the data folder on each call.
function createLeadIdentityApi(dataDirOf, mainRoute) {
  const leadDir = () => mixyIdentityDir(dataDirOf());
  function readLeadFile(file) {
    return readTextOrEmpty(join(leadDir(), file));
  }
  function saveLeadFile(file, text) {
    const value = String(text ?? '').trim();
    if (Buffer.byteLength(value) > LEAD_PERSONA_MAX_BYTES) throw new Error(`${file} is larger than 256 KB`);
    const dir = leadDir();
    if (value) {
      mkdirSync(dir, { recursive: true });
      writeDefinitionText(join(dir, file), `${value}\n`);
    } else rmSync(join(dir, file), { force: true });
    // Mixy's threads take it from their next turn (the save answers at once).
    void publishAgentProfileChange();
    return readLeadFile(file);
  }

  // Whether Mixy was created (the "대표 에이전트 만들기" first run): the
  // explicit `created` flag in Mixy's agent.json (leadDir). null until decided —
  // the desktop host decides once (an existing profile counts as created).
  // Also Mixy's display name (`name`, read by the runtime's identity line) and
  // face (`avatar`, as every agent manifest): '' / null mean the defaults.
  // `homeChatted`: whether Mixy's home thread holds any conversation (the
  // host reads it to tell v1.3.0's never-used automatic Mixy apart).
  function getLeadStatus() {
    const manifest = readManifest(leadDir());
    // A v1.3.0 automatic Mixy the split left in agents/lead still counts as
    // decided (its routines keep running) until bots/mixy says otherwise.
    const legacy = readManifest(join(dataDirOf(), 'agents', LEAD_AGENT_ID)).created;
    let created = null;
    if (typeof manifest.created === 'boolean') created = manifest.created;
    else if (typeof legacy === 'boolean') created = legacy;
    return {
      created,
      name: oneLine(manifest.name),
      avatar: normalizeAgentAvatar(manifest.avatar) ?? null,
      homeChatted: homeThreadEvidence(dataDirOf(), LEAD_AGENT_ID).chatted,
      // Mixy's own model (never the Lead's); null: its thread keeps its own.
      route: readMixyRoute(dataDirOf()),
    };
  }
  // The route Mixy's thread follows: its own, else Main's (an override cleared).
  const getLeadHomeRoute = () => readMixyRoute(dataDirOf()) ?? mainRoute();
  // Mixy's name and face, chosen in the 대표 에이전트 dialog or its profile:
  // a name '' and an avatar null go back to the defaults; absent keys are kept.
  function saveLeadIdentity(payload = {}) {
    const dir = leadDir();
    const manifest = readManifestForUpdate(dir);
    if (hasOwn(payload, 'name')) {
      const name = oneLine(payload.name);
      if (name.length > 64) throw new Error('name must be 64 characters or fewer');
      if (name) manifest.name = name;
      else delete manifest.name;
    }
    const update = hasOwn(payload, 'avatar') ? avatarUpdate(payload.avatar, dir) : null;
    if (update?.avatar) manifest.avatar = update.avatar;
    else if (update) delete manifest.avatar;
    mkdirSync(dir, { recursive: true });
    writeManifest(join(dir, 'agent.json'), manifest);
    syncAvatarFiles(dir, normalizeAgentAvatar(manifest.avatar), update?.writes ?? []);
    // The name is in Mixy's prompt (its identity line); the face is not.
    if (hasOwn(payload, 'name')) void publishAgentProfileChange();
    return getLeadStatus();
  }
  // Sets the flag (and Mixy's 하는 일 when given); every other key is kept.
  // A damaged Lead manifest (NUL-filled, torn, not an object) gets its last
  // good copy back first. Without one it is left alone — nothing is written,
  // the status stays as read — since a rewrite would drop its connector policy.
  function setLeadCreated(created, description) {
    if (typeof created !== 'boolean') throw new TypeError('created must be a boolean');
    let manifest;
    try {
      manifest = readManifestForUpdate(leadDir());
    } catch (error) {
      process.stderr.write(`[agents] ${error.message}; Mixy's created flag was not saved\n`);
      return getLeadStatus();
    }
    manifest.created = created;
    const job = oneLine(description);
    if (job) manifest.description = job;
    mkdirSync(leadDir(), { recursive: true });
    writeManifest(join(leadDir(), 'agent.json'), manifest);
    return getLeadStatus();
  }

  return {
    leadDir,
    getLeadPersona: () => readLeadFile(PERSONA_FILE),
    saveLeadPersona: (text) => saveLeadFile(PERSONA_FILE, text),
    getLeadAgentBody: () => readLeadFile('AGENT.md'),
    saveLeadAgentBody: (text) => saveLeadFile('AGENT.md', text),
    getLeadStatus,
    getLeadHomeRoute,
    saveLeadIdentity,
    setLeadCreated,
    // Mixy's connector policy, in its agent.json (`next` null removes it).
    getLeadConnectorPolicy: () => readConnectorsFile(join(leadDir(), 'agent.json')),
    setLeadConnectorPolicy: (next) => {
      const manifest = readManifestForUpdate(leadDir());
      if (next) manifest.connectors = next;
      else delete manifest.connectors;
      mkdirSync(leadDir(), { recursive: true });
      writeManifest(join(leadDir(), 'agent.json'), manifest);
    },
  };
}

// Whether each agent's definition is on disk, decided per id from the files
// themselves: 'deleted' only when every source is PROVEN absent (ENOENT) or
// tombstoned, 'unknown' on any other read fault. A list read swallows
// directory errors, so its absence never proves a deletion; this does.
function definitionPresence({ dataDir, rootDir, stat }, agentIds) {
  const probe = (path) => {
    try {
      stat(path);
      return 'present';
    } catch (error) {
      return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : 'unknown';
    }
  };
  const presence = (agentId) => {
    const id = agentEditorId(agentId);
    if (!id || id !== agentId) return 'unknown';
    const user = probe(join(userDir(dataDir, id), 'AGENT.md'));
    if (user !== 'absent') return user;
    const tombstone = probe(join(userDir(dataDir, id), AGENT_DELETED_MARKER));
    if (tombstone === 'present') return 'deleted';
    if (tombstone === 'unknown') return 'unknown';
    const shipped = probe(join(rootDir, 'agents', id, 'AGENT.md'));
    return shipped === 'absent' ? 'deleted' : shipped;
  };
  const ids = Array.isArray(agentIds) ? agentIds.filter((id) => typeof id === 'string') : [];
  return Object.fromEntries(ids.map((id) => [id, presence(id)]));
}

// A definition folder's revision: a hash of the three files an editor writes.
function definitionDirRevision(dir) {
  const hash = createHash('sha256');
  for (const name of ['agent.json', 'AGENT.md', PERSONA_FILE]) {
    hash.update(`${name}\0`);
    try {
      hash.update(readFileSync(join(dir, name)));
    } catch {
      hash.update('\u0001absent');
    }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 24);
}

/** The one-time split of bots into bots/ (bot-split-migration.mjs), from
 *  the config as it is now; the catalogs read the store from here on. */
function migrateBotStore(deps) {
  const dataDir = resolveDataDir(deps);
  const config = deps.getConfig();
  const result = migrateBotsToOwnStore({
    dataDir,
    shippedRoot: deps.rootDir ?? STANDALONE_ROOT,
    routeOf: (id) => deps.agentRouteFromConfig(config, id),
    leadRoute: normalizeWorkflowRoute(deps.resolveRoute(config, {})),
    // The definitions the split copies or a re-sync replaces go with it.
    backup: () => backupUserData(dataDir, 'bot-split', { dirs: BOT_SPLIT_BACKUP_DIRS }),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  clearAgentDefinitionCache();
  deps.listCustomAgentIds?.(dataDir);
  return result;
}

/** The one-time `kind: agent` stamp for agents made before the marker
 *  (agent-kind-migration.mjs); runs before the bot split so a workflow
 *  agent is never copied to bots/. */
function migrateAgentKindMarkers(deps) {
  const dataDir = resolveDataDir(deps);
  const result = migrateAgentKinds({
    dataDir,
    shippedRoot: deps.rootDir ?? STANDALONE_ROOT,
    backup: () => backupUserData(dataDir, 'agent-kind', { dirs: BOT_SPLIT_BACKUP_DIRS }),
    // A restored bot's own route goes back to the config, where a workflow
    // agent's lives (unless the config already holds that model).
    restoreRoute: (id, route) => {
      const config = deps.getConfig();
      const current = deps.agentRouteFromConfig(config, id);
      if (current?.provider === route.provider && current?.model === route.model) return;
      deps.saveConfigAndAdopt(canonicalizeAgentRouteStorage({ ...config, agents: { ...config.agents, [id]: route } }));
    },
    log: (line) => process.stderr.write(`${line}\n`),
  });
  clearAgentDefinitionCache();
  deps.listCustomAgentIds?.(dataDir);
  return result;
}

// Deleting (archiving), restoring and purging agents, and the config cleanup
// a removed agent needs.
function createAgentArchiveApi({
  dataDirOf,
  getConfig,
  saveConfigAndAdopt,
  loadAgentDefinition,
  shippedDir,
  announceBotChange,
  getAgentDefinition,
}) {
  // A removed custom agent must not leave a dangling route/preset or a
  // disabled-roster entry that would silently disable a later agent of the
  // same id.
  function dropAgentRoute(id) {
    const nextConfig = withAgentDisabled(getConfig(), id, false);
    if (nextConfig.agents && id in nextConfig.agents) {
      const agents = { ...nextConfig.agents };
      delete agents[id];
      nextConfig.agents = agents;
    }
    saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
  }

  async function deleteAgentDefinition(agentId) {
    const id = agentEditorId(agentId);
    if (!id) throw new Error(`unknown agent "${agentId}"`);
    if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be deleted`);
    const builtIn = isFixedAgent(id);
    const dataDir = dataDirOf();
    const dir = userDir(dataDir, id);
    if (!hasUserAgentFile(dataDir, id)) {
      if (builtIn) throw new Error(`agent "${id}" has no user override to reset`);
      if (!loadAgentDefinition(dataDir, id)) throw new Error(`agent "${id}" not found`);
    }
    // Agents are global (no workflow rosters): deleting a custom agent removes
    // it from every surface at once — catalog, editor, routes, and spawn (the
    // spawn path rejects unknown agent ids).
    if (builtIn) {
      rmSync(dir, { recursive: true, force: true });
      clearAgentDefinitionCache(id);
      const sourceFallback = loadAgentDefinition(dataDir, id);
      // Its threads, and the Leads listing it, take the shipped definition.
      await announceBotChange(dataDir);
      return { id, deleted: true, revertedToBuiltIn: Boolean(sourceFallback) };
    }
    // A custom agent is archived: its AGENT.md (what makes it an agent
    // anywhere) moves aside, the tombstone keeps the packaged copy of a
    // starter from coming back, and the rest (agent.json: name and face,
    // persona, memory, its model and on/off) stays for its archived chat —
    // until restoreAgentDefinition brings it back or purgeAgentDefinition.
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, 'AGENT.md'))) renameSync(join(dir, 'AGENT.md'), join(dir, ARCHIVED_AGENT_FILE));
    writeFileAtomicSync(join(dir, AGENT_DELETED_MARKER), 'deleted\n');
    clearAgentDefinitionCache(id);
    // The Leads listing it drop it from their roster from their next turn.
    await announceBotChange(dataDir);
    return { id, deleted: true, revertedToBuiltIn: false };
  }

  /** An archived agent back as it was, under its own id: its AGENT.md moved
   *  back (a starter without a copy of its own returns to the packaged one)
   *  and the tombstone gone. Its routines stay off (the host). */
  async function restoreAgentDefinition(agentId) {
    const id = agentEditorId(agentId);
    if (!id || isHiddenAgent(id) || isFixedAgent(id)) throw new Error(`unknown agent "${agentId}"`);
    const dataDir = dataDirOf();
    if (!isArchivedAgent(dataDir, id)) throw new Error(`agent "${id}" is not deleted`);
    const dir = userDir(dataDir, id);
    const kept = join(dir, ARCHIVED_AGENT_FILE);
    if (!existsSync(kept) && !existsSync(join(shippedDir(id), 'AGENT.md'))) {
      throw new Error(`agent "${id}" was deleted before deleted agents were kept, so it cannot be restored`);
    }
    if (existsSync(kept)) renameSync(kept, join(dir, 'AGENT.md'));
    rmSync(join(dir, AGENT_DELETED_MARKER), { force: true });
    clearAgentDefinitionCache(id);
    // Back in the roster of the Leads that list it, from their next turn.
    await announceBotChange(dataDir);
    return getAgentDefinition(id);
  }

  /** Deleting an archived agent again: everything it left goes for good. A
   *  starter keeps only its tombstone, so its packaged copy stays gone. */
  async function purgeAgentDefinition(agentId) {
    const id = agentEditorId(agentId);
    if (!id || isHiddenAgent(id) || isFixedAgent(id)) throw new Error(`unknown agent "${agentId}"`);
    const dataDir = dataDirOf();
    // Never a live agent; one deleted before archiving existed left nothing.
    if (!isArchivedAgent(dataDir, id)) return { id, purged: false };
    const dir = userDir(dataDir, id);
    rmSync(dir, { recursive: true, force: true });
    clearAgentDefinitionCache(id);
    dropAgentRoute(id);
    if (loadAgentDefinition(dataDir, id)) {
      mkdirSync(dir, { recursive: true });
      writeFileAtomicSync(join(dir, AGENT_DELETED_MARKER), 'deleted\n');
      clearAgentDefinitionCache(id);
    }
    return { id, purged: true };
  }

  return { dropAgentRoute, deleteAgentDefinition, restoreAgentDefinition, purgeAgentDefinition };
}

// Agent catalog + editor surface: fixed services stay built-in; starter and
// user-authored agents are custom definitions under agents/<id>/AGENT.md.
export function createAgentEditorApi(deps) {
  const { getConfig, loadAgentDefinition, listCustomAgentIds, saveConfigAndAdopt, setAgentRoute } = deps;
  // A store bot's route lives in its folder; every other agent's in the config.
  const ownRoute = (config, id) => {
    const bot = readBotRoute(resolveDataDir(deps), id);
    return bot !== undefined ? bot : deps.agentRouteFromConfig(config, id);
  };
  const routeFor = (config, id) => effectiveAgentRoute({ ...deps, agentRouteFromConfig: ownRoute }, config, id);
  // `route` falls back to Main; this says whether the agent has a route of
  // its own, so a surface never shows (or saves) the Main fallback as one.
  const routeConfigured = (config, id) => Boolean(ownRoute(config, id));
  const shippedDir = (id) => join(deps.rootDir ?? STANDALONE_ROOT, 'agents', id);
  // The manifest in effect: the user's own copy if any, else the shipped one.
  const manifestDirOf = (dataDir, id) => (hasUserAgentFile(dataDir, id) ? userDir(dataDir, id) : shippedDir(id));
  const manifestOf = (dataDir, id) => readManifest(manifestDirOf(dataDir, id));
  // The same, to be written back: the user's copy is recovered or refused when
  // damaged (readManifestForUpdate); a shipped one is only read.
  const manifestForUpdate = (dataDir, id) =>
    hasUserAgentFile(dataDir, id) ? readManifestForUpdate(userDir(dataDir, id)) : readManifest(shippedDir(id));
  const avatarOf = (dataDir, id) => normalizeAgentAvatar(manifestOf(dataDir, id).avatar);
  // A saved, archived or restored bot reaches the prompts that embed it: the
  // fresh scan republishes the shared bot list the Lead rosters read (a new id
  // is in it at once), then every runtime is told.
  async function announceBotChange(dataDir) {
    listCustomAgentIds?.(dataDir);
    await publishAgentProfileChange();
  }

  function listAgents() {
    const dataDir = resolveDataDir(deps);
    const config = getConfig();
    const fixed = FIXED_AGENT_SLOTS.map((agent) => ({
      ...agent,
      locked: true,
      userOverride: hasUserAgentFile(dataDir, agent.id),
      route: routeFor(config, agent.id),
      routeConfigured: routeConfigured(config, agent.id),
      disabled: isAgentDisabled(config, agent.id),
      definition: loadAgentDefinition(dataDir, agent.id),
    }));
    // Starter and user-authored custom agents are discovered from
    // agents/<id>/AGENT.md directories beyond the fixed services.
    const custom = (listCustomAgentIds?.(dataDir) || []).map((id) => {
      const definition = loadAgentDefinition(dataDir, id);
      return {
        id,
        label: definition?.name || id,
        description: definition?.description || '',
        custom: true,
        userOverride: hasUserAgentFile(dataDir, id),
        route: routeFor(config, id),
        routeConfigured: routeConfigured(config, id),
        kind: kindOf(definition),
        disabled: isAgentDisabled(config, id),
        avatar: avatarOf(dataDir, id),
        definition,
      };
    });
    return [...fixed, ...custom];
  }

  // The stored definition's revision: a hash of the three files an editor
  // writes, from the copy in effect. An editor that loaded it can send it back
  // as `expectedRevision`, and a save over a newer copy is refused.
  const definitionRevision = (dataDir, id) =>
    definitionDirRevision(hasUserAgentFile(dataDir, id) ? userDir(dataDir, id) : shippedDir(id));

  function getAgentDefinition(agentId) {
    const id = agentEditorId(agentId);
    if (!id) throw new Error(`unknown agent "${agentId}"`);
    // Internal hidden roles are Mixdog-managed and never editable here.
    if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be edited`);
    const dataDir = resolveDataDir(deps);
    const definition = loadAgentDefinition(dataDir, id);
    if (!definition) throw new Error(`agent "${agentId}" not found`);
    return {
      id,
      name: definition.name,
      description: definition.description,
      body: definition.body,
      custom: !isFixedAgent(id),
      userOverride: hasUserAgentFile(dataDir, id),
      route: routeFor(getConfig(), id),
      routeConfigured: routeConfigured(getConfig(), id),
      kind: kindOf(definition),
      disabled: isAgentDisabled(getConfig(), id),
      avatar: avatarOf(dataDir, id),
      persona: readPersona(hasUserAgentFile(dataDir, id) ? userDir(dataDir, id) : shippedDir(id)),
      revision: definitionRevision(dataDir, id),
    };
  }

  async function saveAgentDefinition(payload = {}, options) {
    const body = String(payload.body || '').trim();
    if (!body) throw new Error('AGENT.md body must not be empty');
    const dataDir = resolveDataDir(deps);
    const { id, name, description } = resolveSaveTarget(loadAgentDefinition, payload, dataDir);
    // Opt-in (the agent profile): without `expectedRevision` the last write
    // wins, as for the Workflows editor and the setup tool.
    if (hasOwn(payload, 'expectedRevision') && String(payload.expectedRevision) !== definitionRevision(dataDir, id)) {
      const conflict = new Error(`${AGENT_DEFINITION_CONFLICT}: agent "${id}" changed since it was loaded`);
      conflict.code = AGENT_DEFINITION_CONFLICT;
      throw conflict;
    }
    const current = loadAgentDefinition(dataDir, id);
    const existed = Boolean(current);
    // Made anew under an archived agent's id (never restored): its kept route goes.
    const reclaimed = !existed && isArchivedAgent(dataDir, id);
    const kind = creationKind(payload, existed);
    const definition = { name: name || id, description, body };
    const manifest = hiddenManifest(manifestForUpdate(dataDir, id));
    // With the bot store, a new bot is made in bots/ and a new agent in
    // agents/; either keeps its `kind` marker, so its kind never rests on
    // the folder alone (a copy read without the store is still a bot).
    const storeBot = !existed && kind === BOT_AGENT_KIND && botStoreActive(dataDir);
    // An id is one definition's in one store: a new bot never takes an id
    // agents/ holds (an archived agent's included), a new agent never one of
    // bots/ (or one the split moved there, even if since deleted).
    if (!existed && botStoreActive(dataDir)) {
      const taken = storeBot
        ? existsSync(join(dataDir, 'agents', id))
        : existsSync(botDir(dataDir, id)) || migratedBotIds(dataDir).has(id);
      if (taken) throw new Error(`agent id "${id}" is already in use; pick another name`);
    }
    const dir = storeBot ? botDir(dataDir, id) : userDir(dataDir, id);
    const inStore = dir === botDir(dataDir, id);
    const update = applyManifestEdits(manifest, payload, dir, options);
    // PERSONA.md (tone, how it addresses the user): written when given and
    // non-empty, removed when given empty, untouched when absent.
    const persona = hasOwn(payload, 'persona') ? String(payload.persona ?? '').trim() : null;
    // Equal to the shipped agent: keep no copy so it follows the shipped
    // version — unless the manifest (an avatar) or a persona differs.
    const absorbed =
      !inStore &&
      !persona &&
      stableJson(manifest) === stableJson(hiddenManifest(readManifest(shippedDir(id)))) &&
      absorbSaveEqualToShipped({
        rootDir: deps.rootDir ?? STANDALONE_ROOT,
        dataDir,
        dir: 'agents',
        id,
        entry: 'AGENT.md',
        files: ['AGENT.md', 'agent.json'],
        definition,
      });
    if (!absorbed) {
      // Hidden frontmatter (the `kind` marker included) survives every edit.
      const extra = kind ? { ...hiddenFrontmatter(current), kind } : hiddenFrontmatter(current);
      writeSavedDefinition(dir, { ...definition, extra, manifest }, persona, update);
    }
    clearAgentDefinitionCache(id);
    if (reclaimed) dropAgentRoute(id);
    // A newly created agent starts enabled; a stale roster entry left by an
    // earlier agent of the same id must not disable it.
    if (!existed && isAgentDisabled(getConfig(), id)) saveConfigAndAdopt(withAgentDisabled(getConfig(), id, false));
    if (payload.route) await setAgentRoute(id, payload.route);
    // Its threads take the saved persona, AGENT.md and name, and the Leads
    // listing it (a new bot, a new name) their roster, from their next turn.
    await announceBotChange(dataDir);
    return getAgentDefinition(id);
  }

  const { dropAgentRoute, deleteAgentDefinition, restoreAgentDefinition, purgeAgentDefinition } = createAgentArchiveApi(
    {
      dataDirOf: () => resolveDataDir(deps),
      getConfig,
      saveConfigAndAdopt,
      loadAgentDefinition,
      shippedDir,
      announceBotChange,
      getAgentDefinition,
    }
  );

  const archivedAgentIdentities = (agentIds = []) => archivedIdentities(resolveDataDir(deps), agentIds);

  const agentDefinitionPresence = (agentIds = []) =>
    definitionPresence(
      {
        dataDir: resolveDataDir(deps),
        rootDir: deps.rootDir ?? STANDALONE_ROOT,
        stat: deps.statSync ?? statSync,
      },
      agentIds
    );

  // A custom avatar's images as data URLs by state, read on demand: the
  // catalog rows (which also reach the setup tool's model output) carry only
  // file names, and the images themselves never go to a model.
  function getAgentAvatarImage(agentId) {
    const id = agentEditorId(agentId);
    if (!id || isHiddenAgent(id)) return null;
    const dataDir = resolveDataDir(deps);
    // Mixy's face lives in its identity folder's agent.json (mixyIdentityDir:
    // bots/mixy with the bot store, agents/lead before), beside no AGENT.md.
    const lead = id === LEAD_AGENT_ID;
    const dir = lead ? leadDir() : userDir(dataDir, id);
    // An archived agent's face stays readable for its archived chat.
    const archived = !lead && isArchivedAgent(dataDir, id);
    const avatar = lead
      ? normalizeAgentAvatar(readManifest(leadDir()).avatar)
      : archived
        ? normalizeAgentAvatar(readManifest(dir).avatar)
        : avatarOf(dataDir, id);
    if (avatar?.kind !== 'custom' || (!lead && !archived && !hasUserAgentFile(dataDir, id))) return null;
    return customAvatarImages(dir, avatar);
  }

  const {
    leadDir,
    getLeadPersona,
    saveLeadPersona,
    getLeadAgentBody,
    saveLeadAgentBody,
    getLeadStatus,
    getLeadHomeRoute,
    saveLeadIdentity,
    setLeadCreated,
    getLeadConnectorPolicy,
    setLeadConnectorPolicy,
  } = createLeadIdentityApi(
    () => resolveDataDir(deps),
    () => normalizeWorkflowRoute(deps.resolveRoute(getConfig(), {}))
  );

  // The agent's connector policy (see runtime/.../mcp/agent-connectors.mjs),
  // or null when its definition has none: every connector is on. Read as the
  // runtime reads it: a broken file or field is DENY_ALL_CONNECTORS, never
  // "every connector".
  function getAgentConnectorPolicy(agentId) {
    const id = agentEditorId(agentId);
    if (!id) throw new Error(`unknown agent "${agentId}"`);
    if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be edited`);
    const dataDir = resolveDataDir(deps);
    if (id === LEAD_AGENT_ID) return getLeadConnectorPolicy();
    if (!loadAgentDefinition(dataDir, id)) throw new Error(`agent "${agentId}" not found`);
    return readConnectorsFile(join(manifestDirOf(dataDir, id), 'agent.json'));
  }
  // Replaces the policy (null removes the field). Every other key — avatar,
  // persona, frontmatter — is kept; for Mixy only its agent.json is touched.
  async function setAgentConnectorPolicy(agentId, connectors) {
    const id = agentEditorId(agentId);
    const next = connectorPolicyInput(connectors);
    getAgentConnectorPolicy(id);
    assertManifestWritable(join(id === LEAD_AGENT_ID ? leadDir() : userDir(resolveDataDir(deps), id), 'agent.json'));
    if (id === LEAD_AGENT_ID) setLeadConnectorPolicy(next);
    else {
      const { name, description, body } = loadAgentDefinition(resolveDataDir(deps), id);
      await saveAgentDefinition({ id, name, description, body, connectors: next });
    }
    return getAgentConnectorPolicy(id);
  }

  return {
    migrateAgentKindMarkers: () => migrateAgentKindMarkers(deps),
    migrateBotStore: () => migrateBotStore(deps),
    getAgentConnectorPolicy,
    setAgentConnectorPolicy,
    listAgents,
    getAgentDefinition,
    getAgentAvatarImage,
    getLeadPersona,
    saveLeadPersona,
    getLeadAgentBody,
    saveLeadAgentBody,
    getLeadStatus,
    getLeadHomeRoute,
    setLeadCreated,
    saveLeadIdentity,
    saveAgentDefinition,
    deleteAgentDefinition,
    restoreAgentDefinition,
    purgeAgentDefinition,
    archivedAgentIdentities,
    agentDefinitionPresence,
  };
}
