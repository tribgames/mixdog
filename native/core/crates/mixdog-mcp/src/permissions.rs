//! Connector policy: which connected MCP servers an agent or a project may use, and how each
//! tool runs — `auto`, `needs_approval` or `disabled`. Every installed connector is on by
//! default for every agent and project; a policy only switches some off:
//!
//! * `agents/<id>/agent.json` (`bots/<id>/` for a store bot; Mixy — runtime id `lead` — in her
//!   identity folder): `connectors: { off: [serverId…], tools?: { [serverId]: { [tool]: permission } } }`
//! * `<data>/project-connectors.json`: `{ projects: { [projectRoot]: { off: [serverId…] } } }`
//!
//! A tool without an override is `auto`, except a catalog connector's high-risk tools, which ask.
//! A legacy agent list (an array: only its enabled entries were mounted) is enforced as written.
//! A policy that exists but cannot be read mounts nothing. The policies are read into a snapshot
//! (`reload`, called at start and when a policy file changes) so the permission checks on the
//! call path are memory reads.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use arc_swap::ArcSwap;
use mixdog_js::js_trim;
use mixdog_protocol::ThreadId;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::config::McpServerConfig;
use crate::connectors;
use crate::scopes::within_projects;

pub const PROJECT_CONNECTORS_FILE: &str = "project-connectors.json";
/// The self plugin surfaces mixdog's own built-in tools through an MCP prefix; they are not
/// connectors.
pub const SELF_MCP_SERVER: &str = "plugin_mixdog_mixdog";
/// Mixy's runtime agent id.
pub const MIXY_AGENT_ID: &str = "lead";
const MIXY_BOT_ID: &str = "mixy";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Permission {
    Auto,
    NeedsApproval,
    Disabled,
}

impl Permission {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "auto" => Some(Self::Auto),
            "needs_approval" => Some(Self::NeedsApproval),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::NeedsApproval => "needs_approval",
            Self::Disabled => "disabled",
        }
    }
}

type ToolOverrides = BTreeMap<String, BTreeMap<String, Permission>>;

#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct Policy {
    /// A legacy list's enabled entries: only these mount.
    pub allow: Option<BTreeSet<String>>,
    pub off: BTreeSet<String>,
    pub tools: ToolOverrides,
}

/// What a policy file holds.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub enum Loaded {
    /// No file or no field: every connector is on.
    #[default]
    Absent,
    Policy(Policy),
    /// A policy that cannot be trusted mounts nothing.
    DenyAll,
}

fn clean(value: &Value) -> String {
    value.as_str().map_or_else(String::new, |s| js_trim(s).to_owned())
}

fn unique_ids(list: Option<&Value>) -> BTreeSet<String> {
    list.and_then(Value::as_array).into_iter().flatten().map(clean).filter(|s| !s.is_empty()).collect()
}

fn tool_overrides(value: Option<&Value>) -> ToolOverrides {
    let mut out = ToolOverrides::new();
    for (server, tools) in value.and_then(Value::as_object).into_iter().flatten() {
        let own: BTreeMap<String, Permission> = tools
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(tool, permission)| {
                let tool = js_trim(tool);
                Some((tool.to_owned(), Permission::parse(permission.as_str()?)?)).filter(|_| !tool.is_empty())
            })
            .collect();
        if !js_trim(server).is_empty() && !own.is_empty() {
            out.insert(js_trim(server).to_owned(), own);
        }
    }
    out
}

/// A stored `connectors` field → a policy; `Ok(None)` when absent. A legacy list parses with
/// `allow` set. Any other shape is an error.
pub fn parse_connector_policy(value: Option<&Value>) -> Result<Option<Policy>, String> {
    let Some(value) = value.filter(|v| !v.is_null()) else { return Ok(None) };
    if let Some(list) = value.as_array() {
        let mut allow = BTreeSet::new();
        let mut tools = ToolOverrides::new();
        for item in list {
            let id = item.get("id").map(clean).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            if item.get("enabled") == Some(&Value::Bool(true)) {
                allow.insert(id.clone());
            }
            let wrapped = Value::Object(Map::from_iter([(id.clone(), item.get("tools").cloned().unwrap_or(Value::Null))]));
            if let Some(own) = tool_overrides(Some(&wrapped)).remove(&id) {
                tools.entry(id).or_default().extend(own);
            }
        }
        return Ok(Some(Policy { allow: Some(allow), off: BTreeSet::new(), tools }));
    }
    let Some(map) = value.as_object().filter(|m| m.keys().all(|k| k == "off" || k == "tools")) else {
        return Err("connectors must be { off: [connector id…], tools? }".to_owned());
    };
    if map.get("off").is_some_and(|v| !v.is_null() && !v.is_array()) {
        return Err("connectors.off must be a list".to_owned());
    }
    if map.get("tools").is_some_and(|v| !v.is_null() && !v.is_object()) {
        return Err("connectors.tools must be an object".to_owned());
    }
    Ok(Some(Policy { allow: None, off: unique_ids(map.get("off")), tools: tool_overrides(map.get("tools")) }))
}

