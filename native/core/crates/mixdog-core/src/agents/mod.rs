//! The agent definition loader: a port of Node's `runtime-core/workflow/agents.mjs` and the
//! read side of `workflow-agents-api/agent-editor.mjs` — the agent list (shipped plus user
//! definitions, starter order, defaults), each agent's route and kind, Mixy's route and
//! creation state, definition presence, the name an archived agent left, and the task
//! workspace. It is the one source `rooms::AgentCatalog` and the definition setup actions read.
//!
//! Every listing reads the folders afresh (Node's `listCustomAgentIds`); the shared scan cache
//! of its status pulse is a speed device and is not ported. Not ported either: the avatar of a
//! row (`normalizeAgentAvatar`), and preset-name routes in the config (`routeFromPreset`).

mod files;
#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::normalize_workflow_route;
use mixdog_core_api::CoreError;
use mixdog_rt::InteractiveIo;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

pub use self::files::AgentDefinition;
pub use self::files::DELETED_MARKER;
use self::files::FIXED_SLOTS;
use self::files::Folders;
use self::files::LEAD_ID;
use self::files::STARTERS;
use self::files::Lane;
use crate::config::AgentRoutes;
use crate::config::ConfigError;
use crate::config::RouteHome;
use crate::domains::ai_admin::hidden_agents::hidden_agents;
use crate::domains::support::on_lane;
use crate::rooms::RoomError;
use crate::rooms::home::Presence;
use crate::rooms::service::KnownAgent;
use crate::rooms::sessions::AgentCatalog;

#[derive(Debug, thiserror::Error)]
pub enum AgentsError {
    #[error("{0}")]
    Lane(CoreError),
    #[error("{0}")]
    Config(#[from] ConfigError),
    /// The routines of Mixy could not be read.
    #[error("{0}")]
    Evidence(String),
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

/// One row of the agent catalog (`listAgents`), without the avatar.
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
    pub definition: Option<AgentDefinition>,
}

/// `getLeadStatus`, without the avatar.
#[derive(Clone, Debug, PartialEq)]
pub struct LeadStatus {
    /// Mixy's `created` flag: `None` until decided.
    pub created: Option<bool>,
    pub name: String,
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
        Self { folders, lane, routes, evidence, main_route, task_workspace: task_workspace.into() }
    }

    async fn job<R: Send + 'static>(&self, work: impl FnOnce(&Folders, &Lane) -> R + Send + 'static) -> Result<R, AgentsError> {
        let folders = self.folders.clone();
        on_lane(self.lane, &CancellationToken::new(), move |lane| work(&folders, lane)).await.map_err(AgentsError::Lane)
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

    /// `hasUserAgentFile`.
    pub async fn has_user_file(&self, id: &str) -> Result<bool, AgentsError> {
        let id = id.to_owned();
        self.job(move |folders, lane| folders.has_user_file(lane, &id)).await
    }

    /// The agent's own route (`ownRoute`), `None` when it has none.
    async fn own_route(&self, id: &str) -> Result<Option<Value>, AgentsError> {
        let route = self.routes.own_route(id).await?;
        if route.as_object().is_none_or(|map| map.is_empty()) {
            return Ok(None);
        }
        // A config route passes `normalizeWorkflowRoute`; a bot's own route is read as stored.
        if self.routes.home(id).await? == RouteHome::Config {
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
        let id = agent_id.to_owned();
        self.job(move |folders, lane| folders.archived_name(lane, &id)).await
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
        let (created, name) = self
            .job(|folders, lane| {
                let manifest = files::manifest_of(&folders.identity_dir(lane));
                let legacy = files::manifest_of(&folders.data.join("agents").join(LEAD_ID));
                let created = manifest.get("created").and_then(Value::as_bool).or_else(|| legacy.get("created").and_then(Value::as_bool));
                (created, crate::workflow::ids::one_line(manifest.get("name")))
            })
            .await?;
        Ok(LeadStatus { created, name, home_chatted: self.evidence.home_chatted(LEAD_ID).await, route: self.mixy_route().await? })
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
fn is_contact(id: &str, kind: Option<&str>) -> bool {
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
