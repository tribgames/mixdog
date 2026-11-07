//! The plugin methods of the runtime API (Node `session-runtime/resource-plugins-api.mjs`) and
//! `config/setExtensionScope` (`resource-api.mjs`), served as one [`DomainService`].
//!
//! A plugin's MCP servers derive from the registry (`plugin_servers`), so each registry edit first
//! adopts any copies an earlier enable action left in the config, then reconciles this process's
//! MCP connections and lets the other processes reconcile theirs. The service owns the registry
//! edits and the config they cause; what a save or a reconcile does to the live process is the
//! host's ([`ExtensionHost`]), and the config file is the [`ExtensionConfig`] port.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::declaration_cache::DeclarationCache;
use crate::plugin_admin::PluginAdmin;
use crate::plugin_admin::clean;
use crate::plugin_admin::truthy;
use crate::plugin_servers::Catalog;
use crate::plugin_servers::declarations_of;
use crate::plugin_servers::resolve_mcp_server_catalog;
use crate::plugin_servers::with_adopted_copies;
use crate::plugin_servers::with_pinned_collision_names;
use crate::plugin_servers::without_plugin_intents;
use crate::scopes::ExtensionScopes;
use crate::scopes::ScopeKind;
use crate::scopes::plan_extension_scope;
use crate::scopes::within_projects;

const METHODS: &[&str] = &[
    "plugins/pluginsStatus",
    "plugins/addPlugin",
    "plugins/updatePlugin",
    "plugins/setPluginEnabled",
    "plugins/removePlugin",
    "plugins/reloadPlugins",
    "config/setExtensionScope",
];

/// The agent config the extension services read and write (`getConfig()` and
/// `saveConfigAndAdopt` of Node). `mixdog-core` implements it for its `Config`.
#[async_trait]
pub trait ExtensionConfig: Send + Sync {
    /// The agent section of the config file.
    fn agent(&self) -> Map<String, Value>;
    /// Stores `after` as the agent config: the difference to `before` (what this writer started
    /// from) is applied in one transaction, so a field another writer changed meanwhile survives.
    async fn save_agent(&self, before: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String>;
    /// `settingsApi.setDisabledSkills`: adopts the (already normalized) list in memory at once and
    /// schedules the debounced save; [`ExtensionHost::flush_skills_save`] writes it out.
    fn set_disabled_skills(&self, names: &[String]);
}

/// What a registry or scope change does to the live process (Node's `sync` and runtime hooks).
#[async_trait]
pub trait ExtensionHost: Send + Sync {
    /// Reconnects this process's MCP servers to the registry's derived set, then announces `plugins`.
    async fn reconcile_plugins_and_announce(&self);
    /// Announces a change of `kind` (`skills`, `mcp`, `plugins`) to new sessions and other processes.
    async fn announce(&self, kind: &str);
    /// [`announce`](Self::announce) for a caller that already dropped the skills cache itself
    /// (`announce(kind, { invalidate: false })`).
    async fn announce_without_invalidating(&self, kind: &str);
    /// The names of the tools the session offers (`getTools()`); a surface that cannot be read is
    /// the error.
    async fn tool_names(&self) -> Result<Vec<String>, String>;
    /// `reconnectMcpAndAnnounce({ only, enabled, drop })`: connect (or, when `enabled` is false,
    /// disconnect) server `only` and disconnect the `drop` names, reconcile, announce `mcp` with
    /// that change list to the other runtimes, and answer the MCP status.
    async fn reconnect_mcp_and_announce(&self, only: Option<&str>, enabled: bool, drop: &[String]) -> Value;
    /// `reconnectMcpAndAnnounce()`: every configured server reconnects, then `mcp` is announced.
    async fn reconnect_all_mcp_and_announce(&self) -> Value;
    /// `scheduleMcpToggle(name, enabled)`: the heavy reconnect of a toggle, one chain per server,
    /// converging on the last requested state; answers the MCP status.
    async fn schedule_mcp_toggle(&self, name: &str, enabled: bool) -> Value;
    /// `publish('mcp', { mcpChanges })`: tell the other runtimes (not this one) what changed.
    async fn publish_mcp_changes(&self, changes: &[(String, bool)]);
    /// `announce('mcp', { detail: { mcpChanges } })`: refresh the surface and publish.
    async fn announce_mcp_changes(&self, changes: &[(String, bool)]);
    /// `connectConfiguredMcp({ only, enabled })`: connect or disconnect one server in this
    /// process; answers the MCP status.
    async fn connect_configured_mcp(&self, only: &str, enabled: bool) -> Value;
    /// Drops the skills cache (and the recursive watchers on plugin roots).
    fn invalidate_skills(&self);
    /// Persists debounced skill-state writes now.
    async fn flush_skills_save(&self);
    /// The folder the caller's session works in (`getCurrentCwd()`).
    async fn current_cwd(&self, thread_id: Option<&str>) -> Result<PathBuf, String>;
    /// The skills status (`skillsStatus()`), undecorated.
    async fn skills_status(&self) -> Value;
}

pub struct PluginsService {
    admin: Arc<PluginAdmin>,
    declarations: Arc<DeclarationCache>,
    config: Arc<dyn ExtensionConfig>,
    host: Arc<dyn ExtensionHost>,
    maintenance: MaintenanceIo,
}

fn domain_error(domain: &str, message: String) -> CoreError {
    CoreError::DomainError { domain: domain.into(), code: None, message: Some(message.into()), detail: None }
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

/// The envelope of `pluginsStatus()` (`cwd-plugins/plugin-status.mjs`) over the registry status: the
/// entries whose root exists are `plugins` and counted, those whose root is gone are `missing`, and the
/// registry and install paths are `roots`. The rows stay the registry's enriched entries.
fn plugins_status(admin: &Value) -> Value {
    let first = |candidates: &[&str]| candidates.iter().find(|s| !s.is_empty()).copied().unwrap_or_default().to_owned();
    let mut plugins = Vec::new();
    let mut missing = Vec::new();
    for entry in admin.get("plugins").and_then(Value::as_array).into_iter().flatten() {
        let root = clean(field(entry, "root"));
        if root.is_empty() {
            continue;
        }
        if field(entry, "exists") == &Value::Bool(true) {
            plugins.push(entry.clone());
            continue;
        }
        let (id, name) = (clean(field(entry, "id")), clean(field(entry, "name")));
        let tail = root.rsplit(['/', '\\']).next().unwrap_or_default();
        missing.push(json!({
            "id": first(&[id.as_str(), name.as_str(), root.as_str()]),
            "name": first(&[name.as_str(), id.as_str(), tail, root.as_str()]),
            "enabled": field(entry, "enabled") != &Value::Bool(false),
        }));
    }
    json!({
        "count": plugins.len(),
        "plugins": plugins,
        "missing": missing,
        "roots": { "registry": field(admin, "registryPath"), "installed": field(admin, "installRoot") },
    })
}

/// `clean(plugin.id || plugin.name || plugin)`; reading a property of null throws in Node.
fn plugin_key(plugin: &Value) -> Result<String, String> {
    if plugin.is_null() {
        return Err("Cannot read properties of null (reading 'id')".to_owned());
    }
    let first = field(plugin, "id");
    let second = field(plugin, "name");
    Ok(clean(if truthy(first) { first } else if truthy(second) { second } else { plugin }))
}

/// The registered status row a caller means by `plugin` (row, id, name, or title), if any.
pub(crate) fn find_registered_plugin<'a>(status: &'a Value, plugin: &Value) -> Result<Option<&'a Value>, String> {
    let key = plugin_key(plugin)?;
    if key.is_empty() {
        return Ok(None);
    }
    let rows = status.get("plugins").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    Ok(rows.iter().find(|row| ["id", "name", "title"].iter().any(|f| clean(field(row, f)) == key)))
}

