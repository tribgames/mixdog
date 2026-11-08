//! The agent home, memory and pool methods of `agent/`: `agent/home/open`, `agent/home/reset`,
//! `agent/memory/list`, `agent/memory/delete` and `agent/pool/list`.
//!
//! Each answers what Node's host code answers: the home flow of `agent-home-sessions.ts`
//! (`createAgentHomeSessions` `open`/`reset`), the memory control calls of `agent-memory.ts`, the
//! IPC input rules of `ipc-sessions.ts` (`requiredString`, `requiredAgentMemoryEntry`) and the pool
//! of [`super::pool_list`]. A Node `Error` reaches the caller as a domain error carrying its message.
//! The service claims exactly [`HOME_METHODS`]; the definitions and lead methods belong to the
//! services that own them.
//!
//! Open and reset of one agent share a single in-flight result, errors included, as Node's
//! `opening` map of promises does: an open that finds a flight joins it, a reset queues behind the
//! flight it finds (ignoring how it ended) and becomes the flight later calls join.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_rooms::rooms::home::Presence;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_js::JsRegex;
use mixdog_js::json_number;
use mixdog_js::json_parse;
use mixdog_js::js_trim;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::is_contact;
use super::pool_list::AgentPool;

const DOMAIN: &str = "agent";
const PAGE_SIZE: u64 = 100;
const SESSION_NOT_AVAILABLE_CODE: &str = "SESSION_NOT_AVAILABLE";

pub const HOME_METHODS: &[&str] = &["agent/home/open", "agent/home/reset", "agent/memory/list", "agent/memory/delete", "agent/pool/list"];

/// A failure of a dependency call: the `Error` Node's dependency rejected with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct DepError {
    pub message: String,
    /// `error.code`, when the error carried one.
    pub code: Option<String>,
}

impl DepError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None }
    }

    /// `isSessionMissingError(error)`: tagged, or worded as a missing session.
    fn session_missing(&self) -> bool {
        static MISSING: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"\bsession(?: \S+)? is not available\b", "i"));
        self.code.as_deref() == Some(SESSION_NOT_AVAILABLE_CODE) || MISSING.is_match(&self.message)
    }
}

/// What an agent home needs of its host (`AgentHomeDeps` of `agent-home-sessions.ts`, the part
/// `open` and `reset` use).
#[async_trait]
pub trait HomeDeps: Send + Sync {
    /// The agent catalog (`listAgents`).
    async fn list_agents(&self) -> Result<Value, DepError>;
    /// The route Mixy's thread follows (`getLeadHomeRoute`).
    async fn mixy_route(&self) -> Result<Value, DepError>;
    /// Whether the representative bot exists.
    async fn mixy_created(&self) -> Result<bool, DepError>;
    /// The session's snapshot; rejects with a session-missing error when it does not exist.
    async fn read_session(&self, session_id: &str) -> Result<Value, DepError>;
    async fn create_session(&self, session_id: &str, params: &Value) -> Result<(), DepError>;
    /// Select `route` for this thread alone from its next turn.
    async fn set_route(&self, session_id: &str, route: &Value) -> Result<(), DepError>;
    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), DepError>;
    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), DepError>;
    async fn task_workspace(&self) -> Result<String, DepError>;
    /// Clear `session_id` in place, its transcript first copied durably to `archive_as`; rejects
    /// while the session runs a turn.
    async fn clear_session(&self, session_id: &str, archive_as: &str) -> Result<(), DepError>;
    /// A fresh, unused session id for the archived copy.
    fn mint_archive_id(&self) -> String;
    /// The persisted record that a home was archived for its agent's deletion.
    async fn is_retired(&self, session_id: &str) -> Result<bool, DepError>;
    /// Title a retired home with its bot's last known name, so the archived chat lists under that
    /// name (a user's own name for it still wins).
    async fn name_retired(&self, session_id: &str, name: &str) -> Result<(), DepError>;
    /// The name a deleted (archived) agent left; empty when none.
    async fn archived_agent_name(&self, agent_id: &str) -> Result<String, DepError>;
    /// Every session id this host knows, blank and untitled ones included.
    async fn known_session_ids(&self) -> Result<Vec<String>, DepError>;
    /// Per-id definition presence from the files themselves; anything but `Deleted` keeps a thread.
    async fn agent_presence(&self, agent_ids: &[String]) -> Result<HashMap<String, Presence>, DepError>;
    /// An agent proven deleted leaves every room's members.
    async fn forget_room_member(&self, agent_id: &str) -> Result<(), DepError>;
}

