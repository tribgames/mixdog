//! The agent definition folders, read as Node's `runtime-core/workflow/agents.mjs` reads them
//! (discovery, the user copy over the shipped one, the bot store) plus the presence and archive
//! probes of `workflow-agents-api/agent-editor.mjs`. Synchronous file work: the service runs
//! every function here as one lane job.
#![allow(clippy::disallowed_methods, reason = "lane job bodies: the service runs these functions on io lanes")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use serde_json::Map;
use serde_json::Value;

use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_config::config::bot_migration;
use mixdog_core_config::config::is_store_bot;
use mixdog_core_config::config::agent_routes::agent_editor_id;
use mixdog_core_rooms::rooms::home::Presence;
use mixdog_core_config::workflow::ids::clean;
use mixdog_core_config::workflow::ids::one_line;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_config::workflow::ids::workflow_id;
use mixdog_core_config::workflow::pack::read_document;
use mixdog_core_config::workflow::pack::read_text_safe;

pub(super) type Lane = InLane<InteractiveIo>;

/// `AGENT_DELETED_MARKER`: the tombstone a deleted agent leaves in its user folder.
pub const DELETED_MARKER: &str = ".deleted";
const BOTS_DIR: &str = "bots";
const MIXY_BOT_ID: &str = "mixy";

/// `FIXED_AGENT_SLOTS`: id, label and description of the built-in services.
pub const FIXED_SLOTS: [(&str, &str, &str, &str); 2] = [
    ("maintainer", "Maintainer", "Memory and upkeep", "memory"),
    ("explore", "Explore", "Codebase exploration", "explore"),
];
/// `DEFAULT_DISABLED_AGENT_IDS`: the shipped starter roles, in their listing order.
pub const STARTERS: [&str; 7] = ["worker", "heavy-worker", "reviewer", "advisor", "security", "front-worker", "writer"];

fn is_role(id: &str) -> bool {
    FIXED_SLOTS.iter().any(|slot| slot.0 == id)
}

/// A loaded `AGENT.md` definition.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub permission: Option<String>,
    pub frontmatter: Map<String, Value>,
    /// `bot`, `agent`, … or `None`: the read-only decision of `agentDefinitionKind`.
    pub kind: Option<String>,
    pub body: String,
    pub persona: String,
}

/// A definition whose kind may still wait for the home-thread evidence.
pub(super) struct Loaded {
    pub definition: AgentDefinition,
    /// The kind rests on whether the agent's home thread holds the creation greeting.
    pub unmarked: bool,
}

#[derive(Clone)]
pub(super) struct Folders {
    /// The install root: shipped agents are under `<shipped>/agents`.
    pub shipped: PathBuf,
    pub data: PathBuf,
    /// The internal agents, which never list.
    pub hidden: Arc<HashSet<String>>,
}

enum Root {
    Bots,
    User,
    Shipped,
}

/// `join(base, rel)`: the segments appended, `.` dropped and `..` taken back.
fn node_join(base: &Path, rel: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for part in rel.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    out
}

/// `agentEntryFile`: the entry file name the manifest names (default `AGENT.md`).
pub(super) fn entry_file(manifest: &Map<String, Value>) -> String {
    let name = clean(manifest.get("entry"));
    if name.is_empty() { "AGENT.md".to_owned() } else { name }
}

/// `agentEntryPath`: the entry file of the agent folder `dir`, exactly as the loader reads it.
pub(super) fn entry_path(dir: &Path, manifest: &Map<String, Value>) -> PathBuf {
    node_join(dir, &entry_file(manifest))
}

/// `readBotRoute(dataDir, id)`: `None` when `id` is no store bot, else its own complete route
/// (`Some(None)` when it has none).
pub(super) fn store_bot_route(folders: &Folders, lane: &Lane, id: &str) -> Option<Option<Value>> {
    if !is_store_bot(lane, &folders.data, id) {
        return None;
    }
    let route = manifest_of(&folders.data.join(BOTS_DIR).join(id)).get("route").cloned();
    let complete = |route: &Value| ["provider", "model"].iter().all(|key| route.get(key).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty()));
    Some(route.filter(|route| route.is_object() && complete(route)))
}

