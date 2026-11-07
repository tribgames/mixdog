//! The production [`SendWorld`] of the agent tool's `send` path: what `createSendFlow` borrows
//! of the session manager (`mgr`) and the session surface (`sessionSurface`) in the daemon, where
//! both are the agent tree (`standalone/session-service/agent-tree.mjs` `agentManager` and
//! `agentSurface`, wired in `agent-tool.mjs:69`).
//!
//! The daemon's agent manager has no `updateSessionRoute`, `holdSessionRoute` or
//! `enqueuePendingMessage` (the flow calls them optionally), and its surface is canonical and
//! runs every agent child, so those three are no-ops and the pending queue is absent.
//!
//! The errors `setRoute` and `enqueueTurn` throw are Node's, checked against
//! `fixtures/agent-send` (recorded by `benchmarks/rust-core/recorders/record-agent-send.mjs`
//! from `createAgentTree`).

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::handoff::handoff_content;
use mixdog_agent::agent_tool::flow::world::SendWorld;
use mixdog_agent::agent_tool::scope::clean_str;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::truthy;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_ports::ports::route::ChatRouteSetter;
use mixdog_core_ports::ports::route::FollowOptions;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_run::run_host::route_chain::BotRoutes;
use mixdog_core_run::run_host::route_chain::route_candidates;
use mixdog_rt::CancellationToken;
use mixdog_rt::InteractiveIo;
use mixdog_store::blobs::BlobStore;
use mixdog_store::schema::bounded::Digest;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::agent_registry::AgentRegistry;
use mixdog_core_session::session::agent_registry::LiveSessions;
use mixdog_core_session::session::agent_registry::Row;
use mixdog_core_session::session::delegation::rebind_patch;
use mixdog_core_session::session::delete::is_session_id;
use mixdog_core_session::session::Clock;
use mixdog_core_session::session::runtime_facts::RuntimeFacts;
use mixdog_core_session::session::run_stamps::Records;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::agent_spawn_world::SessionRuns;

/// `ACTIVE_STAGES` (`tool-def.mjs`), compared as is (`ACTIVE_STAGES.has(stage)`).
const ACTIVE_STAGES: [&str; 6] = ["connecting", "requesting", "streaming", "tool_running", "running", "cancelling"];

/// What the world refuses with. The first two are the agent tree's own messages.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SendWorldError {
    /// `agent session is closed`: no descriptor, or a closed one.
    #[error("agent session is closed")]
    Closed,
    /// `agent follow-up was not accepted`: the runtime refused the queued prompt.
    #[error("agent follow-up was not accepted")]
    NotAccepted,
    /// The prompt could not be handed to the session.
    #[error("{0}")]
    Submit(String),
    #[error("{0}")]
    Port(String),
}

fn port_message(error: PortError) -> SendWorldError {
    SendWorldError::Port(match error {
        PortError::Invalid { reason, .. } => reason,
        PortError::Denied(message) => message,
        PortError::Refused { message, .. } | PortError::Unavailable { message, .. } | PortError::NotFound { message, .. } | PortError::Failed { message, .. } => message,
        PortError::Cancelled => "cancelled".to_owned(),
    })
}

/// `mgr.getSession(id)` as the registry holds it.
pub trait SessionRows: Send + Sync {
    fn row(&self, id: &str) -> Option<Row>;
    /// `registry.assertAdmission(id, epoch)` (`agent-registry.mjs:59`).
    fn assert_admission(&self, id: &str, epoch: Option<u64>) -> Result<u64, String>;
}

impl SessionRows for AgentRegistry {
    fn row(&self, id: &str) -> Option<Row> {
        self.session_row(id)
    }

    fn assert_admission(&self, id: &str, epoch: Option<u64>) -> Result<u64, String> {
        AgentRegistry::assert_admission(self, id, epoch)
    }
}

/// The saved agent configuration (`cfgMod.loadConfig()`).
pub trait AgentConfig: Send + Sync {
    fn agent(&self) -> Obj;
}

impl AgentConfig for Config {
    fn agent(&self) -> Obj {
        Config::agent(self)
    }
}

/// A session's header write (`saveSessionAsync(record, { expectedGeneration: record.generation })` of the
/// delegation rebind, `delegation.mjs:227`).
#[async_trait]
pub trait HeaderWrites: Send + Sync {
    /// `expected_generation`: the generation of the record the patch was computed from. A record that has
    /// moved past it (detached or closed since) refuses the write, which is no error: the save is dropped.
    async fn patch(&self, session: &str, set: Map<String, Value>, expected_generation: Option<f64>) -> Result<(), SendWorldError>;
}