/// The memory runtime as the host reaches it (`control('memoryControl', [args])`): the text it
/// replies with, or the message of the error it rejects with.
#[async_trait]
pub trait MemoryRuntime: Send + Sync {
    async fn memory_control(&self, args: Value) -> Result<String, String>;
}

/// `routeParams(route)`: the create-call route fields of an agent's catalog route.
pub fn route_params(route: &Value) -> Map<String, Value> {
    let leaf = route.as_array().map_or(route, |list| list.first().unwrap_or(&Value::Null));
    let text = |key: &str| leaf.get(key).and_then(Value::as_str).filter(|text| !text.is_empty());
    let (Some(provider), Some(model)) = (text("provider"), text("model")) else {
        return Map::new();
    };
    let mut out = Map::new();
    out.insert("provider".into(), json!(provider));
    out.insert("model".into(), json!(model));
    if let Some(effort) = text("effort") {
        out.insert("effort".into(), json!(effort));
    }
    if let Some(fast) = leaf.get("fast").filter(|value| value.is_boolean()) {
        out.insert("fast".into(), fast.clone());
    }
    if leaf.get("autoEffort") == Some(&Value::Bool(false)) {
        out.insert("autoEffort".into(), Value::Bool(false));
    }
    if let Some(parameters) = leaf.get("modelParameters").filter(|value| value.is_object() || value.is_array()) {
        out.insert("modelParameters".into(), parameters.clone());
    }
    out
}

/// `routeChange(definition, snapshot)`: the definition's route when the thread runs on another one.
fn route_changed(definition: &Map<String, Value>, snapshot: &Value) -> bool {
    if !truthy(definition.get("provider")) || !snapshot.is_object() {
        return false;
    }
    definition.get("provider") != snapshot.get("provider")
        || definition.get("model") != snapshot.get("model")
        || (definition.contains_key("effort") && definition.get("effort") != snapshot.get("effort"))
}

/// `contactAgentRows(agents)`: the catalog rows of the contacts, `custom`, not switched off, `kind: bot`.
pub(super) fn contact_rows(agents: &Value) -> impl Iterator<Item = &Value> {
    agents.as_array().into_iter().flatten().filter(|row| {
        let Some(row) = row.as_object() else { return false };
        row.get("custom") == Some(&Value::Bool(true))
            && row.get("disabled") != Some(&Value::Bool(true))
            && row.get("id").and_then(Value::as_str).is_some_and(|id| is_contact(id, row.get("kind").and_then(Value::as_str)))
    })
}

fn contact_row<'a>(agents: &'a Value, agent_id: &str) -> Option<&'a Value> {
    contact_rows(agents).find(|row| row.get("id").and_then(Value::as_str) == Some(agent_id))
}

fn type_error(message: &str) -> CoreError {
    failed(DOMAIN, message)
}

fn dep(error: DepError) -> CoreError {
    failed(DOMAIN, error.message)
}

/// What a flight settles with: the home's session id, and for a reset the archived copy's id.
type Outcome = Result<(String, Option<String>), CoreError>;

/// One shared in-flight result (a promise of Node's `opening` map).
type Flight = Shared<BoxFuture<'static, Outcome>>;

/// The flight each agent currently has, with the number that tells it from a later one.
#[derive(Default)]
struct Flights {
    next: u64,
    current: HashMap<String, (u64, Flight)>,
}

impl Flights {
    fn register(&mut self, agent_id: &str, flight: Flight, id: u64) {
        self.current.insert(agent_id.to_owned(), (id, flight));
    }

    /// The `finally` of a flight: it leaves the map unless a later flight replaced it.
    fn settled(&mut self, agent_id: &str, id: u64) {
        if self.current.get(agent_id).is_some_and(|(current, _)| *current == id) {
            self.current.remove(agent_id);
        }
    }
}

