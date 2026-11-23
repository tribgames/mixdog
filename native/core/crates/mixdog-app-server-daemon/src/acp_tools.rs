//! The session tools an ACP agent is handed: the run host's own view of a session's tool surface
//! and its ordinary call pipeline, behind the seam the agents' MCP server asks.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_acp::agents::Agents;
use mixdog_acp::agents::Readiness;
use mixdog_acp::agents::Refusal;
use mixdog_acp::mcp::SessionTools;
use mixdog_acp::preset::AgentPreset;
use mixdog_acp::runs::AgentTurn;
use mixdog_acp::runs::Attachments;
use mixdog_acp::runs::Conversation;
use mixdog_acp::surface::CallMark;
use mixdog_acp::surface::CompactEvent;
use mixdog_acp::surface::TurnSurface;
use mixdog_acp::surface::TurnUsage;
use mixdog_ai::registry::accounting::Facts;
use mixdog_ai::registry::accounting::RecordArgs;
use mixdog_ai::registry::accounting::UsagePricing;
use mixdog_ai::registry::accounting::UsageRow;
use mixdog_ai::registry::accounting::UsageSink;
use mixdog_ai::registry::accounting::make_usage_record;
use mixdog_ai::registry::accounting::random_uuid;
use mixdog_core::run_host::assemble::handed_tools::HandedTools;
use mixdog_core::run_host::factory::History;
use mixdog_core::run_host::factory::OutsideAgents;
use mixdog_core::run_host::factory::OutsideAnswer;
use mixdog_core::run_host::factory::OutsideAsk;
use mixdog_core::run_host::factory::OutsideReport;
use mixdog_core::run_host::factory::OutsideTurn;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_base::support::on_lane_wait;
use mixdog_core_session::session::ItemCommit;
use mixdog_core_session::session::RunOutcome;
use mixdog_core_session::session::run::RunError;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ItemId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::TurnError;
use mixdog_rt::InteractiveIo;
use mixdog_store::blobs::BlobStore;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub use mixdog_acp::mcp_bridge::SUBCOMMAND as BRIDGE_SUBCOMMAND;

