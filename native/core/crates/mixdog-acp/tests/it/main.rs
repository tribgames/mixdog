//! The runner against a fake agent: a real process that speaks the protocol over its stdio,
//! started through the process manager. No test needs an agent's own CLI or the network.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_acp::agents::AccountEvent;
use mixdog_acp::agents::Agents;
use mixdog_acp::agents::AgentsParts;
use mixdog_acp::agents::Readiness;
use mixdog_acp::agents::Refusal;
use mixdog_acp::agents::Refusals;
use mixdog_acp::files::TextFiles;
use mixdog_acp::mcp::BATCH_TOOL;
use mixdog_acp::mcp::SessionTools;
use mixdog_acp::preset::AgentPreset;
use mixdog_acp::preset::Command;
use mixdog_acp::preset::Location;
use mixdog_acp::preset::Upkeep;
use mixdog_acp::routes::AgentRouteFacts;
use mixdog_acp::routes::AgentRouteWriter;
use mixdog_acp::runs::Attachments;
use mixdog_acp::runs::Conversation;
use mixdog_acp::runs::Stored;
use mixdog_acp::runs::TurnRequest;
use mixdog_acp::runs::WAKE_TEXT;
use mixdog_acp::surface::CallMark;
use mixdog_acp::surface::CompactEvent;
use mixdog_acp::surface::TurnSurface;
use mixdog_acp::surface::TurnUsage;
use mixdog_acp::turn::Ask;
use mixdog_acp::turn::TurnContext;
use mixdog_acp::turn::TurnEnd;
use mixdog_agent::env::CompactStatus;
use mixdog_agent::env::GateAsk;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateDecision;
use mixdog_agent::env::ToolGate;
use mixdog_agent::env::ToolHooks;
use mixdog_agent::handed::HandedCalls;
use mixdog_agent::handed::HandedParts;
use mixdog_agent::tools::ToolEnv;
use mixdog_agent::tools::ToolSet;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::tool::FollowUpMessage;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_domains::domains::ai_admin::chain::RouteFacts;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route_write::RouteWriter;
use mixdog_core_session::session::ItemCommit;
use mixdog_core_session::session::run::RunError;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ItemId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::TurnId;
use mixdog_store::schema::record::HeaderChange;
use mixdog_tools::orch::bridge::CallResolution;
use mixdog_tools::orch::bridge::CallTool;
use mixdog_tools::orch::bridge::CatalogView;
use mixdog_tools::orch::bridge::LoadTool;
use mixdog_tools::orch::bridge::ToolDispatcher;
use mixdog_tools::orch::bridge::ToolDoc;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
enum Event {
    Started(ThreadItem),
    Delta(String),
    Settled,
    ReasoningDelta(String),
    ReasoningDone(String),
    Commit(ItemCommit),
    Notice(String),
    Usage(TurnUsage),
    Header(HeaderChange),
    /// A step of the turn the spinner was told of.
    Mark(CallMark),
    /// A stage the spinner was told of.
    Stage(String),
    /// A compaction pass's marker.
    Compact(CompactStatus),
    /// A progress record of what the turn streamed.
    Draft(Value),
}

/// Where the agents' refusals are kept: what a restart of the app finds again.
#[derive(Default)]
struct Kept(Mutex<HashMap<String, String>>);

#[async_trait]
impl Refusals for Kept {
    async fn read(&self) -> HashMap<String, String> {
        self.0.lock().unwrap().clone()
    }

    async fn keep(&self, refusals: HashMap<String, String>) {
        *self.0.lock().unwrap() = refusals;
    }
}

/// What the turns of a world are served with besides the agent.
#[derive(Clone, Default)]
struct Turns {
    /// The summary the session's compaction makes of the conversation before the turn: none for a session that holds
    /// none, the reason for one that cannot be made.
    summary: Option<Result<&'static str, &'static str>>,
    /// The session's tools, each call run by the loop's own execution of one.
    calls: Option<Arc<HandedCalls>>,
    /// The agent's context reached the session's compaction trigger.
    due: Option<mixdog_acp::runs::Due>,
    /// The turn is stopped with this token while the summary is being made, which then never comes.
    stops_summary: Option<CancellationToken>,
    /// The turn is stopped with this token as the attachment `stop` is read for the prompt, before the prompt is sent.
    stops_sending: Option<CancellationToken>,
}

#[async_trait]
impl Conversation for Turns {
    async fn hand_over(&self) -> Result<Option<String>, String> {
        if let Some(stop) = &self.stops_summary {
            stop.cancel();
            std::future::pending::<()>().await;
        }
        self.summary.map(|summary| summary.map(str::to_owned).map_err(str::to_owned)).transpose()
    }

    fn hand_over_summarizes(&self) -> bool {
        self.summary.is_some() || self.stops_summary.is_some()
    }

    fn compaction_due(&self) -> Option<mixdog_acp::runs::Due> {
        self.due
    }
}

/// The folder the stored attachments of a test's session are kept in.
const ATTACHMENTS: &str = "C:\\data dir\\blobs";

#[async_trait]
impl Attachments for Turns {
    async fn bytes(&self, reference: &str) -> Option<Vec<u8>> {
        match reference {
            "stored" => Some(b"png".to_vec()),
            "note" => Some(b"# Notes\nplover".to_vec()),
            // No text: a PDF's bytes.
            "paper" => Some(b"%PDF-1.4\n\xff\xfe\x00".to_vec()),
            "stop" => {
                if let Some(stop) = &self.stops_sending {
                    stop.cancel();
                }
                Some(b"stop".to_vec())
            }
            _ => None,
        }
    }

    fn path(&self, reference: &str) -> Option<String> {
        matches!(reference, "note" | "paper").then(|| format!("{ATTACHMENTS}\\{reference}"))
    }
}

#[derive(Default)]
struct Recorded {
    /// The session does not take a row that makes a tool call: its commit fails.
    refuses_calls: AtomicBool,
    events: Mutex<Vec<Event>>,
    asks: Mutex<Vec<ApprovalAsk>>,
    /// The answers the next approvals get; none left answers as a session with no approval surface.
    answers: Mutex<VecDeque<ApprovalResolution>>,
    /// The turn's own surface refuses a call's result row and stops the turn with this token; the closing one takes it.
    stops_at_result: Mutex<Option<CancellationToken>>,
    changed: Notify,
}

/// A surface that records what a turn reports; `.1` is the surface a stopped turn is closed on.
#[derive(Clone, Default)]
struct Surface(Arc<Recorded>, bool);

impl Surface {
    fn record(&self, event: Event) -> Result<(), RunError> {
        self.0.events.lock().unwrap().push(event);
        self.0.changed.notify_waiters();
        Ok(())
    }

    fn events(&self) -> Vec<Event> {
        self.0.events.lock().unwrap().clone()
    }

    /// The committed rows' bodies, in order.
    fn rows(&self) -> Vec<Value> {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                Event::Commit(item) => Some(item.body),
                _ => None,
            })
            .collect()
    }

    /// The text the turn streamed, deltas joined.
    fn streamed(&self) -> String {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                Event::Delta(text) => Some(text),
                _ => None,
            })
            .collect()
    }

    /// The notices the turn showed.
    fn notices(&self) -> Vec<String> {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                Event::Notice(text) => Some(text),
                _ => None,
            })
            .collect()
    }

    async fn until(&self, seen: impl Fn(&[Event]) -> bool) {
        loop {
            let changed = self.0.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if seen(&self.events()) {
                return;
            }
            changed.await;
        }
    }
}

#[async_trait]
impl TurnSurface for Surface {
    async fn item_started(&self, item: ThreadItem) -> Result<(), RunError> {
        self.record(Event::Started(item))
    }

    async fn delta(&self, _item: ItemId, text: String) -> Result<(), RunError> {
        self.record(Event::Delta(text))
    }

    async fn text_settled(&self, _item: ItemId) -> Result<(), RunError> {
        self.record(Event::Settled)
    }

    async fn reasoning_delta(&self, _item: ItemId, text: String) -> Result<(), RunError> {
        self.record(Event::ReasoningDelta(text))
    }

    async fn reasoning_completed(&self, _item: ItemId, text: String) -> Result<(), RunError> {
        self.record(Event::ReasoningDone(text))
    }

    async fn commit(&self, item: ItemCommit) -> Result<(), RunError> {
        if self.0.refuses_calls.load(Ordering::SeqCst) && item.body["toolCalls"].as_array().is_some_and(|calls| !calls.is_empty()) {
            return Err(RunError::Closed);
        }
        if !self.1
            && item.role.as_deref() == Some("tool")
            && let Some(stop) = self.0.stops_at_result.lock().unwrap().clone()
        {
            stop.cancel();
            return Err(RunError::Closed);
        }
        self.record(Event::Commit(item))
    }

    async fn notice(&self, text: String, _warn: bool) -> Result<(), RunError> {
        self.record(Event::Notice(text))
    }

    async fn usage(&self, usage: TurnUsage) -> Result<(), RunError> {
        self.record(Event::Usage(usage))
    }

    async fn draft(&self, body: Value) -> Result<(), RunError> {
        self.record(Event::Draft(body))
    }

    async fn save_header(&self, change: HeaderChange) -> Result<(), RunError> {
        self.record(Event::Header(change))
    }

    async fn call_mark(&self, mark: CallMark) -> Result<(), RunError> {
        self.record(Event::Mark(mark))
    }

    async fn stage(&self, stage: &str) -> Result<(), RunError> {
        self.record(Event::Stage(stage.to_owned()))
    }

    async fn compact_event(&self, event: CompactEvent) -> Result<(), RunError> {
        self.record(Event::Compact(event.status))
    }

    async fn approve(&self, ask: ApprovalAsk) -> ApprovalResolution {
        self.0.asks.lock().unwrap().push(ask);
        self.0.answers.lock().unwrap().pop_front().unwrap_or(ApprovalResolution::Unavailable { at: 0 })
    }

    fn call_epoch(&self) -> u64 {
        0
    }

    fn closing(&self) -> Arc<dyn TurnSurface> {
        Arc::new(Self(self.0.clone(), true))
    }
}

/// The files of the machine the test runs on; `.0` are the places that were opened.
struct Files(Arc<Mutex<Vec<std::path::PathBuf>>>);

#[async_trait]
#[allow(clippy::disallowed_methods, reason = "a test's own files")]
impl TextFiles for Files {
    async fn read(&self, path: AbsPath) -> Result<String, String> {
        self.0.lock().unwrap().push(path.as_path().to_path_buf());
        std::fs::read_to_string(path.as_path()).map_err(|error| error.to_string())
    }

    async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
        let resolved = std::fs::canonicalize(path.as_path()).map_err(|error| error.to_string())?;
        AbsPath::new(resolved).ok_or_else(|| "not absolute".to_owned())
    }

    // The agent definitions are made as the core makes them.
    async fn create(&self, path: AbsPath, text: String) -> Result<(), String> {
        let files = mixdog_acp::files::ServiceFiles {
            files: Arc::new(mixdog_workspace::localfs::LocalFileService::new()),
            lane: mixdog_rt::testing::tokens().interactive_io,
        };
        files.create(path, text).await
    }
}

struct World {
    agents: Arc<Agents>,
    processes: Arc<dyn ProcessManager>,
    preset: AgentPreset,
    enabled: Arc<AtomicBool>,
    /// The threads a wake asked a turn for.
    woken: Arc<(Mutex<Vec<ThreadId>>, Notify)>,
    /// The places the agent's file reads opened.
    opened: Arc<Mutex<Vec<std::path::PathBuf>>>,
    /// What the agents keep across a restart of the app.
    refusals: Arc<Kept>,
    dir: tempfile::TempDir,
}

/// The agents of an app that starts over `preset` in `dir`: what `refusals` keeps is all they share with the ones before.
fn agents_of(
    preset: &AgentPreset,
    processes: &Arc<dyn ProcessManager>,
    opened: &Arc<Mutex<Vec<std::path::PathBuf>>>,
    enabled: &Arc<AtomicBool>,
    refusals: &Arc<Kept>,
    dir: &std::path::Path,
) -> Arc<Agents> {
    let home = dir.join("home").to_string_lossy().into_owned();
    Agents::new(AgentsParts {
        refusals: refusals.clone(),
        presets: vec![preset.clone()],
        processes: processes.clone(),
        files: Arc::new(Files(opened.clone())),
        enabled: {
            let enabled = enabled.clone();
            Arc::new(move || enabled.load(Ordering::SeqCst))
        },
        changed: Arc::new(|| {}),
        probe_cwd: dir.to_path_buf(),
        definitions: dir.join("acp-agents"),
        env: Arc::new(move |name: &str| (name == "FAKE_HOME").then(|| home.clone())),
        mcp_bridge: Some(Command { program: mixdog_testkit::bin_exe!("mixdog-acp-fake-agent"), args: vec!["mcp-bridge".into()] }),
    })
}

impl World {
    /// The feature on, over the fake agent with `settings`.
    fn new(settings: &[(&str, &str)]) -> Self {
        Self::build(settings, |_, _| {})
    }