fn scope_info(scopes: &ExtensionScopes, kind: ScopeKind, name: &str, plugin_id: &str, cwd: &Path) -> [(&'static str, Value); 3] {
    let scope = scopes.projects(kind, name);
    let inherited = if plugin_id.is_empty() { None } else { scopes.projects(ScopeKind::Plugins, plugin_id) };
    let active = scope.is_none_or(|roots| within_projects(cwd, roots)) && inherited.is_none_or(|roots| within_projects(cwd, roots));
    [("scope", json!(scope)), ("inheritedScope", json!(inherited)), ("activeHere", json!(active))]
}

fn decorated(status: &Value, list: &str, decorate: impl Fn(&Value) -> [(&'static str, Value); 3]) -> Value {
    let mut out = status.as_object().cloned().unwrap_or_default();
    let rows = status.get(list).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let rows: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut next = row.as_object().cloned().unwrap_or_default();
            for (key, value) in decorate(row) {
                next.insert(key.to_owned(), value);
            }
            Value::Object(next)
        })
        .collect();
    out.insert(list.to_owned(), Value::Array(rows));
    Value::Object(out)
}

/// Project scope on the plugin status rows: `scope` is the entry's own root list (null = global),
/// `activeHere` says whether `cwd` sees the plugin.
pub fn decorate_plugins(status: &Value, scopes: &ExtensionScopes, cwd: &Path) -> Value {
    decorated(status, "plugins", |plugin| {
        let id = field(plugin, "id");
        scope_info(scopes, ScopeKind::Plugins, &clean(if truthy(id) { id } else { field(plugin, "name") }), "", cwd)
    })
}

/// Project scope on the MCP status rows, including the scope a server inherits from its plugin.
pub fn decorate_mcp(status: &Value, scopes: &ExtensionScopes, cwd: &Path) -> Value {
    decorated(status, "servers", |server| {
        let owner = field(server, "owner");
        let plugin_id = if field(owner, "kind") == "plugin" { clean(field(owner, "id")) } else { String::new() };
        scope_info(scopes, ScopeKind::Mcp, &clean(field(server, "name")), &plugin_id, cwd)
    })
}

/// Project scope on the skill status rows, including the scope a skill inherits from its plugin.
pub fn decorate_skills(status: &Value, scopes: &ExtensionScopes, cwd: &Path) -> Value {
    decorated(status, "skills", |skill| {
        let owner = field(skill, "owner");
        let plugin_id = if field(owner, "kind") == "plugin" { clean(field(owner, "id")) } else { String::new() };
        scope_info(scopes, ScopeKind::Skills, &clean(field(skill, "name")), &plugin_id, cwd)
    })
}

impl PluginsService {
    pub fn new(
        admin: Arc<PluginAdmin>,
        declarations: Arc<DeclarationCache>,
        config: Arc<dyn ExtensionConfig>,
        host: Arc<dyn ExtensionHost>,
        maintenance: MaintenanceIo,
    ) -> Self {
        Self { admin, declarations, config, host, maintenance }
    }

    async fn on_lane<T: Send + 'static>(&self, work: impl FnOnce(&InLane<MaintenanceIo>) -> T + Send + 'static) -> Result<T, CoreError> {
        let job = self.maintenance.submit(&CancellationToken::new(), work)?;
        job.await.map_err(|_| CoreError::Cancelled { by: "maintenance lane".into() })
    }

    async fn status(&self) -> Result<Value, CoreError> {
        let admin = Arc::clone(&self.admin);
        let status = self.on_lane(move |lane| admin.status(lane)).await?.map_err(|e| domain_error("plugins", e.0))?;
        Ok(plugins_status(&status))
    }

    fn scopes(&self) -> ExtensionScopes {
        ExtensionScopes::from_config(self.config.agent().get("extensionScopes").unwrap_or(&Value::Null))
    }

    /// `resolveMcpCatalog()`: the effective MCP server set of the current config and registry.
    async fn catalog(&self, config: Value, cwd: String) -> Result<Catalog, CoreError> {
        let (admin, declarations) = (Arc::clone(&self.admin), Arc::clone(&self.declarations));
        self.on_lane(move |lane| {
            let rows = admin.list_registered_plugins(lane).map_err(|e| e.0)?;
            let declared = declarations_of(&rows, &|root| declarations.load(lane, root));
            Ok::<_, String>(resolve_mcp_server_catalog(&config, &declared, &cwd, &admin.data_dir().to_string_lossy()))
        })
        .await?
        .map_err(|message| domain_error("plugins", message))
    }

    async fn save(&self, before: &Map<String, Value>, after: Value) -> Result<(), CoreError> {
        let after = after.as_object().cloned().unwrap_or_default();
        self.config.save_agent(before, &after).await.map_err(|message| domain_error("config", message))
    }

    /// Persist any adoptable copies of plugin servers while the registry still knows their plugin
    /// (a removal must not leave them stranded), and keep any collision name a plugin server was
    /// just given. `transform` edits the result before it is stored.
    async fn adopt_plugin_server_copies(&self, thread: Option<&str>, transform: impl FnOnce(Value) -> Value) -> Result<(), CoreError> {
        let before = self.config.agent();
        let current = Value::Object(before.clone());
        let cwd = self.host.current_cwd(thread).await.map_err(|e| domain_error("config", e))?.to_string_lossy().into_owned();
        let catalog = self.catalog(current.clone(), cwd).await?;
        let adopted = with_adopted_copies(&current, catalog.adoption.as_ref());
        let next = transform(with_pinned_collision_names(&adopted, &catalog));
        if next == current {
            return Ok(());
        }
        self.save(&before, next).await?;
        self.host.flush_skills_save().await;
        Ok(())
    }

    async fn add_plugin(&self, params: &Value, thread: Option<&str>) -> Result<Value, CoreError> {
        let (admin, source) = (Arc::clone(&self.admin), field(params, "source").clone());
        let plugin = self.on_lane(move |lane| admin.add_plugin(lane, &source, None)).await?.map_err(|e| domain_error("plugins", e.0))?;
        self.adopt_plugin_server_copies(thread, |config| config).await?;
        self.host.reconcile_plugins_and_announce().await;
        Ok(json!({"plugin": plugin, "status": self.status().await?}))
    }

    async fn update_plugin(&self, params: &Value, thread: Option<&str>) -> Result<Value, CoreError> {
        // Windows refuses to rename a directory holding an open recursive skill watch, so drop the
        // watchers before the root is swapped.
        self.host.invalidate_skills();
        let key = plugin_key(field(params, "plugin")).map_err(|m| domain_error("plugins", m))?;
        let admin = Arc::clone(&self.admin);
        let updated = self.on_lane(move |lane| admin.update_plugin(lane, &json!(key))).await?.map_err(|e| domain_error("plugins", e.0))?;
        self.adopt_plugin_server_copies(thread, |config| config).await?;
        self.host.reconcile_plugins_and_announce().await;
        Ok(json!({"plugin": updated, "status": self.status().await?}))
    }

    async fn set_plugin_enabled(&self, params: &Value, thread: Option<&str>) -> Result<Value, CoreError> {
        self.adopt_plugin_server_copies(thread, |config| config).await?;
        let key = plugin_key(field(params, "plugin")).map_err(|m| domain_error("plugins", m))?;
        let enabled = params.get("enabled").cloned().unwrap_or(Value::Bool(true));
        let admin = Arc::clone(&self.admin);
        let updated = self.on_lane(move |lane| admin.set_plugin_enabled(lane, &json!(key), &enabled)).await?.map_err(|e| domain_error("plugins", e.0))?;
        self.host.reconcile_plugins_and_announce().await;
        Ok(json!({"plugin": updated, "status": self.status().await?}))
    }

    async fn remove_plugin(&self, params: &Value, thread: Option<&str>) -> Result<Value, CoreError> {
        let plugin = field(params, "plugin");
        let status = self.status().await?;
        let owner = find_registered_plugin(&status, plugin).map_err(|m| domain_error("plugins", m))?;
        let owner_id = owner.map(|row| clean(field(row, "id"))).unwrap_or_default();
        // Adopt first (the registry still knows the plugin), then drop the plugin's per-server
        // intent together with the plugin.
        self.adopt_plugin_server_copies(thread, |config| if owner_id.is_empty() { config } else { without_plugin_intents(&config, &owner_id) }).await?;
        let key = plugin_key(plugin).map_err(|m| domain_error("plugins", m))?;
        let admin = Arc::clone(&self.admin);
        let removed = self.on_lane(move |lane| admin.remove_plugin(lane, &json!(key))).await?.map_err(|e| domain_error("plugins", e.0))?;
        self.host.reconcile_plugins_and_announce().await;
        Ok(json!({"plugin": removed, "status": self.status().await?}))
    }

    async fn set_extension_scope(&self, params: &Value, thread: Option<&str>) -> Result<Value, CoreError> {
        let before = self.config.agent();
        let kind = field(params, "kind");
        let rows = if clean(kind) == "plugins" {
            self.status().await?.get("plugins").and_then(Value::as_array).cloned().unwrap_or_default()
        } else {
            Vec::new()
        };
        let change = plan_extension_scope(&Value::Object(before.clone()), kind, field(params, "name"), field(params, "projects"), &rows)
            .map_err(|e| domain_error("config", e.to_string()))?;
        self.save(&before, change.config).await?;
        // Connections and files are untouched; only what sessions see changes.
        let announced = if change.kind == ScopeKind::Skills { "skills" } else { "plugins" };
        self.host.announce(announced).await;
        let cwd = self.host.current_cwd(thread).await.map_err(|e| domain_error("config", e))?;
        let scopes = self.scopes();
        Ok(match change.kind {
            ScopeKind::Skills => decorate_skills(&self.host.skills_status().await, &scopes, &cwd),
            _ => decorate_plugins(&self.status().await?, &scopes, &cwd),
        })
    }
}

#[async_trait]
impl DomainService for PluginsService {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params = &req.params;
        let thread = params.get("threadId").and_then(Value::as_str);
        let value = match req.method.as_str() {
            "plugins/pluginsStatus" => {
                let status = self.status().await?;
                let cwd = self.host.current_cwd(thread).await.map_err(|e| domain_error("config", e))?;
                decorate_plugins(&status, &self.scopes(), &cwd)
            }
            "plugins/reloadPlugins" => {
                self.host.reconcile_plugins_and_announce().await;
                self.status().await?
            }
            "plugins/addPlugin" => self.add_plugin(params, thread).await?,
            "plugins/updatePlugin" => self.update_plugin(params, thread).await?,
            "plugins/setPluginEnabled" => self.set_plugin_enabled(params, thread).await?,
            "plugins/removePlugin" => self.remove_plugin(params, thread).await?,
            "config/setExtensionScope" => self.set_extension_scope(params, thread).await?,
            other => {
                return Err(CoreError::CapabilityUnavailable { capability: other.into(), detail: "not served by the plugins service".into() });
            }
        };
        Ok(Reply::Value(value))
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
