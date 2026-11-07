//! `RoutineHost` over the process services: who may own or execute a routine
//! (`routine-owner.mjs` `routineOwnerProblem`, `routine-executor.mjs` `defaultProbe`) is decided
//! here from the agent definitions, and whether a thread is a heartbeat's from the process marks.
//! What only the session core can do — queueing a routine turn behind a thread's own work,
//! running a headless executor, queueing a result in the owner's thread — stays behind
//! `RoutineSessions`.

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_agent::agent_tool::flow::spawn::SpawnFlowImpl;
use mixdog_agent::agent_tool::flow::world::SpawnContext;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;
use mixdog_services::bots::RoutineKind;
use mixdog_services::bots::delivery::home::AgentHomeDelivery;
use mixdog_tools::policy::RunKind;
use serde_json::{Value, json};

use super::attachment_reference::AttachmentFiles;
use super::unattended::{RunMark, UnattendedRunRegistry};
use mixdog_core_agents::agents::{AgentDefinitions, ContactIds};
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_rooms::rooms::home::Presence;
use mixdog_services::bots::{
    AnnouncedRun, DeliveryItem, ExecutorFacts, ExecutorRun, HeartbeatSessions, OwnerProblem, RoutineHost, RoutineTurn, TurnSettle,
};
use tokio_util::sync::CancellationToken;

/// The agent-definition reads the routine rules ask.
#[async_trait]
pub trait RoutineAgents: Send + Sync {
    /// `readMixyExists(null, { ownsRoutine: stored })`.
    async fn mixy_exists(&self, stored: bool) -> Result<bool, String>;
    /// `agentDefinitionPresence([id])[id]`.
    async fn presence(&self, agent_id: &str) -> Result<Presence, String>;
    /// `Boolean(archivedAgentIdentities([id])[id])`.
    async fn archived(&self, agent_id: &str) -> Result<bool, String>;
    /// The fresh scan: a listed custom agent (never a built-in slot), a bot, a disabled one.
    async fn executor_facts(&self, agent_id: &str) -> Result<ExecutorFacts, String>;
}

/// What only the session core can do for a routine.
#[async_trait]
pub trait RoutineSessions: Send + Sync {
    /// The thread exists and is not closed (`loadSession(id)` and `closed !== true`).
    async fn home_thread_open(&self, session_id: &str) -> Result<bool, String>;
    async fn run_turn(&self, turn: RoutineTurn, cancel: CancellationToken) -> TurnSettle;
    async fn run_executor(&self, run: ExecutorRun, cancel: CancellationToken) -> Result<String, String>;
    async fn deliver_result(&self, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<(), String>;
    async fn announce_run(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun) -> Result<(), String>;
}

/// `RoutineAgents` over the agent definitions.
pub struct DefinitionAgents {
    definitions: Arc<AgentDefinitions>,
    contacts: ContactIds,
}

impl DefinitionAgents {
    pub fn new(definitions: Arc<AgentDefinitions>) -> Self {
        Self { contacts: ContactIds::new(definitions.clone()), definitions }
    }
}

#[async_trait]
impl RoutineAgents for DefinitionAgents {
    async fn mixy_exists(&self, stored: bool) -> Result<bool, String> {
        if !stored {
            return self.definitions.mixy_exists().await.map_err(|error| format!("{error:?}"));
        }
        // A routine she owns is itself evidence of her: only `created: false` says no.
        let status = self.definitions.lead_status().await.map_err(|error| format!("{error:?}"))?;
        Ok(status.created != Some(false))
    }

    async fn presence(&self, agent_id: &str) -> Result<Presence, String> {
        let found = self.definitions.presence(&[agent_id.to_owned()]).await.map_err(|error| format!("{error:?}"))?;
        Ok(found.get(agent_id).copied().unwrap_or(Presence::Unknown))
    }

    async fn archived(&self, agent_id: &str) -> Result<bool, String> {
        Ok(self.definitions.archived_identity(agent_id).await.map_err(|error| format!("{error:?}"))?.is_some())
    }