fn locked(flights: &Mutex<Flights>) -> std::sync::MutexGuard<'_, Flights> {
    flights.lock().unwrap_or_else(|e| e.into_inner())
}

/// The home threads: open, reset, retire and restore. Open and reset of one agent share a flight.
#[derive(Clone)]
pub struct AgentHomeSessions {
    deps: Arc<dyn HomeDeps>,
    flights: Arc<Mutex<Flights>>,
}

async fn resolve(deps: &dyn HomeDeps, agent_id: &str) -> Result<String, CoreError> {
    let session_id = agent_home_session_id(agent_id).ok_or_else(|| type_error("agent id is invalid."))?;
    let (route, params) = if agent_id == MIXY_AGENT_ID {
        // Mixy runs on its own model (bots/mixy), Main's once it has none.
        let route = route_params(&deps.mixy_route().await.map_err(dep)?);
        (route.clone(), route)
    } else {
        let agents = deps.list_agents().await.map_err(dep)?;
        let row = contact_row(&agents, agent_id).ok_or_else(|| failed(DOMAIN, format!("Agent \"{agent_id}\" is not available.")))?;
        let route = route_params(row.get("route").unwrap_or(&Value::Null));
        let mut params = route.clone();
        params.insert("sessionProfile".into(), json!({ "homeAgent": agent_id }));
        // A bot made again under a deleted one's id owns its thread again.
        deps.set_retired(&session_id, false).await.map_err(dep)?;
        (route, params)
    };
    // Reopening a contact brings its thread back from the archive.
    deps.set_archived(&session_id, false).await.map_err(dep)?;
    match deps.read_session(&session_id).await {
        Ok(snapshot) => {
            // An existing thread follows its definition's current model and effort from its next
            // turn. A route the runtime refuses (provider signed out) never blocks opening.
            if route_changed(&route, &snapshot) {
                if let Err(error) = deps.set_route(&session_id, &Value::Object(route)).await {
                    // `agent-home-sessions.ts:141`: warned, never blocks opening.
                    tracing::warn!("[mixdog-session] Could not refresh the agent thread route: {error:?}");
                }
            }
            return Ok(session_id);
        }
        Err(error) if error.session_missing() => {}
        Err(error) => return Err(dep(error)),
    }
    // A Mixy the user never created gets no chat, whichever surface asks.
    if agent_id == MIXY_AGENT_ID && !deps.mixy_created().await.map_err(dep)? {
        return Err(failed(DOMAIN, "Create the representative bot first."));
    }
    let mut create = params;
    create.insert("cwd".into(), json!(deps.task_workspace().await.map_err(dep)?));
    create.insert("desktopSession".into(), json!({ "classification": "task", "projectPath": null }));
    deps.create_session(&session_id, &Value::Object(create)).await.map_err(dep)?;
    Ok(session_id)
}

/// `resetHome`: resolve the home, then move its conversation to a new archived id
/// (`startSessionOver`), `None` when it had no user turn. The archive mark is written before the
/// copy exists, so the copy never lists as a live chat.
async fn reset_home(deps: &dyn HomeDeps, agent_id: &str) -> Outcome {
    let session_id = resolve(deps, agent_id).await?;
    let archive_id = deps.mint_archive_id();
    deps.set_archived(&archive_id, true).await.map_err(dep)?;
    if let Err(error) = deps.clear_session(&session_id, &archive_id).await {
        let _ = deps.set_archived(&archive_id, false).await;
        return Err(dep(error));
    }
    let archived = match deps.read_session(&archive_id).await {
        Ok(_) => Some(archive_id),
        Err(error) if error.session_missing() => {
            deps.set_archived(&archive_id, false).await.map_err(dep)?;
            None
        }
        Err(error) => return Err(dep(error)),
    };
    Ok((session_id, archived))
}

impl AgentHomeSessions {
    pub fn new(deps: Arc<dyn HomeDeps>) -> Self {
        Self { deps, flights: Arc::default() }
    }