/// [`HeaderWrites`] over the thread state port.
pub struct ThreadHeaders(pub Arc<dyn ThreadState>);

#[async_trait]
impl HeaderWrites for ThreadHeaders {
    async fn patch(&self, session: &str, set: Map<String, Value>, expected_generation: Option<f64>) -> Result<(), SendWorldError> {
        mixdog_core_session::session::close::patch_header_fenced(&*self.0, &ThreadId::from(session), expected_generation, set, Vec::new())
            .await
            .map(|_| ())
            .map_err(port_message)
    }
}

/// `runtime.submitAsync(content, { priority: 'next' })` of a loaded session, and the queue it
/// leaves.
#[async_trait]
pub trait TurnQueue: Send + Sync {
    /// Whether the runtime took the prompt (`content` is the text, or the text with the forwarded
    /// attachment parts; `context` the follow-up's own; `sizes` the stored files' sizes by
    /// `attachmentRef`, for the message's attachment records).
    async fn submit_next(&self, session: &str, content: Value, submission: &str, context: Option<String>, sizes: BTreeMap<String, u32>) -> Result<bool, SendWorldError>;
}

/// `runtime.getState()` of a session this process hosts, as the agent tree reads it.
pub trait RuntimeStates: Send + Sync {
    fn facts(&self, session: &str) -> Option<RuntimeFacts>;
}

impl RuntimeStates for SessionDirectory {
    fn facts(&self, session: &str) -> Option<RuntimeFacts> {
        self.runtime_facts(&ThreadId::from(session))
    }
}

/// `attachmentBlobSize(ref, claimed)` (`attachments/store.mjs:398`): the stored file's size, or
/// nothing when it is not on disk (the claimed size stands then).
#[async_trait]
pub trait BlobSizes: Send + Sync {
    async fn size(&self, reference: &str) -> Result<Option<u64>, SendWorldError>;
}

/// [`BlobSizes`] over the blob store, read on the interactive lane.
pub struct StoreBlobSizes {
    pub blobs: BlobStore,
    pub io: InteractiveIo,
}

#[async_trait]
impl BlobSizes for StoreBlobSizes {
    async fn size(&self, reference: &str) -> Result<Option<u64>, SendWorldError> {
        let Ok(digest) = Digest::try_from(format!("sha256:{reference}")) else { return Ok(None) };
        let blobs = self.blobs.clone();
        mixdog_core_base::support::on_lane(self.io, &CancellationToken::new(), move |lane| blobs.len(lane, &digest))
            .await
            .map_err(|error| SendWorldError::Submit(format!("{error:?}")))?
            .map_err(|error| SendWorldError::Submit(error.to_string()))
    }
}

/// [`TurnQueue`] over the session directory: the internal `turn/start`, which a running turn
/// queues at the entry's priority.
pub struct DirectoryQueue {
    pub directory: Arc<SessionDirectory>,
}

#[async_trait]
impl TurnQueue for DirectoryQueue {
    async fn submit_next(&self, session: &str, content: Value, submission: &str, context: Option<String>, sizes: BTreeMap<String, u32>) -> Result<bool, SendWorldError> {
        let thread = ThreadId::from(session);
        let Some(handle) = self.directory.handle(&thread) else {
            return Err(SendWorldError::Submit(format!("agent session {session} is not loaded")));
        };
        let op = OpId::from(submission.to_owned());
        let mut options = json!({ "clientSubmissionId": submission, "priority": "next" });
        if let Some(context) = context {
            options["context"] = Value::String(context);
        }
        if !sizes.is_empty() {
            options["attachmentSizes"] = json!(sizes);
        }
        let params = json!({ "threadId": thread, "opId": op, "input": { "prompt": content, "options": options } });
        let ctx = CallContext::internal("agent-message");
        match handle.request(CoreRequest { method: Method("turn/start"), params, op: Some(op.clone()), ctx }).await {
            Ok(Reply::Value(value)) => Ok(matches!(value["kind"].as_str(), Some("started" | "queued"))),
            Ok(_) => Ok(false),
            Err(error) => Err(SendWorldError::Submit(format!("{error:?}"))),
        }
    }
}

/// `Number(value) || 0`.
fn number(value: Option<&Value>) -> f64 {
    let n = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => mixdog_js::string_to_number(s),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        _ => 0.0,
    };
    if n.is_nan() { 0.0 } else { n }
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).map(clean_str).unwrap_or_default()
}