    async fn executor_facts(&self, agent_id: &str) -> Result<ExecutorFacts, String> {
        let rows = self.definitions.rows().await.map_err(|error| format!("{error:?}"))?;
        let Some(row) = rows.iter().find(|row| row.id == agent_id) else {
            return Ok(ExecutorFacts::default());
        };
        let listed = !row.fixed && row.definition.is_some();
        Ok(ExecutorFacts { listed, contact: listed && self.contacts.is_contact_bot(agent_id).await, disabled: row.disabled })
    }
}

pub struct SessionRoutineHost {
    agents: Arc<dyn RoutineAgents>,
    sessions: Arc<dyn RoutineSessions>,
    marks: Arc<HeartbeatSessions>,
}

impl SessionRoutineHost {
    pub fn new(agents: Arc<dyn RoutineAgents>, sessions: Arc<dyn RoutineSessions>, marks: Arc<HeartbeatSessions>) -> Arc<Self> {
        Arc::new(Self { agents, sessions, marks })
    }
}

#[async_trait]
impl RoutineHost for SessionRoutineHost {
    /// A routine Mixy owns is itself evidence of her, so only `created: false` pauses one; a new
    /// one needs her to exist. Only a proven deletion counts for a bot (archived: restorable).
    async fn owner_problem(&self, owner_agent_id: &str, stored: bool) -> Result<Option<OwnerProblem>, String> {
        if owner_agent_id == MIXY_AGENT_ID {
            return Ok((!self.agents.mixy_exists(stored).await?).then_some(OwnerProblem::NoMixy));
        }
        if self.agents.presence(owner_agent_id).await? != Presence::Deleted {
            return Ok(None);
        }
        Ok(Some(if self.agents.archived(owner_agent_id).await? { OwnerProblem::OwnerArchived } else { OwnerProblem::OwnerDeleted }))
    }

    async fn executor_facts(&self, agent_id: &str) -> Result<ExecutorFacts, String> {
        self.agents.executor_facts(agent_id).await
    }

    async fn home_thread_open(&self, session_id: &str) -> Result<bool, String> {
        self.sessions.home_thread_open(session_id).await
    }

    fn is_heartbeat_session(&self, session_id: &str) -> bool {
        self.marks.is_marked(session_id)
    }

    async fn run_turn(&self, turn: RoutineTurn, cancel: CancellationToken) -> TurnSettle {
        self.sessions.run_turn(turn, cancel).await
    }

    async fn run_executor(&self, run: ExecutorRun, cancel: CancellationToken) -> Result<String, String> {
        self.sessions.run_executor(run, cancel).await
    }