    /// Registers the flight `work` makes for `agent_id`; it leaves the map when `work` ends.
    fn start_flight(&self, flights: &mut Flights, agent_id: &str, work: impl FnOnce(Arc<dyn HomeDeps>) -> BoxFuture<'static, Outcome>) -> Flight {
        let id = flights.next;
        flights.next += 1;
        let (deps, map, agent) = (self.deps.clone(), Arc::downgrade(&self.flights), agent_id.to_owned());
        let running = work(deps);
        let flight = async move {
            let outcome = running.await;
            if let Some(map) = Weak::upgrade(&map) {
                locked(&map).settled(&agent, id);
            }
            outcome
        }
        .boxed()
        .shared();
        flights.register(agent_id, flight.clone(), id);
        flight
    }

    /// `agent/home/open`: `{ sessionId }`. A flight in progress, an open's or a reset's, is joined.
    pub async fn open(&self, agent_id: &str) -> Result<Value, CoreError> {
        let flight = {
            let mut flights = locked(&self.flights);
            match flights.current.get(agent_id) {
                Some((_, pending)) => pending.clone(),
                None => {
                    let agent = agent_id.to_owned();
                    self.start_flight(&mut flights, agent_id, |deps| async move { resolve(&*deps, &agent).await.map(|session_id| (session_id, None)) }.boxed())
                }
            }
        };
        let (session_id, _) = flight.await?;
        Ok(json!({ "sessionId": session_id }))
    }

    /// `agent/home/reset`: the agent keeps its one fixed home id; the conversation so far moves to a
    /// new archived id. It waits for the flight it finds, however that ended, and is the flight an
    /// open arriving meanwhile joins.
    pub async fn reset(&self, agent_id: &str) -> Result<Value, CoreError> {
        let flight = {
            let mut flights = locked(&self.flights);
            let previous = flights.current.get(agent_id).map(|(_, pending)| pending.clone());
            let agent = agent_id.to_owned();
            self.start_flight(&mut flights, agent_id, |deps| {
                async move {
                    if let Some(previous) = previous {
                        let _ = previous.await;
                    }
                    reset_home(&*deps, &agent).await
                }
                .boxed()
            })
        };
        let (session_id, archived) = flight.await?;
        Ok(json!({ "sessionId": session_id, "archivedSessionId": archived }))
    }