/// `a || b` over strings.
fn either(value: &Value, a: &str, b: &str) -> String {
    let first = text(value, a);
    if first.is_empty() { text(value, b) } else { first }
}

/// `storedAgentCandidate` (`agent-rehydrate.mjs`): the sessions the agent tree holds, which are
/// the only ones its manager answers.
fn is_agent_child(session: &Value) -> bool {
    let id = text(session, "id");
    if !is_session_id(&id) {
        return false;
    }
    let parent = either(session, "parentSessionId", "ownerSessionId");
    if !is_session_id(&parent) || parent == id {
        return false;
    }
    either(session, "visibility", "sessionVisibility").to_lowercase() == "agent-only" || text(session, "owner").to_lowercase() == "agent"
}

pub struct AgentSendWorld {
    pub sessions: Arc<dyn SessionRows>,
    pub live: Arc<dyn LiveSessions>,
    pub runtime: Arc<dyn RuntimeStates>,
    pub blob_sizes: Arc<dyn BlobSizes>,
    pub clock: Arc<dyn Clock>,
    pub config: Arc<dyn AgentConfig>,
    pub bots: Arc<dyn BotRoutes>,
    pub routes: Arc<dyn ChatRouteSetter>,
    pub queue: Arc<dyn TurnQueue>,
    pub records: Arc<dyn Records>,
    pub runs: Arc<dyn SessionRuns>,
    pub headers: Arc<dyn HeaderWrites>,
}

impl AgentSendWorld {
    /// The agent tree's descriptor (`registry.get`) of an open child.
    fn open_child(&self, session: &Value) -> Result<String, SendWorldError> {
        let id = text(session, "id");
        match SendWorld::session(self, &id) {
            Some(held) if held.get("closed") != Some(&Value::Bool(true)) => Ok(id),
            _ => Err(SendWorldError::Closed),
        }
    }
}

#[async_trait]
impl SendWorld for AgentSendWorld {
    /// `mgr.getSession(id)` (`agent-tree.mjs` `agentDescriptor`).
    ///
    /// The descriptor's status follows the live runtime: a closed one keeps its own (`closed`
    /// when it has none), else a runtime this process hosts that is `stateBusy` reads `running`
    /// and an idle one that was `running` reads `idle`; `stage` is the status. `messageCount` is
    /// the runtime's item count when it has items, else the descriptor's; `updatedAt` the
    /// descriptor's, else now.
    fn session(&self, session_id: &str) -> Option<Value> {
        let mut row = self.sessions.row(session_id).filter(|row| is_agent_child(&Value::Object(row.clone())))?;
        let facts = self.runtime.facts(session_id);
        let own = row.get("status").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        let status = match (&facts, row.get("closed") == Some(&Value::Bool(true))) {
            (_, true) => own.unwrap_or_else(|| "closed".to_owned()),
            (Some(facts), false) if facts.state_busy() => "running".to_owned(),
            (Some(_), false) => own.filter(|s| s != "running").unwrap_or_else(|| "idle".to_owned()),
            (None, false) => own.unwrap_or_else(|| "idle".to_owned()),
        };
        row.insert("status".into(), Value::String(status.clone()));
        row.insert("stage".into(), Value::String(status));
        let items = facts.map_or(0, |facts| facts.items);
        let count = if items > 0 {
            items as f64
        } else {
            number(row.get("messageCount")).max(0.0)
        };
        row.insert("messageCount".into(), json!(count as u64));
        if !truthy(row.get("updatedAt")) {
            row.insert("updatedAt".into(), json!(self.clock.now_ms()));
        }
        Some(Value::Object(row))
    }

    /// `canUseSessionSurface`: the surface runs every session of its tree (`canRun`).
    fn surface_runs(&self, session: &Value) -> bool {
        SendWorld::session(self, &text(session, "id")).is_some()
    }

    /// `agentSurface.canonical`.
    fn canonical_surface(&self) -> bool {
        true
    }

    /// `views.isSessionBusy` (`job-views.mjs:27`): a running turn, else the runtime's stage, which
    /// is the descriptor's own when no progress snapshot exists.
    fn is_busy(&self, session_id: &str) -> bool {
        let Some(session) = SendWorld::session(self, session_id) else { return false };
        if self.live.running(session_id) {
            return true;
        }
        let stage = self.live.runtime_stage(session_id).filter(|s| !s.is_empty()).unwrap_or_else(|| {
            let own = either(&session, "stage", "status");
            if own.is_empty() { "idle".to_owned() } else { own }
        });
        ACTIVE_STAGES.contains(&stage.as_str())
    }