    /// As [`World::new`], with the preset changed by `customize` (which is given the world's folder).
    fn build(settings: &[(&str, &str)], customize: impl FnOnce(&mut AgentPreset, &std::path::Path)) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        // Every run of the fake starts in the world's folder and reads its settings there.
        let mut lines: Vec<String> = settings.iter().map(|(name, value)| format!("{name}={value}")).collect();
        lines.extend([
            format!("FAKE_AGENT_LOG={}", file("agent.log")),
            format!("FAKE_AGENT_VERSION_FILE={}", file("version")),
            format!("FAKE_AGENT_SIGNED_IN_FILE={}", file("signed-in")),
            format!("FAKE_AGENT_SIGNED_OUT_FILE={}", file("signed-out")),
        ]);
        #[allow(clippy::disallowed_methods, reason = "a test writes the fake agent's settings")]
        std::fs::write(dir.path().join("fake-agent.env"), lines.join("\n")).expect("the fake's settings");
        let mut preset = mixdog_acp::preset::builtin().remove(0);
        preset.command = mixdog_testkit::bin_exe!("mixdog-acp-fake-agent");
        preset.args = vec!["acp".into()];
        // A session handed tools starts the fake in a folder of its own, which has no settings file.
        preset.env.extend(lines.iter().filter_map(|line| line.split_once('=')).map(|(name, value)| (name.to_owned(), value.to_owned())));
        // No test runs the vendor's installer.
        preset.upkeep = Upkeep { installer: None, installed_at: Vec::new(), update_args: Some(vec!["update".into()]) };
        customize(&mut preset, dir.path());
        let processes: Arc<dyn ProcessManager> =
            Arc::new(mixdog_spawn::LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, mixdog_spawn::ProcessConfig::default()));
        let enabled = Arc::new(AtomicBool::new(true));
        let opened: Arc<Mutex<Vec<std::path::PathBuf>>> = Arc::default();
        let woken: Arc<(Mutex<Vec<ThreadId>>, Notify)> = Arc::default();
        #[allow(clippy::disallowed_methods, reason = "a test writes the file its agent reads")]
        std::fs::write(dir.path().join("note.txt"), "hello\nsecond line\n").expect("the note");
        let refusals: Arc<Kept> = Arc::default();
        let agents = agents_of(&preset, &processes, &opened, &enabled, &refusals, dir.path());
        agents.bind_wake({
            let woken = woken.clone();
            Arc::new(move |thread: &ThreadId| {
                woken.0.lock().unwrap().push(thread.clone());
                woken.1.notify_waiters();
            })
        });
        Self { agents, processes, preset, enabled, woken, opened, refusals, dir }
    }

    /// The app is started again: new agents, over what the ones before kept.
    fn restart(&mut self) {
        self.agents.release_all();
        self.agents = agents_of(&self.preset, &self.processes, &self.opened, &self.enabled, &self.refusals, self.dir.path());
    }

    /// Waits for the fake agent to have logged `line`.
    async fn logs(&self, line: &str) {
        within(line, async {
            while self.logged(line) == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
    }

    fn cwd(&self) -> AbsPath {
        AbsPath::new(self.dir.path()).expect("an absolute temp dir")
    }

    /// What the fake agent was asked, a line per start and per method.
    fn log(&self) -> Vec<String> {
        #[allow(clippy::disallowed_methods, reason = "a test reads the fake agent's own log")]
        let text = std::fs::read_to_string(self.dir.path().join("agent.log")).unwrap_or_default();
        text.lines().map(str::to_owned).collect()
    }

    /// The settings value's entry of the one agent once the feature's own check of it has ended.
    async fn checked(&self) -> Value {
        self.agents.recheck();
        within("the check", self.agents.look(&self.preset)).await;
        self.agents.status()["agents"][0].clone()
    }

    fn logged(&self, line: &str) -> usize {
        self.log().iter().filter(|logged| *logged == line).count()
    }

    /// Waits for every process the world started to have exited.
    async fn all_exited(&self) {
        within("every process to exit", async {
            while self.processes.list().iter().any(|process| process.exit.is_none()) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
    }

    fn context(&self, cancel: CancellationToken) -> TurnContext {
        TurnContext {
            turn: TurnId::from("turn-1"),
            model: "default".into(),
            effort: None,
            now_ms: Arc::new(|| 0_i64),
            cancel,
            progress: None,
            calls: None,
            on_tool_result: None,
            record: None,
        }
    }

    /// One turn as a run serves it: `input` is the turn's input row, `stored` what the conversation's header holds.
    async fn serve(&self, surface: &Surface, input: Value, stored: Option<&str>, model: &str, cancel: CancellationToken) -> TurnEnd {
        self.serve_with(surface, input, stored.map(held), Some("RULES"), model, cancel, Turns::default()).await
    }

    /// [`World::serve`] with the session's prompt `rules` and what `turns` gives the turn.
    #[allow(clippy::too_many_arguments, reason = "a test's one entry to a served turn")]
    async fn serve_with(
        &self,
        surface: &Surface,
        input: Value,
        stored: Option<Stored>,
        rules: Option<&str>,
        model: &str,
        cancel: CancellationToken,
        turns: Turns,
    ) -> TurnEnd {
        let turns = Arc::new(turns);
        let request = TurnRequest {
            thread: thread(),
            cwd: self.cwd(),
            stored,
            rules: rules.map(str::to_owned),
            input,
            conversation: turns.clone(),
            attachments: turns.clone(),
        };
        let context = TurnContext { model: model.to_owned(), calls: turns.calls.clone(), ..self.context(cancel) };
        mixdog_acp::runs::serve(&self.agents, &self.preset, request, Arc::new(surface.clone()), context).await
    }

    /// A user's message `text` served as a turn of a conversation that holds no agent session.
    async fn ask(&self, surface: &Surface, text: &str, turns: Turns) -> TurnEnd {
        within(
            "the turn",
            self.serve_with(surface, json!({ "role": "user", "content": text }), None, Some("RULES"), "default", CancellationToken::new(), turns),
        )
        .await
    }

    /// Waits for the agent's own reply to have asked for `count` turns.
    async fn wakes(&self, count: usize) {
        within("the wake", async {
            loop {
                let asked = self.woken.1.notified();
                tokio::pin!(asked);
                asked.as_mut().enable();
                if self.woken.0.lock().unwrap().len() >= count {
                    return;
                }
                asked.await;
            }
        })
        .await;
    }

    /// A turn of the `hang` prompt, stopped once its first row is committed.
    async fn hang_until_stopped(&self, surface: &Surface) -> TurnEnd {
        let cancel = CancellationToken::new();
        let thread = thread();
        let running = self.prompt(&thread, surface, "hang", None, cancel.clone());
        let stop = async {
            surface.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
            cancel.cancel();
        };
        within("the stop", async { tokio::join!(running, stop) }).await.0
    }

    /// One prompt turn of `thread`, reported to `surface`.
    async fn prompt(&self, thread: &ThreadId, surface: &Surface, text: &str, stored: Option<&str>, cancel: CancellationToken) -> TurnEnd {
        self.prompt_with(thread, surface, text, stored, cancel, None).await
    }

    /// [`World::prompt`] in a turn that runs the session's tools with `calls`.
    async fn prompt_with(
        &self,
        thread: &ThreadId,
        surface: &Surface,
        text: &str,
        stored: Option<&str>,
        cancel: CancellationToken,
        calls: Option<Arc<HandedCalls>>,
    ) -> TurnEnd {
        let session = self.agents.session(thread, &self.preset, self.cwd(), stored.map(held), Some("RULES".into())).await.expect("the agent starts");
        let context = TurnContext { calls, ..self.context(cancel) };
        mixdog_acp::turn::run(&session, Arc::new(surface.clone()), Ask::Prompt(vec![json!({ "type": "text", "text": text })]), context).await
    }
}

/// The agent's session `id` as a conversation holds it, with no record of the prompt that session was given.
fn held(id: &str) -> Stored {
    Stored { session_id: id.to_owned(), prompt: None }
}

async fn within<T>(what: &str, wait: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(60), wait).await.unwrap_or_else(|_| panic!("{what} did not happen"))
}

fn thread() -> ThreadId {
    ThreadId::from("sess_acp")
}

fn completed_text(end: &TurnEnd) -> &str {
    match end {
        TurnEnd::Completed { text, .. } => text,
        other => panic!("the turn did not complete: {other:?}"),
    }
}

fn decided(decision: Value) -> ApprovalResolution {
    serde_json::from_value(json!({ "kind": "decided", "decision": decision, "device": "PC", "connectionKind": "desktop", "at": 0 })).expect("a resolution")
}

#[tokio::test]
async fn a_prompts_stream_becomes_live_items_and_committed_rows() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = within("the turn", world.prompt(&thread(), &surface, "stream", None, CancellationToken::new())).await;
    assert_eq!(end, TurnEnd::Completed { text: "Done.".into(), stop_reason: Some("end_turn".into()), tool_calls: 2 });

    let events = surface.events();
    assert!(matches!(events.iter().find(|event| !matches!(event, Event::Mark(_))), Some(Event::Started(ThreadItem::Reasoning { .. }))), "{events:?}");
    assert!(events.iter().any(|event| matches!(event, Event::ReasoningDelta(text) if text == "thinking")), "{events:?}");
    assert!(events.iter().any(|event| matches!(event, Event::ReasoningDone(text) if text == "thinking")), "{events:?}");
    assert_eq!(surface.streamed(), "Hello worldDone.");
    assert_eq!(events.iter().filter(|event| matches!(event, Event::Started(ThreadItem::AgentMessage { .. }))).count(), 2);

    let rows = surface.rows();
    let roles: Vec<&str> = rows.iter().map(|row| row["role"].as_str().unwrap_or_default()).collect();
    assert_eq!(roles, ["assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"], "{rows:?}");
    // The text shown before a call is the call's assistant row, under the item it streamed as.
    assert_eq!(rows[0]["content"], "Hello world");
    // A call's id carries its turn, and its name is one every provider takes as a tool's name.
    assert_eq!(rows[0]["toolCalls"][0]["id"], "turn-1.t1");
    assert_eq!(rows[0]["toolCalls"][0]["name"], "shell");
    assert_eq!(rows[0]["toolCalls"][0]["arguments"], json!({ "command": "npm test" }));
    assert_eq!((&rows[1]["toolCallId"], &rows[1]["content"]), (&json!("turn-1.t1"), &json!("ok")));
    assert_eq!(rows[2]["toolCalls"][0]["name"], "antigravity_edit");
    let diff = rows[3]["uiDiff"].as_str().expect("the edit's diff");
    assert!(diff.contains("a.txt") && diff.contains("-one") && diff.contains("+two"), "{diff}");
    assert_eq!(rows[4]["toolCalls"][0]["name"], "todo");
    assert_eq!(
        rows[4]["toolCalls"][0]["arguments"]["items"],
        json!([{ "content": "first", "status": "completed" }, { "content": "second", "status": "in_progress" }])
    );
    assert_eq!(rows[5]["content"], "[x] first\n[>] second");
    assert_eq!(rows[6]["content"], "Done.");
    let streamed_item = events.iter().find_map(|event| match event {
        Event::Started(ThreadItem::AgentMessage { id, .. }) => Some(id.clone()),
        _ => None,
    });
    let committed_item = events.iter().find_map(|event| match event {
        Event::Commit(item) => Some(item.iid.clone()),
        _ => None,
    });
    assert_eq!(streamed_item, committed_item);

    let usage = events.iter().find_map(|event| match event {
        Event::Usage(usage) => Some(usage.clone()),
        _ => None,
    });
    let usage = usage.expect("the prompt's usage");
    assert_eq!((usage.input_tokens, usage.output_tokens, usage.cached_read_tokens, usage.tool_calls), (10, 5, 2, 2));
}

#[tokio::test]
async fn a_permission_request_is_asked_on_the_session_and_its_answer_returns_to_the_agent() {
    let world = World::new(&[]);
    let once = decided(json!({ "approved": true }));
    let rejected = decided(json!({ "approved": false }));
    let interrupted = ApprovalResolution::Interrupted { at: 0 };
    let for_session = decided(json!({ "approved": true, "remember": "session" }));
    // Whatever the user wants remembered, the agent is answered for this one call.
    // A session with nobody to ask (`None`) refuses.
    for (answer, said) in
        [(Some(once), "option:once"), (Some(rejected), "option:no"), (Some(interrupted), "cancelled"), (None, "option:no"), (Some(for_session), "option:once")]
    {
        let surface = Surface::default();
        surface.0.answers.lock().unwrap().extend(answer);
        let end = within("the turn", world.prompt(&thread(), &surface, "permission", None, CancellationToken::new())).await;
        assert_eq!(completed_text(&end), said);
        let asks = surface.0.asks.lock().unwrap().clone();
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0].tool.as_deref(), Some("antigravity_execute"));
        assert_eq!(asks[0].reason.as_deref(), Some("Delete build"));
        assert_eq!(asks[0].payload["args"]["command"], "rm -rf build");
        // The card's words are the client's: the agent and whether its call has a title are data.
        assert_eq!(asks[0].payload["agent"], json!({ "id": "antigravity", "label": "Antigravity ACP" }));
        assert_eq!(asks[0].payload["untitled"], false);
        // The call has its card before the user is asked, under the id the ask names.
        let call = surface.rows()[0]["toolCalls"][0]["id"].as_str().expect("the call's id").to_owned();
        assert!(call.starts_with("turn-1.p1"), "{call}");
        assert_eq!(asks[0].call_id.as_ref().map(|id| id.as_str()), Some(call.as_str()));
        // The wait on the user reads as the loop's approval wait does: the spinner got its mark, once, before the ask.
        assert_eq!(surface.events().iter().filter(|event| matches!(event, Event::Mark(CallMark::ToolApproval))).count(), 1);
    }
    // What the user approved for the session is Mixdog's to remember, under the policy's key of the action: the tool
    // the agent named. That tool's next call is not asked about.
    let surface = Surface::default();
    let end = within("the turn", world.prompt(&thread(), &surface, "permission", None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "option:once");
    assert!(surface.0.asks.lock().unwrap().is_empty());
    // Another tool of the same kind is: the approval covered `run_command`, not every command the agent runs.
    let surface = Surface::default();
    within("the turn", world.prompt(&thread(), &surface, "permission run_script", None, CancellationToken::new())).await;
    let asks = surface.0.asks.lock().unwrap().clone();
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].remember, [mixdog_protocol::ApprovalRemember::Session, mixdog_protocol::ApprovalRemember::Always]);
    // A deletion is never remembered, as the policy never remembers one: the session's approval is not offered for it,
    // and an approval of it answers that one call.
    for _ in 0..2 {
        let surface = Surface::default();
        surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true, "remember": "session" })));
        within("the turn", world.prompt(&thread(), &surface, "permission delete_file", None, CancellationToken::new())).await;
        let asks = surface.0.asks.lock().unwrap().clone();
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0].remember, [mixdog_protocol::ApprovalRemember::Always]);
    }
    // The session's end forgets it.
    world.agents.release(&thread());
    let surface = Surface::default();
    within("the turn", world.prompt(&thread(), &surface, "permission", None, CancellationToken::new())).await;
    assert_eq!(surface.0.asks.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_cancel_stops_the_turn_and_closes_what_it_left_open() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = world.hang_until_stopped(&surface).await;
    assert_eq!(end, TurnEnd::Interrupted);
    let rows = surface.rows();
    assert_eq!(rows[0]["content"], "working");
    assert_eq!(rows[0]["toolCalls"][0]["id"], "turn-1.h1");
    assert_eq!((&rows[1]["role"], &rows[1]["toolCallId"], &rows[1]["content"]), (&json!("tool"), &json!("turn-1.h1"), &json!("Cancelled")));
    let process = world.agents.running(&thread()).expect("the session's agent").connection.handle().clone();
    // The next prompt is taken by the same process as a new turn, once the agent has closed the cancelled one: the
    // agent read the cancel before it, in the order they were written.
    let next = Surface::default();
    let end = within("the next turn", world.prompt(&thread(), &next, "whoami", None, CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1 resumed=false"), "{end:?}");
    assert_eq!(world.agents.running(&thread()).expect("the session's agent").connection.handle(), &process);
    // Two processes ran in ACP mode: the one the check of the CLI opened a session in, and the session's own. No third
    // was started for the next turn, and the agent was told to cancel once.
    assert_eq!((world.logged("start acp"), world.logged("session/cancel")), (2, 1));
    // What the agent still sent for the cancelled prompt is in neither turn.
    assert_eq!(next.rows().len(), 1, "{:?}", next.rows());
}

/// The prompt is the turn's request, as a provider's is: once the agent holds a prompt it answers nothing to, the
/// watchdog judges the turn by the first-answer deadline counted from the prompt's send, and its stop ends the turn.
#[tokio::test]
async fn a_prompt_the_agent_answers_nothing_to_is_stopped_by_the_watchdog() {
    use mixdog_agent::agent_tool::progress::stale_report;
    use mixdog_agent::agent_tool::watchdog::{AgentKind, Overrides, is_watchdog_abort, resolve_policy};
    let world = World::new(&[]);
    let surface = Surface::default();
    let cancel = CancellationToken::new();
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_000));
    let (progress, mut watched) = tokio::sync::watch::channel(mixdog_core_run::run_host::progress::RunProgress::default());
    let session = world.agents.session(&thread(), &world.preset, world.cwd(), None, Some("RULES".into())).await.expect("the agent starts");
    let read_clock = clock.clone();
    let context = TurnContext { now_ms: Arc::new(move || read_clock.load(Ordering::SeqCst)), progress: Some(progress), ..world.context(cancel.clone()) };
    let running = mixdog_acp::turn::run(&session, Arc::new(surface.clone()), Ask::Prompt(vec![json!({ "type": "text", "text": "mute" })]), context);
    let policy =
        resolve_policy(AgentKind { name: None, hidden: false, stall_cap_idle_seconds: None }, Overrides::default(), &|_: &str| -> Option<String> { None });
    let watchdog = async {
        let sent = clock.load(Ordering::SeqCst);
        // The agent holds the prompt: the turn waits on its first answer.
        watched
            .wait_for(|progress| progress.snapshot(sent).is_some_and(|snapshot| snapshot.waiting_for_first_semantic && !snapshot.waiting_for_transport))
            .await
            .expect("the turn's progress");
        let verdict = |at: i64| stale_report(&watched.borrow().snapshot(at).expect("a snapshot"), at, &policy);
        assert_eq!(verdict(sent + policy.first_semantic_ms), None, "no verdict before the deadline has passed");
        let stalled = verdict(sent + policy.first_semantic_ms + 1).expect("the watchdog's verdict");
        assert!(is_watchdog_abort(&stalled), "{stalled}");
        // The watchdog's stop.
        cancel.cancel();
    };
    let (end, ()) = within("the watchdog's stop", async { tokio::join!(running, watchdog) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    world.logs("session/cancel").await;
}

#[tokio::test]
async fn the_agents_process_is_gone_once_its_session_is_released() {
    let dir_of_pid = tempfile::tempdir().expect("temp dir");
    let pid_file = dir_of_pid.path().join("child.pid");
    let world = World::new(&[("FAKE_AGENT_CHILD_PID_FILE", &pid_file.to_string_lossy())]);
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert!(matches!(end, TurnEnd::Completed { .. }));
    let session = world.agents.running(&thread()).expect("the session's agent");
    let handle = session.connection.handle().clone();
    assert!(world.processes.list().iter().any(|process| process.handle == handle && process.exit.is_none()));
    // The agent has a child of its own, which is part of what the session owns.
    #[allow(clippy::disallowed_methods, reason = "a test reads the fake agent's own file")]
    let child: u32 = std::fs::read_to_string(&pid_file).expect("the child's pid").trim().parse().expect("a pid");
    assert!(process_alive(child), "the agent's child runs while its session does");

    world.agents.release(&thread());
    within("the agent's exit", session.connection.exited().cancelled()).await;
    assert!(world.agents.running(&thread()).is_none());
    assert!(world.processes.list().iter().all(|process| process.handle != handle || process.exit.is_some()));
    within("the child's end", async {
        while process_alive(child) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
}

/// Whether the process `pid` exists, asked of the system by its number.
#[allow(clippy::disallowed_methods, reason = "a test asks the system about a process")]
fn process_alive(pid: u32) -> bool {
    if cfg!(windows) {
        let listed = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]).output().expect("tasklist");
        String::from_utf8_lossy(&listed.stdout).contains(&format!("\"{pid}\""))
    } else {
        std::process::Command::new("kill").args(["-0", &pid.to_string()]).output().is_ok_and(|asked| asked.status.success())
    }
}

#[tokio::test]
async fn a_stored_session_is_resumed_in_a_new_process_and_never_loaded() {
    let world = World::new(&[]);
    let first = within("the first turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    // A new session carries Mixdog's rules where the agent advertises a place for them, and is offered file reads only:
    // neither file writes nor a terminal, so the agent edits with its own diff edits and runs its own commands.
    assert_eq!(completed_text(&first), "session=sess-1 resumed=false loaded=false append=RULES model=m1 read=true write=false terminal=false lead= images=0");
    let stored = world.agents.running(&thread()).expect("the session's agent").session_id.clone();

    // The daemon restarted: the agent's process is gone and the session holds only the agent's session id. The reopen
    // carries Mixdog's prompt as the open did.
    world.agents.release(&thread());
    let second = within("the second turn", world.prompt(&thread(), &Surface::default(), "whoami", Some(&stored), CancellationToken::new())).await;
    assert!(completed_text(&second).starts_with("session=sess-1 resumed=true loaded=false append=RULES model="), "{second:?}");
    let log = world.log();
    assert!(log.iter().any(|line| line == "session/resume"), "{log:?}");
    assert!(!log.iter().any(|line| line == "session/load"), "{log:?}");
}

#[tokio::test]
async fn a_cli_older_than_the_presets_minimum_is_reported_and_never_started_as_an_agent() {
    let world = World::new(&[("FAKE_AGENT_VERSION", "1.3.3")]);
    let refused = within("the refusal", world.agents.session(&thread(), &world.preset, world.cwd(), None, None)).await.err();
    assert_eq!(refused, Some(Refusal::NotReady(Readiness::VersionTooOld { version: "1.3.3".into() })));
    assert_eq!(world.log(), ["version"]);
    let status = world.agents.status();
    assert_eq!(status["agents"][0]["state"], "versionTooOld");
    assert_eq!(status["agents"][0]["version"], "1.3.3");
    assert_eq!(status["agents"][0]["minimumVersion"], "1.5.1");
    assert!(world.agents.picker_rows().is_empty());
    assert!(world.processes.list().iter().all(|process| process.exit.is_some()));
}

#[tokio::test]
async fn a_signed_out_cli_and_a_ready_one_are_told_apart() {
    let signed_out = World::new(&[("FAKE_AGENT_SIGNED_OUT", "1")]);
    let agent = signed_out.checked().await;
    assert_eq!(agent["state"], "signedOut");
    assert_eq!(agent["message"], "Authentication required");
    assert_eq!(agent["canSignIn"], true);
    assert!(signed_out.agents.picker_rows().is_empty());

    let ready = World::new(&[]);
    let agent = ready.checked().await;
    assert_eq!(agent["state"], "ready");
    assert_eq!(agent["models"], json!([{ "id": "m1", "name": "Model One" }, { "id": "m2", "name": "Model Two" }]));
    // The check's own session is closed in the agent, and its process is gone.
    assert_eq!(ready.logged("session/close"), 1);
    ready.all_exited().await;
    let rows = ready.agents.picker_rows();
    let listed: Vec<(&str, &str)> = rows.iter().map(|row| (row["id"].as_str().unwrap(), row["display"].as_str().unwrap())).collect();
    assert_eq!(listed, [("default", "Antigravity ACP"), ("m1", "Antigravity ACP · Model One"), ("m2", "Antigravity ACP · Model Two")]);
    assert!(rows.iter().all(|row| row["provider"] == "acp-antigravity" && row["runner"] == "acp"));
}

#[tokio::test]
async fn with_the_feature_off_nothing_is_reachable_and_no_process_is_started() {
    let world = World::new(&[]);
    world.enabled.store(false, Ordering::SeqCst);
    let refused = world.agents.session(&thread(), &world.preset, world.cwd(), None, None).await.err();
    assert_eq!(refused, Some(Refusal::Off));
    world.agents.recheck();
    assert!(world.agents.install().await.is_err());
    let status = world.agents.status();
    assert_eq!(status["enabled"], false);
    assert_eq!(status["agents"][0]["state"], "off");
    assert!(world.agents.picker_rows().is_empty());
    assert!(world.agents.selectable(&world.preset).is_err());
    assert!(world.log().is_empty());
    assert!(world.processes.list().is_empty());

    // Turning the feature off ends the agents it started.
    world.enabled.store(true, Ordering::SeqCst);
    within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    let session = world.agents.running(&thread()).expect("the session's agent");
    world.enabled.store(false, Ordering::SeqCst);
    world.agents.status();
    within("the agent's exit", session.connection.exited().cancelled()).await;
    assert!(world.agents.running(&thread()).is_none());
}

#[tokio::test]
async fn a_reply_the_agent_begins_after_its_turn_asks_for_a_turn_that_ends_with_the_reply() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = within("the turn", world.prompt(&thread(), &surface, "background", None, CancellationToken::new())).await;
    assert_eq!(end, TurnEnd::Completed { text: "started".into(), stop_reason: Some("end_turn".into()), tool_calls: 1 });
    // The call the agent left running has a result, so the turn's rows are whole.
    assert_eq!(surface.rows()[1]["content"], "Still running in the agent's background.");

    let made = surface.rows()[0]["toolCalls"][0]["id"].clone();
    assert_eq!(made, "turn-1.b1");

    let session = world.agents.running(&thread()).expect("the session's agent");
    world.wakes(1).await;
    assert_eq!(*world.woken.0.lock().unwrap(), [thread()]);
    assert!(session.woken());

    // The wake's turn shows what has arrived and ends: it waits on nothing more of the agent.
    let reply = Surface::default();
    let wake = json!({ "role": "user", "content": WAKE_TEXT, "meta": { "source": "task-notification" } });
    let end = within("the reply's turn", world.serve(&reply, wake.clone(), Some("sess-1"), "default", CancellationToken::new())).await;
    assert_eq!(end, TurnEnd::Completed { text: "woke".into(), stop_reason: None, tool_calls: 1 });
    // The call's late result is an item of its own that names the call of the earlier turn; no id is in both turns.
    let rows = reply.rows();
    assert_eq!(rows.iter().map(|row| row["role"].as_str().unwrap_or_default()).collect::<Vec<_>>(), ["assistant", "tool", "assistant"], "{rows:?}");
    let late = &rows[0]["toolCalls"][0];
    assert_ne!(late["id"], made);
    assert_eq!((&late["name"], &late["arguments"]["resultOf"]), (&json!("antigravity_execute"), &made));
    assert_eq!((&rows[1]["toolCallId"], &rows[2]["content"]), (&late["id"], &json!("woke")));
    assert!(!session.woken());
    assert_eq!(world.logged("session/prompt"), 1, "a wake is never sent to the agent as a prompt");

    // The background call is forgotten: nothing of it is left to show, and a wake with no reply behind it shows nothing.
    let again = Surface::default();
    let end = within("the empty wake", world.serve(&again, wake, Some("sess-1"), "default", CancellationToken::new())).await;
    assert_eq!(end, TurnEnd::Completed { text: String::new(), stop_reason: None, tool_calls: 0 });
    assert!(again.rows().is_empty());
}

#[tokio::test]
async fn a_notification_that_is_not_the_agents_wake_is_sent_to_the_agent_as_a_prompt() {
    let world = World::new(&[]);
    within("the turn", world.prompt(&thread(), &Surface::default(), "background", None, CancellationToken::new())).await;
    world.wakes(1).await;
    // A reply of the agent's own is waiting for its turn when a routine's notification runs first.
    let surface = Surface::default();
    let routine = json!({ "role": "user", "content": "whoami from a routine", "meta": { "source": "task-notification" } });
    let end = within("the routine's turn", world.serve(&surface, routine, Some("sess-1"), "default", CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1"), "{end:?}");
    assert_eq!(world.logged("session/prompt"), 2);
    // The reply that waited is shown in that turn, before the prompt's answer.
    assert!(surface.rows().iter().any(|row| row["content"] == "woke"), "{:?}", surface.rows());
}

#[tokio::test]
async fn what_the_agent_sends_after_its_own_reply_was_stopped_starts_no_turn() {
    let world = World::new(&[]);
    within("the turn", world.prompt(&thread(), &Surface::default(), "selfask", None, CancellationToken::new())).await;
    world.wakes(1).await;
    // The user stops the reply's turn; the agent, answered, goes on and reports the end of a step.
    let stopped = CancellationToken::new();
    stopped.cancel();
    let reply = Surface::default();
    let wake = json!({ "role": "user", "content": WAKE_TEXT, "meta": { "source": "task-notification" } });
    let end = within("the stopped reply", world.serve(&reply, wake, Some("sess-1"), "default", stopped)).await;
    assert_eq!(end, TurnEnd::Interrupted);
    // The call the reply showed is closed.
    let rows = reply.rows();
    assert_eq!((&rows[1]["role"], &rows[1]["content"]), (&json!("tool"), &json!("Cancelled")), "{rows:?}");
    let end = within("the next turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");
    assert_eq!(world.woken.0.lock().unwrap().len(), 1, "the leftovers of the stopped reply asked for no turn");
}

#[tokio::test]
async fn an_agent_that_exits_in_the_middle_of_a_turn_fails_it_with_every_item_settled() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = within("the turn", world.prompt(&thread(), &surface, "die", None, CancellationToken::new())).await;
    assert!(matches!(end, TurnEnd::Failed { code: None, .. }), "{end:?}");
    let rows = surface.rows();
    assert_eq!(rows[0]["content"], "going");
    assert_eq!((&rows[1]["role"], &rows[1]["toolCallId"]), (&json!("tool"), &rows[0]["toolCalls"][0]["id"]), "{rows:?}");
    assert_eq!(rows[1]["content"], "The agent's process ended before this call did.");
    // The thread has no agent any more, and its next turn starts one.
    assert!(world.agents.running(&thread()).is_none());
    let end = within("the next turn", world.prompt(&thread(), &Surface::default(), "whoami", Some("sess-1"), CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1 resumed=true"), "{end:?}");
}

/// A turn that attaches to a session whose agent's process has already ended, everything it wrote routed, reads what was
/// left for it and fails at once as a turn whose agent exited: the stream it reads is not one nothing will ever close.
#[tokio::test]
async fn a_turn_that_attaches_after_its_agents_process_ended_fails_at_once() {
    let world = World::new(&[]);
    let session = world.agents.session(&thread(), &world.preset, world.cwd(), None, Some("RULES".into())).await.expect("the agent starts");
    session.connection.kill();
    within("the agent's exit", session.connection.exited().cancelled()).await;
    // The session leaves the agents once all its process wrote was routed: the turn attaches after that.
    within("the end of the agent's output", async {
        while world.agents.running(&thread()).is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    let whoami = Ask::Prompt(vec![json!({ "type": "text", "text": "whoami" })]);
    let surface = Surface::default();
    let end = within("the turn", mixdog_acp::turn::run(&session, Arc::new(surface.clone()), whoami, world.context(CancellationToken::new()))).await;
    assert!(matches!(end, TurnEnd::Failed { code: None, .. }), "{end:?}");
    assert!(surface.rows().is_empty(), "{:?}", surface.rows());
}

#[tokio::test]
async fn a_line_of_the_agents_output_that_is_no_message_is_passed_over() {
    let world = World::new(&[]);
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "garbage", None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "fine");
}

#[tokio::test]
async fn a_model_request_the_agent_never_answers_ends_with_the_turns_stop() {
    let world = World::new(&[("FAKE_AGENT_SILENT_MODEL", "1")]);
    let cancel = CancellationToken::new();
    let surface = Surface::default();
    let input = json!({ "role": "user", "content": "whoami" });
    let turn = world.serve(&surface, input, None, "m2", cancel.clone());
    let stop = async {
        while world.logged("session/set_model") == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        cancel.cancel();
    };
    let (end, ()) = within("the stop", async { tokio::join!(turn, stop) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    assert_eq!(world.logged("session/prompt"), 0);
    // A process that holds a request nobody will answer is not kept for the next turn.
    world.all_exited().await;
    assert!(world.agents.running(&thread()).is_none());
}

#[tokio::test]
async fn a_conversation_that_holds_no_agent_session_never_continues_the_one_a_process_still_has() {
    let world = World::new(&[]);
    within("the first turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    let first = world.agents.running(&thread()).expect("the session's agent");
    // A fork, a rewind and a clear take the agent's session out of the header; the thread's process still has it.
    let surface = Surface::default();
    let input = json!({ "role": "user", "content": "whoami" });
    let end = within("the turn after", world.serve(&surface, input, None, "default", CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1 resumed=false loaded=false"), "{end:?}");
    within("the first process's exit", first.connection.exited().cancelled()).await;
    assert_eq!((world.logged("session/new"), world.logged("session/resume")), (3, 0), "the check's session, then one per conversation");
    // The new session is recorded with the conversation.
    let events = surface.events();
    assert!(events.iter().any(|event| matches!(event, Event::Header(change) if change.set.contains_key(mixdog_acp::runs::SESSION_KEY))), "{events:?}");
}

#[tokio::test]
async fn an_agent_session_that_starts_in_the_middle_of_a_conversation_is_sent_mixdogs_summary_of_it() {
    let world = World::new(&[]);
    // The route came to the agent with a conversation behind it: Mixdog's compaction summarized it, and the agent reads
    // the summary ahead of the user's message, in the first prompt of its session only.
    let surface = Surface::default();
    let end = world.ask(&surface, "whoami", Turns { summary: Some(Ok("## User\nearlier talk")), ..Turns::default() }).await;
    let lead = completed_text(&end).split_once(" lead=").expect("the lead").1;
    assert!(lead.starts_with("# The conversation before this session") && lead.contains("## User\nearlier talk"), "{end:?}");
    assert_eq!(surface.notices(), ["The conversation above was summarized for Antigravity ACP, which starts a session of its own here."]);
    let next = Surface::default();
    let input = json!({ "role": "user", "content": "whoami" });
    let end = within("the next turn", world.serve(&next, input, Some("sess-1"), "default", CancellationToken::new())).await;
    assert!(completed_text(&end).contains(" lead= images="), "{end:?}");
    assert!(next.notices().is_empty());

    // A session with no earlier conversation is sent nothing extra and told nothing.
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = world.ask(&surface, "whoami", Turns::default()).await;
    assert!(completed_text(&end).contains(" lead= images="), "{end:?}");
    assert!(surface.notices().is_empty());
}

#[tokio::test]
async fn a_summary_that_cannot_be_made_fails_the_turn_and_the_agent_is_not_started_blind() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = world.ask(&surface, "whoami", Turns { summary: Some(Err("the summary route answered nothing")), ..Turns::default() }).await;
    assert_eq!(
        end,
        TurnEnd::Failed {
            message: "The conversation could not be summarized for Antigravity ACP: the summary route answered nothing".into(),
            code: None,
            reported: false
        }
    );
    assert_eq!(world.logged("session/prompt"), 0);
    // No agent session is recorded, so the next turn makes the summary again.
    assert!(!surface.events().iter().any(|event| matches!(event, Event::Header(_))), "{:?}", surface.events());
    assert!(world.agents.running(&thread()).is_none());
}

#[tokio::test]
async fn an_agent_whose_system_prompt_takes_nothing_reads_mixdogs_prompt_in_its_first_prompt() {
    let world = World::new(&[("FAKE_AGENT_NO_APPEND", "1")]);
    let surface = Surface::default();
    let end = world.ask(&surface, "whoami", Turns::default()).await;
    assert!(completed_text(&end).contains(" append= model=") && completed_text(&end).contains(" lead=RULES images="), "{end:?}");
    // The session's record tells which prompt its agent holds: the same one is not sent again, a changed one is.
    let record = surface.events().into_iter().find_map(|event| match event {
        Event::Header(change) => change.set.get(mixdog_acp::runs::SESSION_KEY).cloned(),
        _ => None,
    });
    let record = record.expect("the agent's session is recorded");
    let stored = || Some(Stored { session_id: "sess-1".into(), prompt: record["prompt"].as_str().map(str::to_owned) });
    let input = || json!({ "role": "user", "content": "whoami" });
    let same =
        within("the next turn", world.serve_with(&Surface::default(), input(), stored(), Some("RULES"), "default", CancellationToken::new(), Turns::default()))
            .await;
    assert!(completed_text(&same).contains(" lead= images="), "{same:?}");
    world.agents.release(&thread());
    let changed = within(
        "the changed prompt",
        world.serve_with(&Surface::default(), input(), stored(), Some("NEW RULES"), "default", CancellationToken::new(), Turns::default()),
    )
    .await;
    assert!(completed_text(&changed).contains(" lead=NEW RULES images="), "{changed:?}");
}

#[tokio::test]
async fn a_prompts_images_are_sent_as_image_blocks_or_the_user_is_told_they_were_not() {
    let input = || {
        json!({ "role": "user", "content": [
            { "type": "image", "mimeType": "image/png", "data": "aW5saW5l" },
            { "type": "image", "mimeType": "image/png", "attachmentRef": "stored" },
            { "type": "text", "text": "whoami" },
        ] })
    };
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = within("the turn", world.serve(&surface, input(), None, "default", CancellationToken::new())).await;
    assert!(completed_text(&end).ends_with(" images=2"), "{end:?}");
    assert!(surface.notices().is_empty());

    let world = World::new(&[("FAKE_AGENT_NO_IMAGES", "1")]);
    let surface = Surface::default();
    let end = within("the turn", world.serve(&surface, input(), None, "default", CancellationToken::new())).await;
    assert!(completed_text(&end).ends_with(" images=0"), "{end:?}");
    assert_eq!(surface.notices(), ["2 image(s) of this message were not sent to Antigravity ACP: Antigravity ACP takes no images."]);
}

#[tokio::test]
async fn a_reply_that_refuses_the_account_fails_the_turn_in_the_agents_words_and_the_agent_leaves_ready() {
    let world = World::new(&[]);
    assert_eq!(world.checked().await["state"], "ready");
    let surface = Surface::default();
    let end = world.ask(&surface, "suspended", Turns::default()).await;
    let said = "This service has been disabled in this account for violation of Terms of Service.";
    assert_eq!(end, TurnEnd::Refused { message: said.into() });
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["message"]), (&json!("failed"), &json!(said)), "{agent}");
    assert!(world.agents.picker_rows().is_empty());
    // A check opens a session and sends no prompt: it does not find the account served again, and the refusal stands
    // through it, in the agent's words.
    let refused = |agent: Value| assert_eq!((&agent["state"], &agent["message"]), (&json!("failed"), &json!(said)), "{agent}");
    refused(world.checked().await);
    // It stands through a restart of the app.
    let mut world = world;
    world.restart();
    refused(world.checked().await);
    assert!(world.agents.picker_rows().is_empty());
    // A turn the agent answers ends it: a session already on the agent can still ask.
    let end = world.ask(&Surface::default(), "whoami", Turns::default()).await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["message"]), (&json!("ready"), &Value::Null), "{agent}");
    world.restart();
    assert_eq!(world.checked().await["state"], "ready");
}

/// No committed row of `surface` shows the agent's notice of a failure.
fn no_notice_shown(surface: &Surface) {
    assert!(!surface.rows().iter().any(|row| row.to_string().contains('⚠')), "{:?}", surface.rows());
}

/// A reply that ends on the agent's notice of a failure of its own is no answer: the turn fails with what the notice
/// says, and the agent's state stands.
#[tokio::test]
async fn a_failure_notice_the_reply_ends_on_is_the_turns_error() {
    let world = World::new(&[]);
    assert_eq!(world.checked().await["state"], "ready");
    let surface = Surface::default();
    let failed = "failed to construct executor: plan model not specified; you must specify a valid model";
    let end = world.ask(&surface, &format!("notice {failed}"), Turns::default()).await;
    assert_eq!(end, TurnEnd::Failed { message: failed.into(), code: None, reported: true });
    no_notice_shown(&surface);
    assert_eq!(world.agents.status()["agents"][0]["state"], "ready");
}

/// A notice that the agent's sign-in no longer holds fails the turn and signs the agent out: its row says so, and the
/// next turn's start finds it signed out, with the sign-in to offer.
#[tokio::test]
async fn an_authentication_notice_the_reply_ends_on_fails_the_turn_and_signs_the_agent_out() {
    let world = World::new(&[]);
    assert_eq!(world.checked().await["state"], "ready");
    let surface = Surface::default();
    let end = world.ask(&surface, "notice UNAUTHENTICATED (code 401)", Turns::default()).await;
    assert!(matches!(&end, TurnEnd::Failed { message, .. } if message == "UNAUTHENTICATED (code 401)"), "{end:?}");
    no_notice_shown(&surface);
    assert_eq!(world.agents.status()["agents"][0]["state"], "signedOut");
    let refusal = world.agents.selectable(&world.preset).err().expect("a signed-out agent runs no turn");
    assert_eq!(refusal.message(&world.preset), "Antigravity ACP is signed out. Sign in to it in Settings.");
    // The refusal reaches the run as a sign-in failure, typed as a provider's authentication failure is.
    assert!(refusal.signed_out());
    let error = world.agents.failure(&world.preset, refusal.message(&world.preset), Some(-32000), json!({}), None).await;
    assert_eq!(error.provider_error.map(|detail| (detail.provider, detail.kind)), Some((world.preset.provider.clone(), "auth".to_owned())));
}

/// A failure is a spent quota only when the agent reported it for the prompt and the account's quota, read now, shows the
/// window of the model the agent is on exhausted: every other failure starts no CLI and stays as it is.
#[tokio::test]
async fn only_a_failure_the_agent_reported_is_checked_against_the_quota() {
    use mixdog_acp::agents::QuotaCheck;

    let full = r#"{"groups":[{"buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.0,"reset_time":"2030-01-01T05:00:00Z"}]}]}"#;
    let world = World::new(&[("FAKE_AGENT_USAGE", full)]);
    assert_eq!(world.checked().await["state"], "ready");
    let (now_ms, stop) = (1_700_000_000_000, CancellationToken::new());

    let spent = world
        .agents
        .failure(
            &world.preset,
            "limit".into(),
            None,
            json!({ "reason": "acpAgent" }),
            Some(QuotaCheck { model: "gemini-3-pro", current: None, now_ms, stop: &stop }),
        )
        .await;
    assert_eq!(spent.provider_error.as_ref().map(|detail| detail.kind.as_str()), Some("quota_exhausted"));
    assert_eq!(spent.data["providerFacts"]["quotaExhausted"]["resetAt"], json!(1_893_474_000_000_u64));
    assert_eq!(spent.data["reason"], "acpAgent");
    assert_eq!(world.logged("usage"), 1);

    // The default route is the model the agent is on.
    let default = world
        .agents
        .failure(&world.preset, "limit".into(), None, json!({}), Some(QuotaCheck { model: "default", current: Some("gemini-3-pro"), now_ms, stop: &stop }))
        .await;
    assert_eq!(default.provider_error.as_ref().map(|detail| detail.kind.as_str()), Some("quota_exhausted"));
    assert_eq!(default.data["providerFacts"]["quotaExhausted"]["model"], "default", "the stop names the route the session is on");
    let reads = world.logged("usage");
    let unknown =
        world.agents.failure(&world.preset, "limit".into(), None, json!({}), Some(QuotaCheck { model: "default", current: None, now_ms, stop: &stop })).await;
    assert!(unknown.provider_error.is_none(), "an agent not running is on no known model");
    assert_eq!(world.logged("usage"), reads, "and nothing is read for it");
    // Another model's window is not the route's.
    let other = world
        .agents
        .failure(&world.preset, "limit".into(), None, json!({}), Some(QuotaCheck { model: "claude-sonnet-4", current: None, now_ms, stop: &stop }))
        .await;
    assert!(other.provider_error.is_none());
    let reads = world.logged("usage");

    // A failure that was not the agent's answer starts no read.
    let plain = world.agents.failure(&world.preset, "the process ended".into(), None, json!({}), None).await;
    assert!(plain.provider_error.is_none());
    assert_eq!(world.logged("usage"), reads);

    // A stopped turn ends the read and leaves the failure as it is.
    let stopped = CancellationToken::new();
    stopped.cancel();
    let ended = world
        .agents
        .failure(&world.preset, "limit".into(), None, json!({}), Some(QuotaCheck { model: "gemini-3-pro", current: None, now_ms, stop: &stopped }))
        .await;
    assert!(ended.provider_error.is_none());

    // A read that fails leaves it as it is too.
    let failing = World::new(&[("FAKE_AGENT_USAGE_FAILS", "quota service unavailable")]);
    assert_eq!(failing.checked().await["state"], "ready");
    let unread = failing
        .agents
        .failure(&failing.preset, "limit".into(), None, json!({}), Some(QuotaCheck { model: "gemini-3-pro", current: None, now_ms, stop: &stop }))
        .await;
    assert!(unread.provider_error.is_none());
}

/// A turn whose agent no longer holds its session (it answers the prompt that the session is not found, or tells of it
/// in a notice) leaves that session behind: its process ends, the conversation stops naming it, and the next turn
/// starts a new one with the conversation handed over, as after a compaction.
#[tokio::test]
async fn a_lost_session_is_left_behind_and_the_next_turn_starts_a_new_one_on_the_summary() {
    for (word, said) in [("lost", "Session not found: sess-9"), ("notice Failed to rebuild agent", "Failed to rebuild agent")] {
        let world = World::new(&[]);
        let surface = Surface::default();
        let input = json!({ "role": "user", "content": word });
        let end =
            within("the turn", world.serve_with(&surface, input, Some(held("sess-9")), Some("RULES"), "default", CancellationToken::new(), Turns::default()))
                .await;
        assert!(matches!(&end, TurnEnd::Failed { message, .. } if message == said), "{word}: {end:?}");
        let changes: Vec<_> = surface.events().into_iter().filter_map(|event| if let Event::Header(change) = event { Some(change) } else { None }).collect();
        assert_eq!(changes.last().map(|change| change.unset.clone()), Some(vec![mixdog_acp::runs::SESSION_KEY.to_owned()]), "{word}");
        assert!(world.agents.running(&thread()).is_none(), "{word}: the process that held the lost session ended");

        let surface = Surface::default();
        let end = world.ask(&surface, "whoami", Turns { summary: Some(Ok("## User\nearlier talk")), ..Turns::default() }).await;
        let answered = completed_text(&end);
        assert!(answered.contains(" resumed=false") && answered.contains("## User\nearlier talk"), "{word}: {answered}");
    }
}

/// Whether a committed row of `surface` holds `text`.
fn shown(surface: &Surface, text: &str) -> bool {
    surface.rows().iter().any(|row| row.to_string().contains(text))
}

/// A chunk in the form of the agent's notice of a failure that the agent goes on after is the reply's, and shown.
#[tokio::test]
async fn a_warning_sign_followed_by_more_text_stays_in_the_reply() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = world.ask(&surface, "warnfirst", Turns::default()).await;
    let said = completed_text(&end);
    assert!(said.contains("⚠ Model produced invalid output.") && said.ends_with("four"), "{said:?}");
    assert!(shown(&surface, "⚠ Model produced invalid output."), "{:?}", surface.rows());
}

/// A reply that ends on a "⚠" warning and is answered with usage is a reply: only the agent's own notice closes a
/// prompt with no usage.
#[tokio::test]
async fn a_reply_ending_on_a_warning_sign_with_usage_is_a_reply() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = world.ask(&surface, "warnlast", Turns::default()).await;
    let said = completed_text(&end);
    assert!(said.starts_with("Done.") && said.contains("⚠ Warning: the tests were skipped."), "{said:?}");
    assert!(shown(&surface, "⚠ Warning: the tests were skipped."), "{:?}", surface.rows());
}

/// The agent's word that the account may not use it, told as its notice of a failure, refuses the turn in those words
/// and is the agent's state, as the same words in a whole reply are.
#[tokio::test]
async fn an_account_refusal_told_as_a_notice_refuses_the_turn_and_is_the_agents_state() {
    let world = World::new(&[]);
    assert_eq!(world.checked().await["state"], "ready");
    let surface = Surface::default();
    let said = "This service has been disabled in this account for violation of Terms of Service.";
    let end = world.ask(&surface, &format!("notice {said}"), Turns::default()).await;
    assert_eq!(end, TurnEnd::Refused { message: said.into() });
    no_notice_shown(&surface);
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["message"]), (&json!("failed"), &json!(said)), "{agent}");
}

/// A session with nobody to approve (a routine, an unattended run) refuses what the agent asks to do, as it refuses
/// Mixdog's own calls there, and says so: a command the session's gate would ask about, and work of a kind the gate
/// never judges, alike.
#[tokio::test]
async fn a_session_with_nobody_to_approve_refuses_the_agents_own_calls() {
    let (world, tools) = handing(&[]);
    for (word, judged) in [("askrun ls", true), ("permission delete_file", false)] {
        let surface = Surface::default();
        let calls = judged.then(|| tools.calls(&surface));
        let end = within("the turn", world.prompt_with(&thread(), &surface, word, None, CancellationToken::new(), calls)).await;
        assert_eq!(completed_text(&end), "option:no", "{word}");
        let notices = surface.notices();
        assert!(notices.len() == 1 && notices[0].ends_with("was not allowed: this session has nobody to approve it."), "{word}: {notices:?}");
    }
}

#[tokio::test]
async fn a_sign_in_that_succeeds_ends_a_standing_refusal_of_the_account() {
    let world = World::new(&[]);
    assert_eq!(world.checked().await["state"], "ready");
    world.ask(&Surface::default(), "suspended", Turns::default()).await;
    assert_eq!(world.checked().await["state"], "failed");
    // What the account flows run once the agent's sign-in program ended signed in: the CLI opens a session, so the
    // sign-in is held, and the account the user signed in with is not held to the refusal.
    let settled = within("the sign-in's settle", (world.agents.settle_login(&world.preset))(true)).await;
    assert_eq!(settled, Ok(true));
    assert_eq!(world.agents.status()["agents"][0]["state"], "ready");
}

/// The quota of the signed-in account is the CLI's own report, asked only of a CLI found ready and never of one that
/// is off or signed out; a report the CLI fails is told in its words.
#[tokio::test]
async fn a_ready_clis_quota_report_is_read_and_one_that_is_off_or_signed_out_is_not_asked() {
    let world = World::new(&[]);
    assert!(!world.agents.reports_usage(&world.preset), "nothing was checked yet");
    assert_eq!(within("the report", world.agents.usage(&world.preset)).await, None);
    assert_eq!(world.checked().await["state"], "ready");
    assert!(world.agents.reports_usage(&world.preset));
    let report = within("the report", world.agents.usage(&world.preset)).await.expect("a ready CLI is asked").expect("the report");
    let buckets: Vec<(&str, f64)> = report["groups"][0]["buckets"]
        .as_array()
        .expect("buckets")
        .iter()
        .map(|b| (b["id"].as_str().unwrap(), b["remaining_fraction"].as_f64().unwrap()))
        .collect();
    assert_eq!(buckets, [("gemini-weekly", 0.75), ("gemini-5h", 0.5)]);
    assert_eq!(world.logged("usage"), 1);

    let signed_out = World::new(&[("FAKE_AGENT_SIGNED_OUT", "1")]);
    assert_eq!(signed_out.checked().await["state"], "signedOut");
    assert!(!signed_out.agents.reports_usage(&signed_out.preset));
    assert_eq!(within("the report", signed_out.agents.usage(&signed_out.preset)).await, None);
    assert_eq!(signed_out.logged("usage"), 0);

    let failing = World::new(&[("FAKE_AGENT_USAGE_FAILS", "quota service unavailable")]);
    assert_eq!(failing.checked().await["state"], "ready");
    assert_eq!(within("the report", failing.agents.usage(&failing.preset)).await, Some(Err("quota service unavailable".into())));
}

#[tokio::test]
async fn a_call_of_the_agents_own_whose_title_names_a_mixdog_tool_is_asked_on_a_card() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": false })));
    let end = within("the turn", world.prompt_with(&thread(), &surface, "titled", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:no");
    // The call is the agent's own command, whatever its title says: the session's permissions judge it as a command,
    // what they ask about is asked on the call's own card, and its row is the agent's call.
    let asks = surface.0.asks.lock().unwrap().clone();
    let args = json!({ "CommandLine": "ls mcp_mixdog_read", "title": "ls mcp_mixdog_read" });
    assert_eq!(asks.iter().map(|ask| (ask.tool.as_deref(), &ask.payload["args"])).collect::<Vec<_>>(), [(Some("antigravity_execute"), &args)]);
    assert_eq!(*tools.seen.lock().unwrap(), ["judge shell"]);
    assert_eq!(surface.rows()[0]["toolCalls"][0]["name"], "shell");
    assert!(tools.ran.lock().unwrap().is_empty(), "no tool of the session ran");

    // The agent's question about a call of a tool the session's server lists, told by the call's own name, is answered
    // for that one call without the user: the tool's own pipeline asks what it must.
    let surface = Surface::default();
    let end = within("the turn", world.prompt_with(&thread(), &surface, "asktool read", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:once");
    assert!(surface.0.asks.lock().unwrap().is_empty() && cards(&surface).is_empty(), "{:?}", surface.rows());
    // One that names a tool the server does not list is the user's to answer: with nobody to ask, it is refused.
    let surface = Surface::default();
    let end = within("the turn", world.prompt_with(&thread(), &surface, "asktool nothing", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:no");
    assert_eq!(surface.0.asks.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_agents_lasting_option_is_sent_only_for_the_users_own_lasting_approval() {
    let (world, tools) = handing(&[]);
    // The user allowed once, or for the session: the agent's option for one call.
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true, "remember": "always" })));
    let end = within("the turn", world.prompt(&thread(), &surface, "permission", None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "option:always");
    world.agents.release(&thread());

    // The agent offers no option for one call: the user is asked, and told the approval lasts. Nothing of the agent's
    // own is answered for longer on the user's behalf.
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true })));
    let end = within("the turn", world.prompt_with(&thread(), &surface, "lasting", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:always");
    let asks = surface.0.asks.lock().unwrap().clone();
    assert_eq!(asks.len(), 1);
    assert_eq!((&asks[0].payload["lastingOnly"], &asks[0].remember), (&json!(true), &vec![mixdog_protocol::ApprovalRemember::Always]));
    // A Mixdog tool is judged by its own pipeline at every call: the agent is told yes for good, and nobody is asked.
    let surface = Surface::default();
    let end = within("the turn", world.prompt_with(&thread(), &surface, "lasting read", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:always");
    assert!(surface.0.asks.lock().unwrap().is_empty() && cards(&surface).is_empty(), "{:?}", surface.rows());
    let surface = Surface::default();
    let end = within("the turn", world.prompt(&thread(), &surface, "lasting", None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "option:no", "a session with no approval surface refuses, never with the lasting option");
}

#[tokio::test]
async fn an_agent_that_never_connects_to_the_sessions_tool_server_is_told_of_once() {
    let (world, _tools) = handing(&[("FAKE_AGENT_NO_MCP", "1")]);
    let surface = Surface::default();
    world.ask(&surface, "whoami", Turns::default()).await;
    assert_eq!(
        surface.notices(),
        ["Antigravity ACP did not take Mixdog's tools: it never connected to the session's tool server, and works with its own tools only."]
    );
    let next = Surface::default();
    let input = json!({ "role": "user", "content": "whoami" });
    within("the next turn", world.serve(&next, input, Some("sess-1"), "default", CancellationToken::new())).await;
    assert!(next.notices().is_empty());

    // An agent that connected is told nothing, whether it connected while it opened the session or after that.
    let either: [&[(&str, &str)]; 2] = [&[], &[("FAKE_AGENT_LATE_MCP", "1")]];
    for settings in either {
        let (world, _tools) = handing(settings);
        let surface = Surface::default();
        world.ask(&surface, "whoami", Turns::default()).await;
        assert!(surface.notices().is_empty(), "{settings:?}: {:?}", surface.notices());
    }
}

#[tokio::test]
async fn what_the_agent_queued_for_a_turn_that_did_not_start_is_answered_and_none_carries_over() {
    let world = World::new(&[]);
    within("the turn", world.prompt(&thread(), &Surface::default(), "selfask", None, CancellationToken::new())).await;
    world.wakes(1).await;
    // The wake's turn failed at its start: the permission request the agent queued for it is answered there.
    world.agents.unrun(&thread(), "the turn's settings could not be reconciled").await;
    // The agent, answered, goes on with the reply it began; the client has read all of it before the next prompt.
    world.logs("leftover read").await;
    // The next prompt's turn has neither the request, nor the call it was about, nor what the agent said after it.
    let surface = Surface::default();
    let end = within("the next turn", world.prompt(&thread(), &surface, "whoami", None, CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1"), "{end:?}");
    assert!(surface.0.asks.lock().unwrap().is_empty());
    assert!(cards(&surface).is_empty(), "{:?}", surface.rows());
}

#[tokio::test]
async fn a_turn_whose_start_fails_after_the_agents_session_is_open_answers_what_the_agent_queued() {
    let world = World::new(&[]);
    within("the turn", world.prompt(&thread(), &Surface::default(), "selfask", None, CancellationToken::new())).await;
    world.wakes(1).await;
    // The next prompt's turn finds the agent's session and fails where the route's model is chosen.
    let surface = Surface::default();
    let input = json!({ "role": "user", "content": "whoami" });
    let end = within("the failed start", world.serve(&surface, input, Some("sess-1"), "refused", CancellationToken::new())).await;
    assert!(matches!(&end, TurnEnd::Failed { message, .. } if message.contains("Unknown model ID: refused")), "{end:?}");
    assert_eq!(world.logged("session/prompt"), 1, "the turn never reached the agent");
    // The agent goes on only once its permission request is answered: it was, by the start that failed.
    world.logs("leftover read").await;
    let next = Surface::default();
    let end = within("the next turn", world.prompt(&thread(), &next, "whoami", None, CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1"), "{end:?}");
    assert!(next.0.asks.lock().unwrap().is_empty() && cards(&next).is_empty(), "{:?}", next.rows());
}

/// The spinner reads an agent's turn as it reads a turn of the loop: running a tool while a call runs, waiting for
/// approval only while an approval is open, back with the agent once the calls are over, and streaming while it writes.
#[tokio::test]
async fn the_spinner_follows_an_agents_turn_through_its_calls_its_approval_and_its_text() {
    let (world, tools) = handing(&[]);
    let marks = |surface: &Surface| -> Vec<CallMark> {
        let marks = surface.events().into_iter().filter_map(|event| match event {
            Event::Mark(mark) => Some(mark),
            _ => None,
        });
        marks.collect()
    };
    // A call of the agent's own that asks the user, then the agent's text.
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true })));
    let end = within("the turn", world.prompt(&thread(), &surface, "permission", None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "option:once");
    assert_eq!(marks(&surface), [CallMark::ToolCall, CallMark::ToolApproval, CallMark::ToolCall, CallMark::ToolPhaseCompleted, CallMark::Streaming]);
    // A call of a Mixdog tool, which asks nothing, then the agent's text.
    let surface = Surface::default();
    let end = tools.prompt(&world, &surface, "tool read {}").await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");
    assert_eq!(marks(&surface), [CallMark::ToolCall, CallMark::ToolPhaseCompleted, CallMark::Streaming]);
}

#[tokio::test]
async fn a_stop_between_the_two_rows_of_a_late_result_still_leaves_the_call_its_result() {
    let world = World::new(&[]);
    within("the turn", world.prompt(&thread(), &Surface::default(), "background", None, CancellationToken::new())).await;
    world.wakes(1).await;
    // The wake's turn shows the background call's result: its own surface refuses the result's row and the turn is
    // stopped in that moment.
    let reply = Surface::default();
    let cancel = CancellationToken::new();
    *reply.0.stops_at_result.lock().unwrap() = Some(cancel.clone());
    let wake = json!({ "role": "user", "content": WAKE_TEXT, "meta": { "source": "task-notification" } });
    within("the reply's turn", world.serve(&reply, wake, Some("sess-1"), "default", cancel)).await;
    let rows = reply.rows();
    let call = rows[0]["toolCalls"][0]["id"].clone();
    assert!(call.is_string() && rows.iter().any(|row| row["role"] == "tool" && row["toolCallId"] == call), "the stored call has no result: {rows:?}");
}

/// The names of the calls the turn's rows make.
fn cards(surface: &Surface) -> Vec<String> {
    let rows = surface.rows();
    let calls = rows.iter().filter_map(|row| row["toolCalls"].as_array()).flatten();
    calls.filter_map(|call| call["name"].as_str().map(str::to_owned)).collect()
}

/// A catalog that knows every provider and says yes to everything asked of one.
struct AnyCatalog;

#[async_trait]
impl RouteFacts for AnyCatalog {
    fn is_known(&self, _: &str, _: &serde_json::Map<String, Value>) -> bool {
        true
    }
    async fn ensure_ready(&self, _: &serde_json::Map<String, Value>, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn model_meta(&self, _: &str, _: &str) -> Value {
        Value::Null
    }
    fn window_meta(&self, _: &str, _: &str, _: &Value) -> Option<Value> {
        None
    }
    fn catalog_knows(&self, _: &str, _: &str) -> bool {
        true
    }
    fn fast_capable(&self, _: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
        true
    }
    fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
        true
    }
}

#[tokio::test]
async fn a_route_on_an_agent_is_saved_as_a_providers_and_picked_only_while_the_agent_can_run() {
    let world = World::new(&[("FAKE_AGENT_SIGNED_OUT", "1")]);
    let facts = AgentRouteFacts { inner: Arc::new(AnyCatalog), agents: world.agents.clone() };
    let config = serde_json::Map::new();
    // Signed out: a route saved on the agent is still the agent's, and picking it now is refused with its state.
    assert_eq!(world.checked().await["state"], "signedOut");
    assert!(facts.is_known("acp-antigravity", &config));
    let refused = facts.ensure_ready(&config, "acp-antigravity").await.expect_err("a signed-out agent was picked");
    assert!(refused.contains("Antigravity ACP"), "{refused}");

    let world = World::new(&[]);
    world.checked().await;
    let facts = AgentRouteFacts { inner: Arc::new(AnyCatalog), agents: world.agents.clone() };
    assert!(facts.is_known("acp-antigravity", &config));
    assert_eq!(facts.ensure_ready(&config, "acp-antigravity").await, Ok(()));
    assert!(!facts.fast_capable("acp-antigravity", &Value::Null, None, &Value::Null) && facts.fast_capable("openai", &Value::Null, None, &Value::Null));
    // No row of the agent is marked for a session alone: it is saved wherever a provider's model is.
    assert!(world.agents.picker_rows().iter().all(|row| row.get("sessionOnly").is_none()));
}

/// The settings value names the plan the agent reports for the signed-in account, and the agent is signed out with
/// the protocol's `logout`: its running session ends and it reads signed out until a sign-in.
#[tokio::test]
async fn an_agent_tells_its_accounts_plan_and_is_signed_out_with_the_protocols_logout() {
    let world = World::new(&[("FAKE_AGENT_PLAN", "Google AI Ultra")]);
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["plan"], &agent["canSignOut"]), (&json!("ready"), &json!("Google AI Ultra"), &json!(true)));
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert!(matches!(end, TurnEnd::Completed { .. }));
    assert!(world.agents.running(&thread()).is_some());

    assert_eq!(within("the sign-out", world.agents.sign_out(&world.preset)).await, Ok(()));
    assert_eq!(world.logged("logout"), 1);
    assert!(world.agents.running(&thread()).is_none(), "a session that ran under the account outlived its sign-out");
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["plan"], &agent["canSignOut"]), (&json!("signedOut"), &Value::Null, &json!(false)));
    // Signed out, there is nothing to sign out of.
    assert!(within("the second sign-out", world.agents.sign_out(&world.preset)).await.is_err());

    // An agent that does not advertise the method is not asked for it.
    let fixed = World::new(&[("FAKE_AGENT_NO_LOGOUT", "1")]);
    assert_eq!(fixed.checked().await["canSignOut"], false);
    assert_eq!(within("the refused sign-out", fixed.agents.sign_out(&fixed.preset)).await, Err("Antigravity ACP offers no sign-out.".to_owned()));
    assert_eq!(fixed.logged("logout"), 0);
}

/// A model the agent lists at several tiers is one row whose tiers are its efforts, as a provider's row states its
/// own, and a route's effort selects the agent's model id that is run.
#[tokio::test]
async fn a_model_the_agent_lists_at_several_tiers_is_one_row_and_the_routes_effort_picks_what_is_run() {
    let models = r#"[{"modelId":"gem-low","name":"Gem (Low)"},{"modelId":"gem-high","name":"Gem (High)"},{"modelId":"solo","name":"Solo"}]"#;
    let world = World::new(&[("FAKE_AGENT_MODELS", models)]);
    let agent = world.checked().await;
    assert_eq!(agent["models"], json!([{ "id": "gem", "name": "Gem" }, { "id": "solo", "name": "Solo" }]));
    let rows = world.agents.picker_rows();
    let row = |id: &str| rows.iter().find(|row| row["id"] == id).cloned().expect("the model's row");
    assert_eq!(rows.iter().map(|row| row["id"].as_str().unwrap()).collect::<Vec<_>>(), ["default", "gem", "solo"]);
    let gem = row("gem");
    assert_eq!((&gem["display"], &gem["modelName"], &gem["defaultEffort"]), (&json!("Antigravity ACP · Gem"), &json!("Gem"), &json!("low")));
    assert_eq!(gem["effortOptions"].as_array().expect("efforts").iter().map(|item| item["value"].as_str().unwrap()).collect::<Vec<_>>(), ["low", "high"]);
    assert!(!gem["notApplicable"].as_array().unwrap().contains(&json!("effort")));
    // A model the agent lists once has no effort to choose.
    assert!(row("solo").get("effortOptions").is_none() && row("solo")["notApplicable"].as_array().unwrap().contains(&json!("effort")));
    // The row a route on the model resolves to is the picker's.
    assert_eq!(world.agents.model_row(&world.preset, "gem"), gem);

    let run = |effort: Option<&'static str>| {
        let turns = Arc::new(Turns::default());
        let input = json!({ "role": "user", "content": "whoami" });
        let request = TurnRequest {
            thread: thread(),
            cwd: world.cwd(),
            stored: None,
            rules: Some("RULES".to_owned()),
            input,
            conversation: turns.clone(),
            attachments: turns,
        };
        let context = TurnContext { model: "gem".to_owned(), effort: effort.map(str::to_owned), ..world.context(CancellationToken::new()) };
        mixdog_acp::runs::serve(&world.agents, &world.preset, request, Arc::new(Surface::default()), context)
    };
    let end = within("the turn at high", run(Some("high"))).await;
    assert!(completed_text(&end).contains(" model=gem-high "), "{end:?}");
    let end = within("the turn with no effort", run(None)).await;
    assert!(completed_text(&end).contains(" model=gem-low "), "{end:?}");
}

/// The model list's catalog half: no rows of its own.
struct NoCatalogRows;

#[async_trait]
impl mixdog_core_api::DomainService for NoCatalogRows {
    fn methods(&self) -> &'static [&'static str] {
        &["model/list"]
    }
    async fn call(&self, _: mixdog_core_api::CoreRequest) -> Result<mixdog_core_api::Reply, mixdog_core_api::CoreError> {
        Ok(mixdog_core_api::Reply::Value(json!({ "models": [] })))
    }
    fn notify(&self, _: mixdog_core_api::ids::Method, _: Value, _: mixdog_core_api::ids::ConnectionId) -> mixdog_core_api::service::Admit {
        mixdog_core_api::service::Admit::Accepted
    }
}

/// An agent's model rows carry the favourite and hidden marks saved for them, under a provider row's keys, and name
/// the model and its agent apart.
#[tokio::test]
async fn an_agents_model_rows_carry_the_marks_saved_for_them_as_a_providers_rows_do() {
    use mixdog_core_api::DomainService as _;
    let world = World::new(&[]);
    world.checked().await;
    let ids: Vec<String> = world.agents.picker_rows().iter().filter_map(|row| row["id"].as_str().map(str::to_owned)).filter(|id| id != "default").collect();
    let (starred, hidden) = (ids[0].clone(), ids[1].clone());
    let saved = json!({ format!("acp-antigravity/{starred}"): { "favorite": true }, format!("acp-antigravity/{hidden}"): { "hidden": true } });
    let list = mixdog_acp::routes::AgentModelList {
        inner: Arc::new(NoCatalogRows),
        agents: world.agents.clone(),
        settings: Arc::new(move || saved.as_object().cloned().unwrap_or_default()),
    };
    let request = mixdog_core_api::CoreRequest {
        method: mixdog_core_api::ids::Method("model/list"),
        params: json!({}),
        op: None,
        ctx: mixdog_core_api::CallContext::internal("test"),
    };
    let mixdog_core_api::Reply::Value(read) = list.call(request).await.expect("the list") else { panic!("the list is a value") };
    let row = |id: &str| read["models"].as_array().expect("rows").iter().find(|row| row["id"] == id).cloned().expect("the model's row");
    assert_eq!((&row(&starred)["favorite"], &row(&starred)["savedHidden"]), (&json!(true), &Value::Null));
    assert_eq!((&row(&hidden)["favorite"], &row(&hidden)["savedHidden"]), (&Value::Null, &json!(true)));
    assert_eq!(row(&starred)["agentLabel"], "Antigravity ACP");
    assert_eq!(row(&starred)["display"], format!("Antigravity ACP · {}", row(&starred)["modelName"].as_str().expect("the model's own name")));
}

#[tokio::test]
async fn the_agent_reads_files_of_the_sessions_folder_and_no_others() {
    let world = World::new(&[]);
    let inside = world.dir.path().join("note.txt");
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), &format!("read {}", inside.display()), None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "read:hello\nsecond line\n");
    // Outside by its name, by a step back out of the folder, and by a link inside the folder that leads out of it.
    let elsewhere = tempfile::tempdir().expect("another folder");
    #[allow(clippy::disallowed_methods, reason = "a test writes the file its agent must not read")]
    std::fs::write(elsewhere.path().join("secret.txt"), "not yours").expect("the outside file");
    let link = world.dir.path().join("link");
    link_folder(&link, elsewhere.path());
    let refused = [
        elsewhere.path().join("secret.txt"),
        world.dir.path().join("..").join(elsewhere.path().file_name().expect("the folder's name")).join("secret.txt"),
        link.join("secret.txt"),
    ];
    for outside in refused {
        let end =
            within("the turn", world.prompt(&thread(), &Surface::default(), &format!("read {}", outside.display()), None, CancellationToken::new())).await;
        assert!(completed_text(&end).starts_with("error:") && completed_text(&end).contains("outside the session's folder"), "{}: {end:?}", outside.display());
    }
}