/// The stdio end of a session's tool server, run as the process an agent starts for it; the exit status.
pub fn run_bridge() -> i32 {
    match mixdog_acp::mcp_bridge::run() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

/// The agent presets Mixdog ships: what the daemon and `mixdog exec` compose their cores with.
pub fn builtin_presets() -> Vec<mixdog_acp::preset::AgentPreset> {
    mixdog_acp::preset::builtin()
}

pub struct AgentSessionTools(pub HandedTools);

#[async_trait]
impl SessionTools for AgentSessionTools {
    async fn definitions(&self, thread: &ThreadId) -> Result<Vec<ToolDefinition>, String> {
        self.0.definitions(thread).await
    }
}

/// The session's system prompt as its header holds it, in request order: the rules, the stable context, the session
/// core and the environment.
pub fn prompt_of(header: &Header) -> Option<String> {
    let blocks = mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(header);
    let text =
        [blocks.base, blocks.stable, blocks.core, blocks.env].into_iter().flatten().filter(|block| !block.trim().is_empty()).collect::<Vec<_>>().join("\n\n");
    (!text.is_empty()).then_some(text)
}

/// Where usage is recorded: the ledger the usage page reads, opened when a row is recorded.
pub type Ledger = Arc<dyn Fn() -> Option<Arc<dyn UsageSink>> + Send + Sync>;

/// The turns of sessions on an ACP agent's route: begun by the turn path, run in the agent.
pub struct AgentTurns {
    pub agents: Arc<Agents>,
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub blobs: BlobStore,
    pub interactive: InteractiveIo,
    /// Where the tokens the agent reports for a turn are recorded, as a provider's send records its own.
    pub ledger: Ledger,
    /// What prices a turn's row: the price table a provider's send and the ledger's own repricing use, so the row is
    /// stored as the ledger settles it.
    pub pricing: Arc<dyn UsagePricing>,
}

/// Who a session's turns are recorded under in the usage ledger, as its header names them.
#[derive(Clone, Debug)]
struct LedgerRoute {
    provider: String,
    session_id: String,
    owner_session_id: Option<String>,
    source_type: String,
}

impl LedgerRoute {
    fn of(header: &Header, preset: &AgentPreset, thread: &ThreadId) -> Self {
        let text = |key: &str| header.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
        Self {
            provider: preset.provider.clone(),
            session_id: thread.as_str().to_owned(),
            owner_session_id: text("ownerSessionId").or_else(|| text("parentSessionId")),
            source_type: text("sourceType").unwrap_or_default(),
        }
    }

    /// The ledger's row of a turn's usage: the tokens the agent reported under the route's provider and model, with
    /// the time its model worked, priced by `pricing`. `None` for a report that holds no tokens (the agent reported its
    /// context only).
    fn row(&self, usage: &TurnUsage, now: i64, pricing: &dyn UsagePricing) -> Option<Result<UsageRow, String>> {
        let input =
            if mixdog_acp::surface::input_excludes_cache(usage) { usage.input_tokens } else { usage.input_tokens.saturating_sub(usage.cached_read_tokens) };
        let facts = Facts {
            input_tokens: Some(input as f64),
            input_tokens_known: None,
            output_tokens_known: true,
            output_tokens: usage.output_tokens as f64,
            cached_tokens: usage.cached_read_tokens as f64,
            cache_write_tokens: 0.0,
            cache_write_1h_tokens: 0.0,
            cost_usd: None,
            raw_service_tier: None,
        };
        if !facts.recordable() {
            return None;
        }
        let args = RecordArgs {
            ts: now,
            provider: self.provider.clone(),
            model: usage.model.clone(),
            requested_model: usage.model.clone(),
            requested_provider: self.provider.clone(),
            status: "completed".to_owned(),
            attempts: 1.0,
            ttft_ms: None,
            elapsed_ms: 0.0,
            pricing_model: None,
            session_id: Some(self.session_id.clone()),
            owner_session_id: self.owner_session_id.clone(),
            source_type: self.source_type.clone(),
            facts,
            input_tokens_inclusive: false,
            media: None,
            service_tier: None,
            request_service_tier: None,
            response_id: String::new(),
            account: String::new(),
            duration_ms: usage.request_ms as f64,
            origin: None,
            id: None,
        };
        Some(make_usage_record(&args, pricing, &random_uuid))
    }
}

/// The session's port, with the usage of each turn also recorded in the usage ledger and kept for the turn's end.
#[derive(Clone)]
struct Accounted {
    inner: Arc<dyn TurnSurface>,
    ledger: Ledger,
    pricing: Arc<dyn UsagePricing>,
    route: LedgerRoute,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    report: Arc<OutsideReport>,
}

#[async_trait]
impl TurnSurface for Accounted {
    async fn item_started(&self, item: ThreadItem) -> Result<(), RunError> {
        self.inner.item_started(item).await
    }

    async fn delta(&self, item: ItemId, text: String) -> Result<(), RunError> {
        self.inner.delta(item, text).await
    }

    async fn text_settled(&self, item: ItemId) -> Result<(), RunError> {
        self.inner.text_settled(item).await
    }

    async fn reasoning_delta(&self, item: ItemId, text: String) -> Result<(), RunError> {
        self.inner.reasoning_delta(item, text).await
    }

    async fn reasoning_completed(&self, item: ItemId, text: String) -> Result<(), RunError> {
        self.inner.reasoning_completed(item, text).await
    }

    async fn commit(&self, item: ItemCommit) -> Result<(), RunError> {
        self.inner.commit(item).await
    }

    async fn notice(&self, text: String, warn: bool) -> Result<(), RunError> {
        self.inner.notice(text, warn).await
    }

    async fn usage(&self, usage: TurnUsage) -> Result<(), RunError> {
        let row = self.route.row(&usage, (self.now_ms)(), self.pricing.as_ref());
        let settled = (mixdog_acp::surface::provider_usage(&usage), mixdog_acp::surface::input_excludes_cache(&usage));
        *self.report.usage.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(settled);
        let shown = self.inner.usage(usage).await;
        if let Some(row) = row {
            let recorded = match ((self.ledger)(), row) {
                (Some(sink), Ok(row)) => sink.record_queued(row).await,
                (None, _) => Ok(()),
                (_, Err(error)) => Err(error),
            };
            if let Err(error) = recorded {
                tracing::warn!("[acp] the turn's usage was not recorded in the usage ledger: {error}");
            }
        }
        shown
    }

    async fn draft(&self, body: Value) -> Result<(), RunError> {
        self.inner.draft(body).await
    }

    async fn save_header(&self, change: HeaderChange) -> Result<(), RunError> {
        self.inner.save_header(change).await
    }

    async fn approve(&self, ask: ApprovalAsk) -> ApprovalResolution {
        self.inner.approve(ask).await
    }

    async fn stage(&self, stage: &str) -> Result<(), RunError> {
        self.inner.stage(stage).await
    }

    async fn compact_event(&self, event: CompactEvent) -> Result<(), RunError> {
        self.inner.compact_event(event).await
    }

    async fn call_mark(&self, mark: CallMark) -> Result<(), RunError> {
        self.inner.call_mark(mark).await
    }

    fn call_epoch(&self) -> u64 {
        self.inner.call_epoch()
    }

    fn closing(&self) -> Arc<dyn TurnSurface> {
        Arc::new(Self { inner: self.inner.closing(), ..self.clone() })
    }
}

/// Whether a session the agent dispatch prepares can run on an ACP agent's route.
pub struct AgentAdmission(pub Arc<Agents>);

impl mixdog_core::run_host::dispatch_sessions::AgentRoutes for AgentAdmission {
    /// An agent still being checked admits the session: its turn waits for the check, as a turn on the route does, and
    /// is refused by what the check finds.
    fn admits(&self, provider: &str) -> Option<Result<(), String>> {
        let preset = self.0.preset_of_route(provider)?;
        Some(match self.0.selectable(preset) {
            Err(Refusal::NotReady(Readiness::Checking)) => Ok(()),
            selectable => selectable.map_err(|refusal| refusal.message(preset)),
        })
    }
}

impl AgentTurns {
    fn preset_of(&self, header: &Header) -> Option<&AgentPreset> {
        self.agents.preset_of_route(header.get("provider").and_then(Value::as_str).unwrap_or_default())
    }
}

struct Held(History);

#[async_trait]
impl Conversation for Held {
    async fn hand_over(&self) -> Result<Option<String>, String> {
        self.0.hand_over().await
    }

    fn hand_over_summarizes(&self) -> bool {
        self.0.hand_over_summarizes()
    }

    fn compaction_due(&self) -> Option<mixdog_acp::runs::Due> {
        self.0.compaction_due().map(|(used, trigger)| mixdog_acp::runs::Due { used, trigger })
    }

    async fn compact(&self) -> Result<Option<String>, String> {
        self.0.compact().await
    }
}

struct Stored {
    blobs: BlobStore,
    interactive: InteractiveIo,
}

#[async_trait]
impl Attachments for Stored {
    async fn bytes(&self, reference: &str) -> Option<Vec<u8>> {
        mixdog_core::run_host::attachment_store::stored_bytes(&self.blobs, self.interactive, reference).await
    }

    fn path(&self, reference: &str) -> Option<String> {
        mixdog_core::run_host::attachment_store::stored_path(&self.blobs, reference).map(|path| path.to_string_lossy().into_owned())
    }
}

#[async_trait]
impl OutsideAgents for AgentTurns {
    fn serves(&self, header: &Header) -> bool {
        self.preset_of(header).is_some()
    }

    /// An agent still being checked has no refusal yet: its own turn waits for the check.
    fn refusal(&self, header: &Header) -> Option<String> {
        let preset = self.preset_of(header)?;
        match self.agents.selectable(preset) {
            Err(refusal) if refusal != Refusal::NotReady(Readiness::Checking) => Some(refusal.message(preset)),
            _ => None,
        }
    }

    fn signed_out(&self, header: &Header) -> bool {
        self.preset_of(header).is_some_and(|preset| self.agents.selectable(preset).err().is_some_and(|refusal| refusal.signed_out()))
    }

    fn prompts(&self, input: &Value) -> bool {
        !mixdog_acp::runs::is_wake(input)
    }

    async fn run(&self, turn: OutsideTurn) -> RunOutcome {
        let OutsideTurn { thread, turn, header, input, port, cancel, progress, transcript, calls, history, on_tool_result, report } = turn;
        let Some(preset) = self.preset_of(&header).cloned() else {
            return RunOutcome::Failed(TurnError { message: "The session's route names no agent.".to_owned(), data: Value::Null, provider_error: None });
        };
        let surface = Accounted {
            inner: Arc::new(port),
            ledger: self.ledger.clone(),
            pricing: self.pricing.clone(),
            route: LedgerRoute::of(&header, &preset, &thread),
            now_ms: self.now_ms.clone(),
            report,
        };
        let begun = AgentTurn {
            thread,
            turn,
            rules: prompt_of(&header),
            header,
            input,
            surface: Arc::new(surface),
            cancel,
            progress: Some(progress),
            transcript,
            calls: Some(calls),
            conversation: Arc::new(Held(history)),
            attachments: Arc::new(Stored { blobs: self.blobs.clone(), interactive: self.interactive }),
            on_tool_result: on_tool_result.map(|told| {
                Arc::new(move |ui_diff: Option<String>| told(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage { ui_diff }))
                    as mixdog_acp::turn::ToolResultHook
            }),
        };
        mixdog_acp::runs::drive(&self.agents, &preset, self.now_ms.clone(), begun).await
    }

    fn answers(&self, provider: &str) -> bool {
        self.agents.preset_of_route(provider).is_some()
    }

    async fn ask(&self, ask: OutsideAsk) -> Result<OutsideAnswer, String> {
        let Some(preset) = self.agents.preset_of_route(&ask.provider).cloned() else {
            return Err(format!("no agent answers for {}", ask.provider));
        };
        let answered = mixdog_acp::runs::ask_once(&self.agents, &preset, &ask.model, &ask.system, &ask.prompt, self.now_ms.clone()).await?;
        let input_excludes_cache = answered.usage.as_ref().is_some_and(mixdog_acp::surface::input_excludes_cache);
        Ok(OutsideAnswer {
            text: answered.text,
            stop_reason: answered.stop_reason,
            usage: answered.usage.map(|usage| mixdog_core_api::domain::provider::Usage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cached_read_tokens,
                reasoning_tokens: usage.thought_tokens,
                ..Default::default()
            }),
            input_excludes_cache,
        })
    }

    async fn unrun(&self, thread: &ThreadId, why: &str) {
        self.agents.unrun(thread, why).await;
    }

    fn loop_turn(&self, thread: &ThreadId, header: &Header) -> Option<mixdog_store::schema::record::HeaderChange> {
        mixdog_acp::runs::loop_turn(&self.agents, thread, header)
    }
}