    /// `await flushPendingSessionConfigWrites(); cfgMod.loadConfig()` (`send-flow.mjs:226`): a
    /// write here is durable before it answers, so nothing is pending.
    async fn load_config(&self) -> Result<Option<Obj>, String> {
        Ok(Some(self.config.agent()))
    }

    /// `configuredAgentRouteCandidates` (`agent-route-config.mjs:150`).
    async fn route_candidates(&self, config: &Obj, agent: &str) -> Result<Vec<Value>, String> {
        route_candidates(config, agent, &*self.bots).await.map_err(|error| error.to_string())
    }

    /// `typeof sessionSurface.setRoute === 'function'`.
    fn can_set_route(&self) -> bool {
        true
    }

    /// `agentSurface.setRoute` (`agent-tree.mjs:139`): the route goes through the session's own
    /// route API, session only.
    async fn set_route(&self, session: &Value, route: &Value) -> Result<(), String> {
        let id = self.open_child(session).map_err(|e| e.to_string())?;
        let mut pick = route.as_object().cloned().unwrap_or_default();
        pick.insert("sessionOnly".into(), Value::Bool(true));
        self.routes.set_route(&ThreadId::from(id.as_str()), pick, FollowOptions::default()).await.map_err(|e| port_message(e).to_string())
    }

    /// The daemon's manager has no `updateSessionRoute` (`mgr.updateSessionRoute?.()`).
    fn update_session_route(&self, _: &str, _: &Value, _: &Value, _: bool) {}

    /// The daemon's manager has no `holdSessionRoute`.
    fn hold_session_route(&self, _: &str, _: Option<&Value>) {}

    /// `agentSurface.enqueueTurn` (`agent-tree.mjs:170`): the cancel epoch is read first (:173)
    /// and checked again once the runtime took the prompt (:185).
    async fn enqueue_turn(&self, session: &Value, prompt: &str, attachments: &[Value], context: Option<&Value>) -> Result<Option<Value>, String> {
        let id = self.open_child(session).map_err(|e| e.to_string())?;
        let epoch = self.sessions.assert_admission(&id, None)?;
        if !self.runtime.facts(&id).is_some_and(|facts| facts.state_busy()) {
            return Ok(None);
        }
        let context = context.map(|c| match c {
            Value::String(text) => text.clone(),
            other => mixdog_js::value_to_string(other),
        });
        let submission = format!("agent-message-{}", uuid::Uuid::new_v4());
        let content = handoff_content(prompt, attachments);
        // `attachmentsForIntake` sizes a stored attachment's record by its file, the claimed size
        // only when the file is not there; the content part keeps the claimed size.
        let mut sizes = BTreeMap::new();
        for part in content.as_array().into_iter().flatten().skip(1) {
            let Some(reference) = part.get("attachmentRef").and_then(Value::as_str) else { continue };
            if let Some(size) = self.blob_sizes.size(reference).await.map_err(|e| e.to_string())? {
                sizes.insert(reference.to_owned(), u32::try_from(size).map_err(|_| format!("attachment {reference} is too large"))?);
            }
        }
        let accepted = self.queue.submit_next(&id, content, &submission, context, sizes).await.map_err(|e| e.to_string())?;
        if !accepted {
            return Err(SendWorldError::NotAccepted.to_string());
        }
        self.sessions.assert_admission(&id, Some(epoch))?;
        let depth = self.runtime.facts(&id).map(|facts| facts.queued);
        Ok(Some(json!({ "queueDepth": depth })))
    }

    /// The daemon's manager has no `enqueuePendingMessage`.
    fn enqueue_pending(&self, _: &str, _: &str, _: &[Value]) -> Option<u64> {
        None
    }