#[tokio::test]
#[allow(clippy::disallowed_methods, reason = "a test makes the folder and the file its agent reads")]
async fn the_file_a_read_opens_is_the_resolved_place_that_was_checked() {
    let world = World::new(&[]);
    // A link inside the session's folder to another place inside it: allowed, and read where it leads.
    let real = world.dir.path().join("real");
    std::fs::create_dir(&real).expect("the folder");
    std::fs::write(real.join("inner.txt"), "through the link").expect("the file");
    let alias = world.dir.path().join("alias");
    link_folder(&alias, &real);
    let asked = alias.join("inner.txt");
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), &format!("read {}", asked.display()), None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "read:through the link");
    let resolved = std::fs::canonicalize(real.join("inner.txt")).expect("the resolved place");
    assert_eq!(*world.opened.lock().unwrap(), [resolved], "the read opened the place the check resolved, not the name the agent gave");
}

/// A turn's answer is the last text it committed, whichever row took it: a report the agent wrote ahead of a last call
/// of its own is what the turn ends with, as it is for a reply that ends on text.
#[tokio::test]
async fn a_report_written_ahead_of_the_agents_last_call_is_the_turns_answer() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = within("the turn", world.prompt(&thread(), &surface, "report", None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "The report.");
    let rows = surface.rows();
    assert_eq!((&rows[0]["content"], &rows[0]["toolCalls"][0]["id"]), (&json!("The report."), &json!("turn-1.r1")), "{rows:?}");
}

