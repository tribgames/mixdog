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
use mixdog_agent::agent_tool::board::JobBoard;
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
use mixdog_core::run_host::factory::OutsideReport;
use mixdog_core::run_host::factory::OutsideTurn;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::UsdTicks;
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

/// Each agent's route by the provider whose account and quota it shares: what the catalog prices an agent's usage as
/// (`CatalogService::bind_shared_quotas`).
pub fn shared_quotas(presets: &[AgentPreset]) -> std::collections::BTreeMap<String, String> {
    presets.iter().filter_map(|preset| Some((preset.provider.clone(), preset.same_quota_as.clone()?))).collect()
}

/// The sessions' tool surfaces, and the table of their tool calls that went on in the background.
pub struct AgentSessionTools(pub HandedTools, pub JobBoard);

#[async_trait]
impl SessionTools for AgentSessionTools {
    async fn definitions(&self, thread: &ThreadId) -> Result<Vec<ToolDefinition>, String> {
        self.0.definitions(thread).await
    }

    fn tasks(&self) -> &JobBoard {
        &self.1
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
            // The turn's whole run: the quota table spreads the record's meter rises over [ts - duration, ts].
            duration_ms: usage.run_ms as f64,
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

    async fn context_update(&self, usage: TurnUsage) -> Result<(), RunError> {
        self.inner.context_update(usage).await
    }

    async fn usage(&self, usage: TurnUsage) -> Result<(), RunError> {
        let row = self.route.row(&usage, (self.now_ms)(), self.pricing.as_ref());
        // The ledger's cost is the turn's wherever the turn's usage goes: the session's stats and the gateway's record of the ask.
        let cost = row.as_ref().and_then(|row| row.as_ref().ok()).and_then(|row| row.cost_usd).and_then(UsdTicks::from_usd);
        let usage = TurnUsage { cost, ..usage };
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

    /// An agent still being checked has no refusal yet: its own turn waits for the check. Nor has a route on a model of
    /// another preset of the agent, whatever this preset's state: its own turn refuses it naming that preset, and it does
    /// not hop to a fallback provider as a route on an agent that cannot run does.
    fn refusal(&self, header: &Header) -> Option<String> {
        let preset = self.preset_of(header)?;
        let model = header.get("model").and_then(Value::as_str).unwrap_or(mixdog_acp::agents::DEFAULT_MODEL);
        if self.agents.refuses_model(preset, model).is_some() {
            return None;
        }
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

    async fn unrun(&self, thread: &ThreadId, why: &str) {
        self.agents.unrun(thread, why).await;
    }

    fn loop_turn(&self, thread: &ThreadId, header: &Header) -> Option<mixdog_store::schema::record::HeaderChange> {
        mixdog_acp::runs::loop_turn(&self.agents, thread, header)
    }
}

/// What the agents keep across a restart of the app, in files of the data folder: their refusals of the signed-in account,
/// and the context window each last reported.
pub struct KeptRefusals {
    pub file: std::path::PathBuf,
    pub windows: std::path::PathBuf,
    pub lane: mixdog_rt::DurabilityIo,
}

impl KeptRefusals {
    /// The files under the data folder `data_dir`.
    pub fn in_data_dir(data_dir: &std::path::Path, lane: mixdog_rt::DurabilityIo) -> Self {
        Self { file: data_dir.join("acp-agent-refusals.json"), windows: data_dir.join("acp-agent-windows.json"), lane }
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

    async fn read_windows(&self) -> mixdog_acp::agents::Windows {
        let file = self.windows.clone();
        let read =
            on_lane_wait(self.lane, &CancellationToken::new(), move |lane| mixdog_statefile::read_json(lane, &file, None, &mixdog_statefile::Opts::default()))
                .await;
        match read {
            // An agent's entry that is no map of models (the form that kept one size for the agent) is dropped.
            Ok(Ok(Some(Value::Object(kept)))) => kept
                .into_iter()
                .filter_map(|(agent, models)| {
                    let models: HashMap<String, u64> =
                        models.as_object()?.iter().filter_map(|(model, size)| Some((model.clone(), size.as_u64().filter(|size| *size > 0)?))).collect();
                    Some((agent, models))
                })
                .collect(),
            Ok(Ok(_)) => Default::default(),
            Ok(Err(error)) => {
                tracing::warn!("[acp] the agents' kept context windows could not be read: {error}");
                Default::default()
            }
            Err(error) => {
                tracing::warn!("[acp] the agents' kept context windows could not be read: {error}");
                Default::default()
            }
        }
    }

    async fn keep_windows(&self, windows: mixdog_acp::agents::Windows) {
        let file = self.windows.clone();
        let value = Value::Object(
            windows
                .into_iter()
                .map(|(agent, models)| (agent, Value::Object(models.into_iter().map(|(model, size)| (model, Value::from(size))).collect())))
                .collect(),
        );
        let kept = on_lane_wait(self.lane, &CancellationToken::new(), move |lane| {
            mixdog_statefile::write_json(lane, &file, &value, &mixdog_statefile::Opts::default()).map(drop)
        })
        .await;
        match kept {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!("[acp] an agent's context window could not be kept: {error}"),
            Err(error) => tracing::warn!("[acp] an agent's context window could not be kept: {error}"),
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

/// The feature's own folder under the data folder `data_dir`: the builds and homes of the registry's agents, what they
/// told of themselves, and their servers' temporary folders.
pub fn acp_data_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("acp-agents")
}

/// The largest archive of an agent's build that is downloaded.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
/// How long the registry's index is waited for: past it the installed build stays as it is.
const INDEX_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// How long a request may go without a byte, its answer's headers or its body's, before it is given up.
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// How much of an archive is held before it is written out.
const WRITE_BLOCK: usize = 8 * 1024 * 1024;
/// The most redirects a build's download follows, as many as a client follows by default.
const MAX_REDIRECTS: usize = 10;
/// How much of an answer that is no success is told.
const FAILURE_TEXT_CHARS: usize = 300;

/// The ACP registry over the network: its index, and a build's archive downloaded over HTTPS alone, checked against its
/// SHA-256 and unpacked with the archive extraction of the managed engine installs.
pub struct RegistryDownloads {
    client: reqwest::Client,
    /// Follows no redirect: a download follows each itself, to an allowed host alone.
    direct: reqwest::Client,
    lane: mixdog_rt::DurabilityIo,
}

impl RegistryDownloads {
    pub fn new(lane: mixdog_rt::DurabilityIo) -> Result<Self, String> {
        let client = Self::client(STALL_TIMEOUT).https_only(true).build().map_err(|error| error.to_string())?;
        let direct = Self::client(STALL_TIMEOUT).https_only(true).redirect(reqwest::redirect::Policy::none()).build().map_err(|error| error.to_string())?;
        Ok(Self { client, direct, lane })
    }

    /// A client that gives up a request going `stall` without a byte, before its answer's headers as in its body.
    fn client(stall: std::time::Duration) -> reqwest::ClientBuilder {
        reqwest::Client::builder().connect_timeout(INDEX_TIMEOUT).read_timeout(stall)
    }

    /// Runs `job` on the durability lane.
    async fn on_lane<R: Send + 'static>(&self, job: impl FnOnce() -> std::io::Result<R> + Send + 'static) -> Result<R, String> {
        on_lane_wait(self.lane, &CancellationToken::new(), move |_| job()).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
    }

    /// The answer to `build`'s archive, each redirect followed only to one of the build's hosts.
    async fn archive(&self, build: &mixdog_acp::registry::Build) -> Result<reqwest::Response, String> {
        let mut url = reqwest::Url::parse(&build.archive).map_err(|error| format!("{} is no address: {error}", build.archive))?;
        for _ in 0..=MAX_REDIRECTS {
            let response = self.direct.get(url.clone()).send().await.map_err(|error| error.to_string())?;
            if !response.status().is_redirection() {
                return response.error_for_status().map_err(|error| error.to_string());
            }
            let location = response.headers().get(reqwest::header::LOCATION).and_then(|value| value.to_str().ok());
            let location = location.ok_or_else(|| format!("{url} redirects to no address"))?;
            url = url.join(location).map_err(|error| format!("{url} redirects to no address: {error}"))?;
            if !mixdog_acp::registry::allowed_archive(url.as_str(), &build.hosts) {
                return Err(format!("{url} is not on a host the build may come from"));
            }
        }
        Err(format!("{} redirects more than {MAX_REDIRECTS} times", build.archive))
    }

    /// Writes `block` at the end of `file`, a new file where `first`.
    async fn write(&self, file: &std::path::Path, block: Vec<u8>, first: bool, unpacking: mixdog_acp::registry::Unpacking) -> Result<(), String> {
        let file = file.to_path_buf();
        #[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a durability-lane job")]
        let job = move || {
            let _unpacking = unpacking;
            use std::io::Write;
            std::fs::OpenOptions::new().create(true).write(true).append(!first).truncate(first).open(&file)?.write_all(&block)
        };
        self.on_lane(job).await
    }
}

#[async_trait]
impl mixdog_acp::registry::RegistryFetcher for RegistryDownloads {
    async fn index(&self, url: &str) -> Result<Value, String> {
        let response =
            self.client.get(url).timeout(INDEX_TIMEOUT).send().await.and_then(reqwest::Response::error_for_status).map_err(|error| error.to_string())?;
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        serde_json::from_slice(&bytes).map_err(|error| format!("the registry's index is not JSON: {error}"))
    }

    async fn unpack(
        &self,
        build: &mixdog_acp::registry::Build,
        archive: &std::path::Path,
        into: &std::path::Path,
        unpacking: mixdog_acp::registry::Unpacking,
    ) -> Result<(), String> {
        use sha2::Digest;
        let mut response = self.archive(build).await?;
        let too_large = || format!("the archive of {} is larger than {} MiB", build.archive, MAX_ARCHIVE_BYTES / 1024 / 1024);
        if response.content_length().is_some_and(|length| length > MAX_ARCHIVE_BYTES) {
            return Err(too_large());
        }
        let mut hasher = sha2::Sha256::new();
        let (mut held, mut total, mut first) = (Vec::new(), 0_u64, true);
        loop {
            let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? else { break };
            total += chunk.len() as u64;
            if total > MAX_ARCHIVE_BYTES {
                return Err(too_large());
            }
            hasher.update(&chunk);
            held.extend_from_slice(&chunk);
            if held.len() >= WRITE_BLOCK {
                self.write(archive, std::mem::take(&mut held), first, unpacking.clone()).await?;
                first = false;
            }
        }
        self.write(archive, held, first, unpacking.clone()).await?;
        let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        if digest != build.sha256 {
            return Err(format!("the archive's SHA-256 is {digest}, not the registry's {}", build.sha256));
        }
        let (archive, into) = (archive.to_path_buf(), into.to_path_buf());
        let programs: Vec<String> = std::iter::once(&build.cmd).chain(&build.helpers).cloned().collect();
        let from = build.archive.clone();
        // The job holds the unpack's gate to its end, which a dropped future does not cut short.
        #[allow(clippy::disallowed_methods, reason = "a durability-lane job")]
        let job = move || {
            let _unpacking = unpacking;
            std::fs::create_dir_all(&into)?;
            mixdog_services::tidy::extract::extract_zip(&archive, &into, |_| false).map_err(std::io::Error::other)?;
            for program in &programs {
                let path = into.join(program);
                if !path.is_file() {
                    return Err(std::io::Error::other(format!("the archive of {from} holds no {program}")));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
                }
            }
            std::fs::remove_file(&archive)
        };
        self.on_lane(job).await
    }

    async fn post(&self, url: &str, headers: &[(String, String)], body: Vec<u8>) -> Result<Value, String> {
        let request = headers.iter().fold(self.direct.post(url).timeout(INDEX_TIMEOUT).body(body), |request, (name, value)| request.header(name, value));
        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!("{status}: {}", text.chars().take(FAILURE_TEXT_CHARS).collect::<String>()));
        }
        serde_json::from_str(&text).map_err(|error| format!("the answer of {url} is not JSON: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use mixdog_acp::agents::AgentsParts;
    use mixdog_acp::agents::Refusals;
    use mixdog_acp::registry::RegistryFetcher;
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

    fn shipped(id: &str) -> AgentPreset {
        builtin_presets().into_iter().find(|preset| preset.id == id).expect("a shipped preset")
    }

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
        async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
            Err("no file is written".to_owned())
        }
    }

    /// A session prepared on an agent's route while the agent's first check is still running is admitted, as a turn on
    /// the route waits for that check; an agent the feature's switch turned off is refused at once.
    #[tokio::test]
    async fn a_session_on_an_agent_still_being_checked_is_admitted() {
        let dir = tempfile::tempdir().expect("a data folder");
        let preset = shipped("antigravity-cli");
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
            definitions: dir.path().join("acp-agents"),
            data_dir: dir.path().join("acp-agents"),
            env: Arc::new(|_: &str| None),
            mcp_bridge: None,
            registry: None,
        });
        let admission = AgentAdmission(agents.clone());

        assert_eq!(admission.admits(&preset.provider), Some(Ok(())));
        assert!(matches!(agents.selectable(&preset), Err(Refusal::NotReady(Readiness::Checking))), "the check is still running");
        assert_eq!(admission.admits("anthropic"), None, "no agent's route");
        enabled.store(false, Ordering::SeqCst);
        assert!(matches!(admission.admits(&preset.provider), Some(Err(_))));
    }

    /// A download from a server that takes the request and sends nothing, not even its answer's headers, is given up once
    /// it went the stall time without a byte: the install does not wait for the feature to be turned off.
    #[tokio::test]
    async fn a_build_download_whose_server_sends_no_headers_is_given_up_at_the_stall_time() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("a local listener");
        let port = listener.local_addr().expect("its address").port();
        let held = tokio::spawn(async move {
            let (connection, _) = listener.accept().await.expect("the request");
            std::future::pending::<()>().await;
            drop(connection);
        });
        let dir = tempfile::tempdir().expect("a folder");
        let downloads = local_downloads(std::time::Duration::from_millis(300));
        let build = build_at(format!("http://127.0.0.1:{port}/agy-acp-server.zip"), "ab".repeat(32), &[]);
        let (archive, into) = (dir.path().join("archive"), dir.path().join("build"));
        let unpacked = downloads.unpack(&build, &archive, &into, unpacking());
        let given_up = mixdog_rt::time::timeout(std::time::Duration::from_secs(20), unpacked).await.expect("the download is given up at the stall time");
        assert!(given_up.is_err(), "{given_up:?}");
        held.abort();
    }

    /// The registry's downloads as a test's own server on plain HTTP serves them, a request going `stall` without a byte
    /// given up.
    fn local_downloads(stall: std::time::Duration) -> RegistryDownloads {
        RegistryDownloads {
            client: RegistryDownloads::client(stall).build().expect("the client"),
            direct: RegistryDownloads::client(stall).redirect(reqwest::redirect::Policy::none()).build().expect("the client"),
            lane: mixdog_rt::testing::tokens().durability_io,
        }
    }

    /// The official server's build at `archive` with `sha256`, from the preset's host, starting `helpers` beside it.
    fn build_at(archive: String, sha256: String, helpers: &[&str]) -> mixdog_acp::registry::Build {
        mixdog_acp::registry::Build {
            version: mixdog_acp::preset::Version::new(1, 5, 2),
            archive,
            cmd: "agy_acp_server.exe".into(),
            args: Vec::new(),
            sha256,
            hosts: vec!["dl.google.com".into()],
            helpers: helpers.iter().map(|helper| (*helper).to_owned()).collect(),
        }
    }

    fn unpacking() -> mixdog_acp::registry::Unpacking {
        mixdog_acp::registry::Unpacking(Arc::new(Arc::new(tokio::sync::Semaphore::new(1)).try_acquire_owned().expect("a free gate")))
    }

    /// A server of the test's own on a port of its own, which answers its first request with `answer`, and whether it
    /// was asked.
    async fn answering(answer: Vec<u8>) -> (u16, tokio::task::JoinHandle<()>, Arc<AtomicBool>) {
        use tokio::io::AsyncReadExt;
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("a local listener");
        let port = listener.local_addr().expect("its address").port();
        let asked = Arc::new(AtomicBool::new(false));
        let told = asked.clone();
        let served = tokio::spawn(async move {
            let Ok((mut connection, _)) = listener.accept().await else { return };
            told.store(true, Ordering::SeqCst);
            let (mut request, mut chunk) = (Vec::new(), [0_u8; 1024]);
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                match connection.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(read) => request.extend_from_slice(&chunk[..read]),
                }
            }
            let _ = connection.write_all(&answer).await;
            let _ = connection.shutdown().await;
        });
        (port, served, asked)
    }

    /// A zip of `files` stored as they are, made on MS-DOS: it says nothing of a file's Unix mode.
    fn stored_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        fn crc32(data: &[u8]) -> u32 {
            let mut crc = !0_u32;
            for byte in data {
                crc ^= u32::from(*byte);
                for _ in 0..8 {
                    crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
                }
            }
            !crc
        }
        let (mut zip, mut central) = (Vec::new(), Vec::new());
        for (name, data) in files {
            let offset = u32::try_from(zip.len()).expect("a small zip");
            let (crc, size, length) = (crc32(data), u32::try_from(data.len()).expect("a small file"), u16::try_from(name.len()).expect("a short name"));
            // Version needed, no flags, stored, no time or date, the CRC and both sizes, the name's length, no extra field.
            let shared: Vec<u8> =
                [&20_u16.to_le_bytes()[..], &[0; 8], &crc.to_le_bytes(), &size.to_le_bytes(), &size.to_le_bytes(), &length.to_le_bytes(), &[0; 2]].concat();
            zip.extend([&0x0403_4b50_u32.to_le_bytes()[..], &shared, name.as_bytes(), data].concat());
            central.extend([&0x0201_4b50_u32.to_le_bytes()[..], &20_u16.to_le_bytes(), &shared, &[0; 10], &offset.to_le_bytes(), name.as_bytes()].concat());
        }
        let count = u16::try_from(files.len()).expect("a few files");
        let (size, offset) = (u32::try_from(central.len()).expect("a small zip"), u32::try_from(zip.len()).expect("a small zip"));
        zip.extend(central);
        zip.extend([&0x0605_4b50_u32.to_le_bytes()[..], &[0; 4], &count.to_le_bytes(), &count.to_le_bytes(), &size.to_le_bytes(), &offset.to_le_bytes(), &[0; 2]].concat());
        zip
    }

    /// A download is never sent to a host its build may not come from: a redirect to another is refused before it is
    /// followed, and that host is never asked.
    #[tokio::test]
    async fn a_build_download_redirected_to_another_host_is_refused_before_it_is_followed() {
        let (other, other_served, other_asked) = answering(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()).await;
        let to = format!("http://localhost:{other}/agy-acp-server.zip");
        let (port, served, _) = answering(format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()).await;
        let dir = tempfile::tempdir().expect("a folder");
        let build = build_at(format!("http://127.0.0.1:{port}/agy-acp-server.zip"), "ab".repeat(32), &[]);
        let refused = local_downloads(STALL_TIMEOUT).unpack(&build, &dir.path().join("archive"), &dir.path().join("build"), unpacking()).await;
        assert_eq!(refused, Err(format!("{to} is not on a host the build may come from")));
        served.await.expect("the server");
        assert!(!other_asked.load(Ordering::SeqCst), "the other host was asked");
        other_served.abort();
    }

    /// An archive without the build's program, or without a program the build starts beside it, is no build; one with
    /// both leaves each executable, whatever the archive said of them.
    #[tokio::test]
    async fn a_build_archive_without_its_program_or_a_helper_is_no_build() {
        use sha2::Digest;
        let serve = |zip: Vec<u8>| async move {
            let sha256: String = sha2::Sha256::digest(&zip).iter().map(|byte| format!("{byte:02x}")).collect();
            let mut answer = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", zip.len()).into_bytes();
            answer.extend(zip);
            let (port, served, _) = answering(answer).await;
            (format!("http://127.0.0.1:{port}/agy-acp-server.zip"), sha256, served)
        };
        let (cmd, helper) = ("agy_acp_server.exe", "localharness_external.exe");
        let dir = tempfile::tempdir().expect("a folder");
        let (archive, sha256, served) = serve(stored_zip(&[(cmd, b"server")])).await;
        let missing = local_downloads(STALL_TIMEOUT).unpack(&build_at(archive.clone(), sha256, &[helper]), &dir.path().join("archive"), &dir.path().join("a"), unpacking()).await;
        assert_eq!(missing, Err(format!("the archive of {archive} holds no {helper}")));
        served.await.expect("the server");
        let (archive, sha256, served) = serve(stored_zip(&[(helper, b"harness")])).await;
        let missing = local_downloads(STALL_TIMEOUT).unpack(&build_at(archive.clone(), sha256, &[helper]), &dir.path().join("archive"), &dir.path().join("b"), unpacking()).await;
        assert_eq!(missing, Err(format!("the archive of {archive} holds no {cmd}")));
        served.await.expect("the server");

        let (archive, sha256, served) = serve(stored_zip(&[(cmd, b"server"), (helper, b"harness")])).await;
        let whole = local_downloads(STALL_TIMEOUT).unpack(&build_at(archive, sha256, &[helper]), &dir.path().join("archive"), &dir.path().join("c"), unpacking()).await;
        assert_eq!(whole, Ok(()));
        served.await.expect("the server");
        #[cfg(unix)]
        for program in [cmd, helper] {
            use std::os::unix::fs::PermissionsExt;
            #[allow(clippy::disallowed_methods, reason = "a test looks at what was unpacked")]
            let mode = std::fs::metadata(dir.path().join("c").join(program)).expect("unpacked").permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "{program}");
        }
    }

    /// A route on a model another preset of the agent runs (a saved route, or `mixdog exec --provider acp-antigravity
    /// --model claude-…`) is no refusal of the agent's state, whatever that state is: the turn path would hop such a route
    /// to its fallback provider, or tell the user to install or sign in. The agent's own turn refuses it, naming the preset
    /// that runs the model.
    #[tokio::test]
    async fn a_route_on_a_model_of_the_other_preset_is_refused_by_its_turn_before_the_agents_state() {
        let dir = tempfile::tempdir().expect("a data folder");
        let agents = Agents::new(AgentsParts {
            refusals: Arc::new(KeptRefusals::in_data_dir(dir.path(), mixdog_rt::testing::tokens().durability_io)),
            presets: builtin_presets(),
            processes: Arc::new(NeverStarts),
            files: Arc::new(NoFiles),
            enabled: Arc::new(|| false),
            changed: Arc::new(|| {}),
            probe_cwd: dir.path().to_path_buf(),
            definitions: dir.path().join("acp-agents"),
            data_dir: dir.path().join("acp-agents"),
            env: Arc::new(|_: &str| None),
            mcp_bridge: None,
            registry: None,
        });
        let turns = AgentTurns {
            agents: agents.clone(),
            now_ms: Arc::new(|| 0_i64),
            blobs: BlobStore::new(dir.path()),
            interactive: mixdog_rt::testing::tokens().interactive_io,
            ledger: Arc::new(|| None::<Arc<dyn UsageSink>>),
            pricing: Arc::new(mixdog_ai::catalog::CatalogPricing(warm_catalog(dir.path()).await)),
        };
        let header = |model: &str| serde_json::json!({ "provider": "acp-antigravity", "model": model }).as_object().cloned().expect("a header");
        assert_eq!(turns.refusal(&header("claude-opus-5-5")), None, "the model's refusal is the turn's");
        let official = shipped("antigravity");
        assert_eq!(
            agents.refuses_model(&official, "claude-opus-5-5").as_deref(),
            Some("Antigravity (acp-antigravity) does not run the model \"claude-opus-5-5\". Choose it under Antigravity (acp-antigravity-cli).")
        );
        assert_eq!(
            turns.refusal(&header("gemini-4-neon")),
            Some("ACP agents are turned off in Settings.".to_owned()),
            "a model of its own is refused by the state"
        );
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

    /// A catalog with both price tables loaded from the cache files under `dir`, which price an OpenAI model and a Gemini
    /// model Google serves.
    #[allow(clippy::disallowed_methods, reason = "the test seeds the catalog's cache files")]
    async fn warm_catalog(dir: &std::path::Path) -> Arc<mixdog_ai::catalog::CatalogService> {
        use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, LITELLM_CACHE_FILE, MODELS_DEV_CACHE_FILE, ModelsDevSource};
        let priced = r#"{"fetchedAt":1,"data":{
            "gpt-x":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":0.000001,"output_cost_per_token":0.000002},
            "gemini/gemini-4-neon":{"litellm_provider":"gemini","mode":"chat","input_cost_per_token":0.000003,"output_cost_per_token":0.000015,"cache_read_input_token_cost":0.0000003}
        }}"#;
        std::fs::write(dir.join(LITELLM_CACHE_FILE), priced).expect("the price table");
        std::fs::write(dir.join(MODELS_DEV_CACHE_FILE), r#"{"fetchedAt":1,"data":{}}"#).expect("the model table");
        let tokens = mixdog_rt::testing::tokens();
        let io = || mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), io());
        let litellm = ModelsDevSource::litellm(Arc::new(Offline), dir.to_path_buf(), io());
        Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await.with_litellm(litellm).await)
    }

    /// A usage ledger in a data folder of its own, over a warm catalog, with the refresh that reprices it.
    struct LedgerRig {
        _dir: tempfile::TempDir,
        catalog: Arc<mixdog_ai::catalog::CatalogService>,
        path: std::path::PathBuf,
        writer: Arc<mixdog_ledger::writer::UsageWriter>,
        reader: Arc<mixdog_ledger::reader::UsageReader>,
        refresher: Arc<mixdog_ledger::refresh::UsageRefresher>,
    }

    impl LedgerRig {
        async fn new() -> Self {
            let dir = tempfile::tempdir().expect("a data folder");
            let catalog = warm_catalog(dir.path()).await;
            let tokens = mixdog_rt::testing::tokens();
            let path = dir.path().join("ledger.sqlite");
            let writer = mixdog_ledger::writer::UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).expect("the ledger");
            let reader = mixdog_ledger::reader::UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
            let pricer = mixdog_core_base::pricing::ledger_pricer::CatalogPricer::new(&catalog).expect("a warm catalog");
            let refresher = mixdog_ledger::refresh::UsageRefresher::new(Arc::new(pricer), tokens.cpu_bulk);
            Self { _dir: dir, catalog, path, writer, reader, refresher }
        }
    }

    /// The tokens an agent reports for a turn reach the usage ledger the usage page reads, under the session's route and
    /// with the time its model worked, priced as a provider's send prices its own: the ledger's refresh finds nothing to
    /// reprice in the row, so it writes nothing and copies no backup. A report of the agent's context alone records no
    /// row. The session's port is told every report, a stopped turn's closing surface included.
    #[tokio::test]
    async fn an_agents_turn_usage_is_recorded_in_the_usage_ledger_as_the_ledger_prices_it() {
        use mixdog_ledger::refresh::Refresh;
        let LedgerRig { _dir, catalog, path, writer, reader, refresher } = LedgerRig::new().await;
        let ledger: Ledger = {
            let writer = writer.clone();
            Arc::new(move || Some(Arc::new(mixdog_core::run_host::accounting_scope::LedgerSink(writer.clone())) as Arc<dyn UsageSink>))
        };
        let preset = shipped("antigravity");
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
            run_ms: 9_000,
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
        // The record spans the turn's whole run (9 s), not the 2 s its model streamed: the quota table spreads the turn's meter
        // rises over [ts - duration, ts]. The port, which feeds the session's readout, still gets the streaming time.
        let expected = ("acp-antigravity".to_owned(), model(), "sess_worker".to_owned(), "agent".to_owned(), 4_437.0, 144.0, 14_487.0, None, 9_000.0);
        assert_eq!(rows, [expected], "one row, and none for a report of the context alone");
        assert_eq!(port.0.lock().unwrap()[0].request_ms, 2_000);

        let Refresh::Repaired(report) = refresher.refresh(&writer, &reader, at + 1_000).await.expect("the refresh") else {
            panic!("the unpriced row is examined");
        };
        assert_eq!(report.still_unpriced, 1, "{report:?}");
        assert!(report.changes.is_empty() && report.integrity.is_none(), "nothing is repriced or rewritten: {report:?}");
    }

    /// An agent's route runs on the account its CLI signed in with: its turns' tokens are subscription usage, priced as the
    /// provider whose quota the agent shares prices the same tokens, and a model that provider has no price for stays
    /// unpriced. A row the route's turn wrote before as API usage is settled by the ledger's own refresh into the route a
    /// turn writes now, the turns' rows give the refresh nothing to repair, and the usage pages hold the route under one
    /// kind.
    #[tokio::test]
    async fn an_agents_turn_usage_is_subscription_usage_priced_as_the_provider_whose_quota_it_shares() {
        use mixdog_ledger::refresh::Refresh;
        let LedgerRig { _dir, catalog, path, writer, reader, refresher } = LedgerRig::new().await;
        let sink = Arc::new(mixdog_core::run_host::accounting_scope::LedgerSink(writer.clone())) as Arc<dyn UsageSink>;
        let preset = shipped("antigravity");
        let quota = preset.same_quota_as.clone().expect("the agent shares a provider's quota");
        let header =
            serde_json::json!({ "provider": preset.provider.as_str(), "model": "gemini-4-neon", "ownerSessionId": "sess_lead", "sourceType": "agent" })
                .as_object()
                .cloned()
                .expect("a header");
        let route = LedgerRoute::of(&header, &preset, &ThreadId::from("sess_worker".to_owned()));
        let pricing = mixdog_ai::catalog::CatalogPricing(catalog.clone());
        let at = 1_800_000_000_000;
        let usage = |model: &str| TurnUsage {
            input_tokens: 4_437,
            output_tokens: 144,
            cached_read_tokens: 14_487,
            total_tokens: Some(19_068),
            model: model.to_owned(),
            request_ms: 2_000,
            ..TurnUsage::default()
        };

        let mut earlier = route.row(&usage("gemini-4-neon"), at, &pricing).expect("tokens").expect("a row");
        earlier.kind = "api".to_owned();
        assert_eq!(earlier.cost_source, "unpriced", "{earlier:?}");
        sink.record_queued(earlier).await.expect("the earlier row is stored");

        catalog.bind_shared_quotas(shared_quotas(std::slice::from_ref(&preset)));
        let port = Port::default();
        let surface = Accounted {
            inner: Arc::new(port.clone()),
            ledger: Arc::new(move || Some(sink.clone())),
            pricing: Arc::new(mixdog_ai::catalog::CatalogPricing(catalog.clone())),
            route: route.clone(),
            now_ms: Arc::new(move || at + 1),
            report: Arc::default(),
        };
        surface.usage(usage("gemini-4-neon")).await.expect("the port takes it");
        // What the turn's end settles the ask with carries the cost the ledger priced, as the session's stats do.
        let settled_cost = surface.report.usage.lock().unwrap().as_ref().and_then(|(usage, _)| usage.cost);
        assert_eq!(settled_cost, port.0.lock().unwrap()[0].cost);
        assert!(settled_cost.is_some(), "the priced turn's settled usage carries its cost");
        surface.usage(usage("gpt-oss-120b")).await.expect("the port takes it");
        writer.settle_writes().await.expect("the rows are stored");

        let own = LedgerRoute { provider: quota, ..route.clone() }.row(&usage("gemini-4-neon"), at + 1, &pricing).expect("tokens").expect("a row");
        assert!(own.cost_usd.is_some(), "the provider whose quota the agent shares prices the model: {own:?}");
        let shown: Vec<Option<UsdTicks>> = port.0.lock().unwrap().iter().map(|usage| usage.cost).collect();
        assert_eq!(
            shown,
            [own.cost_usd.and_then(UsdTicks::from_usd), None],
            "the session's stats carry the cost the ledger records, and none for an unpriced turn"
        );
        type Stored = (String, String, String, Option<f64>, Option<String>, i64);
        #[allow(clippy::disallowed_types, reason = "Test-only read of the ledger file the test itself wrote.")]
        let stored = || -> Vec<Stored> {
            mixdog_ledger::db::Connection::open(&path)
                .expect("the ledger file")
                .prepare(
                    "SELECT json_extract(r.signature,'$[1]'), json_extract(r.signature,'$[2]'), json_extract(r.signature,'$[4]'), e.cost_usd,
                     json_extract(r.signature,'$[5]'), e.route FROM usage_events e JOIN usage_routes r ON r.id=e.route ORDER BY e.ts, 1",
                )
                .expect("the rows")
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))
                .expect("the rows")
                .collect::<Result<_, _>>()
                .expect("the rows")
        };
        let written = stored();
        assert_eq!(written.len(), 3, "{written:?}");
        let subscription = |model: &str| (model.to_owned(), "oauth".to_owned(), "subscription".to_owned(), own.cost_usd, own.rates.clone());
        let turn = |row: &Stored| (row.0.clone(), row.1.clone(), row.2.clone(), row.3, row.4.clone());
        assert_eq!((own.kind.as_str(), own.cost_source.as_str()), ("oauth", "subscription"), "{own:?}");
        assert_eq!(turn(&written[1]), subscription("gemini-4-neon"), "the provider's own row of the same tokens");
        assert_eq!((written[2].0.as_str(), written[2].1.as_str(), written[2].2.as_str(), written[2].3), ("gpt-oss-120b", "oauth", "unpriced", None));

        let Refresh::Repaired(report) = refresher.refresh(&writer, &reader, at + 1_000).await.expect("the refresh") else {
            panic!("the unpriced rows are examined");
        };
        let earlier_route = format!("{0} \u{2192} {0} / gemini-4-neon", preset.provider);
        assert_eq!(report.changes, std::collections::BTreeMap::from([(earlier_route, 1)]), "only the earlier row is repaired: {report:?}");
        assert_eq!((report.repriced, report.still_unpriced), (1, 1), "{report:?}");
        let settled = stored();
        assert_eq!(turn(&settled[0]), subscription("gemini-4-neon"), "the earlier row is settled as a turn writes it now");
        assert_eq!(settled[0].5, written[1].5, "into the turn's route");
        assert_eq!(settled[1..], written[1..], "the turns' rows are as they were written");
        #[allow(clippy::disallowed_types, reason = "Test-only read of the ledger file the test itself wrote.")]
        let kinds: Vec<String> = mixdog_ledger::db::Connection::open(&path)
            .expect("the ledger file")
            .prepare("SELECT DISTINCT kind FROM daily WHERE provider=?1")
            .expect("the days")
            .query_map([preset.provider.as_str()], |row| row.get(0))
            .expect("the days")
            .collect::<Result<_, _>>()
            .expect("the days");
        assert_eq!(kinds, ["oauth"], "the route's days are one kind's");
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
        assert!(KeptRefusals::in_data_dir(dir.path(), lane).read_windows().await.is_empty());
        let windows = HashMap::from([("antigravity".to_owned(), HashMap::from([("gem/1".to_owned(), 1_048_576), ("default".to_owned(), 200_000)]))]);
        KeptRefusals::in_data_dir(dir.path(), lane).keep_windows(windows.clone()).await;
        assert_eq!(KeptRefusals::in_data_dir(dir.path(), lane).read_windows().await, windows, "a model id with a slash collides with nothing");
        // The earlier form, one size for the agent, is dropped.
        #[allow(clippy::disallowed_methods, reason = "the test seeds the file an earlier version wrote")]
        std::fs::write(dir.path().join("acp-agent-windows.json"), br#"{"antigravity":1048576,"agy":{"m":5}}"#).expect("the earlier file");
        assert_eq!(KeptRefusals::in_data_dir(dir.path(), lane).read_windows().await, HashMap::from([("agy".to_owned(), HashMap::from([("m".to_owned(), 5)]))]));
        assert!(KeptRefusals::in_data_dir(dir.path(), lane).read().await.is_empty(), "the refusals are a file of their own");
    }
}