/// `parseManifestText`: the `agent.json` object in `text`, `None` when it is not one.
fn parse_manifest_text(text: &[u8]) -> Option<Map<String, Value>> {
    match mixdog_statefile::parse_json_text(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// `readManifestStrict`: the manifest at `file`, `None` when it is missing, unreadable, holds no
/// data or is not a JSON object.
fn manifest_strict(file: &Path) -> Option<Map<String, Value>> {
    let bytes = std::fs::read(file).ok()?;
    if mixdog_statefile::holds_no_data(&bytes) {
        return None;
    }
    parse_manifest_text(&bytes)
}

/// `readManifest(dir)`: `{}` when there is none.
pub(super) fn manifest_of(dir: &Path) -> Map<String, Value> {
    manifest_strict(&dir.join("agent.json")).unwrap_or_default()
}

/// `explicitKind`: the frontmatter `kind`, lower-cased, `None` when blank or not a string.
pub(super) fn explicit_kind(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let kind = mixdog_js::js_trim(text).to_lowercase();
    (!kind.is_empty()).then_some(kind)
}

/// `isDialogDefaultBody`: the body ends with the bot dialog's three closing lines.
pub(super) fn is_dialog_default_body(body: &str) -> bool {
    let lines: Vec<&str> = mixdog_js::js_trim(body).split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let [.., first, second, third] = lines.as_slice() else {
        return false;
    };
    (*first == "- Help the user in a natural, friendly conversation, in the language they write in."
        || *first == "- Help the user with this role in a natural, friendly conversation, in the language they write in.")
        && *second == "- Ask a short question when a request is unclear, and say plainly when something is outside what you do."
        && *third == "- Keep replies as short or as detailed as the moment needs."
}

/// `normalizeAgentPermissionOrNone`.
fn permission_or_none(value: Option<&Value>) -> Option<String> {
    let raw = clean(value);
    if raw.is_empty() {
        return None;
    }
    let normalized = match raw.to_lowercase().as_str() {
        "none" => "none",
        "readonly" | "read-only" | "read" => "read",
        "write" | "readwrite" | "read_write" | "read-write" => "read-write",
        "mcp" => "mcp",
        "full" => "full",
        _ => "none",
    };
    Some(normalized.to_owned())
}

fn probe(path: &Path) -> Probe {
    match std::fs::metadata(path) {
        Ok(_) => Probe::Present,
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => Probe::Absent,
        Err(_) => Probe::Unknown,
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Probe {
    Present,
    Absent,
    Unknown,
}

impl Probe {
    fn presence(self) -> Presence {
        match self {
            Probe::Present => Presence::Present,
            Probe::Absent => Presence::Deleted,
            Probe::Unknown => Presence::Unknown,
        }
    }
}

impl Folders {
    pub(super) fn shipped_dir(&self, id: &str) -> PathBuf {
        self.shipped.join("agents").join(id)
    }

    /// `userDefinitionDir`: `bots/<id>` for a store bot, else `agents/<id>`.
    pub(super) fn user_dir(&self, lane: &Lane, id: &str) -> PathBuf {
        if is_store_bot(lane, &self.data, id) {
            self.data.join(BOTS_DIR).join(id)
        } else {
            self.data.join("agents").join(id)
        }
    }

    /// `hasUserAgentFile`: the user folder holds an `AGENT.md`.
    pub(super) fn has_user_file(&self, lane: &Lane, id: &str) -> bool {
        self.user_dir(lane, id).join("AGENT.md").exists()
    }

    /// `listCustomAgentIds` (a fresh scan): the starter roles first in their order, then the
    /// rest by id.
    pub(super) fn custom_ids(&self, lane: &Lane) -> Vec<String> {
        let migration = bot_migration(lane, &self.data);
        let migrated: HashSet<&str> = migration
            .as_ref()
            .and_then(|m| m.get("bots"))
            .and_then(Value::as_array)
            .map(|bots| bots.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let user_root = self.data.join("agents");
        let mut roots = Vec::new();
        if migration.is_some() {
            roots.push((Root::Bots, self.data.join(BOTS_DIR)));
        }
        roots.push((Root::User, user_root.clone()));
        roots.push((Root::Shipped, self.shipped.join("agents")));
        let mut ids = HashSet::new();
        for (kind, root) in &roots {
            let Ok(entries) = std::fs::read_dir(root) else { continue };
            for entry in entries.flatten() {
                if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(id) = workflow_id(&name) else { continue };
                if id == MIXY_AGENT_ID || is_role(&id) || self.hidden.contains(&id) {
                    continue;
                }
                match kind {
                    Root::Bots if id == MIXY_BOT_ID || name != id => continue,
                    Root::User if migrated.contains(id.as_str()) => continue,
                    Root::Shipped if user_root.join(&id).join(DELETED_MARKER).exists() => continue,
                    _ => {}
                }
                if !root.join(&name).join("AGENT.md").exists() {
                    continue;
                }
                ids.insert(id);
            }
        }
        let rank = |id: &str| STARTERS.iter().position(|s| *s == id);
        let mut ids: Vec<String> = ids.into_iter().collect();
        ids.sort_by(|left, right| match (rank(left), rank(right)) {
            (None, None) => left.cmp(right),
            (l, r) => l.unwrap_or(usize::MAX).cmp(&r.unwrap_or(usize::MAX)),
        });
        ids
    }

    /// `agentSourceDirs`: the folders a definition is read from, in order.
    fn source_dirs(&self, lane: &Lane, id: &str) -> Vec<PathBuf> {
        if is_store_bot(lane, &self.data, id) {
            return vec![self.data.join(BOTS_DIR).join(id)];
        }
        let user = self.data.join("agents").join(id);
        if user.join(DELETED_MARKER).exists() {
            vec![user]
        } else {
            vec![user, self.shipped_dir(id)]
        }
    }

    /// `loadAgentDefinition`: the first source folder whose entry file has a body.
    pub(super) fn load(&self, lane: &Lane, id: &str) -> Option<Loaded> {
        let mut agent_id = agent_editor_id(id);
        if agent_id.is_empty() {
            agent_id = workflow_id(id)?;
        }
        let slot = FIXED_SLOTS.iter().find(|slot| slot.0 == agent_id);
        for dir in self.source_dirs(lane, &agent_id) {
            let manifest = parse_manifest_text(read_text_safe(&dir.join("agent.json")).as_bytes()).unwrap_or_default();
            let entry = entry_path(&dir, &manifest);
            let (frontmatter, body) = read_document(&read_text_safe(&entry));
            if body.is_empty() {
                continue;
            }
            let label = |own: &str, fallback: Option<&str>| {
                if !own.is_empty() {
                    own.to_owned()
                } else {
                    fallback.map_or_else(|| agent_id.clone(), str::to_owned)
                }
            };
            let name = label(&clean(manifest.get("name")), slot.map(|s| s.1));
            let description = {
                let own = clean(manifest.get("description"));
                if own.is_empty() { slot.map_or("", |s| s.2).to_owned() } else { own }
            };
            let explicit = explicit_kind(frontmatter.get("kind"));
            let (kind, unmarked) = if dir == self.shipped_dir(&agent_id) {
                (explicit, false)
            } else {
                self.kind_of(lane, &agent_id, explicit, &manifest, &body)
            };
            let persona = read_text_safe(&dir.join("PERSONA.md"));
            return Some(Loaded {
                definition: AgentDefinition {
                    id: agent_id.clone(),
                    name,
                    description,
                    permission: permission_or_none(frontmatter.get("permission")),
                    frontmatter,
                    kind,
                    body,
                    persona,
                },
                unmarked,
            });
        }
        None
    }

    /// `readAgentDefinitionKind` (`shared/agent-kind.mjs:140`): the kind from the user copy's
    /// front matter alone, with no body required, and whether it waits for the home thread's
    /// greeting evidence. A store bot is a bot; with no user copy the shipped role's own front
    /// matter decides; with neither, no kind.
    pub(super) fn kind_only(&self, lane: &Lane, id: &str) -> (Option<String>, bool) {
        if is_store_bot(lane, &self.data, id) {
            return (Some("bot".into()), false);
        }
        let dir = self.data.join("agents").join(id);
        let read = |path: PathBuf| std::fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        let Ok(text) = read(dir.join("AGENT.md")) else {
            return match read(self.shipped_dir(id).join("AGENT.md")) {
                Ok(text) => (explicit_kind(read_document(&text).0.get("kind")), false),
                Err(_) => (None, false),
            };
        };
        let (frontmatter, body) = read_document(&text);
        self.kind_of(lane, id, explicit_kind(frontmatter.get("kind")), &manifest_of(&dir), &body)
    }

    /// `readAgentFirstResponseTimeoutMs`: the front matter's `firstResponseTimeoutMs` (a
    /// non-negative number, floored; 0 turns the first-response deadline off) from the first
    /// definition, in precedence order, that sets one. A deleted agent has none.
    pub(super) fn first_response_timeout_ms(&self, lane: &Lane, id: &str) -> Option<i64> {
        let id = mixdog_js::js_trim(id);
        if id.is_empty() || self.user_dir(lane, id).join(DELETED_MARKER).exists() {
            return None;
        }
        let flat = |dir: PathBuf| PathBuf::from(format!("{}.md", dir.display()));
        let files = if is_store_bot(lane, &self.data, id) {
            vec![self.user_dir(lane, id).join("AGENT.md")]
        } else {
            let user = self.data.join("agents").join(id);
            let shipped = self.shipped_dir(id);
            vec![user.join("AGENT.md"), flat(user), shipped.join("AGENT.md"), flat(shipped)]
        };
        files.into_iter().filter(|file| file.exists()).find_map(|file| {
            let (frontmatter, _) = read_document(&read_text_safe(&file));
            let raw = match frontmatter.get("firstResponseTimeoutMs") {
                None | Some(Value::Null) => String::new(),
                Some(value) => mixdog_js::js_trim(&mixdog_js::value_to_string(value)).to_owned(),
            };
            let ms = mixdog_js::string_to_number(&raw);
            (!raw.is_empty() && ms.is_finite() && ms >= 0.0).then(|| ms.floor() as i64)
        })
    }

    /// `agentDefinitionKind` for a user copy: the kind, and whether it waits for the home
    /// thread's greeting evidence.
    fn kind_of(&self, lane: &Lane, id: &str, explicit: Option<String>, manifest: &Map<String, Value>, body: &str) -> (Option<String>, bool) {
        if is_store_bot(lane, &self.data, id) {
            return (Some("bot".into()), false);
        }
        if bot_migration(lane, &self.data).is_some() || explicit.is_some() || id == MIXY_AGENT_ID {
            return (explicit, false);
        }
        if self.shipped_dir(id).join("AGENT.md").exists() {
            return (None, false);
        }
        if truthy(manifest.get("avatar")) && is_dialog_default_body(body) {
            return (Some("bot".into()), false);
        }
        (None, true)
    }

    /// `definitionPresence` for one id.
    pub(super) fn presence(&self, lane: &Lane, agent_id: &str) -> Presence {
        let id = agent_editor_id(agent_id);
        if id.is_empty() || id != agent_id {
            return Presence::Unknown;
        }
        let user = self.user_dir(lane, &id);
        let user_entry = probe(&user.join("AGENT.md"));
        if user_entry != Probe::Absent {
            return user_entry.presence_present();
        }
        match probe(&user.join(DELETED_MARKER)) {
            Probe::Present => return Presence::Deleted,
            Probe::Unknown => return Presence::Unknown,
            Probe::Absent => {}
        }
        probe(&self.shipped_dir(&id).join("AGENT.md")).presence()
    }

    /// `avatarOf`: the avatar of the manifest in effect (the user copy's, else the shipped one),
    /// `Null` when it has none.
    pub(super) fn avatar_of(&self, lane: &Lane, id: &str) -> Value {
        let dir = if self.has_user_file(lane, id) { self.user_dir(lane, id) } else { self.shipped_dir(id) };
        manifest_of(&dir).get("avatar").and_then(super::avatar::normalize_agent_avatar).unwrap_or(Value::Null)
    }

    /// `archivedIdentities` for one id: the name and face a deleted agent left, `None` when it
    /// is not archived.
    pub(super) fn archived_identity(&self, lane: &Lane, agent_id: &str) -> Option<ArchivedIdentity> {
        let id = agent_editor_id(agent_id);
        if id.is_empty() || id != agent_id {
            return None;
        }
        let dir = self.user_dir(lane, &id);
        if !dir.join(DELETED_MARKER).exists() {
            return None;
        }
        let manifest = manifest_of(&dir);
        let name = one_line(manifest.get("name"));
        let avatar = manifest.get("avatar").and_then(super::avatar::normalize_agent_avatar).unwrap_or(Value::Null);
        Some(ArchivedIdentity { name: if name.is_empty() { id } else { name }, avatar })
    }

    /// Mixy's identity folder: `bots/mixy` once the store is active, `agents/lead` before.
    pub(super) fn identity_dir(&self, lane: &Lane) -> PathBuf {
        if bot_migration(lane, &self.data).is_some() {
            self.data.join(BOTS_DIR).join(MIXY_BOT_ID)
        } else {
            self.data.join("agents").join(MIXY_AGENT_ID)
        }
    }
}

impl Probe {
    /// The first probe of `presence` answers `present` or `unknown`, never `deleted`.
    fn presence_present(self) -> Presence {
        match self {
            Probe::Present => Presence::Present,
            _ => Presence::Unknown,
        }
    }
}

/// What a deleted agent left: its name and face (`Null` without one).
#[derive(Clone, Debug, PartialEq)]
pub struct ArchivedIdentity {
    pub name: String,
    pub avatar: Value,
}