/// What an agent's reply streams is written to the turn's progress record as it arrives, ahead of the row that later
/// holds it, as the loop's run writes its own: a restart restores the reply streamed up to it.
#[tokio::test]
async fn an_agents_streamed_reply_is_written_to_the_turns_progress_record_ahead_of_its_row() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = world.hang_until_stopped(&surface).await;
    assert_eq!(end, TurnEnd::Interrupted);
    let events = surface.events();
    let drafted = events.iter().position(|event| matches!(event, Event::Draft(body) if body["text"] == "working")).expect("the reply was recorded");
    let row = events.iter().position(|event| matches!(event, Event::Commit(item) if item.body["content"] == "working")).expect("the reply's row");
    assert!(drafted < row, "the record is written ahead of the row: {events:?}");
}

#[tokio::test]
async fn a_call_whose_row_the_session_did_not_take_is_given_no_result() {
    let world = World::new(&[]);
    let surface = Surface::default();
    surface.0.refuses_calls.store(true, Ordering::SeqCst);
    let end = within("the turn", world.prompt(&thread(), &surface, "hang", None, CancellationToken::new())).await;
    assert_eq!(end, TurnEnd::Interrupted);
    // The call's row was never stored, so the turn's end closes no call: a result would name a call that is not there.
    let rows = surface.rows();
    assert!(rows.iter().all(|row| row["role"] != "tool"), "{rows:?}");
}