    async fn deliver_result(&self, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<(), String> {
        self.sessions.deliver_result(owner_agent_id, name, item).await
    }

    async fn announce_run(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun) -> Result<(), String> {
        self.sessions.announce_run(owner_agent_id, name, run).await
    }
}

/// `runAgent` of the live surface: one workflow agent run to its end (`runToCompletion`).
#[async_trait]
pub trait ExecutorAgents: Send + Sync {
    /// `{ sessionId, content }`'s content, or the run's failure text. `caller` is the id the agent
    /// is created under.
    async fn run_to_completion(&self, args: &Value, caller: &str, cancel: &CancellationToken) -> Result<String, String>;
}

#[async_trait]
impl ExecutorAgents for Arc<SpawnFlowImpl> {
    async fn run_to_completion(&self, args: &Value, caller: &str, cancel: &CancellationToken) -> Result<String, String> {
        let context = SpawnContext {
            caller_session_id: Some(caller.to_owned()),
            session_id: None,
            owner_session_id: Some(caller.to_owned()),
            client_host_pid: None,
        };
        SpawnFlowImpl::run_to_completion(self, args, "", &context, cancel).await.map(|(_, content)| content)
    }
}

/// What the routine runner asks of the home delivery (`AgentHomeDelivery`).
#[async_trait]
pub trait ResultDelivery: Send + Sync {
    async fn enqueue(&self, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<(), String>;
    async fn announce(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun);
}

#[async_trait]
impl ResultDelivery for Arc<AgentHomeDelivery> {
    async fn enqueue(&self, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<(), String> {
        AgentHomeDelivery::enqueue(self, owner_agent_id, name, item).await.map(|_| ())
    }

    async fn announce(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun) {
        AgentHomeDelivery::announce(self, owner_agent_id, name, run).await;
    }
}

/// `routineHumanNeededText(outcome, site)`.
fn human_needed_text(outcome: &str, site: &str) -> String {
    let prefix = match outcome {
        "login_required" => "Sign-in required: ",
        "sensitive_confirmation_required" => "Confirmation required: ",
        _ => "Action required: ",
    };
    let label = mixdog_js::slice_utf16(&mixdog_js::js_words(site).collect::<Vec<_>>().join(" "), 120);
    format!("{prefix}{}", if label.is_empty() { "the site" } else { &label })
}

/// `referencePart` of the routine executor: an inline image or document part as the stored
/// attachment reference an executor's prompt admits; `None` when it cannot be stored (or is
/// already a reference, which Node drops the same way).
async fn reference_part(part: &Value, files: &dyn AttachmentFiles) -> Option<Value> {
    let object = part.as_object()?;
    if object.get("attachmentRef").and_then(Value::as_str).is_some_and(|r| r.len() == 64 && r.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
        return None;
    }
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let source = object.get("source").filter(|s| s.get("type").and_then(Value::as_str) == Some("base64"));
    let (data, mut metadata) = match object.get("type").and_then(Value::as_str)? {
        "image" => match (text(object.get("data")).filter(|d| !d.is_empty()), source) {
            (Some(data), _) => {
                let mut rest = object.clone();
                rest.shift_remove("data");
                (data, rest)
            }
            (None, Some(source)) => {
                let data = text(source.get("data")).filter(|d| !d.is_empty())?;
                let mut rest = object.clone();
                for key in ["source", "mimeType", "mediaType"] {
                    rest.shift_remove(key);
                }
                if let Some(mime) = text(source.get("media_type")).or_else(|| text(source.get("mediaType"))).filter(|m| !m.is_empty()) {
                    rest.insert("mimeType".into(), Value::String(mime));
                }
                (data, rest)
            }
            _ => return None,
        },
        "document" => {
            let source = source?;
            let data = text(source.get("data"))?;
            let mut rest = object.clone();
            for key in ["source", "type", "mimeType", "mediaType"] {
                rest.shift_remove(key);
            }
            let mime = [source.get("media_type"), source.get("mediaType"), object.get("mimeType"), object.get("mediaType")]
                .into_iter()
                .filter_map(text)
                .find(|m| !m.is_empty())
                .map(|m| mixdog_js::js_trim(&m).to_lowercase())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| "application/pdf".into());
            rest.insert("type".into(), Value::String("file".into()));
            rest.insert("mimeType".into(), Value::String(mime));
            if let Some(name) = text(object.get("title")).filter(|n| !n.is_empty()).or_else(|| text(object.get("filename")).filter(|n| !n.is_empty())) {
                rest.insert("filename".into(), Value::String(name));
            }
            (data, rest)
        }
        "file" => {
            let data = text(object.get("data"))?;
            let mut rest = object.clone();
            rest.shift_remove("data");
            (data, rest)
        }
        _ => return None,
    };
    // A payload that would not re-encode to the same base64 string could not be replayed exactly.
    let bytes = STANDARD.decode(&data).ok().filter(|bytes| !bytes.is_empty() && STANDARD.encode(bytes) == data)?;
    if metadata.get("type").and_then(Value::as_str) == Some("file") && bytes.starts_with(b"%PDF-") {
        metadata.insert("mimeType".into(), Value::String("application/pdf".into()));
    }
    let mime = text(metadata.get("mimeType")).unwrap_or_default();
    let filename = text(metadata.get("filename")).unwrap_or_default();
    let stored = files.store_inline(&data, &mime, &filename).await?;
    metadata.insert("attachmentRef".into(), Value::String(stored.reference));
    metadata.insert("sizeBytes".into(), Value::from(stored.size_bytes));
    Some(Value::Object(metadata))
}

/// `RoutineSessions` over the session directory, the unattended-run registry, the agent
/// tool's foreground run and the home delivery.
pub struct CoreRoutineSessions {
    directory: Arc<SessionDirectory>,
    unattended: Arc<UnattendedRunRegistry>,
    agents: Arc<dyn ExecutorAgents>,
    files: Arc<dyn AttachmentFiles>,
    delivery: Arc<dyn ResultDelivery>,
}

impl CoreRoutineSessions {
    pub fn new(
        directory: Arc<SessionDirectory>,
        unattended: Arc<UnattendedRunRegistry>,
        agents: Arc<dyn ExecutorAgents>,
        files: Arc<dyn AttachmentFiles>,
        delivery: Arc<dyn ResultDelivery>,
    ) -> Arc<Self> {
        Arc::new(Self { directory, unattended, agents, files, delivery })
    }
}

fn run_kind(kind: RoutineKind) -> RunKind {
    if kind == RoutineKind::Webhook { RunKind::Webhook } else { RunKind::Schedule }
}

#[async_trait]
impl RoutineSessions for CoreRoutineSessions {
    async fn home_thread_open(&self, session_id: &str) -> Result<bool, String> {
        self.directory
            .home_thread_open(&ThreadId::from(session_id))
            .await
            .map_err(|_| "the home thread's record could not be read: its lane did not run the read".to_owned())
    }