/// The agents' refusals of the signed-in account, kept in a file of the data folder.
pub struct KeptRefusals {
    pub file: std::path::PathBuf,
    pub lane: mixdog_rt::DurabilityIo,
}

impl KeptRefusals {
    /// The file under the data folder `data_dir`.
    pub fn in_data_dir(data_dir: &std::path::Path, lane: mixdog_rt::DurabilityIo) -> Self {
        Self { file: data_dir.join("acp-agent-refusals.json"), lane }
    }
}

#[async_trait]
impl mixdog_acp::agents::Refusals for KeptRefusals {
    async fn read(&self) -> HashMap<String, String> {
        let file = self.file.clone();
        let read =
            on_lane_wait(self.lane, &CancellationToken::new(), move |lane| mixdog_statefile::read_json(lane, &file, None, &mixdog_statefile::Opts::default()))
                .await;
        match read {
            Ok(Ok(Some(Value::Object(kept)))) => kept.into_iter().filter_map(|(agent, said)| Some((agent, said.as_str()?.to_owned()))).collect(),
            Ok(Ok(_)) => HashMap::new(),
            Ok(Err(error)) => {
                tracing::warn!("[acp] the agents' kept account refusals could not be read: {error}");
                HashMap::new()
            }
            Err(error) => {
                tracing::warn!("[acp] the agents' kept account refusals could not be read: {error}");
                HashMap::new()
            }
        }
    }