#[tokio::test]
async fn a_session_that_leaves_the_agents_route_ends_the_agents_process_without_a_turn() {
    let world = World::new(&[]);
    within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    let session = world.agents.running(&thread()).expect("the session's agent");
    let writer = AgentRouteWriter { inner: Arc::new(Routes::default()), agents: world.agents.clone() };
    let route = |provider: &str| json!({ "provider": provider, "model": "default" }).as_object().cloned().expect("a route");

    // A route change that stays on the agent keeps its process.
    writer.set_route_state(&thread(), route(&world.preset.provider));
    assert!(world.agents.running(&thread()).is_some());
    // One that leaves it ends the process there and then: no turn of the session runs after it.
    writer.set_route_state(&thread(), route("openai"));
    within("the agent's exit", session.connection.exited().cancelled()).await;
    assert!(world.agents.running(&thread()).is_none());
    assert_eq!(writer.route(&thread())["provider"], "openai", "the route is written as before");
}

#[tokio::test]
async fn an_agents_model_with_efforts_is_filled_from_its_row_without_the_providers_readiness() {
    let world = World::new(&[]);
    let (_dir, writer) = live_writer(&world).await;
    let route = json!({ "provider": world.preset.provider, "model": "gemini-4-neon", "effort": "high" }).as_object().cloned().expect("a route");
    writer.set_route_state(&thread(), route);
    let meta = json!({ "id": "gemini-4-neon", "provider": world.preset.provider, "reasoningLevels": ["low", "medium", "high"] });
    // The catalog behind the facts serves no agent and refuses to ready one: the route is filled from the agent's row.
    let filled = within("the refresh", writer.refresh_route_effort(&thread(), Some(meta), false, None))
        .await
        .expect("no provider is asked")
        .expect("the route is filled");
    assert_eq!(filled["effectiveEffort"], "high");
    assert_eq!(writer.route(&thread())["effectiveEffort"], "high", "the filled route is the session's");
}

/// A route the writer refreshes with no model row of its caller's (a resumed thread's `prepare_route`, a new task's
/// `ready_default` and the control session's `ready_control` refresh it so) takes the agent's own row, as a provider's
/// route takes the catalog's: a model the agent runs at several efforts has its effort fields filled, one it runs at
/// one has them empty, and the route's display is the row's either way.
#[tokio::test]
async fn a_route_refreshed_with_no_row_takes_the_agents_row_with_its_efforts_or_none() {
    let models = r#"[{"modelId":"gem-low","name":"Gem (Low)"},{"modelId":"gem-high","name":"Gem (High)"},{"modelId":"solo","name":"Solo"}]"#;
    let world = World::new(&[("FAKE_AGENT_MODELS", models)]);
    world.checked().await;
    let (_dir, writer) = live_writer(&world).await;
    let route = |model: &str, effort: Option<&str>| {
        let mut route = json!({ "provider": world.preset.provider, "model": model }).as_object().cloned().expect("a route");
        if let Some(effort) = effort {
            route.insert("effort".to_owned(), json!(effort));
        }
        route
    };

    writer.set_route_state(&thread(), route("gem", Some("high")));
    let gem = within("the refresh", writer.refresh_route_effort(&thread(), None, true, None)).await.expect("refreshed").expect("written");
    assert_eq!((&gem["effectiveEffort"], &gem["modelDisplay"], &gem["fastCapable"]), (&json!("high"), &json!("Antigravity ACP · Gem"), &json!(false)));
    let efforts: Vec<&str> = gem["effortOptions"].as_array().expect("the efforts").iter().filter_map(|item| item["value"].as_str()).collect();
    assert_eq!(efforts, ["low", "high"]);
    assert_eq!(writer.route(&thread()), gem, "the filled route is the session's");

    writer.set_route_state(&thread(), route("solo", None));
    let solo = within("the refresh", writer.refresh_route_effort(&thread(), None, true, None)).await.expect("refreshed").expect("written");
    assert_eq!((&solo["effortOptions"], &solo["effectiveEffort"]), (&json!([]), &Value::Null), "{solo:?}");
    assert_eq!((&solo["modelDisplay"], &solo["fastCapable"]), (&json!("Antigravity ACP · Solo"), &json!(false)));
}

/// A refresh whose lease names a session generation that has moved on writes nothing over the newer session.
#[tokio::test]
async fn a_refresh_under_a_stale_lease_writes_nothing() {
    let world = World::new(&[]);
    world.checked().await;
    let (_dir, writer) = live_writer(&world).await;
    let route = json!({ "provider": world.preset.provider, "model": "default" }).as_object().cloned().expect("a route");
    writer.set_route_state(&thread(), route.clone());
    let moved = writer.generation(&thread()) + 1;
    writer.session.generation.store(moved, Ordering::SeqCst);
    let refreshed = within("the refresh", writer.refresh_route_effort(&thread(), None, false, Some(moved - 1))).await.expect("refreshed");
    assert_eq!(refreshed, None);
    assert_eq!(writer.route(&thread()), route, "the newer session's route stands");
}

/// An import makes its sessions on the Lead route: one an agent serves is a route as a provider's is, readied as the
/// agent is, though no provider of the catalog's is configured.
#[tokio::test]
async fn an_import_prepares_its_sessions_on_a_lead_route_only_an_agent_serves() {
    let world = World::new(&[]);
    world.checked().await;
    let lead = json!({ "id": "lead", "name": "Lead", "provider": world.preset.provider, "model": "default" });
    let (_dir, config) = config_of(json!({ "default": "lead", "presets": [lead] })).await;
    let routes = mixdog_core_domains::domains::ai_admin::chain::CatalogRouteContext {
        config,
        facts: Arc::new(AgentRouteFacts { inner: Arc::new(Unserved), agents: world.agents.clone() }),
    };
    assert_eq!(within("the preparation", mixdog_core_session::session::import_sessions::prepare_lead_route(&routes)).await, Ok(()));
}

/// The config of a profile whose agent section, in its memory form, is `agent`; the directory holds its file.
async fn config_of(agent: Value) -> (tempfile::TempDir, mixdog_core_config::config::Config) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("mixdog-config.json");
    let file = mixdog_core_config::config::agent_routes::stored_file_of(&agent);
    #[allow(clippy::disallowed_methods, reason = "a test writes the config file it opens")]
    std::fs::write(&path, serde_json::to_vec(&file).expect("the file")).expect("the config file");
    let tokens = mixdog_rt::testing::tokens();
    let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) =
        mixdog_core_config::config::Config::open(path, Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.expect("the config");
    (dir, config)
}

/// The writer the composition builds: the live route writer over the facts that know the agents, whose catalog serves
/// no agent (as the PC's catalog serves none).
async fn live_writer(world: &World) -> (tempfile::TempDir, LiveWriter) {
    let (dir, config) = config_of(json!({})).await;
    let cell = Arc::new(Cell::default());
    let session = Arc::new(Generations::default());
    let writer = mixdog_core_ports::ports::route_write::LiveRouteWriter {
        cell: cell.clone(),
        session: session.clone(),
        config,
        facts: Arc::new(AgentRouteFacts { inner: Arc::new(Unserved), agents: world.agents.clone() }),
        usage: Arc::new(NoUsage),
    };
    let writer = AgentRouteWriter { inner: Arc::new(writer), agents: world.agents.clone() };
    (dir, LiveWriter { writer, session })
}

/// The route writer and the session generation its leases are read from.
struct LiveWriter {
    writer: AgentRouteWriter,
    session: Arc<Generations>,
}

impl std::ops::Deref for LiveWriter {
    type Target = AgentRouteWriter;
    fn deref(&self) -> &AgentRouteWriter {
        &self.writer
    }
}

/// The route cell of the one thread, with its route generation.
#[derive(Default)]
struct Cell {
    route: Mutex<Route>,
    generation: std::sync::atomic::AtomicU64,
}

impl mixdog_core_ports::ports::route::LiveRoute for Cell {
    fn route(&self, _: &ThreadId) -> Route {
        self.route.lock().unwrap().clone()
    }
    fn adopt_held(&self, _: &ThreadId, _: &Route) {
        unreachable!("no held route is adopted")
    }
}

impl mixdog_core_ports::ports::route_write::RouteCell for Cell {
    fn set_route_state(&self, _: &ThreadId, route: Route) {
        *self.route.lock().unwrap() = route;
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    fn route_generation(&self, _: &ThreadId) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    fn boot(&self, _: &ThreadId, _: &Route) {}
}

/// The session generation of the one thread; nothing else of the session is asked by a refresh.
#[derive(Default)]
struct Generations {
    generation: std::sync::atomic::AtomicU64,
}

#[async_trait]
impl mixdog_core_ports::ports::route::RouteSession for Generations {
    fn generation(&self, _: &ThreadId) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    async fn live_turn_messages(&self, _: &ThreadId) -> Result<Vec<Value>, mixdog_tools::orch::util::PortError> {
        unreachable!("a refresh reads no turn")
    }
    fn has_user_conversation(&self, _: &[Value]) -> bool {
        unreachable!("a refresh reads no conversation")
    }
    async fn update_route(&self, _: &ThreadId, _: Route, _: bool) -> Result<bool, mixdog_tools::orch::util::PortError> {
        unreachable!("a refresh updates no session")
    }
    async fn record_boundary(&self, _: &ThreadId, _: &str, _: Value) -> Result<bool, mixdog_tools::orch::util::PortError> {
        unreachable!("a refresh records no boundary")
    }
    async fn rebuild_tool_surface(&self, _: &ThreadId, _: &str) -> Result<(), mixdog_tools::orch::util::PortError> {
        unreachable!("a refresh rebuilds no tool surface")
    }
    async fn owner_fallbacks(
        &self,
        _: &ThreadId,
        _: &mixdog_store::schema::record::Header,
        _: &str,
        _: &str,
    ) -> Result<Option<Vec<Value>>, mixdog_tools::orch::util::PortError> {
        unreachable!("a refresh reads no fallbacks")
    }
    fn write_statusline(&self, _: &ThreadId, _: &Route) {}
    fn invalidate_context_status(&self, _: &ThreadId) {}
}

struct NoUsage;

impl mixdog_core_ports::ports::route_write::StatuslineUsage for NoUsage {
    fn refresh(&self, _: &ThreadId, _: &Route) {}
}

/// The PC's catalog as it answers a provider id no family serves (an agent's): known to nobody, not readied, with a
/// bare placeholder row and nobody to send on it.
struct Unserved;

#[async_trait]
impl RouteFacts for Unserved {
    fn is_known(&self, _: &str, _: &serde_json::Map<String, Value>) -> bool {
        false
    }
    async fn ensure_ready(&self, _: &serde_json::Map<String, Value>, provider: &str) -> Result<(), String> {
        Err(format!("[provider] Failed to init \"{provider}\": unknown enabled provider: {provider}"))
    }
    fn model_meta(&self, provider: &str, model: &str) -> Value {
        json!({ "id": model, "provider": provider })
    }
    fn window_meta(&self, _: &str, _: &str, _: &Value) -> Option<Value> {
        None
    }
    fn catalog_knows(&self, _: &str, _: &str) -> bool {
        false
    }
    fn fast_capable(&self, _: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
        false
    }
    fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
        false
    }
    async fn sender(
        &self,
        _: Option<&serde_json::Map<String, Value>>,
        provider: &str,
    ) -> Result<Option<mixdog_core_ports::ports::route_facts::RouteSender>, String> {
        Err(format!("unknown enabled provider: {provider}"))
    }
}

#[tokio::test]
#[allow(clippy::disallowed_methods, reason = "a test reads the folder the file is made in")]
async fn a_file_made_through_the_cores_file_service_appears_whole_and_one_already_there_is_kept() {
    let dir = tempfile::tempdir().expect("temp dir");
    let files = mixdog_acp::files::ServiceFiles {
        files: Arc::new(mixdog_workspace::localfs::LocalFileService::new()),
        lane: mixdog_rt::testing::tokens().interactive_io,
    };
    let path = AbsPath::new(dir.path().join("home/.agents/agents/mixdog/agent.md")).expect("an absolute temp dir");
    within("the first", files.create(path.clone(), "first".to_owned())).await.expect("made");
    within("the second", files.create(path.clone(), "second".to_owned())).await.expect("kept");
    assert_eq!(std::fs::read_to_string(path.as_path()).expect("the file"), "first");
    let left: Vec<_> =
        std::fs::read_dir(path.as_path().parent().expect("the folder")).expect("the folder").map(|entry| entry.expect("an entry").file_name()).collect();
    assert_eq!(left, ["agent.md"]);
}

#[tokio::test]
#[allow(clippy::disallowed_methods, reason = "a test makes the folder and the file its agent reads")]
async fn a_read_through_the_cores_file_service_opens_the_resolved_place() {
    // The resolved place is a verbatim path on Windows: the core's own file service is what is asked to open it.
    let dir = tempfile::tempdir().expect("temp dir");
    let real = dir.path().join("real");
    std::fs::create_dir(&real).expect("the folder");
    std::fs::write(real.join("inner.txt"), "through the link").expect("the file");
    let alias = dir.path().join("alias");
    link_folder(&alias, &real);
    let files = mixdog_acp::files::ServiceFiles {
        files: Arc::new(mixdog_workspace::localfs::LocalFileService::new()),
        lane: mixdog_rt::testing::tokens().interactive_io,
    };
    let cwd = AbsPath::new(dir.path()).expect("an absolute temp dir");

    let asked = json!({ "path": alias.join("inner.txt") });
    let read = within("the read", mixdog_acp::files::read_text_file(&files, &cwd, &asked)).await.unwrap_or_else(|error| panic!("{}", error.message));
    assert_eq!(read["content"], "through the link");
    // A place the links lead out of the folder is still outside it, whatever form the resolved place has.
    let outside = tempfile::tempdir().expect("temp dir");
    std::fs::write(outside.path().join("secret.txt"), "not the session's").expect("the file");
    let leak = dir.path().join("leak");
    link_folder(&leak, outside.path());
    let refused =
        within("the refusal", mixdog_acp::files::read_text_file(&files, &cwd, &json!({ "path": leak.join("secret.txt") }))).await.expect_err("outside");
    assert!(refused.message.contains("outside the session's folder"), "{}", refused.message);
}

#[tokio::test]
async fn a_turn_of_the_loop_ends_the_agents_process_and_forgets_the_agents_session() {
    let world = World::new(&[]);
    within("the agent's turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    let session = world.agents.running(&thread()).expect("the session's agent");
    // The turn's start left the session on a route of Mixdog's own (a pick held for the turn): the loop runs it.
    let header = json!({ "provider": "openai", mixdog_acp::runs::SESSION_KEY: { "agent": "antigravity", "sessionId": "sess-1" } })
        .as_object()
        .cloned()
        .expect("a header");
    let change = mixdog_acp::runs::loop_turn(&world.agents, &thread(), &header).expect("the agent's session leaves the header");
    // (The turn starts once this change is saved: `run_host::factory::drive` fails the start on a write that fails.)
    assert_eq!(change.unset, [mixdog_acp::runs::SESSION_KEY]);
    within("the agent's exit", session.connection.exited().cancelled()).await;
    assert!(world.agents.running(&thread()).is_none());
    // A session that holds no agent session has nothing to forget.
    let plain = json!({ "provider": "openai" }).as_object().cloned().expect("a header");
    assert!(mixdog_acp::runs::loop_turn(&world.agents, &thread(), &plain).is_none());
}

/// The live route of the one thread.
#[derive(Default)]
struct Routes(Mutex<Route>);

#[async_trait]
impl RouteWriter for Routes {
    fn route(&self, _: &ThreadId) -> Route {
        self.0.lock().unwrap().clone()
    }

    fn set_route_state(&self, _: &ThreadId, route: Route) {
        *self.0.lock().unwrap() = route;
    }

    fn generation(&self, _: &ThreadId) -> u64 {
        0
    }

    async fn refresh_route_effort(
        &self,
        _: &ThreadId,
        _: Option<Value>,
        _: bool,
        _: Option<u64>,
    ) -> Result<Option<Route>, mixdog_tools::orch::util::PortError> {
        Ok(None)
    }

    fn refresh_statusline_usage(&self, _: &ThreadId, _: &Route) {}
}

/// Makes `link` a folder that is `target`: a junction on Windows, which needs no privilege, a symlink elsewhere.
#[allow(clippy::disallowed_methods, reason = "a test links a folder")]
fn link_folder(link: &std::path::Path, target: &std::path::Path) {
    #[cfg(windows)]
    {
        let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().expect("mklink");
        assert!(made.status.success(), "the junction: {made:?}");
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link).expect("the link");
}

/// The tools a request of the test's bridge session defines directly.
const DIRECT_TOOLS: [&str; 6] = ["read", "shell", "Skill", "todo", "edit", "picture"];
/// A tool of the session's catalog that its requests do not define.
const DEFERRED_TOOL: &str = "browser";

fn described(name: &str) -> String {
    format!("{name} of the session")
}

type Ran = Arc<Mutex<Vec<(ThreadId, String, Value)>>>;
/// What the loop's execution of the calls did, in order: the gate's judgements and the hooks' reports.
type Seen = Arc<Mutex<Vec<String>>>;

/// A tool of the test's session: it keeps what it was called with and answers that it ran.
struct Echo {
    spec: ToolSpec,
    ran: Ran,
}

fn spec(name: &str) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: described(name),
        input_schema: json!({ "type": "object" }),
        annotations: Default::default(),
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }
}

