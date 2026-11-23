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
use mixdog_core::run_host::assemble::handed_tools::HandedTools;
use mixdog_core::run_host::factory::History;
use mixdog_core::run_host::factory::OutsideAgents;
use mixdog_core::run_host::factory::OutsideAnswer;
use mixdog_core::run_host::factory::OutsideAsk;
use mixdog_core::run_host::factory::OutsideTurn;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_base::support::on_lane_wait;
use mixdog_core_session::session::RunOutcome;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnError;
use mixdog_rt::InteractiveIo;
use mixdog_store::blobs::BlobStore;
use mixdog_store::schema::record::Header;
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

/// The turns of sessions on an ACP agent's route: begun by the turn path, run in the agent.
pub struct AgentTurns {
    pub agents: Arc<Agents>,
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub blobs: BlobStore,
    pub interactive: InteractiveIo,
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

    fn prompts(&self, input: &Value) -> bool {
        !mixdog_acp::runs::is_wake(input)
    }

    async fn run(&self, turn: OutsideTurn) -> RunOutcome {
        let OutsideTurn { thread, turn, header, input, port, cancel, progress, transcript, calls, history, on_tool_result } = turn;
        let Some(preset) = self.preset_of(&header).cloned() else {
            return RunOutcome::Failed(TurnError { message: "The session's route names no agent.".to_owned(), data: Value::Null, provider_error: None });
        };
        let begun = AgentTurn {
            thread,
            turn,
            rules: prompt_of(&header),
            header,
            input,
            surface: Arc::new(port),
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