    /// `archiveDeleted`: archive the home thread of each agent whose definition is proven deleted
    /// on disk. The thread is addressed by its fixed id, so a blank home that no summary lists is
    /// archived too; the conversation stays restorable. Absence from a list read never counts:
    /// only a per-id `Deleted` answer does. `on_transition` archives only a home not yet retired
    /// for this deletion, so an archived one is never rewritten and a hand-restored one stays
    /// restored; an agent that exists again clears the record for its next deletion.
    async fn archive_deleted(&self, agent_ids: &[String], on_transition: bool) -> Result<(), CoreError> {
        let mut ids: Vec<String> = Vec::new();
        for id in agent_ids {
            if id != MIXY_AGENT_ID && agent_home_session_id(id).is_some() && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        if ids.is_empty() {
            return Ok(());
        }
        let presence = self.deps.agent_presence(&ids).await.map_err(dep)?;
        for id in &ids {
            let session_id = agent_home_session_id(id).ok_or_else(|| type_error("agent id is invalid."))?;
            match presence.get(id).copied() {
                Some(Presence::Present) => {
                    if on_transition {
                        self.deps.set_retired(&session_id, false).await.map_err(dep)?;
                    }
                }
                Some(Presence::Deleted) => {
                    if !(on_transition && self.deps.is_retired(&session_id).await.map_err(dep)?) {
                        let name = self.deps.archived_agent_name(id).await.map_err(dep)?;
                        if !name.is_empty() {
                            self.deps.name_retired(&session_id, &name).await.map_err(dep)?;
                        }
                        self.deps.set_archived(&session_id, true).await.map_err(dep)?;
                        self.deps.set_retired(&session_id, true).await.map_err(dep)?;
                    }
                    // Its schedules and webhooks are left as they are: they wait, hidden, for a restore. Its
                    // membership goes with it: the one place a deletion is proven here, whether the delete came
                    // through the editor or a chat's setup tool.
                    self.deps.forget_room_member(id).await.map_err(dep)?;
                }
                Some(Presence::Unknown) | None => {}
            }
        }
        Ok(())
    }

    /// An explicit delete event: always archives the deleted agent's home.
    pub async fn retire(&self, agent_ids: &[String]) -> Result<(), CoreError> {
        self.archive_deleted(agent_ids, false).await
    }

    /// Deletions that did not pass through the editor (a chat's setup tool, files removed on disk): every
    /// known home thread's agent is checked, and only a newly observed deletion archives.
    pub async fn reconcile(&self) -> Result<(), CoreError> {
        let known = self.deps.known_session_ids().await.map_err(dep)?;
        let ids: Vec<String> = known.iter().filter_map(|id| agent_id_of_home_session(id)).collect();
        self.archive_deleted(&ids, true).await
    }

    /// A restored bot: its home is no longer a deleted bot's chat and leaves the archive.
    pub async fn restore(&self, agent_id: &str) -> Result<(), CoreError> {
        let Some(session_id) = agent_home_session_id(agent_id) else { return Ok(()) };
        if agent_id == MIXY_AGENT_ID {
            return Ok(());
        }
        self.deps.set_retired(&session_id, false).await.map_err(dep)?;
        self.deps.set_archived(&session_id, false).await.map_err(dep)
    }

    /// Whether the agent's home thread is among the sessions this host knows.
    pub async fn has_home(&self, agent_id: &str) -> Result<bool, CoreError> {
        let Some(session_id) = agent_home_session_id(agent_id) else { return Ok(false) };
        Ok(self.deps.known_session_ids().await.map_err(dep)?.contains(&session_id))
    }
}

// ---- memory -----------------------------------------------------------------------------------

/// `requiredAgentId`: the agent must have a home id.
fn required_agent_id(agent_id: &str) -> Result<(), CoreError> {
    agent_home_session_id(agent_id).map(|_| ()).ok_or_else(|| type_error("agent id is invalid."))
}

/// `requiredAgentMemoryEntry`: a positive list index and its list version.
pub fn required_memory_entry(id: &Value, index_revision: &Value) -> Result<(f64, String), CoreError> {
    let id = to_number_of_safe_integer(id).filter(|id| *id > 0.0).ok_or_else(|| type_error("memory id is invalid."))?;
    match index_revision {
        Value::String(text) if !text.is_empty() && utf16_len(text) <= 200 => Ok((id, text.clone())),
        _ => Err(type_error("memory indexRevision is invalid.")),
    }
}

/// `Number.isSafeInteger(value)` of a number value; `None` for anything else.
fn to_number_of_safe_integer(value: &Value) -> Option<f64> {
    let Value::Number(number) = value else { return None };
    let number = number.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number)
}

/// One row of a memory page as `listAgentMemory` maps it.
fn memory_entry(row: &Value) -> Result<Value, CoreError> {
    if row.is_null() {
        return Err(type_error("Cannot read properties of null (reading 'id')"));
    }
    let field = |key: &str| row.as_object().and_then(|row| row.get(key));
    let string_of = |value: Option<&Value>| value.map_or_else(|| "undefined".to_owned(), value_to_string);
    Ok(json!({
        "id": json_number(field("id").map_or(f64::NAN, to_number)),
        "indexRevision": string_of(field("index_revision")),
        "summary": match field("summary") { None | Some(Value::Null) => String::new(), Some(value) => value_to_string(value) },
    }))
}

/// The rows `for (const row of page.entries ?? [])` visits.
fn page_rows(page: &Value) -> Result<Vec<Value>, CoreError> {
    match page.get("entries") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(rows)) => Ok(rows.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        Some(Value::Object(_)) => Err(type_error("object is not iterable (cannot read property Symbol(Symbol.iterator))")),
        Some(Value::Bool(flag)) => Err(type_error(&format!("boolean {flag} is not iterable (cannot read property Symbol(Symbol.iterator))"))),
        Some(other) => Err(type_error(&format!("number {} is not iterable (cannot read property Symbol(Symbol.iterator))", value_to_string(other)))),
    }
}

/// The agent memory as the host reads and deletes it (`agent-memory.ts`).
pub struct AgentMemoryHost {
    runtime: Arc<dyn MemoryRuntime>,
}

impl AgentMemoryHost {
    pub fn new(runtime: Arc<dyn MemoryRuntime>) -> Self {
        Self { runtime }
    }