    /// The turn rides the thread's queue; once it starts the thread is an unattended run of its
    /// owner (it never asks), until the turn settles. A step only a person can do ends it.
    async fn run_turn(&self, turn: RoutineTurn, cancel: CancellationToken) -> TurnSettle {
        let held: Arc<Mutex<Option<RunMark>>> = Arc::default();
        let on_start = {
            let (registry, held, thread, agent, name, kind) =
                (self.unattended.clone(), held.clone(), turn.session_id.clone(), turn.agent_id.clone(), turn.name.clone(), run_kind(turn.kind));
            Box::new(move || *held.lock().unwrap_or_else(PoisonError::into_inner) = registry.mark(&thread, kind, &agent, &name))
        };
        let thread = turn.session_id.clone();
        let settle = self.directory.run_routine_turn(turn, on_start, cancel).await;
        // Read before unmarking.
        let human = self.unattended.human_needed_of(&thread);
        held.lock().unwrap_or_else(PoisonError::into_inner).take();
        match human {
            Some((outcome, site)) => TurnSettle::HumanNeeded(human_needed_text(&outcome, &site)),
            None => settle,
        }
    }

    /// The executor is created under `routine_exec_<uuid>`, marked as this routine's unattended
    /// run for as long as it works.
    async fn run_executor(&self, run: ExecutorRun, cancel: CancellationToken) -> Result<String, String> {
        let parent = format!("routine_exec_{}", uuid::Uuid::new_v4());
        let _mark = self.unattended.mark(&parent, run_kind(run.kind), &run.owner_agent_id, &run.name);
        let mut args = json!({ "agent": run.agent_id, "prompt": run.prompt, "skillSelection": run.skill_selection });
        if let Some(cwd) = run.cwd.as_deref().filter(|c| !c.is_empty()) {
            args["cwd"] = Value::String(cwd.to_owned());
        }
        let mut references: Vec<Value> = Vec::new();
        for part in &run.attachment_parts {
            references.extend(reference_part(part, &*self.files).await);
        }
        if !references.is_empty() {
            args["attachmentParts"] = Value::Array(references);
        }
        match self.agents.run_to_completion(&args, &parent, &cancel).await {
            Ok(content) => Ok(mixdog_js::js_trim(&content).to_owned()),
            // The caller's own cancellation stays as it is.
            Err(error) if cancel.is_cancelled() => Err(error),
            Err(error) => Err(format!("{} \"{}\": executor agent \"{}\" failed: {error}", run.kind.word(), run.name, run.agent_id)),
        }
    }

