//! The runner against a fake agent: a real process that speaks the protocol over its stdio,
//! started through the process manager. No test needs an agent's own CLI or the network.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
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
use mixdog_acp::mcp::SessionTools;
use mixdog_acp::preset::AgentPreset;
use mixdog_acp::preset::Command;
use mixdog_acp::preset::Distribution;
use mixdog_acp::preset::Location;
use mixdog_acp::routes::AgentRouteFacts;
use mixdog_acp::routes::AgentRouteWriter;
use mixdog_acp::runs::Attachments;
use mixdog_acp::runs::Conversation;
use mixdog_acp::runs::SESSION_KEY;
use mixdog_acp::runs::Stored;
use mixdog_acp::runs::TurnRequest;
use mixdog_acp::runs::WAKE_TEXT;
use mixdog_acp::surface::CallMark;
use mixdog_acp::surface::CompactEvent;
use mixdog_acp::surface::SteerDelivery;
use mixdog_acp::surface::TurnSurface;
use mixdog_acp::surface::TurnUsage;
use mixdog_acp::turn::Ask;
use mixdog_acp::turn::TurnContext;
use mixdog_acp::turn::TurnEnd;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::NewJob;
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
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::tool::FollowUpMessage;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_api::ids::QueuedId;
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
use mixdog_tools::exec::AgentTasks;
use mixdog_tools::exec::ExecConfig;
use mixdog_tools::exec::ExecRuntime;
use mixdog_tools::exec::ExtSyntax;
use mixdog_tools::exec::FixedShell;
use mixdog_tools::exec::IoLanes;
use mixdog_tools::exec::OsPromptElevation;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::exec::TaskTool;
use mixdog_tools::exec::WakeHub;
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
    /// The agent's report of its context, made while the turn ran.
    Context(TurnUsage),
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
struct Kept(Mutex<HashMap<String, String>>, Mutex<mixdog_acp::agents::Windows>);

#[async_trait]
impl Refusals for Kept {
    async fn read(&self) -> HashMap<String, String> {
        self.0.lock().unwrap().clone()
    }

    async fn keep(&self, refusals: HashMap<String, String>) {
        *self.0.lock().unwrap() = refusals;
    }

    async fn read_windows(&self) -> mixdog_acp::agents::Windows {
        self.1.lock().unwrap().clone()
    }

    async fn keep_windows(&self, windows: mixdog_acp::agents::Windows) {
        *self.1.lock().unwrap() = windows;
    }
}

/// What the turns of a world are served with besides the agent.
#[derive(Clone, Default)]
struct Turns {
    /// The summary the session's compaction makes of the conversation before the turn: none for a session that holds
    /// none, the reason for one that cannot be made.
    summary: Option<Result<&'static str, &'static str>>,
    /// Optional override summary returned by `compact_mid_turn`; falls back to `summary` when `None`.
    mid_turn_summary: Option<Result<&'static str, &'static str>>,
    /// The session's tools, each call run by the loop's own execution of one.
    calls: Option<Arc<HandedCalls>>,
    /// The agent's context reached the session's compaction trigger.
    due: Option<mixdog_acp::runs::Due>,
    /// Enables Mixdog automatic compaction policy (returning `effective_window` as the policy trigger unless `auto_trigger` overrides it).
    auto_compact: bool,
    /// Explicit policy auto-compaction trigger override.
    auto_trigger: Option<u64>,
    /// Persisted context tokens from the previous turn's header.
    last_context_tokens: Option<u64>,
    /// Persisted context window from the previous turn's header.
    context_window: Option<u64>,
    /// The window the user selected for the session, below the agent's own.
    selected_window: Option<u64>,
    /// The turn is stopped with this token while the summary is being made, which then never comes.
    stops_summary: Option<CancellationToken>,
    /// The turn is stopped with this token while `compact_mid_turn` is running, which then never comes.
    stops_mid_turn_summary: Option<CancellationToken>,
    /// The turn is stopped with this token as the attachment `stop` is read for the prompt, before the prompt is sent.
    stops_sending: Option<CancellationToken>,
    /// Hook invoked while resolving an attachment reference (e.g. to simulate a concurrent `stop_submissions`).
    on_attachment_read: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// Gate that holds reading the `"slow"` attachment reference until notified.
    hold_attachment: Option<Arc<Notify>>,
    /// Optional counter incremented each time `Conversation::hand_over` runs.
    hand_over_calls: Option<Arc<AtomicUsize>>,
    /// Optional counter incremented each time `Conversation::compact_mid_turn` runs.
    mid_turn_compacts: Option<Arc<AtomicUsize>>,
    /// Optional progress watch sender passed into `TurnContext::progress`.
    progress: Option<tokio::sync::watch::Sender<mixdog_core_run::run_host::progress::RunProgress>>,
    /// Extra attachment reference -> filesystem path mappings for attachment read tests.
    extra_paths: HashMap<String, String>,
    /// Images persisted via `Attachments::keep_image`, in order.
    kept_images: Arc<Mutex<Vec<mixdog_acp::runs::ShownImage>>>,
}

#[async_trait]
impl Conversation for Turns {
    async fn hand_over(&self) -> Result<Option<String>, String> {
        if let Some(calls) = &self.hand_over_calls {
            calls.fetch_add(1, Ordering::SeqCst);
        }
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

    fn auto_compaction_trigger(&self, effective_window: u64) -> Option<u64> {
        if let Some(trigger) = self.auto_trigger {
            return Some(trigger);
        }
        self.auto_compact.then_some(effective_window)
    }

    async fn compact_mid_turn(&self, _effective_window: Option<u64>) -> Result<Option<String>, String> {
        if let Some(calls) = &self.mid_turn_compacts {
            calls.fetch_add(1, Ordering::SeqCst);
        }
        if let Some(stop) = &self.stops_mid_turn_summary {
            stop.cancel();
            std::future::pending::<()>().await;
        }
        self.mid_turn_summary.or(self.summary).map(|summary| summary.map(str::to_owned).map_err(str::to_owned)).transpose()
    }
}

/// The folder the stored attachments of a test's session are kept in.
const ATTACHMENTS: &str = "C:\\data dir\\blobs";

#[async_trait]
impl Attachments for Turns {
    async fn bytes(&self, reference: &str) -> Option<Vec<u8>> {
        if let Some(hook) = &self.on_attachment_read {
            hook(reference);
        }
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
            "slow" => {
                if let Some(gate) = &self.hold_attachment {
                    gate.notified().await;
                }
                Some(b"slow attachment body".to_vec())
            }
            _ => None,
        }
    }

    fn path(&self, reference: &str) -> Option<String> {
        if let Some(path) = self.extra_paths.get(reference) {
            return Some(path.clone());
        }
        matches!(reference, "note" | "paper").then(|| format!("{ATTACHMENTS}\\{reference}"))
    }

    async fn keep_image(&self, image: mixdog_acp::runs::ShownImage) -> Option<mixdog_acp::runs::KeptImage> {
        let mut kept = self.kept_images.lock().unwrap();
        let n = kept.len() + 1;
        kept.push(image);
        Some(mixdog_acp::runs::KeptImage { asset_id: format!("asset-{n}"), path: Some(format!("/media/asset-{n}.png")) })
    }
}

#[derive(Default)]
struct Recorded {
    /// The session does not take a row that makes a tool call: its commit fails.
    refuses_calls: AtomicBool,
    /// The session refuses terminal assistant text rows (simulating a disk/store write failure during `Reply::close`).
    refuses_assistant_text: AtomicBool,
    events: Mutex<Vec<Event>>,
    asks: Mutex<Vec<ApprovalAsk>>,
    /// The answers the next approvals get; none left answers as a session with no approval surface.
    answers: Mutex<VecDeque<ApprovalResolution>>,
    /// An approval's card stays open: nobody answers it.
    holds_asks: AtomicBool,
    /// Optional one-shot gate that pauses `approve` until the test sends a resolution.
    approve_gate: Mutex<Option<tokio::sync::oneshot::Receiver<ApprovalResolution>>>,
    /// How many held approval futures were dropped (simulating held_requests.rs CancelGuard).
    dropped_asks: std::sync::atomic::AtomicUsize,
    /// The calls gone on in the background that ended, by id, as the approvals heard of each.
    released: Mutex<Vec<String>>,
    /// The turn's own surface refuses a call's result row and stops the turn with this token; the closing one takes it.
    stops_at_result: Mutex<Option<CancellationToken>>,
    /// Queued mid-turn user messages and task notifications visible to `peek_steers`, removed only on `commit_steers`.
    steers: Mutex<VecDeque<SteerDelivery>>,
    steer_peeks: AtomicUsize,
    steer_commits: AtomicUsize,
    committed_steers: Mutex<Vec<QueuedId>>,
    /// Optional hook invoked inside `commit_steers` right before dequeuing (can cancel pre-mutation).
    on_commit_steers: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// When set, `commit_steers` blocks prior to mutation until its `cancel` token fires (simulating a stalled actor).
    hold_commit_steers: AtomicBool,
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
        if self.0.refuses_assistant_text.load(Ordering::SeqCst)
            && item.role.as_deref() == Some("assistant")
            && item.body["toolCalls"].as_array().is_none_or(Vec::is_empty)
        {
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

    async fn context_update(&self, usage: TurnUsage) -> Result<(), RunError> {
        self.record(Event::Context(usage))
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
        struct DropCount(Arc<Recorded>);
        impl Drop for DropCount {
            fn drop(&mut self) {
                self.0.dropped_asks.fetch_add(1, Ordering::SeqCst);
            }
        }
        self.0.asks.lock().unwrap().push(ask);
        self.0.changed.notify_waiters();
        let gate = self.0.approve_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            return gate.await.unwrap_or(ApprovalResolution::Unavailable { at: 0 });
        }
        if self.0.holds_asks.load(Ordering::SeqCst) {
            let _guard = DropCount(self.0.clone());
            return std::future::pending().await;
        }
        self.0.answers.lock().unwrap().pop_front().unwrap_or(ApprovalResolution::Unavailable { at: 0 })
    }

    fn call_epoch(&self) -> u64 {
        0
    }

    async fn peek_steers(&self) -> Result<Vec<SteerDelivery>, RunError> {
        self.0.steer_peeks.fetch_add(1, Ordering::SeqCst);
        Ok(self.0.steers.lock().unwrap().iter().cloned().collect())
    }

    async fn commit_steers(&self, queued_ids: Vec<QueuedId>, _now_ms: i64, cancel: CancellationToken) -> Result<Vec<SteerDelivery>, RunError> {
        self.0.steer_commits.fetch_add(1, Ordering::SeqCst);
        let hook = self.0.on_commit_steers.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook();
        }
        if self.0.hold_commit_steers.load(Ordering::SeqCst) {
            cancel.cancelled().await;
            return Err(RunError::Cancelled);
        }
        if cancel.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let committed: std::collections::HashSet<QueuedId> = queued_ids.iter().cloned().collect();
        let mut steers = self.0.steers.lock().unwrap();
        let mut claimed = Vec::new();
        steers.retain(|steer| {
            let matching: Vec<QueuedId> = steer.queued_ids.iter().filter(|id| committed.contains(*id)).cloned().collect();
            if matching.is_empty() {
                true
            } else {
                let mut delivered = steer.clone();
                delivered.queued_ids = matching;
                claimed.push(delivered);
                false
            }
        });
        let claimed_ids: Vec<QueuedId> = claimed.iter().flat_map(|steer| steer.queued_ids.iter().cloned()).collect();
        self.0.committed_steers.lock().unwrap().extend(claimed_ids);
        Ok(claimed)
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

    async fn read_bytes(&self, path: AbsPath, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        self.0.lock().unwrap().push(path.as_path().to_path_buf());
        let bytes = std::fs::read(path.as_path()).map_err(|error| error.to_string())?;
        let start = (offset as usize).min(bytes.len());
        let end = start.saturating_add(len as usize).min(bytes.len());
        Ok(bytes[start..end].to_vec())
    }

    async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
        let resolved = std::fs::canonicalize(path.as_path()).map_err(|error| error.to_string())?;
        AbsPath::new(resolved).ok_or_else(|| "not absolute".to_owned())
    }

    // The agent definitions and the servers' temporary folders are made and removed as the core makes and removes them.
    async fn create(&self, path: AbsPath, text: String) -> Result<(), String> {
        service_files().create(path, text).await
    }

    async fn create_bytes(&self, path: AbsPath, bytes: Vec<u8>) -> Result<(), String> {
        service_files().create_bytes(path, bytes).await
    }

    async fn make_folder(&self, path: AbsPath) -> Result<(), String> {
        service_files().make_folder(path).await
    }

    async fn remove_folder(&self, path: AbsPath) -> Result<(), String> {
        service_files().remove_folder(path).await
    }

    async fn folders(&self, path: AbsPath) -> Result<Vec<String>, String> {
        service_files().folders(path).await
    }

    // The builds, homes and kept answers of the registry's agents are written, moved and removed as the core does it.
    async fn replace(&self, path: AbsPath, text: String) -> Result<(), String> {
        service_files().replace(path, text).await
    }

    async fn rename(&self, from: AbsPath, to: AbsPath) -> Result<(), String> {
        service_files().rename(from, to).await
    }

    async fn remove_file(&self, path: AbsPath) -> Result<(), String> {
        service_files().remove_file(path).await
    }
}

fn service_files() -> mixdog_acp::files::ServiceFiles {
    mixdog_acp::files::ServiceFiles { files: Arc::new(mixdog_workspace::localfs::LocalFileService::new()), lane: mixdog_rt::testing::tokens().interactive_io }
}

/// The ACP registry as a test serves it: the index it was given, and a download that unpacks the fake agent as the build.
#[derive(Default)]
struct Registry {
    /// The index it serves; `None` is a registry that cannot be reached.
    index: Mutex<Option<Value>>,
    /// The archives it was asked for, in order.
    downloads: Mutex<Vec<String>>,
    /// A download that never ends.
    hangs: AtomicBool,
    /// An unpack of a download that never ends goes on writing into its folder after the download was ended, as an
    /// extraction on its lane does, until `finish` is notified.
    lingers: AtomicBool,
    /// Notified once `unpack` has recorded the download and armed any lingering writer.
    entered: Notify,
    finish: Arc<Notify>,
    /// Notified once the lingering writer has written its late file and released `Unpacking`.
    late_done: Arc<Notify>,
}

impl Registry {
    /// Offers `version` of Google's official server, which is the fake agent, for this system, its archive at `archive`.
    fn offer(&self, version: &str, archive: &str) {
        let fake = mixdog_testkit::bin_exe!("mixdog-acp-fake-agent");
        let cmd = std::path::Path::new(&fake).file_name().expect("the fake's name").to_string_lossy().into_owned();
        let build = json!({ "archive": archive, "cmd": format!("./{cmd}"), "args": ["--uid="], "sha256": "ab".repeat(32) });
        let mut builds = serde_json::Map::new();
        builds.insert(mixdog_acp::registry::this_target().expect("a system the registry names").to_owned(), build);
        *self.index.lock().unwrap() =
            Some(json!({ "agents": [{ "id": "antigravity-acp", "version": version, "distribution": { "binary": Value::Object(builds) } }] }));
    }

    fn downloads(&self) -> Vec<String> {
        self.downloads.lock().unwrap().clone()
    }
}

#[async_trait]
impl mixdog_acp::registry::RegistryFetcher for Registry {
    async fn index(&self, _url: &str) -> Result<Value, String> {
        self.index.lock().unwrap().clone().ok_or_else(|| "the registry cannot be reached".to_owned())
    }

    #[allow(clippy::disallowed_methods, reason = "a test unpacks the fake agent as a build")]
    async fn unpack(
        &self,
        build: &mixdog_acp::registry::Build,
        _archive: &std::path::Path,
        into: &std::path::Path,
        held: mixdog_acp::registry::Unpacking,
    ) -> Result<(), String> {
        self.downloads.lock().unwrap().push(build.archive.clone());
        if self.hangs.load(Ordering::SeqCst) {
            std::fs::create_dir_all(into).map_err(|error| error.to_string())?;
            if self.lingers.load(Ordering::SeqCst) {
                let (finish, late, late_done) = (self.finish.clone(), into.join("late"), self.late_done.clone());
                drop(tokio::spawn(async move {
                    finish.notified().await;
                    std::fs::create_dir_all(&late).and_then(|()| std::fs::write(late.join("part"), "written late")).expect("the late write");
                    drop(held);
                    late_done.notify_one();
                }));
            }
            self.entered.notify_one();
            std::future::pending::<()>().await;
        }
        self.entered.notify_one();
        std::fs::create_dir_all(into).map_err(|error| error.to_string())?;
        std::fs::copy(mixdog_testkit::bin_exe!("mixdog-acp-fake-agent"), into.join(&build.cmd)).map_err(|error| error.to_string())?;
        for helper in &build.helpers {
            std::fs::write(into.join(helper), "").map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

/// The address of the official server's archive on the host its builds come from.
const ARCHIVE: &str = "https://dl.google.com/agy-extensions/releases/agy-acp-server.zip";

/// The home Mixdog keeps for the preset `id` under the world's folder `dir`.
fn home_of(dir: &std::path::Path, id: &str) -> std::path::PathBuf {
    dir.join("acp-agents").join("homes").join(id)
}

/// The official server's home signed in, as its sign-in leaves it.
#[allow(clippy::disallowed_methods, reason = "a test signs the official server's home in")]
fn sign_in_home(dir: &std::path::Path, id: &str) {
    let folder = home_of(dir, id).join("antigravity-acp");
    std::fs::create_dir_all(&folder).expect("the home");
    std::fs::write(folder.join("settings.json"), r#"{"auth":{"type":"oauth-personal"}}"#).expect("the settings");
    std::fs::write(folder.join("acp_token.json"), "token").expect("the credential");
}

/// The world's `probe-cache.json`.
fn probe_cache(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("acp-agents").join("probe-cache.json")
}

/// What the official server preset `id`, run with `settings`, tells of itself, kept as a server that ran before told it.
#[allow(clippy::disallowed_methods, reason = "a test keeps what the server told of itself")]
fn keep_answers(dir: &std::path::Path, id: &str, settings: &[(&str, &str)]) {
    let setting = |name: &str| settings.iter().find(|(key, _)| *key == name).map(|(_, value)| *value);
    let listed: Value = setting("FAKE_AGENT_MODELS").map_or_else(
        || json!([{ "modelId": "m1", "name": "Model One" }, { "modelId": "m2", "name": "Model Two" }]),
        |models| serde_json::from_str(models).expect("JSON"),
    );
    let available: Vec<Value> = listed.as_array().into_iter().flatten().map(|model| json!({ "id": model["modelId"], "name": model["name"] })).collect();
    let mut kept = serde_json::Map::new();
    kept.insert(
        id.to_owned(),
        json!({
            "version": setting("FAKE_AGENT_VERSION").unwrap_or("1.5.2"),
            "models": { "available": available, "current": "m1", "configOption": null },
            "plan": setting("FAKE_AGENT_PLAN"),
            "signOut": setting("FAKE_AGENT_NO_LOGOUT").is_none(),
        }),
    );
    std::fs::write(probe_cache(dir), Value::Object(kept).to_string()).expect("the kept answers");
}

struct World {
    agents: Arc<Agents>,
    processes: Arc<dyn ProcessManager>,
    /// The agent the world's sessions run on: the first of `presets`.
    preset: AgentPreset,
    presets: Vec<AgentPreset>,
    enabled: Arc<AtomicBool>,
    /// The threads a wake asked a turn for.
    woken: Arc<(Mutex<Vec<ThreadId>>, Notify)>,
    /// The places the agent's file reads opened.
    opened: Arc<Mutex<Vec<std::path::PathBuf>>>,
    /// What the agents keep across a restart of the app.
    refusals: Arc<Kept>,
    /// The ACP registry, which cannot be reached until it is given an index.
    registry: Arc<Registry>,
    /// Notified whenever the agents report a state change.
    changed: Arc<Notify>,
    dir: tempfile::TempDir,
}

/// The agents of an app that starts over `presets` in `dir`: what `refusals` keeps is all they share with the ones before.
#[allow(clippy::too_many_arguments, reason = "test harness helper wiring world collaborators")]
fn agents_of(
    presets: &[AgentPreset],
    processes: &Arc<dyn ProcessManager>,
    opened: &Arc<Mutex<Vec<std::path::PathBuf>>>,
    enabled: &Arc<AtomicBool>,
    refusals: &Arc<Kept>,
    registry: &Arc<Registry>,
    changed: &Arc<Notify>,
    dir: &std::path::Path,
) -> Arc<Agents> {
    let home = dir.join("home").to_string_lossy().into_owned();
    Agents::new(AgentsParts {
        refusals: refusals.clone(),
        presets: presets.to_vec(),
        processes: processes.clone(),
        files: Arc::new(Files(opened.clone())),
        cpu: mixdog_rt::testing::tokens().cpu_interactive,
        enabled: {
            let enabled = enabled.clone();
            Arc::new(move || enabled.load(Ordering::SeqCst))
        },
        changed: {
            let changed = changed.clone();
            Arc::new(move || changed.notify_waiters())
        },
        probe_cwd: dir.to_path_buf(),
        definitions: dir.join("acp-agents"),
        data_dir: dir.join("acp-agents"),
        env: Arc::new(move |name: &str| (name == "FAKE_HOME").then(|| home.clone())),
        mcp_bridge: Some(Command { program: mixdog_testkit::bin_exe!("mixdog-acp-fake-agent"), args: vec!["mcp-bridge".into()] }),
        registry: Some(registry.clone()),
    })
}

impl World {
    /// The feature on, over the fake agent with `settings`.
    fn new(settings: &[(&str, &str)]) -> Self {
        Self::build(settings, |_, _| {})
    }

    /// As [`World::new`], with the preset changed by `customize` (which is given the world's folder). The world's agent is
    /// the CLI's preset, on whose default model the suite's turns run.
    fn build(settings: &[(&str, &str)], customize: impl FnOnce(&mut AgentPreset, &std::path::Path)) -> Self {
        Self::of(&["antigravity-cli"], settings, |preset, dir| {
            // Which preset runs its agent's default model is pinned by `each_preset_offers_and_runs_only_its_own_models`.
            preset.quirks.runs_default = true;
            customize(preset, dir);
        })
    }

    /// The feature on, over the official server's fake with `settings`, installed where Mixdog keeps its build, signed in,
    /// and with what it told of itself when it last ran kept.
    fn official(settings: &[(&str, &str)]) -> Self {
        Self::of(&["antigravity"], settings, |_, _| {})
    }

    /// The feature on, over the shipped presets `ids` as they are, each on the fake: a CLI's command is the fake, and a
    /// registry agent's installed build (the version `FAKE_AGENT_VERSION` names), its home signed in and its answers kept
    /// as a server that ran before left them. The first, which `customize` changes, is the one the world's sessions run on.
    fn of(ids: &[&str], settings: &[(&str, &str)], customize: impl FnOnce(&mut AgentPreset, &std::path::Path)) -> Self {
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
        let fake = mixdog_testkit::bin_exe!("mixdog-acp-fake-agent");
        let shipped = mixdog_acp::preset::builtin();
        let mut presets: Vec<AgentPreset> = ids
            .iter()
            .map(|id| {
                let mut preset = shipped.iter().find(|preset| preset.id == *id).expect("a shipped preset").clone();
                // A session handed tools starts the fake in a folder of its own, which has no settings file.
                preset.env.extend(lines.iter().filter_map(|line| line.split_once('=')).map(|(name, value)| (name.to_owned(), value.to_owned())));
                if let Distribution::Registry { helpers, .. } = &preset.distribution {
                    let helpers = helpers.clone();
                    preset.env.push(("FAKE_AGENT_OFFICIAL".into(), "1".into()));
                    let version = settings.iter().find(|(name, _)| *name == "FAKE_AGENT_VERSION").map_or("1.5.2", |(_, version)| *version);
                    let installed = json!({ "version": version, "cmd": fake, "args": ["acp", "--from-manifest"], "sha256": "" });
                    let folder = dir.path().join("acp-agents").join("bin").join(&preset.id);
                    let build = folder.join(version);
                    #[allow(clippy::disallowed_methods, reason = "a test installs the fake as Mixdog keeps a registry agent's build")]
                    {
                        std::fs::create_dir_all(&build)
                            .and_then(|()| std::fs::write(folder.join("installed.json"), installed.to_string()))
                            .expect("the install");
                        for helper in &helpers {
                            std::fs::write(build.join(helper), "").expect("the helper");
                        }
                    }
                    sign_in_home(dir.path(), &preset.id);
                    keep_answers(dir.path(), &preset.id, settings);
                } else {
                    preset.command = fake.clone();
                    preset.args = vec!["acp".into()];
                    // No test runs the vendor's installer.
                    preset.distribution = Distribution::Cli { installer: None, installed_at: Vec::new(), update_args: Some(vec!["update".into()]) };
                }
                preset
            })
            .collect();
        customize(&mut presets[0], dir.path());
        let preset = presets[0].clone();
        let processes: Arc<dyn ProcessManager> =
            Arc::new(mixdog_spawn::LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, mixdog_spawn::ProcessConfig::default()));
        let enabled = Arc::new(AtomicBool::new(true));
        let opened: Arc<Mutex<Vec<std::path::PathBuf>>> = Arc::default();
        let woken: Arc<(Mutex<Vec<ThreadId>>, Notify)> = Arc::default();
        #[allow(clippy::disallowed_methods, reason = "a test writes the file its agent reads")]
        std::fs::write(dir.path().join("note.txt"), "hello\nsecond line\n").expect("the note");
        let refusals: Arc<Kept> = Arc::default();
        let registry: Arc<Registry> = Arc::default();
        let changed: Arc<Notify> = Arc::default();
        let agents = agents_of(&presets, &processes, &opened, &enabled, &refusals, &registry, &changed, dir.path());
        agents.bind_wake({
            let woken = woken.clone();
            Arc::new(move |thread: &ThreadId| {
                woken.0.lock().unwrap().push(thread.clone());
                woken.1.notify_waiters();
            })
        });
        Self { agents, processes, preset, presets, enabled, woken, opened, refusals, registry, changed, dir }
    }

    /// The app is started again: new agents, over what the ones before kept.
    fn restart(&mut self) {
        self.agents.release_all();
        self.agents = agents_of(&self.presets, &self.processes, &self.opened, &self.enabled, &self.refusals, &self.registry, &self.changed, self.dir.path());
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
            selected_window: None,
            attachments: None,
            pictures: None,
            transcript: None,
            output_produced: None,
            mid_turn_compaction: None,
            cpu: mixdog_rt::testing::tokens().cpu_interactive,
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
        let homes: Vec<AbsPath> = [self.dir.path().join("home"), home_of(self.dir.path(), &self.preset.id)].into_iter().filter_map(AbsPath::new).collect();
        let pictures = mixdog_acp::turn::Pictures { keep: turns.clone(), files: Arc::new(Files(self.opened.clone())), homes };
        let request = TurnRequest {
            thread: thread(),
            cwd: self.cwd(),
            stored,
            rules: rules.map(str::to_owned),
            input,
            conversation: turns.clone(),
            attachments: turns.clone(),
            last_context_tokens: turns.last_context_tokens,
            context_window: turns.context_window,
        };
        let context = TurnContext {
            model: model.to_owned(),
            progress: turns.progress.clone(),
            calls: turns.calls.clone(),
            selected_window: turns.selected_window,
            pictures: Some(pictures),
            ..self.context(cancel)
        };
        mixdog_acp::runs::serve(&self.agents, &self.preset, request, Arc::new(surface.clone()), context).await
    }

    /// The user's message `whoami` served on `preset` with the route's `model`, in a conversation that holds no agent session.
    async fn serve_on(&self, preset: &AgentPreset, model: &str) -> TurnEnd {
        let turns = Arc::new(Turns::default());
        let request = TurnRequest {
            thread: thread(),
            cwd: self.cwd(),
            stored: None,
            rules: Some("RULES".into()),
            input: json!({ "role": "user", "content": "whoami" }),
            conversation: turns.clone(),
            attachments: turns,
            last_context_tokens: None,
            context_window: None,
        };
        let context = TurnContext { model: model.to_owned(), ..self.context(CancellationToken::new()) };
        mixdog_acp::runs::serve(&self.agents, preset, request, Arc::new(Surface::default()), context).await
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

    /// The folder `name` of the world's folder, made: the folder of a session of its own.
    fn folder(&self, name: &str) -> AbsPath {
        let path = self.dir.path().join(name);
        #[allow(clippy::disallowed_methods, reason = "a test makes a session's folder")]
        std::fs::create_dir_all(&path).expect("the folder");
        AbsPath::new(path).expect("an absolute folder")
    }

    /// One prompt turn of `thread` in `cwd`, its conversation holding the agent's session `stored`, reported to `surface`.
    async fn prompt_in(&self, thread: &ThreadId, cwd: &AbsPath, surface: &Surface, text: &str, stored: Option<&str>, cancel: CancellationToken) -> TurnEnd {
        let session = self.agents.session(thread, &self.preset, cwd.clone(), stored.map(held), Some("RULES".into())).await.expect("the agent starts");
        mixdog_acp::turn::run(&session, Arc::new(surface.clone()), Ask::Prompt(vec![json!({ "type": "text", "text": text })]), self.context(cancel)).await
    }

    /// What the agent answers `text` in `thread`'s session in `cwd`.
    async fn answer_in(&self, thread: &ThreadId, cwd: &AbsPath, text: &str) -> String {
        let end = within("the turn", self.prompt_in(thread, cwd, &Surface::default(), text, None, CancellationToken::new())).await;
        completed_text(&end).to_owned()
    }

    /// The temporary folders the starts of the official server were given, in order: Mixdog's own, not a check's.
    fn server_temps(&self) -> Vec<std::path::PathBuf> {
        let root = self.dir.path().join("acp-agents").join("tmp");
        self.log().iter().filter_map(|line| line.strip_prefix("official temp=")).map(std::path::PathBuf::from).filter(|temp| temp.starts_with(&root)).collect()
    }

    /// How the process `handle` ended; `None` while it runs.
    fn exit_of(&self, handle: &mixdog_protocol::ProcessHandle) -> Option<mixdog_core_api::domain::process::ProcessExit> {
        self.processes.list().into_iter().find(|process| &process.handle == handle).and_then(|process| process.exit)
    }
}

/// The exit of a process that ended as the end of its input ended it.
const CLOSED: mixdog_core_api::domain::process::ProcessExit =
    mixdog_core_api::domain::process::ProcessExit { status: mixdog_core_api::domain::process::ExitStatus::Code(0), killed: None };

#[allow(clippy::disallowed_methods, reason = "a test looks at the folders the agents keep")]
fn exists(path: &std::path::Path) -> bool {
    path.exists()
}

/// The URL and the bearer token of the session's tool server, from the fake's `servers` answer.
fn tool_server(said: &str) -> (String, String) {
    let servers: Value = serde_json::from_str(said.strip_prefix("servers=").unwrap_or_else(|| panic!("not the session's servers: {said}"))).expect("JSON");
    let token = servers[0]["headers"][0]["value"].as_str().expect("the token").to_owned();
    (servers[0]["url"].as_str().expect("the URL").to_owned(), token)
}

/// The agent's session `id` as a conversation holds it after a turn with `"RULES"`.
fn held(id: &str) -> Stored {
    Stored { session_id: id.to_owned(), prompt: Some(mixdog_acp::session::digest("RULES")) }
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
        assert_eq!(asks[0].payload["agent"], json!({ "id": "antigravity-cli", "label": "Antigravity" }));
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
    assert_eq!(listed, [("m1", "Antigravity · Model One"), ("m2", "Antigravity · Model Two")]);
    assert!(rows.iter().all(|row| row["provider"] == "acp-antigravity-cli" && row["runner"] == "acp"));
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
    assert!(surface.notices().is_empty(), "the stored summary's divider is all the transcript shows: {:?}", surface.notices());
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
            message: "The conversation could not be summarized for Antigravity: the summary route answered nothing".into(),
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
    assert_eq!(surface.notices(), ["2 image(s) of this message were not sent to Antigravity: Antigravity takes no images."]);
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

/// An account the agent refused is still the one signed in: it can be signed out, to sign in with another.
#[tokio::test]
async fn an_account_the_agent_refused_can_still_be_signed_out() {
    let world = World::new(&[]);
    assert_eq!(world.checked().await["canSignOut"], true);
    world.ask(&Surface::default(), "suspended", Turns::default()).await;
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["canSignOut"]), (&json!("failed"), &json!(true)), "{agent}");
    assert_eq!(within("the sign-out", world.agents.sign_out(&world.preset)).await, Ok(()));
    assert_eq!(world.checked().await["state"], "signedOut");
}

/// Where the CLI's own login opens its page in the system's browser (a system with a display it keeps), the window that
/// asked for the sign-in is told so, and opens no second tab.
#[tokio::test]
async fn a_cli_login_that_opens_the_browser_itself_tells_the_window_so() {
    let world = World::new(&[]);
    assert_eq!(world.checked().await["loginOpensBrowser"], json!(cfg!(windows) || cfg!(target_os = "macos")));
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
    assert_eq!(refusal.message(&world.preset), "Antigravity is signed out. Sign in to it in Settings.");
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
        ["Antigravity did not take Mixdog's tools: it never connected to the session's tool server, and works with its own tools only."]
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
    assert!(facts.is_known("acp-antigravity-cli", &config));
    let refused = facts.ensure_ready(&config, "acp-antigravity-cli").await.expect_err("a signed-out agent was picked");
    assert!(refused.contains("Antigravity"), "{refused}");

    let world = World::new(&[]);
    world.checked().await;
    let facts = AgentRouteFacts { inner: Arc::new(AnyCatalog), agents: world.agents.clone() };
    assert!(facts.is_known("acp-antigravity-cli", &config));
    assert_eq!(facts.ensure_ready(&config, "acp-antigravity-cli").await, Ok(()));
    assert!(!facts.fast_capable("acp-antigravity-cli", &Value::Null, None, &Value::Null) && facts.fast_capable("openai", &Value::Null, None, &Value::Null));
    // No row of the agent is marked for a session alone: it is saved wherever a provider's model is.
    assert!(world.agents.picker_rows().iter().all(|row| row.get("sessionOnly").is_none()));
}

#[tokio::test]
async fn route_facts_refuses_an_out_of_scope_agent_model_during_readiness() {
    let world = World::build(&[], |preset, _| {
        preset.quirks.model_scope = mixdog_acp::preset::ModelScope::OnlyPrefixes(vec!["gem-".into()]);
        preset.quirks.runs_default = false;
    });
    world.checked().await;
    let facts = AgentRouteFacts { inner: Arc::new(AnyCatalog), agents: world.agents.clone() };
    let config = serde_json::Map::new();
    let refused =
        facts.ensure_route_ready(&config, "acp-antigravity-cli", "claude-opus-5-5").await.expect_err("out-of-scope model must be refused during readiness");
    assert!(refused.contains("claude-opus-5-5"), "{refused}");
    assert!(facts.ensure_route_ready(&config, "acp-antigravity-cli", "").await.is_err());
    assert_eq!(facts.ensure_route_ready(&config, "acp-antigravity-cli", "gem-pro").await, Ok(()));
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
    assert_eq!(within("the refused sign-out", fixed.agents.sign_out(&fixed.preset)).await, Err("Antigravity offers no sign-out.".to_owned()));
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
    assert_eq!(rows.iter().map(|row| row["id"].as_str().unwrap()).collect::<Vec<_>>(), ["gem", "solo"]);
    let gem = row("gem");
    assert_eq!((&gem["display"], &gem["modelName"], &gem["defaultEffort"]), (&json!("Antigravity · Gem"), &json!("Gem"), &json!("low")));
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
            last_context_tokens: None,
            context_window: None,
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
    let ids: Vec<String> = world.agents.picker_rows().iter().filter_map(|row| row["id"].as_str().map(str::to_owned)).collect();
    let (starred, hidden) = (ids[0].clone(), ids[1].clone());
    let saved = json!({ format!("acp-antigravity-cli/{starred}"): { "favorite": true }, format!("acp-antigravity-cli/{hidden}"): { "hidden": true } });
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
    assert_eq!(row(&starred)["agentLabel"], "Antigravity");
    assert_eq!(row(&starred)["display"], format!("Antigravity · {}", row(&starred)["modelName"].as_str().expect("the model's own name")));
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
    assert_eq!((&gem["effectiveEffort"], &gem["modelDisplay"], &gem["fastCapable"]), (&json!("high"), &json!("Antigravity · Gem"), &json!(false)));
    let efforts: Vec<&str> = gem["effortOptions"].as_array().expect("the efforts").iter().filter_map(|item| item["value"].as_str()).collect();
    assert_eq!(efforts, ["low", "high"]);
    assert_eq!(writer.route(&thread()), gem, "the filled route is the session's");

    writer.set_route_state(&thread(), route("solo", None));
    let solo = within("the refresh", writer.refresh_route_effort(&thread(), None, true, None)).await.expect("refreshed").expect("written");
    assert_eq!((&solo["effortOptions"], &solo["effectiveEffort"]), (&json!([]), &Value::Null), "{solo:?}");
    assert_eq!((&solo["modelDisplay"], &solo["fastCapable"]), (&json!("Antigravity · Solo"), &json!(false)));
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
    let header = json!({ "provider": "openai", mixdog_acp::runs::SESSION_KEY: { "agent": "antigravity-cli", "sessionId": "sess-1" } })
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
                    data: mixdog_core_api::domain::tool::ImageData::Bytes(sample_tool_png()),
                    width: None,
                    height: None,
                };
                ToolOutput { parts: vec![ToolPart::Text("a picture".to_owned()), image], ..ToolOutput::default() }
            }
            _ => ToolOutput { parts: text(format!("{name} ran with {arguments}")), ..ToolOutput::default() },
        })
    }
}

fn sample_tool_png() -> Vec<u8> {
    let raster = mixdog_imaging::Raster { width: 200, height: 200, has_alpha: false, data: vec![0x40; 200 * 200 * 3] };
    mixdog_imaging::encode::encode_in_format(&raster, mixdog_imaging::Format::Png).expect("encode sample png")
}

/// The test session's tool that runs until the test lets it end.
const SLOW: &str = "slow";

/// A tool of the test's session: it keeps what it was called with and ends once the test releases one of its calls.
struct Slow {
    spec: ToolSpec,
    ran: Ran,
    release: Arc<tokio::sync::Semaphore>,
}

#[async_trait]
impl Tool for Slow {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, arguments: Value) -> ToolOutcome {
        self.ran.lock().unwrap().push((ctx.thread_id.clone(), SLOW.to_owned(), arguments.clone()));
        if let Some(port) = arguments.get("readyPort").and_then(Value::as_u64).and_then(|port| u16::try_from(port).ok()) {
            let _ = tokio::net::TcpStream::connect(("127.0.0.1", port)).await;
        }
        self.release.acquire().await.expect("the test's release").forget();
        // A call that asks for silence ends with no output.
        let mut parts = if arguments["silent"] == true { Vec::new() } else { vec![ToolPart::Text(format!("{SLOW} ended with {arguments}"))] };
        // A call that asks for a picture ends with one.
        if arguments["picture"] == true {
            parts.push(ToolPart::Image {
                mime: "image/png".to_owned(),
                data: mixdog_core_api::domain::tool::ImageData::Bytes(sample_tool_png()),
                width: None,
                height: None,
            });
        }
        Ok(ToolOutput { parts, ..ToolOutput::default() })
    }
}

/// Where the shell runtime of the test's session publishes its job strips: nowhere.
struct NoStrips;

impl mixdog_spawn::tasks::TaskPublisher for NoStrips {
    fn thread_updated(&self, _: &str, _: &mixdog_spawn::tasks::ShellJobsState) {}
    fn host_updated(&self, _: &mixdog_spawn::tasks::HostShellJobs) {}
    fn schedule_expiry(&self, _: u64) {}
}

/// Where the session's finished background tasks are delivered, as the session directory takes them: each as its owner,
/// its surface, its task, its status and its notification.
#[derive(Default)]
struct Delivered(Mutex<Vec<(ThreadId, String, String, String, String)>>);

#[async_trait]
impl TaskNotifier for Delivered {
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String) {
        self.0.lock().unwrap().push((owner.clone(), surface.to_owned(), task_id.to_owned(), status.to_owned(), notification));
    }
}

/// The session's `task` tool, as the core composes it: over a shell runtime that keeps its logs in `logs`, and over
/// `board`, the background tasks it reads beside the shell jobs.
fn task_tool(logs: &std::path::Path, board: &JobBoard) -> TaskTool {
    let tokens = mixdog_rt::testing::tokens();
    let runtime = ExecRuntime::new(ExecConfig {
        tasks: Arc::new(mixdog_spawn::tasks::TaskRegistry::new(Arc::new(NoStrips), || 0_u64)),
        lanes: IoLanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            spawn: tokens.spawn_io,
            pty: tokens.pty_io,
        },
        spill_dir: logs.to_path_buf(),
        data_dir: None,
        skill_launcher_dir: None,
        notifier: None,
        survivors: None,
        wake: WakeHub::new(),
        policy: Arc::new(mixdog_tools::policy::exec::NodeCommandPolicy),
        elevation: Arc::new(OsPromptElevation),
        oem: None,
        skill_runtime: None,
        shell: Arc::new(FixedShell("/bin/sh".into())),
        script_syntax: Arc::new(ExtSyntax::new()),
        windows: false,
        powershell: false,
        warm_standby: false,
        now_ms: Arc::new(|| 0_u64),
    });
    TaskTool::new(runtime).with_agent_tasks(Arc::new(board.clone()))
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

    async fn released(&self, call_id: &str) {
        self.0.0.released.lock().unwrap().push(call_id.to_owned());
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
    /// The session's tool calls that went on in the background, which its `task` tool reads.
    board: JobBoard,
    /// Where the board delivers the calls that ended.
    delivered: Arc<Delivered>,
    /// Lets a call of [`SLOW`] end.
    release: Arc<tokio::sync::Semaphore>,
    /// Where the `task` tool's shell runtime keeps its logs.
    _logs: tempfile::TempDir,
}

impl Tools {
    fn new(processes: Arc<dyn ProcessManager>) -> Arc<Self> {
        let ran = Ran::default();
        let pool = Arc::new(Pool);
        let delivered = Arc::new(Delivered::default());
        let board = JobBoard::of_tool_calls(Arc::new(Zero), Some(delivered.clone()));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let logs = tempfile::tempdir().expect("temp dir");
        let mut set: Vec<Arc<dyn Tool>> =
            DIRECT_TOOLS.iter().chain(&[DEFERRED_TOOL]).map(|name| Arc::new(Echo { spec: spec(name), ran: ran.clone() }) as Arc<dyn Tool>).collect();
        set.push(Arc::new(Slow { spec: spec(SLOW), ran: ran.clone(), release: release.clone() }));
        set.push(Arc::new(task_tool(logs.path(), &board)));
        set.push(Arc::new(LoadTool::new(pool.clone())));
        set.push(Arc::new(CallTool::new(pool.clone(), pool)));
        Arc::new(Self { ran, seen: Seen::default(), set, processes, board, delivered, release, _logs: logs })
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
            limits: None,
            hidden_agent: false,
            vision: None,
            reactions: None,
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

    fn tasks(&self) -> &JobBoard {
        &self.board
    }
}

/// A world whose sessions hand their tools to the agent.
fn handing(settings: &[(&str, &str)]) -> (World, Arc<Tools>) {
    handing_in(World::new(settings))
}

/// `world`, its sessions handing their tools to the agent.
fn handing_in(world: World) -> (World, Arc<Tools>) {
    let tools = Tools::new(world.processes.clone());
    world.agents.bind_tools(tools.clone());
    (world, tools)
}

#[tokio::test]
async fn the_agent_is_handed_the_sessions_tools_and_its_call_runs_in_the_session_as_that_tools_call() {
    let (world, tools) = handing(&[]);
    let end = within("the listing", world.prompt(&thread(), &Surface::default(), "tools", None, CancellationToken::new())).await;
    // The agent's listing is what the session's side lists, in its order, and no tool besides.
    let sent: Vec<String> = tools.definitions(&thread()).await.expect("the session's tools").into_iter().map(|tool| tool.name).collect();
    assert_eq!(completed_text(&end), format!("tools={}", sent.join(",")));
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
async fn a_file_backed_tool_image_reaches_an_image_capable_agent_and_omits_for_a_text_only_agent() {
    use mixdog_agent::offload::{ImageCompactor, ImageOutcome};

    struct StoredImages(Mutex<std::collections::HashMap<String, Vec<u8>>>);

    #[async_trait]
    impl ImageCompactor for StoredImages {
        async fn import_blob(&self, reference: &str) -> Option<(String, String)> {
            self.0.lock().unwrap().contains_key(reference).then(|| (reference.to_owned(), "image/png".to_owned()))
        }

        async fn compact(&self, data: &str, mime: &str) -> ImageOutcome {
            let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).expect("valid base64");
            let reference = "d".repeat(64);
            self.0.lock().unwrap().insert(reference.clone(), bytes);
            ImageOutcome::Stored { reference, mime: mime.to_owned(), note: None }
        }
    }

    #[async_trait]
    impl Attachments for StoredImages {
        async fn bytes(&self, reference: &str) -> Option<Vec<u8>> {
            self.0.lock().unwrap().get(reference).cloned()
        }
    }

    let store = Arc::new(StoredImages(Mutex::default()));
    let run_picture = |world: World, store: Arc<StoredImages>| async move {
        let tools = Tools::new(world.processes.clone());
        world.agents.bind_tools(tools.clone());
        let surface = Surface::default();
        let tokens = mixdog_rt::testing::tokens();
        let calls = Arc::new(HandedCalls::new(HandedParts {
            tools: ToolSet::new(tools.set.clone()),
            tool_env: ToolEnv {
                thread_id: thread(),
                turn_id: TurnId::from("turn-1"),
                cwd: AbsPath::new(std::env::temp_dir()).expect("an absolute temp dir"),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(Cards(surface.clone())),
                files: Arc::new(MockFileService::default()),
                processes: tools.processes.clone(),
                progress: Arc::new(MockProgress::default()),
                deadline_of: None,
                notify: None,
                review: None,
            },
            gate: Arc::new(Witness(tools.seen.clone())),
            hooks: Some(Arc::new(Witness(tools.seen.clone()))),
            guards: Arc::new(mixdog_agent::env::NoGuards),
            reuse: None,
            clock: Arc::new(Zero),
            observer: Arc::new(mixdog_agent::env::NullObserver),
            mcp: None,
            live_cwd: None,
            artifacts: None,
            images: Some(store.clone()),
            failures: None,
            repeat: Default::default(),
            cancel: CancellationToken::new(),
            slot: None,
            asks: None,
            limits: None,
            hidden_agent: false,
            vision: None,
            reactions: None,
        }));
        let session = world.agents.session(&thread(), &world.preset, world.cwd(), None, Some("RULES".into())).await.expect("the agent starts");
        let context = TurnContext { calls: Some(calls), attachments: Some(store), ..world.context(CancellationToken::new()) };
        let end = within(
            "the turn",
            mixdog_acp::turn::run(&session, Arc::new(surface), Ask::Prompt(vec![json!({ "type": "text", "text": "tool picture {}" })]), context),
        )
        .await;
        completed_text(&end).to_owned()
    };

    // Image-capable agent receives the stored file-backed image as real MCP image content.
    let limit = mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE;
    let image_world = World::build(&[], |preset, _| preset.quirks.mcp_max_output_bytes = Some(limit));
    let seen = run_picture(image_world, store.clone()).await;
    assert_eq!(seen, "result:a picture images=1");

    // Agent advertising promptCapabilities.image = false receives no image block and a clear omission line.
    let no_image_world = World::build(&[("FAKE_AGENT_NO_IMAGES", "1")], |preset, _| preset.quirks.mcp_max_output_bytes = Some(limit));
    let omitted = run_picture(no_image_world, store).await;
    assert_eq!(omitted, format!("result:a picture\n{}", mixdog_acp::mcp::IMAGE_OMITTED_UNSUPPORTED));
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

/// A call of a Mixdog tool still running when the agent's deadline for it nears is answered before the deadline and goes
/// on as a background task of the session: the answer, which is also the call's row, names the task and the `task` tool,
/// and the turn ends while the call runs. The `task` tool lists the task as that tool's call. The same call made again
/// while it runs is answered with that task and not run again. Once the call ends its end is delivered to the session
/// as that tool's call, with its result, and the session's `task` tool gives that result.
#[tokio::test]
async fn a_call_still_running_near_the_agents_deadline_goes_on_as_a_task_whose_end_is_delivered_and_whose_result_the_task_tool_gives() {
    let (world, tools) = handing_in(World::build(&[], |preset, _| preset.quirks.mcp_call_deadline = Some(Duration::from_secs(2))));
    let surface = Surface::default();
    let call = format!(r#"tool {SLOW} {{"step":1}}"#);
    let end = tools.prompt(&world, &surface, &call).await;
    let told = completed_text(&end).strip_prefix("result:").expect("an answer that is no error").to_owned();
    let task = told.lines().find_map(|line| line.strip_prefix("task_id: ")).expect("the task").to_owned();
    assert_eq!(told, mixdog_acp::mcp::kept(SLOW, &task));
    let rows = surface.rows();
    assert_eq!((&rows[0]["toolCalls"][0]["name"], &rows[1]["role"], &rows[1]["content"]), (&json!(SLOW), &json!("tool"), &json!(told)), "{rows:?}");
    assert_eq!(AgentTasks::view(&tools.board, &thread(), &task).expect("the session's task").status, "running");
    let listed = tools.prompt(&world, &Surface::default(), r#"tool task {"action":"list"}"#).await;
    assert!(completed_text(&listed).contains(&format!("\n- {task} tool/{SLOW} running")), "{listed:?}");

    let again = tools.prompt(&world, &Surface::default(), &call).await;
    assert_eq!(completed_text(&again), format!("result:{}", mixdog_acp::mcp::kept_again(SLOW, &task)));

    tools.release.add_permits(1);
    within("the call's end", AgentTasks::settled(&tools.board, &task)).await;
    assert_eq!(tools.ran.lock().unwrap().iter().filter(|(_, name, _)| name == SLOW).count(), 1, "the call ran more than once");
    let delivered = within("the call's delivery", async {
        loop {
            if let Some(delivered) = tools.delivered.0.lock().unwrap().first().cloned() {
                return delivered;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    let (owner, surface, delivered_task, status, notification) = delivered;
    assert_eq!((owner, surface.as_str(), delivered_task.as_str(), status.as_str()), (thread(), "tool", task.as_str(), "completed"));
    assert!(notification.contains(&format!("<summary>Tool call \"{SLOW}\" completed</summary>")), "{notification}");
    assert!(notification.contains("<result>\nslow ended with {\"step\":1}\n</result>"), "{notification}");
    let end = tools.prompt(&world, &Surface::default(), &format!(r#"tool task {{"action":"wait","task_id":"{task}"}}"#)).await;
    let got = completed_text(&end);
    assert!(got.starts_with(&format!("result:background task\ntask_id: {task}\nsurface: tool\ntool: {SLOW}\nstatus: completed\n")), "{got}");
    assert!(got.ends_with(r#"slow ended with {"step":1}"#), "{got}");
}

/// A call gone on as a background task holds nothing the turn's later calls need: the calls the agent makes after it in
/// the same turn run at once, a `task cancel` of that very task included. The cancel stops the call, and its end closes
/// what it still asks the person.
#[tokio::test]
async fn a_call_gone_on_as_a_task_leaves_the_turns_later_calls_free_and_a_cancel_of_it_ends_it() {
    let (world, tools) = handing_in(World::build(&[], |preset, _| preset.quirks.mcp_call_deadline = Some(Duration::from_secs(2))));
    let surface = Surface::default();
    let turn = format!(r#"calls {SLOW} {{}} ;; read {{"path":"a.txt"}} ;; task {{"action":"cancel","task_id":"$TASK"}}"#);
    let end = tools.prompt(&world, &surface, &turn).await;
    let said = completed_text(&end);
    let listed = AgentTasks::list(&tools.board, &thread());
    let [task] = listed.as_slice() else { panic!("one task: {listed:?}") };
    assert_eq!((task.operation.as_str(), task.status.as_str()), (SLOW, "cancelled"));
    assert!(said.contains(&mixdog_acp::mcp::kept(SLOW, &task.task_id)), "{said}");
    assert!(said.contains("\nresult:read ran with {\"path\":\"a.txt\"}\n"), "the next call did not run at once: {said}");
    assert!(said.ends_with(&format!("task_id: {}\ncancelled: tool/{SLOW}", task.task_id)), "the cancel did not run at once: {said}");
    let call = surface.rows()[0]["toolCalls"][0]["id"].as_str().expect("the call's id").to_owned();
    let released = within("the call's end", async {
        loop {
            if let Some(released) = surface.0.released.lock().unwrap().first().cloned() {
                return released;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert_eq!(released, call);
}

/// A call gone on as a background task keeps its result whole: the image it ends with is given by the `task` tool with
/// the text, to the agent and to the session's row of the read alike.
#[tokio::test]
async fn a_call_gone_on_as_a_task_keeps_the_images_of_its_result() {
    let (world, tools) = handing_in(World::build(&[], |preset, _| preset.quirks.mcp_call_deadline = Some(Duration::from_secs(2))));
    let end = tools.prompt(&world, &Surface::default(), &format!(r#"tool {SLOW} {{"picture":true}}"#)).await;
    let task = completed_text(&end).lines().find_map(|line| line.strip_prefix("task_id: ")).expect("the task").to_owned();
    tools.release.add_permits(1);
    within("the call's end", AgentTasks::settled(&tools.board, &task)).await;
    let surface = Surface::default();
    let end = tools.prompt(&world, &surface, &format!(r#"tool task {{"action":"read","task_id":"{task}"}}"#)).await;
    let got = completed_text(&end);
    assert!(got.contains("slow ended with {\"picture\":true}\n[an image of the result: `task` read of this task gives it]"), "{got}");
    assert!(got.ends_with(" images=1"), "{got}");
    let rows = surface.rows();
    let row = rows.iter().find(|row| row["role"] == "tool").expect("the read's row");
    assert!(row["content"].as_array().is_some_and(|parts| parts.iter().any(|part| part["type"] == "image")), "{rows:?}");
}

/// A call gone on as a background task that ends with no output is delivered with an empty result, not the stored form
/// of one.
#[tokio::test]
async fn a_call_gone_on_as_a_task_that_ends_with_no_output_is_delivered_without_its_stored_form() {
    let (world, tools) = handing_in(World::build(&[], |preset, _| preset.quirks.mcp_call_deadline = Some(Duration::from_secs(2))));
    let end = tools.prompt(&world, &Surface::default(), &format!(r#"tool {SLOW} {{"silent":true}}"#)).await;
    let task = completed_text(&end).lines().find_map(|line| line.strip_prefix("task_id: ")).expect("the task").to_owned();
    tools.release.add_permits(1);
    within("the call's end", AgentTasks::settled(&tools.board, &task)).await;
    let notification = within("the call's delivery", async {
        loop {
            if let Some((.., notification)) = tools.delivered.0.lock().unwrap().first().cloned() {
                return notification;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(notification.contains(&format!("<summary>Tool call \"{SLOW}\" completed</summary>")), "{notification}");
    assert!(!notification.contains("\"images\""), "{notification}");
}

/// A `task` wait under an agent's deadline ends before the deadline as it ends at its own ceiling: the agent is answered
/// by the `task` tool itself with the task still running, and the wait does not go on as a task of its own.
#[tokio::test]
async fn a_task_wait_under_the_agents_deadline_answers_the_task_still_running_before_it() {
    let (world, tools) = handing_in(World::build(&[], |preset, _| preset.quirks.mcp_call_deadline = Some(Duration::from_secs(5))));
    let owner = JobOwner { caller_session_id: Some(thread().as_str().to_owned()), ..JobOwner::default() };
    let task = tools.board.register(NewJob { operation: "probe".to_owned(), owner, ..NewJob::default() }).expect("a task");
    // The wait asks for an hour, and `task` waits 300 s by default: the turn ends within the agent's deadline and the start
    // of its process.
    let asked = std::time::Instant::now();
    let end = tools.prompt(&world, &Surface::default(), &format!(r#"tool task {{"action":"wait","task_id":"{task}","timeout_ms":3600000}}"#)).await;
    assert!(asked.elapsed() < Duration::from_secs(30), "the wait outlasted the agent's deadline");
    let got = completed_text(&end);
    assert!(got.starts_with(&format!("result:background task\ntask_id: {task}\nsurface: tool\ntool: probe\nstatus: running\n")), "{got}");
    assert!(
        got.ends_with("\n\nWait ceiling reached; task still running and its result is delivered automatically. If periodic reports were requested, write the user-facing report now; otherwise continue independent work or end the turn."),
        "{got}"
    );
    assert_eq!(AgentTasks::list(&tools.board, &thread()).len(), 1, "the wait went on as a task of its own");
}

/// An agent that waits for every call to end is answered with the call's result when it ends, and no call of its goes
/// on as a task.
#[tokio::test]
async fn an_agent_that_waits_for_every_call_is_answered_with_its_result_when_it_ends() {
    let (world, tools) = handing_in(World::build(&[], |preset, _| preset.quirks.mcp_call_deadline = None));
    let release = async {
        within("the call", async {
            while tools.ran.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        tools.release.add_permits(1);
    };
    let (surface, call) = (Surface::default(), format!("tool {SLOW} {{}}"));
    let (end, ()) = tokio::join!(tools.prompt(&world, &surface, &call), release);
    assert_eq!(completed_text(&end), "result:slow ended with {}");
    assert!(AgentTasks::list(&tools.board, &thread()).is_empty());
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
    assert!(names.contains("read"), "{names}");
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
    World::build(settings, make_uninstalled)
}

/// `preset`, a CLI of the world in `dir`, on no `PATH`: its installer puts it under `FAKE_HOME`.
fn make_uninstalled(preset: &mut AgentPreset, dir: &std::path::Path) {
    let installed = format!("bin/fake-agy{}", std::env::consts::EXE_SUFFIX);
    preset.distribution = Distribution::Cli {
        installer: Some(Command {
            program: mixdog_testkit::bin_exe!("mixdog-acp-fake-agent"),
            args: vec!["install-into".into(), dir.join("home").join(&installed).to_string_lossy().into_owned()],
        }),
        installed_at: vec![Location { env: Some("FAKE_HOME".into()), path: installed }],
        update_args: Some(vec!["update".into()]),
    };
    preset.command = "mixdog-acp-no-such-cli".into();
}

/// A world whose CLI is on no `PATH` and under no variable's folder: it is found only as the file it is, as in a folder
/// a package manager links its programs into.
fn found_only_as_its_file(settings: &[(&str, &str)]) -> World {
    World::build(settings, |preset, _| {
        let fake = std::mem::replace(&mut preset.command, "mixdog-acp-no-such-cli".into());
        preset.distribution = Distribution::Cli { installer: None, installed_at: vec![Location { env: None, path: fake }], update_args: None };
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
    assert_eq!(failed, "Antigravity could not be installed: no route to the download server");
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

/// A preset that cannot be installed leaves the others to their install: the official server's build cannot be had, and
/// the CLI is installed all the same, the failure told for the official server alone.
#[tokio::test]
async fn an_install_that_fails_for_one_preset_still_installs_the_others() {
    let mut world = World::of(&["antigravity", "antigravity-cli"], &[], |_, dir| {
        #[allow(clippy::disallowed_methods, reason = "a test removes the build it installed")]
        std::fs::remove_file(dir.join("acp-agents").join("bin").join("antigravity").join("installed.json")).expect("the install");
    });
    let dir = world.dir.path().to_path_buf();
    make_uninstalled(&mut world.presets[1], &dir);
    world.restart();
    let failed = within("the install", world.agents.install()).await.expect_err("the official server's install fails");
    assert_eq!(failed, "Antigravity could not be installed: the registry cannot be reached");
    let agents = world.agents.status()["agents"].clone();
    assert_eq!((&agents[0]["state"], &agents[1]["state"], &agents[1]["lastError"]), (&json!("notInstalled"), &json!("ready"), &Value::Null), "{agents}");
    assert_eq!(world.logged("install"), 1);
}

#[tokio::test]
async fn a_cli_on_no_path_and_under_no_variables_folder_is_found_as_the_file_it_is() {
    let world = found_only_as_its_file(&[]);
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["version"]), (&json!("ready"), &json!("1.5.1")), "{agent}");
}

/// A sign-in begun before any check runs the CLI where a look finds it, not a command `PATH` does not have.
#[tokio::test]
async fn a_sign_in_begun_before_any_check_runs_the_cli_where_it_is_found() {
    let world = found_only_as_its_file(&[("FAKE_AGENT_SIGNED_OUT", "1")]);
    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts on the CLI found");
    let shown = login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    assert!(matches!(shown, LoginState::Authorize { .. }), "{shown:?}");
    login.cancel();
    assert_eq!(login_state(login.as_ref(), LoginState::is_terminal).await, LoginState::Cancelled);
    world.all_exited().await;
}

/// An update that never ends holds no turn: the turn ends it, and runs on the CLI as it was before it.
#[tokio::test]
async fn a_turn_ends_an_update_that_never_ends_and_runs_on_the_cli_as_it_was() {
    let world = World::new(&[("FAKE_AGENT_UPDATE_HANGS", "1")]);
    world.agents.recheck();
    world.logs("update").await;
    assert_eq!(world.agents.status()["agents"][0]["state"], "updating");
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1"), "{end:?}");
    assert_eq!(world.agents.status()["agents"][0]["state"], "ready");
    // The update ended with its check: once the session's agent is gone, nothing of it runs.
    let session = world.agents.running(&thread()).expect("the session's agent");
    world.agents.release(&thread());
    within("the agent's exit", session.connection.exited().cancelled()).await;
    world.all_exited().await;
    assert_eq!(world.logged("update"), 1);
}

/// A version run that fails is a failed check in the CLI's own words, whatever version it printed beside them.
#[tokio::test]
async fn a_version_run_that_fails_is_a_failed_check_in_the_clis_words() {
    let why = "error while loading shared libraries: libsecret-1.so.0";
    let world = World::new(&[("FAKE_AGENT_VERSION_FAILS", why)]);
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["message"]), (&json!("failed"), &json!(why)), "{agent}");
    assert_eq!(world.logged("start acp"), 0, "a CLI whose version run failed is not started");
}

/// What changes the account an agent's quota was read of (a sign-in settled, a sign-out, the feature turned off) reaches
/// the callback bound for it, with the agent's id; only the settled sign-in asks for the next reading to be taken at
/// once. A sign-in begun changes nothing until it settles: the account and its reading stay.
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
    assert_eq!(seen(), [], "a sign-in begun");
    login.cancel();

    // The look the settle makes finds the CLI ready (askable), then the sign-in is told.
    assert_eq!(within("the sign-in's settle", (world.agents.settle_login(&world.preset))(true)).await, Ok(true));
    assert_eq!(seen(), [(id.clone(), AccountEvent::Askable), (id.clone(), AccountEvent::SignedIn)], "a sign-in settled");

    assert_eq!(within("the sign-out", world.agents.sign_out(&world.preset)).await, Ok(()));
    let after_sign_out = seen();
    assert!(after_sign_out.len() > 2 && after_sign_out[2..].iter().all(|told| told == &(id.clone(), AccountEvent::Left)), "a sign-out: {after_sign_out:?}");

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

    // The reading follows the report while the turn runs: it was told before the prompt's answer closed the turn, and
    // carries no tokens of the turn.
    let kinds: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            Event::Context(usage) => {
                assert_eq!((usage.context, usage.input_tokens, usage.output_tokens), (reported, 0, 0));
                Some("context")
            }
            Event::Usage(_) => Some("usage"),
            _ => None,
        })
        .collect();
    assert_eq!(kinds, ["context", "usage"], "{events:?}");

    let next = Surface::default();
    within("the next turn", world.prompt(&thread(), &next, "whoami", None, CancellationToken::new())).await;
    assert_eq!(usage(&next).and_then(|u| u.context), None);
    assert!(!next.events().iter().any(|event| matches!(event, Event::Header(_))), "{:?}", next.events());
}

/// The agent's size is the raw window. A window the user selected below it stays the session's effective window and
/// compaction boundary through every report the agent makes, and one above it is the agent's whole; once the agent has
/// reported, its routes' rows state the window, so the window control applies to them.
#[tokio::test]
async fn a_selected_window_below_the_agents_is_kept_when_the_agent_reports_its_own() {
    let world = World::new(&[]);
    let windows = |surface: &Surface| -> Vec<HeaderChange> {
        surface
            .events()
            .into_iter()
            .filter_map(|event| match event {
                Event::Header(change) if change.set.contains_key("rawContextWindow") => Some(change),
                _ => None,
            })
            .collect()
    };
    let input = || json!({ "role": "user", "content": "stream" });
    let before = world.agents.status();
    assert_eq!(before["agents"][0]["contextWindows"], json!({}));
    assert!(
        world.agents.window_meta(&world.preset, "default").is_none() && !world.agents.picker_rows().iter().any(|row| row.get("maxContextWindow").is_some())
    );
    for (selected, effective) in [(Some(400), 400), (Some(5_000), 1000), (None, 1000)] {
        let surface = Surface::default();
        let turns = Turns { selected_window: selected, ..Turns::default() };
        let thread_stored = None;
        within("the turn", world.serve_with(&surface, input(), thread_stored, Some("RULES"), "default", CancellationToken::new(), turns)).await;
        let changes = windows(&surface);
        assert_eq!(changes.len(), 1, "{selected:?}: {:?}", surface.events());
        for (key, want) in [
            ("contextWindow", effective),
            ("compactBoundaryTokens", effective),
            ("rawContextWindow", 1000),
            (mixdog_core_session::session::turn_ops::AGENT_WINDOW, 1000),
        ] {
            assert_eq!(changes[0].set.get(key), Some(&json!(want)), "{selected:?} {key}");
        }
        world.agents.end_process(&thread());
    }
    assert_eq!(world.agents.window_meta(&world.preset, "default"), Some(json!({ "contextWindow": 1000, "maxContextWindow": 1000 })));
    let row = world.agents.model_row(&world.preset, "default");
    assert_eq!((&row["contextWindow"], &row["maxContextWindow"]), (&json!(1000), &json!(1000)));
    assert!(!row["notApplicable"].as_array().unwrap().contains(&json!("contextWindow")), "{row}");
    // A newly reported window changes the settings value's `acpAgents`, which is what has the desktop read its catalog again.
    let after = world.agents.status();
    assert_ne!(after["agents"], before["agents"]);
    assert_eq!(after["agents"][0]["contextWindows"], json!({ "default": 1000 }));
    // The window is the reported model's: the default model's route row carries it, and no listed model's row does.
    let rows = world.agents.picker_rows();
    assert!(!rows.is_empty() && rows.iter().all(|row| row["id"] != "default" && row.get("maxContextWindow").is_none()), "{rows:?}");
}

/// What an agent last reported of its window is kept with the agents' other state: an app that starts over it sizes the
/// agent's routes by that window before the agent reports again, and an agent that never reported has none.
#[tokio::test]
async fn the_window_an_agent_reported_is_kept_across_a_restart_of_the_app() {
    let mut world = World::new(&[]);
    let input = json!({ "role": "user", "content": "stream" });
    within("the turn", world.serve_with(&Surface::default(), input, None, Some("RULES"), "default", CancellationToken::new(), Turns::default())).await;
    let reported = Some(json!({ "contextWindow": 1000, "maxContextWindow": 1000 }));
    assert_eq!(world.agents.window_meta(&world.preset, "default"), reported);

    world.restart();
    assert!(world.agents.window_meta(&world.preset, "default").is_none(), "nothing is read before the app restores it");
    world.agents.restore_windows().await;
    assert_eq!(world.agents.window_meta(&world.preset, "default"), reported);
    assert_eq!(world.agents.model_row(&world.preset, "default")["maxContextWindow"], json!(1000));

    let fresh = World::new(&[]);
    fresh.agents.restore_windows().await;
    assert!(fresh.agents.window_meta(&fresh.preset, "default").is_none(), "an agent that never reported has none");
}

/// A route saved under the agent's own id of one effort tier of a grouped model reports its window for the grouped model:
/// the picker's row of it, and a route that names the grouped model, find it.
#[tokio::test]
async fn a_window_reported_on_an_effort_tier_is_the_grouped_models() {
    let models = r#"[{"modelId":"gem-low","name":"Gem (Low)"},{"modelId":"gem-high","name":"Gem (High)"},{"modelId":"solo","name":"Solo"}]"#;
    let world = World::new(&[("FAKE_AGENT_MODELS", models)]);
    world.checked().await;
    let input = json!({ "role": "user", "content": "stream" });
    within("the turn", world.serve_with(&Surface::default(), input, None, Some("RULES"), "gem-high", CancellationToken::new(), Turns::default())).await;
    assert_eq!(world.agents.reported_window(&world.preset, "gem"), Some(1000));
    assert_eq!(world.agents.reported_window(&world.preset, "gem-low"), Some(1000), "the tier's own id names the same model");
    assert_eq!(world.agents.reported_window(&world.preset, "solo"), None);
    let rows = world.agents.picker_rows();
    let gem = rows.iter().find(|row| row["id"] == "gem").expect("the grouped model's row");
    assert_eq!(gem["maxContextWindow"], json!(1000));
    assert_eq!(world.agents.status()["agents"][0]["contextWindows"], json!({ "gem": 1000 }));
}

/// One agent serves models of different sizes: the window it reported on one model is that model's alone, in the rows, in
/// what sizes a route, and across a restart. A model it never reported a window on has none.
#[tokio::test]
async fn the_window_an_agent_reported_is_its_models_and_no_other_model_of_the_agent() {
    let models = r#"[{"modelId":"gem","name":"Gem"},{"modelId":"solo","name":"Solo"}]"#;
    let mut world = World::new(&[("FAKE_AGENT_MODELS", models)]);
    world.checked().await;
    let input = json!({ "role": "user", "content": "stream" });
    within("the turn", world.serve_with(&Surface::default(), input, None, Some("RULES"), "gem", CancellationToken::new(), Turns::default())).await;
    let sized = |world: &World| -> Vec<(String, bool)> {
        world.agents.picker_rows().iter().map(|row| (row["id"].as_str().unwrap().to_owned(), row.get("maxContextWindow") == Some(&json!(1000)))).collect()
    };
    let want = vec![("gem".to_owned(), true), ("solo".to_owned(), false)];
    assert_eq!(sized(&world), want);
    assert!(world.agents.window_meta(&world.preset, "solo").is_none() && world.agents.model_row(&world.preset, "solo").get("maxContextWindow").is_none());
    assert_eq!(world.agents.reported_window(&world.preset, "gem"), Some(1000));

    world.restart();
    world.agents.restore_windows().await;
    world.checked().await;
    assert_eq!(sized(&world), want, "kept per model across a restart");
    assert_eq!(world.agents.reported_window(&world.preset, "solo"), None);
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
    let told = ["Not sent to Antigravity (not readable where the session keeps its attachments): \"lost.pdf\", \"old notes.txt\"."];
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
    assert!(notices.len() == 1 && notices[0].starts_with("Antigravity's call \"Run it\" was not allowed in this session: "), "{notices:?}");
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

/// The official server's own tools, which every session of it has off.
const OFFICIAL_TOOLS: [&str; 15] = [
    "list_directory",
    "search_directory",
    "find_file",
    "view_file",
    "create_file",
    "edit_file",
    "run_command",
    "ask_question",
    "invoke_subagent",
    "run_workflow",
    "generate_image",
    "search_web",
    "read_url_content",
    "schedule",
    "finish",
];

/// The `_meta` the fake's session was opened with, as its `meta` answer `text` says it.
fn meta_of(text: &str) -> Value {
    serde_json::from_str(text.strip_prefix("meta=").unwrap_or_else(|| panic!("not the session's meta: {text}"))).expect("JSON")
}

/// The official server is the build Mixdog installed, started with the build's own arguments in a home of Mixdog's own and
/// its sign-in kept in a file there; it is never run for a version. Its state comes from its build, its home and what it
/// told of itself when it last ran: a check starts nothing, and a build below the preset's minimum is never started. With
/// no build installed nothing is started and nothing is downloaded.
#[tokio::test]
async fn the_official_server_runs_from_its_installed_build_in_its_own_home_and_a_check_starts_nothing() {
    let models = json!([{ "modelId": "gemini-a", "name": "Gemini A" }, { "modelId": "gemini-b", "name": "Gemini B" }]).to_string();
    let world = World::official(&[("FAKE_AGENT_MODELS", &models)]);
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["version"], &agent["minimumVersion"]), (&json!("ready"), &json!("1.5.2"), &json!("1.5.2")), "{agent}");
    assert_eq!(
        agent["models"],
        json!([{ "id": "gemini-a", "name": "Gemini A" }, { "id": "gemini-b", "name": "Gemini B" }]),
        "the models it told when it last ran"
    );
    assert!(world.processes.list().is_empty(), "{:?}", world.log());
    let home = home_of(world.dir.path(), "antigravity");
    let started = format!("official args=acp --from-manifest GEMINI_HOME={} AGY_ACP_FORCE_FILE_STORAGE=1", home.display());
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1 resumed=false"), "{end:?}");
    assert_eq!(world.logged(&started), 1, "{:?}", world.log());
    assert_eq!(world.logged("version"), 0, "the server has no version flag");

    let old = World::official(&[("FAKE_AGENT_VERSION", "1.5.1")]);
    let agent = old.checked().await;
    assert_eq!((&agent["state"], &agent["version"]), (&json!("versionTooOld"), &json!("1.5.1")));
    let refused = within("the refusal", old.agents.session(&thread(), &old.preset, old.cwd(), None, None)).await.err();
    assert_eq!(refused, Some(Refusal::NotReady(Readiness::VersionTooOld { version: "1.5.1".into() })));
    assert!(old.processes.list().is_empty() && old.log().is_empty(), "{:?}", old.log());

    let missing = World::official(&[]);
    missing.registry.offer("1.5.2", ARCHIVE);
    #[allow(clippy::disallowed_methods, reason = "a test removes the build it installed")]
    std::fs::remove_file(missing.dir.path().join("acp-agents").join("bin").join("antigravity").join("installed.json")).expect("the install");
    let agent = missing.checked().await;
    assert_eq!((&agent["state"], &agent["canInstall"], &agent["canSignIn"]), (&json!("notInstalled"), &json!(true), &json!(true)));
    assert!(missing.processes.list().is_empty() && missing.log().is_empty(), "{:?}", missing.log());
    assert!(missing.registry.downloads().is_empty(), "a check downloads nothing");
}

/// The official server's session is opened and reopened with its settings deep-merged beside Mixdog's prompt under one
/// `_meta.antigravity`: its own tools off, Mixdog's offered by name, their results whole, and no word on calling them.
/// A question handed no tools has the server's own off alone. The CLI's session carries Mixdog's prompt and that word.
#[tokio::test]
async fn the_official_servers_sessions_carry_its_settings_and_the_clis_its_prompt_alone() {
    let (world, _tools) = handing_in(World::official(&[]));
    let handed = json!({ "antigravity": {
        "systemPrompt": { "append": "RULES" },
        "mcpMaxOutputBytes": mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE,
        "eagerMcpServers": ["mixdog"],
        "disabledTools": OFFICIAL_TOOLS,
    } });
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "meta", None, CancellationToken::new())).await;
    assert_eq!(meta_of(completed_text(&end)), handed);
    let stored = world.agents.running(&thread()).expect("the session's agent").session_id.clone();
    world.agents.release(&thread());
    let end = within("the reopened turn", world.prompt(&thread(), &Surface::default(), "meta", Some(&stored), CancellationToken::new())).await;
    assert_eq!(meta_of(completed_text(&end)), handed);
    assert_eq!(world.logged("session/resume"), 1);

    let now: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(|| 0_i64);
    let answered =
        within("the answer", mixdog_acp::runs::ask_once(&world.agents, &world.preset, "default", "SUMMARIZE", "meta", now)).await.expect("an answer");
    assert_eq!(meta_of(&answered.text), json!({ "antigravity": { "systemPrompt": { "append": "SUMMARIZE" }, "disabledTools": OFFICIAL_TOOLS } }));

    let (cli, _tools) = handing(&[]);
    let end = within("the CLI's turn", cli.prompt(&thread(), &Surface::default(), "meta", None, CancellationToken::new())).await;
    let prompt = format!("RULES\n\n{}", mixdog_acp::mcp::preference());
    assert_eq!(meta_of(completed_text(&end)), json!({ "antigravity": { "systemPrompt": { "append": prompt } } }));
}

/// The official server names Mixdog's server and tool of a call under `_meta.mcp` alone: such a call is Mixdog's, shown
/// once as that tool's call, and the server's question about it is answered without the user.
#[tokio::test]
async fn the_official_servers_calls_of_mixdog_tools_are_known_by_their_meta() {
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    let end = tools.prompt(&world, &surface, r#"tool read {"path":"a.txt"}"#).await;
    assert_eq!(completed_text(&end), r#"result:read ran with {"path":"a.txt"}"#);
    assert_eq!(cards(&surface), ["read"], "{:?}", surface.rows());
    assert_eq!(*tools.ran.lock().unwrap(), [(thread(), "read".to_owned(), json!({ "path": "a.txt" }))]);

    let surface = Surface::default();
    let end = within("the turn", world.prompt_with(&thread(), &surface, "asktool read", None, CancellationToken::new(), Some(tools.calls(&surface)))).await;
    assert_eq!(completed_text(&end), "option:once");
    assert!(surface.0.asks.lock().unwrap().is_empty() && cards(&surface).is_empty(), "{:?}", surface.rows());
}

/// A prompt the official server answers with -32002, the protocol's code for a resource it does not hold, lost its session
/// whatever the message says: the conversation stops naming the session.
#[tokio::test]
async fn a_prompt_the_official_server_answers_with_the_lost_session_code_leaves_its_session_behind() {
    let world = World::official(&[]);
    let surface = Surface::default();
    let input = json!({ "role": "user", "content": "lost" });
    let end =
        within("the turn", world.serve_with(&surface, input, Some(held("sess-9")), Some("RULES"), "default", CancellationToken::new(), Turns::default())).await;
    assert_eq!(end, TurnEnd::Failed { message: "Resource not found: sess-9".into(), code: Some(-32002), reported: true });
    let changes: Vec<_> = surface.events().into_iter().filter_map(|event| if let Event::Header(change) = event { Some(change) } else { None }).collect();
    assert_eq!(changes.last().map(|change| change.unset.clone()), Some(vec![mixdog_acp::runs::SESSION_KEY.to_owned()]));
    assert!(world.agents.running(&thread()).is_none());
}

/// Antigravity's two presets split its models: each lists and runs only its own, the official server alone runs its
/// default model (which neither lists), and a route on a model of the other preset is refused naming that preset,
/// before any agent is asked.
#[tokio::test]
async fn each_preset_offers_and_runs_only_its_own_models() {
    let models = json!([
        { "modelId": "gemini-4-neon-high", "name": "Gemini 4 Neon (High)" },
        { "modelId": "gemini-4-neon-low", "name": "Gemini 4 Neon (Low)" },
        { "modelId": "claude-opus-5-5-high", "name": "Claude Opus 5.5 (High)" },
        { "modelId": "claude-opus-5-5-low", "name": "Claude Opus 5.5 (Low)" },
    ])
    .to_string();
    let world = World::of(&["antigravity", "antigravity-cli"], &[("FAKE_AGENT_MODELS", &models)], |_, _| {});
    let cli = world.presets[1].clone();
    world.checked().await;
    within("the CLI's check", world.agents.look(&cli)).await;
    let rows = world.agents.picker_rows();
    let listed: Vec<(&str, &str)> = rows.iter().map(|row| (row["provider"].as_str().unwrap(), row["id"].as_str().unwrap())).collect();
    assert_eq!(listed, [("acp-antigravity", "gemini-4-neon"), ("acp-antigravity-cli", "claude-opus-5-5")]);
    let status = world.agents.status();
    assert_eq!(status["agents"][0]["models"], json!([{ "id": "gemini-4-neon", "name": "Gemini 4 Neon" }]));
    assert_eq!(status["agents"][1]["models"], json!([{ "id": "claude-opus-5-5", "name": "Claude Opus 5.5" }]));

    let now: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(|| 0_i64);
    for (preset, model, said) in [
        (
            &world.preset,
            "claude-opus-5-5",
            "Antigravity (acp-antigravity) does not run the model \"claude-opus-5-5\". Choose it under Antigravity (acp-antigravity-cli).",
        ),
        (
            &cli,
            "gemini-4-neon-high",
            "Antigravity (acp-antigravity-cli) does not run the model \"gemini-4-neon-high\". Choose it under Antigravity (acp-antigravity).",
        ),
        (&cli, "default", "Antigravity (acp-antigravity-cli) does not run its agent's default model. Choose it under Antigravity (acp-antigravity)."),
    ] {
        let end = within("the refused turn", world.serve_on(preset, model)).await;
        assert_eq!(end, TurnEnd::Failed { message: said.to_owned(), code: None, reported: false }, "{model}");
        let asked = within("the refused question", mixdog_acp::runs::ask_once(&world.agents, preset, model, "SUMMARIZE", "whoami", now.clone())).await;
        assert_eq!(asked, Err(said.to_owned()), "{model}");
    }
    assert!(world.agents.running(&thread()).is_none());
    assert_eq!((world.logged("session/set_model"), world.logged("session/prompt")), (0, 0), "{:?}", world.log());
}

/// A route on a model of the other preset is refused by that model first, whatever this preset's state: an official
/// server that is not installed is not what the user is told, and nothing is started.
#[tokio::test]
async fn a_route_on_the_other_presets_model_is_refused_by_the_model_before_the_presets_state() {
    let world = World::of(&["antigravity", "antigravity-cli"], &[], |_, _| {});
    #[allow(clippy::disallowed_methods, reason = "a test removes the build it installed")]
    std::fs::remove_file(world.dir.path().join("acp-agents").join("bin").join("antigravity").join("installed.json")).expect("the install");
    let end = within("the refused turn", world.serve_on(&world.preset, "claude-opus-5-5")).await;
    let said = "Antigravity (acp-antigravity) does not run the model \"claude-opus-5-5\". Choose it under Antigravity (acp-antigravity-cli).";
    assert_eq!(end, TurnEnd::Failed { message: said.to_owned(), code: None, reported: false });
    let gemini = within("the turn on its own model", world.serve_on(&world.preset, "gemini-4-neon")).await;
    assert!(matches!(&gemini, TurnEnd::Failed { message, .. } if message.contains("is not installed")), "{gemini:?}");
    assert!(world.processes.list().is_empty(), "{:?}", world.log());
}

/// The official server starts once, when the first session needs it, however many sessions start at once, and serves
/// every later one; each session keeps its own folder, tool server with its own token, and settings.
#[tokio::test]
async fn one_official_server_serves_every_session_each_with_its_own_folder_tool_server_and_settings() {
    let (world, _tools) = handing_in(World::official(&[]));
    let (a, b, c) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"), ThreadId::from("sess_c"));
    let (in_a, in_b) = (world.folder("a"), world.folder("b"));
    let rules = || Some("RULES".to_owned());
    let (first, second) = within("the first two sessions", async {
        tokio::join!(world.agents.session(&a, &world.preset, in_a.clone(), None, rules()), world.agents.session(&b, &world.preset, in_b.clone(), None, rules()))
    })
    .await;
    let (first, second) = (first.expect("a's agent"), second.expect("b's agent"));
    assert_eq!(world.server_temps().len(), 1, "the concurrent first opens started one server: {:?}", world.log());
    assert_eq!(first.connection.handle(), second.connection.handle());
    assert_ne!(first.session_id, second.session_id);

    assert_eq!(world.answer_in(&a, &in_a, "cwd").await, format!("cwd={}", in_a.as_path().display()));
    assert_eq!(world.answer_in(&b, &in_b, "cwd").await, format!("cwd={}", in_b.as_path().display()));
    let (url_a, token_a) = tool_server(&world.answer_in(&a, &in_a, "servers").await);
    let (url_b, token_b) = tool_server(&world.answer_in(&b, &in_b, "servers").await);
    assert!(url_a != url_b && token_a != token_b, "each session is handed a tool server of its own: {url_a} {url_b}");
    let handed = json!({ "antigravity": {
        "systemPrompt": { "append": "RULES" },
        "mcpMaxOutputBytes": mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE,
        "eagerMcpServers": ["mixdog"],
        "disabledTools": OFFICIAL_TOOLS,
    } });
    assert_eq!(meta_of(&world.answer_in(&a, &in_a, "meta").await), handed);
    assert_eq!(meta_of(&world.answer_in(&b, &in_b, "meta").await), handed);

    // A later session is the same server's.
    assert!(world.answer_in(&c, &world.cwd(), "whoami").await.starts_with("session=sess-3 resumed=false"));
    assert_eq!(world.agents.running(&c).expect("c's agent").connection.handle(), first.connection.handle());
    assert_eq!((world.server_temps().len(), world.logged("start acp")), (1, 1), "the one server, and no process for the check: {:?}", world.log());
}

/// What the server sends of a session reaches that session alone, while the others' turns run: its updates, its questions,
/// its reads, which are answered from its own folder only, and its prompt's answer; a read or a question that names no
/// session it holds open is refused. A cancel stops that session's prompt alone.
#[tokio::test]
async fn what_the_shared_server_sends_of_a_session_reaches_that_session_alone() {
    // Official Neon disables fs_read_text_file; opt in here to exercise shared-server read isolation.
    let world = World::of(&["antigravity"], &[], |preset, _| {
        preset.quirks.fs_read_text_file = true;
    });
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    let (in_a, in_b) = (world.folder("a"), world.folder("b"));
    #[allow(clippy::disallowed_methods, reason = "a test writes the files its sessions read")]
    {
        std::fs::write(in_a.as_path().join("a.txt"), "alpha").expect("a's file");
        std::fs::write(in_b.as_path().join("b.txt"), "beta").expect("b's file");
    }
    let (of_a, of_b) = (in_a.as_path().join("a.txt").display().to_string(), in_b.as_path().join("b.txt").display().to_string());
    // A's session opens first: it is the server's first.
    let whoami = world.answer_in(&a, &in_a, "whoami").await;
    assert!(whoami.starts_with("session=sess-1") && whoami.contains(" read=true "), "{whoami}");

    let (working, stop) = (Surface::default(), CancellationToken::new());
    let hanging = world.prompt_in(&a, &in_a, &working, "hang", None, stop.clone());
    let others = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        let read = Surface::default();
        let end = world.prompt_in(&b, &in_b, &read, &format!("read {of_b}"), None, CancellationToken::new()).await;
        assert_eq!(completed_text(&end), "read:beta");
        assert_eq!(read.streamed(), "read:beta", "only B's own reply");
        let end = world.prompt_in(&b, &in_b, &Surface::default(), &format!("read {of_a}"), None, CancellationToken::new()).await;
        assert!(completed_text(&end).starts_with("error:") && completed_text(&end).contains("outside the session's folder"), "{end:?}");
        for named in ["-", "sess-9"] {
            let end = world.prompt_in(&b, &in_b, &Surface::default(), &format!("readas {named} {of_b}"), None, CancellationToken::new()).await;
            assert_eq!(completed_text(&end), "error:the read names no session this client holds open", "{named}");
        }
        let end = world.prompt_in(&b, &in_b, &Surface::default(), "askas sess-9", None, CancellationToken::new()).await;
        assert_eq!(completed_text(&end), "cancelled", "a question about no open session is cancelled");
        let asked = Surface::default();
        let end = world.prompt_in(&b, &in_b, &asked, "permission", None, CancellationToken::new()).await;
        assert_eq!(completed_text(&end), "option:no");
        assert_eq!(asked.0.asks.lock().unwrap().len(), 1);
        // Only A's prompt is cancelled.
        stop.cancel();
    };
    let (end, ()) = within("the sessions' turns", async { tokio::join!(hanging, others) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    assert_eq!(working.streamed(), "working", "nothing of B's reached A's turn");
    assert!(working.0.asks.lock().unwrap().is_empty());
    world.logs("session/cancel sess-1").await;
    assert_eq!(world.logged("session/cancel sess-2"), 0, "{:?}", world.log());
    assert!(world.answer_in(&b, &in_b, "whoami").await.starts_with("session=sess-2"));
}

/// A model switch and a close act on their session alone: the other session keeps its model, and a session that closes
/// leaves the server (its tool server closed) while the server serves the others on.
#[tokio::test]
async fn a_model_switch_and_a_close_act_on_one_session_of_the_shared_server() {
    let models = json!([{ "modelId": "gemini-a", "name": "Gemini A" }, { "modelId": "gemini-b", "name": "Gemini B" }]).to_string();
    let (world, _tools) = handing_in(World::official(&[("FAKE_AGENT_MODELS", &models)]));
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    let in_b = world.folder("b");
    let turns = Arc::new(Turns::default());
    let request = TurnRequest {
        thread: a.clone(),
        cwd: world.cwd(),
        stored: None,
        rules: Some("RULES".into()),
        input: json!({ "role": "user", "content": "whoami" }),
        conversation: turns.clone(),
        attachments: turns,
        last_context_tokens: None,
        context_window: None,
    };
    let context = TurnContext { model: "gemini-b".into(), ..world.context(CancellationToken::new()) };
    let end = within("A's turn", mixdog_acp::runs::serve(&world.agents, &world.preset, request, Arc::new(Surface::default()), context)).await;
    assert!(completed_text(&end).contains(" model=gemini-b "), "{end:?}");
    assert!(world.answer_in(&b, &in_b, "whoami").await.contains(" model=m1 "), "B's session keeps its own model");
    assert_eq!((world.logged("session/set_model sess-1"), world.logged("session/set_model sess-2")), (1, 0), "{:?}", world.log());

    let (url, _) = tool_server(&world.answer_in(&a, &world.cwd(), "servers").await);
    let port: u16 = url.trim_end_matches("/mcp").rsplit(':').next().and_then(|port| port.parse().ok()).expect("the port");
    let server = world.agents.running(&a).expect("a's agent").connection.clone();
    world.agents.release(&a);
    within("A's tool server to close", async {
        while tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(world.agents.running(&a).is_none());
    within("the official shared server to retire once quiescent", server.exited().cancelled()).await;
    world.logs("session/resume sess-2").await;
    let resumed_b = within("B on the new server", world.prompt_in(&b, &in_b, &Surface::default(), "whoami", Some("sess-2"), CancellationToken::new())).await;
    assert!(completed_text(&resumed_b).starts_with("session=sess-2 resumed=true"), "{resumed_b:?}");
    assert_ne!(world.agents.running(&b).expect("b's agent").connection.handle(), server.handle());
    assert_eq!(world.logged("session/resume sess-2"), 1, "{:?}", world.log());
}

/// A server that exits fails the turns running on it cleanly, and the next turn of each of its sessions starts one new
/// server, in which each session is resumed with its id, a tool server of its own again and all its settings.
#[tokio::test]
async fn an_exited_shared_server_fails_its_turns_and_the_next_ones_resume_their_sessions_in_one_new_server() {
    let (world, _tools) = handing_in(World::official(&[]));
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    let (in_a, in_b) = (world.folder("a"), world.folder("b"));
    assert!(world.answer_in(&a, &in_a, "whoami").await.starts_with("session=sess-1"));
    assert!(world.answer_in(&b, &in_b, "whoami").await.starts_with("session=sess-2"));
    let (_, token) = tool_server(&world.answer_in(&a, &in_a, "servers").await);

    let working = Surface::default();
    let hanging = world.prompt_in(&a, &in_a, &working, "hang", None, CancellationToken::new());
    let dying = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        world.prompt_in(&b, &in_b, &Surface::default(), "die", None, CancellationToken::new()).await
    };
    let (hung, died) = within("the server's exit", async { tokio::join!(hanging, dying) }).await;
    assert!(matches!(died, TurnEnd::Failed { code: None, .. }), "{died:?}");
    assert!(matches!(&hung, TurnEnd::Failed { code: None, message, .. } if message.starts_with("the agent process ended")), "{hung:?}");
    let rows = working.rows();
    assert_eq!(rows.last().map(|row| row["content"].clone()), Some(json!("The agent's process ended before this call did.")), "{rows:?}");

    let handed = json!({ "antigravity": {
        "systemPrompt": { "append": "RULES" },
        "mcpMaxOutputBytes": mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE,
        "eagerMcpServers": ["mixdog"],
        "disabledTools": OFFICIAL_TOOLS,
    } });
    let (of_a, of_b) = (Surface::default(), Surface::default());
    let (again_a, again_b) = within("the next turns", async {
        tokio::join!(
            world.prompt_in(&a, &in_a, &of_a, "meta", Some("sess-1"), CancellationToken::new()),
            world.prompt_in(&b, &in_b, &of_b, "meta", Some("sess-2"), CancellationToken::new()),
        )
    })
    .await;
    assert_eq!((meta_of(completed_text(&again_a)), meta_of(completed_text(&again_b))), (handed.clone(), handed));
    assert_eq!(world.server_temps().len(), 2, "one new server for both: {:?}", world.log());
    assert_eq!((world.logged("session/resume sess-1"), world.logged("session/resume sess-2")), (1, 1), "{:?}", world.log());
    let (_, resumed) = tool_server(&world.answer_in(&a, &in_a, "servers").await);
    assert_ne!(resumed, token, "the resumed session is handed a new tool server");
}

/// A session the new server refuses to resume is opened anew, and the conversation is handed over as Mixdog's summary.
#[tokio::test]
async fn a_session_the_new_server_cannot_resume_is_opened_anew_with_the_conversations_summary() {
    let world = World::official(&[("FAKE_AGENT_FORGETS", "1")]);
    let input = || json!({ "role": "user", "content": "whoami" });
    let first = within("the first turn", world.serve(&Surface::default(), input(), None, "default", CancellationToken::new())).await;
    assert!(completed_text(&first).starts_with("session=sess-1 resumed=false"), "{first:?}");
    let server = world.agents.running(&thread()).expect("the session's agent").connection.clone();
    server.kill();
    within("the server's exit", server.exited().cancelled()).await;

    let surface = Surface::default();
    let turns = Turns { summary: Some(Ok("## User\nearlier talk")), ..Turns::default() };
    let end =
        within("the next turn", world.serve_with(&surface, input(), Some(held("sess-1")), Some("RULES"), "default", CancellationToken::new(), turns)).await;
    let said = completed_text(&end);
    assert!(said.starts_with("session=sess-2 resumed=false") && said.contains("## User\nearlier talk"), "{end:?}");
    assert_eq!(surface.notices(), ["Antigravity could not reopen its earlier session: the conversation above was summarized for the new one."]);
    assert_eq!((world.logged("session/resume sess-1"), world.server_temps().len()), (1, 2), "{:?}", world.log());
}

/// A `!closes` shared server retires as soon as a session leaves it and remaining sessions are idle, cleaning up its
/// temporary folder on EOF so per-session helper processes never accumulate; the session it still held is reopened on a
/// new server at once, and once no session is held no server runs until the next turn starts one.
#[tokio::test]
async fn a_shared_server_runs_while_a_session_uses_it_and_closes_once_none_does() {
    let world = World::official(&[]);
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    world.answer_in(&a, &world.cwd(), "whoami").await;
    world.answer_in(&b, &world.cwd(), "whoami").await;
    let server = world.agents.running(&a).expect("a's agent").connection.clone();
    let temp = world.server_temps().pop().expect("the server's temporary folder");
    assert!(exists(&temp.join("_MEIfake")));

    world.agents.release(&b);
    within("the server's quiescent exit", server.exited().cancelled()).await;
    assert_eq!(world.exit_of(server.handle()), Some(CLOSED), "closed by the end of its input");
    assert_eq!(world.logged("eof"), 1);
    assert!(!exists(&temp), "{temp:?}");

    // A's session was reopened on a new server, where its next turn goes on.
    world.logs("session/resume sess-1").await;
    assert!(world.answer_in(&a, &world.cwd(), "whoami").await.starts_with("session=sess-1 resumed=true"));
    let server2 = world.agents.running(&a).expect("a's agent").connection.clone();
    assert_ne!(server2.handle(), server.handle());
    let temp2 = world.server_temps().pop().expect("the second server's temporary folder");
    assert!(exists(&temp2.join("_MEIfake")));

    world.agents.release(&a);
    within("the second server's exit", server2.exited().cancelled()).await;
    assert_eq!(world.exit_of(server2.handle()), Some(CLOSED), "closed by the end of its input");
    assert_eq!(world.logged("eof"), 2);
    assert!(!exists(&temp2), "{temp2:?}");
    assert_eq!(world.logged("start acp"), 2, "no server starts while no session is held: {:?}", world.log());
    assert!(world.answer_in(&b, &world.cwd(), "whoami").await.starts_with("session=sess-1 resumed=false"));
    assert_eq!((world.server_temps().len(), world.logged("start acp")), (3, 3), "{:?}", world.log());
}

/// Each start of the server has a temporary folder of its own, removed once it exits however it ended; the daemon's start
/// removes those that daemons gone since left behind, and keeps those of the daemon that runs.
#[tokio::test]
async fn each_server_start_has_its_own_temporary_folder_and_those_of_gone_daemons_are_swept() {
    let world = World::official(&[]);
    let tmp = world.dir.path().join("acp-agents").join("tmp");
    let (gone, own) = (tmp.join("pid-2000000000-3"), tmp.join(format!("pid-{}-999999", std::process::id())));
    #[allow(clippy::disallowed_methods, reason = "a test leaves what daemons left behind")]
    {
        std::fs::create_dir_all(gone.join("_MEI123")).expect("a gone daemon's folder");
        std::fs::write(gone.join("_MEI123").join("python3.dll"), "unpacked").expect("its file");
        std::fs::create_dir_all(&own).expect("this daemon's folder");
    }
    // As the daemon's start sweeps them.
    within("the sweep", world.agents.sweep_leftovers()).await;
    assert!(!exists(&gone) && exists(&own));
    world.answer_in(&thread(), &world.cwd(), "whoami").await;
    let temp = world.server_temps().pop().expect("the server's temporary folder");
    assert!(temp.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&format!("pid-{}-", std::process::id()))), "{temp:?}");
    assert!(exists(&temp.join("_MEIfake")));
    // A server ended by force leaves nothing either.
    let server = world.agents.running(&thread()).expect("the session's agent").connection.clone();
    server.kill();
    within("the server's exit", server.exited().cancelled()).await;
    assert!(!exists(&temp), "{temp:?}");
}

/// The app's stop closes every shared server as the end of its input closes it, and nothing it unpacked is left.
#[tokio::test]
async fn the_apps_stop_closes_the_shared_server_and_leaves_nothing_it_unpacked() {
    let world = World::official(&[]);
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    world.answer_in(&a, &world.cwd(), "whoami").await;
    world.answer_in(&b, &world.folder("b"), "whoami").await;
    let server = world.agents.running(&a).expect("a's agent").connection.clone();
    let temp = world.server_temps().pop().expect("the server's temporary folder");
    assert!(exists(&temp.join("_MEIfake")));
    within("the stop", world.agents.shutdown()).await;
    assert_eq!(world.exit_of(server.handle()), Some(CLOSED), "closed by the end of its input");
    assert_eq!(world.logged("eof"), 1);
    assert!(!exists(&temp), "{temp:?}");
}

/// The CLI's preset starts a process of its own for each session, as before.
#[tokio::test]
async fn the_clis_sessions_each_run_in_a_process_of_their_own() {
    let world = World::new(&[]);
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    assert!(world.answer_in(&a, &world.cwd(), "whoami").await.starts_with("session=sess-1"));
    assert!(world.answer_in(&b, &world.cwd(), "whoami").await.starts_with("session=sess-1"));
    let (first, second) = (world.agents.running(&a).expect("a's agent"), world.agents.running(&b).expect("b's agent"));
    assert_ne!(first.connection.handle(), second.connection.handle());
    assert_eq!(world.logged("start acp"), 3, "the check's process and one per session");
    world.agents.release(&a);
    within("a's exit", first.connection.exited().cancelled()).await;
    assert!(!second.connection.exited().is_cancelled());
}

/// A route that moves to the other preset of the agent ends the thread's session on the one it leaves: on the shared
/// server only that session leaves it, and the server serves the others on.
#[tokio::test]
async fn a_route_moved_to_the_other_preset_takes_the_threads_session_off_the_shared_server_alone() {
    let world = World::of(&["antigravity", "antigravity-cli"], &[], |_, _| {});
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    world.answer_in(&a, &world.cwd(), "whoami").await;
    world.answer_in(&b, &world.folder("b"), "whoami").await;
    let server = world.agents.running(&a).expect("a's agent").connection.clone();
    let writer = AgentRouteWriter { inner: Arc::new(Routes::default()), agents: world.agents.clone() };
    let route = |provider: &str| json!({ "provider": provider, "model": "default" }).as_object().cloned().expect("a route");
    writer.set_route_state(&a, route("acp-antigravity"));
    assert!(world.agents.running(&a).is_some(), "a route change on the same preset keeps the session");
    writer.set_route_state(&a, route("acp-antigravity-cli"));
    assert!(world.agents.running(&a).is_none());
    within("the official shared server to retire once quiescent", server.exited().cancelled()).await;
    assert_eq!(world.logged("eof"), 1);
    let resumed_b =
        within("B resumes on a fresh server", world.prompt_in(&b, &world.folder("b"), &Surface::default(), "whoami", Some("sess-2"), CancellationToken::new()))
            .await;
    assert!(completed_text(&resumed_b).starts_with("session=sess-2 resumed=true"), "{resumed_b:?}");
}

/// A reply an agent's session began on its own is the route's of that session's preset: a wake served on the other preset
/// (the route moved meanwhile) shows nothing of it and starts no turn in the agent.
#[tokio::test]
async fn a_wake_on_another_presets_route_shows_nothing_of_the_reply() {
    let world = World::of(&["antigravity-cli", "antigravity"], &[], |preset, _| preset.quirks.runs_default = true);
    let official = world.presets[1].clone();
    within("the turn", world.prompt(&thread(), &Surface::default(), "background", None, CancellationToken::new())).await;
    world.wakes(1).await;
    let session = world.agents.running(&thread()).expect("the session's agent");
    let wake = json!({ "role": "user", "content": WAKE_TEXT, "meta": { "source": "task-notification" } });
    let turns = Arc::new(Turns::default());
    let request = TurnRequest {
        thread: thread(),
        cwd: world.cwd(),
        stored: None,
        rules: Some("RULES".into()),
        input: wake,
        conversation: turns.clone(),
        attachments: turns,
        last_context_tokens: None,
        context_window: None,
    };
    let surface = Surface::default();
    let end =
        within("the wake", mixdog_acp::runs::serve(&world.agents, &official, request, Arc::new(surface.clone()), world.context(CancellationToken::new())))
            .await;
    assert_eq!(end, TurnEnd::Completed { text: String::new(), stop_reason: None, tool_calls: 0 });
    assert!(surface.rows().is_empty(), "{:?}", surface.rows());
    assert!(session.woken(), "the reply waits for its own route's turn");
    assert_eq!(world.logged("session/prompt"), 1);
}

/// The folder of the official server's builds in the world's folder.
fn builds_of(world: &World) -> std::path::PathBuf {
    world.dir.path().join("acp-agents").join("bin").join("antigravity")
}

#[allow(clippy::disallowed_methods, reason = "a test reads what Mixdog keeps")]
fn read_json(path: &std::path::Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).expect("JSON")
}

#[allow(clippy::disallowed_methods, reason = "a test reads the official server's home")]
fn credential_of(world: &World) -> Option<String> {
    std::fs::read_to_string(home_of(world.dir.path(), "antigravity").join("antigravity-acp").join("acp_token.json")).ok()
}

/// The sign-ins' staging homes left beside the agents' homes.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a test lists the agents' homes")]
fn staging_homes(world: &World) -> Vec<std::path::PathBuf> {
    let homes = world.dir.path().join("acp-agents").join("homes");
    let entries = std::fs::read_dir(homes).map(|entries| entries.filter_map(Result::ok).map(|entry| entry.path()).collect::<Vec<_>>()).unwrap_or_default();
    entries.into_iter().filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.contains(".login-"))).collect()
}

/// The feature's install takes the official server from the ACP registry: the build for this system with its own
/// arguments, named by `installed.json`, and never one from a host the preset does not name. A check of the installed
/// build brings it to the registry's newest, never while its server runs, and keeps it where the registry cannot be
/// reached.
#[tokio::test]
async fn the_official_server_is_installed_from_the_registry_and_kept_current_only_while_it_does_not_run() {
    let world = World::official(&[]);
    let builds = builds_of(&world);
    #[allow(clippy::disallowed_methods, reason = "a test removes the build it installed")]
    std::fs::remove_file(builds.join("installed.json")).expect("the install");
    world.registry.offer("1.5.2", "https://downloads.example/agy-acp-server.zip");
    let refused = within("the refused install", world.agents.install()).await.expect_err("a build from another host");
    assert!(refused.contains("is not on a host the build may come from"), "{refused}");
    assert!(world.registry.downloads().is_empty());

    world.registry.offer("1.5.2", ARCHIVE);
    within("the install", world.agents.install()).await.expect("the install");
    assert_eq!(world.registry.downloads(), [ARCHIVE]);
    let installed = read_json(&builds.join("installed.json"));
    assert_eq!((&installed["version"], &installed["args"]), (&json!("1.5.2"), &json!(["--uid="])), "{installed}");
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["version"], &agent["lastError"]), (&json!("ready"), &json!("1.5.2"), &Value::Null), "{agent}");
    // A session's server is the build, started with the build's own arguments.
    assert!(world.answer_in(&thread(), &world.cwd(), "whoami").await.starts_with("session=sess-1"));
    let home = home_of(world.dir.path(), "antigravity");
    assert!(world.logged(&format!("official args=--uid= GEMINI_HOME={} AGY_ACP_FORCE_FILE_STORAGE=1", home.display())) >= 1, "{:?}", world.log());

    // A newer build is not installed while the server runs.
    world.registry.offer("1.5.3", ARCHIVE);
    assert_eq!(world.checked().await["version"], "1.5.2");
    assert_eq!(world.registry.downloads().len(), 1);

    let server = world.agents.running(&thread()).expect("the session's agent").connection.clone();
    world.agents.release_all();
    within("the server's exit", server.exited().cancelled()).await;
    #[allow(clippy::disallowed_methods, reason = "the fake names the version of the build it was unpacked as")]
    std::fs::write(world.dir.path().join("version"), "1.5.3").expect("the fake's version");
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["version"], &agent["lastError"]), (&json!("ready"), &json!("1.5.3"), &Value::Null), "{agent}");
    assert_eq!(world.registry.downloads().len(), 2);
    assert_eq!(read_json(&builds.join("installed.json"))["version"], "1.5.3");
    assert!(exists(&builds.join("1.5.3")) && !exists(&builds.join("1.5.2")), "the build replaced is removed");

    // A registry that cannot be reached leaves the installed build as it is, with no failure to tell.
    *world.registry.index.lock().unwrap() = None;
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["version"], &agent["lastError"]), (&json!("ready"), &json!("1.5.3"), &Value::Null), "{agent}");
    assert_eq!(world.registry.downloads().len(), 2);
}

/// Turning the feature off ends a download of the official server at once, and the next install clears what it left.
#[tokio::test]
async fn turning_the_feature_off_ends_a_download_of_the_official_server() {
    let world = World::official(&[]);
    let builds = builds_of(&world);
    #[allow(clippy::disallowed_methods, reason = "a test removes the build it installed")]
    std::fs::remove_file(builds.join("installed.json")).expect("the install");
    world.registry.offer("1.5.2", ARCHIVE);
    world.registry.hangs.store(true, Ordering::SeqCst);
    let installing = world.agents.install();
    let off = async {
        while world.registry.downloads().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(world.agents.status()["agents"][0]["state"], "installing");
        world.enabled.store(false, Ordering::SeqCst);
        world.agents.status();
    };
    let (installed, ()) = within("the install's end", async { tokio::join!(installing, off) }).await;
    assert_eq!(installed, Err("ACP agents were turned off before the install ended.".to_owned()));
    assert!(!exists(&builds.join("installed.json")));

    world.enabled.store(true, Ordering::SeqCst);
    world.registry.hangs.store(false, Ordering::SeqCst);
    within("the install", world.agents.install()).await.expect("the install");
    #[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a test lists the builds' folder")]
    let left: Vec<String> =
        std::fs::read_dir(&builds).expect("the builds").filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    assert!(!left.iter().any(|name| name.starts_with(".staging-")), "{left:?}");
}

/// A build whose program is gone (deleted, or quarantined by an antivirus) is no build: a check finds the official server
/// not installed, and the install puts it back.
#[tokio::test]
async fn a_build_whose_program_is_gone_is_not_installed_and_the_install_puts_it_back() {
    let world = World::official(&[]);
    let builds = builds_of(&world);
    let record = json!({ "version": "1.5.2", "cmd": "agy_acp_server.exe", "args": [], "sha256": "" });
    #[allow(clippy::disallowed_methods, reason = "a test names a build whose program is gone")]
    std::fs::write(builds.join("installed.json"), record.to_string()).expect("the record");
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["canInstall"]), (&json!("notInstalled"), &json!(true)), "{agent}");

    world.registry.offer("1.5.2", ARCHIVE);
    within("the install", world.agents.install()).await.expect("the install");
    assert_eq!(world.registry.downloads(), [ARCHIVE]);
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["version"]), (&json!("ready"), &json!("1.5.2")), "{agent}");
}

/// A build whose helper binary (`localharness_external[.exe]`) is gone while `installed.json` and the server remain is
/// incomplete: a check finds it not installed, and the install repairs it.
#[tokio::test]
async fn a_build_whose_helper_is_gone_is_not_installed_and_the_install_puts_it_back() {
    let world = World::official(&[]);
    let builds = builds_of(&world);
    let helper = if cfg!(windows) { "localharness_external.exe" } else { "localharness_external" };
    let helper_path = builds.join("1.5.2").join(helper);
    assert!(exists(&helper_path));
    #[allow(clippy::disallowed_methods, reason = "a test removes the build's helper binary")]
    std::fs::remove_file(&helper_path).expect("the helper");
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["canInstall"]), (&json!("notInstalled"), &json!(true)), "{agent}");

    world.registry.offer("1.5.2", ARCHIVE);
    within("the install", world.agents.install()).await.expect("the install");
    assert_eq!(world.registry.downloads(), [ARCHIVE]);
    assert!(exists(&helper_path));
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["version"]), (&json!("ready"), &json!("1.5.2")), "{agent}");
}

/// An install ended while its unpack still writes into its folder leaves that unpack to finish before the next install
/// clears away what it left: nothing of the next one starts meanwhile, and no folder of the ended one is left after.
#[tokio::test]
async fn the_next_install_waits_for_an_ended_unpack_before_it_clears_what_that_left() {
    let world = World::official(&[]);
    let builds = builds_of(&world);
    #[allow(clippy::disallowed_methods, reason = "a test removes the build it installed")]
    std::fs::remove_file(builds.join("installed.json")).expect("the install");
    world.registry.offer("1.5.2", ARCHIVE);
    world.registry.hangs.store(true, Ordering::SeqCst);
    world.registry.lingers.store(true, Ordering::SeqCst);
    let first_entered = world.registry.entered.notified();
    tokio::pin!(first_entered);
    first_entered.as_mut().enable();
    let installing = world.agents.install();
    let off = async {
        first_entered.await;
        world.enabled.store(false, Ordering::SeqCst);
        world.agents.status();
    };
    let (installed, ()) = within("the install's end", async { tokio::join!(installing, off) }).await;
    assert_eq!(installed, Err("ACP agents were turned off before the install ended.".to_owned()));

    world.enabled.store(true, Ordering::SeqCst);
    world.registry.hangs.store(false, Ordering::SeqCst);
    let late_done = world.registry.late_done.notified();
    tokio::pin!(late_done);
    late_done.as_mut().enable();
    let again = world.agents.install();
    let finish = async {
        loop {
            let changed = world.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if world.agents.status()["agents"][0]["state"] == "installing" {
                break;
            }
            changed.await;
        }
        assert_eq!(world.registry.downloads().len(), 1, "the next install started while the ended unpack still wrote");
        world.registry.finish.notify_one();
        late_done.await;
    };
    let (installed, ()) = within("the install", async { tokio::join!(again, finish) }).await;
    installed.expect("the install");
    assert_eq!(world.registry.downloads().len(), 2);
    #[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a test lists the builds' folder")]
    let left: Vec<String> =
        std::fs::read_dir(&builds).expect("the builds").filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    assert!(!left.iter().any(|name| name.starts_with(".staging-")), "{left:?}");
}

/// The official server's quota comes from the Antigravity CLI preset's `/usage` report when the CLI is ready, and
/// returns `None` when the CLI is missing or signed out (never reading `acp_token.json`).
#[tokio::test]
async fn the_official_servers_quota_comes_from_the_antigravity_cli_report() {
    let world = World::of(&["antigravity", "antigravity-cli"], &[], |_, _| {});
    let cli = world.agents.presets().iter().find(|p| p.id == "antigravity-cli").expect("cli preset").clone();
    assert!(matches!(within("official look", world.agents.look(&world.preset)).await, Some(Readiness::Ready { .. })));
    assert!(!world.agents.reports_usage(&world.preset), "CLI has not been checked yet");
    assert_eq!(within("report before cli ready", world.agents.usage(&world.preset)).await, None);

    assert!(matches!(within("cli look", world.agents.look(&cli)).await, Some(Readiness::Ready { .. })));
    assert!(world.agents.reports_usage(&world.preset));
    let report = within("the report", world.agents.usage(&world.preset)).await.expect("a ready CLI is asked").expect("the report");
    assert!(report["groups"].as_array().is_some_and(|groups| !groups.is_empty()), "{report}");

    // When the CLI is signed out, the official server reports no usage.
    let signed_out = World::of(&["antigravity", "antigravity-cli"], &[("FAKE_AGENT_SIGNED_OUT", "1")], |_, _| {});
    let cli_out = signed_out.agents.presets().iter().find(|p| p.id == "antigravity-cli").expect("cli preset").clone();
    assert!(matches!(within("official look", signed_out.agents.look(&signed_out.preset)).await, Some(Readiness::Ready { .. })));
    assert!(matches!(within("cli signed out", signed_out.agents.look(&cli_out)).await, Some(Readiness::SignedOut { .. })));
    assert!(!signed_out.agents.reports_usage(&signed_out.preset));
    assert_eq!(within("no report when cli signed out", signed_out.agents.usage(&signed_out.preset)).await, None);
}

/// A sign-in page that sends the browser back to the official server's loopback listener can be finished from a browser
/// on another machine: the address it ended on, pasted, reaches the listener with the page's own state, and one of
/// another sign-in is refused. The server runs with a browser of its own that takes the page and opens nothing.
#[tokio::test]
async fn an_official_sign_in_finished_on_another_machine_delivers_the_pasted_address_to_the_servers_listener() {
    use mixdog_core_api::domain::login::LoginError;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("a local listener");
    let port = listener.local_addr().expect("its address").port();
    let page = format!("https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Foauth2callback&state=st-1");
    let world = World::official(&[("FAKE_AGENT_AUTH_PAGE", &page), ("FAKE_AGENT_AUTH_UNTIL", "signed-in-on-the-page")]);
    let signed_in = world.dir.path().join("signed-in-on-the-page");
    // The server's listener: the address it is asked for signs the user in.
    let listened = tokio::spawn(async move {
        let (mut connection, _) = listener.accept().await.expect("the delivery");
        let (mut request, mut chunk) = (Vec::new(), [0_u8; 1024]);
        while !request.windows(4).any(|end| end == b"\r\n\r\n") {
            match connection.read(&mut chunk).await.expect("the request") {
                0 => break,
                read => request.extend_from_slice(&chunk[..read]),
            }
        }
        #[allow(clippy::disallowed_methods, reason = "the user signs in on the page")]
        std::fs::write(&signed_in, "").expect("the sign-in");
        connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.expect("the answer");
        String::from_utf8_lossy(&request).split_whitespace().nth(1).map(str::to_owned)
    });
    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    let shown = login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    assert_eq!(shown, LoginState::Authorize { url: page.clone(), manual_url: Some(page.clone()) });

    let other = login.provide(LoginInput::AuthorizationCode("http://localhost:1/oauth2callback?state=another&code=c".into())).await;
    let refused = "The address is of another sign-in. Paste the address this sign-in's page ended on.";
    assert_eq!(other, Err(LoginError::Failed(LoginFailure::Failed { code: "agentLogin".into(), message: refused.into() })));
    let pasted = "http://localhost:8085/oauth2callback?state=st-1&code=4/abc&scope=email";
    login.provide(LoginInput::AuthorizationCode(pasted.into())).await.expect("the address is delivered");
    let asked = within("the listener", listened).await.expect("the listener").expect("a request");
    let asked = url::Url::parse(&format!("http://127.0.0.1:{port}{asked}")).expect("an address");
    assert_eq!(asked.path(), "/oauth2callback");
    let query: Vec<(String, String)> = asked.query_pairs().into_owned().collect();
    assert_eq!(query, [("state".to_owned(), "st-1".to_owned()), ("code".to_owned(), "4/abc".to_owned())]);
    assert_eq!(login_state(login.as_ref(), LoginState::is_terminal).await, LoginState::Done { account: None });

    let browser = world.log().iter().find_map(|line| line.strip_prefix("official browser=").map(str::to_owned)).expect("the server's start");
    assert!(browser.contains("%s"), "the server's own browser is a command given the page: {browser:?}");
}

/// A bad pasted redirect URL or a non-2xx loopback answer submitted through `OAuthFlows::complete` ends the flow as
/// `failed` and cancels the underlying `Authenticate` login so its server process, staging home and update guard
/// (`Starting`) are released instead of blocking subsequent updates.
#[tokio::test]
async fn a_failed_pasted_redirect_through_oauth_flows_cancels_the_login_and_releases_the_update_lock() {
    use mixdog_core_api::domain::process::ProcessEvent;
    use mixdog_core_api::feed_publisher::LoginFeeds;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;
    use mixdog_core_domains::domains::ai_account::flows::DEFAULT_FLOW_TTL_MS;
    use mixdog_core_domains::domains::ai_account::flows::OAuthFlows;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("a loopback listener");
    let port = listener.local_addr().expect("a port").port();
    let page = format!("https://accounts.example/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Foauth2callback&state=st-1");
    let world = World::official(&[("FAKE_AGENT_AUTH_PAGE", &page), ("FAKE_AGENT_AUTH_UNTIL", "signed-in-on-the-page")]);
    let flows = OAuthFlows::new(Duration::from_millis(DEFAULT_FLOW_TTL_MS), Arc::new(LoginFeeds::new(Arc::new(MockScopedFeeds::new(MockLimits::default())))));

    // Case 1: wrong-state pasted redirect URL fails in `complete`.
    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    let proc = world.processes.list().into_iter().find(|p| p.exit.is_none()).expect("the login server process");
    let mut events = world.processes.subscribe(&proc.handle, None).expect("process events");
    let started = flows.register(&world.preset.provider, login, world.agents.settle_login(&world.preset)).expect("the flow");
    let flow_id = started["flowId"].as_str().expect("flowId").to_owned();
    assert_eq!(started["manualCodeSupported"], true);

    let err = within("the wrong-state paste", flows.complete(&flow_id, "http://localhost:1/oauth2callback?state=another&code=c")).await.unwrap_err();
    assert_eq!(err.message(), "The address is of another sign-in. Paste the address this sign-in's page ended on.");
    assert_eq!(flows.status(&flow_id).expect("status")["state"], "failed");
    within("the cancelled login server's exit", async {
        while let Some(event) = events.next().await {
            if matches!(event, ProcessEvent::Exited { .. }) {
                break;
            }
        }
    })
    .await;
    within("the staging home's removal", async {
        while !staging_homes(&world).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;

    // `_held: Starting` must have dropped so an update can acquire `begin_update`.
    let builds = builds_of(&world);
    world.registry.offer("1.5.3", ARCHIVE);
    within("the update after failed paste", world.agents.install()).await.expect("the update");
    assert_eq!(read_json(&builds.join("installed.json"))["version"], "1.5.3");

    // Case 2: non-2xx loopback delivery also cancels and releases the login session cleanly.
    let refused = tokio::spawn(async move {
        let (mut connection, _) = listener.accept().await.expect("the delivery");
        let (mut request, mut chunk) = (Vec::new(), [0_u8; 512]);
        while !request.windows(4).any(|end| end == b"\r\n\r\n") {
            match connection.read(&mut chunk).await.expect("the request") {
                0 => break,
                read => request.extend_from_slice(&chunk[..read]),
            }
        }
        connection.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.expect("the answer");
    });
    let login = within("the second sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    let proc = world.processes.list().into_iter().find(|p| p.exit.is_none()).expect("the second login server process");
    let mut events = world.processes.subscribe(&proc.handle, None).expect("process events");
    let started = flows.register(&world.preset.provider, login, world.agents.settle_login(&world.preset)).expect("the flow");
    let flow_id = started["flowId"].as_str().expect("flowId").to_owned();

    let err = within("the 400 loopback paste", flows.complete(&flow_id, "http://localhost:8085/oauth2callback?state=st-1&code=4/abc")).await.unwrap_err();
    assert!(err.message().contains("HTTP 400"), "unexpected error: {}", err.message());
    assert_eq!(flows.status(&flow_id).expect("status")["state"], "failed");
    within("the listener", refused).await.expect("the listener");
    within("the second cancelled login server's exit", async {
        while let Some(event) = events.next().await {
            if matches!(event, ProcessEvent::Exited { .. }) {
                break;
            }
        }
    })
    .await;
    within("the second staging home's removal", async {
        while !staging_homes(&world).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;

    world.registry.offer("1.5.4", ARCHIVE);
    within("the update after 400 loopback", world.agents.install()).await.expect("the update");
    assert_eq!(read_json(&builds.join("installed.json"))["version"], "1.5.4");
    flows.cancel_all();
}

/// Where the registry's build does not run (an Intel Mac) the official server is unsupported: nothing is installed or
/// started, and no other build stands in for it.
#[tokio::test]
async fn an_official_server_that_does_not_run_on_this_system_is_unsupported_and_never_installed() {
    let world = World::of(&["antigravity"], &[], |preset, _| {
        if let Distribution::Registry { supported, .. } = &mut preset.distribution {
            *supported = false;
        }
    });
    world.registry.offer("1.5.2", ARCHIVE);
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["canInstall"]), (&json!("unsupported"), &json!(false)), "{agent}");
    within("the install", world.agents.install()).await.expect("nothing to install");
    let refused = within("the refusal", world.agents.session(&thread(), &world.preset, world.cwd(), None, None)).await.err();
    assert_eq!(refused, Some(Refusal::NotReady(Readiness::Unsupported)));
    assert!(world.registry.downloads().is_empty() && world.processes.list().is_empty(), "{:?}", world.log());
}

/// With nothing it told of itself kept, a check starts the official server in a temporary folder of its own, keeps what it
/// tells, and closes it as the end of its input closes it; the next start of the app starts nothing. A server that asks
/// for a sign-in in the browser is signed out and closed at once, and a home with no sign-in is signed out with nothing
/// started.
#[tokio::test]
async fn the_official_server_is_started_for_its_state_only_where_nothing_it_told_stands() {
    let mut world = World::official(&[("FAKE_AGENT_PLAN", "Google AI Ultra")]);
    let cache = probe_cache(world.dir.path());
    #[allow(clippy::disallowed_methods, reason = "a test forgets what the server told")]
    std::fs::remove_file(&cache).expect("the kept answers");
    let agent = world.checked().await;
    assert_eq!((&agent["state"], &agent["plan"]), (&json!("ready"), &json!("Google AI Ultra")), "{agent}");
    let temp = world.server_temps().pop().expect("the probe's temporary folder");
    assert!(world.processes.list().iter().all(|process| process.exit == Some(CLOSED)), "closed by the end of its input");
    assert!(!exists(&temp) && world.logged("eof") == 1, "{:?}", world.log());
    let kept = read_json(&cache);
    assert_eq!((&kept["antigravity"]["version"], &kept["antigravity"]["plan"]), (&json!("1.5.2"), &json!("Google AI Ultra")), "{kept}");

    world.restart();
    assert_eq!(world.checked().await["state"], "ready");
    assert_eq!(world.logged("start acp"), 1, "the app's start starts no server");

    #[allow(clippy::disallowed_methods, reason = "a test leaves a credential the server no longer takes")]
    {
        std::fs::write(home_of(world.dir.path(), "antigravity").join("antigravity-acp").join("acp_token.json"), "expired").expect("the credential");
        std::fs::remove_file(&cache).expect("the kept answers");
    }
    world.restart();
    assert_eq!(world.checked().await["state"], "signedOut");
    assert_eq!(world.logged("browser sign-in"), 1);
    assert!(world.processes.list().iter().all(|process| process.exit.is_some()), "{:?}", world.log());
    assert!(world.server_temps().iter().all(|temp| !exists(temp)));

    #[allow(clippy::disallowed_methods, reason = "a test signs the home out")]
    std::fs::remove_file(home_of(world.dir.path(), "antigravity").join("antigravity-acp").join("acp_token.json")).expect("the credential");
    world.restart();
    assert_eq!(world.checked().await["state"], "signedOut");
    assert_eq!(world.logged("start acp"), 2, "a home with no sign-in starts nothing");
}

/// The official sign-in asks `authenticate` of a server of its own in a staging home and shows the page it names, with
/// no form for a code. Its success moves the sign-in into the agent's home and closes the running server, which holds
/// the account left; the next look finds the agent ready.
#[tokio::test]
async fn an_official_sign_in_runs_in_a_staging_home_and_its_success_replaces_the_running_servers_account() {
    let world = World::official(&[("FAKE_AGENT_ACCOUNT", "the new account"), ("FAKE_AGENT_AUTH_UNTIL", "signed-in-on-the-page"), ("FAKE_AGENT_LINGERS", "1")]);
    world.answer_in(&thread(), &world.cwd(), "whoami").await;
    let server = world.agents.running(&thread()).expect("the session's agent").connection.clone();

    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    let shown = login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    assert_eq!(shown, LoginState::Authorize { url: "https://accounts.example/o/oauth2/auth?state=acp".into(), manual_url: None });
    assert_eq!(login.provide(LoginInput::AuthorizationCode("a code".into())).await, Err(mixdog_core_api::domain::login::LoginError::InputNotExpected));
    assert!(!server.exited().is_cancelled() && credential_of(&world).as_deref() == Some("token"), "nothing changes before the sign-in succeeds");
    #[allow(clippy::disallowed_methods, reason = "the user signs in on the page")]
    std::fs::write(world.dir.path().join("signed-in-on-the-page"), "").expect("the sign-in");
    assert_eq!(login_state(login.as_ref(), LoginState::is_terminal).await, LoginState::Done { account: None });

    // Told done once the sign-in is the agent's: the sign-in's server, which lingers after its input ends, is still to end.
    assert_eq!(credential_of(&world).as_deref(), Some("the new account"));
    let staged =
        world.log().iter().find_map(|line| line.strip_prefix("authenticate oauth-personal GEMINI_HOME=").map(std::path::PathBuf::from)).expect("the sign-in");
    assert_ne!(staged, home_of(world.dir.path(), "antigravity"));
    assert!(exists(&staged), "the staging home goes after the sign-in's server ended");
    // The server of the account left takes no session from here and is closed.
    assert!(world.agents.running(&thread()).is_none());
    within("the old server's exit", server.exited().cancelled()).await;
    within("the staging home's removal", async {
        while !staging_homes(&world).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;

    assert_eq!(within("the sign-in's settle", (world.agents.settle_login(&world.preset))(true)).await, Ok(true));
    assert_eq!(world.agents.status()["agents"][0]["state"], "ready");
}

/// A signed-out official server's sign-in shows the agent ready as soon as the sign-in is its own, before its server,
/// signed in already, told the plan and models in a session it opens; they follow from it, and the sign-in's server is
/// the only one started.
#[tokio::test]
async fn an_official_sign_in_makes_the_agent_ready_at_once_and_its_own_server_tells_the_plan_after() {
    let models = json!([{ "modelId": "gemini-a", "name": "Gemini A" }]).to_string();
    let world = World::official(&[
        ("FAKE_AGENT_PLAN", "Google AI Ultra"),
        ("FAKE_AGENT_MODELS", &models),
        ("FAKE_AGENT_AUTH_UNTIL", "signed-in-on-the-page"),
        ("FAKE_AGENT_NEW_UNTIL", "session-opens"),
    ]);
    #[allow(clippy::disallowed_methods, reason = "the agent was never signed in")]
    {
        std::fs::remove_dir_all(home_of(world.dir.path(), "antigravity").join("antigravity-acp")).expect("the home's sign-in");
        std::fs::remove_file(probe_cache(world.dir.path())).expect("what it told");
    }
    assert_eq!(world.checked().await["state"], "signedOut");

    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    #[allow(clippy::disallowed_methods, reason = "the user signs in on the page")]
    std::fs::write(world.dir.path().join("signed-in-on-the-page"), "").expect("the sign-in");
    assert_eq!(login_state(login.as_ref(), LoginState::is_terminal).await, LoginState::Done { account: None });
    assert_eq!(within("the sign-in's settle", (world.agents.settle_login(&world.preset))(true)).await, Ok(true));

    // Ready while the sign-in's server has not opened its session yet.
    let agent = world.agents.status()["agents"][0].clone();
    assert_eq!((&agent["state"], &agent["plan"]), (&json!("ready"), &Value::Null), "{agent}");
    assert!(agent["models"].as_array().is_none_or(Vec::is_empty), "{agent}");
    let cache = probe_cache(world.dir.path());
    assert!(!exists(&cache) || read_json(&cache).get("antigravity").is_none(), "nothing is kept of the account yet");

    #[allow(clippy::disallowed_methods, reason = "the server opens its session")]
    std::fs::write(world.dir.path().join("session-opens"), "").expect("the session");
    let agent = within("the plan", async {
        loop {
            let agent = world.agents.status()["agents"][0].clone();
            if agent["plan"] == "Google AI Ultra" {
                return agent;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert_eq!((&agent["state"], &agent["models"]), (&json!("ready"), &json!([{ "id": "gemini-a", "name": "Gemini A" }])));
    assert_eq!(read_json(&probe_cache(world.dir.path()))["antigravity"]["plan"], "Google AI Ultra");
    within("the staging home's removal", async {
        while !staging_homes(&world).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert_eq!(world.logged("start acp"), 1, "only the sign-in's server: {:?}", world.log());
}

/// A cancelled or failed official sign-in leaves the agent's home and its running server as they were, and its staging
/// home goes.
#[tokio::test]
async fn a_cancelled_or_failed_official_sign_in_leaves_the_agents_home_and_server_as_they_were() {
    let world = World::official(&[("FAKE_AGENT_AUTH_HANGS", "1")]);
    world.answer_in(&thread(), &world.cwd(), "whoami").await;
    let server = world.agents.running(&thread()).expect("the session's agent").connection.clone();
    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    login.cancel();
    assert_eq!(login_state(login.as_ref(), LoginState::is_terminal).await, LoginState::Cancelled);
    within("the staging home's removal", async {
        while !staging_homes(&world).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(!server.exited().is_cancelled() && world.agents.running(&thread()).is_some());
    assert_eq!(credential_of(&world).as_deref(), Some("token"));

    let failing = World::official(&[("FAKE_AGENT_AUTH_FAILS", "the browser was closed")]);
    let login = within("the sign-in's start", failing.agents.begin_login(&failing.preset)).await.expect("the sign-in starts");
    let ended = login_state(login.as_ref(), LoginState::is_terminal).await;
    assert_eq!(ended, LoginState::Failed(LoginFailure::Failed { code: "agentLogin".into(), message: "the browser was closed".into() }));
    within("the staging home's removal", async {
        while !staging_homes(&failing).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert_eq!(credential_of(&failing).as_deref(), Some("token"));
}

/// The official server is signed out with `logout` on its running server, which is then closed, or on one started for it
/// in a temporary folder of its own; its sign-in leaves its home and what it told of the account is forgotten. Only the
/// CLI's sign-out is the vendor's sign-in outside Mixdog, and only the official server opens its page itself.
#[tokio::test]
async fn the_official_server_signs_out_with_logout_on_its_running_server_or_a_short_lived_one() {
    let world = World::official(&[]);
    assert_eq!(world.checked().await["canSignOut"], true);
    world.answer_in(&thread(), &world.cwd(), "whoami").await;
    let server = world.agents.running(&thread()).expect("the session's agent").connection.clone();
    assert_eq!(within("the sign-out", world.agents.sign_out(&world.preset)).await, Ok(()));
    assert_eq!((world.logged("logout"), world.logged("start acp")), (1, 1), "{:?}", world.log());
    assert_eq!(world.exit_of(server.handle()), Some(CLOSED));
    assert_eq!(credential_of(&world), None);
    assert!(read_json(&probe_cache(world.dir.path())).get("antigravity").is_none());
    assert_eq!(world.agents.status()["agents"][0]["state"], "signedOut");

    let idle = World::official(&[]);
    assert_eq!(idle.checked().await["state"], "ready");
    assert_eq!(within("the sign-out", idle.agents.sign_out(&idle.preset)).await, Ok(()));
    assert_eq!((idle.logged("logout"), idle.server_temps().len()), (1, 1), "{:?}", idle.log());
    assert!(idle.processes.list().iter().all(|process| process.exit == Some(CLOSED)));
    assert!(idle.server_temps().iter().all(|temp| !exists(temp)));
    assert_eq!(idle.agents.status()["agents"][0]["state"], "signedOut");

    let both = World::of(&["antigravity", "antigravity-cli"], &[], |_, _| {});
    both.checked().await;
    within("the CLI's check", both.agents.look(&both.presets[1])).await;
    let status = both.agents.status();
    let flags = |agent: &Value| (agent["loginOpensBrowser"].clone(), agent["sharesExternalSignIn"].clone());
    assert_eq!(
        (flags(&status["agents"][0]), flags(&status["agents"][1])),
        ((json!(false), json!(false)), (json!(cfg!(windows) || cfg!(target_os = "macos")), json!(true)))
    );
}

/// A sign-out asked while one of the same agent is under way (a second window, a second press) is refused at once: the
/// server is asked to log out once, and the sign-out under way ends as it would alone.
#[tokio::test]
async fn a_sign_out_asked_while_one_is_under_way_is_refused_and_the_server_logs_out_once() {
    let world = World::official(&[]);
    assert_eq!(world.checked().await["state"], "ready");

    let (first, second) = within("both sign-outs", async { tokio::join!(world.agents.sign_out(&world.preset), world.agents.sign_out(&world.preset)) }).await;

    assert_eq!(first, Ok(()));
    assert_eq!(second, Err("Antigravity is already signing out.".to_owned()));
    assert_eq!(world.logged("logout"), 1, "{:?}", world.log());
    assert_eq!(world.agents.status()["agents"][0]["state"], "signedOut");
}

/// The app's stop waits for a server whose retirement began before it, closed by the end of its input with nothing it
/// unpacked left, and no server starts once the stop began.
#[tokio::test]
async fn the_apps_stop_waits_for_a_retiring_server_and_no_server_starts_after_it() {
    let world = World::official(&[]);
    let keeper = ThreadId::from("sess_keeper");
    world.answer_in(&keeper, &world.cwd(), "whoami").await;
    let server = world.agents.running(&keeper).expect("the keeper's agent").connection.clone();
    for n in 0..4 {
        let thread = ThreadId::from(format!("sess_{n}"));
        world.answer_in(&thread, &world.cwd(), "whoami").await;
        world.agents.release(&thread);
    }
    let temp = world.server_temps().pop().expect("the server's temporary folder");
    // The last session leaves it: its retirement begins in a task of its own.
    world.agents.release(&keeper);
    within("the stop", world.agents.shutdown()).await;
    assert_eq!(world.exit_of(server.handle()), Some(CLOSED));
    assert!(!exists(&temp), "{temp:?}");

    let started = world.server_temps().len();
    let late = within("a start after the stop", world.agents.session(&ThreadId::from("sess_late"), &world.preset, world.cwd(), None, None)).await;
    assert!(matches!(late, Err(Refusal::Closed)));
    assert_eq!(world.server_temps().len(), started, "{:?}", world.log());
    assert!(world.server_temps().iter().all(|temp| !exists(temp)), "{:?}", world.log());
}

/// A route that leaves the official preset while a turn runs (the switch takes effect at the next turn) does not cut the
/// turn off: the session ends once the turn is over. A session taken off the server with its prompt open has that prompt
/// cancelled there.
#[tokio::test]
async fn a_route_switch_during_a_turn_ends_the_session_after_it_and_a_detached_prompt_is_cancelled() {
    let world = World::of(&["antigravity", "antigravity-cli"], &[], |_, _| {});
    let writer = AgentRouteWriter { inner: Arc::new(Routes::default()), agents: world.agents.clone() };
    let route = json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-5-5" }).as_object().cloned().expect("a route");
    let (working, stop) = (Surface::default(), CancellationToken::new());
    let thread = thread();
    let hanging = world.prompt(&thread, &working, "hang", None, stop.clone());
    let switch = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        writer.set_route_state(&thread, route.clone());
        let session = world.agents.running(&thread).expect("the session stays for its turn");
        assert!(!session.gone().is_cancelled());
        stop.cancel();
        session
    };
    let (end, session) = within("the turn", async { tokio::join!(hanging, switch) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    within("the session's end", session.gone().cancelled()).await;

    // On a shared server that supports `session/close`, a session that stays keeps it running while B's session is
    // taken off it mid-prompt.
    let shared = World::build(&[], |preset, _| preset.scope = mixdog_acp::preset::ProcessScope::Shared);
    let (keeper, other) = (ThreadId::from("sess_keeper"), ThreadId::from("sess_b"));
    assert!(shared.answer_in(&keeper, &shared.cwd(), "whoami").await.starts_with("session=sess-1"));
    let surface = Surface::default();
    let cwd = shared.cwd();
    let hanging = shared.prompt_in(&other, &cwd, &surface, "hang", None, CancellationToken::new());
    let release = async {
        surface.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        shared.agents.release(&other);
    };
    let (end, ()) = within("the released turn", async { tokio::join!(hanging, release) }).await;
    assert!(matches!(end, TurnEnd::Failed { .. }), "{end:?}");
    // Only the official server logs a method again with its session's id; B's is the one prompt open here.
    shared.logs("session/cancel").await;
    assert!(shared.answer_in(&keeper, &shared.cwd(), "whoami").await.starts_with("session=sess-1"), "the server serves the keeper on");
}

/// A turn whose call of a Mixdog tool waits on its approval card ends at once when its session leaves the shared server:
/// the call gets its row, and nothing waits for the agent's deadline.
#[tokio::test]
async fn a_turn_whose_mixdog_call_waits_on_its_card_ends_when_its_session_leaves_the_shared_server() {
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    surface.0.holds_asks.store(true, Ordering::SeqCst);
    let thread = thread();
    let calling = world.prompt_with(&thread, &surface, r#"tool shell {"command":"ls"}"#, None, CancellationToken::new(), Some(tools.calls(&surface)));
    let release = async {
        while surface.0.asks.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        world.agents.release(&thread);
    };
    let (end, ()) = within("the turn's end", async { tokio::join!(calling, release) }).await;
    assert!(matches!(&end, TurnEnd::Failed { message, .. } if message == "The agent's session was closed."), "{end:?}");
    let rows = surface.rows();
    assert!(rows.iter().any(|row| row["content"] == "The agent's session ended before this call did."), "{rows:?}");
}

/// A session taken off a surviving shared server while the server's question about one of its calls is open has that
/// question answered (cancelled): the server goes on serving the others.
#[tokio::test]
async fn a_question_of_a_session_taken_off_the_shared_server_is_answered_cancelled() {
    let world = World::build(&[], |preset, _| preset.scope = mixdog_acp::preset::ProcessScope::Shared);
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    let in_b = world.folder("b");
    assert!(world.answer_in(&b, &in_b, "whoami").await.starts_with("session=sess-1"));
    let surface = Surface::default();
    surface.0.holds_asks.store(true, Ordering::SeqCst);
    let cwd = world.cwd();
    let asking = world.prompt_in(&a, &cwd, &surface, "permission", None, CancellationToken::new());
    let release = async {
        while surface.0.asks.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        world.agents.release(&a);
    };
    let (end, ()) = within("the turn's end", async { tokio::join!(asking, release) }).await;
    assert!(matches!(end, TurnEnd::Failed { .. }), "{end:?}");
    world.logs("permission answered sess-2 cancelled").await;
    assert!(world.answer_in(&b, &in_b, "whoami").await.starts_with("session=sess-1"), "the server serves B on");
}

/// A build is not replaced while a server of it is still ending or a sign-in runs on it, and the daemon's start clears
/// away the builds that are not the installed one and the staging homes of sign-ins that did not end.
#[tokio::test]
async fn a_build_is_not_replaced_while_a_process_of_it_still_runs_and_the_start_sweeps_what_updates_left() {
    let world = World::official(&[("FAKE_AGENT_LINGERS", "1"), ("FAKE_AGENT_AUTH_HANGS", "1")]);
    #[allow(clippy::disallowed_methods, reason = "the fake names the version of the build it was unpacked as")]
    std::fs::write(world.dir.path().join("version"), "1.5.3").expect("the fake's version");
    world.registry.offer("1.5.3", ARCHIVE);

    // A sign-in runs on the build.
    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    world.checked().await;
    assert!(world.registry.downloads().is_empty(), "no update under a sign-in");
    login.cancel();
    within("the sign-in's end", async {
        while !staging_homes(&world).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;

    // A server of the build is still ending (it lingers after its input ended, until its grace is over).
    world.answer_in(&thread(), &world.cwd(), "whoami").await;
    world.agents.release_all();
    world.checked().await;
    assert!(world.registry.downloads().is_empty(), "no update under a server that is still ending");
    within("the update once nothing of the build runs", async {
        while world.registry.downloads().is_empty() {
            world.checked().await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    assert_eq!(world.agents.status()["agents"][0]["version"], "1.5.3");

    let builds = builds_of(&world);
    let homes = world.dir.path().join("acp-agents").join("homes");
    #[allow(clippy::disallowed_methods, reason = "a test leaves what earlier runs left")]
    for left in [builds.join("1.5.1"), builds.join(".staging-left"), homes.join("antigravity.login-left")] {
        std::fs::create_dir_all(left.join("inside")).expect("a folder left behind");
    }
    within("the sweep", world.agents.sweep_leftovers()).await;
    assert!(!exists(&builds.join("1.5.1")) && !exists(&builds.join(".staging-left")) && !exists(&homes.join("antigravity.login-left")));
    assert!(exists(&builds.join("1.5.3")) && exists(&homes.join("antigravity")), "the installed build and the agent's home stay");
}

/// A turn that finds the official server signed out forgets what it told of itself on disk too: the next start of the app
/// does not read it ready from what it told before, and starts it to learn its state.
#[tokio::test]
async fn a_turn_that_finds_the_official_server_signed_out_forgets_what_it_told_across_a_restart() {
    let mut world = World::official(&[]);
    assert_eq!(world.checked().await["state"], "ready");
    let home = home_of(world.dir.path(), "antigravity").join("antigravity-acp");
    #[allow(clippy::disallowed_methods, reason = "the server's sign-in is gone, as the user left it outside the app")]
    std::fs::remove_dir_all(&home).expect("the home's sign-in");
    let end = world.ask(&Surface::default(), "hello", Turns::default()).await;
    assert!(matches!(end, TurnEnd::Failed { code: Some(-32000), .. }), "{end:?}");
    assert!(read_json(&probe_cache(world.dir.path())).get("antigravity").is_none());

    sign_in_home(world.dir.path(), "antigravity");
    world.restart();
    assert_eq!(world.checked().await["state"], "ready");
    assert_eq!(world.logged("start acp"), 2, "the turn's server, then a start to learn its state: {:?}", world.log());
}

/// The app's stop while the shared server starts: the opens waiting for it are refused once it started, it is closed, and
/// the stop waits for it.
#[tokio::test]
async fn the_apps_stop_during_a_servers_start_refuses_its_waiters_and_waits_for_it() {
    let world = World::official(&[("FAKE_AGENT_SLOW_START", "1500")]);
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    let opens = async {
        tokio::join!(world.agents.session(&a, &world.preset, world.cwd(), None, None), world.agents.session(&b, &world.preset, world.cwd(), None, None))
    };
    let stop = async {
        world.logs("start acp").await;
        world.agents.shutdown().await;
    };
    let ((opened_a, opened_b), ()) = within("the opens and the stop", async { tokio::join!(opens, stop) }).await;
    assert!(matches!(opened_a, Err(Refusal::Fault(_))) && matches!(opened_b, Err(Refusal::Fault(_))));
    assert!(world.processes.list().iter().all(|process| process.exit == Some(CLOSED)), "{:?}", world.log());
    assert_eq!(world.logged("start acp"), 1);
    assert!(world.server_temps().iter().all(|temp| !exists(temp)));
}

/// A sign-in that hands over while the shared server still starts takes that server out of use: the open that waited for
/// it opens on a new server, not on the one of the account left.
#[tokio::test]
async fn an_open_waiting_for_a_server_retired_by_a_sign_in_opens_on_a_new_server() {
    let world =
        World::official(&[("FAKE_AGENT_SLOW_START", "1500"), ("FAKE_AGENT_ACCOUNT", "the new account"), ("FAKE_AGENT_AUTH_UNTIL", "signed-in-on-the-page")]);
    let login = within("the sign-in's start", world.agents.begin_login(&world.preset)).await.expect("the sign-in starts");
    login_state(login.as_ref(), |state| matches!(state, LoginState::Authorize { .. })).await;
    let thread = thread();
    let opening = world.agents.session(&thread, &world.preset, world.cwd(), None, None);
    let hand_over = async {
        within("the server's start", async {
            while world.logged("start acp") < 2 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        #[allow(clippy::disallowed_methods, reason = "the user signs in on the page")]
        std::fs::write(world.dir.path().join("signed-in-on-the-page"), "").expect("the sign-in");
        login_state(login.as_ref(), LoginState::is_terminal).await
    };
    let (opened, signed_in) = within("the open and the sign-in", async { tokio::join!(opening, hand_over) }).await;
    assert_eq!(signed_in, LoginState::Done { account: None });
    let session = opened.unwrap_or_else(|refusal| panic!("the open is refused: {refusal:?}"));
    assert!(!session.connection.exited().is_cancelled());
    assert_eq!(world.logged("start acp"), 3, "the sign-in's server, the server retired while it started, a new one: {:?}", world.log());
}

/// A turn waiting on an approval card ends when its session leaves the shared server, instead of waiting on the card.
#[tokio::test]
async fn a_turn_waiting_on_an_approval_card_ends_when_its_session_leaves_the_shared_server() {
    let world = World::official(&[]);
    let surface = Surface::default();
    surface.0.holds_asks.store(true, Ordering::SeqCst);
    let thread = thread();
    let asking = world.prompt(&thread, &surface, "permission", None, CancellationToken::new());
    let release = async {
        while surface.0.asks.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        world.agents.release(&thread);
    };
    let (end, ()) = within("the turn's end", async { tokio::join!(asking, release) }).await;
    assert!(matches!(&end, TurnEnd::Failed { message, .. } if message == "The agent's session was closed."), "{end:?}");
}

/// Stopping a turn whose ACP agent never answers `session/cancel` ends the turn promptly and lets the next turn
/// recover after a bounded grace on both per-session (`antigravity-cli`) and shared-server (`antigravity`) agents,
/// leaving other threads on the shared server untouched.
#[tokio::test]
async fn unanswered_session_cancel_ends_turn_promptly_and_recovers_next_turn() {
    let per_session = World::new(&[("FAKE_AGENT_SILENT_CANCEL", "1")]);
    per_session.agents.set_cancel_close_grace(Duration::from_millis(150));
    let end = per_session.hang_until_stopped(&Surface::default()).await;
    assert_eq!(end, TurnEnd::Interrupted);
    let stuck = per_session.agents.running(&thread()).expect("stuck session").connection.handle().clone();
    let recovered = within("per-session recovery", per_session.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    assert!(completed_text(&recovered).starts_with("session=sess-1"), "{recovered:?}");
    let fresh = per_session.agents.running(&thread()).expect("fresh session").connection.handle().clone();
    assert_ne!(fresh, stuck, "stuck child process replaced after cancel grace");
    // Three processes ran in ACP mode: the CLI readiness check, the stuck session, and its replacement.
    assert_eq!(per_session.logged("start acp"), 3, "stuck child process replaced after cancel grace: {:?}", per_session.log());

    let shared = World::build(&[("FAKE_AGENT_SILENT_CANCEL", "1")], |preset, _| preset.scope = mixdog_acp::preset::ProcessScope::Shared);
    shared.agents.set_cancel_close_grace(Duration::from_millis(150));
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    let cwd = shared.cwd();
    assert!(shared.answer_in(&b, &cwd, "whoami").await.starts_with("session=sess-1"));

    let (working, stop) = (Surface::default(), CancellationToken::new());
    let hanging = shared.prompt_in(&a, &cwd, &working, "hang", None, stop.clone());
    let cancel_a = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        stop.cancel();
    };
    let (ended, ()) = within("shared cancel", async { tokio::join!(hanging, cancel_a) }).await;
    assert_eq!(ended, TurnEnd::Interrupted);

    // Passing the stuck session id as stored must still open a fresh session on the shared server instead of hanging
    // or reattaching to the unanswered prompt, while thread B keeps its session on the same server.
    let recovered_a = within("shared recovery", shared.prompt_in(&a, &cwd, &Surface::default(), "whoami", Some("sess-2"), CancellationToken::new())).await;
    let text_a = completed_text(&recovered_a);
    assert!(text_a.starts_with("session=sess-3 resumed=false"), "{text_a:?}");
    assert!(shared.answer_in(&b, &cwd, "whoami").await.starts_with("session=sess-1"));
    assert_eq!(shared.logged("start acp"), 2, "probe plus one shared server kept alive for thread B: {:?}", shared.log());
}

/// A queued mid-turn user message reaches the running ACP agent at its next Mixdog tool-call boundary exactly once,
/// and stays queued untouched when a turn makes no Mixdog tool call.
#[tokio::test]
async fn mid_turn_user_steer_delivers_at_mixdog_tool_boundary_and_otherwise_waits() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-user-1")],
        content: Content::Text("pivot to plan B".into()),
        task_notification: false,
    });

    let first = tools.prompt(&world, &surface, r#"tool read {"path":"a.txt"}"#).await;
    let first_text = completed_text(&first);
    assert!(first_text.contains(r#"read ran with {"path":"a.txt"}"#), "{first_text:?}");
    assert!(first_text.contains("[User message received while you were working]\npivot to plan B"), "{first_text:?}");
    assert_eq!(surface.0.steer_peeks.load(Ordering::SeqCst), 1);
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 1);
    assert_eq!(*surface.0.committed_steers.lock().unwrap(), vec![QueuedId::from("q-user-1")]);
    assert!(surface.0.steers.lock().unwrap().is_empty(), "steered message committed once");

    // A later tool call with nothing queued receives no duplicate copy.
    let second = tools.prompt(&world, &surface, r#"tool read {"path":"b.txt"}"#).await;
    assert!(!completed_text(&second).contains("pivot to plan B"), "{second:?}");

    // With no Mixdog tool call in the turn, peek_steers is not called and the queued message stays for the next turn.
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-user-2")],
        content: Content::Text("next turn prompt".into()),
        task_notification: false,
    });
    let peeks_before = surface.0.steer_peeks.load(Ordering::SeqCst);
    let commits_before = surface.0.steer_commits.load(Ordering::SeqCst);
    let plain = tools.prompt(&world, &surface, "whoami").await;
    assert!(completed_text(&plain).starts_with("session="), "{plain:?}");
    assert_eq!(surface.0.steer_peeks.load(Ordering::SeqCst), peeks_before);
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), commits_before);
    assert_eq!(surface.0.steers.lock().unwrap().len(), 1, "uncommitted message remains queued for the next turn");
}

/// A queued `<task-notification>` reaches the running ACP agent verbatim at its next Mixdog tool-call boundary on a
/// shared-server session, and stays queued untouched when a turn makes no Mixdog tool call.
#[tokio::test]
async fn mid_turn_task_notification_delivers_at_mixdog_tool_boundary_and_otherwise_waits() {
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    let notice = "<task-notification>\n<task-id>bg_1</task-id>\n<status>completed</status>\n<summary>worker done</summary>\n</task-notification>";
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-task-1")],
        content: Content::Text(notice.into()),
        task_notification: true,
    });

    let delivered = tools.prompt(&world, &surface, r#"tool read {"path":"a.txt"}"#).await;
    let text = completed_text(&delivered);
    assert!(text.contains(r#"read ran with {"path":"a.txt"}"#), "{text:?}");
    assert!(text.contains(notice), "{text:?}");
    assert!(!text.contains("[User message received while you were working]"), "task notifications are not wrapped as typed user messages: {text:?}");
    assert_eq!(surface.0.steer_peeks.load(Ordering::SeqCst), 1);
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 1);
    assert!(surface.0.steers.lock().unwrap().is_empty(), "notification committed once");

    // With no Mixdog tool call in the turn, the notification remains queued for the next turn.
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-task-2")],
        content: Content::Text(notice.into()),
        task_notification: true,
    });
    let plain = tools.prompt(&world, &surface, "whoami").await;
    assert!(completed_text(&plain).starts_with("session="), "{plain:?}");
    assert_eq!(surface.0.steer_peeks.load(Ordering::SeqCst), 1);
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 1);
    assert_eq!(surface.0.steers.lock().unwrap().len(), 1, "uncommitted notification remains queued for the next turn");
}

/// Mid-turn steers resolve `AttachmentRef` images and offloaded text pastes through the turn's real attachment store,
/// and a Stop racing attachment resolution leaves the queued steer uncommitted for the next turn.
#[tokio::test]
async fn mid_turn_steer_resolves_attachment_refs_and_preserves_uncommitted_steers_on_stop() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-attach-1")],
        content: Content::Parts(vec![
            ContentPart::Text("inspect these".into(), None),
            ContentPart::File {
                source: BinarySource::AttachmentRef("note".into()),
                mime_type: "text/plain".into(),
                filename: Some("paste.txt".into()),
                text: None,
            },
            ContentPart::File {
                source: BinarySource::AttachmentRef("stored".into()),
                mime_type: "image/png".into(),
                filename: Some("shot.png".into()),
                text: None,
            },
        ]),
        task_notification: false,
    });
    let delivered = within(
        "steered attachments",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": r#"tool read {"path":"a.txt"}"# }),
            None,
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns { calls: Some(tools.calls(&surface)), ..Turns::default() },
        ),
    )
    .await;
    let text = completed_text(&delivered);
    assert!(text.contains("[Attached file: paste.txt]\n# Notes\nplover"), "offloaded paste resolved: {text:?}");
    assert!(text.contains("images=1"), "attached image resolved: {text:?}");
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 1);
    assert!(surface.0.steers.lock().unwrap().is_empty());

    // If Stop fires while attachment resolution is running, the steer is not committed and stays queued.
    let stop = CancellationToken::new();
    let surface = Surface::default();
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-attach-stop")],
        content: Content::Parts(vec![ContentPart::File {
            source: BinarySource::AttachmentRef("stop".into()),
            mime_type: "text/plain".into(),
            filename: Some("late.txt".into()),
            text: None,
        }]),
        task_notification: false,
    });
    let interrupted = within(
        "stop during steer attachment resolution",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": r#"tool read {"path":"b.txt"}"# }),
            None,
            Some("RULES"),
            "default",
            stop.clone(),
            Turns { calls: Some(tools.calls(&surface)), stops_sending: Some(stop), ..Turns::default() },
        ),
    )
    .await;
    assert_eq!(interrupted, TurnEnd::Interrupted);
    assert_eq!(surface.0.steer_peeks.load(Ordering::SeqCst), 1);
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 0, "cancelled steer must not commit");
    assert_eq!(surface.0.steers.lock().unwrap().len(), 1, "cancelled steer remains queued");
}

/// If `stop_submissions` removes a queued steer during async attachment resolution without cancelling the active turn,
/// `deliver_answer` claims before sending so the stopped submission is never delivered to the ACP agent, while any
/// surviving steer is still claimed, recorded, and delivered.
#[tokio::test]
async fn stopped_submission_during_steer_attachment_resolution_is_never_delivered() {
    let (world, tools) = handing(&[]);

    // Case 1: The only queued steer is stopped while its attachment is being read; the active turn stays alive.
    let surface = Surface::default();
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-stopped-only")],
        content: Content::Parts(vec![
            ContentPart::Text("stopped steer text".into(), None),
            ContentPart::File {
                source: BinarySource::AttachmentRef("note".into()),
                mime_type: "text/plain".into(),
                filename: Some("paste.txt".into()),
                text: None,
            },
        ]),
        task_notification: false,
    });
    let surface_for_stop = surface.0.clone();
    let stop_only = Arc::new(move |reference: &str| {
        if reference == "note" {
            surface_for_stop.steers.lock().unwrap().retain(|steer| !steer.queued_ids.iter().any(|id| id.as_str() == "q-stopped-only"));
        }
    });
    let only_stopped = within(
        "stopped sole steer during attachment resolution",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": r#"tool read {"path":"a.txt"}"# }),
            None,
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns { calls: Some(tools.calls(&surface)), on_attachment_read: Some(stop_only), ..Turns::default() },
        ),
    )
    .await;
    let only_text = completed_text(&only_stopped);
    assert!(only_text.contains(r#"read ran with {"path":"a.txt"}"#), "{only_text:?}");
    assert!(!only_text.contains("stopped steer text"), "stopped steer must never reach agent: {only_text:?}");
    assert!(!only_text.contains("plover"), "stopped steer attachment must never reach agent: {only_text:?}");
    assert!(surface.0.committed_steers.lock().unwrap().is_empty(), "stopped steer must not be committed");

    // Case 2: Two steers are peeked; the first is stopped during attachment resolution while the second survives.
    let surface = Surface::default();
    {
        let mut queue = surface.0.steers.lock().unwrap();
        queue.push_back(SteerDelivery {
            queued_ids: vec![QueuedId::from("q-stopped-first")],
            content: Content::Parts(vec![
                ContentPart::Text("dropped first steer".into(), None),
                ContentPart::File {
                    source: BinarySource::AttachmentRef("note".into()),
                    mime_type: "text/plain".into(),
                    filename: Some("paste.txt".into()),
                    text: None,
                },
            ]),
            task_notification: false,
        });
        queue.push_back(SteerDelivery {
            queued_ids: vec![QueuedId::from("q-surviving-second")],
            content: Content::Text("surviving second steer".into()),
            task_notification: false,
        });
    }
    let surface_for_partial = surface.0.clone();
    let stop_first = Arc::new(move |reference: &str| {
        if reference == "note" {
            surface_for_partial.steers.lock().unwrap().retain(|steer| !steer.queued_ids.iter().any(|id| id.as_str() == "q-stopped-first"));
        }
    });
    let partial = within(
        "partial stop during steer attachment resolution",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": r#"tool read {"path":"b.txt"}"# }),
            None,
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns { calls: Some(tools.calls(&surface)), on_attachment_read: Some(stop_first), ..Turns::default() },
        ),
    )
    .await;
    let partial_text = completed_text(&partial);
    assert!(partial_text.contains(r#"read ran with {"path":"b.txt"}"#), "{partial_text:?}");
    assert!(!partial_text.contains("dropped first steer"), "stopped first steer must not reach agent: {partial_text:?}");
    assert!(!partial_text.contains("plover"), "stopped first steer attachment must not reach agent: {partial_text:?}");
    assert!(partial_text.contains("surviving second steer"), "surviving steer must reach agent: {partial_text:?}");
    assert_eq!(*surface.0.committed_steers.lock().unwrap(), vec![QueuedId::from("q-surviving-second")]);
}

/// On a shared server, dropping a stuck cancelled session after `cancel_close_grace` and stopping during post-open
/// `hand_over()` invalidates `SESSION_KEY` in the header and prevents the next turn from reattaching to the stuck session.
#[tokio::test]
async fn shared_server_invalidates_stored_session_key_on_cancel_grace_and_post_open_stop() {
    let world = World::build(&[("FAKE_AGENT_SILENT_CANCEL", "1")], |preset, _| preset.scope = mixdog_acp::preset::ProcessScope::Shared);
    world.agents.set_cancel_close_grace(Duration::from_millis(150));
    let other = ThreadId::from("sess_b");
    let cwd = world.cwd();
    assert!(world.answer_in(&other, &cwd, "whoami").await.starts_with("session=sess-1"));

    // Thread's turn hangs and is stopped while the agent ignores `session/cancel` (stuck on sess-2).
    let (working, stop) = (Surface::default(), CancellationToken::new());
    let hanging = world.serve_with(&working, json!({ "role": "user", "content": "hang" }), None, Some("RULES"), "default", stop.clone(), Turns::default());
    let cancel_turn = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        stop.cancel();
    };
    let (ended, ()) = within("shared hang cancel", async { tokio::join!(hanging, cancel_turn) }).await;
    assert_eq!(ended, TurnEnd::Interrupted);

    // Next turn drops stuck sess-2 after grace, opens a fresh session, and is stopped during hand_over() before
    // `SESSION_KEY` can be updated: `SESSION_KEY` must be unset in the header.
    let stop_handover = CancellationToken::new();
    let surface = Surface::default();
    let interrupted = within(
        "post-open hand_over stop",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": "whoami" }),
            Some(held("sess-2")),
            Some("RULES"),
            "default",
            stop_handover.clone(),
            Turns { stops_summary: Some(stop_handover), ..Turns::default() },
        ),
    )
    .await;
    assert_eq!(interrupted, TurnEnd::Interrupted);
    let unset_session = surface.events().into_iter().any(|event| matches!(event, Event::Header(change) if change.unset.iter().any(|k| k == SESSION_KEY)));
    assert!(unset_session, "expected SESSION_KEY unset header change, got {:?}", surface.events());

    // Even if a subsequent turn still supplies stale `sess-2`, the abandoned session is skipped and a fresh session opens.
    let recovered = within(
        "fresh session after abandoned sess-2",
        world.serve_with(
            &Surface::default(),
            json!({ "role": "user", "content": "whoami" }),
            Some(held("sess-2")),
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns::default(),
        ),
    )
    .await;
    let text = completed_text(&recovered);
    assert!(text.contains("resumed=false"), "must not reattach to abandoned sess-2: {text:?}");
    assert!(!text.contains("session=sess-2"), "must not reuse sess-2: {text:?}");
    assert!(world.answer_in(&other, &cwd, "whoami").await.starts_with("session=sess-1"));
}

/// Agent-initiated wake turns (`Ask::Reply`) populate `TurnContext::attachments` from `TurnRequest::attachments`,
/// so mid-turn steer attachments (offloaded pastes and images) resolve at Mixdog tool-call boundaries on wake turns.
#[tokio::test]
async fn wake_turn_tool_call_resolves_steer_attachments_from_request() {
    use http_body_util::BodyExt;
    use http_body_util::Full;
    use hyper_util::rt::TokioIo;

    let (world, tools) = handing(&[]);
    let servers_end = tools.prompt(&world, &Surface::default(), "servers").await;
    let servers_text = completed_text(&servers_end);
    let servers_json = servers_text.strip_prefix("servers=").expect("servers json prefix");
    let servers: Value = serde_json::from_str(servers_json).expect("servers json");
    let url = servers[0]["url"].as_str().expect("mcp server url").to_owned();
    let auth = servers[0]["headers"][0]["value"].as_str().expect("mcp bearer auth").to_owned();
    let addr = url.strip_prefix("http://").and_then(|rest| rest.split('/').next()).expect("loopback host:port").to_owned();

    // Trigger an agent-initiated wake via `selfask`, which opens a wake turn paused on `surface.approve`.
    within("selfask turn", world.prompt(&thread(), &Surface::default(), "selfask", None, CancellationToken::new())).await;
    world.wakes(1).await;

    let surface = Surface::default();
    let (approve_tx, approve_rx) = tokio::sync::oneshot::channel();
    *surface.0.approve_gate.lock().unwrap() = Some(approve_rx);
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-wake-attach")],
        content: Content::Parts(vec![
            ContentPart::Text("wake steer".into(), None),
            ContentPart::File {
                source: BinarySource::AttachmentRef("note".into()),
                mime_type: "text/plain".into(),
                filename: Some("paste.txt".into()),
                text: None,
            },
            ContentPart::File {
                source: BinarySource::AttachmentRef("stored".into()),
                mime_type: "image/png".into(),
                filename: Some("shot.png".into()),
                text: None,
            },
        ]),
        task_notification: false,
    });

    let wake_input = json!({ "role": "user", "content": WAKE_TEXT, "meta": { "source": "task-notification" } });
    let wake_fut = world.serve_with(
        &surface,
        wake_input,
        None,
        Some("RULES"),
        "default",
        CancellationToken::new(),
        Turns { calls: Some(tools.calls(&surface)), ..Turns::default() },
    );
    let drive_mcp = async {
        // Wait until the wake turn is attached and paused in `approve`.
        surface.until(|_| !surface.0.asks.lock().unwrap().is_empty()).await;
        let stream = tokio::net::TcpStream::connect(&addr).await.expect("connect mcp server");
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.expect("http1 handshake");
        let conn_task = tokio::spawn(async move {
            let _ = conn.await;
        });
        let body = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": { "name": "read", "arguments": { "path": "a.txt" } }
        })
        .to_string();
        let req = hyper::Request::builder()
            .method(hyper::Method::POST)
            .uri("/mcp")
            .header(hyper::header::HOST, &addr)
            .header(hyper::header::AUTHORIZATION, &auth)
            .header(hyper::header::CONTENT_TYPE, "application/json")
            .body(Full::new(bytes::Bytes::from(body)))
            .expect("mcp request");
        let response_fut = tokio::spawn(async move {
            let resp = sender.send_request(req).await.expect("mcp response");
            let collected = resp.into_body().collect().await.expect("mcp body").to_bytes();
            serde_json::from_slice::<Value>(&collected).expect("mcp json")
        });
        // Give the loopback HTTP request a moment to queue `Incoming::Tool` into the active wake turn, then release `approve`.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = approve_tx.send(ApprovalResolution::Unavailable { at: 0 });
        let reply = response_fut.await.expect("mcp reply");
        conn_task.abort();
        reply
    };
    let (_wake_end, mcp_reply) = within("wake turn with mcp tool call", async { tokio::join!(wake_fut, drive_mcp) }).await;
    let content = mcp_reply["result"]["content"].as_array().expect("tool result content blocks");
    let texts: Vec<&str> = content.iter().filter_map(|block| block.get("text").and_then(Value::as_str)).collect();
    let has_paste = texts.iter().any(|text| text.contains("[Attached file: paste.txt]\n# Notes\nplover"));
    let has_image = content.iter().any(|block| block["type"] == "image" && block["mimeType"] == "image/png" && block["data"] == "cG5n");
    assert!(has_paste, "wake turn must resolve offloaded paste attachment from request: {content:?}");
    assert!(has_image, "wake turn must resolve image attachment from request: {content:?}");
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 1);
    assert!(surface.0.steers.lock().unwrap().is_empty());
}

/// Partial steer claims assemble the tool answer from already-resolved per-steer blocks without re-reading
/// attachments after `commit_steers`, and a turn stop racing `commit_steers` prevents delivering the steered answer.
#[tokio::test]
async fn partial_steer_claim_reuses_resolved_attachments_without_re_reading_and_respects_cancel_before_send() {
    let (world, tools) = handing(&[]);

    // Case 1: Two steers with attachments are peeked; the first is stopped during resolution while the second survives.
    // The surviving steer's attachment must be read once (pre-commit), never a second time after `commit_steers`.
    let surface = Surface::default();
    {
        let mut queue = surface.0.steers.lock().unwrap();
        queue.push_back(SteerDelivery {
            queued_ids: vec![QueuedId::from("q-drop-1")],
            content: Content::Parts(vec![
                ContentPart::Text("dropped first".into(), None),
                ContentPart::File {
                    source: BinarySource::AttachmentRef("note".into()),
                    mime_type: "text/plain".into(),
                    filename: Some("paste.txt".into()),
                    text: None,
                },
            ]),
            task_notification: false,
        });
        queue.push_back(SteerDelivery {
            queued_ids: vec![QueuedId::from("q-keep-2")],
            content: Content::Parts(vec![
                ContentPart::Text("surviving with image".into(), None),
                ContentPart::File {
                    source: BinarySource::AttachmentRef("stored".into()),
                    mime_type: "image/png".into(),
                    filename: Some("shot.png".into()),
                    text: None,
                },
            ]),
            task_notification: false,
        });
    }
    let stored_reads = Arc::new(AtomicUsize::new(0));
    let surface_for_stop = surface.0.clone();
    let reads_hook = stored_reads.clone();
    let hook = Arc::new(move |reference: &str| {
        if reference == "note" {
            surface_for_stop.steers.lock().unwrap().retain(|steer| !steer.queued_ids.iter().any(|id| id.as_str() == "q-drop-1"));
        } else if reference == "stored" {
            reads_hook.fetch_add(1, Ordering::SeqCst);
        }
    });
    let partial = within(
        "partial claim without second attachment read",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": r#"tool read {"path":"a.txt"}"# }),
            None,
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns { calls: Some(tools.calls(&surface)), on_attachment_read: Some(hook), ..Turns::default() },
        ),
    )
    .await;
    let partial_text = completed_text(&partial);
    assert!(partial_text.contains("surviving with image"), "{partial_text:?}");
    assert!(partial_text.contains("images=1"), "{partial_text:?}");
    assert!(!partial_text.contains("dropped first"), "{partial_text:?}");
    assert!(!partial_text.contains("plover"), "{partial_text:?}");
    assert_eq!(stored_reads.load(Ordering::SeqCst), 1, "surviving steer attachment must not be re-read after commit_steers");

    // Case 2: Turn cancellation firing during `commit_steers` prevents sending the steered answer.
    let stop = CancellationToken::new();
    let surface = Surface::default();
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-cancel-post-commit")],
        content: Content::Text("must not send after cancel".into()),
        task_notification: false,
    });
    let stop_in_commit = stop.clone();
    *surface.0.on_commit_steers.lock().unwrap() = Some(Arc::new(move || {
        stop_in_commit.cancel();
    }));
    let interrupted = within(
        "cancel racing commit_steers",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": r#"tool read {"path":"b.txt"}"# }),
            None,
            Some("RULES"),
            "default",
            stop,
            Turns { calls: Some(tools.calls(&surface)), ..Turns::default() },
        ),
    )
    .await;
    assert_eq!(interrupted, TurnEnd::Interrupted);
    assert!(!surface.streamed().contains("must not send after cancel"), "cancelled turn must not deliver steered answer: {}", surface.streamed());
    assert_eq!(surface.0.steers.lock().unwrap().len(), 1, "pre-dequeue cancel must leave steer queued");
}

/// When a shared server wedges (ignores `session/cancel` and stalls `session/new`), recovery immediately
/// unsets the abandoned `SESSION_KEY` header before blocking on `session/new`, retires/kills the wedged server after
/// `shared_open_timeout`, and recovers cleanly on a fresh shared server.
#[tokio::test]
async fn wedged_shared_server_unsets_abandoned_header_promptly_and_recovers_past_stalled_session_new() {
    let world = World::official(&[("FAKE_AGENT_SILENT_CANCEL", "1")]);
    world.agents.set_cancel_close_grace(Duration::from_millis(100));
    world.agents.set_shared_open_timeout(Duration::from_millis(200));

    // Start a hanging turn on the shared server and stop it while the server ignores `session/cancel` (sess-1 stuck).
    let (working, stop) = (Surface::default(), CancellationToken::new());
    let hanging = world.serve_with(&working, json!({ "role": "user", "content": "hang" }), None, Some("RULES"), "default", stop.clone(), Turns::default());
    let cancel_turn = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        stop.cancel();
    };
    let (ended, ()) = within("shared hang cancel", async { tokio::join!(hanging, cancel_turn) }).await;
    assert_eq!(ended, TurnEnd::Interrupted);

    let wedged_session = world.agents.running(&thread()).expect("stuck session");
    let wedged_conn = wedged_session.connection.clone();
    let wedged_handle = wedged_conn.handle().clone();

    // Wedge `session/new` on the existing shared server using the dynamic `fake-agent.env` gate file.
    let env_path = world.dir.path().join("fake-agent.env");
    let gate_file = world.dir.path().join("unblock-new");
    #[allow(clippy::disallowed_methods, reason = "test updates fake-agent.env to stall session/new on the wedged server")]
    {
        let mut content = std::fs::read_to_string(&env_path).expect("read fake-agent.env");
        content.push_str(&format!("\nFAKE_AGENT_NEW_UNTIL={}\n", gate_file.display()));
        std::fs::write(&env_path, content).expect("write fake-agent.env");
    }

    let surface = Surface::default();
    let header_unset_while_wedged = Arc::new(AtomicBool::new(false));
    let serve_fut = world.serve_with(
        &surface,
        json!({ "role": "user", "content": "whoami" }),
        Some(held("sess-1")),
        Some("RULES"),
        "default",
        CancellationToken::new(),
        Turns::default(),
    );
    let watch_fut = {
        let surface = surface.clone();
        let wedged_conn = wedged_conn.clone();
        let header_unset_while_wedged = header_unset_while_wedged.clone();
        async move {
            // The abandoned SESSION_KEY must be unset promptly while `session/new` on the wedged server is still pending.
            surface.until(|events| events.iter().any(|event| matches!(event, Event::Header(change) if change.unset.iter().any(|k| k == SESSION_KEY)))).await;
            if !wedged_conn.exited().is_cancelled() {
                header_unset_while_wedged.store(true, Ordering::SeqCst);
            }
            // Wait for `shared_open_timeout` to retire and kill the wedged server, then unblock the fresh replacement server.
            wedged_conn.exited().cancelled().await;
            #[allow(clippy::disallowed_methods, reason = "test unblocks the replacement shared server")]
            std::fs::write(&gate_file, "go").expect("write gate file");
        }
    };
    let (recovered, ()) = within("wedged shared server recovery", async { tokio::join!(serve_fut, watch_fut) }).await;
    let text = completed_text(&recovered);
    assert!(header_unset_while_wedged.load(Ordering::SeqCst), "abandoned SESSION_KEY must be unset before the wedged server is retired");
    assert!(text.contains("resumed=false"), "fresh session must open after retiring wedged server: {text:?}");
    let fresh_handle = world.agents.running(&thread()).expect("fresh session").connection.handle().clone();
    assert_ne!(fresh_handle, wedged_handle, "wedged shared server must be replaced with a fresh server process");
}

/// `deliver_answer` respects `mcp_call_deadline` — a tool that already handed off to background answers
/// immediately without waiting on steers, and slow steer attachment reads on a fast tool are bounded by the remaining
/// deadline before `commit_steers`, leaving queued steers untouched for the next boundary.
#[tokio::test]
async fn deliver_answer_respects_mcp_call_deadline_and_hands_off_immediately_with_slow_attachments() {
    // Case 1: Slow tool hits `mcp_call_deadline` and hands off to background -> immediate delivery, steers untouched.
    let (world, tools) = handing_in(World::build(&[], |preset, _| preset.quirks.mcp_call_deadline = Some(Duration::from_millis(800))));
    let surface = Surface::default();
    let gate = Arc::new(Notify::new());
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-bg-handoff")],
        content: Content::Parts(vec![
            ContentPart::Text("pending steer during background handoff".into(), None),
            ContentPart::File {
                source: BinarySource::AttachmentRef("slow".into()),
                mime_type: "text/plain".into(),
                filename: Some("slow.txt".into()),
                text: None,
            },
        ]),
        task_notification: false,
    });
    let handoff = within(
        "background handoff with slow steer attachment",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": format!(r#"tool {SLOW} {{"step":1}}"#) }),
            None,
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns { calls: Some(tools.calls(&surface)), hold_attachment: Some(gate.clone()), ..Turns::default() },
        ),
    )
    .await;
    let handoff_text = completed_text(&handoff);
    assert!(handoff_text.contains("background task"), "tool should hand off to background: {handoff_text:?}");
    assert!(!handoff_text.contains("pending steer during background handoff"), "{handoff_text:?}");
    assert_eq!(surface.0.steer_peeks.load(Ordering::SeqCst), 0, "background handoff must skip peeking steers");
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 0, "background handoff must not commit steers");
    assert_eq!(surface.0.steers.lock().unwrap().len(), 1, "queued steer must remain intact for the next boundary");
    tools.release.add_permits(1);

    // Case 2: Fast tool completes quickly, but steer attachment stalls past `due.answer` -> bounded before commit_steers.
    let (world, tools) = handing_in(World::build(&[], |preset, _| preset.quirks.mcp_call_deadline = Some(Duration::from_millis(600))));
    let surface = Surface::default();
    let gate = Arc::new(Notify::new());
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-slow-attach")],
        content: Content::Parts(vec![
            ContentPart::Text("slow attachment steer".into(), None),
            ContentPart::File {
                source: BinarySource::AttachmentRef("slow".into()),
                mime_type: "text/plain".into(),
                filename: Some("slow.txt".into()),
                text: None,
            },
        ]),
        task_notification: false,
    });
    let fast_end = within(
        "fast tool with stalled steer attachment bounded by mcp_call_deadline",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": r#"tool read {"path":"a.txt"}"# }),
            None,
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns { calls: Some(tools.calls(&surface)), hold_attachment: Some(gate), ..Turns::default() },
        ),
    )
    .await;
    let fast_text = completed_text(&fast_end);
    assert!(fast_text.contains(r#"read ran with {"path":"a.txt"}"#), "{fast_text:?}");
    assert!(!fast_text.contains("slow attachment steer"), "timed-out steer must not be appended: {fast_text:?}");
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 0, "timed-out steer must not be committed");
    assert_eq!(surface.0.steers.lock().unwrap().len(), 1, "timed-out steer must remain queued for the next boundary");
}

/// Repeated silent cancels on a shared server with a live sibling clean up abandoned prompt ids from
/// `Connection::sent` immediately on detach instead of leaking one entry per recovery forever.
#[tokio::test]
async fn repeated_silent_cancels_on_shared_server_do_not_leak_connection_sent_ids() {
    let world = World::build(&[("FAKE_AGENT_SILENT_CANCEL", "1")], |preset, _| preset.scope = mixdog_acp::preset::ProcessScope::Shared);
    world.agents.set_cancel_close_grace(Duration::from_millis(60));
    let other = ThreadId::from("sess_sibling");
    let cwd = world.cwd();
    assert!(world.answer_in(&other, &cwd, "whoami").await.starts_with("session=sess-1"));
    let shared_conn = world.agents.running(&other).expect("sibling session").connection.clone();

    for round in 0..5 {
        let (working, stop) = (Surface::default(), CancellationToken::new());
        let hanging = world.serve_with(&working, json!({ "role": "user", "content": "hang" }), None, Some("RULES"), "default", stop.clone(), Turns::default());
        let cancel_turn = async {
            working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
            stop.cancel();
        };
        let (ended, ()) = within("silent cancel round", async { tokio::join!(hanging, cancel_turn) }).await;
        assert_eq!(ended, TurnEnd::Interrupted);
        let stuck_id = world.agents.running(&thread()).expect("stuck session").session_id.clone();

        let recovered = within(
            "recovery after silent cancel",
            world.serve_with(
                &Surface::default(),
                json!({ "role": "user", "content": "whoami" }),
                Some(held(&stuck_id)),
                Some("RULES"),
                "default",
                CancellationToken::new(),
                Turns::default(),
            ),
        )
        .await;
        let _ = completed_text(&recovered);
        assert_eq!(shared_conn.sent_len(), 0, "abandoned prompt ids leaked into Connection::sent on round {round}");
    }
    assert!(world.answer_in(&other, &cwd, "whoami").await.starts_with("session=sess-1"));
    assert_eq!(shared_conn.sent_len(), 0);
}

/// When a wedged shared server is replaced by a fresh process that allocates the exact same
/// `sessionId` (`sess-1`) as the abandoned stored session and has the same prompt digest, recovery must
/// still run conversation handoff (sending the summary) and restore the cleared `SESSION_KEY` header.
#[tokio::test]
async fn replacement_shared_server_with_same_session_id_still_runs_handoff_and_restores_header() {
    let world = World::official(&[("FAKE_AGENT_SILENT_CANCEL", "1")]);
    world.agents.set_cancel_close_grace(Duration::from_millis(80));
    world.agents.set_shared_open_timeout(Duration::from_millis(180));

    // Turn 1 opens `sess-1` on the initial shared server and hangs until Stop (leaving `sess-1` stuck).
    let (working, stop) = (Surface::default(), CancellationToken::new());
    let hanging = world.serve_with(&working, json!({ "role": "user", "content": "hang" }), None, Some("RULES"), "default", stop.clone(), Turns::default());
    let cancel_turn = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        stop.cancel();
    };
    let (ended, ()) = within("shared hang cancel", async { tokio::join!(hanging, cancel_turn) }).await;
    assert_eq!(ended, TurnEnd::Interrupted);

    let wedged_conn = world.agents.running(&thread()).expect("stuck session").connection.clone();
    let stored_same_prompt = Stored { session_id: "sess-1".into(), prompt: Some(mixdog_acp::session::digest("RULES")) };

    // Stall `session/new` on the wedged server until it is retired, then unblock the fresh replacement server
    // (whose first `session/new` allocates `sess-1` again!).
    let env_path = world.dir.path().join("fake-agent.env");
    let gate_file = world.dir.path().join("unblock-handoff");
    #[allow(clippy::disallowed_methods, reason = "test updates fake-agent.env to stall session/new on wedged server")]
    {
        let mut content = std::fs::read_to_string(&env_path).expect("read fake-agent.env");
        content.push_str(&format!("\nFAKE_AGENT_NEW_UNTIL={}\n", gate_file.display()));
        std::fs::write(&env_path, content).expect("write fake-agent.env");
    }

    let surface = Surface::default();
    let hand_over_calls = Arc::new(AtomicUsize::new(0));
    let serve_fut = world.serve_with(
        &surface,
        json!({ "role": "user", "content": "echo" }),
        Some(stored_same_prompt),
        Some("RULES"),
        "default",
        CancellationToken::new(),
        Turns { summary: Some(Ok("PRIOR CONVERSATION SUMMARY")), hand_over_calls: Some(hand_over_calls.clone()), ..Turns::default() },
    );
    let watch_fut = async {
        wedged_conn.exited().cancelled().await;
        #[allow(clippy::disallowed_methods, reason = "test unblocks replacement server")]
        std::fs::write(&gate_file, "go").expect("write gate file");
    };
    let (recovered, ()) = within("replacement handoff with colliding session id", async { tokio::join!(serve_fut, watch_fut) }).await;
    let text = completed_text(&recovered);

    assert_eq!(world.agents.running(&thread()).expect("replacement session").session_id, "sess-1", "replacement server reused sess-1");
    assert_eq!(hand_over_calls.load(Ordering::SeqCst), 1, "replacement server's fresh session must run conversation handoff even on colliding session_id");
    assert!(text.contains("PRIOR CONVERSATION SUMMARY"), "replacement session prompt must include conversation summary: {text:?}");

    // Verify SESSION_KEY was unset for the abandoned session and then restored on the fresh replacement session.
    let header_events: Vec<HeaderChange> = surface
        .events()
        .into_iter()
        .filter_map(|event| match event {
            Event::Header(change) => Some(change),
            _ => None,
        })
        .collect();
    let unset_pos = header_events.iter().position(|change| change.unset.iter().any(|k| k == SESSION_KEY)).expect("abandoned header unset");
    let restore_pos = header_events
        .iter()
        .rposition(|change| change.set.get(SESSION_KEY).and_then(|v| v.get("sessionId")).and_then(Value::as_str) == Some("sess-1"))
        .expect("replacement SESSION_KEY header must be restored even with identical sessionId and prompt digest");
    assert!(restore_pos > unset_pos, "restored header must follow abandoned unset: {header_events:?}");
}

/// A stalled `commit_steers` (actor/IO delay before dequeue) is bounded by `mcp_call_deadline`,
/// sending the base tool answer on time and leaving the steer queued untouched.
#[tokio::test]
async fn stalled_commit_steers_is_bounded_by_mcp_call_deadline_and_leaves_steer_queued() {
    let (world, tools) = handing_in(World::build(&[], |preset, _| preset.quirks.mcp_call_deadline = Some(Duration::from_millis(500))));
    let surface = Surface::default();
    surface.0.hold_commit_steers.store(true, Ordering::SeqCst);
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-stalled-commit")],
        content: Content::Text("stalled commit must not delay tool answer".into()),
        task_notification: false,
    });

    let end = within(
        "fast tool with stalled commit_steers bounded by mcp_call_deadline",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": r#"tool read {"path":"a.txt"}"# }),
            None,
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns { calls: Some(tools.calls(&surface)), ..Turns::default() },
        ),
    )
    .await;
    let text = completed_text(&end);
    assert!(text.contains(r#"read ran with {"path":"a.txt"}"#), "{text:?}");
    assert!(!text.contains("stalled commit must not delay tool answer"), "{text:?}");
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 1, "commit_steers was attempted and cancelled before dequeue");
    assert_eq!(surface.0.steers.lock().unwrap().len(), 1, "stalled steer must stay queued for the next boundary");
}

/// When a wedged shared server is retired and the fresh replacement server also stalls on `session/new`,
/// the retry path honors `shared_open_timeout` and fails cleanly instead of hanging indefinitely.
#[tokio::test]
async fn replacement_shared_server_stalled_session_new_honors_open_timeout_instead_of_hanging() {
    let world = World::official(&[("FAKE_AGENT_SILENT_CANCEL", "1")]);
    world.agents.set_cancel_close_grace(Duration::from_millis(80));
    world.agents.set_shared_open_timeout(Duration::from_millis(160));

    let (working, stop) = (Surface::default(), CancellationToken::new());
    let hanging = world.serve_with(&working, json!({ "role": "user", "content": "hang" }), None, Some("RULES"), "default", stop.clone(), Turns::default());
    let cancel_turn = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        stop.cancel();
    };
    let (ended, ()) = within("shared hang cancel", async { tokio::join!(hanging, cancel_turn) }).await;
    assert_eq!(ended, TurnEnd::Interrupted);

    // Permanently stall `session/new` (gate file is never created) so BOTH the wedged server and its fresh
    // replacement stall on `session/new`.
    let env_path = world.dir.path().join("fake-agent.env");
    let never_gate = world.dir.path().join("never-created-gate");
    #[allow(clippy::disallowed_methods, reason = "test updates fake-agent.env to stall session/new on both servers")]
    {
        let mut content = std::fs::read_to_string(&env_path).expect("read fake-agent.env");
        content.push_str(&format!("\nFAKE_AGENT_NEW_UNTIL={}\n", never_gate.display()));
        std::fs::write(&env_path, content).expect("write fake-agent.env");
    }

    let started = tokio::time::Instant::now();
    let failed = within(
        "replacement shared server open timeout",
        world.serve_with(
            &Surface::default(),
            json!({ "role": "user", "content": "whoami" }),
            Some(held("sess-1")),
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns::default(),
        ),
    )
    .await;
    assert!(matches!(failed, TurnEnd::Failed { .. }), "both stalled servers must fail cleanly after open timeout: {failed:?}");
    assert!(started.elapsed() < Duration::from_secs(3), "replacement open must honor shared_open_timeout, took {:?}", started.elapsed());
    world.all_exited().await;
}

/// When `session/new` opens a fresh handle with the same `sessionId` as the stored header,
/// and model selection fails before the prompt carrying the handoff is ever sent, retrying with a valid
/// model reuses the cached handle and still runs conversation handoff and restores `SESSION_KEY`
/// (clearing `handoff_pending` only once that prompt is actually sent).
#[tokio::test]
async fn reused_handle_after_failed_model_selection_still_runs_handoff_and_restores_header() {
    let world = World::of(&["antigravity"], &[("FAKE_AGENT_SILENT_CANCEL", "1")], |preset, _| {
        preset.quirks.model_scope = mixdog_acp::preset::ModelScope::ExceptPrefixes(Vec::new());
    });
    world.agents.set_cancel_close_grace(Duration::from_millis(80));
    world.agents.set_shared_open_timeout(Duration::from_millis(160));

    // Turn 1: open `sess-1` on the initial shared server and leave it stuck on Stop.
    let (working, stop) = (Surface::default(), CancellationToken::new());
    let hanging = world.serve_with(&working, json!({ "role": "user", "content": "hang" }), None, Some("RULES"), "default", stop.clone(), Turns::default());
    let cancel_turn = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        stop.cancel();
    };
    let (ended, ()) = within("shared hang cancel", async { tokio::join!(hanging, cancel_turn) }).await;
    assert_eq!(ended, TurnEnd::Interrupted);

    let wedged_conn = world.agents.running(&thread()).expect("stuck session").connection.clone();
    let stored_same_prompt = Stored { session_id: "sess-1".into(), prompt: Some(mixdog_acp::session::digest("RULES")) };

    // Stall `session/new` on the wedged server so it retires, then let the fresh replacement server allocate `sess-1`.
    let env_path = world.dir.path().join("fake-agent.env");
    let gate_file = world.dir.path().join("unblock-model-fail-handoff");
    #[allow(clippy::disallowed_methods, reason = "test updates fake-agent.env to retire wedged server")]
    {
        let mut content = std::fs::read_to_string(&env_path).expect("read fake-agent.env");
        content.push_str(&format!("\nFAKE_AGENT_NEW_UNTIL={}\n", gate_file.display()));
        std::fs::write(&env_path, content).expect("write fake-agent.env");
    }

    // Turn 2: recovery opens fresh `sess-1` on the replacement server, summarizes, then fails `select_model("refused")`
    // before the prompt is ever sent, leaving the fresh handle cached in `agents.sessions`.
    let hand_over_calls = Arc::new(AtomicUsize::new(0));
    let fail_surface = Surface::default();
    let fail_fut = world.serve_with(
        &fail_surface,
        json!({ "role": "user", "content": "echo" }),
        Some(stored_same_prompt.clone()),
        Some("RULES"),
        "refused",
        CancellationToken::new(),
        Turns { summary: Some(Ok("PRIOR CONVERSATION SUMMARY")), hand_over_calls: Some(hand_over_calls.clone()), ..Turns::default() },
    );
    let watch_fut = async {
        wedged_conn.exited().cancelled().await;
        #[allow(clippy::disallowed_methods, reason = "test unblocks replacement server")]
        std::fs::write(&gate_file, "go").expect("write gate file");
    };
    let (failed, ()) = within("failed model selection on fresh replacement handle", async { tokio::join!(fail_fut, watch_fut) }).await;
    assert!(matches!(failed, TurnEnd::Failed { .. }), "refused model must fail before sending prompt: {failed:?}");
    let cached = world.agents.running(&thread()).expect("fresh handle remains cached after model failure");
    assert_eq!(cached.session_id, "sess-1");
    assert!(cached.handoff_pending(), "handoff_pending must stay true when prompt was never sent");
    assert_eq!(hand_over_calls.load(Ordering::SeqCst), 1);

    // Turn 3: retry with a valid model and identical stored sessionId/prompt digest.
    // `resolve_running` reuses `cached` (`header_cleared == false`), yet `handoff_pending` is still true so handoff
    // must run, deliver the summary, restore SESSION_KEY, and clear `handoff_pending`.
    let retry_surface = Surface::default();
    let recovered = within(
        "retry after failed model selection",
        world.serve_with(
            &retry_surface,
            json!({ "role": "user", "content": "echo" }),
            Some(stored_same_prompt.clone()),
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns { summary: Some(Ok("PRIOR CONVERSATION SUMMARY")), hand_over_calls: Some(hand_over_calls.clone()), ..Turns::default() },
        ),
    )
    .await;
    let text = completed_text(&recovered);
    assert!(text.contains("PRIOR CONVERSATION SUMMARY"), "reused handle must still send conversation handoff: {text:?}");
    assert_eq!(hand_over_calls.load(Ordering::SeqCst), 2);
    assert!(!cached.handoff_pending(), "handoff_pending must clear once the prompt carrying handoff is sent");
    let restored = retry_surface.events().into_iter().any(|event| match event {
        Event::Header(change) => change.set.get(SESSION_KEY).and_then(|v| v.get("sessionId")).and_then(Value::as_str) == Some("sess-1"),
        _ => false,
    });
    assert!(restored, "retry on reused handle with pending handoff must restore SESSION_KEY");

    // Turn 4: subsequent turn on the same handle must NOT re-run handoff.
    let followup = within(
        "followup turn after handoff sent",
        world.serve_with(
            &Surface::default(),
            json!({ "role": "user", "content": "echo" }),
            Some(stored_same_prompt),
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns { summary: Some(Ok("PRIOR CONVERSATION SUMMARY")), hand_over_calls: Some(hand_over_calls.clone()), ..Turns::default() },
        ),
    )
    .await;
    let followup_text = completed_text(&followup);
    assert!(!followup_text.contains("PRIOR CONVERSATION SUMMARY"), "subsequent turn must not repeat handoff: {followup_text:?}");
    assert_eq!(hand_over_calls.load(Ordering::SeqCst), 2);
}

/// When a wedged shared server is replaced and the replacement server stalls during `initialize`,
/// the retry path bounds `shared_server` startup and `open_session` by `shared_open_timeout`, kills and cleans up
/// the stalled `Starting` slot, unblocks sibling opens waiting on that slot, and allows later opens to succeed.
#[tokio::test]
async fn replacement_shared_server_stalled_initialize_honors_open_timeout_and_unblocks_sibling() {
    let world = World::official(&[("FAKE_AGENT_SILENT_CANCEL", "1")]);
    world.agents.set_cancel_close_grace(Duration::from_millis(80));
    world.agents.set_shared_open_timeout(Duration::from_millis(200));

    // Turn 1: open `sess-1` on the initial shared server and leave it stuck on Stop.
    let (working, stop) = (Surface::default(), CancellationToken::new());
    let hanging = world.serve_with(&working, json!({ "role": "user", "content": "hang" }), None, Some("RULES"), "default", stop.clone(), Turns::default());
    let cancel_turn = async {
        working.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        stop.cancel();
    };
    let (ended, ()) = within("shared hang cancel", async { tokio::join!(hanging, cancel_turn) }).await;
    assert_eq!(ended, TurnEnd::Interrupted);

    let wedged_conn = world.agents.running(&thread()).expect("stuck session").connection.clone();

    // Stall `session/new` on the wedged server so it retires, AND stall `initialize` on the fresh replacement server.
    let env_path = world.dir.path().join("fake-agent.env");
    let new_gate = world.dir.path().join("init-test-new-gate");
    let init_gate = world.dir.path().join("init-test-init-gate");
    #[allow(clippy::disallowed_methods, reason = "test updates fake-agent.env to stall replacement initialize")]
    {
        let mut content = std::fs::read_to_string(&env_path).expect("read fake-agent.env");
        content.push_str(&format!("\nFAKE_AGENT_NEW_UNTIL={}\nFAKE_AGENT_INIT_UNTIL={}\n", new_gate.display(), init_gate.display()));
        std::fs::write(&env_path, content).expect("write fake-agent.env");
    }

    let started = tokio::time::Instant::now();
    let retry_surface = Surface::default();
    let retry_fut = world.serve_with(
        &retry_surface,
        json!({ "role": "user", "content": "whoami" }),
        Some(held("sess-1")),
        Some("RULES"),
        "default",
        CancellationToken::new(),
        Turns::default(),
    );
    let sibling_thread = ThreadId::from("thr_sibling_stalled_init");
    let sibling_fut = async {
        // Wait for the wedged server to be retired so the sibling joins the replacement server's `Starting` slot.
        wedged_conn.exited().cancelled().await;
        let turns = Arc::new(Turns::default());
        let request = TurnRequest {
            thread: sibling_thread.clone(),
            cwd: world.cwd(),
            stored: None,
            rules: Some("RULES".into()),
            input: json!({ "role": "user", "content": "whoami" }),
            conversation: turns.clone(),
            attachments: turns,
            last_context_tokens: None,
            context_window: None,
        };
        mixdog_acp::runs::serve(&world.agents, &world.preset, request, Arc::new(Surface::default()), world.context(CancellationToken::new())).await
    };
    let (retry_end, sibling_end) = within("stalled replacement initialize timeout + sibling unblock", async { tokio::join!(retry_fut, sibling_fut) }).await;
    assert!(matches!(retry_end, TurnEnd::Failed { .. }), "replacement stalled on initialize must fail cleanly: {retry_end:?}");
    assert!(matches!(sibling_end, TurnEnd::Failed { .. }), "sibling waiting on stalled Starting slot must unblock cleanly: {sibling_end:?}");
    assert!(started.elapsed() < Duration::from_secs(3), "replacement initialize timeout took {:?}", started.elapsed());

    // Unblock both gates and verify a subsequent open starts a fresh server cleanly (Starting slot was cleaned up).
    #[allow(clippy::disallowed_methods, reason = "test unblocks fake-agent gates")]
    {
        std::fs::write(&init_gate, "go").expect("write init gate");
        std::fs::write(&new_gate, "go").expect("write new gate");
    }
    let recovered = within(
        "fresh open after stalled Starting slot cleanup",
        world.serve_with(
            &Surface::default(),
            json!({ "role": "user", "content": "whoami" }),
            None,
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns::default(),
        ),
    )
    .await;
    let text = completed_text(&recovered);
    assert!(text.contains("session=sess-1"), "fresh server after cleanup must work cleanly: {text:?}");
    world.agents.release_all();
    world.all_exited().await;
}

/// The prompt `text` as a turn of `world`'s thread on the session it has, its route on `gem` at the effort `high`.
fn serve_on_gem<'a>(world: &'a World, text: &str, stored: Option<Stored>) -> impl Future<Output = TurnEnd> + 'a {
    let turns = Arc::new(Turns::default());
    let request = TurnRequest {
        thread: thread(),
        cwd: world.cwd(),
        stored,
        rules: Some("RULES".to_owned()),
        input: json!({ "role": "user", "content": text }),
        conversation: turns.clone(),
        attachments: turns,
        last_context_tokens: None,
        context_window: None,
    };
    let context = TurnContext { model: "gem".to_owned(), effort: Some("high".to_owned()), ..world.context(CancellationToken::new()) };
    mixdog_acp::runs::serve(&world.agents, &world.preset, request, Arc::new(Surface::default()), context)
}

/// The fake's models, `gem` at two efforts beside `solo`.
const TIERED: &str = r#"[{"modelId":"gem-low","name":"Gem (Low)"},{"modelId":"gem-high","name":"Gem (High)"},{"modelId":"solo","name":"Solo"}]"#;

/// One prompt turn of `session`, reported to `surface`.
async fn run_on(world: &World, session: &Arc<mixdog_acp::session::AgentSession>, surface: &Surface, text: &str) -> TurnEnd {
    let ask = Ask::Prompt(vec![json!({ "type": "text", "text": text })]);
    within("the turn", mixdog_acp::turn::run(session, Arc::new(surface.clone()), ask, world.context(CancellationToken::new()))).await
}

/// A shared server whose start never gets its `initialize` answered is stopped by the app's stop: the stop does not wait on
/// the answer, the server is closed as the end of its input closes it, and the open that waited for it is refused.
#[tokio::test]
async fn the_apps_stop_ends_a_servers_start_whose_initialize_is_never_answered() {
    let world = World::official(&[("FAKE_AGENT_SILENT_INIT", "1")]);
    let thread = thread();
    let opening = world.agents.session(&thread, &world.preset, world.cwd(), None, None);
    let stop = async {
        world.logs("initialize").await;
        world.agents.shutdown().await;
    };
    let (opened, ()) = within("the open and the stop", async { tokio::join!(opening, stop) }).await;
    assert!(matches!(opened, Err(Refusal::Fault(_))));
    assert!(world.processes.list().iter().all(|process| process.exit == Some(CLOSED)), "{:?}", world.log());
    assert!(world.server_temps().iter().all(|temp| !exists(temp)));
}

/// A close the agent never answers is cancelled on shutdown (and skipped on a retiring shared server) without a fixed
/// timer: the question returns its answer and its process ends, and a retiring shared server closes via stdin EOF.
#[tokio::test]
async fn a_close_the_agent_never_answers_does_not_hold_up_the_question() {
    let world = World::new(&[("FAKE_AGENT_SILENT_CLOSE", "1")]);
    world.checked().await;
    let before = world.logged("session/close");
    let now: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(|| 0_i64);
    let asking = mixdog_acp::runs::ask_once(&world.agents, &world.preset, "default", "SUMMARIZE", "whoami", now);
    let stop = async {
        while world.logged("session/close") <= before {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        world.agents.shutdown().await;
    };
    let (answered, ()) = within("the answer and shutdown", async { tokio::join!(asking, stop) }).await;
    assert!(matches!(&answered, Ok(answered) if answered.text.starts_with("session=sess-1")), "{answered:?}");
    assert!(world.logged("session/close") > before, "the question's session was asked to close: {:?}", world.log());

    // On a shared server that advertises close, a non-retiring detach sends session/close without a timer, while a
    // retiring detach skips session/close and cancels any in-flight close as stdin closes.
    let shared = World::build(&[("FAKE_AGENT_SILENT_CLOSE", "1")], |preset, _| preset.scope = mixdog_acp::preset::ProcessScope::Shared);
    shared.checked().await;
    let before = shared.logged("session/close");
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    assert!(shared.answer_in(&a, &shared.cwd(), "whoami").await.starts_with("session=sess-1"));
    assert!(shared.answer_in(&b, &shared.folder("b"), "whoami").await.starts_with("session=sess-2"));
    let server = shared.agents.running(&a).expect("a's agent").connection.clone();
    shared.agents.release(&a);
    within("non-retiring session/close", async {
        while shared.logged("session/close") <= before {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    let after_a = shared.logged("session/close");
    shared.agents.release(&b);
    within("the retiring shared server's exit", server.exited().cancelled()).await;
    assert_eq!(shared.logged("session/close"), after_a, "retiring shared server skips session/close: {:?}", shared.log());
}

/// An error the agent answers to no request (`"id": null`, as it answers a line it could not parse) ends nothing: the
/// turn goes on in the same process.
#[tokio::test]
async fn an_error_the_agent_answers_to_no_request_leaves_its_process_running() {
    let world = World::new(&[]);
    let end = within("the turn", world.prompt(&thread(), &Surface::default(), "nullerror", None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "fine");
    let session = world.agents.running(&thread()).expect("the session's agent");
    let next = run_on(&world, &session, &Surface::default(), "whoami").await;
    assert!(matches!(next, TurnEnd::Completed { .. }), "{next:?}");
    assert!(!session.connection.exited().is_cancelled());
}

/// A cancel told while no prompt was open (a stop that came as the agent answered the prompt) is written ahead of the next
/// prompt: the agent never reads it as the cancel of that one.
#[tokio::test]
async fn a_cancel_told_before_the_next_prompt_reaches_the_agent_ahead_of_it() {
    let world = World::new(&[]);
    within("the first turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    let session = world.agents.running(&thread()).expect("the session's agent");
    session.cancel(None);
    let end = run_on(&world, &session, &Surface::default(), "whoami").await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");
    let log = world.log();
    let cancel = log.iter().position(|line| line == "session/cancel").expect("the cancel");
    let prompt = log.iter().rposition(|line| line == "session/prompt").expect("the prompt");
    assert!(cancel < prompt, "{log:?}");
}

/// Cancelling a turn that is waiting on a cancelled prompt the agent never closed ends the wedged process so the next
/// turn opens cleanly without a fixed timer.
#[tokio::test]
async fn a_cancelled_prompt_the_agent_never_closes_does_not_hold_the_next_turn() {
    let world = World::new(&[("FAKE_AGENT_DEAF", "1")]);
    let (thread, surface, cancel) = (thread(), Surface::default(), CancellationToken::new());
    let muted = world.prompt(&thread, &surface, "mute", None, cancel.clone());
    let stop = async {
        world.logs("session/prompt").await;
        cancel.cancel();
    };
    let (end, ()) = within("the stop", async { tokio::join!(muted, stop) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    let held = world.agents.running(&thread).expect("the session's agent");
    assert!(held.holds_cancelled_prompt());

    let (cancel_next, next_surface) = (CancellationToken::new(), Surface::default());
    let waiting = world.serve(&next_surface, json!({ "role": "user", "content": "whoami" }), Some("sess-1"), "default", cancel_next.clone());
    let stop_next = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel_next.cancel();
    };
    let (end, ()) = within("cancelling the waiting turn", async { tokio::join!(waiting, stop_next) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    within("the end of the agent that held the prompt", held.connection.exited().cancelled()).await;

    let end = within(
        "the recovered turn",
        world.serve(&Surface::default(), json!({ "role": "user", "content": "whoami" }), Some("sess-1"), "default", CancellationToken::new()),
    )
    .await;
    assert!(completed_text(&end).starts_with("session=sess-1 resumed=true"), "{end:?}");
}

/// On a shared server with `Reopen::Resume`, a wedged/unclosed session is never resumed concurrently with its unclosed
/// prompt or farewell `session/cancel`: an otherwise empty server retires so the next turn starts a fresh server, and
/// a server still serving another session starts a fresh session instead of resuming the wedged id.
#[tokio::test]
async fn a_wedged_prompt_on_a_shared_server_is_never_resumed_while_its_cancel_or_prompt_is_open() {
    // Alone on the shared server: cancelling the waiting turn retires the wedged server instead of keeping it leased.
    let solo = World::official(&[("FAKE_AGENT_DEAF", "1")]);
    let (cancel1, surface1) = (CancellationToken::new(), Surface::default());
    let muted = solo.serve(&surface1, json!({ "role": "user", "content": "mute" }), None, "default", cancel1.clone());
    let stop1 = async {
        solo.logs("session/prompt").await;
        cancel1.cancel();
    };
    let (end, ()) = within("first stop", async { tokio::join!(muted, stop1) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    let wedged = solo.agents.running(&thread()).expect("the session's agent");
    assert!(wedged.holds_cancelled_prompt());
    let server1 = wedged.connection.clone();

    let (cancel2, surface2) = (CancellationToken::new(), Surface::default());
    let waiting = solo.serve(&surface2, json!({ "role": "user", "content": "whoami" }), Some("sess-1"), "default", cancel2.clone());
    let stop2 = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel2.cancel();
    };
    let (end, ()) = within("second stop", async { tokio::join!(waiting, stop2) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    within("retiring the wedged shared server", server1.exited().cancelled()).await;
    assert!(solo.agents.running(&thread()).is_none());

    let end = within(
        "recovered turn on fresh server",
        solo.serve(&Surface::default(), json!({ "role": "user", "content": "whoami" }), Some("sess-1"), "default", CancellationToken::new()),
    )
    .await;
    assert!(completed_text(&end).starts_with("session=sess-1 resumed=true"), "{end:?}");
    let fresh = solo.agents.running(&thread()).expect("the recovered session");
    assert_ne!(fresh.connection.handle(), server1.handle());
    assert_eq!(solo.logged("start acp"), 2, "{:?}", solo.log());

    // Alongside another active session on a close-capable shared server: the server keeps serving the keeper, while the wedged id is never resumed on it.
    let shared = World::build(&[("FAKE_AGENT_DEAF", "1")], |preset, _| preset.scope = mixdog_acp::preset::ProcessScope::Shared);
    let keeper = ThreadId::from("sess_keeper");
    assert!(shared.answer_in(&keeper, &shared.folder("keeper"), "whoami").await.starts_with("session=sess-1"));
    let server = shared.agents.running(&keeper).expect("keeper's agent").connection.clone();

    let (cancel1, surface1) = (CancellationToken::new(), Surface::default());
    let muted = shared.serve(&surface1, json!({ "role": "user", "content": "mute" }), None, "default", cancel1.clone());
    let stop1 = async {
        while shared.logged("session/prompt") < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        cancel1.cancel();
    };
    let (end, ()) = within("shared first stop", async { tokio::join!(muted, stop1) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    assert!(shared.agents.running(&thread()).expect("wedged session").holds_cancelled_prompt());

    let (cancel2, surface2) = (CancellationToken::new(), Surface::default());
    let waiting = shared.serve(&surface2, json!({ "role": "user", "content": "whoami" }), Some("sess-2"), "default", cancel2.clone());
    let stop2 = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel2.cancel();
    };
    let (end, ()) = within("shared second stop", async { tokio::join!(waiting, stop2) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    assert!(!server.exited().is_cancelled(), "the shared server stays up for the keeper");

    let end = within(
        "fresh session on shared server",
        shared.serve(&Surface::default(), json!({ "role": "user", "content": "whoami" }), Some("sess-2"), "default", CancellationToken::new()),
    )
    .await;
    assert!(completed_text(&end).starts_with("session=sess-3 resumed=false"), "{end:?}");
    assert_eq!(shared.logged("session/resume sess-2"), 0, "wedged sessionId must never be resumed on the same server: {:?}", shared.log());
    assert_eq!(shared.agents.running(&thread()).expect("fresh session").connection.handle(), server.handle());
    assert!(shared.answer_in(&keeper, &shared.folder("keeper"), "whoami").await.starts_with("session=sess-1"));

    // Direct detach of a wedged session inside Agents::session (cwd change) also starts a fresh session cleanly.
    let (cancel3, surface3) = (CancellationToken::new(), Surface::default());
    let muted = shared.serve(&surface3, json!({ "role": "user", "content": "mute" }), Some("sess-3"), "default", cancel3.clone());
    let stop3 = async {
        while shared.logged("session/prompt") < 5 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        cancel3.cancel();
    };
    let (end, ()) = within("shared third stop", async { tokio::join!(muted, stop3) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    let moved = shared.folder("moved");
    let reopened = within("reopening after cwd change", shared.agents.session(&thread(), &shared.preset, moved, Some(held("sess-3")), Some("RULES".into())))
        .await
        .expect("fresh session opened");
    assert_eq!(reopened.session_id, "sess-4");
    assert!(reopened.restarted);
    assert_eq!(shared.logged("session/resume sess-3"), 0, "{:?}", shared.log());
}

/// What the shared server sends of a session before the answer that opens it names it (a first report) reaches the session.
#[tokio::test]
async fn what_the_shared_server_sends_of_a_session_before_its_open_is_answered_reaches_it() {
    let world = World::official(&[("FAKE_AGENT_EARLY_UPDATE", "1")]);
    let session = within("the open", world.agents.session(&thread(), &world.preset, world.cwd(), None, None)).await.expect("the session");
    assert_eq!(session.context_use(), Some(mixdog_acp::session::ContextUse { used: 7, size: 700 }));
}

/// What a load that failed replayed of the stored session is none of the session opened in its place.
#[tokio::test]
async fn what_a_failed_load_replayed_is_none_of_the_session_opened_in_its_place() {
    let world = World::build(&[("FAKE_AGENT_LOAD_FAILS", "1")], |preset, _| preset.quirks.reopen = mixdog_acp::preset::Reopen::Load);
    within("the first turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    world.agents.release(&thread());
    let surface = Surface::default();
    let end = within("the reopened turn", world.prompt(&thread(), &surface, "whoami", Some("sess-1"), CancellationToken::new())).await;
    assert!(completed_text(&end).starts_with("session=sess-1 resumed=false loaded=false"), "{end:?}");
    assert_eq!(world.logged("session/load"), 1);
    let replayed = |text: &str| text.contains("replayed");
    let rows = surface.rows();
    assert!(!replayed(&surface.streamed()) && !rows.iter().any(|row| row["content"].as_str().is_some_and(replayed)), "{rows:?}");
}

/// An agent that states the close it does not offer as `null` is never asked to close a session across `check_cli`,
/// `probe`, one-off questions, and shared-server session detach.
#[tokio::test]
async fn an_agent_that_states_its_close_as_null_is_never_asked_to_close() {
    let cli = World::new(&[("FAKE_AGENT_CLOSE_NULL", "1")]);
    cli.checked().await;
    assert_eq!(cli.logged("session/new"), 1, "check_cli probed a session: {:?}", cli.log());
    assert_eq!(cli.logged("session/close"), 0, "check_cli must not send session/close when close is null: {:?}", cli.log());
    let now: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(|| 0_i64);
    within("the answer", mixdog_acp::runs::ask_once(&cli.agents, &cli.preset, "default", "SUMMARIZE", "whoami", now)).await.expect("an answer");
    assert_eq!(cli.logged("session/close"), 0, "session.close must not send session/close when close is null: {:?}", cli.log());

    let official = World::official(&[("FAKE_AGENT_CLOSE_NULL", "1")]);
    #[allow(clippy::disallowed_methods, reason = "force a fresh probe instead of reading the cached probe file")]
    let _ = std::fs::remove_file(official.dir.path().join("acp-agents").join("probe-cache.json"));
    official.checked().await;
    assert_eq!(official.logged("session/new"), 1, "probe opened a session: {:?}", official.log());
    assert_eq!(official.logged("session/close"), 0, "probe must not send session/close when close is null: {:?}", official.log());
    let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
    assert!(official.answer_in(&a, &official.cwd(), "whoami").await.starts_with("session=sess-1"));
    assert!(official.answer_in(&b, &official.folder("b"), "whoami").await.starts_with("session=sess-2"));
    official.agents.release(&a);
    official.agents.release(&b);
    assert_eq!(official.logged("session/close"), 0, "shared detach must not send session/close when close is null: {:?}", official.log());
}

/// A reopen the agent refuses for a sign-in that no longer holds signs the agent out: no new session is opened in place
/// of the stored one.
#[tokio::test]
async fn a_reopen_refused_for_the_sign_in_signs_the_agent_out_and_opens_no_new_session() {
    let world = World::new(&[("FAKE_AGENT_RESUME_AUTH", "1")]);
    within("the first turn", world.prompt(&thread(), &Surface::default(), "whoami", None, CancellationToken::new())).await;
    world.agents.release(&thread());
    let opened = within("the reopen", world.agents.session(&thread(), &world.preset, world.cwd(), Some(held("sess-1")), Some("RULES".into()))).await;
    let refused = opened.err();
    assert!(refused.as_ref().is_some_and(Refusal::signed_out), "{refused:?}");
    assert_eq!(world.agents.status()["agents"][0]["state"], "signedOut");
}

/// What the agent writes last before it exits, with no end of line after it, arrives: the prompt's answer on stdout, and
/// the line on stderr.
#[tokio::test]
async fn what_the_agent_writes_last_with_no_end_of_line_still_arrives() {
    let world = World::new(&[]);
    let session = within("the open", world.agents.session(&thread(), &world.preset, world.cwd(), None, None)).await.expect("the agent starts");
    let mut lines = session.connection.stderr_lines();
    let end = run_on(&world, &session, &Surface::default(), "lastword").await;
    assert!(matches!(&end, TurnEnd::Failed { message, code: Some(-32603), reported: true } if message == "out of words"), "{end:?}");
    let mut told = Vec::new();
    while let Some(line) = within("the end of stderr", lines.recv()).await {
        told.push(line);
    }
    assert!(told.iter().any(|line| line == "the last stderr words"), "{told:?}");
}

/// A stderr line is told up to its bound, however long the agent makes it.
#[tokio::test]
async fn a_stderr_line_is_told_up_to_its_bound() {
    let world = World::new(&[]);
    let session = within("the open", world.agents.session(&thread(), &world.preset, world.cwd(), None, None)).await.expect("the agent starts");
    let mut lines = session.connection.stderr_lines();
    run_on(&world, &session, &Surface::default(), "noisy").await;
    let line = within("the line", lines.recv()).await.expect("the line");
    assert_eq!(line.len(), 32 * 1024);
}

/// A session whose shared server was retired while it opened is not kept as the thread's.
#[tokio::test]
async fn a_session_whose_server_was_retired_while_it_opened_is_not_kept() {
    let world = World::official(&[("FAKE_AGENT_NEW_UNTIL", "answer-the-open")]);
    let thread = thread();
    let opening = world.agents.session(&thread, &world.preset, world.cwd(), None, None);
    let retire = async {
        world.logs("session/new").await;
        world.agents.release_all();
        #[allow(clippy::disallowed_methods, reason = "the agent answers the open")]
        std::fs::write(world.dir.path().join("answer-the-open"), "").expect("the answer");
    };
    let (opened, ()) = within("the open", async { tokio::join!(opening, retire) }).await;
    assert!(world.agents.running(&thread).is_none(), "a session gone while it opened is not kept");
    assert!(opened.is_err());
}

/// A model option of the agent's whose choices are grouped lists the choices of every group.
#[test]
fn a_grouped_model_option_lists_the_models_of_every_group() {
    let answer = json!({ "configOptions": [{ "id": "model", "category": "model", "type": "select", "currentValue": "b", "options": [
        { "group": "fast", "name": "Fast", "options": [{ "value": "a", "name": "A" }] },
        { "group": "deep", "name": "Deep", "options": [{ "value": "b", "name": "B" }, { "value": "c" }] },
    ] }] });
    let models = mixdog_acp::session::Models::of(&answer);
    assert_eq!(models.available.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    assert_eq!((models.current.as_deref(), models.config_option.as_deref()), (Some("b"), Some("model")));
}

/// The model the agent tells it put itself on (its model option at its `thought_level`) is the session's: a route's model
/// is set again where it is not that one.
#[tokio::test]
async fn a_model_the_agent_tells_it_is_on_is_the_sessions_and_the_routes_is_set_again() {
    let world = World::new(&[("FAKE_AGENT_MODELS", TIERED)]);
    within("the switch", serve_on_gem(&world, "switch gem low", None)).await;
    let session = world.agents.running(&thread()).expect("the session's agent");
    assert_eq!(session.models().current.as_deref(), Some("gem-low"));
    let end = within("the next turn", serve_on_gem(&world, "whoami", Some(held("sess-1")))).await;
    assert!(completed_text(&end).contains(" model=gem-high "), "{end:?}");
}

/// A reopened session whose answer lists no models runs the route's model at its effort, as the agent listed it.
#[tokio::test]
async fn a_reopened_session_whose_answer_lists_no_models_runs_the_routes_effort() {
    let world = World::new(&[("FAKE_AGENT_MODELS", TIERED)]);
    let end = within("the first turn", serve_on_gem(&world, "whoami", None)).await;
    assert!(completed_text(&end).contains(" model=gem-high "), "{end:?}");
    world.agents.release(&thread());
    let end = within("the reopened turn", serve_on_gem(&world, "whoami", Some(held("sess-1")))).await;
    assert!(completed_text(&end).starts_with("session=sess-1 resumed=true") && completed_text(&end).contains(" model=gem-high "), "{end:?}");
}

/// A call an earlier turn left running that ends while a cancelled prompt is still open is shown by the next turn.
#[tokio::test]
async fn a_background_call_that_ends_while_a_cancelled_prompt_is_open_is_shown_by_the_next_turn() {
    let world = World::new(&[]);
    let first = Surface::default();
    within("the first turn", world.prompt(&thread(), &first, "keep", None, CancellationToken::new())).await;
    let made = first.rows()[0]["toolCalls"][0]["id"].clone();
    let (thread, surface, cancel) = (thread(), Surface::default(), CancellationToken::new());
    let muted = world.prompt(&thread, &surface, "mute", None, cancel.clone());
    let stop = async {
        while world.logged("session/prompt") < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        cancel.cancel();
    };
    let (end, ()) = within("the stop", async { tokio::join!(muted, stop) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    let next = Surface::default();
    let end = within("the next turn", world.prompt(&thread, &next, "whoami", None, CancellationToken::new())).await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");
    let rows = next.rows();
    assert!(rows.iter().any(|row| row["toolCalls"][0]["arguments"]["resultOf"] == made), "{rows:?}");
}

/// A report of its context the agent makes after its prompt was answered is told by the next turn, and its window is kept.
#[tokio::test]
async fn a_report_the_agent_makes_after_its_prompt_is_answered_is_told_by_the_next_turn() {
    let world = World::new(&[]);
    let input = |text: &str| json!({ "role": "user", "content": text });
    within("the turn", world.serve(&Surface::default(), input("latereport"), None, "default", CancellationToken::new())).await;
    let session = world.agents.running(&thread()).expect("the session's agent");
    within("the late report", async {
        while session.context_use().is_none() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    let next = Surface::default();
    within("the next turn", world.serve(&next, input("whoami"), Some("sess-1"), "default", CancellationToken::new())).await;
    let windows: Vec<Value> = next
        .events()
        .into_iter()
        .filter_map(|event| match event {
            Event::Header(change) => change.set.get("rawContextWindow").cloned(),
            _ => None,
        })
        .collect();
    assert_eq!(windows, [json!(2000)], "{:?}", next.events());
    assert_eq!(world.agents.reported_window(&world.preset, "default"), Some(2000));
}

/// A read the agent of a session's own process makes in the name of another session is refused.
#[tokio::test]
async fn a_read_that_names_another_session_than_the_processs_own_is_refused() {
    let world = World::new(&[]);
    let note = world.dir.path().join("note.txt");
    let end =
        within("the turn", world.prompt(&thread(), &Surface::default(), &format!("readas sess-9 {}", note.display()), None, CancellationToken::new())).await;
    assert_eq!(completed_text(&end), "error:the read names no session this client holds open");
}

/// Item 1: A `resource_link` attachment pointing into a BlobStore outside `cwd` is readable by `fs/read_text_file`
/// only for the session it was attached to, while siblings, unrelated sessions in the same `cwd`, and reopened sessions
/// after release are denied.
#[tokio::test]
async fn attached_resource_link_outside_cwd_is_readable_by_agent() {
    let world = World::new(&[]);
    let outside = tempfile::tempdir().expect("outside blobs");
    let attached = outside.path().join("attached.txt");
    let sibling = outside.path().join("secret.txt");
    #[allow(clippy::disallowed_methods, reason = "test seeds outside attachment files")]
    std::fs::write(&attached, "hello from blob\n").expect("write attached");
    #[allow(clippy::disallowed_methods, reason = "test seeds outside sibling file")]
    std::fs::write(&sibling, "not allowed\n").expect("write sibling");

    let mut turns = Turns::default();
    turns.extra_paths.insert("ext".into(), attached.to_string_lossy().into_owned());
    let input = json!({
        "role": "user",
        "content": [
            { "type": "file", "name": "attached.txt", "attachmentRef": "ext", "mimeType": "text/plain" },
            { "type": "text", "text": format!("read {}", attached.display()) }
        ]
    });
    let end = within("attached read", world.serve_with(&Surface::default(), input, None, Some("RULES"), "default", CancellationToken::new(), turns)).await;
    assert_eq!(completed_text(&end), "read:hello from blob\n");
    let session_id = world.agents.running(&thread()).expect("running session").session_id.clone();

    let denied = within(
        "sibling denied",
        world.serve_with(
            &Surface::default(),
            json!({ "role": "user", "content": format!("read {}", sibling.display()) }),
            Some(held(&session_id)),
            Some("RULES"),
            "default",
            CancellationToken::new(),
            Turns::default(),
        ),
    )
    .await;
    assert!(completed_text(&denied).starts_with("error:"), "sibling outside cwd must be denied: {denied:?}");

    // An unrelated session in the same `cwd` must NOT inherit the first session's attached file allowlist.
    let other_thread = ThreadId::from("t2".to_owned());
    let other =
        within("other session read", world.prompt(&other_thread, &Surface::default(), &format!("read {}", attached.display()), None, CancellationToken::new()))
            .await;
    assert!(completed_text(&other).starts_with("error:"), "other session in same cwd must be denied: {other:?}");

    // Ending the session evicts its allowlist: a fresh session on the same thread cannot read it without re-attaching.
    world.agents.release(&thread());
    let after_end = world.ask(&Surface::default(), &format!("read {}", attached.display()), Turns::default()).await;
    assert!(completed_text(&after_end).starts_with("error:"), "released session allowlist must be evicted: {after_end:?}");
}

/// Item 2: Non-text content in message chunks and tool results reaches the transcript, images are stored once and
/// rendered as `media` cards with no raw base64 retained, and both official Antigravity and `agy` CLI `generate_image`
/// shapes produce a media image card.
#[tokio::test]
async fn nontext_chunks_and_both_generate_image_shapes_store_and_render_media_cards() {
    let world = World::official(&[]);
    let surface = Surface::default();
    let turns = Turns::default();
    let kept = turns.kept_images.clone();
    let end = world.ask(&surface, "nontext", turns).await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");

    let streamed = surface.streamed();
    assert!(streamed.contains("[audio (audio/wav)]"), "{streamed}");
    assert!(streamed.contains("inline resource"), "{streamed}");
    assert!(streamed.contains("link.md"), "{streamed}");

    let rows = surface.rows();
    let serialized = Value::Array(rows.clone()).to_string();
    assert!(!serialized.contains("iVBORw=="), "chunk base64 must not be retained in rows: {serialized}");
    assert!(!serialized.contains("aW1n"), "tool image base64 must not be retained in rows: {serialized}");
    assert_eq!(kept.lock().unwrap().len(), 2, "chunk image and generate_image each stored once");

    let media_calls: Vec<&Value> = rows.iter().filter_map(|row| row["toolCalls"].as_array()).flatten().filter(|call| call["name"] == "media").collect();
    assert_eq!(media_calls.len(), 2, "one card for chunk image, one single card for generate_image: {rows:?}");
    let results: Vec<Value> =
        rows.iter().filter(|row| row["role"] == "tool").filter_map(|row| row["content"].as_str().and_then(|s| serde_json::from_str::<Value>(s).ok())).collect();
    assert!(results.iter().any(|r| r["assetId"] == "asset-1" && r["kind"] == "image"), "{results:?}");
    assert!(results.iter().any(|r| r["assetId"] == "asset-2" && r["prompt"] == "a red fox"), "{results:?}");

    // agy CLI shape: "Generated image is saved at <path>." pointing under the agent's home folder.
    let cli_world = World::new(&[]);
    let img_dir = cli_world.dir.path().join("home").join("out");
    let img_path = img_dir.join("cat.png");
    #[allow(clippy::disallowed_methods, reason = "test seeds saved image under agent home")]
    std::fs::create_dir_all(&img_dir).and_then(|()| std::fs::write(&img_path, b"\x89PNG\r\n\x1a\ncat")).expect("seed image");
    let cli_surface = Surface::default();
    let cli_turns = Turns::default();
    let cli_kept = cli_turns.kept_images.clone();
    let cli_end = cli_world.ask(&cli_surface, &format!("agyimage {}", img_path.display()), cli_turns).await;
    assert!(matches!(cli_end, TurnEnd::Completed { .. }), "{cli_end:?}");
    assert_eq!(cli_kept.lock().unwrap().len(), 1);
    assert_eq!(cli_kept.lock().unwrap()[0].bytes, b"\x89PNG\r\n\x1a\ncat");
    let cli_rows = cli_surface.rows();
    assert!(
        cli_rows.iter().any(|row| row["role"] == "tool" && row["content"].as_str().is_some_and(|s| s.contains("\"assetId\":\"asset-1\""))),
        "agy CLI saved image renders as media card: {cli_rows:?}"
    );
}

/// Items 3 & 10: `usage_update.cost` and `cachedWriteTokens` are preserved, a subsequent turn with no `usage_update`
/// does not re-report the previous turn's context, and agent-side cancel preserves its usage.
#[tokio::test]
async fn usage_cost_cached_write_no_stale_context_and_agent_cancel_usage() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end1 = world.ask(&surface, "costusage", Turns::default()).await;
    assert!(matches!(end1, TurnEnd::Completed { .. }), "{end1:?}");
    let usages1: Vec<TurnUsage> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Usage(u) => Some(u),
            _ => None,
        })
        .collect();
    assert_eq!(usages1.len(), 1);
    assert_eq!(usages1[0].cached_write_tokens, 300);
    assert_eq!(usages1[0].cost, mixdog_core_api::domain::provider::UsdTicks::from_usd(0.042));
    assert_eq!(usages1[0].context.map(|c| (c.used, c.size)), Some((500, 10000)));
    assert!(mixdog_acp::surface::input_excludes_cache(&usages1[0]));

    // Second turn on the same session sends no usage_update -> context must be None (not stale 500/10000).
    let surface2 = Surface::default();
    let end2 = within("plain turn", world.prompt(&thread(), &surface2, "plainusage", None, CancellationToken::new())).await;
    assert!(matches!(end2, TurnEnd::Completed { .. }), "{end2:?}");
    let usages2: Vec<TurnUsage> = surface2
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Usage(u) => Some(u),
            _ => None,
        })
        .collect();
    assert_eq!(usages2.len(), 1);
    assert_eq!(usages2[0].context, None, "must not re-report previous turn's context");

    // Third turn cancelled by agent carries usage -> preserved on Interrupted turn.
    let surface3 = Surface::default();
    let end3 = within("agent cancel", world.prompt(&thread(), &surface3, "agentcancel", None, CancellationToken::new())).await;
    assert_eq!(end3, TurnEnd::Interrupted);
    let usages3: Vec<TurnUsage> = surface3
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Usage(u) => Some(u),
            _ => None,
        })
        .collect();
    assert_eq!(usages3.len(), 1);
    assert_eq!((usages3[0].input_tokens, usages3[0].output_tokens), (33, 7));
}

/// Item 4: Concurrent Mixdog MCP calls do not stall the turn loop or sibling MCP calls while another holds its lane.
#[tokio::test]
async fn concurrent_mixdog_mcp_calls_run_without_stalling_turn_loop_or_siblings() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    let calling = tools.prompt(&world, &surface, "concurrent slow read");
    let drive = async {
        // Wait until the sibling `read` completed and streamed its text WHILE `slow` is still blocked!
        surface.until(|events| events.iter().any(|e| matches!(e, Event::Delta(t) if t.contains("second=read ran")))).await;
        tools.release.add_permits(1);
    };
    let (end, ()) = within("concurrent mcp calls", async { tokio::join!(calling, drive) }).await;
    let text = completed_text(&end);
    assert!(text.contains("second=read ran") && text.contains("first=slow ended"), "{text}");
}

/// Item 5: Cancelling during `session/request_permission` drops the pending approval future, answers `cancelled`, and
/// prevents queued permission requests from running after cancel.
#[tokio::test]
async fn cancelling_during_permission_drops_ask_answers_cancelled_and_skips_queued() {
    let world = World::new(&[]);
    let surface = Surface::default();
    surface.0.holds_asks.store(true, Ordering::SeqCst);
    let cancel = CancellationToken::new();
    let t = thread();
    let asking = world.prompt(&t, &surface, "twoasks", None, cancel.clone());
    let stop = async {
        surface.until(|_| !surface.0.asks.lock().unwrap().is_empty()).await;
        cancel.cancel();
    };
    let (end, ()) = within("cancelled permission", async { tokio::join!(asking, stop) }).await;
    assert_eq!(end, TurnEnd::Interrupted);
    assert_eq!(surface.0.asks.lock().unwrap().len(), 1, "queued second permission must never open an approval card");
    assert_eq!(surface.0.dropped_asks.load(Ordering::SeqCst), 1, "pending approval future must be dropped on cancel");
    world.logs("permission answered sess-1 cancelled").await;
}

/// Items 7 & 11: All parts dropped by `promptCapabilities` does not send empty `prompt: []`, does not trigger
/// `hand_over()` or leave an orphaned session; `mediaType` is honored for image detection; inline `attachment:///{name}`
/// URIs are percent-encoded.
#[tokio::test]
async fn prompt_parts_mediatype_and_percent_encoded_inline_attachment_uri() {
    // All parts dropped (no image capability, image-only prompt) -> fails cleanly without prompting agent, running
    // handover, or leaving a fresh session orphaned.
    let no_img = World::new(&[("FAKE_AGENT_NO_IMAGES", "1")]);
    let no_img_surface = Surface::default();
    let img_only = json!({ "role": "user", "content": [{ "type": "file", "mediaType": "image/png", "data": "aW1n" }] });
    let turns = Turns { summary: Some(Ok("prior summary")), ..Turns::default() };
    let end = within("dropped prompt", no_img.serve_with(&no_img_surface, img_only, None, Some("RULES"), "default", CancellationToken::new(), turns)).await;
    assert!(matches!(end, TurnEnd::Failed { reported: false, .. }), "{end:?}");
    assert_eq!(no_img.logged("session/prompt"), 0, "must not send empty prompt: []");
    assert!(no_img.agents.running(&thread()).is_none(), "must not leave an orphaned session after an all-dropped prompt");
    let handover_notice = no_img_surface.events().into_iter().any(|e| matches!(e, Event::Notice(text) if text.contains("summarized")));
    assert!(!handover_notice, "must not run handover when all prompt parts are dropped: {:?}", no_img_surface.events());

    // mediaType: "image/png" detected as image when agent supports images.
    let with_img = World::new(&[]);
    let media_type_input = json!({
        "role": "user",
        "content": [
            { "type": "file", "mediaType": "image/png", "data": "aW1n" },
            { "type": "text", "text": "whoami" }
        ]
    });
    let end = within("mediatype image", with_img.serve(&Surface::default(), media_type_input, None, "default", CancellationToken::new())).await;
    assert!(completed_text(&end).contains("images=1"), "{end:?}");

    // Percent-encoded inline attachment:///{name} URI.
    let embedded = World::new(&[("FAKE_AGENT_EMBEDDED", "1")]);
    let inline = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "spec body");
    let inline_input = json!({
        "role": "user",
        "content": [
            { "type": "file", "name": "my spec #1?.md", "mimeType": "text/markdown", "data": inline },
            { "type": "text", "text": "files" }
        ]
    });
    let end = within("inline uri", embedded.serve(&Surface::default(), inline_input, None, "default", CancellationToken::new())).await;
    assert!(completed_text(&end).contains("attachment:///my%20spec%20%231%3F.md"), "{end:?}");
}

/// Item 8: `refusal`, `max_tokens`, and `max_turn_requests` surface why the turn stopped and do not leave open tool
/// calls labelled as still running on user turns or `ask_once`.
#[tokio::test]
async fn cut_short_stop_reasons_surface_why_and_close_open_calls() {
    let world = World::new(&[]);
    for (reason, expected_why) in [("refusal", "refused"), ("max_tokens", "output tokens"), ("max_turn_requests", "model requests")] {
        let surface = Surface::default();
        let end = world.ask(&surface, &format!("stopreason {reason}"), Turns::default()).await;
        assert!(matches!(&end, TurnEnd::Completed { stop_reason: Some(r), .. } if r == reason), "{end:?}");
        assert!(surface.notices().iter().any(|n| n.contains(expected_why)), "{reason}: {:?}", surface.notices());
        let rows = surface.rows();
        let tool_row = rows.iter().find(|r| r["role"] == "tool").expect("closed tool row");
        let content = tool_row["content"].as_str().unwrap_or_default();
        assert!(!content.contains("Still running"), "{reason}: {content}");
        assert!(content.contains(expected_why), "{reason}: {content}");

        let asked = within(
            "ask_once cut short",
            mixdog_acp::runs::ask_once(&world.agents, &world.preset, "default", "RULES", &format!("stopreason {reason}"), Arc::new(|| 0_i64)),
        )
        .await;
        let err = asked.expect_err("ask_once must fail on cut-short stop reason");
        assert!(err.contains(expected_why), "{reason}: {err}");
    }
}

/// Item 9: `Judged::Refused` and `ApprovalResolution::Unavailable` fall back to `reject_always` when `reject_once` is
/// absent.
#[tokio::test]
async fn refused_and_unavailable_approvals_fall_back_to_reject_always() {
    let (world, tools) = handing(&[]);
    // ApprovalResolution::Unavailable (Surface has no queued answers -> Unavailable).
    let end_unavail = tools.prompt(&world, &Surface::default(), "rejectonly").await;
    assert_eq!(completed_text(&end_unavail), "option:deny_always");

    // Judged::Refused (Witness denies file paths containing "secret").
    let end_refused = tools.prompt(&world, &Surface::default(), "rejectonly /w/secret.txt").await;
    assert_eq!(completed_text(&end_refused), "option:deny_always");
}

/// Item 12: A `tool_call_update` arriving after call close reaches the transcript.
#[tokio::test]
async fn late_tool_call_update_after_close_reaches_transcript() {
    let world = World::new(&[]);
    let surface = Surface::default();
    let end = world.ask(&surface, "lateupdate", Turns::default()).await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");
    let rows = surface.rows();
    assert!(rows.iter().any(|r| r["role"] == "tool" && r["content"] == "initial"), "{rows:?}");
    assert!(rows.iter().any(|r| r["role"] == "tool" && r["content"] == "updated final"), "{rows:?}");
}

/// Item 13: Inbound `RpcError.data` classifies failure codes in `turn.rs`, and `ask_once` passes the route's effort.
#[tokio::test]
async fn rpc_error_data_classifies_failure_and_ask_once_passes_effort() {
    let world = World::new(&[]);
    let end = world.ask(&Surface::default(), "errdata", Turns::default()).await;
    assert!(matches!(&end, TurnEnd::Failed { code: Some(-32002), message, reported: true } if message.contains("Session not found")), "{end:?}");

    let tiered =
        World::build(&[("FAKE_AGENT_MODELS", r#"[{"modelId":"gem-low","name":"Gem (Low)"},{"modelId":"gem-high","name":"Gem (High)"}]"#)], |preset, _| {
            preset.quirks.effort_tiers = vec!["low".into(), "high".into()];
        });
    let answered =
        within("ask_once effort", mixdog_acp::runs::ask_once(&tiered.agents, &tiered.preset, ("gem", Some("low")), "RULES", "whoami", Arc::new(|| 0_i64)))
            .await
            .expect("ask_once succeeds");
    assert!(answered.text.contains("model=gem-low"), "{answered:?}");
}

/// Regression: `generate_image` recognized only on `tool_call_update` via `rawOutput.{imageName, imagePath}` emits a
/// `media` card once, and `Reply::late_result` for a background `generate_image` emits a single `media` card without
/// duplicating it.
#[tokio::test]
async fn generate_image_recognized_on_update_and_late_result_emit_single_media_card() {
    // Case 1: Opened initially as `antigravity_other`, recognized as `generate_image` only on completion update.
    let world = World::official(&[]);
    let surface = Surface::default();
    let turns = Turns::default();
    let kept = turns.kept_images.clone();
    let end = world.ask(&surface, "lateimage", turns).await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");
    assert_eq!(kept.lock().unwrap().len(), 1, "image stored once");
    let rows = surface.rows();
    let media_calls: Vec<&Value> = rows.iter().filter_map(|row| row["toolCalls"].as_array()).flatten().filter(|call| call["name"] == "media").collect();
    assert_eq!(media_calls.len(), 1, "standalone media card emitted once: {rows:?}");
    assert!(
        rows.iter().any(|row| row["role"] == "tool" && row["content"].as_str().is_some_and(|s| s.contains("\"assetId\":\"asset-1\""))),
        "media card result holds stored assetId: {rows:?}"
    );

    // Case 2: Background `generate_image` completed in a later turn via `Reply::late_result`.
    let bg_world = World::official(&[]);
    let s1 = Surface::default();
    let end1 = bg_world.ask(&s1, "bgimage", Turns::default()).await;
    assert!(matches!(end1, TurnEnd::Completed { .. }), "{end1:?}");
    let bg_session = bg_world.agents.running(&thread()).expect("running session").session_id.clone();

    let s2 = Surface::default();
    let t2 = Turns::default();
    let kept2 = t2.kept_images.clone();
    let end2 = within(
        "finishbgimage",
        bg_world.serve_with(
            &s2,
            json!({ "role": "user", "content": "finishbgimage" }),
            Some(held(&bg_session)),
            Some("RULES"),
            "default",
            CancellationToken::new(),
            t2,
        ),
    )
    .await;
    assert!(matches!(end2, TurnEnd::Completed { .. }), "{end2:?}");
    assert_eq!(kept2.lock().unwrap().len(), 1, "background image stored once");
    let rows2 = s2.rows();
    let media_calls2: Vec<&Value> = rows2.iter().filter_map(|row| row["toolCalls"].as_array()).flatten().filter(|call| call["name"] == "media").collect();
    assert_eq!(media_calls2.len(), 1, "late_result must emit exactly one media card without duplicating: {rows2:?}");
    assert!(
        rows2.iter().any(|row| row["role"] == "tool" && row["content"].as_str().is_some_and(|s| s.contains("\"assetId\":\"asset-1\""))),
        "late_result media card holds stored assetId: {rows2:?}"
    );
}

/// Live User Bug #2 regression: when two Mixdog tool calls run concurrently (`slow` + `read`) and a mid-turn user
/// steer is queued, the first completing call (`read`) MUST NOT commit or attach the steer while `slow` is still in
/// flight (`self.running > 0`). Only once `slow` finishes (`self.running == 0`) is the steer committed once and
/// attached to the final answer of the batch.
#[tokio::test]
async fn parallel_tool_batch_defers_mid_turn_steer_until_all_concurrent_calls_complete() {
    let (world, tools) = handing(&[]);
    let surface = Surface::default();
    surface.0.steers.lock().unwrap().push_back(SteerDelivery {
        queued_ids: vec![QueuedId::from("q-parallel-steer")],
        content: Content::Text("wait for the whole batch".into()),
        task_notification: false,
    });

    let calling = tools.prompt(&world, &surface, "concurrent slow read");
    let drive = async {
        // Wait until sibling `read` has completed and streamed its result WHILE `slow` is still blocked.
        surface.until(|events| events.iter().any(|e| matches!(e, Event::Delta(t) if t.contains("second=read ran")))).await;
        assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 0, "mid-turn steer must NOT be committed while a sibling Mixdog call is still in flight");
        assert_eq!(surface.0.steers.lock().unwrap().len(), 1, "steer must stay queued until batch finishes");
        assert!(
            !surface.streamed().contains("wait for the whole batch"),
            "steer must NOT be attached to the earlier-finishing sibling answer: {}",
            surface.streamed()
        );
        // Release `slow` so `self.running` reaches 0.
        tools.release.add_permits(1);
    };
    let (end, ()) = within("parallel batch mid-turn steer", async { tokio::join!(calling, drive) }).await;
    let text = completed_text(&end);
    let (second_part, first_part) = text.split_once(" first=").expect("both second and first answers echoed");
    assert!(second_part.contains("second=read ran"), "{second_part}");
    assert!(
        !second_part.contains("wait for the whole batch"),
        "steer must be absent from EVERY content block of the earlier-finishing sibling answer: {second_part}"
    );
    assert!(first_part.contains("slow ended"), "{first_part}");
    assert!(
        first_part.contains("[User message received while you were working]\nwait for the whole batch"),
        "steer must be attached to the final answer of the batch: {first_part}"
    );
    assert_eq!(surface.0.steer_commits.load(Ordering::SeqCst), 1, "steer committed exactly once when batch finished");
    assert_eq!(*surface.0.committed_steers.lock().unwrap(), vec![QueuedId::from("q-parallel-steer")]);
    assert!(surface.0.steers.lock().unwrap().is_empty());
}

/// `Reply::close` propagates terminal transcript write failures on normal AND cut-short (`max_tokens`,
/// `max_turn_requests`, `refusal`) completions instead of reporting `TurnEnd::Completed` after dropping the final row.
#[tokio::test]
async fn reply_close_terminal_write_error_fails_turn_instead_of_completing() {
    for prompt in ["whoami", "stopreason max_tokens", "stopreason max_turn_requests", "stopreason refusal"] {
        let world = World::new(&[]);
        let surface = Surface::default();
        surface.0.refuses_assistant_text.store(true, Ordering::SeqCst);

        let end = world.ask(&surface, prompt, Turns::default()).await;
        assert!(
            matches!(&end, TurnEnd::Failed { message, reported: false, .. } if message.contains("could not be saved")),
            "terminal commit failure for `{prompt}` must fail the turn cleanly: {end:?}"
        );
    }
}

/// Reusing an in-process ACP session checks the rules digest so changed rules force a fresh `session/new` (never
/// resuming the stale stored session) and apply the new rules cleanly.
#[tokio::test]
async fn reused_session_with_changed_rules_digest_reopens_and_applies_new_rules() {
    let world = World::new(&[]);
    let first_surface = Surface::default();
    let end1 = within(
        "first rules turn",
        world.serve_with(
            &first_surface,
            json!({ "role": "user", "content": "whoami" }),
            None,
            Some("RULES-V1"),
            "default",
            CancellationToken::new(),
            Turns::default(),
        ),
    )
    .await;
    assert!(matches!(end1, TurnEnd::Completed { .. }), "{end1:?}");
    let first_session = world.agents.running(&thread()).expect("running session").clone();
    let stored_v1 = Stored { session_id: first_session.session_id.clone(), prompt: first_session.prompt.clone() };

    let second_surface = Surface::default();
    let end2 = within(
        "changed rules turn",
        world.serve_with(
            &second_surface,
            json!({ "role": "user", "content": "whoami" }),
            Some(stored_v1),
            Some("RULES-V2"),
            "default",
            CancellationToken::new(),
            Turns::default(),
        ),
    )
    .await;
    let text2 = completed_text(&end2);
    assert!(text2.contains("resumed=false"), "changed rules must open a fresh session, not resume the stale one: {text2}");
    assert!(text2.contains("append=RULES-V2"), "fresh session must apply the new rules: {text2}");
    assert_eq!(world.logged("session/resume"), 0, "stale session must not be resumed: {:?}", world.log());
    let second_session = world.agents.running(&thread()).expect("fresh session");
    assert_ne!(second_session.prompt, first_session.prompt);
}

#[tokio::test]
async fn cold_reopen_adding_rules_without_prior_digest_opens_fresh_session() {
    let world = World::new(&[]);
    let first_surface = Surface::default();
    let end1 = within(
        "first turn without rules",
        world.serve_with(&first_surface, json!({ "role": "user", "content": "whoami" }), None, None, "default", CancellationToken::new(), Turns::default()),
    )
    .await;
    assert!(matches!(end1, TurnEnd::Completed { .. }), "{end1:?}");
    let first_session = world.agents.running(&thread()).expect("running session").clone();
    assert_eq!(first_session.prompt, None);
    let stored_without_digest = Stored { session_id: first_session.session_id.clone(), prompt: None };

    // Simulate a cold restart: no live handle remains, only the stored session ID with no recorded prompt digest.
    world.agents.release(&thread());
    assert!(world.agents.running(&thread()).is_none());

    let second_surface = Surface::default();
    let end2 = within(
        "cold reopen with newly supplied rules",
        world.serve_with(
            &second_surface,
            json!({ "role": "user", "content": "whoami" }),
            Some(stored_without_digest),
            Some("NEW-RULES"),
            "default",
            CancellationToken::new(),
            Turns::default(),
        ),
    )
    .await;
    let text2 = completed_text(&end2);
    assert!(text2.contains("resumed=false"), "cold reopen adding rules must open a fresh session: {text2}");
    assert!(text2.contains("append=NEW-RULES"), "fresh session must apply the newly supplied rules: {text2}");
    assert_eq!(world.logged("session/resume"), 0, "stale session without rules must not be resumed: {:?}", world.log());
    assert_eq!(world.logged("session/load"), 0, "stale session without rules must not be loaded: {:?}", world.log());
    let second_session = world.agents.running(&thread()).expect("fresh session");
    assert_eq!(second_session.prompt, Some(mixdog_acp::session::digest("NEW-RULES")));
}

/// Live User Bug #1: Built-in official Antigravity (Neon) preset enforces real context window caps (256k for
/// Gemini/Claude and the `default` route, 128k for gpt-oss) and surfaces the 76% mid-turn compaction cliff warning
/// when reported usage reaches ~195k/256k on the real `default` route.
#[tokio::test]
async fn antigravity_context_window_cap_and_mid_turn_compaction_cliff_enforced() {
    // Verify built-in Antigravity preset caps and cliff math directly.
    let presets = mixdog_acp::preset::builtin();
    let neon = presets.iter().find(|p| p.id == "antigravity").expect("official antigravity preset");
    assert!(!neon.quirks.fs_read_text_file, "official Neon preset must disable fs.readTextFile");
    assert_eq!(neon.quirks.effective_context_window("gemini-4-neon", 1_048_576), 256_000);
    assert_eq!(neon.quirks.effective_context_window("claude-opus-4-6", 1_000_000), 256_000);
    assert_eq!(neon.quirks.effective_context_window("gpt-oss-120b", 1_048_576), 128_000);
    assert_eq!(neon.quirks.effective_context_window_for("default", None, 1_048_576), 256_000);
    let cliff = neon.quirks.mid_turn_compaction_cliff(256_000).expect("antigravity cliff");
    assert!((190_000..=200_000).contains(&cliff), "expected ~195k compaction cliff, got {cliff}");

    // End-to-end turn check on the real built-in official Neon preset (`World::official`) and `"default"` route:
    // fake agent reports used=196_000, size=1_048_576; the real preset caps 1M -> 256_000 and fires the 76% cliff notice.
    let world = World::official(&[]);
    let surface = Surface::default();
    let end = world.ask(&surface, "cliff 196000 1048576", Turns::default()).await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");
    let windows: Vec<HeaderChange> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Header(change) if change.set.contains_key("contextWindow") => Some(change),
            _ => None,
        })
        .collect();
    assert_eq!(windows.len(), 1, "{:?}", surface.events());
    assert_eq!(windows[0].set.get("contextWindow"), Some(&json!(256_000)), "reported 1M window capped to 256k on official default route");
    assert!(
        surface.notices().iter().any(|n| n.contains("compaction cliff") && n.contains("196000 / 256000")),
        "expected mid-turn compaction cliff notice: {:?}",
        surface.notices()
    );
}

/// Neon `SharedServer` (`World::official`) initializes with `fs.readTextFile: false`, and `Agents::release_all` clears
/// remembered session grants so a reopened session does not inherit them.
#[tokio::test]
async fn neon_official_disables_fs_read_text_file_and_release_all_clears_grants() {
    let world = World::official(&[]);
    let surface = Surface::default();
    let end = world.ask(&surface, "whoami", Turns::default()).await;
    let text = completed_text(&end);
    assert!(text.contains("read=false"), "shared/official Neon server must initialize with fs.readTextFile=false: {text}");

    let session = world.agents.running(&thread()).expect("running session");
    let key = mixdog_tools::policy::GrantKey::tool("antigravity:demo").expect("grant key");
    session.grants.lock().unwrap().insert(key.clone());
    assert!(session.grants.lock().unwrap().contains(&key));
    world.agents.release_all();
    assert!(world.agents.running(&thread()).is_none(), "release_all drops running sessions");

    // Reopen a fresh session on the same thread and prove it does NOT inherit the old grant.
    let surface2 = Surface::default();
    let end2 = world.ask(&surface2, "whoami", Turns::default()).await;
    assert!(matches!(end2, TurnEnd::Completed { .. }), "{end2:?}");
    let reopened = world.agents.running(&thread()).expect("reopened session");
    assert!(!reopened.grants.lock().unwrap().contains(&key), "reopened session must not inherit grants cleared by release_all");
}

/// An idle-unloaded worker keeps its open ACP session so its next turn continues on it without `session/resume`,
/// `session/load`, or a new session; releasing it (close, cleanup, park, or delete) exits the process cleanly.
#[tokio::test]
async fn idle_unloaded_worker_reuses_open_acp_session_without_reopen_and_closes_on_release() {
    for shared in [false, true] {
        let world = if shared { World::official(&[]) } else { World::new(&[]) };
        if !shared {
            world.checked().await;
        }
        let surface1 = Surface::default();
        let end1 = world.serve(&surface1, json!({ "role": "user", "content": "whoami" }), None, "default", CancellationToken::new()).await;
        assert!(completed_text(&end1).starts_with("session=sess-1"), "shared={shared}: {end1:?}");
        let opens_after_first = world.logged("session/new");
        let resumes_after_first = world.logged("session/resume");
        let loads_after_first = world.logged("session/load");
        assert!(world.agents.running(&thread()).is_some(), "shared={shared}: ACP session stays open while Mixdog state is unloaded");

        // Next turn after Mixdog idle-unloaded and reloaded the worker's header (carrying `stored = sess-1`).
        let surface2 = Surface::default();
        let end2 = world.serve(&surface2, json!({ "role": "user", "content": "whoami" }), Some("sess-1"), "default", CancellationToken::new()).await;
        assert!(completed_text(&end2).starts_with("session=sess-1"), "shared={shared}: {end2:?}");
        assert_eq!(world.logged("session/new"), opens_after_first, "shared={shared}: no new ACP session on follow-up turn");
        assert_eq!(world.logged("session/resume"), resumes_after_first, "shared={shared}: no session/resume on follow-up turn");
        assert_eq!(world.logged("session/load"), loads_after_first, "shared={shared}: no session/load on follow-up turn");

        // Releasing the worker (close, cleanup, park, or thread delete) closes its ACP session and leaves no orphan process.
        world.agents.release(&thread());
        assert!(world.agents.running(&thread()).is_none(), "shared={shared}: release drops the ACP session");
        world.all_exited().await;
    }
}

/// Core shutdown (`Agents::shutdown`) ends every still-open per-session and shared ACP process (including sessions
/// whose Mixdog runtime was already idle-unloaded), waits for them to exit, and refuses subsequent opens.
#[tokio::test]
async fn shutdown_ends_idle_per_session_and_shared_acp_processes_without_orphans() {
    for shared in [false, true] {
        let world = if shared { World::official(&[]) } else { World::new(&[]) };
        if !shared {
            world.checked().await;
        }
        let surface = Surface::default();
        let end = world.serve(&surface, json!({ "role": "user", "content": "whoami" }), None, "default", CancellationToken::new()).await;
        assert!(completed_text(&end).starts_with("session=sess-1"), "shared={shared}: {end:?}");
        assert!(world.agents.running(&thread()).is_some(), "shared={shared}: session running before shutdown");

        within("shutdown", world.agents.shutdown()).await;
        assert!(world.agents.running(&thread()).is_none(), "shared={shared}: shutdown drains running sessions");
        assert!(
            world.processes.list().iter().all(|process| process.exit.is_some()),
            "shared={shared}: shutdown waits for every ACP process to exit without orphans: {:?}",
            world.processes.list()
        );
        let late = world.agents.session(&thread(), &world.preset, world.cwd(), None, None).await;
        assert!(matches!(late, Err(Refusal::Closed)), "shared={shared}: open after shutdown is refused: {:?}", late.err());
    }
}

/// When an ACP session crosses the capped compaction cliff (76% of 256k = 194,560) mid-turn, Mixdog cancels the old
/// session before the next tool round runs, summarizes via Mixdog compaction, opens a fresh session with Mixdog's
/// rules and summary, records the fresh session id, and completes the turn with zero agent self-compaction.
#[tokio::test]
async fn mid_turn_compaction_rolls_over_to_fresh_session_before_next_tool_round() {
    let (world, tools) = handing_in(World::official(&[("FAKE_AGENT_CONTINUE_TOOL", "read")]));
    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns {
        summary: Some(Ok("MIXDOG_MID_TURN_SUMMARY")),
        calls: Some(tools.calls(&surface)),
        auto_compact: true,
        mid_turn_compacts: Some(mid_compacts.clone()),
        ..Turns::default()
    };

    let end = world.ask(&surface, "midcompact 200687 1048576 read shell", turns).await;
    let (text, tool_calls) = match &end {
        TurnEnd::Completed { text, tool_calls, .. } => (text.as_str(), *tool_calls),
        other => panic!("expected TurnEnd::Completed after mid-turn rollover, got {other:?}"),
    };
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "Mixdog mid-turn compaction must fire once");
    assert_eq!(tool_calls, 2, "accumulated tool_calls across old (read) + fresh (read) sessions");
    assert!(text.contains("session=sess-1"), "fresh session on retired-and-restarted server must answer continuation: {text}");
    assert!(text.contains("resumed=false"), "rollover must open a fresh session, not resume: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover on !closes server must retire old server instead of leaking its harness: {:?}", world.log());
    assert!(text.contains("append=RULES"), "fresh session must receive session-start rules: {text}");
    assert!(text.contains("MIXDOG_MID_TURN_SUMMARY"), "fresh session lead must carry Mixdog's summary: {text}");

    let ran_tools: Vec<String> = tools.ran.lock().unwrap().iter().map(|(_, name, _)| name.clone()).collect();
    assert_eq!(ran_tools, vec!["read".to_owned(), "read".to_owned()], "round-2 shell tool on old session must never run");

    let log = world.log();
    assert!(log.iter().any(|line| line == "round2-refused"), "old session round-2 tool call must be refused: {log:?}");
    assert!(!log.iter().any(|line| line == "self-compact"), "agent self-compaction must never occur: {log:?}");

    let events = surface.events();
    assert!(events.iter().any(|e| matches!(e, Event::Stage(s) if s == "compacting")), "compacting stage emitted: {events:?}");
    assert!(events.iter().any(|e| matches!(e, Event::Compact(CompactStatus::Compacted))), "Compacted event emitted: {events:?}");
    assert!(
        !surface.notices().iter().any(|n| n.contains("compaction cliff")),
        "auto mid-turn compaction replaces advisory-only cliff notice: {:?}",
        surface.notices()
    );
    let recorded_sessions: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            Event::Header(change) => change.set.get(SESSION_KEY)?.get("sessionId")?.as_str().map(str::to_owned),
            _ => None,
        })
        .collect();
    assert_eq!(recorded_sessions.len(), 2, "SESSION_KEY updated for fresh rollover session: {recorded_sessions:?}");
}

/// If `usage_update` crosses the trigger while a Mixdog tool call is already in flight, Mixdog lets the in-flight tool
/// finish and commit its result row to the transcript, then refuses its MCP answer after `session/cancel` so the old
/// session cannot start another LLM round, compacts, and continues on a fresh session.
#[tokio::test]
async fn mid_turn_compaction_waits_for_in_flight_tool_to_commit_before_rolling_over() {
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns {
        summary: Some(Ok("INFLIGHT_SUMMARY")),
        calls: Some(tools.calls(&surface)),
        auto_compact: true,
        mid_turn_compacts: Some(mid_compacts.clone()),
        ..Turns::default()
    };

    let release = tools.release.clone();
    let releaser = tokio::spawn(async move {
        // Give the fake agent time to emit usage_update while `slow` is actively blocked inside Mixdog.
        tokio::time::sleep(Duration::from_millis(120)).await;
        release.add_permits(1);
    });
    let end = world.ask(&surface, "inflightcompact 200687 1048576 slow", turns).await;
    releaser.await.expect("releaser task");

    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once after in-flight tool commits");
    assert!(text.contains("resumed=false"), "fresh session continued turn: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());
    assert!(text.contains("INFLIGHT_SUMMARY"), "fresh session received Mixdog summary: {text}");

    let ran_tools: Vec<String> = tools.ran.lock().unwrap().iter().map(|(_, name, _)| name.clone()).collect();
    assert_eq!(ran_tools, vec![SLOW.to_owned()], "in-flight slow tool ran to completion");
    let committed_tool = surface.events().into_iter().any(|e| match e {
        Event::Commit(item) => item.body.get("role").and_then(Value::as_str) == Some("tool"),
        _ => false,
    });
    assert!(committed_tool, "in-flight tool result row must be committed before rollover");

    let log = world.log();
    assert!(log.iter().any(|line| line == "inflight-refused"), "old session must receive refused MCP answer after cancel: {log:?}");
    assert!(!log.iter().any(|line| line == "self-compact"), "old session must not self-compact: {log:?}");
}

/// A high `usage_update` followed immediately by `end_turn` does not trigger a spurious mid-turn rollover, and the
/// very next turn compacts via Mixdog pre-turn (using the capped window cliff even with a persisted 1M header window)
/// instead of resuming the bloated session.
#[tokio::test]
async fn high_usage_at_turn_end_does_not_roll_over_mid_turn_and_compacts_before_next_turn() {
    let world = World::official(&[]);
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let surface1 = Surface::default();
    let turns1 = Turns { summary: Some(Ok("SHOULD_NOT_RUN_MID_TURN")), auto_compact: true, mid_turn_compacts: Some(mid_compacts.clone()), ..Turns::default() };
    let end1 = world.ask(&surface1, "cliff 200687 1048576", turns1).await;
    assert!(matches!(end1, TurnEnd::Completed { .. }), "{end1:?}");
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 0, "turn ending right after usage_update must not roll over mid-turn");

    // Next turn arrives with persisted lastContextTokens=200_687 and stale 1M contextWindow: pre-turn compaction fires.
    let surface2 = Surface::default();
    let turns2 = Turns {
        summary: Some(Ok("PRE_TURN_MIXDOG_SUMMARY")),
        auto_compact: true,
        last_context_tokens: Some(200_687),
        context_window: Some(1_048_576),
        ..Turns::default()
    };
    let end2 = within(
        "pre-turn compaction turn",
        world.serve_with(
            &surface2,
            json!({ "role": "user", "content": "whoami" }),
            Some(held("sess-1")),
            Some("RULES"),
            "default",
            CancellationToken::new(),
            turns2,
        ),
    )
    .await;
    let text2 = completed_text(&end2);
    assert_eq!(world.logged("start acp"), 2, "pre-turn compaction retires old !closes server: {:?}", world.log());
    assert!(text2.contains("resumed=false"), "pre-turn compaction must not resume bloated sess-1: {text2}");
    assert!(text2.contains("PRE_TURN_MIXDOG_SUMMARY"), "fresh session must receive Mixdog pre-turn summary: {text2}");
    assert!(
        surface2.events().iter().any(|e| matches!(e, Event::Compact(CompactStatus::Compacted))),
        "pre-turn Compacted event emitted: {:?}",
        surface2.events()
    );
}

/// Mid-turn compaction failure emits `CompactStatus::Failed`, fails cleanly, and settles progress to `"error"`;
/// user cancellation during mid-turn compaction returns `TurnEnd::Interrupted`, ends the old session, and settles
/// progress to `"done"`.
#[tokio::test]
async fn mid_turn_compaction_failure_and_cancellation_stop_cleanly() {
    // 1. Compactor error during mid-turn rollover.
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    let (progress1, watched1) = tokio::sync::watch::channel(mixdog_core_run::run_host::progress::RunProgress::default());
    let turns = Turns {
        mid_turn_summary: Some(Err("compactor unavailable")),
        calls: Some(tools.calls(&surface)),
        auto_compact: true,
        progress: Some(progress1),
        ..Turns::default()
    };
    let end = world.ask(&surface, "midcompact 200687 1048576 read shell", turns).await;
    match &end {
        TurnEnd::Failed { message, .. } => assert!(message.contains("compactor unavailable"), "{message}"),
        other => panic!("expected TurnEnd::Failed on mid-turn compaction error, got {other:?}"),
    }
    assert!(
        surface.events().iter().any(|e| matches!(e, Event::Compact(CompactStatus::Failed))),
        "CompactStatus::Failed emitted on error: {:?}",
        surface.events()
    );
    assert_eq!(watched1.borrow().stage().as_deref(), Some("error"), "progress must settle to error on mid-turn compaction failure");

    // 2. Cancellation while `compact_mid_turn` is running.
    let (world2, tools2) = handing_in(World::official(&[]));
    let surface2 = Surface::default();
    let cancel = CancellationToken::new();
    let (progress2, watched2) = tokio::sync::watch::channel(mixdog_core_run::run_host::progress::RunProgress::default());
    let turns2 = Turns {
        stops_mid_turn_summary: Some(cancel.clone()),
        calls: Some(tools2.calls(&surface2)),
        auto_compact: true,
        progress: Some(progress2),
        ..Turns::default()
    };
    let end2 = within(
        "cancelled mid-turn compaction",
        world2.serve_with(
            &surface2,
            json!({ "role": "user", "content": "midcompact 200687 1048576 read shell" }),
            None,
            Some("RULES"),
            "default",
            cancel,
            turns2,
        ),
    )
    .await;
    assert!(matches!(end2, TurnEnd::Interrupted), "expected TurnEnd::Interrupted, got {end2:?}");
    assert!(world2.agents.running(&thread()).is_none(), "old agent session must be ended when cancelled mid-compaction");
    assert_eq!(watched2.borrow().stage().as_deref(), Some("done"), "progress must settle to done on cancel during compaction");
}

/// Deterministic rollover guard: a fresh session whose first live `usage_update` is already at or over the trigger
/// does not roll over again in that turn; whereas a fresh session that starts below the trigger and later crosses it
/// still rolls over normally.
#[tokio::test]
async fn mid_turn_compaction_no_progress_guard_prevents_infinite_rollover() {
    // 1. Fresh session's first usage_update is already >= trigger -> disabled for remainder of turn (1 rollover).
    {
        let (world, tools) = handing_in(World::official(&[("FAKE_AGENT_RECOMPACT", "200687 1048576")]));
        let surface = Surface::default();
        // The fresh session's `shell` call runs, and the session's gate asks the user about every `shell`.
        surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true })));
        let mid_compacts = Arc::new(AtomicUsize::new(0));
        let turns = Turns {
            summary: Some(Ok("GUARDED_SUMMARY")),
            calls: Some(tools.calls(&surface)),
            auto_compact: true,
            mid_turn_compacts: Some(mid_compacts.clone()),
            ..Turns::default()
        };

        let end = world.ask(&surface, "midcompact 200687 1048576 read shell", turns).await;
        let text = completed_text(&end);
        assert!(text.contains("continued-after-guard"), "fresh session must finish without second rollover: {text}");
        assert_eq!(world.logged("start acp"), 2, "first rollover retired old !closes server: {:?}", world.log());
        assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "fresh session already over trigger must not roll over again");
        let log = world.log();
        assert!(log.iter().any(|line| line == "recompact-continued"), "fresh session's tool must run once rollover is disabled: {log:?}");
    }

    // 2. Fresh session starts below trigger (50_000), then crosses trigger (200_687) -> rolls over a second time.
    {
        let (world, tools) = handing_in(World::official(&[("FAKE_AGENT_RECOMPACT", "50000 200687 1048576")]));
        let surface = Surface::default();
        let mid_compacts = Arc::new(AtomicUsize::new(0));
        let turns = Turns {
            summary: Some(Ok("SECOND_ROLLOVER_SUMMARY")),
            calls: Some(tools.calls(&surface)),
            auto_compact: true,
            mid_turn_compacts: Some(mid_compacts.clone()),
            ..Turns::default()
        };

        let end = world.ask(&surface, "midcompact 200687 1048576 read shell", turns).await;
        let text = completed_text(&end);
        assert!(text.contains("SECOND_ROLLOVER_SUMMARY"), "fresh session starting below trigger must roll over again on later crossing: {text}");
        assert_eq!(world.logged("start acp"), 3, "each rollover retires the old !closes server: {:?}", world.log());
        assert_eq!(mid_compacts.load(Ordering::SeqCst), 2, "must roll over twice when fresh session started below trigger");
    }
}

/// Review 1: an open agent-owned tool call prevents rollover until it completes; while waiting for that quiet point,
/// a Mixdog tool request is answered normally (never deferred/refused), and once the agent call closes with its real
/// result Mixdog sends `session/cancel`, observes the prompt response, and rolls over cleanly.
#[tokio::test]
async fn mid_turn_compaction_waits_for_open_agent_tool_call_before_rolling_over() {
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns {
        summary: Some(Ok("OPEN_AGENT_SUMMARY")),
        calls: Some(tools.calls(&surface)),
        auto_compact: true,
        mid_turn_compacts: Some(mid_compacts.clone()),
        ..Turns::default()
    };

    let end = world.ask(&surface, "openagentcompact 200687 1048576 read", turns).await;
    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction must fire once after open agent call finishes");
    assert!(text.contains("resumed=false"), "fresh session continued turn: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());
    assert!(text.contains("OPEN_AGENT_SUMMARY"), "fresh session received Mixdog summary: {text}");

    let tool_results: Vec<String> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body.to_string()),
            _ => None,
        })
        .collect();
    assert!(
        tool_results.iter().any(|row| row.contains("BUILD_OK_REAL_RESULT")),
        "open agent call must commit its real result before rollover: {tool_results:?}"
    );
    let ran_tools: Vec<String> = tools.ran.lock().unwrap().iter().map(|(_, name, _)| name.clone()).collect();
    assert_eq!(ran_tools, vec!["read".to_owned()], "Mixdog tool requested while agent call is open must run normally");

    let log = world.log();
    assert!(log.iter().any(|line| line == "open-agent-mixdog-ok"), "Mixdog tool must be answered while agent call is open: {log:?}");
    let done_idx = log.iter().position(|line| line == "open-agent-a1-completed").expect("a1 completed logged");
    let cancel_idx = log.iter().position(|line| line == "session/cancel").expect("session/cancel logged");
    assert!(done_idx < cancel_idx, "session/cancel ({cancel_idx}) must wait until a1 completes ({done_idx}): {log:?}");
}

/// An already-running (`in_progress`) agent-owned `tool_call` arriving after `usage_update` armed mid-turn compaction
/// is recorded (not dropped), allowed to finish and commit its real result, and then rolled over cleanly.
#[tokio::test]
async fn mid_turn_compaction_records_in_progress_agent_tool_call_started_after_usage_update() {
    let world = World::official(&[]);
    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns { summary: Some(Ok("LATE_AGENT_SUMMARY")), auto_compact: true, mid_turn_compacts: Some(mid_compacts.clone()), ..Turns::default() };

    let end = world.ask(&surface, "lateagentcall 200687 1048576", turns).await;
    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once after late in-progress call finishes");
    assert!(text.contains("resumed=false"), "fresh session continued turn: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());
    assert!(text.contains("LATE_AGENT_SUMMARY"), "fresh session received Mixdog summary: {text}");

    let commits: Vec<Value> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) => Some(item.body),
            _ => None,
        })
        .collect();
    let has_call = commits.iter().any(|row| row.get("role").and_then(Value::as_str) == Some("assistant") && row.to_string().contains("echo late"));
    let has_real_result = commits.iter().any(|row| row.get("role").and_then(Value::as_str) == Some("tool") && row.to_string().contains("LATE_CALL_OUTPUT"));
    let has_placeholder = commits.iter().any(|row| row.to_string().contains("Context compacted; continuing in a fresh session."));
    assert!(has_call, "in-progress agent tool_call must be recorded, not dropped: {commits:?}");
    assert!(has_real_result, "in-progress agent tool_call must commit its real output before rollover: {commits:?}");
    assert!(!has_placeholder, "late in-progress agent call must not be closed with a placeholder: {commits:?}");
}

/// A permission request with no earlier `tool_call`, arriving after the context crossed the trigger at a quiet point,
/// opens its call's card as in any turn: the user answers it, the call commits its real result, and only then is
/// `session/cancel` sent and the turn rolled over.
#[tokio::test]
async fn mid_turn_compaction_opens_card_for_permission_without_prior_tool_call() {
    let world = World::official(&[]);
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true })));
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns { summary: Some(Ok("CANCEL_ORDER_SUMMARY")), auto_compact: true, mid_turn_compacts: Some(mid_compacts.clone()), ..Turns::default() };

    let end = world.ask(&surface, "cancelorder 200687 1048576", turns).await;
    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once");
    assert!(text.contains("resumed=false"), "fresh session continued turn: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());

    let log = world.log();
    assert!(log.iter().any(|line| line == "permission answered sess-1 selected"), "the user's approval must answer the permission: {log:?}");
    let done_idx = log.iter().position(|line| line == "pending-perm-p1-completed").unwrap_or_else(|| panic!("p1 must complete: {log:?}"));
    let cancel_idx = log.iter().position(|line| line == "session/cancel").unwrap_or_else(|| panic!("missing session/cancel in log: {log:?}"));
    assert!(done_idx < cancel_idx, "session/cancel ({cancel_idx}) must follow p1's completion ({done_idx}): {log:?}");

    let tool_rows: Vec<Value> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
            _ => None,
        })
        .collect();
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("P1_APPROVED_RESULT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "p1 keeps its real result: {tool_rows:?}"
    );
}

/// A rollover whose `session/cancel` the agent answers with an error leaves the agent's session behind: the header
/// stops naming it, its process ends, and the next turn opens a fresh session instead of resuming the one that holds
/// the refusal "Context compacted".
#[tokio::test]
async fn mid_turn_compaction_cancel_ending_in_agent_error_leaves_old_session_behind() {
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns {
        summary: Some(Ok("SHOULD_NOT_COMPACT")),
        calls: Some(tools.calls(&surface)),
        auto_compact: true,
        mid_turn_compacts: Some(mid_compacts.clone()),
        ..Turns::default()
    };

    let end = world.ask(&surface, "cancelerror 200687 1048576", turns).await;
    assert!(matches!(end, TurnEnd::Failed { .. }), "the agent's error fails the turn: {end:?}");
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 0, "no rollover without the cancel's answer");
    let log = world.log();
    assert!(log.iter().any(|line| line == "cancel-error-refused"), "the Mixdog tool is refused as compacted after session/cancel: {log:?}");
    assert!(world.agents.running(&thread()).is_none(), "the left-behind session's process ended");

    let stored = surface.events().into_iter().fold(None, |stored, event| match event {
        Event::Header(change) if change.unset.iter().any(|key| key == SESSION_KEY) => None,
        Event::Header(change) => change.set.get(SESSION_KEY).and_then(|value| value["sessionId"].as_str()).map(held).or(stored),
        _ => stored,
    });
    assert_eq!(stored, None, "the header no longer names the left-behind session: {:?}", surface.events());

    let next = Surface::default();
    let end2 = within(
        "the next turn",
        world.serve_with(&next, json!({ "role": "user", "content": "whoami" }), stored, Some("RULES"), "default", CancellationToken::new(), Turns::default()),
    )
    .await;
    let text2 = completed_text(&end2);
    assert!(text2.contains("resumed=false") && text2.contains("loaded=false"), "the next turn opens a fresh session: {text2}");
    assert_eq!(world.logged("session/new"), 2, "the next turn opens a new session instead of reusing the left-behind one: {:?}", world.log());
}

/// A call the agent kept running from an earlier turn counts as open: crossing the trigger while it runs answers a
/// Mixdog tool as in any turn, and `session/cancel` waits until that call ends.
#[tokio::test]
async fn mid_turn_compaction_waits_for_call_kept_running_from_earlier_turn() {
    let (world, tools) = handing_in(World::official(&[]));
    let first = Surface::default();
    let end1 = within(
        "the first turn",
        world.serve_with(&first, json!({ "role": "user", "content": "keep" }), None, Some("RULES"), "default", CancellationToken::new(), Turns::default()),
    )
    .await;
    assert!(completed_text(&end1).contains("kept"), "{end1:?}");

    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns {
        summary: Some(Ok("KEPT_SUMMARY")),
        calls: Some(tools.calls(&surface)),
        auto_compact: true,
        mid_turn_compacts: Some(mid_compacts.clone()),
        ..Turns::default()
    };
    let end = within(
        "the rollover turn",
        world.serve_with(
            &surface,
            json!({ "role": "user", "content": "keptcompact 200687 1048576" }),
            Some(held("sess-1")),
            Some("RULES"),
            "default",
            CancellationToken::new(),
            turns,
        ),
    )
    .await;
    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once the kept call ends");
    assert!(text.contains("resumed=false") && text.contains("KEPT_SUMMARY"), "fresh session continued turn: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());

    let log = world.log();
    assert!(log.iter().any(|line| line == "kept-mixdog-ok"), "the Mixdog tool runs while the kept call is open: {log:?}");
    let done_idx = log.iter().position(|line| line == "kept-call-completed").unwrap_or_else(|| panic!("kept call must complete: {log:?}"));
    let cancel_idx = log.iter().position(|line| line == "session/cancel").unwrap_or_else(|| panic!("missing session/cancel in log: {log:?}"));
    assert!(done_idx < cancel_idx, "session/cancel ({cancel_idx}) must wait for the kept call ({done_idx}): {log:?}");
    let ran_tools: Vec<String> = tools.ran.lock().unwrap().iter().map(|(_, name, _)| name.clone()).collect();
    assert_eq!(ran_tools, vec!["read".to_owned()], "the Mixdog tool ran");
}

/// The segment a rollover cancels reports its usage, as every other end of a segment does.
#[tokio::test]
async fn mid_turn_compaction_reports_cancelled_segment_usage() {
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    let turns = Turns { summary: Some(Ok("USAGE_SUMMARY")), calls: Some(tools.calls(&surface)), auto_compact: true, ..Turns::default() };

    let end = world.ask(&surface, "midcompact 200687 1048576 read shell", turns).await;
    completed_text(&end);
    let usages: Vec<TurnUsage> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Usage(u) => Some(u),
            _ => None,
        })
        .collect();
    assert_eq!(usages.len(), 2, "one usage report per segment: {usages:?}");
    assert_eq!(usages[0].context.map(|context| context.used), Some(200_687), "the cancelled segment reports its context: {usages:?}");
    assert_eq!(usages[0].tool_calls, 1, "the cancelled segment reports its tool call: {usages:?}");
}

/// On mid-turn rollover, the fresh session still receives the turn's image and file attachments (both when the agent
/// supports embedded resources and when text files are sent as inline text blocks).
#[tokio::test]
async fn mid_turn_compaction_resends_turn_image_and_file_attachments_to_fresh_session() {
    let input = || {
        json!({
            "role": "user",
            "content": [
                { "type": "image", "mimeType": "image/png", "attachmentRef": "stored" },
                { "type": "text", "attachmentRef": "note", "filename": "note.md" },
                { "type": "file", "mimeType": "application/pdf", "attachmentRef": "paper", "filename": "paper.pdf" },
                { "type": "text", "text": "midcompact 200687 1048576 read shell" },
            ]
        })
    };

    // 1. Agent with embeddedContext enabled: image block + embedded `resource` (note) + `resource_link` (paper).
    let (embedded_world, embedded_tools) = handing_in(World::official(&[("FAKE_AGENT_EMBEDDED", "1")]));
    let embedded_surface = Surface::default();
    let embedded_turns =
        Turns { summary: Some(Ok("ATTACH_EMBEDDED_SUMMARY")), calls: Some(embedded_tools.calls(&embedded_surface)), auto_compact: true, ..Turns::default() };
    let embedded_end = within(
        "embedded mid-turn rollover with attachments",
        embedded_world.serve_with(&embedded_surface, input(), None, Some("RULES"), "default", CancellationToken::new(), embedded_turns),
    )
    .await;
    let embedded_text = completed_text(&embedded_end);
    assert!(embedded_text.contains("resumed=false"), "fresh session answered: {embedded_text}");
    assert_eq!(embedded_world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", embedded_world.log());
    assert!(embedded_text.contains("images=1"), "fresh session must receive turn image block: {embedded_text}");
    let (_, embedded_files_raw) = embedded_text.rsplit_once(" files=").expect("files suffix");
    let embedded_files: Value = serde_json::from_str(embedded_files_raw).expect("files json");
    let expected_note = json!({
        "type": "resource",
        "resource": { "uri": "file:///C:/data%20dir/blobs/note", "mimeType": "text/plain", "text": "# Notes\nplover" }
    });
    let expected_paper = json!({
        "type": "resource_link",
        "uri": "file:///C:/data%20dir/blobs/paper",
        "name": "paper.pdf",
        "mimeType": "application/pdf"
    });
    assert_eq!(embedded_files, json!([expected_note, expected_paper]), "fresh session must receive embedded + linked file blocks");

    // 2. Agent without embeddedContext: image block + `[Attached file: note.md]` text block + `resource_link` (paper).
    let (plain_world, plain_tools) = handing_in(World::official(&[]));
    let plain_surface = Surface::default();
    let plain_turns =
        Turns { summary: Some(Ok("ATTACH_PLAIN_SUMMARY")), calls: Some(plain_tools.calls(&plain_surface)), auto_compact: true, ..Turns::default() };
    let plain_end = within(
        "plain mid-turn rollover with attachments",
        plain_world.serve_with(&plain_surface, input(), None, Some("RULES"), "default", CancellationToken::new(), plain_turns),
    )
    .await;
    let plain_text = completed_text(&plain_end);
    assert!(plain_text.contains("resumed=false"), "fresh session answered: {plain_text}");
    assert_eq!(plain_world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", plain_world.log());
    assert!(plain_text.contains("images=1"), "fresh session must receive turn image block: {plain_text}");
    assert!(plain_text.contains("[Attached file: note.md]\n# Notes\nplover"), "fresh session must receive inline text attachment: {plain_text}");
    let (_, plain_files_raw) = plain_text.rsplit_once(" files=").expect("files suffix");
    let plain_files: Value = serde_json::from_str(plain_files_raw).expect("files json");
    assert_eq!(plain_files, json!([expected_paper]), "fresh session must receive resource_link file block");
}

/// Review 2 P1: a `tool_call` with status `pending`, omitted status (ACP default `pending`), or `in_progress` counts
/// as open; when `session/request_permission` arrives after crossing the compaction trigger, Mixdog answers it
/// normally (never deferring or freezing), lets the call finish with its real result, and rolls over at the quiet
/// point after it completes.
#[tokio::test]
async fn mid_turn_compaction_does_not_freeze_on_pending_or_permission_held_agent_call() {
    for mode in ["pending", "nostatus", "inprogress", "after_nostatus"] {
        let world = World::official(&[]);
        let surface = Surface::default();
        surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true })));
        let mid_compacts = Arc::new(AtomicUsize::new(0));
        let turns = Turns { summary: Some(Ok("P1_SUMMARY")), auto_compact: true, mid_turn_compacts: Some(mid_compacts.clone()), ..Turns::default() };

        let end = world.ask(&surface, &format!("pendingpermcompact {mode} 200687 1048576"), turns).await;
        let text = completed_text(&end);
        assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mode={mode}: mid-turn compaction fires once after p1 completes");
        assert!(text.contains("resumed=false"), "mode={mode}: fresh session continued: {text}");
        assert_eq!(world.logged("start acp"), 2, "mode={mode}: rollover retires old !closes server: {:?}", world.log());
        assert!(text.contains("P1_SUMMARY"), "mode={mode}: fresh session received summary: {text}");

        let log = world.log();
        let done_idx =
            log.iter().position(|line| line == "pending-perm-p1-completed").unwrap_or_else(|| panic!("mode={mode}: p1 must complete before cancel: {log:?}"));
        let cancel_idx = log.iter().position(|line| line == "session/cancel").unwrap_or_else(|| panic!("mode={mode}: missing session/cancel: {log:?}"));
        assert!(done_idx < cancel_idx, "mode={mode}: session/cancel ({cancel_idx}) must follow p1 completion ({done_idx}): {log:?}");

        let tool_rows: Vec<Value> = surface
            .events()
            .into_iter()
            .filter_map(|e| match e {
                Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
                _ => None,
            })
            .collect();
        assert_eq!(tool_rows.len(), 1, "mode={mode}: p1 committed once: {tool_rows:?}");
        assert_eq!(tool_rows[0].get("toolKind").and_then(Value::as_str), Some("normal"), "mode={mode}: p1 keeps its real normal result: {:?}", tool_rows[0]);
        assert!(tool_rows[0].to_string().contains("P1_APPROVED_RESULT"), "mode={mode}: p1 keeps its real output: {:?}", tool_rows[0]);
    }
}

/// If a permission request was approved before `usage_update` crossed the trigger, the agent may execute the tool
/// without emitting an intermediate `in_progress` update: Mixdog waits for its completion so its real result commits
/// before rolling over.
#[tokio::test]
async fn mid_turn_compaction_waits_for_approved_permission_call_without_in_progress_update() {
    let world = World::official(&[]);
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true })));
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns { summary: Some(Ok("APPROVED_PERM_SUMMARY")), auto_compact: true, mid_turn_compacts: Some(mid_compacts.clone()), ..Turns::default() };

    let end = world.ask(&surface, "approvedpermcompact 200687 1048576", turns).await;
    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once after approved call completes");
    assert!(text.contains("resumed=false"), "fresh session continued: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());
    assert!(text.contains("APPROVED_PERM_SUMMARY"), "fresh session received summary: {text}");

    let tool_rows: Vec<Value> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
            _ => None,
        })
        .collect();
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("APPROVED_CMD_OUTPUT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "approved call must keep its real completed result: {tool_rows:?}"
    );
}

/// A `pending` agent call opened before `usage_update` that transitions to `in_progress` without requesting permission
/// is waited on until completion so its real result commits before rollover.
#[tokio::test]
async fn mid_turn_compaction_waits_when_pending_call_starts_in_progress_after_usage_update() {
    let world = World::official(&[]);
    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns { summary: Some(Ok("PENDING_STARTED_SUMMARY")), auto_compact: true, mid_turn_compacts: Some(mid_compacts.clone()), ..Turns::default() };

    let end = world.ask(&surface, "pendingstartscompact 200687 1048576", turns).await;
    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once after call finishes");
    assert!(text.contains("resumed=false"), "fresh session continued: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());
    assert!(text.contains("PENDING_STARTED_SUMMARY"), "fresh session received summary: {text}");

    let tool_rows: Vec<Value> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
            _ => None,
        })
        .collect();
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("AUTO_STARTED_OUTPUT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "auto-started call must keep its real result: {tool_rows:?}"
    );
}

/// Review 3 P1 #1: an auto-allowed call `a1` that stays `pending` (no `in_progress` update) alongside sibling `b1`
/// must not be killed or recorded as unstarted when `b1` completes after `usage_update` crosses the trigger; rollover
/// waits until `a1` completes too and keeps both real results.
#[tokio::test]
async fn mid_turn_compaction_waits_for_pending_call_without_in_progress_when_sibling_completes() {
    let world = World::official(&[]);
    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns { summary: Some(Ok("PENDING_PARALLEL_SUMMARY")), auto_compact: true, mid_turn_compacts: Some(mid_compacts.clone()), ..Turns::default() };

    let end = world.ask(&surface, "pendingparallelcompact 200687 1048576", turns).await;
    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once after both a1 and b1 complete");
    assert!(text.contains("resumed=false") && text.contains("PENDING_PARALLEL_SUMMARY"), "fresh session continued: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());

    let log = world.log();
    let done_idx = log.iter().position(|line| line == "pending-parallel-a1-completed").expect("a1 completed logged");
    let cancel_idx = log.iter().position(|line| line == "session/cancel").expect("session/cancel logged");
    assert!(done_idx < cancel_idx, "session/cancel ({cancel_idx}) must wait for pending a1 ({done_idx}): {log:?}");

    let tool_rows: Vec<Value> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
            _ => None,
        })
        .collect();
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("B1_REAL_RESULT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "b1 keeps its real result: {tool_rows:?}"
    );
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("A1_PENDING_REAL_RESULT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "pending a1 keeps its real result: {tool_rows:?}"
    );
}

/// Review 3 P1 #2: when an in-flight parent call `a1` issues a child `session/request_permission` and a Mixdog MCP
/// `tools/call` after `usage_update` crosses the trigger, neither is deferred or refused so `a1` cannot freeze; all
/// calls keep their real results and rollover happens once `a1` completes.
#[tokio::test]
async fn mid_turn_compaction_does_not_freeze_when_in_flight_call_issues_child_permission_and_mixdog_tool() {
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    surface.0.answers.lock().unwrap().push_back(decided(json!({ "approved": true })));
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns {
        summary: Some(Ok("SUBAGENT_CHILD_SUMMARY")),
        calls: Some(tools.calls(&surface)),
        auto_compact: true,
        mid_turn_compacts: Some(mid_compacts.clone()),
        ..Turns::default()
    };

    let end = world.ask(&surface, "subagentchildcompact 200687 1048576", turns).await;
    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once after parent a1 completes");
    assert!(text.contains("resumed=false") && text.contains("SUBAGENT_CHILD_SUMMARY"), "fresh session continued: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());

    let log = world.log();
    assert!(log.iter().any(|line| line == "subagent-read-ok"), "Mixdog child tool must be answered normally while a1 is open: {log:?}");
    let done_idx = log.iter().position(|line| line == "parent-a1-completed").expect("parent a1 completed logged");
    let cancel_idx = log.iter().position(|line| line == "session/cancel").expect("session/cancel logged");
    assert!(done_idx < cancel_idx, "session/cancel ({cancel_idx}) must wait for parent a1 ({done_idx}): {log:?}");

    let tool_rows: Vec<Value> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
            _ => None,
        })
        .collect();
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("CHILD1_REAL_RESULT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "child permission call keeps its real result: {tool_rows:?}"
    );
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("PARENT_A1_REAL_RESULT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "parent a1 keeps its real result: {tool_rows:?}"
    );
    let ran_tools: Vec<String> = tools.ran.lock().unwrap().iter().map(|(_, name, _)| name.clone()).collect();
    assert_eq!(ran_tools, vec!["read".to_owned()], "Mixdog child tool ran normally while a1 was open");
}

/// Review 3 P1 #3: forwarded text, thought, plan, child call completion, and multiple `usage_update`s never demote an
/// open call `a1`; rollover waits until `a1` completes and preserves every call's real result.
#[tokio::test]
async fn mid_turn_compaction_waits_for_open_call_across_text_thought_plan_child_calls_and_multiple_usage_updates() {
    let world = World::official(&[]);
    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns { summary: Some(Ok("SUBAGENT_ACTIVITY_SUMMARY")), auto_compact: true, mid_turn_compacts: Some(mid_compacts.clone()), ..Turns::default() };

    let end = world.ask(&surface, "subagentactivitycompact 200687 1048576", turns).await;
    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once after a1 completes");
    assert!(text.contains("resumed=false") && text.contains("SUBAGENT_ACTIVITY_SUMMARY"), "fresh session continued: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());

    let log = world.log();
    let done_idx = log.iter().position(|line| line == "subagent-activity-a1-completed").expect("a1 completed logged");
    let cancel_idx = log.iter().position(|line| line == "session/cancel").expect("session/cancel logged");
    assert!(done_idx < cancel_idx, "session/cancel ({cancel_idx}) must wait for a1 ({done_idx}): {log:?}");

    let tool_rows: Vec<Value> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
            _ => None,
        })
        .collect();
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("C1_REAL_RESULT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "child call c1 keeps its real result: {tool_rows:?}"
    );
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("A1_AFTER_ACTIVITY_RESULT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "open call a1 keeps its real result: {tool_rows:?}"
    );
}

/// Review 2 P2 / no quiet point before turn end: when an open call `bg1` remains open until `end_turn`, no mid-turn
/// rollover occurs, nothing is killed or falsely recorded as error/interrupted, `bg1` is handed off as a normal
/// background call, and the next turn compacts pre-turn.
#[tokio::test]
async fn mid_turn_compaction_skips_rollover_when_open_call_never_reaches_quiet_point_before_turn_end() {
    let world = World::official(&[]);
    let surface1 = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns1 =
        Turns { summary: Some(Ok("SHOULD_NOT_ROLL_OVER_MID_TURN")), auto_compact: true, mid_turn_compacts: Some(mid_compacts.clone()), ..Turns::default() };

    let end1 = world.ask(&surface1, "bgneverquietcompact 200687 1048576", turns1).await;
    assert!(matches!(end1, TurnEnd::Completed { .. }), "turn must complete normally without mid-turn rollover: {end1:?}");
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 0, "no mid-turn rollover without a quiet point");

    let tool_rows: Vec<Value> = surface1
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
            _ => None,
        })
        .collect();
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("C1_REAL_RESULT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "completed call c1 keeps its real result: {tool_rows:?}"
    );
    assert!(
        tool_rows
            .iter()
            .any(|row| row.to_string().contains("Still running in the agent's background.") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "open call bg1 handed off normally as background, never error: {tool_rows:?}"
    );

    // Next turn compacts pre-turn onto a fresh session.
    let surface2 = Surface::default();
    let turns2 = Turns {
        summary: Some(Ok("NEXT_TURN_PRE_COMPACT_SUMMARY")),
        auto_compact: true,
        last_context_tokens: Some(200_687),
        context_window: Some(1_048_576),
        ..Turns::default()
    };
    let end2 = within(
        "pre-turn compaction after non-quiet turn",
        world.serve_with(
            &surface2,
            json!({ "role": "user", "content": "whoami" }),
            Some(held("sess-1")),
            Some("RULES"),
            "default",
            CancellationToken::new(),
            turns2,
        ),
    )
    .await;
    let text2 = completed_text(&end2);
    assert!(text2.contains("resumed=false") && text2.contains("NEXT_TURN_PRE_COMPACT_SUMMARY"), "next turn compacted pre-turn: {text2}");
    assert_eq!(world.logged("start acp"), 2, "pre-turn compaction retires old !closes server: {:?}", world.log());
}

/// When a Mixdog tool and an agent-owned tool are both in flight as `usage_update` crosses the trigger, `slow`
/// finishing first while `a1` is still open delivers its real answer normally (nothing deferred/refused), and rollover
/// occurs at the quiet point once `a1` completes too with both real results committed.
#[tokio::test]
async fn mid_turn_compaction_waits_for_parallel_mixdog_and_agent_calls_to_both_commit() {
    let (world, tools) = handing_in(World::official(&[]));
    let surface = Surface::default();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let turns = Turns {
        summary: Some(Ok("PARALLEL_SUMMARY")),
        calls: Some(tools.calls(&surface)),
        auto_compact: true,
        mid_turn_compacts: Some(mid_compacts.clone()),
        ..Turns::default()
    };

    let release = tools.release.clone();
    let releaser = tokio::spawn(async move {
        // Release `slow` before the agent finishes `a1` so Mixdog finishes first and delivers normally while waiting for `a1`.
        tokio::time::sleep(Duration::from_millis(60)).await;
        release.add_permits(1);
    });
    let end = world.ask(&surface, "parallelcompact 200687 1048576 slow", turns).await;
    releaser.await.expect("releaser task");

    let text = completed_text(&end);
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 1, "mid-turn compaction fires once after both parallel calls finish");
    assert!(text.contains("resumed=false") && text.contains("PARALLEL_SUMMARY"), "fresh session continued: {text}");
    assert_eq!(world.logged("start acp"), 2, "rollover retires old !closes server: {:?}", world.log());

    let log = world.log();
    assert!(log.iter().any(|line| line == "parallel-slow-answered"), "slow answer must be delivered while a1 is still open: {log:?}");
    let done_idx = log.iter().position(|line| line == "parallel-a1-completed").expect("a1 completed logged");
    let cancel_idx = log.iter().position(|line| line == "session/cancel").expect("session/cancel logged");
    assert!(done_idx < cancel_idx, "session/cancel ({cancel_idx}) must wait for a1 ({done_idx}): {log:?}");

    let tool_rows: Vec<Value> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
            _ => None,
        })
        .collect();
    assert_eq!(tool_rows.len(), 2, "both slow and a1 committed their tool result rows: {tool_rows:?}");
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("PARALLEL_A1_RESULT") && row.get("toolKind").and_then(Value::as_str) == Some("normal")),
        "parallel agent call keeps its real result: {tool_rows:?}"
    );
}

/// Cancelling a turn while waiting for a quiet point closes the open call as cancelled error, settles progress, and
/// returns `TurnEnd::Interrupted` without rolling over.
#[tokio::test]
async fn cancel_during_mid_turn_compaction_drain_stops_cleanly() {
    let world = World::official(&[]);
    let surface = Surface::default();
    let cancel = CancellationToken::new();
    let mid_compacts = Arc::new(AtomicUsize::new(0));
    let (progress, watched) = tokio::sync::watch::channel(mixdog_core_run::run_host::progress::RunProgress::default());
    let turns = Turns {
        summary: Some(Ok("SHOULD_NOT_COMPACT")),
        auto_compact: true,
        mid_turn_compacts: Some(mid_compacts.clone()),
        progress: Some(progress),
        ..Turns::default()
    };

    let cancel_trigger = cancel.clone();
    let log_path = world.dir.path().join("agent.log");
    let stopper = tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            #[allow(clippy::disallowed_methods, reason = "a test reads the fake agent's own log")]
            let ready = std::fs::read_to_string(&log_path).is_ok_and(|body| body.lines().any(|line| line == "canceldrain-sent"));
            if ready {
                tokio::time::sleep(Duration::from_millis(50)).await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cancel_trigger.cancel();
    });
    let end = within(
        "cancel while waiting for quiet point",
        world.serve_with(&surface, json!({ "role": "user", "content": "canceldraincompact 200687 1048576" }), None, Some("RULES"), "default", cancel, turns),
    )
    .await;
    stopper.await.expect("stopper task");

    assert!(matches!(end, TurnEnd::Interrupted), "expected TurnEnd::Interrupted, got {end:?}");
    assert_eq!(mid_compacts.load(Ordering::SeqCst), 0, "user cancel must not trigger mid-turn rollover");
    assert_eq!(watched.borrow().stage().as_deref(), Some("done"), "progress must settle to done on cancel");

    let tool_rows: Vec<Value> = surface
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Commit(item) if item.body.get("role").and_then(Value::as_str) == Some("tool") => Some(item.body),
            _ => None,
        })
        .collect();
    assert!(
        tool_rows.iter().any(|row| row.to_string().contains("Cancelled") && row.get("toolKind").and_then(Value::as_str) == Some("error")),
        "open call closed as cancelled error: {tool_rows:?}"
    );
}

#[tokio::test]
async fn acp_image_generate_and_edit_isolate_tools_stage_references_and_retire_shared_server() {
    let world = World::official(&[]);
    let image_gen = mixdog_acp::image::AgentImageGen::new(world.agents.clone());

    assert!(image_gen.authenticated("acp-antigravity").await, "installed & signed-in official server reports authenticated");
    assert_eq!(image_gen.unavailable_reason("acp-antigravity").await, None);
    // authenticated() and unavailable_reason() must read local state only, never starting a readiness check or spawning a process.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(world.log().is_empty(), "authenticated/unavailable_reason must not start a readiness check: {:?}", world.log());
    let rows = image_gen.catalog_models("acp-antigravity").await.expect("catalog models");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], mixdog_acp::image::IMAGE_MODEL_ID);

    // 1. Plain image generation.
    let generated = within(
        "acp image generate",
        image_gen.generate(
            mixdog_acp::image::AcpImageRequest {
                provider: "acp-antigravity".into(),
                prompt: "a sunset over mountains".into(),
                aspect_ratio: Some("16:9".into()),
                references: Vec::new(),
            },
            &CancellationToken::new(),
        ),
    )
    .await
    .expect("generate succeeds");
    assert_eq!(generated.mime, "image/jpeg");
    assert!(!generated.bytes.is_empty());
    assert_eq!(generated.revised_prompt.as_deref(), Some("refined sunset over mountains"));
    assert_eq!(generated.usage, Some(json!({ "inputTokens": 120, "cachedTokens": 40, "outputTokens": 35, "images": 1 })));
    // Generated image file and session brain folder in agent home must be removed after bytes are extracted.
    let agent_folder = home_of(world.dir.path(), "antigravity").join("antigravity-acp");
    #[allow(clippy::disallowed_methods, reason = "test checks brain cleanup")]
    let remaining_brain: usize = std::fs::read_dir(agent_folder.join("brain")).map(|d| d.count()).unwrap_or(0);
    assert_eq!(remaining_brain, 0, "generated image brain folder must be removed on success");
    assert!(exists(&agent_folder.join("settings.json")) && exists(&agent_folder.join("acp_token.json")), "sign-in files must stay intact");

    // Wait briefly for SharedServer retirement on stdin EOF after the non-closing image session ends.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline && !world.log().iter().any(|l| l == "eof") {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let log = world.log();
    let session_line = log.iter().find(|l| l.starts_with("image-session ")).expect("image-session logged");
    assert!(!session_line.contains("generate_image"), "generate_image must be enabled in image-only session: {session_line}");
    assert!(session_line.contains("search_web") && session_line.contains("run_command"), "other tools stay disabled: {session_line}");
    assert!(session_line.contains("mcp=0") && session_line.contains("fs_read=false"), "no MCP or fs.readTextFile: {session_line}");
    assert!(log.iter().any(|l| l == "eof"), "image-only session must retire shared server to avoid helper pileup: {log:?}");

    // 2. Edit with a staged reference image.
    let edited = within(
        "acp image edit",
        image_gen.generate(
            mixdog_acp::image::AcpImageRequest {
                provider: "acp-antigravity".into(),
                prompt: "add dramatic storm clouds".into(),
                aspect_ratio: Some("16:9".into()),
                references: vec![mixdog_acp::image::AcpImageReference {
                    bytes: b"\x89PNG\r\n\x1a\n12345678".to_vec(),
                    mime: "image/png".into(),
                    name: "source.png".into(),
                }],
            },
            &CancellationToken::new(),
        ),
    )
    .await
    .expect("edit succeeds");
    assert_eq!(edited.mime, "image/jpeg");
    assert!(!edited.bytes.is_empty());

    let log_after_edit = world.log();
    assert!(log_after_edit.iter().any(|l| l == "image-ref-bytes=16"), "fake agent read exact staged reference bytes: {log_after_edit:?}");
    // Sandbox folder must be cleaned up after completion.
    let sandbox_root = world.dir.path().join("acp-agents").join("image-sandbox");
    #[allow(clippy::disallowed_methods, reason = "test checks sandbox cleanup")]
    let remaining: usize = std::fs::read_dir(&sandbox_root).map(|d| d.count()).unwrap_or(0);
    assert_eq!(remaining, 0, "image sandbox directories must be cleaned up");

    // 3. Ordinary Antigravity chat session still keeps generate_image disabled.
    let surface = Surface::default();
    let end = world.ask(&surface, "meta", Turns::default()).await;
    let text = completed_text(&end);
    assert!(text.contains("generate_image"), "ordinary Antigravity session must keep generate_image disabled: {text}");
}

#[tokio::test]
async fn acp_image_refuses_disallowed_tools_and_out_of_sandbox_image_paths() {
    let world = World::official(&[]);
    let image_gen = mixdog_acp::image::AgentImageGen::new(world.agents.clone());

    let bad_path = within(
        "acp image bad path",
        image_gen.generate(
            mixdog_acp::image::AcpImageRequest {
                provider: "acp-antigravity".into(),
                prompt: "FAKE_IMG_BAD_PATH".into(),
                aspect_ratio: None,
                references: Vec::new(),
            },
            &CancellationToken::new(),
        ),
    )
    .await
    .expect_err("out-of-sandbox ImagePaths must be refused");
    assert_eq!(bad_path.kind, mixdog_acp::image::AcpImageErrorKind::Refusal);

    let other_tool = within(
        "acp image other tool",
        image_gen.generate(
            mixdog_acp::image::AcpImageRequest {
                provider: "acp-antigravity".into(),
                prompt: "FAKE_IMG_OTHER_TOOL".into(),
                aspect_ratio: None,
                references: Vec::new(),
            },
            &CancellationToken::new(),
        ),
    )
    .await
    .expect_err("non-generate_image tool must be refused");
    assert_eq!(other_tool.kind, mixdog_acp::image::AcpImageErrorKind::Refusal);

    let denied_count = world.log().iter().filter(|l| l.as_str() == "image-perm=denied").count();
    assert_eq!(denied_count, 2, "both disallowed calls must be denied at permission gate");
}

#[tokio::test]
async fn acp_image_surfaces_tool_failure_policy_refusal_and_auth_error_in_plain_words() {
    let world = World::official(&[]);
    let image_gen = mixdog_acp::image::AgentImageGen::new(world.agents.clone());

    let tool_fail = within(
        "acp image tool fail",
        image_gen.generate(
            mixdog_acp::image::AcpImageRequest {
                provider: "acp-antigravity".into(),
                prompt: "FAKE_IMG_TOOL_FAIL".into(),
                aspect_ratio: None,
                references: Vec::new(),
            },
            &CancellationToken::new(),
        ),
    )
    .await
    .expect_err("tool failure must return error");
    assert_eq!(tool_fail.kind, mixdog_acp::image::AcpImageErrorKind::Failed);
    assert!(tool_fail.message.contains("Could not read input image."), "unexpected tool failure message: {}", tool_fail.message);
    let brain_root = home_of(world.dir.path(), "antigravity").join("antigravity-acp").join("brain");
    #[allow(clippy::disallowed_methods, reason = "test checks brain cleanup on failure")]
    let remaining_after_fail: usize = std::fs::read_dir(&brain_root).map(|d| d.count()).unwrap_or(0);
    assert_eq!(remaining_after_fail, 0, "brain folder must be cleaned up on tool failure");

    let refused = within(
        "acp image policy refusal",
        image_gen.generate(
            mixdog_acp::image::AcpImageRequest {
                provider: "acp-antigravity".into(),
                prompt: "FAKE_IMG_POLICY_REFUSE".into(),
                aspect_ratio: None,
                references: Vec::new(),
            },
            &CancellationToken::new(),
        ),
    )
    .await
    .expect_err("policy refusal must return error");
    assert_eq!(refused.kind, mixdog_acp::image::AcpImageErrorKind::Refusal);
    assert!(refused.message.contains("violates content policy"), "unexpected refusal message: {}", refused.message);

    let auth_err = within(
        "acp image auth fail",
        image_gen.generate(
            mixdog_acp::image::AcpImageRequest {
                provider: "acp-antigravity".into(),
                prompt: "FAKE_IMG_AUTH_FAIL".into(),
                aspect_ratio: None,
                references: Vec::new(),
            },
            &CancellationToken::new(),
        ),
    )
    .await
    .expect_err("auth error must return sign-in error");
    assert_eq!(auth_err.kind, mixdog_acp::image::AcpImageErrorKind::SignIn);
    assert!(auth_err.message.contains("signed out"), "unexpected auth error message: {}", auth_err.message);
    assert!(!image_gen.authenticated("acp-antigravity").await, "auth error marks agent signed out");
}

#[tokio::test]
async fn acp_image_reads_file_only_output_from_agent_home() {
    let world = World::official(&[]);
    let image_gen = mixdog_acp::image::AgentImageGen::new(world.agents.clone());

    let reply = within(
        "acp image file-only output",
        image_gen.generate(
            mixdog_acp::image::AcpImageRequest {
                provider: "acp-antigravity".into(),
                prompt: "FAKE_IMG_FILE_ONLY".into(),
                aspect_ratio: None,
                references: Vec::new(),
            },
            &CancellationToken::new(),
        ),
    )
    .await
    .expect("file-only output from agent home succeeds");
    assert_eq!(reply.mime, "image/png");
    assert_eq!(reply.bytes, b"\x89PNG\r\n\x1a\nfile-only-bytes");
    let file_only_path = home_of(world.dir.path(), "antigravity").join("brain").join("fake-file-only").join("saved.png");
    assert!(!file_only_path.exists(), "file-only generated image must be deleted after its bytes are read");

    // Cancel after server wrote an in-flight image file in the session brain dir: must clean up the brain dir too.
    let cancel = CancellationToken::new();
    let cancel_trigger = cancel.clone();
    let log_dir = world.dir.path().to_path_buf();
    let cancel_task = tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            #[allow(clippy::disallowed_methods, reason = "test polls fake agent log")]
            let text = std::fs::read_to_string(log_dir.join("agent.log")).unwrap_or_default();
            if text.lines().any(|line| line == "image-cancel-wrote") {
                cancel_trigger.cancel();
                return;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    });
    let cancelled = within(
        "acp image cancel after write",
        image_gen.generate(
            mixdog_acp::image::AcpImageRequest {
                provider: "acp-antigravity".into(),
                prompt: "FAKE_IMG_CANCEL_AFTER_WRITE".into(),
                aspect_ratio: None,
                references: Vec::new(),
            },
            &cancel,
        ),
    )
    .await
    .expect_err("cancelled request returns Cancelled");
    let _ = cancel_task.await;
    assert_eq!(cancelled.kind, mixdog_acp::image::AcpImageErrorKind::Cancelled);
    let brain_root = home_of(world.dir.path(), "antigravity").join("antigravity-acp").join("brain");
    #[allow(clippy::disallowed_methods, reason = "test checks brain cleanup on cancel")]
    let remaining_after_cancel: usize = std::fs::read_dir(&brain_root).map(|d| d.count()).unwrap_or(0);
    assert_eq!(remaining_after_cancel, 0, "brain folder must be cleaned up on cancellation");
}

#[tokio::test]
async fn acp_image_reports_unavailable_causes_without_starting_readiness_check() {
    let world = World::official(&[]);
    let image_gen = mixdog_acp::image::AgentImageGen::new(world.agents.clone());

    // 1. ACP agents turned off.
    world.enabled.store(false, Ordering::SeqCst);
    assert!(!image_gen.authenticated("acp-antigravity").await);
    assert_eq!(image_gen.unavailable_reason("acp-antigravity").await.as_deref(), Some("ACP agents are turned off in Settings."));
    world.enabled.store(true, Ordering::SeqCst);

    // 2. Installed build too old: its build folder holds the helpers, as an install of it leaves them.
    let builds = world.dir.path().join("acp-agents").join("bin").join("antigravity");
    let installed_json = builds.join("installed.json");
    #[allow(clippy::disallowed_methods, reason = "test rewrites installed.json")]
    let orig_installed = std::fs::read_to_string(&installed_json).expect("installed.json");
    let mut parsed: Value = serde_json::from_str(&orig_installed).expect("valid json");
    parsed["version"] = json!("1.0.0");
    let Distribution::Registry { helpers, .. } = &world.preset.distribution else { panic!("the official server is a registry agent") };
    #[allow(clippy::disallowed_methods, reason = "test installs an old build")]
    {
        std::fs::create_dir_all(builds.join("1.0.0")).expect("the old build");
        for helper in helpers {
            std::fs::write(builds.join("1.0.0").join(helper), "").expect("the old build's helper");
        }
        std::fs::write(&installed_json, parsed.to_string()).expect("write old version");
    }
    assert!(!image_gen.authenticated("acp-antigravity").await);
    let too_old = image_gen.unavailable_reason("acp-antigravity").await.expect("too-old reason");
    assert!(too_old.contains("too old"), "expected too-old reason, got: {too_old}");

    // 3. Not installed.
    #[allow(clippy::disallowed_methods, reason = "test removes installed.json")]
    std::fs::remove_file(&installed_json).expect("remove installed.json");
    assert!(!image_gen.authenticated("acp-antigravity").await);
    let missing = image_gen.unavailable_reason("acp-antigravity").await.expect("not-installed reason");
    assert!(missing.contains("not installed"), "expected not-installed reason, got: {missing}");

    // 4. Installed and current, but signed out: unavailable_reason is None so sign-in prompt applies.
    #[allow(clippy::disallowed_methods, reason = "test restores installed.json")]
    std::fs::write(&installed_json, orig_installed).expect("restore installed.json");
    let token_file = home_of(world.dir.path(), "antigravity").join("antigravity-acp").join("acp_token.json");
    #[allow(clippy::disallowed_methods, reason = "test removes token")]
    std::fs::remove_file(&token_file).expect("remove token");
    assert!(!image_gen.authenticated("acp-antigravity").await);
    assert_eq!(image_gen.unavailable_reason("acp-antigravity").await, None);

    // None of the above checks may spawn a server or start a readiness check.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(world.log().is_empty(), "authenticated/unavailable_reason must never spawn a check: {:?}", world.log());
}

/// On a `!closes` shared server (official Antigravity), releasing a finished worker while a sibling turn is actively in
/// flight does not interrupt the active sibling; as soon as the sibling's turn finishes and the server becomes quiescent,
/// the server retires via EOF so the worker's helper process exits, and the sibling is reopened on a new server at once.
#[tokio::test]
async fn quiescent_retirement_waits_for_active_sibling_turn_then_retires_and_reopens_the_sibling() {
    let (world, tools) = handing_in(World::official(&[]));
    let (lead, worker) = (ThreadId::from("sess_lead"), ThreadId::from("sess_worker"));
    let cwd = world.cwd();

    assert!(world.answer_in(&lead, &cwd, "whoami").await.starts_with("session=sess-1"));
    assert!(world.answer_in(&worker, &cwd, "whoami").await.starts_with("session=sess-2"));
    let server = world.agents.running(&lead).expect("lead session").connection.clone();

    let surface = Surface::default();
    let lead_turn = world.prompt_with(&lead, &surface, r#"tool slow {}"#, Some("sess-1"), CancellationToken::new(), Some(tools.calls(&surface)));
    let release_during_turn = async {
        surface.until(|events| events.iter().any(|event| matches!(event, Event::Commit(_)))).await;
        world.agents.release(&worker);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!server.exited().is_cancelled(), "active lead turn must prevent premature retirement");
        tools.release.add_permits(1);
    };
    let (end, ()) = within("lead turn finishes while worker released", async { tokio::join!(lead_turn, release_during_turn) }).await;
    assert!(matches!(end, TurnEnd::Completed { .. }), "{end:?}");

    within("shared server retires once quiescent after lead turn", server.exited().cancelled()).await;
    assert_eq!(world.exit_of(server.handle()), Some(CLOSED));
    world.logs("session/resume sess-1").await;

    let resumed = within("lead on the new server", world.prompt_in(&lead, &cwd, &Surface::default(), "whoami", Some("sess-1"), CancellationToken::new())).await;
    assert!(completed_text(&resumed).starts_with("session=sess-1 resumed=true"), "{resumed:?}");
    assert_ne!(world.agents.running(&lead).expect("resumed lead").connection.handle(), server.handle());
    assert_eq!((world.logged("start acp"), world.logged("session/resume sess-1")), (2, 1), "{:?}", world.log());
}

/// A search-only session on a `!closes` shared server triggers quiescent retirement when it finishes so its helper
/// process does not outlive the search while an idle Lead session is held.
#[tokio::test]
async fn search_only_session_on_no_close_shared_server_retires_when_quiescent() {
    use mixdog_tools::web::AcpSearchBackend;
    use mixdog_tools::web::AcpSearchRequest;

    let world = World::official(&[]);
    let lead = ThreadId::from("sess_lead");
    let cwd = world.cwd();

    assert!(world.answer_in(&lead, &cwd, "whoami").await.starts_with("session=sess-1"));
    let server = world.agents.running(&lead).expect("lead session").connection.clone();

    let search = mixdog_acp::search::AgentWebSearch::new(world.agents.clone());
    let request = AcpSearchRequest {
        provider: "acp-antigravity".into(),
        model: "default".into(),
        effort: None,
        query: "whoami".into(),
        site: None,
        locale: None,
        max_results: 5,
        context_size: "low".into(),
    };
    let reply = within("search-only session", search.search(request, &CancellationToken::new())).await.expect("search reply");
    assert!(!reply.answer.is_empty(), "{reply:?}");

    within("server retires after search-only session ends", server.exited().cancelled()).await;
    world.logs("session/resume sess-1").await;

    let resumed =
        within("lead after search retirement", world.prompt_in(&lead, &cwd, &Surface::default(), "whoami", Some("sess-1"), CancellationToken::new())).await;
    assert!(completed_text(&resumed).starts_with("session=sess-1 resumed=true"), "{resumed:?}");
    assert_eq!((world.logged("start acp"), world.logged("session/resume sess-1")), (2, 1), "{:?}", world.log());
    // The ended search session is not among the sessions the replacement server reopens.
    assert_eq!(world.logged("session/resume"), 1, "{:?}", world.log());
}

/// Changing rules on a `!closes` shared server retires the old server instead of pinning the replaced session's helper
/// process across the reopen.
#[tokio::test]
async fn rules_change_on_no_close_shared_server_retires_old_server_instead_of_pinning_replaced_session() {
    let world = World::official(&[]);
    let surface1 = Surface::default();
    let end1 = within(
        "first rules turn",
        world.serve_with(
            &surface1,
            json!({ "role": "user", "content": "whoami" }),
            None,
            Some("RULES-V1"),
            "default",
            CancellationToken::new(),
            Turns::default(),
        ),
    )
    .await;
    assert!(completed_text(&end1).contains("append=RULES-V1"), "{end1:?}");
    let server1 = world.agents.running(&thread()).expect("server1 session").connection.clone();

    let surface2 = Surface::default();
    let end2 = within(
        "changed rules turn",
        world.serve_with(
            &surface2,
            json!({ "role": "user", "content": "whoami" }),
            Some(held("sess-1")),
            Some("RULES-V2"),
            "default",
            CancellationToken::new(),
            Turns::default(),
        ),
    )
    .await;
    let text2 = completed_text(&end2);
    assert!(text2.contains("resumed=false") && text2.contains("append=RULES-V2"), "{text2}");
    within("old server retired on rules change", server1.exited().cancelled()).await;
    assert_ne!(world.agents.running(&thread()).expect("server2 session").connection.handle(), server1.handle());
    assert_eq!(world.logged("start acp"), 2, "{:?}", world.log());
}

/// The session a retired `!closes` server held for a loaded thread is reopened on a new server at once: a turn that comes
/// while that reopen is under way waits for it instead of opening a second one, and the reopened session keeps what the
/// user approved and the calls its predecessor kept running.
#[tokio::test]
async fn a_turn_during_the_background_reopen_of_its_session_joins_it() {
    let world = World::official(&[("FAKE_AGENT_RESUME_UNTIL", "answer-the-resume")]);
    let (lead, worker) = (ThreadId::from("sess_lead"), ThreadId::from("sess_worker"));
    let cwd = world.cwd();
    assert!(world.answer_in(&lead, &cwd, "whoami").await.starts_with("session=sess-1"));
    assert!(world.answer_in(&worker, &cwd, "whoami").await.starts_with("session=sess-2"));
    let held = world.agents.running(&lead).expect("lead session");
    held.keep_call("read".into(), json!({ "path": "a.txt" }), "task-1".into());
    let server = held.connection.clone();

    world.agents.release(&worker);
    within("the retired server's exit", server.exited().cancelled()).await;
    world.logs("session/resume sess-1").await;
    let surface = Surface::default();
    let turn = world.prompt_in(&lead, &cwd, &surface, "whoami", Some("sess-1"), CancellationToken::new());
    let answer = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        #[allow(clippy::disallowed_methods, reason = "the agent answers the reopen")]
        std::fs::write(world.dir.path().join("answer-the-resume"), "").expect("the answer");
    };
    let (end, ()) = within("the turn that joined the reopen", async { tokio::join!(turn, answer) }).await;
    assert!(completed_text(&end).starts_with("session=sess-1 resumed=true"), "{end:?}");
    assert_eq!((world.logged("start acp"), world.logged("session/resume sess-1")), (2, 1), "one reopen: {:?}", world.log());
    let reopened = world.agents.running(&lead).expect("the reopened lead");
    assert_ne!(reopened.connection.handle(), server.handle());
    assert!(Arc::ptr_eq(&reopened.grants, &held.grants), "what the user approved carries over");
    assert_eq!(reopened.kept_call("read", &json!({ "path": "a.txt" }), |_| true).as_deref(), Some("task-1"));
}

/// A retired server's session of a thread whose Mixdog session unloaded is not reopened, and no server starts while no
/// loaded thread's session is left: the thread's next turn reopens it, with what the user approved. An agent let go of
/// while idle keeps its approvals; one that is not idle keeps running.
#[tokio::test]
async fn a_retired_servers_session_of_an_unloaded_thread_is_reopened_only_by_its_next_turn() {
    let world = World::official(&[]);
    let (lead, worker) = (ThreadId::from("sess_lead"), ThreadId::from("sess_worker"));
    let cwd = world.cwd();
    assert!(world.answer_in(&lead, &cwd, "whoami").await.starts_with("session=sess-1"));
    assert!(world.answer_in(&worker, &cwd, "whoami").await.starts_with("session=sess-2"));
    let held = world.agents.running(&lead).expect("lead session");
    let server = held.connection.clone();

    world.agents.unloaded(&lead);
    world.agents.release_idle(&worker);
    assert!(world.agents.running(&worker).is_none(), "an idle agent is let go of");
    within("the retired server's exit", server.exited().cancelled()).await;
    assert!(world.agents.running(&lead).is_none());
    assert_eq!(world.logged("start acp"), 1, "no server starts for an unloaded thread: {:?}", world.log());

    let resumed = within("the lead's next turn", world.prompt_in(&lead, &cwd, &Surface::default(), "whoami", Some("sess-1"), CancellationToken::new())).await;
    assert!(completed_text(&resumed).starts_with("session=sess-1 resumed=true"), "{resumed:?}");
    assert_eq!(world.logged("start acp"), 2, "{:?}", world.log());
    assert!(Arc::ptr_eq(&world.agents.running(&lead).expect("the reopened lead").grants, &held.grants), "what the user approved carries over");

    // The official server replies only to a prompt: the call it keeps running past the turn is never told ended.
    within("the turn", world.prompt(&thread(), &Surface::default(), "background", None, CancellationToken::new())).await;
    let busy = world.agents.running(&thread()).expect("the session with its call running in the agent's background");
    world.agents.release_idle(&thread());
    assert!(world.agents.running(&thread()).is_some_and(|running| Arc::ptr_eq(&running, &busy)), "an agent that is not idle stays");
    assert!(!busy.gone().is_cancelled());
}