#[async_trait]
impl Tool for Echo {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, arguments: Value) -> ToolOutcome {
        let name = self.spec.name.to_string();
        self.ran.lock().unwrap().push((ctx.thread_id.clone(), name.clone(), arguments.clone()));
        let text = |text: String| vec![ToolPart::Text(text)];
        Ok(match name.as_str() {
            // A skill's instructions are a message the loop adds after the call's own short result.
            "Skill" => {
                let follow_up = FollowUpMessage { text: "<skill>\nDo the thing this way.\n</skill>".to_owned(), meta: Some("skill".to_owned()) };
                ToolOutput { parts: text("Skill pdf loaded".to_owned()), follow_up_messages: vec![follow_up], ..ToolOutput::default() }
            }
            "edit" => ToolOutput { parts: text("edited".to_owned()), meta: Some(json!({ "uiDiff": "@@ -1 +1 @@\n-one\n+two" })), ..ToolOutput::default() },
            "picture" => {
                let image = ToolPart::Image {
                    mime: "image/png".to_owned(),
                    data: mixdog_core_api::domain::tool::ImageData::Bytes(b"png".to_vec()),
                    width: None,
                    height: None,
                };
                ToolOutput { parts: vec![ToolPart::Text("a picture".to_owned()), image], ..ToolOutput::default() }
            }
            _ => ToolOutput { parts: text(format!("{name} ran with {arguments}")), ..ToolOutput::default() },
        })
    }
}

/// The test session's tool that changes nothing.
const LOOK: &str = "look";

/// A tool of the test's session that changes nothing: each call waits until another call of it has started, so two
/// calls of it end only where they run at the same time.
struct Look {
    spec: ToolSpec,
    ran: Ran,
    meet: Arc<tokio::sync::Barrier>,
}

#[async_trait]
impl Tool for Look {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, arguments: Value) -> ToolOutcome {
        self.meet.wait().await;
        self.ran.lock().unwrap().push((ctx.thread_id.clone(), LOOK.to_owned(), arguments.clone()));
        Ok(ToolOutput { parts: vec![ToolPart::Text(format!("{LOOK} met another with {arguments}"))], ..ToolOutput::default() })
    }
}

/// The session's catalog: which of its tools its requests define, and which are left to the bridge.
struct Pool;

#[async_trait]
impl ToolDispatcher for Pool {
    async fn dispatch(&self, _: &ToolContext, name: &str, _: Value) -> ToolOutcome {
        panic!("a handed call_tool is projected onto {name} by the loop, never dispatched by the bridge tool")
    }
}

/// The gate and the hooks of the session's calls: `shell` needs the user's approval, a file `secret…` and a command
/// that says `forbidden` are refused, and a command that says `moved` runs only rewritten.
struct Witness(Seen);

#[async_trait]
impl ToolGate for Witness {
    async fn check_call(&self, call_id: &str, call: &GateCall) -> GateDecision {
        self.0.lock().unwrap().push(format!("judge {}", call.name));
        let says = |key: &str, word: &str| call.args[key].as_str().is_some_and(|text| text.contains(word));
        if says("file_path", "secret") || says("command", "forbidden") {
            return GateDecision::Deny(format!("Error: tool \"{}\" denied by hook", call.name));
        }
        if says("command", "moved") {
            return GateDecision::Rewrite(GateCall::new(call.name.clone(), json!({ "command": "ls elsewhere" })));
        }
        if call.name != "shell" {
            return GateDecision::Allow;
        }
        let ask = ApprovalAsk {
            kind: ApprovalKind::Tool,
            call_id: Some(mixdog_protocol::ToolCallId::from(call_id.to_owned())),
            tool: Some(call.name.clone()),
            action_kind: None,
            reason: None,
            payload: json!({ "name": call.name, "args": call.args }),
            remember: Vec::new(),
            expires_after: None,
        };
        GateDecision::Ask(Box::new(GateAsk { reason: "shell runs a command".to_owned(), ask, call: None }))
    }
}

#[async_trait]
impl ToolHooks for Witness {
    async fn after_tool(&self, _: &str, call: &GateCall, _: &str) -> Option<String> {
        self.0.lock().unwrap().push(format!("report {}", call.name));
        None
    }
}

/// The session's approval cards, as a turn's port asks them.
struct Cards(Surface);

#[async_trait]
impl ApprovalGate for Cards {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        self.0.approve(ask).await
    }
}

#[async_trait]
impl CatalogView for Pool {
    fn available(&self, _: &ThreadId) -> Vec<ToolDoc> {
        let doc =
            |name: &&str| ToolDoc { name: (*name).to_owned(), description: described(name), input_schema: json!({ "type": "object" }), annotations: json!({}) };
        DIRECT_TOOLS.iter().chain(&[DEFERRED_TOOL]).map(doc).collect()
    }

    fn is_eager(&self, _: &ThreadId, name: &str) -> bool {
        DIRECT_TOOLS.contains(&name)
    }

    fn block_reason(&self, _: &ThreadId, _: &str) -> Option<String> {
        None
    }

    fn alias_members(&self, _: &str) -> Vec<String> {
        Vec::new()
    }

    fn mcp_server_members(&self, _: &ThreadId, _: &str) -> Vec<String> {
        Vec::new()
    }

    fn instructions_for(&self, _: &ThreadId, _: &[String]) -> String {
        String::new()
    }

    async fn announce(&self, _: &ThreadId, _: &[String]) {}

    fn resolve_call(&self, _: &ThreadId, name: &str) -> CallResolution {
        match name {
            DEFERRED_TOOL => CallResolution::Deferred(name.to_owned()),
            name if DIRECT_TOOLS.contains(&name) => CallResolution::Direct(name.to_owned()),
            _ => CallResolution::NotFound,
        }
    }
}

/// The session's side of the hand-over, as a bridge session has it: the tools its requests define directly, the tool
/// they leave to the bridge, and Mixdog's own two bridge tools over the session's catalog. A call of one runs through
/// the loop's execution of a call ([`HandedCalls`]), under [`Witness`].
struct Tools {
    ran: Ran,
    seen: Seen,
    set: Vec<Arc<dyn Tool>>,
    processes: Arc<dyn ProcessManager>,
}

impl Tools {
    fn new(processes: Arc<dyn ProcessManager>) -> Arc<Self> {
        let ran = Ran::default();
        let pool = Arc::new(Pool);
        let mut set: Vec<Arc<dyn Tool>> =
            DIRECT_TOOLS.iter().chain(&[DEFERRED_TOOL]).map(|name| Arc::new(Echo { spec: spec(name), ran: ran.clone() }) as Arc<dyn Tool>).collect();
        set.push(Arc::new(Look {
            spec: ToolSpec { annotations: ToolAnnotations { read_only_hint: Some(true), ..ToolAnnotations::default() }, ..spec(LOOK) },
            ran: ran.clone(),
            meet: Arc::new(tokio::sync::Barrier::new(2)),
        }));
        set.push(Arc::new(LoadTool::new(pool.clone())));
        set.push(Arc::new(CallTool::new(pool.clone(), pool)));
        Arc::new(Self { ran, seen: Seen::default(), set, processes })
    }

    /// The calls of one turn whose approvals are asked on `surface`.
    fn calls(&self, surface: &Surface) -> Arc<HandedCalls> {
        let tokens = mixdog_rt::testing::tokens();
        Arc::new(HandedCalls::new(HandedParts {
            tools: ToolSet::new(self.set.clone()),
            tool_env: ToolEnv {
                thread_id: thread(),
                turn_id: TurnId::from("turn-1"),
                cwd: AbsPath::new(std::env::temp_dir()).expect("an absolute temp dir"),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(Cards(surface.clone())),
                files: Arc::new(MockFileService::default()),
                processes: self.processes.clone(),
                progress: Arc::new(MockProgress::default()),
                deadline_of: None,
                notify: None,
                review: None,
            },
            gate: Arc::new(Witness(self.seen.clone())),
            hooks: Some(Arc::new(Witness(self.seen.clone()))),
            guards: Arc::new(mixdog_agent::env::NoGuards),
            reuse: None,
            clock: Arc::new(Zero),
            observer: Arc::new(mixdog_agent::env::NullObserver),
            mcp: None,
            live_cwd: None,
            artifacts: None,
            images: None,
            failures: None,
            repeat: Default::default(),
            cancel: CancellationToken::new(),
            slot: None,
            asks: None,
        }))
    }

    /// One prompt of the agent in a turn that runs the session's tools.
    async fn prompt(&self, world: &World, surface: &Surface, text: &str) -> TurnEnd {
        within("the turn", world.prompt_with(&thread(), surface, text, None, CancellationToken::new(), Some(self.calls(surface)))).await
    }
}

struct Zero;

impl mixdog_agent::env::Clock for Zero {
    fn now_ms(&self) -> i64 {
        0
    }
}

#[async_trait]
impl SessionTools for Tools {
    /// What a request of the bridge session sends: its directly defined tools, then `load_tool` and `call_tool`.
    async fn definitions(&self, _: &ThreadId) -> Result<Vec<ToolDefinition>, String> {
        let sent = self.set.iter().map(|tool| tool.spec()).filter(|spec| spec.name != DEFERRED_TOOL);
        Ok(sent
            .map(|spec| ToolDefinition {
                name: spec.name.to_string(),
                description: spec.description.clone(),
                input_schema: spec.input_schema.clone(),
                defer_loading: false,
                freeform: None,
            })
            .collect())
    }
}

/// A world whose sessions hand their tools to the agent.
fn handing(settings: &[(&str, &str)]) -> (World, Arc<Tools>) {
    let world = World::new(settings);
    let tools = Tools::new(world.processes.clone());
    world.agents.bind_tools(tools.clone());
    (world, tools)
}