impl Policy {
    /// Whether connector `server` is on under this policy.
    pub fn enabled(&self, server: &str) -> bool {
        if self.allow.as_ref().is_some_and(|allow| !allow.contains(server)) {
            return false;
        }
        !self.off.contains(server)
    }

    /// The entries for `tool` under connector `group` or any of its accounts, topmost first:
    /// the connector's own, then the lowest-numbered account.
    fn entries(&self, group: &str, tool: &str) -> Vec<Permission> {
        let account_number = |id: &str| -> u64 {
            id.rsplit_once('-')
                .filter(|(_, n)| n.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|(_, n)| n.parse().ok())
                .unwrap_or(0)
        };
        let mut found: Vec<(u64, Permission)> = self
            .tools
            .iter()
            .filter(|(id, _)| connectors::group_id(id) == group)
            .filter_map(|(id, own)| Some((account_number(id), *own.get(tool)?)))
            .collect();
        found.sort_by_key(|(n, _)| *n);
        found.into_iter().map(|(_, p)| p).collect()
    }
}

/// `{ server, tool }` of an MCP tool name (Node `parseMcpToolName` for a name: a leading
/// `functions.` is dropped, then `/^mcp__(.+?)__(.+)$/`).
pub fn parse_mcp_tool_name(name: &str) -> Option<(String, String)> {
    crate::connector_accounts::split_mcp_tool_name(name.strip_prefix("functions.").unwrap_or(name))
}