    async fn deliver_result(&self, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<(), String> {
        self.delivery.enqueue(owner_agent_id, name, item).await
    }

    async fn announce_run(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun) -> Result<(), String> {
        self.delivery.announce(owner_agent_id, name, run).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Agents {
        mixy: Mutex<Option<Result<bool, String>>>,
        asked_stored: Mutex<Vec<bool>>,
        presence: HashMap<&'static str, Presence>,
        archived: Vec<&'static str>,
    }

    #[async_trait]
    impl RoutineAgents for Agents {
        async fn mixy_exists(&self, stored: bool) -> Result<bool, String> {
            self.asked_stored.lock().unwrap().push(stored);
            self.mixy.lock().unwrap().clone().unwrap()
        }
        async fn presence(&self, id: &str) -> Result<Presence, String> {
            Ok(self.presence.get(id).copied().unwrap_or(Presence::Present))
        }
        async fn archived(&self, id: &str) -> Result<bool, String> {
            Ok(self.archived.contains(&id))
        }
        async fn executor_facts(&self, _id: &str) -> Result<ExecutorFacts, String> {
            Ok(ExecutorFacts { listed: true, contact: false, disabled: false })
        }
    }

    struct Sessions;

    #[async_trait]
    impl RoutineSessions for Sessions {
        async fn home_thread_open(&self, id: &str) -> Result<bool, String> {
            Ok(id == "sess_home_open")
        }
        async fn run_turn(&self, _turn: RoutineTurn, _cancel: CancellationToken) -> TurnSettle {
            TurnSettle::Done { result: "ok".into() }
        }
        async fn run_executor(&self, _run: ExecutorRun, _cancel: CancellationToken) -> Result<String, String> {
            Ok("report".into())
        }
        async fn deliver_result(&self, _owner: &str, _name: &str, _item: &DeliveryItem) -> Result<(), String> {
            Ok(())
        }
        async fn announce_run(&self, _owner: &str, _name: &str, _run: &AnnouncedRun) -> Result<(), String> {
            Ok(())
        }
    }

    fn host(agents: Agents) -> (Arc<SessionRoutineHost>, Arc<Agents>, Arc<HeartbeatSessions>) {
        let agents = Arc::new(agents);
        let marks = HeartbeatSessions::new();
        (SessionRoutineHost::new(agents.clone(), Arc::new(Sessions), marks.clone()), agents, marks)
    }

    #[tokio::test]
    async fn mixy_owns_a_routine_only_while_she_exists_and_a_stored_one_is_asked_as_such() {
        let (host, agents, _) = host(Agents::default());
        *agents.mixy.lock().unwrap() = Some(Ok(false));
        assert_eq!(host.owner_problem(MIXY_AGENT_ID, false).await, Ok(Some(OwnerProblem::NoMixy)));
        *agents.mixy.lock().unwrap() = Some(Ok(true));
        assert_eq!(host.owner_problem(MIXY_AGENT_ID, true).await, Ok(None));
        assert_eq!(*agents.asked_stored.lock().unwrap(), [false, true]);
        *agents.mixy.lock().unwrap() = Some(Err("unreadable".into()));
        assert_eq!(host.owner_problem(MIXY_AGENT_ID, true).await, Err("unreadable".into()), "a read fault never pauses anything");
    }

    #[tokio::test]
    async fn a_bot_pauses_its_routines_only_when_proven_deleted_and_archived_ones_wait_for_the_restore() {
        let presence = HashMap::from([("gone", Presence::Deleted), ("shelved", Presence::Deleted), ("odd", Presence::Unknown)]);
        let (host, ..) = host(Agents { presence, archived: vec!["shelved"], ..Agents::default() });
        assert_eq!(host.owner_problem("gone", true).await, Ok(Some(OwnerProblem::OwnerDeleted)));
        assert_eq!(host.owner_problem("shelved", true).await, Ok(Some(OwnerProblem::OwnerArchived)));
        assert_eq!(host.owner_problem("odd", true).await, Ok(None));
        assert_eq!(host.owner_problem("fine", true).await, Ok(None));
    }

    #[tokio::test]
    async fn a_thread_is_a_heartbeat_session_exactly_while_it_is_marked() {
        let (host, _, marks) = host(Agents::default());
        assert!(!host.is_heartbeat_session("sess_hb"));
        marks.mark("sess_hb");
        assert!(host.is_heartbeat_session("sess_hb"));
        marks.unmark("sess_hb");
        assert!(!host.is_heartbeat_session("sess_hb"));
        assert!(host.home_thread_open("sess_home_open").await.unwrap());
    }

    // ---- the real sessions ----

    use mixdog_core_ports::ports::run_stamps::RunStamps;
    use mixdog_core_session::session::testing::Rig;
    use mixdog_services::bots::{RoutineTrigger, TurnSettle as Settle};

    use super::super::mcp_seams::UnattendedRuns;

    struct NoStamps;
    #[async_trait]
    impl RunStamps for NoStamps {
        async fn stamp_of(&self, _: &ThreadId) -> Option<Value> {
            None
        }
    }

    #[derive(Default)]
    struct Agent {
        calls: Mutex<Vec<(Value, String)>>,
        registry: Mutex<Option<Arc<UnattendedRunRegistry>>>,
        marked_during: Mutex<Vec<bool>>,
        answer: Mutex<Option<Result<String, String>>>,
    }

    #[async_trait]
    impl ExecutorAgents for Agent {
        async fn run_to_completion(&self, args: &Value, caller: &str, _cancel: &CancellationToken) -> Result<String, String> {
            self.calls.lock().unwrap().push((args.clone(), caller.to_owned()));
            let registry = self.registry.lock().unwrap().clone().unwrap();
            let run = registry.run_of(&ThreadId::from(caller)).await.map(|run| (run.kind, run.agent_id));
            self.marked_during.lock().unwrap().push(run == Some((RunKind::Webhook, "gh-bot".to_owned())));
            self.answer.lock().unwrap().clone().unwrap()
        }
    }

    struct Files;
    #[async_trait]
    impl AttachmentFiles for Files {
        async fn store_inline(&self, base64: &str, mime: &str, filename: &str) -> Option<super::super::attachment_reference::StoredFile> {
            Some(super::super::attachment_reference::StoredFile { reference: format!("{}:{mime}:{filename}", base64.len()), size_bytes: 3 })
        }
        async fn named_file(&self, _: &str, _: &str, _: &str, _: Option<&super::super::attachment_reference::OriginalFile>) -> Result<String, ()> {
            Err(())
        }
        fn blob_path(&self, reference: &str) -> Result<String, super::super::attachment_reference::InvalidReference> {
            Ok(reference.to_owned())
        }
    }

    #[derive(Default)]
    struct Delivery(Mutex<Vec<String>>);
    #[async_trait]
    impl ResultDelivery for Delivery {
        async fn enqueue(&self, owner: &str, name: &str, item: &DeliveryItem) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("enqueue {owner} {name} {}", item.run_id));
            Ok(())
        }
        async fn announce(&self, owner: &str, name: &str, run: &AnnouncedRun) {
            self.0.lock().unwrap().push(format!("announce {owner} {name} {}", run.state));
        }
    }