#[tokio::test]
async fn the_agent_is_handed_the_sessions_tools_and_its_call_runs_in_the_session_as_that_tools_call() {
    let (world, tools) = handing(&[]);
    let end = within("the listing", world.prompt(&thread(), &Surface::default(), "tools", None, CancellationToken::new())).await;
    // The agent's listing is what the session's side lists, in its order, and no tool of the catalog besides: only the
    // server's own tool that makes several of their calls at once follows them.
    let sent: Vec<String> = tools.definitions(&thread()).await.expect("the session's tools").into_iter().map(|tool| tool.name).collect();
    assert_eq!(completed_text(&end), format!("tools={},{BATCH_TOOL}", sent.join(",")));
    // Nothing the agent has its own tool for is withheld: the agent reads Office files, lists and searches through Mixdog's.
    assert!(sent.iter().any(|name| name == "read"), "{sent:?}");
    assert!(!sent.iter().any(|name| name == DEFERRED_TOOL) && sent.ends_with(&["load_tool".to_owned(), "call_tool".to_owned()]), "{sent:?}");

    let surface = Surface::default();
    let end = tools.prompt(&world, &surface, r#"tool read {"path":"a.txt"}"#).await;
    let result = r#"read ran with {"path":"a.txt"}"#;
    assert_eq!(end, TurnEnd::Completed { text: format!("result:{result}"), stop_reason: Some("end_turn".into()), tool_calls: 1 });
    assert_eq!(*tools.ran.lock().unwrap(), [(thread(), "read".to_owned(), json!({ "path": "a.txt" }))]);
    // The loop's own execution ran it: judged by the gate once and reported to the hooks once.
    assert_eq!(*tools.seen.lock().unwrap(), ["judge read", "report read"]);
    // One card, Mixdog's own tool's: the agent's report of the same call is no second one.
    let rows = surface.rows();
    assert_eq!(rows.iter().map(|row| row["role"].as_str().unwrap_or_default()).collect::<Vec<_>>(), ["assistant", "tool", "assistant"], "{rows:?}");
    let call = &rows[0]["toolCalls"][0];
    assert_eq!((&call["name"], &call["arguments"]), (&json!("read"), &json!({ "path": "a.txt" })));
    assert_eq!((&rows[1]["toolCallId"], &rows[1]["content"]), (&call["id"], &json!(result)));

    // The agent's system prompt ends with the word to prefer the session's tools.
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert!(completed_text(&end).contains(&format!("append=RULES\n\n{}", mixdog_acp::mcp::preference())), "{end:?}");
}

#[tokio::test]
async fn the_agents_prompt_is_appended_the_bridge_sessions_system_text_with_its_roster_and_bridge_section() {
    let (world, _tools) = handing(&[]);
    // A bridge session's system text as Mixdog composes it: the roster of its deferred tools, then how to reach them.
    let rules = "RULES\n\n---\n\n<available-deferred-tools>\n- browser: Browser.\n</available-deferred-tools>\n\n<tool-bridge>\nRun one with call_tool {name, arguments}.\n</tool-bridge>";
    let session = world.agents.session(&thread(), &world.preset, world.cwd(), None, Some(rules.to_owned())).await.expect("the agent starts");
    let whoami = Ask::Prompt(vec![json!({ "type": "text", "text": "whoami" })]);
    let told = within("the turn", mixdog_acp::turn::run(&session, Arc::new(Surface::default()), whoami, world.context(CancellationToken::new()))).await;
    assert!(completed_text(&told).contains(&format!("append={rules}\n\n{} model=", mixdog_acp::mcp::preference())), "{told:?}");
}

#[tokio::test]
async fn a_deferred_tool_is_not_listed_and_runs_through_call_tool_as_a_direct_call_runs() {
    let (world, tools) = handing(&[]);
    let end = within("the listing", world.prompt(&thread(), &Surface::default(), "tools", None, CancellationToken::new())).await;
    assert!(!completed_text(&end).contains(DEFERRED_TOOL), "{end:?}");

    let surface = Surface::default();
    let bridged = json!({ "name": DEFERRED_TOOL, "arguments": { "url": "x" } });
    let end = tools.prompt(&world, &surface, &format!("tool call_tool {bridged}")).await;
    // The tool ran once, with the arguments it was passed, and answered what a call of it answers.
    assert_eq!(completed_text(&end), r#"result:browser ran with {"url":"x"}"#);
    assert_eq!(*tools.ran.lock().unwrap(), [(thread(), DEFERRED_TOOL.to_owned(), json!({ "url": "x" }))]);
    // The loop projected the call onto its target: the gate judged the target once and the hooks heard of it once, and
    // neither heard of `call_tool`.
    assert_eq!(*tools.seen.lock().unwrap(), ["judge browser", "report browser"]);
    // The session shows the call the agent made: the bridge tool's, as a Mixdog bridge session shows it.
    let rows = surface.rows();
    let call = &rows[0]["toolCalls"][0];
    assert_eq!((&call["name"], &call["arguments"]), (&json!("call_tool"), &bridged), "{rows:?}");
    assert_eq!(rows[1]["content"], r#"browser ran with {"url":"x"}"#);

    // A directly defined tool called with the same arguments answers in the same form: the bridge added nothing to the outcome.
    let direct = tools.prompt(&world, &Surface::default(), r#"tool read {"url":"x"}"#).await;
    assert_eq!(completed_text(&direct), r#"result:read ran with {"url":"x"}"#);

    // The server lists no deferred tool, and a call of one by its own name is refused: the bridge is the way to it.
    let end = tools.prompt(&world, &Surface::default(), r#"tool browser {"url":"y"}"#).await;
    assert_eq!(completed_text(&end), "error:browser is not a tool of this session.");
    assert_eq!(tools.ran.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn load_tool_describes_a_deferred_tool_to_the_agent_and_runs_nothing() {
    let (world, tools) = handing(&[]);
    let end = tools.prompt(&world, &Surface::default(), r#"tool load_tool {"names":"browser"}"#).await;
    let described = completed_text(&end);
    assert!(described.starts_with("result:") && described.contains(DEFERRED_TOOL) && described.contains(&self::described(DEFERRED_TOOL)), "{described}");
    assert!(tools.ran.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_skills_instructions_come_back_to_the_agent_as_the_calls_result() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    let end = tools.prompt(&world, &surface, r#"tool Skill {"name":"pdf"}"#).await;
    assert_eq!(completed_text(&end), "result:Skill pdf loaded\n<skill>\nDo the thing this way.\n</skill>");
    // The session's row of the call is the loop's tool message of it.
    let rows = surface.rows();
    assert_eq!((&rows[0]["toolCalls"][0]["name"], &rows[1]["content"]), (&json!("Skill"), &json!("Skill pdf loaded")), "{rows:?}");
}

#[tokio::test]
async fn a_handed_calls_card_shows_its_diff_and_its_images_reach_the_agent_as_images() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    let end = tools.prompt(&world, &surface, "tool edit {}").await;
    assert_eq!(completed_text(&end), "result:edited");
    let rows = surface.rows();
    assert_eq!((&rows[1]["role"], &rows[1]["uiDiff"]), (&json!("tool"), &json!("@@ -1 +1 @@\n-one\n+two")), "{rows:?}");

    let end = tools.prompt(&world, &Surface::default(), "tool picture {}").await;
    assert_eq!(completed_text(&end), "result:a picture images=1");
}

#[tokio::test]
async fn a_stop_that_lands_while_a_calls_result_is_stored_still_leaves_the_call_its_result() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    let cancel = CancellationToken::new();
    // The turn's own surface refuses the result's row and the turn is stopped in that moment.
    *surface.0.stops_at_result.lock().unwrap() = Some(cancel.clone());
    let end = within("the turn", world.prompt_with(&thread(), &surface, "tool read {}", None, cancel, Some(tools.calls(&surface)))).await;
    assert_eq!(end, TurnEnd::Interrupted);
    let rows = surface.rows();
    let call = rows[0]["toolCalls"][0]["id"].clone();
    assert!(call.is_string() && rows.iter().any(|row| row["role"] == "tool" && row["toolCallId"] == call), "the stored call has no result: {rows:?}");
}

#[tokio::test]
async fn the_agents_own_plan_and_the_todo_tool_write_the_sessions_one_step_list() {
    let (world, tools) = handing(&[]);
    // The agent's own plan update is written into the session's list by the `todo` tool, as a call of that tool is.
    let surface = Surface::default();
    tools.prompt(&world, &surface, "stream").await;
    let plan = json!({ "op": "set", "items": [{ "content": "first", "status": "completed" }, { "content": "second", "status": "in_progress" }] });
    assert_eq!(*tools.ran.lock().unwrap(), [(thread(), "todo".to_owned(), plan.clone())]);
    let rows = surface.rows();
    let card = rows.iter().find_map(|row| row["toolCalls"].as_array()?.iter().find(|call| call["name"] == "todo")).expect("the plan's card");
    let row = rows.iter().find(|row| row["toolCallId"] == card["id"]).expect("the plan's result");
    assert_eq!((&card["arguments"], &row["content"]), (&plan, &json!(format!("todo ran with {plan}"))), "{rows:?}");

    // The tool itself, called by the agent, writes the same list: the newer of the two is what it shows.
    let next = json!({ "op": "set", "items": ["only"] });
    let end = tools.prompt(&world, &Surface::default(), &format!("tool todo {next}")).await;
    assert_eq!(completed_text(&end), format!("result:todo ran with {next}"));
    assert_eq!(tools.ran.lock().unwrap().last(), Some(&(thread(), "todo".to_owned(), next)));
}

#[tokio::test]
async fn a_handed_tools_approval_is_asked_on_the_sessions_card_and_a_refusal_reaches_the_agent() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().extend([decided(json!({ "approved": false })), decided(json!({ "approved": true }))]);
    let end = tools.prompt(&world, &surface, r#"tool shell {"command":"ls"}"#).await;
    assert!(completed_text(&end).starts_with("error:"), "{end:?}");
    assert!(tools.ran.lock().unwrap().is_empty());
    let end = tools.prompt(&world, &surface, r#"tool shell {"command":"ls"}"#).await;
    assert_eq!(completed_text(&end), r#"result:shell ran with {"command":"ls"}"#);
    // The loop's approval wait asked on the session's card, for the call the card is of.
    let asks = surface.0.asks.lock().unwrap().clone();
    assert_eq!(asks.iter().map(|ask| ask.tool.as_deref()).collect::<Vec<_>>(), [Some("shell"), Some("shell")]);
    let rows = surface.rows();
    assert_eq!(asks[0].call_id.as_ref().map(|id| json!(id.as_str())), Some(rows[0]["toolCalls"][0]["id"].clone()), "{rows:?}");
    // The refused call has its card and its result as the approved one has.
    assert_eq!(cards(&surface), ["shell", "shell"]);
    assert_eq!(rows.iter().filter(|row| row["role"] == "tool").count(), 2, "{rows:?}");
}

/// A prompt that has the fake agent make `calls` in one call of the batch tool.
fn batch(calls: Value) -> String {
    format!("tool {BATCH_TOOL} {}", json!({ "calls": calls }))
}

/// The calls a batch carries that change nothing run at the same time: two calls of a tool that each wait for another
/// to have started both end. They are one step's calls, made in one assistant row and each given its result row, and
/// the agent reads every result in the order given, each headed by its position and its tool.
#[tokio::test]
async fn a_batchs_calls_that_change_nothing_run_at_the_same_time() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    let end = tools.prompt(&world, &surface, &batch(json!([{ "tool": LOOK, "arguments": { "at": "a" } }, { "tool": LOOK, "arguments": { "at": "b" } }]))).await;
    let told = "result:[1/2] look\nlook met another with {\"at\":\"a\"}\n[2/2] look\nlook met another with {\"at\":\"b\"}";
    assert_eq!(end, TurnEnd::Completed { text: told.to_owned(), stop_reason: Some("end_turn".into()), tool_calls: 2 });
    let rows = surface.rows();
    assert_eq!(rows.iter().map(|row| row["role"].as_str().unwrap_or_default()).collect::<Vec<_>>(), ["assistant", "tool", "tool", "assistant"], "{rows:?}");
    let calls = rows[0]["toolCalls"].as_array().expect("the step's calls");
    let made: Vec<(&Value, &Value)> = calls.iter().map(|call| (&call["name"], &call["arguments"])).collect();
    assert_eq!(made, [(&json!(LOOK), &json!({ "at": "a" })), (&json!(LOOK), &json!({ "at": "b" }))]);
    assert_eq!((&rows[1]["toolCallId"], &rows[2]["toolCallId"]), (&calls[0]["id"], &calls[1]["id"]));
    // Each was judged and reported as a direct call of the tool is.
    let mut seen = tools.seen.lock().unwrap().clone();
    seen.sort();
    assert_eq!(seen, ["judge look", "judge look", "report look", "report look"]);
}

/// The calls a batch carries that change something run alone, in the order given: each is judged once every call before
/// it has been reported, and the calls after it once it has been. The calls between two of them that change nothing run
/// together.
#[tokio::test]
async fn a_batchs_calls_that_change_something_run_alone_in_the_order_given() {
    let (world, tools) = handing(&[]);
    let calls = json!([
        { "tool": "edit", "arguments": { "n": 1 } },
        { "tool": LOOK, "arguments": { "at": "a" } },
        { "tool": LOOK, "arguments": { "at": "b" } },
        { "tool": "todo", "arguments": { "n": 2 } },
        { "tool": "edit", "arguments": { "n": 3 } },
    ]);
    let end = tools.prompt(&world, &Surface::default(), &batch(calls)).await;
    let told = completed_text(&end);
    assert!(told.starts_with("result:[1/5] edit\nedited\n[2/5] look\n") && told.ends_with("[4/5] todo\ntodo ran with {\"n\":2}\n[5/5] edit\nedited"), "{told}");
    let ran: Vec<String> = tools.ran.lock().unwrap().iter().map(|(_, name, arguments)| format!("{name} {arguments}")).collect();
    assert_eq!((ran[0].as_str(), &ran[3..]), ("edit {\"n\":1}", &["todo {\"n\":2}".to_owned(), "edit {\"n\":3}".to_owned()][..]));
    let seen = tools.seen.lock().unwrap().clone();
    assert_eq!(seen[..2], ["judge edit", "report edit"]);
    let mut looks = seen[2..6].to_vec();
    looks.sort();
    assert_eq!(looks, ["judge look", "judge look", "report look", "report look"]);
    assert_eq!(seen[6..], ["judge todo", "report todo", "judge edit", "report edit"]);
}

/// Each call a batch carries meets the session's permissions as a direct call of its tool does: the gate judges it, what
/// the gate asks about is asked on the session's card for that call, and what is refused never runs.
#[tokio::test]
async fn each_call_a_batch_carries_meets_the_sessions_permissions_as_a_direct_call_does() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    // The first command is approved; the second finds nobody to approve it.
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true })));
    let calls = json!([
        { "tool": "shell", "arguments": { "command": "ls" } },
        { "tool": "read", "arguments": { "file_path": "secret.txt" } },
        { "tool": "shell", "arguments": { "command": "pwd" } },
    ]);
    let end = tools.prompt(&world, &surface, &batch(calls)).await;
    let told = completed_text(&end);
    assert!(told.starts_with("result:[1/3] shell\nshell ran with {\"command\":\"ls\"}\n[2/3] read (failed)\n"), "{told}");
    assert!(told.contains("denied by hook") && told.contains("[3/3] shell (failed)\n"), "{told}");
    assert_eq!(*tools.seen.lock().unwrap(), ["judge shell", "report shell", "judge read", "judge shell"]);
    assert_eq!(*tools.ran.lock().unwrap(), [(thread(), "shell".to_owned(), json!({ "command": "ls" }))]);
    // Both commands were asked about on the session's card, each for the card of its own call.
    let rows = surface.rows();
    let ids: Vec<Value> = rows[0]["toolCalls"].as_array().expect("the step's calls").iter().map(|call| call["id"].clone()).collect();
    let asks = surface.0.asks.lock().unwrap().clone();
    let asked: Vec<(Option<&str>, Option<Value>)> = asks.iter().map(|ask| (ask.tool.as_deref(), ask.call_id.as_ref().map(|id| json!(id.as_str())))).collect();
    assert_eq!(asked, [(Some("shell"), Some(ids[0].clone())), (Some("shell"), Some(ids[2].clone()))]);
    // The refused calls have their results as the one that ran has.
    assert_eq!(rows.iter().filter(|row| row["role"] == "tool").count(), 3, "{rows:?}");
}

/// A refused or failed item of a batch does not stop the others: every item is answered in the order given, one that
/// makes no call of the session's tools (it names no tool of the surface, or the batch tool itself, or its arguments are
/// no object) is answered without a card, and the batch is an error only where nothing succeeded. An item may name a
/// tool as the agent's own tool list names it.
#[tokio::test]
async fn a_refused_or_failed_item_of_a_batch_leaves_the_others_their_results() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    let calls = json!([
        { "tool": "read", "arguments": { "file_path": "secret.txt" } },
        { "tool": "nowhere", "arguments": {} },
        { "tool": BATCH_TOOL, "arguments": { "calls": [] } },
        { "tool": "call_tool", "arguments": { "name": "nowhere", "arguments": {} } },
        { "tool": "mcp_mixdog_read", "arguments": { "file_path": "a.txt" } },
        { "tool": "edit", "arguments": "a.txt" },
    ]);
    let end = tools.prompt(&world, &surface, &batch(calls)).await;
    let told = completed_text(&end);
    let heads = ["read (failed)", "nowhere (failed)", "batch (failed)", "call_tool (failed)", "read", "edit (failed)"];
    for (index, head) in heads.iter().enumerate() {
        assert!(told.contains(&format!("[{}/6] {head}\n", index + 1)), "{told}");
    }
    assert!(told.starts_with("result:") && told.contains("[2/6] nowhere (failed)\nnowhere is not a tool of this session.\n"), "{told}");
    assert!(told.contains("[5/6] read\nread ran with {\"file_path\":\"a.txt\"}\n"), "{told}");
    assert_eq!(*tools.ran.lock().unwrap(), [(thread(), "read".to_owned(), json!({ "file_path": "a.txt" }))]);
    // The calls that met the session's pipeline have their cards in the step's one row and their results.
    assert_eq!(cards(&surface), ["read", "call_tool", "read"]);
    let rows = surface.rows();
    assert_eq!(rows.iter().filter(|row| row["role"] == "tool").count(), 3, "{rows:?}");

    let end = tools.prompt(&world, &Surface::default(), &batch(json!([{ "tool": "nowhere", "arguments": {} }]))).await;
    assert_eq!(completed_text(&end), "error:[1/1] nowhere (failed)\nnowhere is not a tool of this session.");
}

#[tokio::test]
async fn a_session_handed_the_tools_has_the_agent_definition_without_the_clis_own_tools_written_for_its_start() {
    let (world, _tools) = handing(&[]);
    let end = within("the definition", world.prompt(&thread(), &Surface::default(), "definition", None, CancellationToken::new())).await;
    let text = completed_text(&end).strip_prefix("definition=").expect("the definition").to_owned();
    assert!(text.contains("\ntools: []\n"), "{text}");
    // Every tool the session's server lists is declared to the model with its schema.
    let end = within("the tools", world.prompt(&thread(), &Surface::default(), "tools", None, CancellationToken::new())).await;
    let names = completed_text(&end).strip_prefix("tools=").expect("the tools").to_owned();
    assert!(names.contains("read") && names.ends_with(BATCH_TOOL), "{names}");
    for name in names.split(',') {
        assert!(text.contains(&format!("      \"{name}\":\n        eager: true\n")), "{name} in {text}");
    }
}

#[tokio::test]
async fn an_agent_that_takes_no_http_server_reaches_the_tools_through_the_bridge_program() {
    let (world, tools) = handing(&[("FAKE_AGENT_STDIO_MCP", "1")]);
    let end = within("the servers", world.prompt(&thread(), &Surface::default(), "servers", None, CancellationToken::new())).await;
    let servers: Value = serde_json::from_str(completed_text(&end).strip_prefix("servers=").expect("the servers")).expect("JSON");
    assert_eq!((&servers[0]["name"], &servers[0]["args"], servers[0].get("url")), (&json!("mixdog"), &json!(["mcp-bridge"]), None));
    let end = tools.prompt(&world, &Surface::default(), r#"tool read {"path":"b.txt"}"#).await;
    assert_eq!(completed_text(&end), r#"result:read ran with {"path":"b.txt"}"#);
    assert_eq!(tools.ran.lock().unwrap().len(), 1);
}

#[tokio::test]
#[allow(clippy::disallowed_methods, reason = "a test's own blocking client")]
async fn the_tool_server_answers_its_agent_alone_and_ends_with_the_agents_process() {
    let (world, _tools) = handing(&[]);
    let end = within("the servers", world.prompt(&thread(), &Surface::default(), "servers", None, CancellationToken::new())).await;
    let servers: Value = serde_json::from_str(completed_text(&end).strip_prefix("servers=").expect("the servers")).expect("JSON");
    let url = servers[0]["url"].as_str().expect("an HTTP server");
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    let port: u16 = url.split(':').nth(2).and_then(|rest| rest.split('/').next()).and_then(|port| port.parse().ok()).expect("the port");
    let token = servers[0]["headers"][0]["value"].as_str().and_then(|value| value.strip_prefix("Bearer ")).expect("the token").to_owned();
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string();
    let post = |token: String, message: String| tokio::task::spawn_blocking(move || mixdog_acp::mcp_bridge::post(port, &token, &message));

    let listed = within("the listing", post(token.clone(), list.clone())).await.expect("joined").expect("answered").expect("a body");
    assert!(listed.contains(r#""name":"read""#), "{listed}");
    let refused = within("the refusal", post("not-the-token".to_owned(), list.clone())).await.expect("joined").expect_err("refused");
    assert!(refused.to_string().contains("401"), "{refused}");

    // The server is the process's: it is gone once the agent is.
    let session = world.agents.running(&thread()).expect("the session's agent");
    world.agents.release(&thread());
    within("the agent's exit", session.connection.exited().cancelled()).await;
    within("the server's end", async {
        while post(token.clone(), list.clone()).await.expect("joined").is_ok() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
}

#[tokio::test]
async fn a_session_whose_tools_are_not_bound_hands_its_agent_no_server() {
    let world = World::new(&[]);
    let end = within("the servers", world.prompt(&thread(), &Surface::default(), "servers", None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "servers=[]");
}

/// A world whose CLI is on no `PATH`: the installer puts it under `FAKE_HOME`.
fn uninstalled(settings: &[(&str, &str)]) -> World {
    World::build(settings, |preset, dir| {
        let installed = format!("bin/fake-agy{}", std::env::consts::EXE_SUFFIX);
        preset.upkeep.installer = Some(Command {
            program: mixdog_testkit::bin_exe!("mixdog-acp-fake-agent"),
            args: vec!["install-into".into(), dir.join("home").join(&installed).to_string_lossy().into_owned()],
        });
        preset.upkeep.installed_at = vec![Location { env: "FAKE_HOME".into(), path: installed }];
        preset.command = "mixdog-acp-no-such-cli".into();
    })
}

#[tokio::test]
async fn a_missing_cli_is_installed_by_the_feature_and_found_without_a_restart() {
    let world = uninstalled(&[]);
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["canInstall"]), (&json!("notInstalled"), &json!(true)));
    assert_eq!(world.logged("install"), 0, "a check installs nothing");

    within("the install", world.agents.install()).await.expect("the install");
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["version"], &agent["lastError"]), (&json!("ready"), &json!("1.5.1"), &Value::Null));
    assert_eq!(world.logged("install"), 1);
    // A session starts on the CLI where the installer put it.
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1"), "{end:?}");
}

#[tokio::test]
async fn a_failed_install_says_what_failed() {
    let world = uninstalled(&[("FAKE_AGENT_INSTALL_FAILS", "no route to the download server")]);
    let failed = within("the install", world.agents.install()).await.expect_err("the install fails");
    assert_eq!(failed, "Antigravity ACP could not be installed: no route to the download server");
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!(agent["state"], "notInstalled");
    assert_eq!(agent["lastError"], json!({ "action": "install", "message": "no route to the download server" }));
    world.all_exited().await;
}

#[tokio::test]
async fn turning_the_feature_off_ends_a_running_install_at_once() {
    let world = uninstalled(&[("FAKE_AGENT_INSTALL_HANGS", "1")]);
    let installing = world.agents.install();
    let off = async {
        while world.logged("install") == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(world.agents.status()["agents"][0]["state"], "installing");
        // The switch is written and the value read again, as the settings call does while the install call still waits.
        world.enabled.store(false, Ordering::SeqCst);
        assert_eq!(world.agents.status()["agents"][0]["state"], "off");
    };
    let (installed, ()) = within("the install's end", async { tokio::join!(installing, off) }).await;
    assert_eq!(installed, Err("ACP agents were turned off before the install ended.".to_owned()));
    world.all_exited().await;
    assert_eq!(world.logged("install"), 1);
}

#[tokio::test]
async fn a_newer_version_is_fetched_at_the_features_check_and_never_under_a_running_session() {
    let world = World::new(&[("FAKE_AGENT_VERSION", "1.5.1"), ("FAKE_AGENT_UPDATE_TO", "1.6.0")]);
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["version"]), (&json!("ready"), &json!("1.6.0")));
    assert_eq!(world.logged("update"), 1);

    // A session's agent runs on the CLI: a check leaves the CLI as it is.
    within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert_eq!(world.checked().await["state"], "ready");
    assert_eq!(world.logged("update"), 1);

    let session = world.agents.running(&thread()).expect("the session's agent");
    world.agents.release(&thread());
    within("the agent's exit", session.connection.exited().cancelled()).await;
    world.checked().await;
    assert_eq!(world.logged("update"), 2);
}

#[tokio::test]
async fn a_failed_update_keeps_the_working_cli_and_is_reported_once() {
    let world = World::new(&[("FAKE_AGENT_UPDATE_FAILS", "the download was interrupted")]);
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["version"]), (&json!("ready"), &json!("1.5.1")));
    assert_eq!(agent["lastError"], json!({ "action": "update", "message": "the download was interrupted" }));
    assert_eq!(world.logged("update"), 1, "a failed update is not tried again by the check that ran it");
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");
}

/// What may change the account an agent's quota was read of (a sign-in begun, a sign-in settled, a sign-out, the
/// feature turned off) reaches the callback bound for it, with the agent's id; only the settled sign-in asks for the
/// next reading to be taken at once.
#[tokio::test]
async fn each_change_of_an_agents_account_reaches_the_bound_callback() {
    let world = World::new(&[]);
    assert_eq!(world.checked().await["state"], "ready");
    let told: Arc<Mutex<Vec<(String, AccountEvent)>>> = Arc::default();
    world.agents.bind_account_change({
        let told = told.clone();
        Arc::new(move |id: &str, event: AccountEvent| told.lock().unwrap().push((id.to_owned(), event)))
    });
    let id = world.preset.id.clone();
    let seen = || told.lock().unwrap().clone();

    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    assert_eq!(seen(), [(id.clone(), AccountEvent::Left)], "a sign-in begun");
    login.cancel();

    // The look the settle makes finds the CLI ready (askable), then the sign-in is told.
    assert_eq!(within("the sign-in's settle", (world.agents.settle_login(&world.preset))(true)).await, Ok(true));
    assert_eq!(seen()[1..], [(id.clone(), AccountEvent::Askable), (id.clone(), AccountEvent::SignedIn)], "a sign-in settled");

    assert_eq!(within("the sign-out", world.agents.sign_out(&world.preset)).await, Ok(()));
    let after_sign_out = seen();
    assert!(after_sign_out.len() > 3 && after_sign_out[3..].iter().all(|told| told == &(id.clone(), AccountEvent::Left)), "a sign-out: {after_sign_out:?}");

    let before_off = after_sign_out.len();
    world.enabled.store(false, Ordering::SeqCst);
    world.agents.status();
    assert_eq!(seen()[before_off..], [(id, AccountEvent::Left)], "the feature turned off");
}

/// A turn that finds the CLI signed out, which the user did outside the app, is the account leaving: the bound callback
/// is told it as a sign-out is, and the agent has no quota to report from then on.
#[tokio::test]
async fn a_turn_whose_open_finds_the_cli_signed_out_tells_the_bound_callback_the_account_left() {
    let world = World::new(&[]);
    assert_eq!(world.checked().await["state"], "ready");
    let told: Arc<Mutex<Vec<AccountEvent>>> = Arc::default();
    world.agents.bind_account_change({
        let told = told.clone();
        Arc::new(move |_: &str, event: AccountEvent| told.lock().unwrap().push(event))
    });
    assert!(world.agents.reports_usage(&world.preset));

    #[allow(clippy::disallowed_methods, reason = "a test signs the fake agent out as the user would outside the app")]
    std::fs::write(world.dir.path().join("signed-out"), "signed out").expect("the fake's sign-out");
    let end = world.ask(&Surface::default(), "hello", Turns::default()).await;
    assert!(matches!(end, TurnEnd::Failed { code: Some(-32000), .. }), "{end:?}");

    assert_eq!(world.agents.status()["agents"][0]["state"], "signedOut");
    let told = told.lock().unwrap().clone();
    assert!(!told.is_empty() && told.iter().all(|event| *event == AccountEvent::Left), "{told:?}");
    assert!(!world.agents.reports_usage(&world.preset));
}

/// A check that finds the CLI ready tells the core its quota can be asked now; one that finds it signed out tells
/// it the account is gone. A check that ends with nothing says nothing.
#[tokio::test]
async fn a_check_that_finds_the_cli_ready_or_signed_out_is_told_to_the_bound_callback() {
    let world = World::new(&[]);
    let told: Arc<Mutex<Vec<AccountEvent>>> = Arc::default();
    world.agents.bind_account_change({
        let told = told.clone();
        Arc::new(move |_: &str, event: AccountEvent| told.lock().unwrap().push(event))
    });
    assert_eq!(world.checked().await["state"], "ready");
    assert_eq!(*told.lock().unwrap(), [AccountEvent::Askable]);

    let signed_out = World::new(&[("FAKE_AGENT_SIGNED_OUT", "1")]);
    let told: Arc<Mutex<Vec<AccountEvent>>> = Arc::default();
    signed_out.agents.bind_account_change({
        let told = told.clone();
        Arc::new(move |_: &str, event: AccountEvent| told.lock().unwrap().push(event))
    });
    assert_eq!(signed_out.checked().await["state"], "signedOut");
    assert_eq!(*told.lock().unwrap(), [AccountEvent::Left]);
}

async fn login_state(login: &dyn LoginSession, reached: impl Fn(&LoginState) -> bool) -> LoginState {
    within("the sign-in's state", async {
        loop {
            let state = login.state();
            if reached(&state) || login.next().await.is_none() {
                return login.state();
            }
        }
    })
    .await
}

#[tokio::test]
async fn a_sign_in_shows_the_clis_page_takes_its_code_and_leaves_the_agent_ready() {
    let world = World::new(&[("FAKE_AGENT_SIGNED_OUT", "1")]);
    assert_eq!(world.checked().await["state"], "signedOut");

    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    let shown = login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    let page = "https://accounts.example/o/oauth2/auth?state=fake".to_owned();
    assert_eq!(shown, LoginState::Authorize { url: page.clone(), manual_url: Some(page) });
    login.provide(LoginInput::AuthorizationCode("good-code".into())).await.expect("the code is taken");
    assert_eq!(login_state(login.as_ref(), LoginState::is_terminal).await, LoginState::Done { account: None });

    // The state moves with no toggle: the next look finds the CLI signed in.
    let found = within("the look", world.agents.look(&world.preset)).await;
    assert!(matches!(found, Some(Readiness::Ready { .. })), "{found:?}");
    assert_eq!(world.agents.status()["agents"][0]["state"], "ready");
}

#[tokio::test]
async fn a_refused_and_a_cancelled_sign_in_are_told_apart_and_leave_no_process() {
    let world = World::new(&[("FAKE_AGENT_SIGNED_OUT", "1")]);
    let refused = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    login_state(refused.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    refused.provide(LoginInput::AuthorizationCode("wrong".into())).await.expect("the code is taken");
    let ended = login_state(refused.as_ref(), LoginState::is_terminal).await;
    assert_eq!(ended, LoginState::Failed(LoginFailure::Failed { code: "agentLogin".into(), message: "The code was not accepted.".into() }));

    let cancelled = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    login_state(cancelled.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    cancelled.cancel();
    assert_eq!(login_state(cancelled.as_ref(), LoginState::is_terminal).await, LoginState::Cancelled);
    world.all_exited().await;
    assert_eq!(world.checked().await["state"], "signedOut");
}

#[tokio::test]
async fn a_check_of_a_cli_that_never_answers_ends_with_the_feature_and_leaves_no_process() {
    let world = World::new(&[("FAKE_AGENT_SILENT_NEW", "1")]);
    // Asking for a check returns at once; the value says it runs.
    world.agents.recheck();
    assert_eq!(world.agents.status()["agents"][0]["state"], "checking");
    within("the check to reach the agent", async {
        while world.logged("session/new") == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    // A turn that finds the check running waits for that one and starts no other.
    let asking = thread();
    let waiting = world.agents.session(&asking, &world.preset, world.cwd(), None, None);
    let off = async {
        world.enabled.store(false, Ordering::SeqCst);
        assert_eq!(world.agents.status()["agents"][0]["state"], "off");
    };
    let (refused, ()) = within("the check's end", async { tokio::join!(waiting, off) }).await;
    assert_eq!(refused.err(), Some(Refusal::Off));
    world.all_exited().await;
    assert_eq!(world.logged("start acp"), 1);
}

/// What the agent says its context holds is the turn's reading, and the window it names is the session's, in every
/// field the session keeps a window in. A turn in which the agent reports nothing keeps the report it made last.
#[tokio::test]
async fn the_agents_report_of_its_context_is_the_turns_reading_and_the_sessions_window() {
    let world = World::new(&[]);
    let surface = Surface::default();
    within("the turn", world.prompt(&thread(), &surface, "stream", None, CancellationToken::new())).await;
    let events = surface.events();
    let windows: Vec<&HeaderChange> = events
        .iter()
        .filter_map(|event| match event {
            Event::Header(change) if change.set.contains_key("contextWindow") => Some(change),
            _ => None,
        })
        .collect();
    assert_eq!(windows.len(), 1, "{events:?}");
    for key in ["contextWindow", "rawContextWindow", "compactBoundaryTokens"] {
        assert_eq!(windows[0].set.get(key), Some(&json!(1000)), "{key}");
    }
    let reported = Some(mixdog_acp::session::ContextUse { used: 100, size: 1000 });
    let usage = |surface: &Surface| {
        surface.events().into_iter().find_map(|event| match event {
            Event::Usage(usage) => Some(usage),
            _ => None,
        })
    };
    assert_eq!(usage(&surface).expect("the turn's usage").context, reported);

    let next = Surface::default();
    within("the next turn", world.prompt(&thread(), &next, "whoami", None, CancellationToken::new())).await;
    assert_eq!(usage(&next).expect("the next turn's usage").context, reported);
    assert!(!next.events().iter().any(|event| matches!(event, Event::Header(_))), "{:?}", next.events());
}

/// A context that reached the session's trigger is compacted where a provider's is, before the prompt is sent: the
/// conversation is summarized, the agent's session is left behind and the turn opens a new one on the summary. Below
/// the trigger the agent's session goes on, and so it does when the summary cannot be made. The pass shows as a
/// provider's: the spinner's `compacting` while it runs, then `requesting`; the divider of the stored summary and no
/// notice of the agent's own; the loop's marker of the pass, done or failed.
#[tokio::test]
async fn a_context_at_the_sessions_trigger_is_compacted_before_the_prompt_and_the_agent_starts_anew_on_the_summary() {
    let due = Some(mixdog_acp::runs::Due { used: 900, trigger: 800 });
    /// A turn of a conversation that holds the agent's session `sess-9`.
    async fn serve(world: &World, surface: &Surface, turns: Turns) -> TurnEnd {
        let input = json!({ "role": "user", "content": "whoami" });
        within("the turn", world.serve_with(surface, input, Some(held("sess-9")), Some("RULES"), "default", CancellationToken::new(), turns)).await
    }
    /// The stages the spinner was told of and the compaction markers, in order.
    fn shown(surface: &Surface) -> Vec<String> {
        surface
            .events()
            .into_iter()
            .filter_map(|event| match event {
                Event::Stage(stage) => Some(stage),
                Event::Compact(status) => Some(format!("{status:?}")),
                _ => None,
            })
            .collect()
    }

    let world = World::new(&[]);
    let surface = Surface::default();
    let end = serve(&world, &surface, Turns { summary: Some(Ok("## User\nearlier talk")), due, ..Turns::default() }).await;
    let said = completed_text(&end);
    assert!(said.starts_with("session=sess-1 resumed=false"), "{said}");
    let lead = said.split_once(" lead=").expect("the lead").1;
    assert!(lead.starts_with("# The conversation before this session") && lead.contains("## User\nearlier talk"), "{said}");
    assert!(surface.notices().is_empty(), "{:?}", surface.notices());
    assert_eq!(shown(&surface), ["compacting", "requesting", "Compacted"]);
    assert_eq!(world.logged("session/resume"), 0, "the session that held the context is not reopened");
    let recorded = surface.events().into_iter().find_map(|event| match event {
        Event::Header(change) => change.set.get(mixdog_acp::runs::SESSION_KEY).cloned(),
        _ => None,
    });
    assert_eq!(recorded.expect("the new session's record")["sessionId"], "sess-1");

    let world = World::new(&[]);
    let surface = Surface::default();
    let end = serve(&world, &surface, Turns { summary: Some(Ok("## User\nearlier talk")), ..Turns::default() }).await;
    assert!(completed_text(&end).starts_with("session=sess-9 resumed=true") && completed_text(&end).contains(" lead= images="), "{end:?}");
    assert!(surface.notices().is_empty());
    assert!(shown(&surface).is_empty(), "no pass below the trigger");

    let world = World::new(&[]);
    let surface = Surface::default();
    let end = serve(&world, &surface, Turns { summary: Some(Err("the summary route answered nothing")), due, ..Turns::default() }).await;
    assert!(completed_text(&end).starts_with("session=sess-9 resumed=true") && completed_text(&end).contains(" lead= images="), "{end:?}");
    assert!(surface.notices().is_empty(), "{:?}", surface.notices());
    assert_eq!(shown(&surface), ["compacting", "requesting", "Failed"]);

    // The summary a new session of the agent's is handed is made by the same compaction, and shows as one while it is made.
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = world.ask(&surface, "whoami", Turns { summary: Some(Ok("## User\nearlier talk")), ..Turns::default() }).await;
    assert!(completed_text(&end).contains("## User\nearlier talk"), "{end:?}");
    assert_eq!(shown(&surface), ["compacting", "requesting"]);
}

/// A turn stopped after its compaction, before the prompt that carries the summary reached the agent, leaves the
/// conversation naming no session of the agent's: the new session never had the summary, so the next turn does not
/// resume it but hands the summary over again.
#[tokio::test]
async fn a_session_the_summary_never_reached_is_not_recorded_with_the_conversation() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let stop = CancellationToken::new();
    let input = json!({ "role": "user", "content": [
        { "type": "text", "attachmentRef": "stop", "filename": "stop.txt" },
        { "type": "text", "text": "whoami" },
    ] });
    let due = Some(mixdog_acp::runs::Due { used: 900, trigger: 800 });
    let turns = Turns { summary: Some(Ok("## User\nearlier talk")), due, stops_sending: Some(stop.clone()), ..Turns::default() };
    let end = within("the turn", world.serve_with(&surface, input, Some(held("sess-9")), Some("RULES"), "default", stop, turns)).await;
    assert_eq!(end, TurnEnd::Interrupted);
    assert_eq!(world.logged("session/prompt"), 0, "the prompt was never sent");
    let recorded = surface.events().into_iter().any(|event| matches!(event, Event::Header(change) if change.set.contains_key(mixdog_acp::runs::SESSION_KEY)));
    assert!(!recorded, "{:?}", surface.events());

    // The compaction stopped naming the agent's earlier session, and no other was named since.
    let surface = Surface::default();
    let end = world.ask(&surface, "whoami", Turns { summary: Some(Ok("## User\nearlier talk")), ..Turns::default() }).await;
    let said = completed_text(&end);
    assert!(said.contains(" resumed=false") && said.contains("## User\nearlier talk"), "{said}");
}

/// A turn stopped while its compaction is made ends the agent's process with it: the session the compaction was
/// leaving behind is not kept idle until the next turn.
#[tokio::test]
async fn a_turn_stopped_during_its_compaction_ends_the_agents_process() {
    let world = World::new(&[]);
    let input = || json!({ "role": "user", "content": "whoami" });
    let end = within(
        "the turn",
        world.serve_with(&Surface::default(), input(), Some(held("sess-9")), Some("RULES"), "default", CancellationToken::new(), Turns::default()),
    )
    .await;
    assert!(completed_text(&end).starts_with("session=sess-9 resumed=true"), "{end:?}");
    assert!(world.agents.running(&thread()).is_some());

    let stop = CancellationToken::new();
    let turns = Turns { due: Some(mixdog_acp::runs::Due { used: 900, trigger: 800 }), stops_summary: Some(stop.clone()), ..Turns::default() };
    let end = within("the turn", world.serve_with(&Surface::default(), input(), Some(held("sess-9")), Some("RULES"), "default", stop, turns)).await;
    assert_eq!(end, TurnEnd::Interrupted);
    assert!(world.agents.running(&thread()).is_none(), "the agent's process ended with the stop");
    world.all_exited().await;
}

/// An attached file reaches the agent: a text file as its text (an embedded resource where the agent takes one, else a
/// text block under its name), any other file as a link to where the session keeps it, which the agent reads with a
/// tool of its own. A file that can be neither read nor linked is said to the user.
#[tokio::test]
async fn an_attached_file_reaches_the_agent_as_its_text_or_a_link_to_where_it_is_stored() {
    let input = || {
        json!({ "role": "user", "content": [
            { "type": "text", "attachmentRef": "note", "filename": "note.md" },
            { "type": "file", "mimeType": "application/pdf", "attachmentRef": "paper", "filename": "paper.pdf" },
            { "type": "file", "mimeType": "application/pdf", "attachmentRef": "gone", "filename": "lost.pdf" },
            { "type": "file", "mimeType": "text/plain", "attachmentRef": "gone", "filename": "old notes.txt" },
            { "type": "text", "text": "files" },
        ] })
    };
    // Each file left out is named.
    let told = ["Not sent to Antigravity ACP (not readable where the session keeps its attachments): \"lost.pdf\", \"old notes.txt\"."];
    let link = json!({ "type": "resource_link", "uri": "file:///C:/data%20dir/blobs/paper", "name": "paper.pdf", "mimeType": "application/pdf" });
    let sent = |end: &TurnEnd| {
        let (files, lead) = completed_text(end).strip_prefix("files=").expect("the files").rsplit_once(" lead=").expect("the lead");
        (serde_json::from_str::<Value>(files).expect("the blocks"), lead.to_owned())
    };

    let world = World::new(&[("FAKE_AGENT_EMBEDDED", "1")]);
    let surface = Surface::default();
    let end = within("the turn", world.serve(&surface, input(), None, "default", CancellationToken::new())).await;
    let note = json!({ "type": "resource", "resource": { "uri": "file:///C:/data%20dir/blobs/note", "mimeType": "text/plain", "text": "# Notes\nplover" } });
    assert_eq!(sent(&end), (json!([note, link]), String::new()));
    assert_eq!(surface.notices(), told);

    let world = World::new(&[]);
    let surface = Surface::default();
    let end = within("the turn", world.serve(&surface, input(), None, "default", CancellationToken::new())).await;
    assert_eq!(sent(&end), (json!([link]), "[Attached file: note.md]\n# Notes\nplover".to_owned()));
    assert_eq!(surface.notices(), told);
}

/// The agent's question about work of a kind the session has a tool for is answered by the session's own
/// permissions, as a call of that tool is: a read the session's gate allows is allowed with no card, a command it
/// asks about is asked about on the call's card, and its refusal is the agent's answer. Nothing of the session
/// runs: the agent does the work with its own tool.
#[tokio::test]
async fn the_sessions_permissions_answer_the_agents_own_read_and_command_as_they_answer_its_tools() {
    let (world, tools) = handing(&[]);
    let ask = |surface: &Surface, text: &'static str| {
        let (world, calls, surface) = (&world, tools.calls(surface), surface.clone());
        async move { within("the turn", world.prompt_with(&thread(), &surface, text, None, CancellationToken::new(), Some(calls))).await }
    };

    let surface = Surface::default();
    let end = ask(&surface, "askread notes/a.txt").await;
    assert_eq!(completed_text(&end), "option:once");
    assert!(surface.0.asks.lock().unwrap().is_empty(), "the session's gate allows a read without asking");
    assert_eq!(*tools.seen.lock().unwrap(), ["judge read"]);

    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true })));
    let end = ask(&surface, "permission").await;
    assert_eq!(completed_text(&end), "option:once");
    let asks = surface.0.asks.lock().unwrap().clone();
    let args = json!({ "command": "rm -rf build", "title": "Delete build" });
    assert_eq!(asks.iter().map(|ask| (ask.tool.as_deref(), &ask.payload["args"])).collect::<Vec<_>>(), [(Some("antigravity_execute"), &args)]);
    assert_eq!(*tools.seen.lock().unwrap(), ["judge read", "judge shell"], "judged, and nothing of the session ran or was reported");
    assert!(tools.ran.lock().unwrap().is_empty());

    let surface = Surface::default();
    let end = ask(&surface, "askrun forbidden tool").await;
    assert_eq!(completed_text(&end), "option:no");
    assert!(surface.0.asks.lock().unwrap().is_empty(), "a refusal asks nobody");
    let notices = surface.notices();
    assert!(notices.len() == 1 && notices[0].starts_with("Antigravity ACP's call \"Run it\" was not allowed in this session: "), "{notices:?}");
}

/// A call of the agent's that touches several files is judged on every one: one the session refuses refuses the call,
/// whichever file it names first.
#[tokio::test]
async fn a_call_of_the_agents_own_is_judged_on_every_file_it_touches() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    let end = within(
        "the turn",
        world.prompt_with(&thread(), &surface, "askread notes/a.txt secret/b.txt", None, CancellationToken::new(), Some(tools.calls(&surface))),
    )
    .await;
    assert_eq!(completed_text(&end), "option:no");
    assert_eq!(*tools.seen.lock().unwrap(), ["judge read", "judge read"]);
    assert!(surface.0.asks.lock().unwrap().is_empty());
    assert_eq!(surface.notices().len(), 1, "{:?}", surface.notices());
}

