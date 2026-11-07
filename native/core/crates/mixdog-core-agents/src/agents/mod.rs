//! The agent definition loader: a port of Node's `runtime-core/workflow/agents.mjs` and the
//! read side of `workflow-agents-api/agent-editor.mjs` — the agent list (shipped plus user
//! definitions, starter order, defaults), each agent's route and kind, Mixy's route and
//! creation state, definition presence, the name an archived agent left, and the task
//! workspace. It is the one source `rooms::AgentCatalog` and the definition setup actions read.
//!
//! Every listing reads the folders afresh (Node's `listCustomAgentIds`); the shared scan cache
//! of its status pulse is a speed device and is not ported.

mod avatar;
mod catalog_json;
mod connector_api;
mod connectors;
mod contact_ids;
mod edit;
mod files;
mod lead;
mod lead_service;
pub mod home_agent;
mod home_api;
mod permissions;
mod pool_list;
mod service;
#[cfg(test)]
mod api_tests;
#[cfg(test)]
mod lead_twin_tests;
#[cfg(test)]
mod home_api_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
pub(crate) mod tests;

pub use connector_api::AgentConnectors;
pub use connector_api::ConnectorCatalog;
pub use connector_api::McpConnectors;
pub use contact_ids::ContactIds;
pub use lead::LeadAppearance;
pub use lead_service::LEAD_METHODS;
pub use lead_service::LeadService;
pub use home_api::{AgentHomeService, AgentHomeSessions, AgentMemoryHost, DepError, HOME_METHODS, HomeDeps, MemoryRuntime};
pub use permissions::AgentPermissions;
pub use pool_list::{AgentPool, HEADER_FIELDS, PoolError, PoolLive, PoolStore, RuntimeEntry};
pub use service::AgentService;
pub use service::METHODS as AGENT_METHODS;

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::normalize_workflow_route;
use mixdog_core_api::CoreError;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

pub use self::connectors::ApprovedToolChange;
pub use self::connectors::NO_WIDEN;
pub use self::connectors::Parsed;
pub use self::connectors::Stored;
use mixdog_mcp::permissions::read_raw_policy;
pub use self::files::AgentDefinition;
pub use self::files::ArchivedIdentity;
pub use self::files::DELETED_MARKER;
use self::files::FIXED_SLOTS;
use self::files::Folders;
use self::files::LEAD_ID;
use self::files::STARTERS;
use self::files::Lane;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::ConfigError;
use mixdog_core_config::config::RouteHome;
use mixdog_core_config::config::agent_routes::agent_editor_id;
use mixdog_core_config::config::hidden_agents::hidden_agents;
use mixdog_core_base::support::on_lane;
use mixdog_core_rooms::rooms::RoomError;
use mixdog_core_rooms::rooms::home::Presence;
use mixdog_core_rooms::rooms::service::KnownAgent;
use mixdog_core_rooms::rooms::sessions::AgentCatalog;

#[derive(Debug, thiserror::Error)]
pub enum AgentsError {
    #[error("{0}")]
    Lane(CoreError),
    #[error("{0}")]
    Config(#[from] ConfigError),
    /// The routines of Mixy could not be read.
    #[error("{0}")]
    Evidence(String),
    /// Node's `throw new Error(..)` of the editor: the text is Node's.
    #[error("{0}")]
    Refused(String),
}

/// What a change of the definitions sets going outside the files.
#[async_trait]
pub trait AgentEffects: Send + Sync {
    /// `announceBotChange`: every runtime takes the saved, archived or restored agent from its
    /// next turn (`publishAgentProfileChange`).
    async fn agents_changed(&self);
    /// `reloadRoutines`: re-arms the one-shots that came due while an agent was archived; the
    /// message of a failure.
    async fn reload_routines(&self) -> Result<(), String>;
    /// `setAgentRoute(id, route)`: the route a save carries goes through the route setter
    /// (validation, publishing); the message of a failure.
    async fn set_agent_route(&self, agent_id: &str, route: &Value) -> Result<(), String>;
    /// `deleteOwnedRoutines(agentId)`: a bot deleted for good takes its schedules and webhooks
    /// (the channels reload drops their jobs and endpoints); the names removed, or the message
    /// of a failure.
    async fn delete_owned_routines(&self, agent_id: &str) -> Result<OwnedRoutines, String>;
}

/// The schedules and webhooks a purge took with the agent that owned them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OwnedRoutines {
    pub schedules: Vec<String>,
    pub webhooks: Vec<String>,
}