    /// `rebindDelegation(sessionId, callerSessionId)` (`delegation.mjs:196`): the patch is
    /// computed by the session layer and saved to the header.
    async fn rebind_delegation(&self, session_id: &str, caller_session_id: Option<&str>) -> Result<(), String> {
        let (id, caller) = (clean_str(session_id), caller_session_id.map(clean_str).unwrap_or_default());
        if id.is_empty() || caller.is_empty() || caller == id {
            return Ok(());
        }
        // `loadRecord(id)`: the record the patch is computed from names the generation the save is issued for.
        let expected = self.records.record(&id).await.and_then(|record| record.get("generation").and_then(Value::as_f64));
        let run = self.runs.run_of(&caller).await;
        let Some(patch) = rebind_patch(&id, &caller, run, self.live.running(&id), &*self.records).await else { return Ok(()) };
        self.headers.patch(&id, patch, expected).await.map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_ports::ports::route::Route;
    use mixdog_store::schema::record::Header;

    use super::*;

    const GOLDEN: &str = include_str!("../../../../fixtures/agent-send/golden.json");

    fn golden(case: &str) -> String {
        let value: Value = serde_json::from_str(GOLDEN).unwrap();
        value["cases"][case]["error"].as_str().unwrap().to_owned()
    }

    fn row(value: Value) -> Row {
        value.as_object().unwrap().clone()
    }

    fn child(id: &str) -> Row {
        row(json!({ "id": id, "parentSessionId": "sess_parent", "owner": "agent", "agent": "worker", "status": "idle" }))
    }

    /// The rows, and whether a cancellation began after the epoch was read.
    struct Rows(Vec<Row>, bool);
    impl SessionRows for Rows {
        fn row(&self, id: &str) -> Option<Row> {
            self.0.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id)).cloned()
        }
        fn assert_admission(&self, id: &str, epoch: Option<u64>) -> Result<u64, String> {
            match (epoch, self.1) {
                (Some(_), true) => Err(format!("agent session {id} was cancelled during admission")),
                _ => Ok(epoch.unwrap_or(7)),
            }
        }
    }

    #[derive(Default)]
    struct Live {
        running: Vec<String>,
        work: Vec<String>,
        /// Loaded with nothing to do.
        idle: Vec<String>,
        /// Loaded with a compaction running.
        command: Vec<String>,
        items: usize,
        stage: Option<String>,
    }
    impl LiveSessions for Live {
        fn loaded(&self) -> Vec<String> {
            self.work.clone()
        }
        fn header(&self, session: &str) -> Option<Row> {
            self.work.iter().chain(&self.idle).any(|w| w == session).then(Row::new)
        }
        fn running(&self, session: &str) -> bool {
            self.running.iter().any(|r| r == session)
        }
        fn has_live_work(&self, session: &str) -> bool {
            self.work.iter().any(|w| w == session)
        }
        fn runtime_stage(&self, _: &str) -> Option<String> {
            self.stage.clone()
        }
    }

    impl RuntimeStates for Live {
        fn facts(&self, session: &str) -> Option<RuntimeFacts> {
            let has = |list: &Vec<String>| list.iter().any(|s| s == session);
            let loaded = has(&self.work) || has(&self.idle) || has(&self.command);
            loaded.then(|| RuntimeFacts { busy: false, command_busy: has(&self.command), queued: usize::from(has(&self.work)), items: self.items })
        }
    }

    struct Sizes(Vec<(String, u64)>);
    #[async_trait]
    impl BlobSizes for Sizes {
        async fn size(&self, reference: &str) -> Result<Option<u64>, SendWorldError> {
            Ok(self.0.iter().find(|(r, _)| r == reference).map(|(_, n)| *n))
        }
    }

    struct Now;
    impl Clock for Now {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
    }

    struct Agent;
    impl AgentConfig for Agent {
        fn agent(&self) -> Obj {
            row(json!({ "agents": { "worker": { "provider": "p", "model": "m" } } }))
        }
    }

    struct NoBots;
    #[async_trait]
    impl BotRoutes for NoBots {
        async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
    }

    #[derive(Default)]
    struct Routes(Mutex<Vec<(String, Route)>>);
    #[async_trait]
    impl ChatRouteSetter for Routes {
        async fn set_route(&self, thread: &ThreadId, pick: Route, _: FollowOptions) -> Result<(), PortError> {
            self.0.lock().unwrap().push((thread.as_str().to_owned(), pick));
            Ok(())
        }
    }

    struct Queue {
        accept: bool,
        submitted: Mutex<Vec<(String, Value, Option<String>)>>,
        sizes: Mutex<Vec<BTreeMap<String, u32>>>,
    }
    #[async_trait]
    impl TurnQueue for Queue {
        async fn submit_next(&self, session: &str, content: Value, submission: &str, context: Option<String>, sizes: BTreeMap<String, u32>) -> Result<bool, SendWorldError> {
            self.sizes.lock().unwrap().push(sizes);
            assert!(submission.starts_with("agent-message-"));
            self.submitted.lock().unwrap().push((session.to_owned(), content, context));
            Ok(self.accept)
        }
    }

    struct Stored(Mutex<Vec<(String, Header)>>);
    #[async_trait]
    impl Records for Stored {
        async fn record(&self, session: &str) -> Option<Header> {
            self.0.lock().unwrap().iter().find(|(id, _)| id == session).map(|(_, h)| h.clone())
        }
    }

    struct NoRuns;
    #[async_trait]
    impl SessionRuns for NoRuns {
        async fn run_of(&self, _: &str) -> Option<Value> {
            None
        }
    }

    #[derive(Default)]
    struct Written(Mutex<Vec<(String, Map<String, Value>, Option<f64>)>>);
    #[async_trait]
    impl HeaderWrites for Written {
        async fn patch(&self, session: &str, set: Map<String, Value>, expected_generation: Option<f64>) -> Result<(), SendWorldError> {
            self.0.lock().unwrap().push((session.to_owned(), set, expected_generation));
            Ok(())
        }
    }

    struct Rig {
        world: AgentSendWorld,
        routes: Arc<Routes>,
        queue: Arc<Queue>,
        written: Arc<Written>,
    }

    fn rig(rows: Vec<Row>, live: Live, accept: bool, records: Vec<(String, Header)>) -> Rig {
        let (routes, written) = (Arc::new(Routes::default()), Arc::new(Written::default()));
        let queue = Arc::new(Queue { accept, submitted: Mutex::default(), sizes: Mutex::default() });
        let live = Arc::new(live);
        let world = AgentSendWorld {
            sessions: Arc::new(Rows(rows, false)),
            live: live.clone(),
            runtime: live,
            blob_sizes: Arc::new(Sizes(vec![("a".repeat(64), 11)])),
            clock: Arc::new(Now),
            config: Arc::new(Agent),
            bots: Arc::new(NoBots),
            routes: routes.clone(),
            queue: queue.clone(),
            records: Arc::new(Stored(Mutex::new(records))),
            runs: Arc::new(NoRuns),
            headers: written.clone(),
        };
        Rig { world, routes, queue, written }
    }

    #[test]
    fn only_the_agent_trees_children_are_sessions() {
        let lead = row(json!({ "id": "sess_lead" }));
        let no_parent = row(json!({ "id": "sess_a", "owner": "agent" }));
        let self_parent = row(json!({ "id": "sess_a", "parentSessionId": "sess_a", "owner": "agent" }));
        let owned = row(json!({ "id": "sess_o", "ownerSessionId": "sess_parent", "visibility": " Agent-Only " }));
        let rig = rig(vec![child("sess_c"), lead, no_parent, self_parent, owned], Live::default(), true, vec![]);
        assert!(rig.world.session("sess_c").is_some());
        assert!(rig.world.session("sess_o").is_some());
        for id in ["sess_lead", "sess_a", "sess_none"] {
            assert!(rig.world.session(id).is_none(), "{id}");
        }
        assert!(rig.world.surface_runs(&json!({ "id": "sess_c" })));
        assert!(!rig.world.surface_runs(&json!({ "id": "sess_lead" })));
    }

    #[test]
    fn busy_is_a_running_turn_or_an_active_stage() {
        let busy = |live: Live| rig(vec![child("sess_c")], live, true, vec![]).world.is_busy("sess_c");
        assert!(busy(Live { running: vec!["sess_c".into()], ..Live::default() }));
        assert!(busy(Live { stage: Some("streaming".into()), ..Live::default() }));
        assert!(!busy(Live { stage: Some("idle".into()), ..Live::default() }));
        assert!(!busy(Live::default()), "the descriptor's own status is idle");
        assert!(!rig(vec![], Live { running: vec!["sess_c".into()], ..Live::default() }, true, vec![]).world.is_busy("sess_c"), "no descriptor, no runtime");
    }

    #[tokio::test]
    async fn a_busy_session_queues_the_prompt_and_answers_the_depth() {
        let live = Live { work: vec!["sess_c".into()], ..Live::default() };
        let rig = rig(vec![child("sess_c")], live, true, vec![]);
        let session = rig.world.session("sess_c").unwrap();
        let queued = rig.world.enqueue_turn(&session, "next", &[], None).await.unwrap();
        assert_eq!(queued, Some(json!({ "queueDepth": 1 })));
        assert_eq!(*rig.queue.submitted.lock().unwrap(), [("sess_c".to_owned(), json!("next"), None)]);

        let idle = self::rig(vec![child("sess_c")], Live::default(), true, vec![]);
        assert_eq!(idle.world.enqueue_turn(&session, "x", &[], None).await.unwrap(), None, "an idle session runs a job instead");
    }

    #[tokio::test]
    async fn the_refusals_are_the_agent_trees_messages() {
        let live = Live { work: vec!["sess_c".into()], ..Live::default() };
        let refused = rig(vec![child("sess_c")], live, false, vec![]);
        let session = json!({ "id": "sess_c" });
        assert_eq!(refused.world.enqueue_turn(&session, "again", &[], None).await.unwrap_err(), golden("enqueueRefused"));
        let closed = row(json!({ "id": "sess_x", "parentSessionId": "sess_parent", "owner": "agent", "closed": true }));
        let rig = rig(vec![closed], Live::default(), true, vec![]);
        for (id, case) in [("sess_x", "closed"), ("sess_unknown", "unknown")] {
            let session = json!({ "id": id });
            assert_eq!(rig.world.enqueue_turn(&session, "x", &[], None).await.unwrap_err(), golden(if case == "closed" { "enqueueClosed" } else { "enqueueUnknown" }));
            let route = json!({ "provider": "p", "model": "m" });
            assert_eq!(rig.world.set_route(&session, &route).await.unwrap_err(), golden(if case == "closed" { "setRouteClosed" } else { "setRouteUnknown" }));
        }
    }

    #[tokio::test]
    async fn forwarded_files_are_sized_by_their_stored_file_and_ride_with_the_context() {
        let live = Live { work: vec!["sess_c".into()], ..Live::default() };
        let rig = rig(vec![child("sess_c")], live, true, vec![]);
        let reference = "a".repeat(64);
        let file = json!({ "type": "file", "attachmentRef": reference, "sizeBytes": 3, "mimeType": "text/plain", "filename": "n.txt", "data": "inline" });
        rig.world.enqueue_turn(&json!({ "id": "sess_c" }), "x", &[file], Some(&json!("more"))).await.unwrap();
        let want = json!([{ "type": "text", "text": "x" }, { "type": "file", "attachmentRef": reference, "sizeBytes": 3, "mimeType": "text/plain", "filename": "n.txt" }]);
        assert_eq!(*rig.queue.submitted.lock().unwrap(), [("sess_c".to_owned(), want, Some("more".to_owned()))], "the part keeps its claimed size");
        assert_eq!(rig.queue.sizes.lock().unwrap()[0], BTreeMap::from([(reference, 11_u32)]), "the record takes the stored file's size");
    }

    #[tokio::test]
    async fn a_file_that_is_not_stored_keeps_its_claimed_size() {
        let live = Live { work: vec!["sess_c".into()], ..Live::default() };
        let rig = rig(vec![child("sess_c")], live, true, vec![]);
        let file = json!({ "type": "file", "attachmentRef": "d".repeat(64), "sizeBytes": 3, "mimeType": "x/y", "filename": "f" });
        rig.world.enqueue_turn(&json!({ "id": "sess_c" }), "x", &[file], None).await.unwrap();
        assert_eq!(rig.queue.submitted.lock().unwrap()[0].1[1]["sizeBytes"], json!(3));
        assert!(rig.queue.sizes.lock().unwrap()[0].is_empty(), "nothing stored: the claimed size stands");
    }

    #[tokio::test]
    async fn a_cancellation_during_the_submit_refuses_the_follow_up() {
        let live = Live { work: vec!["sess_c".into()], ..Live::default() };
        let mut rig = rig(vec![child("sess_c")], live, true, vec![]);
        rig.world.sessions = Arc::new(Rows(vec![child("sess_c")], true));
        let error = rig.world.enqueue_turn(&json!({ "id": "sess_c" }), "x", &[], None).await.unwrap_err();
        assert_eq!(error, "agent session sess_c was cancelled during admission");
    }

    #[test]
    fn a_session_reads_the_status_of_its_runtime() {
        let status = |row: Value, live: Live| {
            let session = rig(vec![row.as_object().unwrap().clone()], live, true, vec![]).world.session("sess_c").unwrap();
            (session["status"].clone(), session["stage"].clone())
        };
        let working = || Live { work: vec!["sess_c".into()], ..Live::default() };
        let loaded_idle = || Live { idle: vec!["sess_c".into()], ..Live::default() };
        let base = || json!({ "id": "sess_c", "parentSessionId": "sess_parent", "owner": "agent" });
        assert_eq!(status(base(), working()), (json!("running"), json!("running")), "busy runtime");
        assert_eq!(status(base(), loaded_idle()), (json!("idle"), json!("idle")), "no status of its own");
        let mut stored = base();
        stored["status"] = json!("running");
        assert_eq!(status(stored.clone(), Live::default()).0, json!("running"), "not loaded here: its own status stands");
        assert_eq!(status(stored, loaded_idle()).0, json!("idle"), "loaded and idle: a stale running is idle");
        let mut done = base();
        done["status"] = json!("completed");
        assert_eq!(status(done, loaded_idle()).0, json!("completed"));
        let mut closed = base();
        closed["closed"] = json!(true);
        assert_eq!(status(closed, working()).0, json!("closed"));
        let compacting = Live { command: vec!["sess_c".into()], ..Live::default() };
        assert_eq!(status(base(), compacting).0, json!("running"), "a compaction is busy (`commandBusy`)");
    }

    #[test]
    fn a_session_counts_the_runtimes_items_and_is_stamped_now() {
        let at = |row: Value, live: Live| rig(vec![row.as_object().unwrap().clone()], live, true, vec![]).world.session("sess_c").unwrap();
        let base = || json!({ "id": "sess_c", "parentSessionId": "sess_parent", "owner": "agent", "messageCount": " 4 " });
        let items = at(base(), Live { idle: vec!["sess_c".into()], items: 9, ..Live::default() });
        assert_eq!((items["messageCount"].clone(), items["updatedAt"].clone()), (json!(9), json!(1_700_000_000_000_i64)));
        let own = at(base(), Live { idle: vec!["sess_c".into()], ..Live::default() });
        assert_eq!(own["messageCount"], json!(4), "no items: the descriptor\'s count");
        let mut stamped = base();
        stamped["updatedAt"] = json!(5);
        stamped["messageCount"] = json!(-3);
        let kept = at(stamped, Live::default());
        assert_eq!((kept["messageCount"].clone(), kept["updatedAt"].clone()), (json!(0), json!(5)));
    }

    #[tokio::test]
    async fn a_set_route_is_session_only() {
        let rig = rig(vec![child("sess_c")], Live::default(), true, vec![]);
        rig.world.set_route(&json!({ "id": "sess_c" }), &json!({ "provider": "p", "model": "m" })).await.unwrap();
        let calls = rig.routes.0.lock().unwrap();
        assert_eq!(calls[0].0, "sess_c");
        assert_eq!(Value::Object(calls[0].1.clone()), json!({ "provider": "p", "model": "m", "sessionOnly": true }));
    }

    #[tokio::test]
    async fn the_route_candidates_are_the_configured_ones() {
        let rig = rig(vec![], Live::default(), true, vec![]);
        let config = rig.world.load_config().await.unwrap().unwrap();
        assert_eq!(rig.world.route_candidates(&config, "worker").await.unwrap(), vec![json!({ "provider": "p", "model": "m" })]);
        assert!(rig.world.route_candidates(&config, "other").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_rebind_without_a_distinct_caller_writes_nothing() {
        let rig = rig(vec![child("sess_c")], Live::default(), true, vec![]);
        for caller in [None, Some(""), Some(" sess_c ")] {
            rig.world.rebind_delegation("sess_c", caller).await.unwrap();
        }
        assert!(rig.written.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_rebind_attends_a_worker_a_chat_hands_work() {
        // The worker was started by a run; its new caller is a coding chat, so it is attended.
        let run = json!({ "kind": "schedule", "agentId": "bot", "name": "" });
        let worker = row(json!({ "id": "sess_c", "parentSessionId": "sess_chat", "owner": "agent", "agent": "worker", "run": run, "generation": 3 }));
        let chat = row(json!({ "id": "sess_chat" }));
        let records = vec![("sess_c".to_owned(), worker), ("sess_chat".to_owned(), chat)];
        let rig = rig(vec![child("sess_c")], Live::default(), true, records);
        rig.world.rebind_delegation("sess_c", Some("sess_chat")).await.unwrap();
        let written = rig.written.0.lock().unwrap();
        assert_eq!(written.len(), 1);
        assert_eq!(written[0].0, "sess_c");
        assert_eq!(written[0].1.get("run"), Some(&Value::Null));
        assert_eq!(written[0].2, Some(3.0), "the save is issued for the generation of the record it was computed from (`delegation.mjs:227`)");
    }
}