/// The permission of `tool` on `server` under one agent's policy.
pub fn permission(loaded: &Loaded, server: &str, tool: &str, connector_of_server: Option<&str>) -> Permission {
    if server == SELF_MCP_SERVER {
        return Permission::Auto;
    }
    let policy = match loaded {
        Loaded::DenyAll => return Permission::Disabled,
        Loaded::Policy(policy) => Some(policy),
        Loaded::Absent => None,
    };
    if policy.is_some_and(|p| !p.enabled(server)) {
        return Permission::Disabled;
    }
    // An explicit entry of the tool's connector decides; otherwise a catalog connector's
    // high-risk tools ask and any other tool is auto.
    if let Some(own) = policy.and_then(|p| p.entries(&connectors::group_id(server), tool).first().copied()) {
        return own;
    }
    if connectors::tool_default_asks(connector_of_server, tool) {
        Permission::NeedsApproval
    } else {
        Permission::Auto
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
struct ProjectOff {
    root: String,
    off: BTreeSet<String>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
enum Projects {
    Absent,
    Roots(Vec<ProjectOff>),
    DenyAll,
}

struct Snapshot {
    agents: HashMap<String, Loaded>,
    projects: Projects,
}

fn lone_policy(manifest: &Value) -> Result<Loaded, String> {
    Ok(match parse_connector_policy(manifest.get("connectors"))? {
        Some(policy) => Loaded::Policy(policy),
        None => Loaded::Absent,
    })
}

/// Node `readJson` over a policy file: no file (or a path through a file) is `absent`; a file
/// that cannot be read is `deny`; a damaged one (empty, NUL-filled, torn, or a shape `parse`
/// refuses) falls back to its last good copy `<file>.bak` and, without one, is `deny` — it never
/// fails open.
fn read_policy_file<T>(
    lane: &InLane<MaintenanceIo>,
    path: &Path,
    parse: impl Fn(&Value) -> Result<T, String>,
    absent: T,
    deny: T,
) -> T {
    // With a good copy the damaged file is kept aside (`<file>.corrupt-<ms>`) and the copy
    // restored in its place, so the user's deny list survives. Without one the file stays
    // where it is (`keep_without_backup`): moving it would read as "no policy" (all on).
    let valid = |value: &Value| parse(value).map(drop).map_err(mixdog_statefile::Invalid::Damaged);
    let opts = mixdog_statefile::Opts { keep_without_backup: true, ..mixdog_statefile::Opts::default() };
    match mixdog_statefile::read_json(lane, path, Some(&valid), &opts) {
        Ok(Some(value)) => parse(&value).unwrap_or(deny),
        // Nothing there is `absent`; a damaged file left in place with no good copy denies.
        Ok(None) if path.exists() => {
            tracing::warn!(path = %path.display(), "connector policy is unreadable; denying all connectors");
            deny
        }
        Ok(None) => absent,
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => absent,
        Err(error) if error.raw_os_error().is_some_and(|c| c == 20 || c == 267) => absent,
        Err(_) => deny,
    }
}

fn read_agent_policy(lane: &InLane<MaintenanceIo>, path: &Path) -> Loaded {
    read_policy_file(lane, path, lone_policy, Loaded::Absent, Loaded::DenyAll)
}

fn projects_of(raw: &Value) -> Result<Projects, String> {
    let object = raw.as_object().ok_or("projects must be an object")?;
    let projects = match object.get("projects") {
        None | Some(Value::Null) => return Ok(Projects::Roots(Vec::new())),
        Some(Value::Object(map)) => map,
        Some(_) => return Err("projects must be an object".to_owned()),
    };
    let mut out = Vec::new();
    for (root, entry) in projects {
        let Some(entry) = entry.as_object() else { return Err(format!("project \"{root}\" must be {{ off: [connector id…] }}")) };
        if entry.get("off").is_some_and(|v| !v.is_null() && !v.is_array()) {
            return Err(format!("project \"{root}\" must be {{ off: [connector id…] }}"));
        }
        let off = unique_ids(entry.get("off"));
        if !js_trim(root).is_empty() && !off.is_empty() {
            out.push(ProjectOff { root: js_trim(root).to_owned(), off });
        }
    }
    Ok(Projects::Roots(out))
}

fn read_projects(lane: &InLane<MaintenanceIo>, path: &Path) -> Projects {
    read_policy_file(lane, path, projects_of, Projects::Absent, Projects::DenyAll)
}

/// The folder of agent `id`'s definition. Mixy (`lead`) lives in her identity folder.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn agent_dir(data_dir: &Path, id: &str, store: &BotStore) -> PathBuf {
    if id == MIXY_AGENT_ID {
        return if store.active { data_dir.join("bots").join(MIXY_BOT_ID) } else { data_dir.join("agents").join("lead") };
    }
    let is_store_bot = store.active
        && id != MIXY_BOT_ID
        && !id.starts_with('.')
        && (data_dir.join("bots").join(id).exists() || store.bots.contains(id));
    if is_store_bot { data_dir.join("bots").join(id) } else { data_dir.join("agents").join(id) }
}

struct BotStore {
    active: bool,
    bots: BTreeSet<String>,
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn bot_store(data_dir: &Path) -> BotStore {
    let manifest = std::fs::read_to_string(data_dir.join("bots").join("migration.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(|m| m.get("version") == Some(&Value::from(1)));
    BotStore {
        active: manifest.is_some(),
        bots: unique_ids(manifest.as_ref().and_then(|m| m.get("bots"))),
    }
}

fn valid_agent_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn load_snapshot(lane: &InLane<MaintenanceIo>, data_dir: &Path) -> Snapshot {
    let store = bot_store(data_dir);
    let mut ids: BTreeSet<String> = BTreeSet::from([MIXY_AGENT_ID.to_owned()]);
    for folder in ["agents", "bots"] {
        for entry in std::fs::read_dir(data_dir.join(folder)).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if valid_agent_id(&name) && name != MIXY_BOT_ID && name != "lead" {
                ids.insert(name);
            }
        }
    }
    let agents = ids
        .into_iter()
        .map(|id| {
            let loaded = read_agent_policy(lane, &agent_dir(data_dir, &id, &store).join("agent.json"));
            (id, loaded)
        })
        .collect();
    Snapshot { agents, projects: read_projects(lane, &data_dir.join(PROJECT_CONNECTORS_FILE)) }
}

/// Where connector policies are read from and saved to.
#[derive(Clone, Copy)]
pub struct PolicyIo {
    pub maintenance: MaintenanceIo,
    pub interactive: InteractiveIo,
    pub durability: DurabilityIo,
}

pub struct ConnectorPolicy {
    data_dir: PathBuf,
    io: PolicyIo,
    snapshot: ArcSwap<Snapshot>,
    /// Server name → the catalog connector it connects.
    connectors: ArcSwap<HashMap<String, String>>,
    /// Resolves a qualified tool name the model uses to its server and the server's own tool
    /// name (names cut with a hash suffix cannot be parsed back).
    resolver: ArcSwap<Option<Resolver>>,
    /// The project folders a thread runs in.
    thread_paths: ArcSwap<Option<ThreadPaths>>,
}

/// Resolves a qualified tool name to its server and the server's own tool name.
pub type Resolver = Arc<dyn Fn(&str) -> Option<(String, String)> + Send + Sync>;

/// The project folders (the session's working directory and its workspace roots) of a thread.
pub type ThreadPaths = Arc<dyn Fn(&ThreadId) -> Vec<PathBuf> + Send + Sync>;

impl ConnectorPolicy {
    pub fn new(data_dir: PathBuf, io: PolicyIo) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            io,
            snapshot: ArcSwap::from_pointee(Snapshot { agents: HashMap::new(), projects: Projects::Absent }),
            connectors: ArcSwap::from_pointee(HashMap::new()),
            resolver: ArcSwap::from_pointee(None),
            thread_paths: ArcSwap::from_pointee(None),
        })
    }

    pub fn set_thread_paths(&self, paths: ThreadPaths) {
        self.thread_paths.store(Arc::new(Some(paths)));
    }

    /// The project folders `thread` runs in; none while no source is wired.
    pub fn paths_of(&self, thread: &ThreadId) -> Vec<PathBuf> {
        match &**self.thread_paths.load() {
            Some(paths) => paths(thread),
            None => Vec::new(),
        }
    }

    /// Re-reads every policy file. Called at start and when a policy file changes.
    pub async fn reload(&self) {
        let data_dir = self.data_dir.clone();
        let Ok(job) = self.io.maintenance.submit(&CancellationToken::new(), move |lane| load_snapshot(lane, &data_dir)) else {
            return;
        };
        if let Ok(snapshot) = job.await {
            self.snapshot.store(Arc::new(snapshot));
        }
    }

    /// The files whose changes should trigger [`reload`](Self::reload): the data directory
    /// holds the project policy; agent policies are `agent.json` under `agents/` and `bots/`.
    pub fn watched(&self) -> Vec<PathBuf> {
        vec![self.data_dir.join("agents"), self.data_dir.join("bots"), self.data_dir.join(PROJECT_CONNECTORS_FILE)]
    }

    /// Records which catalog connector each configured server connects.
    pub fn set_servers(&self, configs: &[McpServerConfig]) {
        let map = configs
            .iter()
            .filter_map(|c| Some((c.name.clone(), c.connector.clone()?)))
            .collect();
        self.connectors.store(Arc::new(map));
    }

    pub fn set_resolver(&self, resolver: Resolver) {
        self.resolver.store(Arc::new(Some(resolver)));
    }

    fn split(&self, name: &str) -> Option<(String, String)> {
        if let Some(resolve) = &**self.resolver.load()
            && let Some(found) = resolve(name)
        {
            return Some(found);
        }
        parse_mcp_tool_name(name)
    }

    /// The permission `agent` has for the MCP tool `name`; a name that is no MCP tool is `auto`.
    pub fn permission(&self, agent: &str, name: &str) -> Permission {
        let Some((server, tool)) = self.split(name) else { return Permission::Auto };
        let snapshot = self.snapshot.load();
        let loaded = if valid_agent_id(agent) { snapshot.agents.get(agent).cloned().unwrap_or_default() } else { Loaded::Absent };
        let connectors = self.connectors.load();
        permission(&loaded, &server, &tool, connectors.get(&server).map(String::as_str))
    }

    /// The model-visible refusal when `agent` may not use the tool, or `None`.
    pub fn agent_refusal(&self, agent: &str, name: &str) -> Option<String> {
        (self.permission(agent, name) == Permission::Disabled)
            .then(|| format!("Error: tool \"{name}\" is not available to this agent."))
    }

    /// Whether the project the session runs in (any of `paths`) switched the tool's connector
    /// off, or its policy file cannot be read.
    pub fn project_disabled(&self, paths: &[PathBuf], name: &str) -> bool {
        let Some((server, _)) = self.split(name) else { return false };
        if server == SELF_MCP_SERVER || paths.is_empty() {
            return false;
        }
        match &self.snapshot.load().projects {
            Projects::Absent => false,
            Projects::DenyAll => true,
            Projects::Roots(list) => list
                .iter()
                .any(|p| p.off.contains(&server) && paths.iter().any(|path| within_projects(path, std::slice::from_ref(&p.root)))),
        }
    }

    /// The model-visible refusal when the project switched the tool's connector off.
    pub fn project_refusal(&self, paths: &[PathBuf], name: &str) -> Option<String> {
        self.project_disabled(paths, name).then(|| format!("Error: tool \"{name}\" is switched off in this project."))
    }

    /// Saves `permission` for the connector tool `name` under `agent`'s own policy, keeping every
    /// other key of its `agent.json`. False when it is no connector tool or the policy is a
    /// legacy list or could not be written.
    pub async fn write_permission(&self, agent: &str, name: &str, permission: Permission) -> bool {
        let Some((server, tool)) = self.split(name).filter(|(s, _)| s != SELF_MCP_SERVER) else { return false };
        if !valid_agent_id(agent) {
            return false;
        }
        let (data_dir, group, agent_id) = (self.data_dir.clone(), connectors::group_id(&server), agent.to_owned());
        let Ok(job) = self.io.durability.submit(&CancellationToken::new(), move |lane| {
            write_agent_permission(lane, &data_dir, &agent_id, &group, &tool, permission)
        }) else {
            return false;
        };
        let saved = job.await.is_ok_and(|saved| saved);
        if saved {
            self.reload().await;
        }
        saved
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job (InLane proof)")]
fn write_agent_permission(
    lane: &InLane<DurabilityIo>,
    data_dir: &Path,
    agent: &str,
    group: &str,
    tool: &str,
    permission: Permission,
) -> bool {
    let store = bot_store(data_dir);
    let path = agent_dir(data_dir, agent, &store).join("agent.json");
    let mut manifest: Map<String, Value> = match std::fs::read_to_string(&path) {
        Ok(text) => match mixdog_statefile::parse_json_text(text.as_bytes()) {
            Ok(Value::Object(map)) => map,
            _ => return false,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(_) => return false,
    };
    let connectors = manifest.entry("connectors").or_insert_with(|| Value::Object(Map::new()));
    let Some(connectors) = connectors.as_object_mut() else { return false };
    let tools = connectors.entry("tools").or_insert_with(|| Value::Object(Map::new()));
    let Some(tools) = tools.as_object_mut() else { return false };
    let own = tools.entry(group).or_insert_with(|| Value::Object(Map::new()));
    let Some(own) = own.as_object_mut() else { return false };
    own.insert(tool.to_owned(), Value::String(permission.name().to_owned()));
    // `writeJsonAtomicSync(file, manifest, { backup: true })`.
    let opts = mixdog_statefile::Opts { backup: true, ..mixdog_statefile::Opts::default() };
    mixdog_statefile::write_json(lane, &path, &Value::Object(manifest), &opts).is_ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn loaded(connectors: Value) -> Loaded {
        match parse_connector_policy(Some(&connectors)).unwrap() {
            Some(policy) => Loaded::Policy(policy),
            None => Loaded::Absent,
        }
    }

    #[test]
    fn defaults_overrides_and_switches() {
        assert_eq!(permission(&Loaded::Absent, "slack", "post", None), Permission::Auto);
        assert_eq!(permission(&Loaded::Absent, "gmail", "send_email", Some("gmail")), Permission::NeedsApproval);
        let policy = loaded(json!({"off": ["slack"], "tools": {"gmail": {"send_email": "auto", "read": "disabled"}}}));
        assert_eq!(permission(&policy, "slack", "post", None), Permission::Disabled);
        assert_eq!(permission(&policy, "gmail", "send_email", Some("gmail")), Permission::Auto);
        assert_eq!(permission(&policy, "gmail-2", "read", Some("gmail")), Permission::Disabled, "accounts share the connector's entry");
        assert_eq!(permission(&Loaded::DenyAll, "x", "y", None), Permission::Disabled);
        assert_eq!(permission(&Loaded::DenyAll, SELF_MCP_SERVER, "y", None), Permission::Auto);
    }

    #[test]
    fn a_legacy_list_mounts_only_its_enabled_entries() {
        let policy = loaded(json!([{"id": "a", "enabled": true, "tools": {"t": "needs_approval"}}, {"id": "b", "enabled": false}]));
        assert_eq!(permission(&policy, "a", "t", None), Permission::NeedsApproval);
        assert_eq!(permission(&policy, "b", "t", None), Permission::Disabled);
        assert_eq!(permission(&policy, "c", "t", None), Permission::Disabled);
    }

    #[test]
    fn malformed_shapes_are_errors() {
        assert!(parse_connector_policy(Some(&json!({"nope": 1}))).is_err());
        assert!(parse_connector_policy(Some(&json!({"off": "x"}))).is_err());
        assert_eq!(parse_mcp_tool_name("mcp__a__b__c"), Some(("a".to_owned(), "b__c".to_owned())));
        assert_eq!(parse_mcp_tool_name("read"), None);
    }
}