/// `saveAgentDefinition`'s `options`.
#[derive(Clone, Debug, Default)]
pub struct SaveOptions {
    /// For a remote client: the connector policy may not give any tool more authority.
    pub no_widen: bool,
    /// Inside `withApprovedConnectorToolChange`: with `no_widen`, only this change may widen.
    pub approved: Option<ApprovedToolChange>,
}

/// The write side: where it runs and what a change sets going.
#[derive(Clone)]
struct Writes {
    lane: DurabilityIo,
    effects: Arc<dyn AgentEffects>,
    /// `new Date().toISOString()`: names the backup folder of an absorbed save.
    now: Arc<dyn Fn() -> String + Send + Sync>,
}

/// One id's saves, archives and restores run one at a time (`withLifecycle`); each rechecks its
/// eligibility when its turn comes.
async fn lifecycle(data: &std::path::Path, id: &str) -> Option<mixdog_rt::ChainGuard> {
    static TURNS: std::sync::OnceLock<Arc<mixdog_rt::KeyedChains>> = std::sync::OnceLock::new();
    if id.is_empty() {
        return None;
    }
    let key = format!("{}\0{id}", data.display());
    Some(TURNS.get_or_init(mixdog_rt::KeyedChains::new).acquire(&key).await)
}
/// What only the sessions and the automation store know.
#[async_trait]
pub trait AgentEvidence: Send + Sync {
    /// The agent's home thread holds the creation greeting (`homeThreadEvidence(..).greeted`).
    async fn home_greeted(&self, agent_id: &str) -> bool;
    /// The user wrote in the agent's home thread (`homeThreadEvidence(..).chatted`).
    async fn home_chatted(&self, agent_id: &str) -> bool;
    /// A schedule or webhook belongs to Mixy (`mixyOwnsRoutines`); an error when they cannot be
    /// read.
    async fn mixy_owns_routines(&self) -> Result<bool, String>;
}

/// One row of the agent catalog (`listAgents`).
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRow {
    pub id: String,
    /// The definition's name, else the id (the fixed services keep their own label).
    pub label: String,
    pub description: String,
    /// A fixed service (`locked`), not a custom agent.
    pub fixed: bool,
    pub user_override: bool,
    /// The route it runs on: its own, else Main's; `Null` when neither names a model.
    pub route: Value,
    /// It has a route of its own.
    pub route_configured: bool,
    pub kind: Option<String>,
    pub disabled: bool,
    /// The normalised avatar; `Null` without one.
    pub avatar: Value,
    pub definition: Option<AgentDefinition>,
}

/// `getLeadStatus`.
#[derive(Clone, Debug, PartialEq)]
pub struct LeadStatus {
    /// Mixy's `created` flag: `None` until decided.
    pub created: Option<bool>,
    pub name: String,
    /// Her normalised avatar; `Null` without one.
    pub avatar: Value,
    pub home_chatted: bool,
    /// Mixy's own route.
    pub route: Option<Value>,
}

#[derive(Clone)]
pub struct AgentDefinitions {
    folders: Folders,
    lane: InteractiveIo,
    routes: AgentRoutes,
    evidence: Arc<dyn AgentEvidence>,
    /// `resolveRoute(config, {})`: the live Main route; this port normalises it.
    main_route: Arc<dyn Fn() -> Value + Send + Sync>,
    task_workspace: PathBuf,
    writes: Option<Writes>,
}

impl AgentDefinitions {
    /// `shipped_root` holds the shipped `agents/`; `data_dir` the user's `agents/` and `bots/`;
    /// `task_workspace` is the folder task sessions run in (`<userData>/workspace/unclassified`).
    pub fn new(
        shipped_root: impl Into<PathBuf>,
        data_dir: impl Into<PathBuf>,
        lane: InteractiveIo,
        routes: AgentRoutes,
        evidence: Arc<dyn AgentEvidence>,
        main_route: Arc<dyn Fn() -> Value + Send + Sync>,
        task_workspace: impl Into<PathBuf>,
    ) -> Self {
        let folders = Folders { shipped: shipped_root.into(), data: data_dir.into(), hidden: Arc::new(hidden_agents()) };
        Self { folders, lane, routes, evidence, main_route, task_workspace: task_workspace.into(), writes: None }
    }

    /// Lets the definitions be saved, archived and restored; without it they only read.
    #[must_use]
    pub fn with_writes(mut self, lane: DurabilityIo, effects: Arc<dyn AgentEffects>, now: Arc<dyn Fn() -> String + Send + Sync>) -> Self {
        self.writes = Some(Writes { lane, effects, now });
        self
    }