    struct Setup {
        sessions: Arc<CoreRoutineSessions>,
        registry: Arc<UnattendedRunRegistry>,
        directory: Arc<SessionDirectory>,
        agent: Arc<Agent>,
        delivery: Arc<Delivery>,
        rig: Rig,
    }

    fn setup() -> Setup {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let registry = UnattendedRunRegistry::new(Arc::new(NoStamps));
        let (agent, delivery) = (Arc::new(Agent::default()), Arc::new(Delivery::default()));
        *agent.registry.lock().unwrap() = Some(registry.clone());
        let sessions = CoreRoutineSessions::new(directory.clone(), registry.clone(), agent.clone(), Arc::new(Files), delivery.clone());
        Setup { sessions, registry, directory, agent, delivery, rig }
    }

    fn turn(thread: &str) -> RoutineTurn {
        RoutineTurn {
            id: "routine_1".into(),
            session_id: thread.into(),
            agent_id: "lead".into(),
            kind: RoutineKind::Schedule,
            name: "daily".into(),
            content: json!("Header\n\nbody"),
            skill_selection: "body".into(),
            trigger: RoutineTrigger { kind: RoutineKind::Schedule, name: "daily".into(), event: None },
        }
    }

    /// The thread is an unattended run of its owner exactly while the routine's turn runs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_routine_turn_is_an_unattended_run_only_while_it_runs() {
        let s = setup();
        let seen: Arc<Mutex<Vec<Option<(RunKind, String)>>>> = Arc::default();
        let (registry, record) = (s.registry.clone(), seen.clone());
        s.rig.set_script(Arc::new(move |run| {
            let (registry, record) = (registry.clone(), record.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let marked = registry.run_of(&run.thread).await.map(|r| (r.kind, r.agent_id));
                record.lock().unwrap().push(marked);
                mixdog_core_session::session::RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult { content: "ok".into(), ..Default::default() }))
            })
        }));
        let thread = ThreadId::from("sess_home_lead");
        s.directory.create_with_id(thread.clone(), serde_json::Map::new(), json!({})).await.unwrap();
        assert!(s.sessions.home_thread_open(thread.as_str()).await.unwrap());
        assert!(!s.sessions.home_thread_open("sess_none").await.unwrap());
        let settle = s.sessions.run_turn(turn(thread.as_str()), CancellationToken::new()).await;
        assert_eq!(settle, Settle::Done { result: "ok".into() });
        assert_eq!(*seen.lock().unwrap(), [Some((RunKind::Schedule, "lead".to_owned()))]);
        assert!(s.registry.run_of(&thread).await.is_none(), "unmarked once it settled");
    }

    /// A step only a person can do ends the turn with the human-needed text, whatever the turn did.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_step_for_a_person_ends_the_routine_with_its_text() {
        let s = setup();
        let registry = s.registry.clone();
        s.rig.set_script(Arc::new(move |run| {
            let registry = registry.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                assert!(registry.fail_for_human(run.thread.as_str(), "login_required", "  example.com \n login "));
                mixdog_core_session::session::RunOutcome::Completed(Box::default())
            })
        }));
        let thread = ThreadId::from("sess_home_lead");
        s.directory.create_with_id(thread.clone(), serde_json::Map::new(), json!({})).await.unwrap();
        let settle = s.sessions.run_turn(turn(thread.as_str()), CancellationToken::new()).await;
        assert_eq!(settle, Settle::HumanNeeded("Sign-in required: example.com login".into()));
        assert!(!s.registry.fail_for_human("sess_not_a_run", "login_required", "x"));
        assert_eq!(human_needed_text("anything", ""), "Action required: the site");
        assert_eq!(human_needed_text("sensitive_confirmation_required", "bank"), "Confirmation required: bank");
    }

    fn executor_run(attachments: Vec<Value>) -> ExecutorRun {
        ExecutorRun {
            agent_id: "worker".into(),
            kind: RoutineKind::Webhook,
            name: "hook".into(),
            owner_agent_id: "gh-bot".into(),
            prompt: "Do it".into(),
            skill_selection: "skills".into(),
            cwd: Some("/work".into()),
            attachment_parts: attachments,
        }
    }

    /// The executor runs under a `routine_exec_` id marked as the routine's run, with the stored
    /// references of its attachments; its report is trimmed; a failure names the routine and the
    /// agent unless the caller cancelled.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_executor_runs_marked_with_references_and_its_failure_is_named() {
        let s = setup();
        let png = STANDARD.encode(b"abc");
        let parts = vec![
            json!({ "type": "image", "data": png, "mimeType": "image/png", "filename": "a.png" }),
            json!({ "type": "image", "data": "not base64!" }),
            json!({ "type": "image", "attachmentRef": "a".repeat(64) }),
        ];
        *s.agent.answer.lock().unwrap() = Some(Ok("  report \n".into()));
        assert_eq!(s.sessions.run_executor(executor_run(parts), CancellationToken::new()).await, Ok("report".into()));
        let (args, caller) = s.agent.calls.lock().unwrap()[0].clone();
        assert!(caller.starts_with("routine_exec_"));
        assert_eq!(args["agent"], "worker");
        assert_eq!(args["prompt"], "Do it");
        assert_eq!(args["skillSelection"], "skills");
        assert_eq!(args["cwd"], "/work");
        assert_eq!(args["attachmentParts"], json!([{ "type": "image", "mimeType": "image/png", "filename": "a.png", "attachmentRef": "4:image/png:a.png", "sizeBytes": 3 }]));
        assert_eq!(*s.agent.marked_during.lock().unwrap(), [true]);
        assert!(s.registry.run_of(&ThreadId::from(caller.as_str())).await.is_none(), "unmarked when it ends");

        *s.agent.answer.lock().unwrap() = Some(Err("boom".into()));
        assert_eq!(
            s.sessions.run_executor(executor_run(Vec::new()), CancellationToken::new()).await,
            Err("webhook \"hook\": executor agent \"worker\" failed: boom".into())
        );
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert_eq!(s.sessions.run_executor(executor_run(Vec::new()), cancelled).await, Err("boom".into()));
    }

    /// Node's `storeInlineImagePart`/`storeInlineDocumentPart` (real module, recorded): a removed
    /// key leaves the others in place and the keys they add come last, in Node's order.
    #[tokio::test]
    async fn a_stored_reference_part_keeps_nodes_key_order() {
        struct Ref;
        #[async_trait]
        impl AttachmentFiles for Ref {
            async fn store_inline(&self, _: &str, _: &str, _: &str) -> Option<super::super::attachment_reference::StoredFile> {
                Some(super::super::attachment_reference::StoredFile { reference: "ref".into(), size_bytes: 4 })
            }
            async fn named_file(&self, _: &str, _: &str, _: &str, _: Option<&super::super::attachment_reference::OriginalFile>) -> Result<String, ()> {
                Err(())
            }
            fn blob_path(&self, _: &str) -> Result<String, super::super::attachment_reference::InvalidReference> {
                Ok(String::new())
            }
        }
        let png = STANDARD.encode([1u8, 2, 3, 4]);
        let pdf = STANDARD.encode(b"%PDF-1.4 hello");
        let cases = [
            (json!({ "type": "image", "alt": "a", "data": png, "mimeType": "image/png", "z": 1 }),
             r#"{"type":"image","alt":"a","mimeType":"image/png","z":1,"attachmentRef":"ref","sizeBytes":4}"#),
            (json!({ "type": "image", "alt": "a", "source": { "type": "base64", "data": png, "media_type": "image/jpeg" }, "mimeType": "x", "mediaType": "y", "z": 1 }),
             r#"{"type":"image","alt":"a","z":1,"mimeType":"image/jpeg","attachmentRef":"ref","sizeBytes":4}"#),
            (json!({ "type": "document", "title": "T", "source": { "type": "base64", "data": pdf, "media_type": "text/plain" }, "extra": 1 }),
             r#"{"title":"T","extra":1,"type":"file","mimeType":"application/pdf","filename":"T","attachmentRef":"ref","sizeBytes":4}"#),
            (json!({ "type": "file", "name": "n", "data": png, "mimeType": "application/octet-stream", "extra": 1 }),
             r#"{"type":"file","name":"n","mimeType":"application/octet-stream","extra":1,"attachmentRef":"ref","sizeBytes":4}"#),
        ];
        for (part, want) in cases {
            assert_eq!(reference_part(&part, &Ref).await.expect("stored").to_string(), want);
        }
    }

    /// Results and run rows go to the one home delivery.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn results_and_run_rows_go_to_the_home_delivery() {
        let s = setup();
        let item = DeliveryItem { run_id: "run_1".into(), kind: RoutineKind::Schedule, ok: true, text: "done".into(), run_session_id: None, reason: None, paused: None };
        s.sessions.deliver_result("lead", "daily", &item).await.unwrap();
        s.sessions.announce_run("lead", "daily", &AnnouncedRun { item, state: "undelivered" }).await.unwrap();
        assert_eq!(*s.delivery.0.lock().unwrap(), ["enqueue lead daily run_1", "announce lead daily undelivered"]);
    }
}