/// A command of the agent's that names no command line gives the session's permissions nothing to judge: it is asked
/// on its card, never allowed on its title.
#[tokio::test]
async fn a_command_of_the_agents_own_with_no_command_line_is_asked_on_its_card() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": false })));
    let end = within("the turn", world.prompt_with(&thread(), &surface, "askrun", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:no");
    assert!(tools.seen.lock().unwrap().is_empty(), "nothing was judged");
    let asks = surface.0.asks.lock().unwrap().clone();
    assert_eq!(asks.iter().map(|ask| ask.tool.as_deref()).collect::<Vec<_>>(), [Some("antigravity_execute")]);
}

/// The user's approval of the agent's tool for the rest of the session, from its card.
async fn remembered(world: &World, tools: &Tools) {
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true, "remember": "session" })));
    let end = within("the turn", world.prompt_with(&thread(), &surface, "askrun ls", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:once");
    assert_eq!(surface.0.asks.lock().unwrap().len(), 1, "the session's gate asked, on the call's card");
}

/// A tool of the agent's the user approved for the rest of the session answers only what the session's permissions
/// would ask about: they judge first, and what they refuse stays refused.
#[tokio::test]
async fn a_remembered_approval_answers_only_what_the_sessions_permissions_would_ask() {
    let (world, tools) = handing(&[]);
    remembered(&world, &tools).await;

    let surface = Surface::default();
    let end = within("the turn", world.prompt_with(&thread(), &surface, "askrun ls -la", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:once");
    assert!(surface.0.asks.lock().unwrap().is_empty(), "what the gate would ask is answered by the approval");

    let surface = Surface::default();
    let end =
        within("the turn", world.prompt_with(&thread(), &surface, "askrun forbidden tool", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:no", "what the gate refuses is refused, approval or not");
    assert!(surface.0.asks.lock().unwrap().is_empty());
    assert_eq!(*tools.seen.lock().unwrap(), ["judge shell", "judge shell", "judge shell"]);
}

/// A call of the agent's that the session would run only changed cannot be: it is asked on its card, whatever the user
/// approved of the agent's tool before.
#[tokio::test]
async fn a_call_the_session_would_run_only_changed_is_asked_on_its_card() {
    let (world, tools) = handing(&[]);
    remembered(&world, &tools).await;

    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": false })));
    let end =
        within("the turn", world.prompt_with(&thread(), &surface, "askrun moved here", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:no");
    let asks = surface.0.asks.lock().unwrap().clone();
    assert_eq!(
        asks.iter().map(|ask| (ask.tool.as_deref(), &ask.payload["args"]["command"])).collect::<Vec<_>>(),
        [(Some("antigravity_execute"), &json!("moved here"))]
    );
}

/// The job that owns a sub-agent's turn hears each tool result the turn gains, with its card diff, as it hears the
/// results of a turn the loop runs.
#[tokio::test]
async fn the_turns_owner_is_told_each_tool_result_with_its_diff() {
    let world = World::new(&[]);
    let told: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let hook: mixdog_acp::turn::ToolResultHook = {
        let told = told.clone();
        Arc::new(move |diff: Option<String>| told.lock().unwrap().push(diff))
    };
    let session = world.agents.session(&thread(), &world.preset, world.cwd(), None, Some("RULES".into())).await.expect("the agent starts");
    let context = TurnContext { on_tool_result: Some(hook), ..world.context(CancellationToken::new()) };
    let blocks = vec![json!({ "type": "text", "text": "stream" })];
    within("the turn", mixdog_acp::turn::run(&session, Arc::new(Surface::default()), Ask::Prompt(blocks), context)).await;
    // The command's result, the edit's and the plan's.
    let told = told.lock().unwrap().clone();
    assert_eq!(told.len(), 3, "{told:?}");
    assert_eq!((&told[0], &told[2]), (&None, &None));
    assert!(told[1].as_deref().is_some_and(|diff| diff.contains("a.txt") && diff.contains("+two")), "{told:?}");
}

/// What the session's own model writes outside a turn (a summary) an agent writes in a process and a session of
/// its own: it holds nothing of any conversation, takes the instructions where the agent takes a system prompt (else
/// ahead of the question), and ends with the answer.
#[tokio::test]
async fn a_question_outside_every_conversation_is_answered_in_a_session_of_its_own_that_ends_with_it() {
    let world = World::new(&[]);
    let now: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(|| 0_i64);
    // The check's own session is closed as well: what the question adds is counted.
    world.checked().await;
    let closed = world.logged("session/close");
    let answered =
        within("the answer", mixdog_acp::runs::ask_once(&world.agents, &world.preset, "default", "SUMMARIZE", "whoami", now.clone())).await.expect("an answer");
    assert_eq!(world.logged("session/close"), closed + 1, "the question's session is closed in the agent, so it is in no list of the agent's");
    assert!(answered.text.starts_with("session=sess-1 resumed=false loaded=false append=SUMMARIZE model=m1"), "{answered:?}");
    assert!(answered.text.ends_with(" lead= images=0"), "{answered:?}");
    assert_eq!(answered.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(answered.usage.as_ref().map(|usage| (usage.input_tokens, usage.output_tokens)), Some((10, 5)));
    world.all_exited().await;
    assert!(world.agents.running(&thread()).is_none(), "the question's process is no session's");

    let plain = World::new(&[("FAKE_AGENT_NO_APPEND", "1")]);
    let answered =
        within("the answer", mixdog_acp::runs::ask_once(&plain.agents, &plain.preset, "default", "SUMMARIZE", "whoami", now.clone())).await.expect("an answer");
    assert!(answered.text.contains(" append= ") && answered.text.ends_with(" lead=SUMMARIZE images=0"), "{answered:?}");

    world.enabled.store(false, Ordering::SeqCst);
    assert!(within("the refusal", mixdog_acp::runs::ask_once(&world.agents, &world.preset, "default", "SUMMARIZE", "whoami", now)).await.is_err());
}

/// A question outside every conversation has nobody to approve what the agent asks to do: the agent is refused the
/// call and goes on to answer, as a session with nobody to approve refuses it.
#[tokio::test]
async fn a_permission_the_agent_asks_for_during_a_question_is_refused_and_the_question_answered() {
    let world = World::new(&[]);
    let now: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(|| 0_i64);
    let answered = within("the answer", mixdog_acp::runs::ask_once(&world.agents, &world.preset, "default", "SUMMARIZE", "permission delete_file", now)).await;
    assert_eq!(answered.map(|answered| answered.text), Ok("option:no".to_owned()));
}

/// What a question outside every conversation learns of the account is the agent's state, as a turn's is: a refusal
/// of the account and a sign-in that no longer holds show on the agent's row.
#[tokio::test]
async fn a_questions_word_on_the_account_is_the_agents_state() {
    for (word, state) in [("suspended", "failed"), ("notice UNAUTHENTICATED (code 401)", "signedOut")] {
        let world = World::new(&[]);
        assert_eq!(world.checked().await["state"], "ready");
        let now: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(|| 0_i64);
        let answered = within("the answer", mixdog_acp::runs::ask_once(&world.agents, &world.preset, "default", "SUMMARIZE", word, now)).await;
        assert!(answered.is_err(), "{word}: {answered:?}");
        assert_eq!(world.agents.status()["agents"][0]["state"], state, "{word}");
    }
}