    fn writes(&self) -> Result<Writes, AgentsError> {
        self.writes.clone().ok_or_else(|| AgentsError::Refused("agent definitions cannot be changed here".into()))
    }

    /// Runs the file writes as a lane job that holds the id's `turn` until the IO has finished,
    /// even if the caller stops waiting: a job already running is not stopped by that, and the
    /// next change of the id must not start beside it. The turn comes back with the result, for
    /// the steps that follow.
    async fn write_job<R: Send + 'static>(
        &self,
        writes: &Writes,
        turn: Option<mixdog_rt::ChainGuard>,
        work: impl FnOnce(&Folders, &mixdog_rt::InLane<DurabilityIo>) -> R + Send + 'static,
    ) -> Result<(R, Option<mixdog_rt::ChainGuard>), AgentsError> {
        let folders = self.folders.clone();
        on_lane(writes.lane, &CancellationToken::new(), move |lane| (work(&folders, lane), turn)).await.map_err(AgentsError::Lane)
    }

    /// `getAgentDefinition`: the definition as the editor shows it.
    pub async fn get(&self, agent_id: &str) -> Result<Value, AgentsError> {
        let folders = self.folders.clone();
        let id = edit::view_id(&folders, agent_id).map_err(AgentsError::Refused)?;
        let Some(definition) = self.load(&id).await? else {
            return Err(AgentsError::Refused(format!("agent \"{agent_id}\" not found")));
        };
        let wanted = id.clone();
        let facts = self.job(move |folders, lane| edit::view_facts(folders, lane, &wanted)).await?;
        let own = self.own_route(&id).await?;
        let mut view = Map::new();
        let mut put = |key: &str, value: Value| {
            view.insert(key.into(), value);
        };
        put("id", json!(id));
        put("name", json!(definition.name));
        put("description", json!(definition.description));
        put("body", json!(definition.body));
        put("custom", json!(!FIXED_SLOTS.iter().any(|slot| slot.0 == id)));
        put("userOverride", json!(facts.user_override));
        if let Some(path) = &facts.path {
            put("path", json!(path));
        }
        put("route", own.clone().or_else(|| self.main()).unwrap_or(Value::Null));
        put("routeConfigured", json!(own.is_some()));
        put("kind", json!(definition.kind));
        put("disabled", json!(self.routes.is_disabled(&id)));
        put("avatar", facts.avatar);
        put("persona", json!(facts.persona));
        put("revision", json!(facts.revision));
        Ok(Value::Object(view))
    }

    /// `saveAgentDefinition(payload)`.
    pub async fn save(&self, payload: &Map<String, Value>) -> Result<Value, AgentsError> {
        self.save_with(payload, SaveOptions::default()).await
    }

    /// `saveAgentDefinition(payload, options)`: creates or edits one agent. The payload takes
    /// `id`, `name`, `description`, `body`, `kind` (only when creating: `bot` or `agent`),
    /// `persona`, `avatar`, `connectors`, `expectedRevision` and `route`.
    pub async fn save_with(&self, payload: &Map<String, Value>, options: SaveOptions) -> Result<Value, AgentsError> {
        let writes = self.writes()?;
        if !mixdog_core_config::workflow::ids::truthy(payload.get("body")) || mixdog_js::js_trim(&mixdog_core_config::workflow::ids::js_string(&payload["body"])).is_empty() {
            return Err(AgentsError::Refused("AGENT.md body must not be empty".into()));
        }
        let planned = payload.clone();
        let target = self.job(move |folders, lane| edit::plan_save(folders, lane, &planned, None)).await?.map_err(AgentsError::Refused)?;
        let turn = lifecycle(&self.folders.data, &target.id).await;
        self.save_on_turn(&writes, payload, options, &target.id, turn).await
    }

    /// `saveLocked`: the save of agent `id` on its own turn of the lifecycle queue.
    async fn save_on_turn(
        &self,
        writes: &Writes,
        payload: &Map<String, Value>,
        options: SaveOptions,
        id: &str,
        turn: Option<mixdog_rt::ChainGuard>,
    ) -> Result<Value, AgentsError> {
        // The id is fixed before queuing (`resolveSaveTarget`); on its turn what a change ahead
        // left is what is saved over.
        let (planned, now, fixed) = (payload.clone(), writes.now.clone(), id.to_owned());
        let plan = self.job(move |folders, lane| edit::plan_save(folders, lane, &planned, Some(&fixed))).await?.map_err(AgentsError::Refused)?;
        let (given, id) = (payload.clone(), plan.id.clone());
        let (done, _turn) = self
            .write_job(writes, turn, move |folders, lane| edit::save_files(folders, lane, &plan, &given, options.no_widen.then_some(options.approved.as_ref()), &*now))
            .await?;
        let done = done.map_err(AgentsError::Refused)?;
        if done.reclaimed {
            // Made anew under an archived agent's id: no stale route or switch-off carries over.
            self.routes.set_disabled(&id, false).await?;
            self.routes.clear_route(&id).await?;
        } else if !done.existed && self.routes.is_disabled(&id) {
            self.routes.start_enabled(&id).await?;
        }
        if let Some(route) = payload.get("route").filter(|route| mixdog_core_config::workflow::ids::truthy(Some(route))) {
            writes.effects.set_agent_route(&id, route).await.map_err(AgentsError::Refused)?;
        }
        writes.effects.agents_changed().await;
        self.get(&id).await
    }

    /// `deleteAgentDefinition(agentId)`: a built-in override is reset; a custom agent is archived
    /// with its chat and routines.
    pub async fn delete(&self, agent_id: &str) -> Result<Value, AgentsError> {
        let writes = self.writes()?;
        let turn = lifecycle(&self.folders.data, &agent_editor_id(agent_id)).await;
        let wanted = agent_id.to_owned();
        let plan = self.job(move |folders, lane| edit::plan_delete(folders, lane, &wanted)).await?.map_err(AgentsError::Refused)?;
        let id = plan.id.clone();
        let (deleted, _turn) = self.write_job(&writes, turn, move |_, lane| edit::delete_files(lane, &plan)).await?;
        deleted.map_err(AgentsError::Refused)?;
        let reverted = FIXED_SLOTS.iter().any(|slot| slot.0 == id) && self.load(&id).await?.is_some();
        writes.effects.agents_changed().await;
        Ok(json!({ "id": id, "deleted": true, "revertedToBuiltIn": reverted }))
    }

    /// `restoreAgentDefinition(agentId)`: an archived agent back as it was.
    pub async fn restore(&self, agent_id: &str) -> Result<Value, AgentsError> {
        let writes = self.writes()?;
        let turn = lifecycle(&self.folders.data, &agent_editor_id(agent_id)).await;
        let wanted = agent_id.to_owned();
        let plan = self.job(move |folders, lane| edit::plan_restore(folders, lane, &wanted)).await?.map_err(AgentsError::Refused)?;
        let id = plan.id.clone();
        let (restored, _turn) = self.write_job(&writes, turn, move |_, _| edit::restore_files(&plan)).await?;
        restored.map_err(AgentsError::Refused)?;
        writes.effects.agents_changed().await;
        if let Err(message) = writes.effects.reload_routines().await {
            return Err(AgentsError::Refused(format!(
                "agent \"{id}\" was restored, but its schedules could not be re-armed ({message}); they are re-armed by the next schedule reload or restart"
            )));
        }
        self.get(&id).await
    }

    /// `purgeAgentDefinition(agentId)`: deleting an archived agent again. Everything it left goes
    /// for good, its schedules and webhooks first: a failure there ends the purge with the agent
    /// still archived and nothing lost, to be retried.
    pub async fn purge(&self, agent_id: &str) -> Result<Value, AgentsError> {
        let writes = self.writes()?;
        let turn = lifecycle(&self.folders.data, &agent_editor_id(agent_id)).await;
        let wanted = agent_id.to_owned();
        let plan = self.job(move |folders, lane| edit::plan_purge(folders, lane, &wanted)).await?.map_err(AgentsError::Refused)?;
        let id = plan.id.clone();
        let begun = plan.clone();
        // The marker goes down before the first await: a restore from here on is refused, and a
        // crash before the folder is removed leaves a purge to finish.
        let (begin, turn) = self.write_job(&writes, turn, move |_, lane| edit::purge_begin(lane, &begun)).await?;
        if !begin.map_err(AgentsError::Refused)? {
            return Ok(json!({ "id": id, "purged": false }));
        }
        let routines = writes.effects.delete_owned_routines(&id).await.map_err(AgentsError::Refused)?;
        let removing = plan.clone();
        let (removed, turn) = self.write_job(&writes, turn, move |_, _| edit::purge_remove(&removing)).await?;
        removed.map_err(AgentsError::Refused)?;
        // `dropAgentRoute`: no dangling route or switch-off may silently disable a later agent of
        // the same id.
        self.routes.set_disabled(&id, false).await?;
        self.routes.clear_route(&id).await?;
        let wanted = id.clone();
        let mut turn = turn;
        if self.job(move |folders, lane| folders.load(lane, &wanted).is_some()).await? {
            // A starter keeps only its tombstone, so its packaged copy stays gone.
            let tombstone = plan.clone();
            let (written, held) = self.write_job(&writes, turn, move |_, lane| edit::purge_tombstone(lane, &tombstone)).await?;
            written.map_err(AgentsError::Refused)?;
            turn = held;
        }
        // A save that passed its owner check before the bot was archived can land after the first
        // sweep: swept again now that the bot is gone.
        let late = writes.effects.delete_owned_routines(&id).await;
        drop(turn);
        let swept = late.as_ref().ok();
        let joined = |first: &[String], second: Option<&Vec<String>>| -> Vec<String> {
            first.iter().chain(second.into_iter().flatten()).cloned().collect()
        };
        let schedules = joined(&routines.schedules, swept.map(|late| &late.schedules));
        let webhooks = joined(&routines.webhooks, swept.map(|late| &late.webhooks));
        let mut out = Map::new();
        out.insert("id".into(), json!(id));
        out.insert("purged".into(), json!(true));
        if schedules.len() + webhooks.len() > 0 {
            out.insert("routines".into(), json!({ "schedules": schedules, "webhooks": webhooks }));
        }
        if let Err(message) = late {
            out.insert("routinesError".into(), json!(message));
        }
        Ok(Value::Object(out))
    }

    /// `getAgentAvatarImage(agentId)`: a custom avatar's images as data URLs by state, `Null`
    /// without one.
    pub async fn avatar_image(&self, agent_id: &str) -> Result<Value, AgentsError> {
        let id = agent_id.to_owned();
        self.job(move |folders, lane| edit::avatar_images(folders, lane, &id)).await
    }

    /// `getAgentConnectorPolicy(agentId)`: the policy as the runtime reads it; a broken file or
    /// field is [`Stored::DenyAll`], never "every connector".
    pub async fn connector_policy(&self, agent_id: &str) -> Result<Stored, AgentsError> {
        let writes = self.writes()?;
        let (wanted, label) = (agent_id.to_owned(), agent_id.to_owned());
        let file = self
            .job(move |folders, lane| -> Result<PathBuf, String> {
                let id = edit::view_id(folders, &wanted)?;
                if id == LEAD_ID {
                    return Ok(folders.identity_dir(lane).join("agent.json"));
                }
                if folders.load(lane, &id).is_none() {
                    return Err(format!("agent \"{label}\" not found"));
                }
                // The manifest in effect: the user's own copy if any, else the shipped one.
                let dir = if folders.has_user_file(lane, &id) { folders.user_dir(lane, &id) } else { folders.shipped_dir(&id) };
                Ok(dir.join("agent.json"))
            })
            .await?
            .map_err(AgentsError::Refused)?;
        let (raw, _) = self.write_job(&writes, None, move |_, lane| read_raw_policy(lane, &file)).await?;
        Ok(Stored::of_raw(raw))
    }

    /// `updateAgentConnectorPolicy(agentId, derive)`: a read-modify-write of the policy as one turn
    /// of the id's lifecycle queue, like every other writer of its definition. `derive` sees the
    /// policy as stored when that turn comes and may refuse; what it returns is stored (`Null`
    /// removes the policy). Every other key — avatar, persona, frontmatter — is kept; for Mixy only
    /// her `agent.json` is touched. Answers the policy after the write.
    pub async fn update_connector_policy(
        &self,
        agent_id: &str,
        derive: impl FnOnce(&Stored) -> Result<Value, String> + Send,
    ) -> Result<Stored, AgentsError> {
        self.update_connector_policy_with(agent_id, async { Ok(()) }, move |stored, ()| derive(stored)).await
    }

    /// [`Self::update_connector_policy`] with `snapshot`, a read of the world (the installed
    /// connectors) taken once the edit's turn has come, so that `derive` judges a state no later
    /// than the stored policy it edits.
    pub async fn update_connector_policy_with<S>(
        &self,
        agent_id: &str,
        snapshot: impl Future<Output = Result<S, String>> + Send,
        derive: impl FnOnce(&Stored, S) -> Result<Value, String> + Send,
    ) -> Result<Stored, AgentsError> {
        let writes = self.writes()?;
        let id = agent_editor_id(agent_id);
        if id.is_empty() {
            return Err(AgentsError::Refused(format!("unknown agent \"{agent_id}\"")));
        }
        let turn = lifecycle(&self.folders.data, &id).await;
        let seen = snapshot.await.map_err(AgentsError::Refused)?;
        let current = self.connector_policy(&id).await?;
        let next = connectors::policy_input(&derive(&current, seen).map_err(AgentsError::Refused)?).map_err(AgentsError::Refused)?;
        let wanted = id.clone();
        let file = self
            .job(move |folders, lane| {
                let dir = if wanted == LEAD_ID { folders.identity_dir(lane) } else { folders.user_dir(lane, &wanted) };
                dir.join("agent.json")
            })
            .await?;
        edit::assert_writable(&file).map_err(AgentsError::Refused)?;
        if id == LEAD_ID {
            let dir = file.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
            let (done, _turn) = self.write_job(&writes, turn, move |_, lane| edit::set_lead_connectors(lane, &dir, next)).await?;
            done.map_err(AgentsError::Refused)?;
        } else {
            let Some(definition) = self.load(&id).await? else {
                return Err(AgentsError::Refused(format!("agent \"{id}\" not found")));
            };
            if mixdog_js::js_trim(&definition.body).is_empty() {
                return Err(AgentsError::Refused("AGENT.md body must not be empty".into()));
            }
            let mut payload = Map::new();
            payload.insert("id".into(), json!(id));
            payload.insert("name".into(), json!(definition.name));
            payload.insert("description".into(), json!(definition.description));
            payload.insert("body".into(), json!(definition.body));
            payload.insert("connectors".into(), next.unwrap_or(Value::Null));
            self.save_on_turn(&writes, &payload, SaveOptions::default(), &id, turn).await?;
        }
        self.connector_policy(&id).await
    }

    async fn job<R: Send + 'static>(&self, work: impl FnOnce(&Folders, &Lane) -> R + Send + 'static) -> Result<R, AgentsError> {
        let folders = self.folders.clone();
        on_lane(self.lane, &CancellationToken::new(), move |lane| work(&folders, lane)).await.map_err(AgentsError::Lane)
    }

    /// `isHiddenAgent(name)`: whether `name` is an internal agent of `defaults/agents.json`.
    /// Answered from the loaded set, so it needs no lane job.
    pub fn hidden_agent(&self, name: Option<&str>) -> bool {
        name.is_some_and(|name| self.folders.hidden.contains(name))
    }

    /// `listCustomAgentIds`.
    pub async fn custom_agent_ids(&self) -> Result<Vec<String>, AgentsError> {
        self.job(|folders, lane| folders.custom_ids(lane)).await
    }

    /// `delegatableAgentIds`: on disk, not a built-in service, not switched off.
    pub async fn delegatable_agent_ids(&self) -> Result<Vec<String>, AgentsError> {
        let ids = self.custom_agent_ids().await?;
        Ok(ids.into_iter().filter(|id| !FIXED_SLOTS.iter().any(|slot| slot.0 == id) && !self.routes.is_disabled(id)).collect())
    }

    /// `loadAgentDefinition`.
    pub async fn load(&self, id: &str) -> Result<Option<AgentDefinition>, AgentsError> {
        let id = id.to_owned();
        let Some(mut loaded) = self.job(move |folders, lane| folders.load(lane, &id)).await? else {
            return Ok(None);
        };
        if loaded.unmarked && self.evidence.home_greeted(&loaded.definition.id).await {
            loaded.definition.kind = Some("bot".into());
        }
        Ok(Some(loaded.definition))
    }

    async fn avatar_of(&self, id: &str) -> Result<Value, AgentsError> {
        let id = id.to_owned();
        self.job(move |folders, lane| folders.avatar_of(lane, &id)).await
    }

    /// `readAgentFirstResponseTimeoutMs(id)`: the definition's own first-response deadline, read
    /// afresh (Node caches it for the 5 s front matter TTL; a run reads it once, at its start).
    pub async fn first_response_timeout_ms(&self, id: &str) -> Result<Option<i64>, AgentsError> {
        let id = id.to_owned();
        self.job(move |folders, lane| folders.first_response_timeout_ms(lane, &id)).await
    }

    /// `readAgentDefinitionKind(id)`: the kind read afresh from the front matter alone (no body
    /// needed), with the home thread's greeting deciding an unmarked user copy.
    pub async fn definition_kind(&self, id: &str) -> Result<Option<String>, AgentsError> {
        let wanted = id.to_owned();
        let (kind, unmarked) = self.job(move |folders, lane| folders.kind_only(lane, &wanted)).await?;
        if unmarked && self.evidence.home_greeted(id).await {
            return Ok(Some("bot".into()));
        }
        Ok(kind)
    }

    /// `hasUserAgentFile`.
    pub async fn has_user_file(&self, id: &str) -> Result<bool, AgentsError> {
        let id = id.to_owned();
        self.job(move |folders, lane| folders.has_user_file(lane, &id)).await
    }

    /// The agent's own route (`ownRoute`), `None` when it has none.
    async fn own_route(&self, id: &str) -> Result<Option<Value>, AgentsError> {
        // The editor's `ownRoute`: a store bot's own route, else the config's. Mixy's id `lead`
        // is no store bot there, so it reads the config.
        let route = if id == LEAD_ID {
            // A store bot of that id keeps its route in its folder, as any other bot.
            let bot = self.job(|folders, lane| files::store_bot_route(folders, lane, LEAD_ID)).await?;
            match bot {
                Some(route) => route.unwrap_or_else(|| json!({})),
                None => self.routes.config_route(id).unwrap_or_else(|| json!({})),
            }
        } else {
            if self.routes.home(id).await? == RouteHome::Config {
                // `agentRouteFromConfig`: a stored preset name resolves too.
                return Ok(self.routes.config_route(id));
            }
            self.routes.own_route(id).await?
        };
        if route.as_object().is_none_or(|map| map.is_empty()) {
            return Ok(None);
        }
        // A config route passes `normalizeWorkflowRoute`; a bot's own route is read as stored.
        if id == LEAD_ID || self.routes.home(id).await? == RouteHome::Config {
            return Ok(normalize_workflow_route(&route, &json!({}), false).ok().flatten());
        }
        Ok(Some(route))
    }

    /// `normalizeWorkflowRoute(resolveRoute(config, {}))`: Main's route, `None` without one.
    fn main(&self) -> Option<Value> {
        normalize_workflow_route(&(self.main_route)(), &json!({}), false).ok().flatten()
    }

    /// `listAgents`: the fixed services, then every custom agent.
    pub async fn rows(&self) -> Result<Vec<AgentRow>, AgentsError> {
        let mut rows = Vec::new();
        for (id, label, description, _) in FIXED_SLOTS {
            let own = self.own_route(id).await?;
            rows.push(AgentRow {
                id: id.into(),
                label: label.into(),
                description: description.into(),
                fixed: true,
                user_override: self.has_user_file(id).await?,
                route_configured: own.is_some(),
                route: own.or_else(|| self.main()).unwrap_or(Value::Null),
                kind: None,
                disabled: self.routes.is_disabled(id),
                // The fixed services carry no avatar in the listing.
                avatar: Value::Null,
                definition: self.load(id).await?,
            });
        }
        for id in self.custom_agent_ids().await? {
            let definition = self.load(&id).await?;
            let own = self.own_route(&id).await?;
            rows.push(AgentRow {
                label: definition.as_ref().map(|d| d.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| id.clone()),
                description: definition.as_ref().map(|d| d.description.clone()).unwrap_or_default(),
                fixed: false,
                user_override: self.has_user_file(&id).await?,
                route_configured: own.is_some(),
                route: own.or_else(|| self.main()).unwrap_or(Value::Null),
                kind: definition.as_ref().and_then(|d| d.kind.clone()),
                disabled: self.routes.is_disabled(&id),
                avatar: self.avatar_of(&id).await?,
                definition,
                id,
            });
        }
        Ok(rows)
    }

    /// The contacts: `contactAgentRows(listAgents())` as the rooms need them.
    pub async fn contacts(&self) -> Result<Vec<KnownAgent>, AgentsError> {
        Ok(self
            .rows()
            .await?
            .into_iter()
            .filter(|row| !row.fixed && !row.disabled && is_contact(&row.id, row.kind.as_deref()))
            .map(|row| KnownAgent { id: row.id, route: row.route })
            .collect())
    }

    /// `definitionPresence`, per id (a repeated id answers once).
    pub async fn presence(&self, agent_ids: &[String]) -> Result<HashMap<String, Presence>, AgentsError> {
        let ids = agent_ids.to_vec();
        self.job(move |folders, lane| ids.into_iter().map(|id| (id.clone(), folders.presence(lane, &id))).collect()).await
    }

    /// `archivedIdentities(..)[id].name`: the name a deleted agent left, `None` when not archived.
    pub async fn archived_name(&self, agent_id: &str) -> Result<Option<String>, AgentsError> {
        Ok(self.archived_identity(agent_id).await?.map(|who| who.name))
    }

    /// `archivedIdentities(..)[id]`: the name and face a deleted agent left, `None` when not archived.
    pub async fn archived_identity(&self, agent_id: &str) -> Result<Option<ArchivedIdentity>, AgentsError> {
        let id = agent_id.to_owned();
        self.job(move |folders, lane| folders.archived_identity(lane, &id)).await
    }

    /// Mixy's own route (`readMixyRoute`), `None` when she has none.
    pub async fn mixy_route(&self) -> Result<Option<Value>, AgentsError> {
        let route = self.routes.own_route(LEAD_ID).await?;
        Ok(route.as_object().is_some_and(|map| !map.is_empty()).then_some(route))
    }

    /// `getLeadHomeRoute`: her own route, else Main's; `Null` when neither is set.
    pub async fn mixy_home_route(&self) -> Result<Value, AgentsError> {
        Ok(self.mixy_route().await?.or_else(|| self.main()).unwrap_or(Value::Null))
    }

    /// `getLeadStatus`.
    pub async fn lead_status(&self) -> Result<LeadStatus, AgentsError> {
        let (created, name, avatar) = self
            .job(|folders, lane| {
                let manifest = files::manifest_of(&folders.identity_dir(lane));
                let legacy = files::manifest_of(&folders.data.join("agents").join(LEAD_ID));
                let created = manifest.get("created").and_then(Value::as_bool).or_else(|| legacy.get("created").and_then(Value::as_bool));
                (created, mixdog_core_config::workflow::ids::one_line(manifest.get("name")), manifest.get("avatar").and_then(avatar::normalize_agent_avatar).unwrap_or(Value::Null))
            })
            .await?;
        Ok(LeadStatus { created, name, avatar, home_chatted: self.evidence.home_chatted(LEAD_ID).await, route: self.mixy_route().await? })
    }

    /// Whether Mixy exists (`mixyExists`, the one rule): `created: false` is no; a name or a
    /// message the user wrote in her thread is yes; otherwise a routine she owns.
    pub async fn mixy_exists(&self) -> Result<bool, AgentsError> {
        let status = self.lead_status().await?;
        if status.created == Some(false) {
            return Ok(false);
        }
        if !mixdog_js::js_trim(&status.name).is_empty() || status.home_chatted {
            return Ok(true);
        }
        self.evidence.mixy_owns_routines().await.map_err(AgentsError::Evidence)
    }

    /// The task workspace (`SessionHost.taskWorkspace`): created if missing, as its real path.
    #[allow(clippy::disallowed_methods, reason = "the closure is a lane job body")]
    pub async fn task_workspace(&self) -> Result<String, AgentsError> {
        let path = self.task_workspace.clone();
        let made = on_lane(self.lane, &CancellationToken::new(), move |_| {
            std::fs::create_dir_all(&path).and_then(|()| std::fs::canonicalize(&path))
        })
        .await
        .map_err(AgentsError::Lane)?;
        let path = made.map_err(|error| AgentsError::Evidence(error.to_string()))?;
        Ok(display_path(&path))
    }
}