    async fn keep(&self, refusals: HashMap<String, String>) {
        let file = self.file.clone();
        let value = Value::Object(refusals.into_iter().map(|(agent, said)| (agent, Value::String(said))).collect());
        let kept = on_lane_wait(self.lane, &CancellationToken::new(), move |lane| {
            mixdog_statefile::write_json(lane, &file, &value, &mixdog_statefile::Opts::default()).map(drop)
        })
        .await;
        match kept {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!("[acp] an agent's account refusal could not be kept: {error}"),
            Err(error) => tracing::warn!("[acp] an agent's account refusal could not be kept: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use mixdog_acp::agents::AgentsParts;
    use mixdog_acp::agents::Refusals;
    use mixdog_core::run_host::dispatch_sessions::AgentRoutes;
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::process::ProcessError;
    use mixdog_core_api::domain::process::ProcessEvent;
    use mixdog_core_api::domain::process::ProcessInfo;
    use mixdog_core_api::domain::process::ProcessManager;
    use mixdog_core_api::domain::process::PtySize;
    use mixdog_core_api::domain::process::SpawnRequest;
    use mixdog_core_api::domain::process::SpawnedProcess;
    use mixdog_protocol::ProcessHandle;

    use super::*;

    /// Starts no process: each one asked for is still starting, so an agent's check never ends.
    struct NeverStarts;

    #[async_trait]
    impl ProcessManager for NeverStarts {
        async fn spawn(&self, _: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            std::future::pending().await
        }
        fn subscribe(&self, _: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            Err(ProcessError::UnknownHandle)
        }
        fn subscribe_holding(&self, _: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            Err(ProcessError::UnknownHandle)
        }
        async fn write_stdin(&self, _: &ProcessHandle, _: Vec<u8>) -> Result<(), ProcessError> {
            Err(ProcessError::UnknownHandle)
        }
        fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Err(ProcessError::UnknownHandle)
        }
        fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
            Err(ProcessError::UnknownHandle)
        }
        fn kill(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Err(ProcessError::UnknownHandle)
        }
        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    struct NoFiles;

    #[async_trait]
    impl mixdog_acp::files::TextFiles for NoFiles {
        async fn read(&self, _: AbsPath) -> Result<String, String> {
            Err("no file is read".to_owned())
        }
        async fn resolved(&self, _: AbsPath) -> Result<AbsPath, String> {
            Err("no file is read".to_owned())
        }
    }

    /// A session prepared on an agent's route while the agent's first check is still running is admitted, as a turn on
    /// the route waits for that check; an agent the feature's switch turned off is refused at once.
    #[tokio::test]
    async fn a_session_on_an_agent_still_being_checked_is_admitted() {
        let dir = tempfile::tempdir().expect("a data folder");
        let preset = builtin_presets().remove(0);
        let enabled = Arc::new(AtomicBool::new(true));
        let agents = Agents::new(AgentsParts {
            refusals: Arc::new(KeptRefusals::in_data_dir(dir.path(), mixdog_rt::testing::tokens().durability_io)),
            presets: vec![preset.clone()],
            processes: Arc::new(NeverStarts),
            files: Arc::new(NoFiles),
            enabled: {
                let enabled = enabled.clone();
                Arc::new(move || enabled.load(Ordering::SeqCst))
            },
            changed: Arc::new(|| {}),
            probe_cwd: dir.path().to_path_buf(),
            env: Arc::new(|_: &str| None),
            mcp_bridge: None,
        });
        let admission = AgentAdmission(agents.clone());

        assert_eq!(admission.admits(&preset.provider), Some(Ok(())));
        assert!(matches!(agents.selectable(&preset), Err(Refusal::NotReady(Readiness::Checking))), "the check is still running");
        assert_eq!(admission.admits("anthropic"), None, "no agent's route");
        enabled.store(false, Ordering::SeqCst);
        assert!(matches!(admission.admits(&preset.provider), Some(Err(_))));
    }

    /// A port that takes every report and keeps the usage reports.
    #[derive(Clone, Default)]
    struct Port(Arc<std::sync::Mutex<Vec<TurnUsage>>>);

    #[async_trait]
    impl TurnSurface for Port {
        async fn item_started(&self, _: ThreadItem) -> Result<(), RunError> {
            Ok(())
        }
        async fn delta(&self, _: ItemId, _: String) -> Result<(), RunError> {
            Ok(())
        }
        async fn text_settled(&self, _: ItemId) -> Result<(), RunError> {
            Ok(())
        }
        async fn reasoning_delta(&self, _: ItemId, _: String) -> Result<(), RunError> {
            Ok(())
        }
        async fn reasoning_completed(&self, _: ItemId, _: String) -> Result<(), RunError> {
            Ok(())
        }
        async fn commit(&self, _: ItemCommit) -> Result<(), RunError> {
            Ok(())
        }
        async fn notice(&self, _: String, _: bool) -> Result<(), RunError> {
            Ok(())
        }
        async fn usage(&self, usage: TurnUsage) -> Result<(), RunError> {
            self.0.lock().unwrap().push(usage);
            Ok(())
        }
        async fn draft(&self, _: Value) -> Result<(), RunError> {
            Ok(())
        }
        async fn save_header(&self, _: HeaderChange) -> Result<(), RunError> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalAsk) -> ApprovalResolution {
            ApprovalResolution::Unavailable { at: 0 }
        }
        async fn stage(&self, _: &str) -> Result<(), RunError> {
            Ok(())
        }
        async fn compact_event(&self, _: CompactEvent) -> Result<(), RunError> {
            Ok(())
        }
        async fn call_mark(&self, _: CallMark) -> Result<(), RunError> {
            Ok(())
        }
        fn call_epoch(&self) -> u64 {
            0
        }
        fn closing(&self) -> Arc<dyn TurnSurface> {
            Arc::new(self.clone())
        }
    }

    /// The catalog's price documents are never fetched.
    struct Offline;

    #[async_trait]
    impl mixdog_ai::transport::http::HttpSend for Offline {
        async fn send(
            &self,
            _: mixdog_core_api::domain::provider::WireRequest,
            _: mixdog_ai::transport::Exchange,
        ) -> Result<mixdog_ai::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
            use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError};
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
        }
    }

    /// A catalog with both price tables loaded from the cache files under `dir`, which price one model of a provider's.
    #[allow(clippy::disallowed_methods, reason = "the test seeds the catalog's cache files")]
    async fn warm_catalog(dir: &std::path::Path) -> Arc<mixdog_ai::catalog::CatalogService> {
        use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, LITELLM_CACHE_FILE, MODELS_DEV_CACHE_FILE, ModelsDevSource};
        let priced =
            r#"{"fetchedAt":1,"data":{"gpt-x":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":0.000001,"output_cost_per_token":0.000002}}}"#;
        std::fs::write(dir.join(LITELLM_CACHE_FILE), priced).expect("the price table");
        std::fs::write(dir.join(MODELS_DEV_CACHE_FILE), r#"{"fetchedAt":1,"data":{}}"#).expect("the model table");
        let tokens = mixdog_rt::testing::tokens();
        let io = || mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), io());
        let litellm = ModelsDevSource::litellm(Arc::new(Offline), dir.to_path_buf(), io());
        Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await.with_litellm(litellm).await)
    }

    /// The tokens an agent reports for a turn reach the usage ledger the usage page reads, under the session's route and
    /// with the time its model worked, priced as a provider's send prices its own: the ledger's refresh finds nothing to
    /// reprice in the row, so it writes nothing and copies no backup. A report of the agent's context alone records no
    /// row. The session's port is told every report, a stopped turn's closing surface included.
    #[tokio::test]
    async fn an_agents_turn_usage_is_recorded_in_the_usage_ledger_as_the_ledger_prices_it() {
        use mixdog_ledger::refresh::Refresh;
        let dir = tempfile::tempdir().expect("a data folder");
        let catalog = warm_catalog(dir.path()).await;
        let tokens = mixdog_rt::testing::tokens();
        let path = dir.path().join("ledger.sqlite");
        let writer = mixdog_ledger::writer::UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).expect("the ledger");
        let reader = mixdog_ledger::reader::UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
        let pricer = mixdog_core_base::pricing::ledger_pricer::CatalogPricer::new(&catalog).expect("a warm catalog");
        let refresher = mixdog_ledger::refresh::UsageRefresher::new(Arc::new(pricer), tokens.cpu_bulk);
        let ledger: Ledger = {
            let writer = writer.clone();
            Arc::new(move || Some(Arc::new(mixdog_core::run_host::accounting_scope::LedgerSink(writer.clone())) as Arc<dyn UsageSink>))
        };
        let preset = builtin_presets().remove(0);
        let header = serde_json::json!({ "provider": preset.provider.as_str(), "model": "gemini-3-pro", "ownerSessionId": "sess_lead", "sourceType": "agent" })
            .as_object()
            .cloned()
            .expect("a header");
        let port = Port::default();
        let route = LedgerRoute::of(&header, &preset, &ThreadId::from("sess_worker".to_owned()));
        let at = 1_800_000_000_000;
        let surface = Accounted {
            inner: Arc::new(port.clone()),
            ledger,
            pricing: Arc::new(mixdog_ai::catalog::CatalogPricing(catalog.clone())),
            route,
            now_ms: Arc::new(move || at),
            report: Arc::default(),
        };
        let model = || "gemini-3-pro".to_owned();
        let usage = TurnUsage {
            input_tokens: 4_437,
            output_tokens: 144,
            cached_read_tokens: 14_487,
            total_tokens: Some(19_068),
            model: model(),
            request_ms: 2_000,
            ..TurnUsage::default()
        };
        surface.usage(usage).await.expect("the port takes it");
        surface.closing().usage(TurnUsage { model: model(), ..TurnUsage::default() }).await.expect("the closing port takes it");

        writer.settle_writes().await.expect("the rows are stored");

        assert_eq!(port.0.lock().unwrap().len(), 2, "the port is told every report");
        type Stored = (String, String, String, String, f64, f64, f64, Option<f64>, f64);
        #[allow(clippy::disallowed_types, reason = "Test-only read of the ledger file the test itself wrote.")]
        let rows: Vec<Stored> = mixdog_ledger::db::Connection::open(&path)
            .expect("the ledger file")
            .prepare("SELECT provider, model, session_id, source_type, input, output, cache_read, cost_usd, duration_ms FROM events")
            .expect("the rows")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)))
            .expect("the rows")
            .collect::<Result<_, _>>()
            .expect("the rows");
        let expected = ("acp-antigravity".to_owned(), model(), "sess_worker".to_owned(), "agent".to_owned(), 4_437.0, 144.0, 14_487.0, None, 2_000.0);
        assert_eq!(rows, [expected], "one row, and none for a report of the context alone");

        let Refresh::Repaired(report) = refresher.refresh(&writer, &reader, at + 1_000).await.expect("the refresh") else {
            panic!("the unpriced row is examined");
        };
        assert_eq!(report.still_unpriced, 1, "{report:?}");
        assert!(report.changes.is_empty() && report.integrity.is_none() && report.backup_path.is_none(), "nothing is repriced or rewritten: {report:?}");
    }

    /// What the agents refused is found again by an app that starts over the same data folder.
    #[tokio::test]
    async fn an_agents_refusal_is_kept_in_the_data_folder_for_the_app_that_starts_next() {
        let dir = tempfile::tempdir().expect("a data folder");
        let lane = mixdog_rt::testing::tokens().durability_io;
        let said = "This service has been disabled in this account.";
        assert!(KeptRefusals::in_data_dir(dir.path(), lane).read().await.is_empty());
        KeptRefusals::in_data_dir(dir.path(), lane).keep(HashMap::from([("antigravity".to_owned(), said.to_owned())])).await;
        assert_eq!(KeptRefusals::in_data_dir(dir.path(), lane).read().await, HashMap::from([("antigravity".to_owned(), said.to_owned())]));
        KeptRefusals::in_data_dir(dir.path(), lane).keep(HashMap::new()).await;
        assert!(KeptRefusals::in_data_dir(dir.path(), lane).read().await.is_empty());
    }
}