    async fn control(&self, args: Value) -> Result<String, CoreError> {
        self.runtime.memory_control(args).await.map_err(|message| failed(DOMAIN, message))
    }

    /// `listAgentMemory`: every active entry of `agent_id`'s pool, in its list order.
    pub async fn list(&self, agent_id: &str) -> Result<Value, CoreError> {
        required_agent_id(agent_id)?;
        let mut entries = Vec::new();
        let mut offset = Some(0.0_f64);
        while let Some(at) = offset {
            let text = self.control(json!({ "op": "list", "agent_id": agent_id, "format": "json", "limit": PAGE_SIZE, "offset": json_number(at) })).await?;
            let page = json_parse(&text).map_err(|_| failed(DOMAIN, if text.is_empty() { "The agent memory could not be read." } else { &text }))?;
            if page.is_null() {
                return Err(type_error("Cannot read properties of null (reading 'entries')"));
            }
            for row in page_rows(&page)? {
                entries.push(memory_entry(&row)?);
            }
            offset = match page.get("nextOffset") {
                Some(Value::Number(next)) => next.as_f64().filter(|next| *next > at),
                _ => None,
            };
        }
        Ok(Value::Array(entries))
    }

    /// `deleteAgentMemory`: a stale `indexRevision` is refused (list again).
    pub async fn delete(&self, agent_id: &str, id: &Value, index_revision: &Value) -> Result<(), CoreError> {
        required_agent_id(agent_id)?;
        let (id, revision) = required_memory_entry(id, index_revision)?;
        let text = self.control(json!({ "op": "delete", "agent_id": agent_id, "id": json_number(id), "index_revision": revision })).await?;
        if text.starts_with("core deleted ") {
            return Ok(());
        }
        Err(failed(DOMAIN, if text.is_empty() { "The agent memory entry could not be deleted." } else { &text }))
    }
}

// ---- the service ------------------------------------------------------------------------------

/// `requiredString(value, 'agentId', 200)`: a string, trimmed, not empty, at most 200 characters.
fn required_agent_param(params: &Value) -> Result<String, CoreError> {
    let Some(Value::String(text)) = params.get("agentId") else {
        return Err(type_error("agentId must be a string."));
    };
    let text = js_trim(text);
    if text.is_empty() || utf16_len(text) > 200 {
        return Err(type_error("agentId is invalid."));
    }
    Ok(text.to_owned())
}

pub struct AgentHomeService {
    homes: AgentHomeSessions,
    memory: AgentMemoryHost,
    /// Shared with the `agentPool` section's task: Node's idle stamps live in one pool.
    pool: Arc<AgentPool>,
}

impl AgentHomeService {
    pub fn new(homes: AgentHomeSessions, memory: AgentMemoryHost, pool: Arc<AgentPool>) -> Self {
        Self { homes, memory, pool }
    }

    async fn dispatch(&self, method: &str, params: &Value) -> Result<Value, CoreError> {
        match method {
            "agent/home/open" => self.homes.open(&required_agent_param(params)?).await,
            "agent/home/reset" => self.homes.reset(&required_agent_param(params)?).await,
            "agent/memory/list" => self.memory.list(&required_agent_param(params)?).await,
            "agent/memory/delete" => {
                let agent = required_agent_param(params)?;
                // The entry id travels as text; Node's IPC takes the number it names.
                let id = match params.get("entryId") {
                    Some(Value::String(text)) => json_number(to_number(&Value::String(text.clone()))),
                    _ => return Err(invalid("params.entryId", "string")),
                };
                let revision = params.get("indexRevision").unwrap_or(&Value::Null);
                required_memory_entry(&id, revision)?;
                self.memory.delete(&agent, &id, revision).await?;
                Ok(Value::Null)
            }
            "agent/pool/list" => self.pool.list().await.map(Value::Array).map_err(|error| failed(DOMAIN, error.0)),
            other => Err(wrong_method(DOMAIN, other)),
        }
    }
}

#[async_trait]
impl DomainService for AgentHomeService {
    fn methods(&self) -> &'static [&'static str] {
        HOME_METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(req.method.as_str(), &req.params).await?))
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