/// A real path as Node's `realpath` prints it: the Windows verbatim prefix goes.
fn display_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_owned(),
        _ => text.into_owned(),
    }
}

/// `isContactAgentId(id, kind)`: a user-made agent marked `kind: bot`, never Mixy nor a shipped
/// role.
pub(crate) fn is_contact(id: &str, kind: Option<&str>) -> bool {
    let id = mixdog_js::js_trim(id).to_lowercase();
    let roster: HashSet<&str> = STARTERS.iter().copied().chain(FIXED_SLOTS.iter().map(|slot| slot.0)).collect();
    !id.is_empty()
        && id != LEAD_ID
        && !roster.contains(id.as_str())
        && kind.is_some_and(|kind| mixdog_js::js_trim(kind).to_lowercase() == "bot")
}

fn port(error: AgentsError) -> RoomError {
    RoomError::Port(error.to_string())
}

#[async_trait]
impl AgentCatalog for AgentDefinitions {
    async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
        self.contacts().await.map_err(port)
    }

    async fn mixy_route(&self) -> Value {
        self.mixy_home_route().await.unwrap_or(Value::Null)
    }

    /// Whether Mixy exists; an unreadable status answers no.
    async fn mixy_created(&self) -> bool {
        self.mixy_exists().await.unwrap_or(false)
    }

    async fn presence(&self, agent_ids: &[String]) -> Result<HashMap<String, Presence>, RoomError> {
        AgentDefinitions::presence(self, agent_ids).await.map_err(port)
    }

    async fn archived_name(&self, agent_id: &str) -> String {
        AgentDefinitions::archived_name(self, agent_id).await.ok().flatten().unwrap_or_default()
    }

    async fn task_workspace(&self) -> String {
        AgentDefinitions::task_workspace(self).await.unwrap_or_else(|_| display_path(&self.task_workspace))
    }
}
