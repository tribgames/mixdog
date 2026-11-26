//! Search-only ACP sessions implementing [`AcpSearchBackend`].
//!
//! Each search opens an ephemeral ACP session with no Mixdog tools handed over and every built-in
//! agent tool disabled except `search_web`, auto-approves only the agent's web search tool while
//! refusing all other permission requests, captures `SearchCall`s, citations, answer text and
//! usage, and maps `TurnEnd` cleanly into [`AcpSearchReply`] or [`AcpSearchError`].

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::UsdTicks;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::web::AcpSearchBackend;
use mixdog_tools::web::AcpSearchError;
use mixdog_tools::web::AcpSearchReply;
use mixdog_tools::web::AcpSearchRequest;
use mixdog_tools::web::NativeSource;
use mixdog_tools::web::SearchCall;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::agents::AUTH_REQUIRED;
use crate::agents::Agents;
use crate::agents::DEFAULT_MODEL;
use crate::agents::QuotaCheck;
use crate::agents::Readiness;
use crate::agents::Refusal;
use crate::agents::lock;
use crate::connection::Fault;
use crate::connection::Incoming;
use crate::connection::RpcError;
use crate::files::TextFiles;
use crate::preset::AgentPreset;
use crate::preset::OwnToolsOff;
use crate::preset::ProcessScope;
use crate::preset::Quirks;
use crate::rows::AgentTool;
use crate::rows::block_text;
use crate::session::AgentSession;
use crate::session::ContextUse;
use crate::session::Open;
use crate::session::OpenSharedError;
use crate::session::OwnedSession;
use crate::session::RefuseBudget;
use crate::session::not_offered;
use crate::surface::TurnUsage;
use crate::surface::input_excludes_cache;
use crate::surface::provider_usage;
use crate::turn::TurnEnd;

const SHARED_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const SEARCH_SANDBOX_DIR: &str = "search-sandbox";
const SEARCH_SANDBOX_FOLDER: &str = "the ACP web search sandbox folder";
const SEARCH_ONLY_RULES: &str = "\
You are running in a web-search-only session.
- Use ONLY your built-in web search tool (`search_web`) to answer the user's query.
- Do NOT inspect local files, run shell commands, fetch local paths, or call any other tool.
- Base your answer on the search results and cite sources with markdown links `[Title](https://...)`.";

fn now_ms() -> i64 {
    mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// [`TextFiles`] wrapper for web-search-only sessions that blocks every local file read and
/// exposes no readable roots while still allowing sandbox folder and agent-file lifecycle ops.
struct SearchNoReadFiles(Arc<dyn TextFiles>);

#[async_trait]
impl TextFiles for SearchNoReadFiles {
    async fn read(&self, _path: AbsPath) -> Result<String, String> {
        Err("file reads are disabled in web-search-only sessions".to_owned())
    }

    async fn read_bytes(&self, _path: AbsPath, _offset: u64, _len: u64) -> Result<Vec<u8>, String> {
        Err("file reads are disabled in web-search-only sessions".to_owned())
    }

    fn readable_roots(&self) -> Vec<AbsPath> {
        Vec::new()
    }

    async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
        self.0.resolved(path).await
    }

    async fn create(&self, path: AbsPath, text: String) -> Result<(), String> {
        self.0.create(path, text).await
    }

    async fn make_folder(&self, path: AbsPath) -> Result<(), String> {
        self.0.make_folder(path).await
    }

    async fn remove_folder(&self, path: AbsPath) -> Result<(), String> {
        self.0.remove_folder(path).await
    }

    async fn folders(&self, path: AbsPath) -> Result<Vec<String>, String> {
        self.0.folders(path).await
    }

    async fn replace(&self, path: AbsPath, text: String) -> Result<(), String> {
        self.0.replace(path, text).await
    }

    async fn rename(&self, from: AbsPath, to: AbsPath) -> Result<(), String> {
        self.0.rename(from, to).await
    }

    async fn remove_file(&self, path: AbsPath) -> Result<(), String> {
        self.0.remove_file(path).await
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SandboxState {
    Creating { remove_after: bool },
    Ready,
    Cleaned,
}

/// RAII guard for a per-search sandbox directory with ordered create-then-remove state transitions.
/// While `make_folder` is in flight, dropping marks `remove_after = true` so the creation task
/// itself runs `remove_folder` sequentially once creation completes instead of spawning a racing
/// deletion task. Once `Ready`, explicit [`Self::cleanup`] or `Drop` transitions to `Cleaned` and
/// removes the directory.
struct SearchSandbox {
    path: AbsPath,
    files: Arc<dyn TextFiles>,
    state: Arc<std::sync::Mutex<SandboxState>>,
}

impl SearchSandbox {
    #[cfg(test)]
    fn new(path: AbsPath, files: Arc<dyn TextFiles>) -> Self {
        Self { path, files, state: Arc::new(std::sync::Mutex::new(SandboxState::Ready)) }
    }

    async fn create(path: AbsPath, files: Arc<dyn TextFiles>) -> Result<Self, AcpSearchError> {
        let state = Arc::new(std::sync::Mutex::new(SandboxState::Creating { remove_after: false }));
        let sandbox = Self { path: path.clone(), files: files.clone(), state: state.clone() };
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task_path = path.clone();
        let task_files = files.clone();
        let task_state = state.clone();
        drop(mixdog_rt::spawn("acp.search.sandbox_create", mixdog_rt::TaskClass::Work, async move {
            let made = task_files.make_folder(task_path.clone()).await;
            let remove_now = {
                let mut guard = lock(&task_state);
                match *guard {
                    SandboxState::Creating { remove_after: true } => {
                        *guard = SandboxState::Cleaned;
                        true
                    }
                    SandboxState::Creating { remove_after: false } => {
                        if made.is_ok() {
                            *guard = SandboxState::Ready;
                            false
                        } else {
                            *guard = SandboxState::Cleaned;
                            true
                        }
                    }
                    SandboxState::Ready | SandboxState::Cleaned => false,
                }
            };
            if remove_now {
                crate::connection::remove_folder(task_files.as_ref(), task_path, SEARCH_SANDBOX_FOLDER).await;
            }
            let _ = tx.send(made);
        }));
        match rx.await {
            Ok(Ok(())) => Ok(sandbox),
            Ok(Err(error)) => Err(AcpSearchError::failed(format!("could not create ACP web search sandbox directory: {error}"))),
            Err(_) => Err(AcpSearchError::failed("could not create ACP web search sandbox directory")),
        }
    }

    fn path(&self) -> &AbsPath {
        &self.path
    }

    async fn cleanup(&mut self) {
        let remove_now = {
            let mut guard = lock(&self.state);
            match *guard {
                SandboxState::Creating { ref mut remove_after } => {
                    *remove_after = true;
                    false
                }
                SandboxState::Ready => {
                    *guard = SandboxState::Cleaned;
                    true
                }
                SandboxState::Cleaned => false,
            }
        };
        if remove_now {
            crate::connection::remove_folder(self.files.as_ref(), self.path.clone(), SEARCH_SANDBOX_FOLDER).await;
        }
    }
}

impl Drop for SearchSandbox {
    fn drop(&mut self) {
        let remove_now = {
            let mut guard = lock(&self.state);
            match *guard {
                SandboxState::Creating { ref mut remove_after } => {
                    *remove_after = true;
                    false
                }
                SandboxState::Ready => {
                    *guard = SandboxState::Cleaned;
                    true
                }
                SandboxState::Cleaned => false,
            }
        };
        if remove_now {
            let files = self.files.clone();
            let path = self.path.clone();
            if tokio::runtime::Handle::try_current().is_ok() {
                drop(mixdog_rt::spawn("acp.search.sandbox_cleanup", mixdog_rt::TaskClass::Work, async move {
                    crate::connection::remove_folder(files.as_ref(), path, SEARCH_SANDBOX_FOLDER).await;
                }));
            } else {
                tracing::warn!(
                    "[acp] {SEARCH_SANDBOX_FOLDER} {} was not removed on drop (no async runtime); deferred to startup sweep",
                    path.as_path().display()
                );
            }
        }
    }
}

impl Agents {
    /// Clears away stale per-search sandbox directories left behind by earlier daemon runs or
    /// failed removals.
    pub(crate) async fn sweep_search_sandboxes(&self) {
        let Some(root) = AbsPath::new(self.parts.data_dir.join(SEARCH_SANDBOX_DIR)) else { return };
        let Ok(folders) = self.parts.files.folders(root.clone()).await else { return };
        for name in folders {
            let stale = match name.strip_prefix("pid-").and_then(|rest| rest.split('-').next()).and_then(|pid| pid.parse::<u32>().ok()) {
                Some(pid) => pid != std::process::id() && !mixdog_statefile::process_exists(pid),
                None => true,
            };
            if stale && let Some(folder) = AbsPath::new(root.as_path().join(&name)) {
                crate::connection::remove_folder(self.parts.files.as_ref(), folder, SEARCH_SANDBOX_FOLDER).await;
            }
        }
    }
}

/// Holds a running search session's registration in `Agents::sessions` so ACP disable
/// (`release_all`) and CLI updater drain checks always see active search runs, and removes the
/// entry and sandbox automatically if the future is dropped early.
struct RegisteredSearchSession {
    agents: Arc<Agents>,
    thread_id: ThreadId,
    session: Arc<AgentSession>,
    sandbox: SearchSandbox,
    registered: bool,
}

impl RegisteredSearchSession {
    fn register(
        agents: Arc<Agents>,
        thread_id: ThreadId,
        opening: &crate::agents::Opening<'_>,
        owned: OwnedSession,
        sandbox: SearchSandbox,
    ) -> Result<Self, (AcpSearchError, SearchSandbox)> {
        let session = {
            let mut sessions = lock(&agents.sessions);
            if agents.stopping.load(Ordering::SeqCst) || agents.stop_token.is_cancelled() {
                drop(sessions);
                drop(owned);
                return Err((AcpSearchError::cancelled("This operation was aborted"), sandbox));
            }
            if !agents.enabled() || !opening.current() {
                drop(sessions);
                drop(owned);
                return Err((AcpSearchError::not_installed("ACP agents are turned off in Settings."), sandbox));
            }
            let session = owned.into_inner();
            sessions.insert(thread_id.clone(), session.clone());
            session
        };
        Ok(Self { agents, thread_id, session, sandbox, registered: true })
    }

    fn unregister(&mut self) {
        if self.registered {
            self.registered = false;
            lock(&self.agents.sessions).remove(&self.thread_id);
        }
    }
}

impl Drop for RegisteredSearchSession {
    fn drop(&mut self) {
        if self.registered {
            self.unregister();
            if !self.session.end_after_turn() {
                self.session.end();
            }
        }
    }
}

/// Concrete [`AcpSearchBackend`] backed by [`Agents`].
pub struct AgentWebSearch {
    agents: Arc<Agents>,
}

impl AgentWebSearch {
    pub fn new(agents: Arc<Agents>) -> Arc<Self> {
        Arc::new(Self { agents })
    }

    async fn create_sandbox(&self) -> Result<SearchSandbox, AcpSearchError> {
        let dir = self.agents.parts.data_dir.join(SEARCH_SANDBOX_DIR).join(format!("pid-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        let path = AbsPath::new(dir).ok_or_else(|| AcpSearchError::failed("could not create an isolated sandbox directory for ACP web search"))?;
        SearchSandbox::create(path, self.agents.parts.files.clone()).await
    }

    async fn open_search_session(
        &self,
        preset: &AgentPreset,
        search_preset: &AgentPreset,
        cancel: &CancellationToken,
    ) -> Result<RegisteredSearchSession, AcpSearchError> {
        if cancel.is_cancelled() {
            return Err(AcpSearchError::cancelled("This operation was aborted"));
        }
        let thread_id = ThreadId::from(format!("acp-search:{}", uuid::Uuid::new_v4().simple()));
        let opening = self.agents.begin_opening(thread_id.clone());
        let (program, _starting) = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(AcpSearchError::cancelled("This operation was aborted")),
            ready = self.agents.ready_program(preset) => ready.map_err(|refusal| refusal_to_error(preset, &refusal))?,
        };
        if !self.agents.enabled() || !opening.current() {
            return Err(AcpSearchError::not_installed("ACP agents are turned off in Settings."));
        }
        let mut sandbox = self.create_sandbox().await?;
        let cwd = sandbox.path().clone();
        let wake: crate::session::Wake = Arc::new(|| {});
        let no_read_files: Arc<dyn TextFiles> = Arc::new(SearchNoReadFiles(self.agents.parts.files.clone()));
        let open_session = async {
            match preset.scope {
                ProcessScope::PerSession => {
                    let open = Open {
                        preset: search_preset,
                        program: &program,
                        cwd,
                        definitions: &self.agents.parts.definitions,
                        stored: None,
                        rules: Some(SEARCH_ONLY_RULES.to_owned()),
                        held: None,
                        grants: Arc::default(),
                        handed: None,
                        temp: None,
                    };
                    AgentSession::open(self.agents.parts.processes.clone(), no_read_files, open, wake, Box::new(|| {})).await.map(OwnedSession::new)
                }
                ProcessScope::Shared => {
                    let mut result = Err(Fault::Start(format!("{} did not open a session in time", preset.label)));
                    for attempt in 0..2 {
                        let attempt_deadline = (attempt > 0).then(|| tokio::time::Instant::now() + SHARED_OPEN_TIMEOUT);
                        let (lease, existing) = match self.agents.shared_server_bounded(preset, &program, attempt_deadline).await {
                            Ok(found) => found,
                            Err(fault) => {
                                result = Err(fault);
                                break;
                            }
                        };
                        let server = lease.server().clone();
                        let open = Open {
                            preset: search_preset,
                            program: &program,
                            cwd: cwd.clone(),
                            definitions: &self.agents.parts.definitions,
                            stored: None,
                            rules: Some(SEARCH_ONLY_RULES.to_owned()),
                            held: None,
                            grants: Arc::default(),
                            handed: None,
                            temp: None,
                        };
                        let timeout = match attempt_deadline {
                            Some(deadline) => Some(deadline.saturating_duration_since(tokio::time::Instant::now())),
                            None => existing.then_some(SHARED_OPEN_TIMEOUT),
                        };
                        match AgentSession::open_on_shared_owned(lease, open, wake.clone(), Box::new(|| {}), timeout).await {
                            Ok(owned) => {
                                result = Ok(owned);
                                break;
                            }
                            Err(OpenSharedError::TimedOut) => {
                                tracing::warn!(
                                    "[acp.search] {}'s shared server did not open a search session within {:?}: {}",
                                    preset.id,
                                    SHARED_OPEN_TIMEOUT,
                                    if existing && attempt == 0 { "replacing it" } else { "giving up" }
                                );
                                self.agents.retire_wedged_shared(&server);
                                if existing && attempt == 0 {
                                    continue;
                                }
                                result = Err(Fault::Start(format!("{} did not open a session in time", preset.label)));
                                break;
                            }
                            Err(OpenSharedError::Fault(Fault::Closed(_))) if existing && attempt == 0 => {
                                self.agents.retire_wedged_shared(&server);
                                continue;
                            }
                            Err(OpenSharedError::Fault(fault)) => {
                                result = Err(fault);
                                break;
                            }
                        }
                    }
                    result
                }
            }
        };
        let opened = tokio::select! {
            biased;
            () = cancel.cancelled() => {
                sandbox.cleanup().await;
                return Err(AcpSearchError::cancelled("This operation was aborted"));
            }
            opened = open_session => opened,
        };
        let owned = match opened {
            Ok(owned) => owned,
            Err(fault) => {
                sandbox.cleanup().await;
                self.agents.open_failed(preset, &fault).await;
                return Err(fault_to_error(preset, &fault));
            }
        };
        if let Some(Readiness::Ready { models, .. }) = lock(&self.agents.slots).get(&preset.id).and_then(|slot| slot.readiness.as_ref()) {
            owned.session().adopt_models(models);
        }
        let registered = match RegisteredSearchSession::register(self.agents.clone(), thread_id, &opening, owned, sandbox) {
            Ok(registered) => registered,
            Err((err, mut sandbox)) => {
                sandbox.cleanup().await;
                return Err(err);
            }
        };
        if registered.session.gone().is_cancelled() {
            let fault = registered.session.closed();
            self.cleanup_session(preset, registered, None).await;
            return Err(fault_to_error(preset, &fault));
        }
        Ok(registered)
    }

    async fn cleanup_session(&self, preset: &AgentPreset, mut registered: RegisteredSearchSession, cancelled_prompt: Option<u64>) {
        let session = registered.session.clone();
        if let Some(prompt_id) = cancelled_prompt {
            session.cancel(Some(prompt_id));
            if preset.scope == ProcessScope::Shared {
                self.agents.abandon_shared(preset, &session.session_id);
            }
            session.end();
        } else {
            if session.closes && !session.gone().is_cancelled() && !self.agents.stop_token.is_cancelled() {
                let _ = mixdog_rt::time::timeout(CLOSE_TIMEOUT, session.close()).await;
            }
            session.end();
        }
        registered.unregister();
        registered.sandbox.cleanup().await;
    }
}

#[async_trait]
impl AcpSearchBackend for AgentWebSearch {
    async fn search(&self, request: AcpSearchRequest, cancel: &CancellationToken) -> Result<AcpSearchReply, AcpSearchError> {
        if cancel.is_cancelled() {
            return Err(AcpSearchError::cancelled("This operation was aborted"));
        }
        let Some(preset) = self.agents.preset_of_route(&request.provider) else {
            return Err(AcpSearchError::unavailable(format!("no ACP preset is configured for provider \"{}\"", request.provider)));
        };
        if !self.agents.enabled() {
            return Err(AcpSearchError::not_installed("ACP agents are turned off in Settings."));
        }
        let search_preset = search_only_preset(preset)?;
        if let Some(message) = self.agents.refuses_model(preset, &request.model) {
            return Err(AcpSearchError::refusal(message));
        }

        let registered = self.open_search_session(preset, &search_preset, cancel).await?;
        let session = registered.session.clone();

        if request.model != DEFAULT_MODEL {
            let model = crate::tiers::agent_model(&session.models(), &preset.quirks.effort_tiers, &request.model, request.effort.as_deref());
            let selected = tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    self.cleanup_session(preset, registered, None).await;
                    return Err(AcpSearchError::cancelled("This operation was aborted"));
                }
                () = session.gone().cancelled() => {
                    let fault = session.closed();
                    self.cleanup_session(preset, registered, None).await;
                    return Err(fault_to_error(preset, &fault));
                }
                selected = session.select_model(&model) => selected,
            };
            if let Err(fault) = selected {
                self.agents.open_failed(preset, &fault).await;
                self.cleanup_session(preset, registered, None).await;
                return Err(fault_to_error(preset, &fault));
            }
        }

        let current_model = session.models().current;
        let outcome = run_search_turn(&session, &search_preset.quirks, &request, cancel).await;
        self.cleanup_session(preset, registered, outcome.cancelled_prompt).await;

        let served_model = current_model.clone().or_else(|| (request.model != DEFAULT_MODEL).then(|| request.model.clone()));
        let (usage, excludes_cache) = outcome.usage.as_ref().map(|u| (Some(provider_usage(u)), input_excludes_cache(u))).unwrap_or((None, false));

        match outcome.end {
            TurnEnd::Completed { text, stop_reason, tool_calls } => {
                let mapped = map_turn_outcome(
                    TurnEnd::Completed { text, stop_reason, tool_calls },
                    &request.provider,
                    served_model,
                    outcome.citations,
                    outcome.calls,
                    usage,
                    excludes_cache,
                );
                if mapped.is_ok() {
                    self.agents.answered(preset).await;
                }
                mapped
            }
            TurnEnd::Interrupted => Err(AcpSearchError::cancelled("This operation was aborted").with_usage(usage, excludes_cache)),
            TurnEnd::Refused { message } => {
                self.agents.refused(preset, &message).await;
                Err(AcpSearchError::refusal(message).with_usage(usage, excludes_cache))
            }
            TurnEnd::Failed { message, code, reported } => {
                if code == Some(AUTH_REQUIRED) {
                    self.agents.signed_out(preset, message.clone()).await;
                    return Err(AcpSearchError::sign_in(message).with_usage(usage, excludes_cache));
                }
                if reported {
                    let check = QuotaCheck { model: &request.model, current: current_model.as_deref(), now_ms: now_ms(), stop: cancel };
                    let turn_error = self.agents.failure(preset, message.clone(), code, Value::Null, Some(check)).await;
                    let is_quota = turn_error.provider_error.as_ref().is_some_and(|detail| detail.kind == "quota_exhausted");
                    if is_quota || is_capacity_failure(&message, code) {
                        return Err(AcpSearchError::capacity(message).with_usage(usage, excludes_cache));
                    }
                }
                map_turn_outcome(
                    TurnEnd::Failed { message, code, reported },
                    &request.provider,
                    served_model,
                    outcome.citations,
                    outcome.calls,
                    usage,
                    excludes_cache,
                )
            }
        }
    }
}

/// Clones `preset` into a search-only preset: keeps every non-search built-in tool disabled while
/// enabling `search_web`, disables client-side `fs/read_text_file`, clears eager MCP servers (no
/// Mixdog tools are handed over), and disables Mixdog tool-preference guidance.
///
/// `OwnToolsOff::AgentFile` presets cannot disable non-search built-ins without Mixdog tool
/// handover (`handed: None`), so they are excluded from search-only sessions fail-closed.
pub(crate) fn search_only_preset(preset: &AgentPreset) -> Result<AgentPreset, AcpSearchError> {
    if matches!(preset.own_tools_off, Some(OwnToolsOff::AgentFile(_))) {
        return Err(AcpSearchError::unavailable(format!(
            "ACP provider \"{}\" cannot enforce search-only tool isolation without Mixdog tool handover",
            preset.provider
        )));
    }
    let mut search = preset.clone();
    search.quirks.append_tool_guidance = false;
    search.quirks.fs_read_text_file = false;
    search.quirks.replies_without_prompt = false;
    if let Some(OwnToolsOff::SessionMeta(meta)) = &mut search.own_tools_off {
        meta.disabled_tools.retain(|tool| !tool.eq_ignore_ascii_case("search_web"));
        meta.eager_mcp_servers.clear();
    }
    Ok(search)
}

fn search_prompt(request: &AcpSearchRequest, unsent_rules: Option<String>) -> String {
    let mut parts = Vec::new();
    if let Some(rules) = unsent_rules.filter(|text| !text.trim().is_empty()) {
        parts.push(rules);
    }
    let mut prompt = format!("Search the web and answer the following query using your `search_web` tool.\n\nQuery: {}", request.query.trim());
    if let Some(site) = request.site.as_deref().map(str::trim).filter(|site| !site.is_empty()) {
        prompt.push_str(&format!("\nSite filter: restrict results to {site}"));
    }
    if let Some(locale) = &request.locale {
        let formatted = match locale {
            Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
            Value::Null => None,
            other => Some(other.to_string()),
        };
        if let Some(locale) = formatted {
            prompt.push_str(&format!("\nLocale: {locale}"));
        }
    }
    if request.max_results > 0 {
        prompt.push_str(&format!("\nTarget results: up to {}", request.max_results));
    }
    if !request.context_size.trim().is_empty() {
        prompt.push_str(&format!("\nSearch depth: {}", request.context_size.trim()));
    }
    prompt.push_str("\n\nProvide a concise, well-sourced answer with markdown links `[Title](https://...)` to the pages used.");
    parts.push(prompt);
    parts.join("\n\n")
}

struct SearchTurnOutcome {
    end: TurnEnd,
    calls: Vec<SearchCall>,
    citations: Vec<NativeSource>,
    usage: Option<TurnUsage>,
    cancelled_prompt: Option<u64>,
}

enum PendingSearchRpc {
    /// An in-flight tool *grant* response (`allow_once` / `allow_always`): mid-write interruption
    /// breaks the connection so an uncancelled grant cannot slip through.
    Grant { id: Value, write_state: Arc<AtomicU8> },
    /// An in-flight permission *refusal* response: completes cleanly through bounded teardown
    /// without breaking healthy sibling sessions on a busy shared connection.
    Refusal { done: tokio::sync::oneshot::Receiver<()> },
    /// An in-flight `not_offered` rejection for an unsupported RPC method.
    Other { done: tokio::sync::oneshot::Receiver<()> },
}

async fn refuse_incoming_item(session: &Arc<AgentSession>, item: Incoming, refuse_budget: &mut RefuseBudget) {
    match item {
        Incoming::Request { id, method, .. } if method == "session/request_permission" => {
            refuse_budget.refuse(session, id).await;
        }
        Incoming::Request { id, method, .. } => {
            if !session.connection.exited().is_cancelled() {
                let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                let write_session = session.clone();
                drop(mixdog_rt::spawn("acp.search.reject_rpc", mixdog_rt::TaskClass::Work, async move {
                    if !write_session.connection.exited().is_cancelled() {
                        write_session.connection.respond(id, Err(not_offered(&method))).await;
                    }
                    let _ = done_tx.send(());
                }));
                refuse_budget.wait_write(session, done_rx, "search unsupported RPC refusal timed out on stalled stdin").await;
            }
        }
        Incoming::Tool(ask) => {
            ask.refuse("Mixdog tools are unavailable in web-search-only sessions.");
        }
        _ => {}
    }
}

async fn drain_search_rpcs_and_detach(
    session: &Arc<AgentSession>,
    pending: Option<PendingSearchRpc>,
    queue: VecDeque<Incoming>,
    mut stream: Option<tokio::sync::mpsc::UnboundedReceiver<Incoming>>,
    refuse_budget: &mut RefuseBudget,
    cancel_prompt: Option<u64>,
) {
    if let Some(pending) = pending {
        match pending {
            PendingSearchRpc::Grant { id, write_state } => {
                abort_search_grant_write(session, refuse_budget, &write_state, id, "search permission grant write interrupted on teardown").await;
            }
            PendingSearchRpc::Refusal { done } => {
                refuse_budget.wait_write(session, done, "search permission refusal write timed out on stalled stdin").await;
            }
            PendingSearchRpc::Other { done } => {
                refuse_budget.wait_write(session, done, "search unsupported RPC refusal write timed out on stalled stdin").await;
            }
        }
    }
    for item in queue {
        refuse_incoming_item(session, item, refuse_budget).await;
    }
    // Keep `routing.turn` active while draining all currently buffered stream messages and finishing
    // their refusal writes, so `RegisteredSearchSession::drop` cannot call `session.end()` early.
    if let Some(rx) = stream.as_mut() {
        loop {
            let batch: Vec<Incoming> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
            if batch.is_empty() {
                break;
            }
            for item in batch {
                refuse_incoming_item(session, item, refuse_budget).await;
            }
        }
    }
    let ended = match stream {
        Some(stream) => session.detach_quiet_with_budget(stream, refuse_budget).await,
        None => false,
    };
    if !ended && let Some(prompt_id) = cancel_prompt {
        session.cancel(Some(prompt_id));
    }
}

struct SearchTurnTeardownState {
    stream: Option<tokio::sync::mpsc::UnboundedReceiver<Incoming>>,
    queue: VecDeque<Incoming>,
    pending: Option<PendingSearchRpc>,
    prompt_id: Option<u64>,
    refuse_budget: RefuseBudget,
}

/// Unified RAII owner for a running search turn's stream, queued messages, and any currently
/// dequeued RPC. Both explicit [`Self::teardown`] and [`Drop`] launch the same single
/// non-cancellable cleanup task so dropping during `teardown().await` or mid-turn never loses
/// pending/queued refusals, detach, or deferred `session.end()`.
struct SearchTurnGuard {
    session: Arc<AgentSession>,
    state: Option<SearchTurnTeardownState>,
    teardown_done: Option<tokio::sync::oneshot::Receiver<()>>,
}

impl SearchTurnGuard {
    fn new(session: Arc<AgentSession>, waiting: Vec<Incoming>, stream: tokio::sync::mpsc::UnboundedReceiver<Incoming>) -> Self {
        Self {
            session,
            state: Some(SearchTurnTeardownState {
                stream: Some(stream),
                queue: waiting.into(),
                pending: None,
                prompt_id: None,
                refuse_budget: RefuseBudget::new(),
            }),
            teardown_done: None,
        }
    }

    fn state_mut(&mut self) -> &mut SearchTurnTeardownState {
        self.state.as_mut().expect("search turn state held until teardown")
    }

    fn start_teardown(&mut self, cancel_prompt_on_drop: bool) {
        let Some(mut state) = self.state.take() else { return };
        if let Some(PendingSearchRpc::Grant { write_state, .. }) = &state.pending
            && write_state.compare_exchange(GRANT_BEFORE_WRITE, GRANT_CANCELLED_BEFORE_WRITE, Ordering::SeqCst, Ordering::SeqCst).is_err()
            && write_state.compare_exchange(GRANT_WRITING, GRANT_DONE, Ordering::SeqCst, Ordering::SeqCst).is_ok()
        {
            // Break the connection synchronously inside Drop/teardown before the async cleanup task
            // is scheduled so already-queued grant bytes cannot be delivered to the agent.
            self.session.break_connection("search permission grant write interrupted on teardown");
        }
        let session = self.session.clone();
        let pending = state.pending.take();
        let queue = std::mem::take(&mut state.queue);
        let stream = state.stream.take();
        let cancel_prompt = if cancel_prompt_on_drop { state.prompt_id.take() } else { None };
        let mut refuse_budget = state.refuse_budget;
        if tokio::runtime::Handle::try_current().is_ok() {
            let (done_tx, done_rx) = tokio::sync::oneshot::channel();
            drop(mixdog_rt::spawn("acp.search.turn_teardown", mixdog_rt::TaskClass::Work, async move {
                drain_search_rpcs_and_detach(&session, pending, queue, stream, &mut refuse_budget, cancel_prompt).await;
                let _ = done_tx.send(());
            }));
            self.teardown_done = Some(done_rx);
        } else {
            session.end();
        }
    }

    async fn teardown(&mut self) {
        self.start_teardown(false);
        if let Some(done_rx) = self.teardown_done.take() {
            let _ = done_rx.await;
        }
    }
}

impl Drop for SearchTurnGuard {
    fn drop(&mut self) {
        self.start_teardown(true);
    }
}

async fn run_search_turn(session: &Arc<AgentSession>, quirks: &Quirks, request: &AcpSearchRequest, cancel: &CancellationToken) -> SearchTurnOutcome {
    let started_at_ms = now_ms();
    let (waiting, stream) = session.attach(true);
    let mut guard = SearchTurnGuard::new(session.clone(), waiting, stream);
    let prompt_text = search_prompt(request, session.take_unsent_prompt());
    let prompt_blocks = vec![json!({ "type": "text", "text": prompt_text })];

    let prompt_id = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            guard.teardown().await;
            return SearchTurnOutcome { end: TurnEnd::Interrupted, calls: Vec::new(), citations: Vec::new(), usage: None, cancelled_prompt: None };
        }
        () = session.gone().cancelled() => {
            let fault = session.closed();
            guard.teardown().await;
            return SearchTurnOutcome {
                end: TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false },
                calls: Vec::new(),
                citations: Vec::new(),
                usage: None,
                cancelled_prompt: None,
            };
        }
        sent = session.prompt(prompt_blocks) => match sent {
            Ok(id) => id,
            Err(fault) => {
                guard.teardown().await;
                return SearchTurnOutcome {
                    end: TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false },
                    calls: Vec::new(),
                    citations: Vec::new(),
                    usage: None,
                    cancelled_prompt: None,
                };
            }
        },
    };
    guard.state_mut().prompt_id = Some(prompt_id);

    let mut state = SearchTurnState::default();
    let mut cancelled_prompt = None;

    let ended: Result<Value, TurnEnd> = loop {
        let next = if let Some(item) = guard.state_mut().queue.pop_front() {
            Some(item)
        } else {
            let stream = guard.state_mut().stream.as_mut().expect("search turn stream held until teardown");
            tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    cancelled_prompt = Some(prompt_id);
                    break Err(TurnEnd::Interrupted);
                }
                () = session.gone().cancelled() => {
                    let fault = session.closed();
                    break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                }
                item = stream.recv() => item,
            }
        };
        let Some(incoming) = next else {
            let fault = session.closed();
            break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
        };

        match incoming {
            Incoming::Notification { method, params } if method == "session/update" => {
                let update = &params["update"];
                state.handle_update(session, quirks, update);
            }
            Incoming::Request { id, method, params } if method == "session/request_permission" => {
                let (answer, is_grant) = decide_search_permission(&params, &mut state);
                if cancel.is_cancelled() {
                    guard.state_mut().queue.push_front(Incoming::Request { id, method, params });
                    cancelled_prompt = Some(prompt_id);
                    break Err(TurnEnd::Interrupted);
                }
                if session.gone().is_cancelled() {
                    guard.state_mut().queue.push_front(Incoming::Request { id, method, params });
                    let fault = session.closed();
                    break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                }
                if is_grant {
                    let write_state = Arc::new(AtomicU8::new(GRANT_BEFORE_WRITE));
                    guard.state_mut().pending = Some(PendingSearchRpc::Grant { id: id.clone(), write_state: write_state.clone() });
                    let granted = send_search_permission_grant_with_state(session, id, answer, cancel, write_state).await;
                    if granted {
                        guard.state_mut().pending = None;
                    } else {
                        // Leave `PendingSearchRpc::Grant` armed so the non-cancellable teardown task
                        // finishes aborting or refusing it safely.
                        if session.gone().is_cancelled() && !cancel.is_cancelled() {
                            let fault = session.closed();
                            break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                        }
                        cancelled_prompt = Some(prompt_id);
                        break Err(TurnEnd::Interrupted);
                    }
                } else {
                    if guard.state_mut().refuse_budget.stalled() || guard.state_mut().refuse_budget.remaining().is_zero() {
                        guard.state_mut().refuse_budget.mark_stalled(session, "search permission refusal budget exhausted on stalled stdin");
                        let fault = session.closed();
                        break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                    }
                    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                    let write_session = session.clone();
                    drop(mixdog_rt::spawn("acp.search.refuse_write", mixdog_rt::TaskClass::Work, async move {
                        if !write_session.connection.exited().is_cancelled() {
                            write_session.connection.respond(id, Ok(answer)).await;
                        }
                        let _ = done_tx.send(());
                    }));
                    guard.state_mut().pending = Some(PendingSearchRpc::Refusal { done: done_rx });
                    let limit = guard.state_mut().refuse_budget.remaining();
                    let started = tokio::time::Instant::now();
                    let done = match guard.state_mut().pending.as_mut() {
                        Some(PendingSearchRpc::Refusal { done }) => done,
                        _ => unreachable!(),
                    };
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => {
                            guard.state_mut().refuse_budget.consume(started.elapsed());
                            cancelled_prompt = Some(prompt_id);
                            break Err(TurnEnd::Interrupted);
                        }
                        () = session.gone().cancelled() => {
                            guard.state_mut().refuse_budget.consume(started.elapsed());
                            let fault = session.closed();
                            break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                        }
                        timed = mixdog_rt::time::timeout(limit, done) => {
                            guard.state_mut().refuse_budget.consume(started.elapsed());
                            guard.state_mut().pending = None;
                            if timed.is_err() {
                                guard
                                    .state_mut()
                                    .refuse_budget
                                    .mark_stalled(session, "search permission refusal write timed out on stalled stdin");
                                let fault = session.closed();
                                break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                            }
                        }
                    }
                }
            }
            Incoming::Request { id, method, .. } => {
                if guard.state_mut().refuse_budget.stalled() || guard.state_mut().refuse_budget.remaining().is_zero() {
                    guard.state_mut().refuse_budget.mark_stalled(session, "search unsupported RPC refusal budget exhausted on stalled stdin");
                    let fault = session.closed();
                    break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                }
                let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                let write_session = session.clone();
                drop(mixdog_rt::spawn("acp.search.reject_rpc", mixdog_rt::TaskClass::Work, async move {
                    if !write_session.connection.exited().is_cancelled() {
                        write_session.connection.respond(id, Err(not_offered(&method))).await;
                    }
                    let _ = done_tx.send(());
                }));
                guard.state_mut().pending = Some(PendingSearchRpc::Other { done: done_rx });
                let limit = guard.state_mut().refuse_budget.remaining();
                let started = tokio::time::Instant::now();
                let done = match guard.state_mut().pending.as_mut() {
                    Some(PendingSearchRpc::Other { done }) => done,
                    _ => unreachable!(),
                };
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => {
                        guard.state_mut().refuse_budget.consume(started.elapsed());
                        cancelled_prompt = Some(prompt_id);
                        break Err(TurnEnd::Interrupted);
                    }
                    () = session.gone().cancelled() => {
                        guard.state_mut().refuse_budget.consume(started.elapsed());
                        let fault = session.closed();
                        break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                    }
                    timed = mixdog_rt::time::timeout(limit, done) => {
                        guard.state_mut().refuse_budget.consume(started.elapsed());
                        guard.state_mut().pending = None;
                        if timed.is_err() {
                            guard
                                .state_mut()
                                .refuse_budget
                                .mark_stalled(session, "search unsupported RPC refusal write timed out on stalled stdin");
                            let fault = session.closed();
                            break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                        }
                    }
                }
            }
            Incoming::Tool(ask) => {
                ask.refuse("Mixdog tools are unavailable in web-search-only sessions.");
            }
            Incoming::Response { id, result } if id == prompt_id => {
                guard.state_mut().prompt_id = None;
                match result {
                    Ok(answer) => break Ok(answer),
                    Err(error) => break Err(rpc_error_to_turn_end(quirks, error)),
                }
            }
            Incoming::Notification { .. } | Incoming::Response { .. } => {}
        }
    };

    guard.teardown().await;
    if let Some((count, context)) = state.seen_context {
        session.mark_context_reported(count);
        let _ = context;
    }

    let (calls, citations) = extract_calls_and_citations(&state, &request.query);
    let end_ms = now_ms();
    let run_ms = (end_ms - started_at_ms).max(0) as u64;

    match ended {
        Ok(answer) => {
            let usage = usage_of(&answer, state.seen_context.map(|(_, ctx)| ctx), state.cost, &request.model, started_at_ms, run_ms, calls.len() as u64);
            // A trailing failure notice with no usage is the agent reporting a failure inside the reply.
            if let Some(held) = state.held.take() {
                if usage.is_none()
                    && let Some(said) = quirks.failure_notice(&held)
                {
                    let end = classify_reported_failure(quirks, said, None, None);
                    return SearchTurnOutcome { end, calls, citations, usage, cancelled_prompt };
                }
                state.answer.push_str(&held);
            }
            let final_text = state.answer.trim().to_owned();
            if calls.is_empty() && !final_text.is_empty() && quirks.account_refusals.iter().any(|marker| final_text.contains(marker.as_str())) {
                return SearchTurnOutcome { end: TurnEnd::Refused { message: final_text }, calls, citations, usage, cancelled_prompt };
            }
            let stop_reason = answer.get("stopReason").and_then(Value::as_str).map(str::to_owned);
            // Re-extract citations now that any held answer chunk has been appended.
            let (calls, citations) = extract_calls_and_citations(&state, &request.query);
            SearchTurnOutcome {
                end: TurnEnd::Completed { text: final_text, stop_reason, tool_calls: calls.len() as u64 },
                calls,
                citations,
                usage,
                cancelled_prompt,
            }
        }
        Err(end) => {
            let usage = if state.seen_context.is_some() || state.cost.is_some() {
                Some(TurnUsage {
                    context: state.seen_context.map(|(_, ctx)| ctx),
                    cost: state.cost,
                    model: request.model.clone(),
                    tool_calls: calls.len() as u64,
                    started_at_ms,
                    request_ms: run_ms,
                    run_ms,
                    ..TurnUsage::default()
                })
            } else {
                None
            };
            SearchTurnOutcome { end, calls, citations, usage, cancelled_prompt }
        }
    }
}

const GRANT_BEFORE_WRITE: u8 = 0;
const GRANT_WRITING: u8 = 1;
const GRANT_DONE: u8 = 2;
const GRANT_CANCELLED_BEFORE_WRITE: u8 = 3;

struct SearchGrantCancelWaker {
    armed: AtomicBool,
    state: Arc<AtomicU8>,
    connection: Arc<crate::connection::Connection>,
    why: &'static str,
    skip_if_exited: bool,
}

impl std::task::Wake for SearchGrantCancelWaker {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        if !self.armed.swap(false, Ordering::SeqCst) {
            return;
        }
        if self.skip_if_exited && self.connection.exited().is_cancelled() {
            return;
        }
        if self.state.compare_exchange(GRANT_BEFORE_WRITE, GRANT_CANCELLED_BEFORE_WRITE, Ordering::SeqCst, Ordering::SeqCst).is_err()
            && self.state.load(Ordering::SeqCst) == GRANT_WRITING
        {
            self.connection.break_off(self.why);
        }
    }
}

struct SyncSearchGrantCancelHook {
    waker_state: Arc<SearchGrantCancelWaker>,
    _waiter: std::pin::Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>>,
}

impl SyncSearchGrantCancelHook {
    fn arm(token: &CancellationToken, state: Arc<AtomicU8>, connection: Arc<crate::connection::Connection>, why: &'static str, skip_if_exited: bool) -> Self {
        let waker_state = Arc::new(SearchGrantCancelWaker { armed: AtomicBool::new(true), state, connection, why, skip_if_exited });
        let mut waiter = Box::pin(token.clone().cancelled_owned());
        let waker = std::task::Waker::from(waker_state.clone());
        let mut cx = std::task::Context::from_waker(&waker);
        if waiter.as_mut().poll(&mut cx).is_ready() {
            std::task::Wake::wake_by_ref(&waker_state);
        }
        Self { waker_state, _waiter: waiter }
    }

    fn disarm(&self) {
        self.waker_state.armed.store(false, Ordering::SeqCst);
    }
}

impl Drop for SyncSearchGrantCancelHook {
    fn drop(&mut self) {
        self.disarm();
    }
}

async fn abort_search_grant_write(session: &Arc<AgentSession>, refuse_budget: &mut RefuseBudget, write_state: &AtomicU8, id: Value, why: &str) {
    let state = write_state.swap(GRANT_WRITING, Ordering::SeqCst);
    if state == GRANT_BEFORE_WRITE || state == GRANT_CANCELLED_BEFORE_WRITE {
        refuse_budget.refuse(session, id).await;
        write_state.store(GRANT_DONE, Ordering::SeqCst);
    } else if state == GRANT_WRITING {
        session.break_connection(why);
        write_state.store(GRANT_DONE, Ordering::SeqCst);
    } else {
        write_state.store(GRANT_DONE, Ordering::SeqCst);
    }
}

#[cfg(test)]
async fn send_search_permission_grant(
    session: &Arc<AgentSession>,
    refuse_budget: &mut RefuseBudget,
    id: Value,
    answer: Value,
    cancel: &CancellationToken,
) -> bool {
    let write_state = Arc::new(AtomicU8::new(GRANT_BEFORE_WRITE));
    let granted = send_search_permission_grant_with_state(session, id.clone(), answer, cancel, write_state.clone()).await;
    if !granted {
        abort_search_grant_write(session, refuse_budget, &write_state, id, "search permission grant write aborted").await;
    }
    granted
}

async fn send_search_permission_grant_with_state(
    session: &Arc<AgentSession>,
    id: Value,
    answer: Value,
    cancel: &CancellationToken,
    write_state: Arc<AtomicU8>,
) -> bool {
    let cancel_hook =
        SyncSearchGrantCancelHook::arm(cancel, write_state.clone(), session.connection.clone(), "search permission grant write stalled past turn stop", false);
    let gone_hook = SyncSearchGrantCancelHook::arm(
        session.gone(),
        write_state.clone(),
        session.connection.clone(),
        "search permission grant write stalled on ended session",
        true,
    );
    let write_id = id;
    let write_state_for_send = write_state;
    let respond = async move {
        if write_state_for_send.compare_exchange(GRANT_BEFORE_WRITE, GRANT_WRITING, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return false;
        }
        session.connection.respond(write_id, Ok(answer)).await;
        write_state_for_send.store(GRANT_DONE, Ordering::SeqCst);
        true
    };
    tokio::select! {
        biased;
        () = cancel.cancelled() => {
            cancel_hook.disarm();
            gone_hook.disarm();
            false
        }
        () = session.gone().cancelled() => {
            cancel_hook.disarm();
            gone_hook.disarm();
            false
        }
        wrote = respond => {
            cancel_hook.disarm();
            gone_hook.disarm();
            wrote
        }
    }
}

#[derive(Default)]
struct SearchTurnState {
    answer: String,
    held: Option<String>,
    order: Vec<String>,
    tools: HashMap<String, AgentTool>,
    mcp_tools: HashSet<String>,
    refused_call_ids: HashSet<String>,
    chunk_citations: Vec<NativeSource>,
    seen_context: Option<(u64, ContextUse)>,
    cost: Option<UsdTicks>,
    refused_tools: Vec<String>,
}

impl SearchTurnState {
    fn flush_held(&mut self) {
        if let Some(held) = self.held.take() {
            self.answer.push_str(&held);
        }
    }

    fn merge_tool(&mut self, update: &Value) -> Option<String> {
        let id = update.get("toolCallId").and_then(Value::as_str).filter(|id| !id.trim().is_empty())?.to_owned();
        if is_mcp_tool_call(update) {
            self.mcp_tools.insert(id.clone());
        }
        if !self.tools.contains_key(&id) {
            self.order.push(id.clone());
            self.tools.insert(id.clone(), AgentTool { id: id.clone(), ..AgentTool::default() });
        }
        if let Some(tool) = self.tools.get_mut(&id) {
            tool.merge(update);
        }
        Some(id)
    }

    fn handle_update(&mut self, session: &AgentSession, quirks: &Quirks, update: &Value) {
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
        if matches!(kind, "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" | "plan") {
            self.flush_held();
        }
        match kind {
            "agent_message_chunk" => {
                if let Some(content) = update.get("content") {
                    match content.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = content.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                                if quirks.failure_notice(text).is_some() {
                                    self.held = Some(text.to_owned());
                                } else {
                                    self.answer.push_str(text);
                                }
                            }
                        }
                        Some("resource_link" | "resource") => {
                            collect_sources_from_content_block(content, &mut self.chunk_citations);
                        }
                        _ => {
                            if let Some(text) = block_text(content) {
                                self.answer.push_str(&text);
                            }
                        }
                    }
                }
            }
            "tool_call" | "tool_call_update" => {
                self.merge_tool(update);
            }
            "usage_update" => {
                if let Some(cost) = cost_of(update) {
                    self.cost = Some(cost);
                }
                if let Some(context) = session.unreported_context() {
                    self.seen_context = Some(context);
                }
            }
            _ => {}
        }
    }
}

/// Decides a `session/request_permission` payload in a search-only session.
///
/// Only the agent's built-in web search tool is auto-approved (preferring `allow_once`);
/// every other tool call is refused (preferring `reject_once`, then `reject_always`, else `cancelled`).
/// Returns `(response_payload, is_grant)`.
fn decide_search_permission(params: &Value, state: &mut SearchTurnState) -> (Value, bool) {
    let tool_call = params.get("toolCall").unwrap_or(&Value::Null);
    let options = options_of(params);

    let tool_id = state.merge_tool(tool_call);
    let merged = if let Some(id) = tool_id.as_deref() {
        state.tools.get(id).cloned().unwrap_or_default()
    } else {
        let mut tool = AgentTool::default();
        tool.merge(tool_call);
        tool
    };

    let call_id = tool_id.as_deref().filter(|id| !id.trim().is_empty());
    let is_mcp = is_mcp_tool_call(tool_call) || call_id.is_some_and(|id| state.mcp_tools.contains(id));
    let previously_refused = call_id.is_some_and(|id| state.refused_call_ids.contains(id));
    if call_id.is_some() && !previously_refused && !is_mcp && is_web_search_tool(&merged) {
        let allow =
            options.iter().find(|(_, kind)| kind == "allow_once").or_else(|| options.iter().find(|(_, kind)| kind == "allow_always")).map(|(id, _)| id.clone());
        if allow.is_some() {
            return (permission_outcome(allow), true);
        }
    }

    if let Some(id) = call_id {
        state.refused_call_ids.insert(id.to_owned());
    }
    let label = if !merged.tool.is_empty() {
        merged.tool.clone()
    } else if !merged.title.is_empty() {
        merged.title.clone()
    } else {
        "unknown".to_owned()
    };
    state.refused_tools.push(label);
    (permission_outcome(rejection_option(&options)), false)
}

fn is_mcp_tool_call(call: &Value) -> bool {
    if call.pointer("/_meta/mcp").is_some_and(|v| !v.is_null()) {
        return true;
    }
    if call.pointer("/rawInput/ServerName").and_then(Value::as_str).is_some() {
        return true;
    }
    ["name", "tool"].iter().filter_map(|key| call.get(*key).and_then(Value::as_str)).any(|name| {
        let lower = name.trim().to_ascii_lowercase();
        lower.starts_with("mcp_") || lower.starts_with("mcp__")
    })
}

/// Returns true only when `tool` has an explicit, verified built-in web search tool identity
/// with no MCP prefix, no non-search local/execution kind, and no local filesystem/shell input keys.
pub(crate) fn is_web_search_tool(tool: &AgentTool) -> bool {
    let name = tool.tool.trim().to_ascii_lowercase();
    if name.is_empty() || name.starts_with("mcp_") || name.starts_with("mcp__") {
        return false;
    }
    if matches!(tool.kind.as_str(), "read" | "edit" | "delete" | "move" | "execute" | "think" | "switch_mode") {
        return false;
    }
    if has_local_tool_input(&tool.input) {
        return false;
    }
    matches!(name.as_str(), "search_web" | "web_search" | "google_search" | "google_web_search")
}

fn is_completed_search_tool(tool: &AgentTool) -> bool {
    let status = tool.status.trim().to_ascii_lowercase();
    if matches!(status.as_str(), "completed" | "complete" | "succeeded" | "success" | "done") {
        return true;
    }
    if matches!(status.as_str(), "pending" | "in_progress" | "running" | "failed" | "error" | "cancelled" | "canceled" | "refused" | "denied") {
        return false;
    }
    status.is_empty() && tool.output.is_some()
}

fn has_local_tool_input(input: &Value) -> bool {
    let Some(obj) = input.as_object() else { return false };
    const EXTRA_LOCAL_KEYS: [&str; 10] = ["paths", "file", "filepath", "directory", "targetdirectory", "target_directory", "dir", "cwd", "pattern", "regex"];
    obj.keys().any(|key| {
        crate::rows::FILE_INPUT_KEYS.iter().any(|local| key.eq_ignore_ascii_case(local))
            || crate::rows::COMMAND_INPUT_KEYS.iter().any(|local| key.eq_ignore_ascii_case(local))
            || EXTRA_LOCAL_KEYS.iter().any(|local| key.eq_ignore_ascii_case(local))
    })
}

fn options_of(params: &Value) -> Vec<(String, String)> {
    params
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| Some((option.get("optionId")?.as_str()?.to_owned(), option.get("kind")?.as_str()?.to_owned())))
        .collect()
}

fn rejection_option(options: &[(String, String)]) -> Option<String> {
    options.iter().find(|(_, kind)| kind == "reject_once").or_else(|| options.iter().find(|(_, kind)| kind == "reject_always")).map(|(id, _)| id.clone())
}

fn permission_outcome(option: Option<String>) -> Value {
    match option {
        Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

fn cost_of(update: &Value) -> Option<UsdTicks> {
    let cost = update.get("cost")?.as_object()?;
    if let Some(currency) = cost.get("currency").and_then(Value::as_str)
        && !currency.eq_ignore_ascii_case("usd")
    {
        return None;
    }
    UsdTicks::from_usd(cost.get("amount").and_then(Value::as_f64)?)
}

fn usage_of(
    answer: &Value,
    reported: Option<ContextUse>,
    cost: Option<UsdTicks>,
    model: &str,
    started_at_ms: i64,
    run_ms: u64,
    tool_calls: u64,
) -> Option<TurnUsage> {
    let usage = answer.get("usage").filter(|usage| usage.is_object());
    if usage.is_none() && reported.is_none() && cost.is_none() {
        return None;
    }
    let count = |key: &str| usage.and_then(|usage| usage.get(key)).and_then(Value::as_u64);
    Some(TurnUsage {
        input_tokens: count("inputTokens").unwrap_or(0),
        output_tokens: count("outputTokens").unwrap_or(0),
        cached_read_tokens: count("cachedReadTokens").unwrap_or(0),
        cached_write_tokens: count("cachedWriteTokens").unwrap_or(0),
        thought_tokens: count("thoughtTokens"),
        total_tokens: count("totalTokens"),
        context: reported,
        model: model.to_owned(),
        tool_calls,
        started_at_ms,
        request_ms: run_ms,
        run_ms,
        cost,
    })
}

fn extract_calls_and_citations(state: &SearchTurnState, fallback_query: &str) -> (Vec<SearchCall>, Vec<NativeSource>) {
    let mut calls = Vec::new();
    let mut all_citations = Vec::new();
    let mut seen_citations: HashMap<String, usize> = HashMap::new();

    for source in &state.chunk_citations {
        push_citation(&mut all_citations, &mut seen_citations, source.clone());
    }
    for source in extract_sources_from_text(&state.answer) {
        push_citation(&mut all_citations, &mut seen_citations, source);
    }

    for id in &state.order {
        if state.mcp_tools.contains(id) || state.refused_call_ids.contains(id) {
            continue;
        }
        let Some(tool) = state.tools.get(id) else { continue };
        if !is_web_search_tool(tool) || !is_completed_search_tool(tool) {
            continue;
        }
        let query = extract_query(&tool.input, &tool.title, fallback_query);
        let mut raw_sources = Vec::new();
        if let Some(output) = &tool.output {
            collect_sources_from_value(output, &mut raw_sources);
        }
        for block in &tool.content {
            collect_sources_from_content_block(block, &mut raw_sources);
        }
        let mut sources = Vec::new();
        let mut seen_call: HashMap<String, usize> = HashMap::new();
        for source in raw_sources {
            push_citation(&mut sources, &mut seen_call, source.clone());
            push_citation(&mut all_citations, &mut seen_citations, source);
        }
        let urls: Vec<String> = sources.iter().map(|source| source.url.clone()).collect();
        calls.push(SearchCall { query, sources, urls });
    }

    (calls, all_citations)
}

fn extract_query(input: &Value, title: &str, fallback: &str) -> String {
    if let Some(text) = input.as_str().map(str::trim).filter(|text| !text.is_empty()) {
        return text.to_owned();
    }
    if let Some(obj) = input.as_object() {
        for key in ["query", "q", "search_query", "searchQuery", "Query", "prompt"] {
            if let Some(text) = obj.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()) {
                return text.to_owned();
            }
        }
    }
    let trimmed_title = title.trim();
    if !trimmed_title.is_empty()
        && !matches!(
            trimmed_title.to_ascii_lowercase().as_str(),
            "search_web" | "web_search" | "search web" | "web search" | "run search_web?" | "running search_web"
        )
    {
        return trimmed_title.to_owned();
    }
    fallback.trim().to_owned()
}

fn push_citation(target: &mut Vec<NativeSource>, seen: &mut HashMap<String, usize>, mut source: NativeSource) {
    let Some(url) = normalize_http_url(&source.url) else { return };
    source.url = url.clone();
    source.title = source.title.trim().to_owned();
    source.snippet = source.snippet.trim().to_owned();
    if let Some(&idx) = seen.get(&url) {
        let existing = &mut target[idx];
        if existing.title.is_empty() && !source.title.is_empty() {
            existing.title = source.title;
        }
        if existing.snippet.is_empty() && !source.snippet.is_empty() {
            existing.snippet = source.snippet;
        }
        if existing.published_date.is_none() && source.published_date.is_some() {
            existing.published_date = source.published_date;
        }
        return;
    }
    seen.insert(url, target.len());
    target.push(source);
}

fn normalize_http_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches(|ch| matches!(ch, '<' | '>' | '"' | '\''));
    let parsed = Url::parse(trimmed).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.to_string())
}

fn collect_sources_from_content_block(block: &Value, out: &mut Vec<NativeSource>) {
    let block = if block.get("type").and_then(Value::as_str) == Some("content") { block.get("content").unwrap_or(block) } else { block };
    match block.get("type").and_then(Value::as_str) {
        Some("resource_link") => {
            if let Some(uri) = block.get("uri").and_then(Value::as_str) {
                let title = block.get("title").or_else(|| block.get("name")).and_then(Value::as_str).unwrap_or_default().to_owned();
                let snippet = block.get("description").and_then(Value::as_str).unwrap_or_default().to_owned();
                out.push(NativeSource { url: uri.to_owned(), title, snippet, published_date: None });
            }
        }
        Some("resource") => {
            if let Some(resource) = block.get("resource") {
                if let Some(uri) = resource.get("uri").and_then(Value::as_str) {
                    let snippet = resource.get("text").and_then(Value::as_str).unwrap_or_default().to_owned();
                    out.push(NativeSource { url: uri.to_owned(), title: String::new(), snippet, published_date: None });
                } else if let Some(text) = resource.get("text").and_then(Value::as_str) {
                    collect_sources_from_text_or_json(text, out);
                }
            }
        }
        Some("text") => {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                collect_sources_from_text_or_json(text, out);
            }
        }
        _ => collect_sources_from_value(block, out),
    }
}

fn collect_sources_from_text_or_json(text: &str, out: &mut Vec<NativeSource>) {
    let trimmed = text.trim();
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
    {
        collect_sources_from_value(&parsed, out);
        return;
    }
    out.extend(extract_sources_from_text(text));
}

fn collect_sources_from_value(value: &Value, out: &mut Vec<NativeSource>) {
    match value {
        Value::String(text) => {
            if let Some(url) = normalize_http_url(text) {
                out.push(NativeSource { url, ..NativeSource::default() });
            } else {
                collect_sources_from_text_or_json(text, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_sources_from_value(item, out);
            }
        }
        Value::Object(map) => {
            let direct_url = ["url", "uri", "link", "href"].iter().find_map(|key| map.get(*key).and_then(Value::as_str));
            if let Some(url) = direct_url {
                let title = ["title", "name"].iter().find_map(|key| map.get(*key).and_then(Value::as_str)).unwrap_or_default().to_owned();
                let snippet = ["snippet", "description", "summary", "content", "text", "body"]
                    .iter()
                    .find_map(|key| map.get(*key).and_then(Value::as_str))
                    .unwrap_or_default()
                    .to_owned();
                let published_date =
                    ["published_date", "publishedDate", "date"].iter().find_map(|key| map.get(*key).and_then(Value::as_str)).map(str::to_owned);
                out.push(NativeSource { url: url.to_owned(), title, snippet, published_date });
            }
            for (key, nested) in map {
                if matches!(key.as_str(), "url" | "uri" | "link" | "href" | "title" | "name" | "published_date" | "publishedDate" | "date") {
                    continue;
                }
                if direct_url.is_some() && matches!(key.as_str(), "snippet" | "description" | "summary" | "content" | "text" | "body") {
                    continue;
                }
                collect_sources_from_value(nested, out);
            }
        }
        _ => {}
    }
}

/// Scans a markdown link destination starting right after `[title](`, handling balanced
/// parentheses inside URLs (e.g. Wikipedia links), `<...>` wrapped URLs, and optional titles.
/// Returns `(raw_url, close_paren_offset)`.
fn scan_markdown_link_dest(rest: &str) -> Option<(&str, usize)> {
    let trimmed_start = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    let body = &rest[trimmed_start..];
    if let Some(after_open) = body.strip_prefix('<') {
        let close_angle = after_open.find('>')?;
        let url = &after_open[..close_angle];
        if url.contains('\n') || url.contains('\r') {
            return None;
        }
        let after_angle = &after_open[close_angle + 1..];
        let close_paren = after_angle.find(')')?;
        if after_angle[..close_paren].contains('\n') {
            return None;
        }
        let end = trimmed_start + 1 + close_angle + 1 + close_paren;
        return Some((url.trim(), end));
    }

    let mut paren_depth = 0usize;
    let mut url_end: Option<usize> = None;
    for (idx, ch) in body.char_indices() {
        match ch {
            '\n' | '\r' => return None,
            '(' => {
                if url_end.is_none() {
                    paren_depth += 1;
                }
            }
            ')' => {
                if paren_depth == 0 {
                    let raw_url = &body[..url_end.unwrap_or(idx)];
                    return Some((raw_url.trim(), trimmed_start + idx));
                }
                paren_depth -= 1;
            }
            ch if ch.is_whitespace() && paren_depth == 0 && url_end.is_none() => {
                url_end = Some(idx);
            }
            _ => {}
        }
    }
    None
}

/// Scans a bare `http(s)://...` URL, preserving balanced parentheses inside the URL while stopping
/// at an unmatched `)` that closes surrounding prose.
fn scan_bare_url_end(rest: &str) -> usize {
    let mut paren_depth = 0usize;
    for (idx, ch) in rest.char_indices() {
        match ch {
            ch if ch.is_whitespace() || matches!(ch, ']' | '>' | '"' | '\'' | '`') => return idx,
            '(' => paren_depth += 1,
            ')' => {
                if paren_depth == 0 {
                    return idx;
                }
                paren_depth -= 1;
            }
            _ => {}
        }
    }
    rest.len()
}

/// Extracts markdown links `[Title](https://...)` and bare `http(s)://...` URLs from text.
fn extract_sources_from_text(text: &str) -> Vec<NativeSource> {
    let mut sources = Vec::new();
    let mut seen_urls = HashSet::new();

    // First pass: markdown links `[title](url)`
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'['
            && let Some(close_bracket) = text[i + 1..].find(']')
        {
            let title_start = i + 1;
            let title_end = title_start + close_bracket;
            let after_bracket = title_end + 1;
            if bytes.get(after_bracket) == Some(&b'(')
                && let Some((raw_url, close_paren)) = scan_markdown_link_dest(&text[after_bracket + 1..])
            {
                let url_end = after_bracket + 1 + close_paren;
                let title = text[title_start..title_end].trim();
                if !title.contains('\n')
                    && let Some(url) = normalize_http_url(raw_url)
                {
                    seen_urls.insert(url.clone());
                    sources.push(NativeSource { url, title: title.to_owned(), snippet: String::new(), published_date: None });
                    i = url_end + 1;
                    continue;
                }
            }
        }
        i += 1;
    }

    // Second pass: bare `http://` or `https://` URLs not already captured with a markdown title.
    let mut search_from = 0;
    while let Some(offset) = find_http_scheme(&text[search_from..]) {
        let start = search_from + offset;
        let rest = &text[start..];
        let end = scan_bare_url_end(rest);
        let candidate = rest[..end].trim_end_matches(|ch: char| matches!(ch, '.' | ',' | ';' | ':' | '!' | '?'));
        if let Some(url) = normalize_http_url(candidate)
            && seen_urls.insert(url.clone())
        {
            sources.push(NativeSource { url, title: String::new(), snippet: String::new(), published_date: None });
        }
        search_from = start + end.max(1);
    }

    sources
}

fn find_http_scheme(text: &str) -> Option<usize> {
    let https = text.find("https://");
    let http = text.find("http://");
    match (https, http) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn rpc_error_to_turn_end(quirks: &Quirks, error: RpcError) -> TurnEnd {
    let data = match &error.data {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Value::Object(map) => {
            map.get("details").or_else(|| map.get("message")).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned)
        }
        _ => None,
    };
    classify_reported_failure(quirks, error.message, data, Some(error.code))
}

fn classify_reported_failure(quirks: &Quirks, message: String, data: Option<String>, code: Option<i64>) -> TurnEnd {
    let says = |markers: &[String]| {
        markers.iter().any(|marker| message.contains(marker.as_str()) || data.as_deref().is_some_and(|detail| detail.contains(marker.as_str())))
    };
    let refused = says(&quirks.account_refusals);
    let signed_out = says(&quirks.signed_out_failures);
    let full = match data {
        Some(detail) if !detail.is_empty() && !message.contains(&detail) => format!("{message}: {detail}"),
        _ => message,
    };
    if refused {
        return TurnEnd::Refused { message: full };
    }
    let code = if signed_out { Some(AUTH_REQUIRED) } else { code };
    TurnEnd::Failed { message: full, code, reported: true }
}

pub(crate) fn map_turn_outcome(
    end: TurnEnd,
    provider: &str,
    model: Option<String>,
    citations: Vec<NativeSource>,
    calls: Vec<SearchCall>,
    usage: Option<Usage>,
    input_excludes_cache: bool,
) -> Result<AcpSearchReply, AcpSearchError> {
    match end {
        TurnEnd::Completed { text, stop_reason, .. } => {
            if let Some(reason) = stop_reason.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
                let lower = reason.to_ascii_lowercase();
                if matches!(lower.as_str(), "cancelled" | "canceled" | "aborted") {
                    return Err(
                        AcpSearchError::cancelled(format!("ACP web search on \"{provider}\" was cancelled ({reason})")).with_usage(usage, input_excludes_cache)
                    );
                }
                if matches!(lower.as_str(), "refusal" | "refused" | "safety" | "content_filter") {
                    return Err(
                        AcpSearchError::refusal(format!("ACP web search on \"{provider}\" was refused ({reason})")).with_usage(usage, input_excludes_cache)
                    );
                }
            }
            if calls.is_empty() {
                return Err(AcpSearchError::refusal(format!("ACP web search on \"{provider}\" completed without a successful search_web call"))
                    .with_usage(usage, input_excludes_cache));
            }
            Ok(AcpSearchReply { answer: text, model, citations, calls, usage, input_excludes_cache })
        }
        TurnEnd::Interrupted => Err(AcpSearchError::cancelled("This operation was aborted").with_usage(usage, input_excludes_cache)),
        TurnEnd::Refused { message } => Err(AcpSearchError::refusal(message).with_usage(usage, input_excludes_cache)),
        TurnEnd::Failed { message, code, .. } => {
            if code == Some(AUTH_REQUIRED) {
                return Err(AcpSearchError::sign_in(message).with_usage(usage, input_excludes_cache));
            }
            if is_capacity_failure(&message, code) {
                return Err(AcpSearchError::capacity(message).with_usage(usage, input_excludes_cache));
            }
            Err(AcpSearchError::failed(message).with_usage(usage, input_excludes_cache))
        }
    }
}

fn is_capacity_failure(message: &str, code: Option<i64>) -> bool {
    if matches!(code, Some(429 | 503)) {
        return true;
    }
    let lower = message.to_ascii_lowercase();
    lower.contains("resource_exhausted")
        || lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("too many requests")
        || lower.contains("quota exceeded")
        || lower.contains("capacity")
        || lower.contains("(code 429)")
        || lower.contains("status 429")
        || lower.contains("http 429")
}

fn fault_code(fault: &Fault) -> Option<i64> {
    match fault {
        Fault::Rpc(error) => Some(error.code),
        _ => None,
    }
}

fn fault_to_error(preset: &AgentPreset, fault: &Fault) -> AcpSearchError {
    match fault {
        Fault::NotFound => AcpSearchError::not_installed(format!("{} is not installed: `{}` was not found.", preset.label, preset.command)),
        Fault::Rpc(error) if error.code == AUTH_REQUIRED => AcpSearchError::sign_in(format!("{} is signed out. Sign in to it in Settings.", preset.label)),
        Fault::Rpc(error) if preset.quirks.signed_out_failures.iter().any(|m| error.message.contains(m.as_str())) => {
            AcpSearchError::sign_in(error.message.clone())
        }
        Fault::Rpc(error) if is_capacity_failure(&error.message, Some(error.code)) => AcpSearchError::capacity(error.message.clone()),
        Fault::Rpc(error) => AcpSearchError::failed(error.message.clone()),
        other => AcpSearchError::failed(format!("{}: {other}", preset.label)),
    }
}

fn refusal_to_error(preset: &AgentPreset, refusal: &Refusal) -> AcpSearchError {
    let message = refusal.message(preset);
    match refusal {
        Refusal::Off | Refusal::NotReady(Readiness::NotInstalled | Readiness::Unsupported | Readiness::VersionTooOld { .. } | Readiness::VersionUnknown) => {
            AcpSearchError::not_installed(message)
        }
        Refusal::NotReady(Readiness::SignedOut { .. }) => AcpSearchError::sign_in(message),
        Refusal::Fault(Fault::Rpc(error)) if error.code == AUTH_REQUIRED => AcpSearchError::sign_in(message),
        Refusal::NotReady(Readiness::Failed { message: detail, .. })
            if preset.quirks.account_refusals.iter().any(|marker| detail.contains(marker.as_str())) =>
        {
            AcpSearchError::refusal(detail.clone())
        }
        Refusal::Fault(fault) => fault_to_error(preset, fault),
        Refusal::NotReady(_) | Refusal::Closed => AcpSearchError::failed(message),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::process::ProcessError;
    use mixdog_core_api::domain::process::ProcessEvent;
    use mixdog_core_api::domain::process::ProcessInfo;
    use mixdog_core_api::domain::process::ProcessManager;
    use mixdog_core_api::domain::process::PtySize;
    use mixdog_core_api::domain::process::SpawnRequest;
    use mixdog_core_api::domain::process::SpawnedProcess;
    use mixdog_protocol::ids::ProcessHandle;
    use mixdog_tools::web::AcpSearchErrorKind;
    use tokio::sync::mpsc;

    use super::*;
    use crate::connection::Connection;
    use crate::connection::Launch;

    struct ScriptedEvents(mpsc::UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for ScriptedEvents {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    struct ScriptedAgent {
        events: Mutex<Option<mpsc::UnboundedReceiver<ProcessEvent>>>,
        written_tx: mpsc::UnboundedSender<Value>,
        written_buf: Mutex<String>,
        killed: Arc<AtomicBool>,
    }

    #[async_trait]
    impl ProcessManager for ScriptedAgent {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            Ok(SpawnedProcess { handle: request.handle, pid: 42 })
        }

        fn subscribe(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let rx = self.events.lock().unwrap().take().expect("single subscriber");
            Ok(Box::new(ScriptedEvents(rx)))
        }

        fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            self.subscribe(handle, from_seq)
        }

        async fn write_stdin(&self, _handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let mut buf = self.written_buf.lock().unwrap();
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buf.find('\n') {
                let line: String = buf.drain(..=pos).collect();
                let trimmed = line.trim();
                if !trimmed.is_empty()
                    && let Ok(val) = serde_json::from_str::<Value>(trimmed)
                {
                    let _ = self.written_tx.send(val);
                }
            }
            Ok(())
        }

        fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }

        fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
            Ok(())
        }

        fn kill(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    fn emit_json(tx: &mpsc::UnboundedSender<ProcessEvent>, seq: &mut u64, value: Value) {
        *seq += 1;
        let mut line = serde_json::to_string(&value).unwrap();
        line.push('\n');
        let _ = tx.send(ProcessEvent::Output { seq: *seq, stream: mixdog_core_api::domain::process::OutputStream::Stdout, bytes: line.into_bytes() });
    }

    fn sample_request() -> AcpSearchRequest {
        AcpSearchRequest {
            provider: "acp-antigravity".into(),
            model: "gemini-2.5-pro".into(),
            effort: None,
            query: "rust async traits".into(),
            site: Some("rust-lang.org".into()),
            locale: Some(json!("en-US")),
            max_results: 5,
            context_size: "medium".into(),
        }
    }

    #[test]
    fn search_only_preset_enables_search_web_and_keeps_other_tools_disabled() {
        let presets = crate::preset::builtin();
        let official = presets.iter().find(|p| p.id == "antigravity").expect("antigravity preset");
        let search = search_only_preset(official).expect("SessionMeta preset supports search-only isolation");
        let Some(OwnToolsOff::SessionMeta(meta)) = &search.own_tools_off else {
            panic!("expected SessionMeta");
        };
        assert!(!meta.disabled_tools.iter().any(|t| t == "search_web"), "search_web must be enabled");
        assert!(meta.disabled_tools.iter().any(|t| t == "run_command"), "run_command must stay disabled");
        assert!(meta.disabled_tools.iter().any(|t| t == "view_file"), "view_file must stay disabled");
        assert!(meta.disabled_tools.iter().any(|t| t == "edit_file"), "edit_file must stay disabled");
        assert!(meta.disabled_tools.iter().any(|t| t == "read_url_content"), "read_url_content must stay disabled");
        assert!(meta.eager_mcp_servers.is_empty(), "search-only preset hands no MCP servers");
        assert!(!search.quirks.append_tool_guidance);
        assert!(!search.quirks.fs_read_text_file, "client fs/read_text_file must be disabled");

        let cli = presets.iter().find(|p| p.id == "antigravity-cli").expect("antigravity-cli preset");
        let err = search_only_preset(cli).expect_err("OwnToolsOff::AgentFile preset must be excluded from search-only sessions");
        assert_eq!(err.kind, AcpSearchErrorKind::Unavailable);
    }

    #[tokio::test]
    async fn search_no_read_files_blocks_reads_and_exposes_no_roots() {
        struct AllowAllFiles(AbsPath);

        #[async_trait]
        impl TextFiles for AllowAllFiles {
            async fn read(&self, _path: AbsPath) -> Result<String, String> {
                Ok("secret".into())
            }
            fn readable_roots(&self) -> Vec<AbsPath> {
                vec![self.0.clone()]
            }
            async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
                Ok(path)
            }
            async fn create(&self, _path: AbsPath, _text: String) -> Result<(), String> {
                Ok(())
            }
        }

        let root = AbsPath::new(std::env::current_dir().unwrap()).unwrap();
        let wrapped = SearchNoReadFiles(Arc::new(AllowAllFiles(root.clone())));
        assert!(wrapped.readable_roots().is_empty());
        assert!(wrapped.read(root.clone()).await.is_err());
        assert!(wrapped.read_bytes(root, 0, 16).await.is_err());
    }

    #[test]
    fn permission_gating_is_fail_closed_and_tracks_sticky_mcp_provenance() {
        let options = json!([
            { "optionId": "allow-1", "kind": "allow_once" },
            { "optionId": "deny-1", "kind": "reject_once" }
        ]);
        let mut state = SearchTurnState::default();

        // Unnamed tool with a spoofed "Searching the web" title MUST be refused (fail-closed).
        let unnamed = json!({
            "toolCall": { "toolCallId": "u-1", "title": "Searching the web", "kind": "search", "rawInput": { "query": "cats" } },
            "options": options,
        });
        assert_eq!(decide_search_permission(&unnamed, &mut state), (json!({ "outcome": { "outcome": "selected", "optionId": "deny-1" } }), false));

        // Tool named search_web with local file input keys MUST be refused.
        let local_input = json!({
            "toolCall": { "toolCallId": "u-2", "name": "search_web", "kind": "search", "rawInput": { "path": "/etc/passwd" } },
            "options": options,
        });
        assert_eq!(decide_search_permission(&local_input, &mut state), (json!({ "outcome": { "outcome": "selected", "optionId": "deny-1" } }), false));

        // Sticky MCP provenance: initial tool_call marks _meta.mcp, later permission request drops _meta.mcp.
        state.merge_tool(&json!({
            "toolCallId": "mcp-1",
            "name": "search_web",
            "_meta": { "mcp": { "server": "evil", "tool": "search_web" } }
        }));
        let later_ask = json!({
            "toolCall": { "toolCallId": "mcp-1", "name": "search_web", "kind": "search", "rawInput": { "query": "rust" } },
            "options": options,
        });
        assert_eq!(decide_search_permission(&later_ask, &mut state), (json!({ "outcome": { "outcome": "selected", "optionId": "deny-1" } }), false));
        assert!(state.mcp_tools.contains("mcp-1"));
        assert!(state.refused_call_ids.contains("mcp-1"));
    }

    #[test]
    fn cancelled_refused_stop_reason_and_incomplete_search_calls_are_not_success() {
        let sample_call = SearchCall { query: "rust".into(), sources: Vec::new(), urls: Vec::new() };

        // Agent-side stopReason=cancelled -> Cancelled error even if a call ran.
        let err = map_turn_outcome(
            TurnEnd::Completed { text: "partial".into(), stop_reason: Some("cancelled".into()), tool_calls: 1 },
            "acp-antigravity",
            None,
            Vec::new(),
            vec![sample_call.clone()],
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(err.kind, AcpSearchErrorKind::Cancelled);

        // Agent-side stopReason=refusal -> Refusal error even if a call ran.
        let err = map_turn_outcome(
            TurnEnd::Completed { text: "cannot comply".into(), stop_reason: Some("refusal".into()), tool_calls: 1 },
            "acp-antigravity",
            None,
            Vec::new(),
            vec![sample_call],
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(err.kind, AcpSearchErrorKind::Refusal);

        // Pending (permission-only) or failed search_web calls do NOT count as completed SearchCalls.
        let mut state = SearchTurnState::default();
        state.merge_tool(&json!({ "toolCallId": "ws-pending", "name": "search_web", "status": "pending", "rawInput": { "query": "q1" } }));
        state.merge_tool(&json!({ "toolCallId": "ws-failed", "name": "search_web", "status": "failed", "rawInput": { "query": "q2" } }));
        state.merge_tool(&json!({ "toolCallId": "ws-perm-only", "name": "search_web", "rawInput": { "query": "q3" } }));
        let (calls, _) = extract_calls_and_citations(&state, "fallback");
        assert!(calls.is_empty(), "only genuinely completed search_web calls may count as SearchCalls");
    }

    #[tokio::test]
    async fn grant_write_cancel_before_vs_during_write_behaves_safely() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let launch = Launch {
            program: "fake-agent".into(),
            args: Vec::new(),
            env: Vec::new(),
            env_remove: Vec::new(),
            cwd: AbsPath::new(std::env::current_dir().unwrap()).unwrap(),
        };
        let (connection, _incoming) = Connection::start(manager, launch).await.unwrap();
        let session = AgentSession::test_session_for(connection);
        let mut budget = RefuseBudget::new();

        // Cancel BEFORE write -> sends cancelled refusal, does NOT break connection.
        let state_before = AtomicU8::new(GRANT_BEFORE_WRITE);
        abort_search_grant_write(&session, &mut budget, &state_before, json!(99), "cancelled before write").await;
        let msg = written_rx.recv().await.expect("refusal written");
        assert_eq!(msg["id"], 99);
        assert_eq!(msg["result"]["outcome"]["outcome"], "cancelled");
        assert!(!killed.load(Ordering::SeqCst), "cancel before write must keep connection alive");

        // Cancel DURING write -> breaks connection instead of writing a conflicting response.
        let state_writing = AtomicU8::new(GRANT_WRITING);
        abort_search_grant_write(&session, &mut budget, &state_writing, json!(100), "cancelled mid-write").await;
        assert!(killed.load(Ordering::SeqCst), "in-flight grant write cancel must break connection");
        assert!(written_rx.try_recv().is_err(), "no conflicting second response written");
        drop(event_tx);
    }

    #[test]
    fn extract_sources_preserves_balanced_parentheses_in_markdown_and_bare_urls() {
        let text = "\
See [Rust](https://en.wikipedia.org/wiki/Rust_(programming_language)) and \
also (https://en.wikipedia.org/wiki/Actor_model_(computing)).";
        let sources = extract_sources_from_text(text);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].title, "Rust");
        assert_eq!(sources[0].url, "https://en.wikipedia.org/wiki/Rust_(programming_language)");
        assert_eq!(sources[1].url, "https://en.wikipedia.org/wiki/Actor_model_(computing)");
    }

    #[test]
    fn permission_gating_approves_only_web_search_and_refuses_all_other_tools() {
        let options = json!([
            { "optionId": "allow-1", "kind": "allow_once" },
            { "optionId": "allow-all", "kind": "allow_always" },
            { "optionId": "deny-1", "kind": "reject_once" },
            { "optionId": "deny-all", "kind": "reject_always" }
        ]);
        let mut state = SearchTurnState::default();

        // Built-in search_web is approved with allow_once.
        let search_ask = json!({
            "toolCall": { "toolCallId": "tc-1", "name": "search_web", "kind": "search", "rawInput": { "query": "rust" } },
            "options": options,
        });
        assert_eq!(decide_search_permission(&search_ask, &mut state), (json!({ "outcome": { "outcome": "selected", "optionId": "allow-1" } }), true));

        // Shell command is refused with reject_once.
        let shell_ask = json!({
            "toolCall": { "toolCallId": "tc-2", "name": "run_command", "kind": "execute", "rawInput": { "command": "ls" } },
            "options": options,
        });
        assert_eq!(decide_search_permission(&shell_ask, &mut state), (json!({ "outcome": { "outcome": "selected", "optionId": "deny-1" } }), false));

        // Local search_directory / grep with path is refused even with kind=search.
        let grep_ask = json!({
            "toolCall": { "toolCallId": "tc-3", "title": "Searching files", "kind": "search", "rawInput": { "path": "/repo", "pattern": "foo" } },
            "options": options,
        });
        assert_eq!(decide_search_permission(&grep_ask, &mut state), (json!({ "outcome": { "outcome": "selected", "optionId": "deny-1" } }), false));

        // An MCP-wrapped tool named search_web is still refused (no MCP tools allowed).
        let mcp_ask = json!({
            "toolCall": {
                "toolCallId": "tc-4",
                "name": "search_web",
                "_meta": { "mcp": { "server": "mixdog", "tool": "search_web" } }
            },
            "options": options,
        });
        assert_eq!(decide_search_permission(&mcp_ask, &mut state), (json!({ "outcome": { "outcome": "selected", "optionId": "deny-1" } }), false));
        assert_eq!(state.refused_tools.len(), 3);
    }

    #[tokio::test]
    async fn scripted_search_turn_gates_permissions_and_captures_calls_citations_and_usage() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let manager = Arc::new(ScriptedAgent {
            events: Mutex::new(Some(event_rx)),
            written_tx,
            written_buf: Mutex::new(String::new()),
            killed: Arc::new(AtomicBool::new(false)),
        });
        let launch = Launch {
            program: "fake-agent".into(),
            args: Vec::new(),
            env: Vec::new(),
            env_remove: Vec::new(),
            cwd: AbsPath::new(std::env::current_dir().unwrap()).unwrap(),
        };
        let (connection, mut incoming) = Connection::start(manager, launch).await.unwrap();
        let session = AgentSession::test_session_for(connection);
        let pump_session = session.clone();
        let pump = tokio::spawn(async move {
            while let Some(item) = incoming.recv().await {
                let _ = pump_session.take(item);
            }
        });

        let request = sample_request();
        let cancel = CancellationToken::new();
        let driver_tx = event_tx.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            // 1. Receive session/prompt.
            let prompt_msg = written_rx.recv().await.expect("prompt");
            assert_eq!(prompt_msg["method"], "session/prompt");
            let prompt_id = prompt_msg["id"].as_u64().unwrap();

            // 2. Agent attempts a forbidden shell command -> must be rejected.
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": 10,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "sess-test",
                        "toolCall": { "toolCallId": "bad-1", "name": "run_command", "kind": "execute", "rawInput": { "command": "whoami" } },
                        "options": [
                            { "optionId": "allow", "kind": "allow_once" },
                            { "optionId": "reject", "kind": "reject_once" }
                        ]
                    }
                }),
            );
            let bad_reply = written_rx.recv().await.expect("bad reply");
            assert_eq!(bad_reply["id"], 10);
            assert_eq!(bad_reply["result"]["outcome"]["optionId"], "reject");

            // 3. Agent requests search_web -> must be approved.
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": 11,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "sess-test",
                        "toolCall": { "toolCallId": "ws-1", "name": "search_web", "kind": "search", "rawInput": { "query": "rust async traits site:rust-lang.org" } },
                        "options": [
                            { "optionId": "allow", "kind": "allow_once" },
                            { "optionId": "reject", "kind": "reject_once" }
                        ]
                    }
                }),
            );
            let good_reply = written_rx.recv().await.expect("good reply");
            assert_eq!(good_reply["id"], 11);
            assert_eq!(good_reply["result"]["outcome"]["optionId"], "allow");

            // 4. Agent streams tool_call_update with structured rawOutput + resource_link content, usage_update, answer text, and prompt completion.
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "sess-test",
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "ws-1",
                            "status": "completed",
                            "rawOutput": {
                                "results": [
                                    { "title": "Async Trait RFC", "url": "https://rust-lang.github.io/async-book/", "snippet": "Async trait methods in Rust." }
                                ]
                            },
                            "content": [
                                { "type": "resource_link", "uri": "https://blog.rust-lang.org/2023/12/21/async-fn-rpit-in-traits.html", "title": "Announcing async fn in traits", "description": "Stabilized in Rust 1.75." }
                            ]
                        }
                    }
                }),
            );
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "sess-test",
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": { "type": "text", "text": "Rust 1.75 stabilized [async fn in traits](https://blog.rust-lang.org/2023/12/21/async-fn-rpit-in-traits.html)." }
                        }
                    }
                }),
            );
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "sess-test",
                        "update": {
                            "sessionUpdate": "usage_update",
                            "used": 1200,
                            "size": 100000,
                            "cost": { "currency": "USD", "amount": 0.0025 }
                        }
                    }
                }),
            );
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": prompt_id,
                    "result": {
                        "stopReason": "end_turn",
                        "usage": {
                            "inputTokens": 300,
                            "outputTokens": 120,
                            "cachedReadTokens": 500,
                            "totalTokens": 920
                        }
                    }
                }),
            );
        });

        let outcome = run_search_turn(&session, &session.preset.quirks, &request, &cancel).await;
        driver.await.unwrap();
        drop(event_tx);
        let _ = pump.await;

        let usage = outcome.usage.as_ref().expect("usage captured");
        assert!(input_excludes_cache(usage), "300 + 120 + 500 == 920 implies input excludes cache");
        let reply = map_turn_outcome(
            outcome.end,
            &request.provider,
            Some(request.model.clone()),
            outcome.citations,
            outcome.calls,
            Some(provider_usage(usage)),
            input_excludes_cache(usage),
        )
        .expect("clean reply");

        assert!(reply.answer.contains("Rust 1.75 stabilized"));
        assert_eq!(reply.calls.len(), 1);
        assert_eq!(reply.calls[0].query, "rust async traits site:rust-lang.org");
        assert_eq!(reply.calls[0].urls.len(), 2);
        assert_eq!(reply.citations.len(), 2);
        assert!(reply.citations.iter().any(|c| c.url == "https://rust-lang.github.io/async-book/" && c.title == "Async Trait RFC"));
        assert!(reply.citations.iter().any(|c| c.url == "https://blog.rust-lang.org/2023/12/21/async-fn-rpit-in-traits.html"));
        assert_eq!(reply.usage.as_ref().unwrap().input_tokens, 300);
        assert_eq!(reply.usage.as_ref().unwrap().cache_read_tokens, 500);
        assert!(reply.input_excludes_cache);
    }

    #[test]
    fn turn_end_and_refusal_mapping_covers_errors_capacity_signin_cancel_and_zero_calls() {
        let sample_usage = Some(Usage { input_tokens: 10, output_tokens: 5, ..Usage::default() });

        // Completed with zero search_web calls -> Refusal preserving usage.
        let err = map_turn_outcome(
            TurnEnd::Completed { text: "guessed".into(), stop_reason: Some("end_turn".into()), tool_calls: 0 },
            "acp-antigravity",
            Some("gemini-2.5-pro".into()),
            Vec::new(),
            Vec::new(),
            sample_usage.clone(),
            true,
        )
        .unwrap_err();
        assert_eq!(err.kind, AcpSearchErrorKind::Refusal);
        assert_eq!(err.usage.as_ref().unwrap().input_tokens, 10);
        assert!(err.input_excludes_cache);

        // TurnEnd::Refused -> Refusal.
        let err =
            map_turn_outcome(TurnEnd::Refused { message: "disabled in this account".into() }, "acp-antigravity", None, Vec::new(), Vec::new(), None, false)
                .unwrap_err();
        assert_eq!(err.kind, AcpSearchErrorKind::Refusal);

        // AUTH_REQUIRED -> SignIn.
        let err = map_turn_outcome(
            TurnEnd::Failed { message: "Authentication required".into(), code: Some(AUTH_REQUIRED), reported: true },
            "acp-antigravity",
            None,
            Vec::new(),
            Vec::new(),
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(err.kind, AcpSearchErrorKind::SignIn);

        // Rate limit / RESOURCE_EXHAUSTED -> Capacity.
        let err = map_turn_outcome(
            TurnEnd::Failed { message: "RESOURCE_EXHAUSTED: quota exceeded".into(), code: Some(429), reported: true },
            "acp-antigravity",
            None,
            Vec::new(),
            Vec::new(),
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(err.kind, AcpSearchErrorKind::Capacity);

        // Interrupted -> Cancelled.
        let err = map_turn_outcome(TurnEnd::Interrupted, "acp-antigravity", None, Vec::new(), Vec::new(), sample_usage, false).unwrap_err();
        assert_eq!(err.kind, AcpSearchErrorKind::Cancelled);
        assert_eq!(err.usage.as_ref().unwrap().output_tokens, 5);

        // Readiness refusals map cleanly.
        let preset = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("preset");
        assert_eq!(refusal_to_error(&preset, &Refusal::Off).kind, AcpSearchErrorKind::NotInstalled);
        assert_eq!(refusal_to_error(&preset, &Refusal::NotReady(Readiness::NotInstalled)).kind, AcpSearchErrorKind::NotInstalled);
        assert_eq!(
            refusal_to_error(&preset, &Refusal::NotReady(Readiness::SignedOut { version: "1.5.2".into(), message: "sign in".into() })).kind,
            AcpSearchErrorKind::SignIn
        );
        assert_eq!(
            refusal_to_error(
                &preset,
                &Refusal::NotReady(Readiness::Failed { version: Some("1.5.2".into()), message: "model has been disabled in this account".into() })
            )
            .kind,
            AcpSearchErrorKind::Refusal
        );
    }

    #[test]
    fn permission_gating_denies_previously_refused_id_and_missing_call_id() {
        let options = json!([
            { "optionId": "allow-1", "kind": "allow_once" },
            { "optionId": "deny-1", "kind": "reject_once" }
        ]);
        let mut state = SearchTurnState::default();

        // First request for `call-reuse` is a forbidden local tool -> denied and recorded in refused_call_ids.
        let initial_bad = json!({
            "toolCall": { "toolCallId": "call-reuse", "name": "run_command", "kind": "execute", "rawInput": { "command": "ls" } },
            "options": options,
        });
        assert_eq!(decide_search_permission(&initial_bad, &mut state), (json!({ "outcome": { "outcome": "selected", "optionId": "deny-1" } }), false));
        assert!(state.refused_call_ids.contains("call-reuse"));

        // Second request for the same `call-reuse` tries to mutate metadata into a clean `search_web` -> MUST still be denied.
        let mutated_second = json!({
            "toolCall": { "toolCallId": "call-reuse", "name": "search_web", "kind": "search", "rawInput": { "query": "rust" } },
            "options": options,
        });
        assert_eq!(
            decide_search_permission(&mutated_second, &mut state),
            (json!({ "outcome": { "outcome": "selected", "optionId": "deny-1" } }), false),
            "previously refused toolCallId must stay denied even if merged metadata later looks like search_web"
        );

        // Missing, empty, and whitespace-only toolCallId must ALWAYS be denied fail-closed even for search_web.
        for tool_call in [
            json!({ "name": "search_web", "kind": "search", "rawInput": { "query": "rust" } }),
            json!({ "toolCallId": "", "name": "search_web", "kind": "search", "rawInput": { "query": "rust" } }),
            json!({ "toolCallId": "   ", "name": "search_web", "kind": "search", "rawInput": { "query": "rust" } }),
        ] {
            let ask = json!({ "toolCall": tool_call, "options": options });
            assert_eq!(
                decide_search_permission(&ask, &mut state),
                (json!({ "outcome": { "outcome": "selected", "optionId": "deny-1" } }), false),
                "permission request without a non-empty toolCallId must be denied fail-closed"
            );
        }
    }

    #[test]
    fn statusless_search_call_with_content_does_not_satisfy_completion() {
        let mut state = SearchTurnState::default();
        // Permission payload or intermediate update with descriptive content but no terminal status / rawOutput.
        state.merge_tool(&json!({
            "toolCallId": "ws-statusless-content",
            "name": "search_web",
            "kind": "search",
            "rawInput": { "query": "rust" },
            "content": [{ "type": "text", "text": "About to search the web for rust" }]
        }));
        let tool = state.tools.get("ws-statusless-content").expect("merged tool");
        assert!(!is_completed_search_tool(tool), "statusless call with only descriptive content must not count as completed");
        let (calls, _) = extract_calls_and_citations(&state, "rust");
        assert!(calls.is_empty(), "statusless call with content must not produce a SearchCall");
        let err = map_turn_outcome(
            TurnEnd::Completed { text: "answer".into(), stop_reason: Some("end_turn".into()), tool_calls: 0 },
            "acp-antigravity",
            None,
            Vec::new(),
            calls,
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(err.kind, AcpSearchErrorKind::Refusal);

        // Once an explicit terminal completed status arrives, the call counts as completed.
        state.merge_tool(&json!({
            "toolCallId": "ws-statusless-content",
            "status": "completed",
            "content": [{ "type": "resource_link", "uri": "https://www.rust-lang.org/", "title": "Rust" }]
        }));
        let tool = state.tools.get("ws-statusless-content").expect("merged tool");
        assert!(is_completed_search_tool(tool));
        let (calls, citations) = extract_calls_and_citations(&state, "rust");
        assert_eq!(calls.len(), 1);
        assert_eq!(citations.len(), 1);
    }

    #[tokio::test]
    async fn shared_session_detach_with_dequeued_permission_rpc_sends_refusal_on_live_connection() {
        struct NoopFiles;

        #[async_trait]
        impl TextFiles for NoopFiles {
            async fn read(&self, _: AbsPath) -> Result<String, String> {
                Err("unused".into())
            }
            async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
                Ok(path)
            }
            async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
                Ok(())
            }
        }

        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let launch = Launch {
            program: "fake-agent".into(),
            args: Vec::new(),
            env: Vec::new(),
            env_remove: Vec::new(),
            cwd: AbsPath::new(std::env::current_dir().unwrap()).unwrap(),
        };
        let (connection, _incoming) = Connection::start(manager, launch).await.unwrap();
        let shared = crate::shared::SharedServer::test_server_for(connection, Arc::new(NoopFiles), "antigravity");
        let sibling = AgentSession::test_shared_session_for(shared.clone(), "sess-sibling");
        let session = AgentSession::test_shared_session_for(shared.clone(), "sess-search");
        shared.register(&sibling);
        shared.register(&session);

        // Detach the shared search session while the sibling keeps the underlying shared connection alive.
        session.end();
        assert!(session.gone().is_cancelled());
        assert!(!session.connection.exited().is_cancelled(), "sibling keeps shared connection alive");

        // A permission RPC was already dequeued and reached send_search_permission_grant as the session detached:
        // it must send an explicit cancelled refusal instead of leaving the live shared agent hung waiting.
        let mut budget = RefuseBudget::new();
        let cancel = CancellationToken::new();
        let granted =
            send_search_permission_grant(&session, &mut budget, json!(77), json!({ "outcome": { "outcome": "selected", "optionId": "allow-1" } }), &cancel)
                .await;
        assert!(!granted, "detached session must not report a grant");
        let reply = mixdog_rt::time::timeout(Duration::from_secs(2), written_rx.recv())
            .await
            .expect("refusal written on live shared connection")
            .expect("json-rpc reply");
        assert_eq!(reply["id"], 77);
        assert_eq!(reply["result"]["outcome"]["outcome"], "cancelled");
        assert!(!killed.load(Ordering::SeqCst), "sending refusal on detached shared session must keep shared connection alive");
        drop(event_tx);
    }

    struct TrackingFiles {
        created: Mutex<Vec<AbsPath>>,
        removed: Mutex<Vec<AbsPath>>,
        listed: Mutex<Vec<String>>,
        remove_notify: Arc<tokio::sync::Notify>,
    }

    impl TrackingFiles {
        fn new() -> Self {
            Self { created: Mutex::default(), removed: Mutex::default(), listed: Mutex::default(), remove_notify: Arc::new(tokio::sync::Notify::new()) }
        }
    }

    #[async_trait]
    impl TextFiles for TrackingFiles {
        async fn read(&self, _: AbsPath) -> Result<String, String> {
            Err("unused".into())
        }
        async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
            Ok(path)
        }
        async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
            Ok(())
        }
        async fn make_folder(&self, path: AbsPath) -> Result<(), String> {
            self.created.lock().unwrap().push(path);
            Ok(())
        }
        async fn remove_folder(&self, path: AbsPath) -> Result<(), String> {
            self.removed.lock().unwrap().push(path);
            self.remove_notify.notify_waiters();
            Ok(())
        }
        async fn folders(&self, path: AbsPath) -> Result<Vec<String>, String> {
            if path.as_path().file_name() == Some(std::ffi::OsStr::new(SEARCH_SANDBOX_DIR)) { Ok(self.listed.lock().unwrap().clone()) } else { Ok(Vec::new()) }
        }
    }

    struct DummyRefusals;

    #[async_trait]
    impl crate::agents::Refusals for DummyRefusals {
        async fn read(&self) -> HashMap<String, String> {
            HashMap::new()
        }
        async fn keep(&self, _: HashMap<String, String>) {}
        async fn read_windows(&self) -> crate::agents::Windows {
            HashMap::new()
        }
        async fn keep_windows(&self, _: crate::agents::Windows) {}
    }

    struct HangingSpawnProcesses {
        spawn_started: Arc<tokio::sync::Notify>,
        spawn_count: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl ProcessManager for HangingSpawnProcesses {
        async fn spawn(&self, _request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            self.spawn_count.fetch_add(1, Ordering::SeqCst);
            self.spawn_started.notify_waiters();
            std::future::pending().await
        }
        fn subscribe(&self, _: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            unreachable!()
        }
        fn subscribe_holding(&self, _: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            unreachable!()
        }
        async fn write_stdin(&self, _: &ProcessHandle, _: Vec<u8>) -> Result<(), ProcessError> {
            Ok(())
        }
        fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }
        fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
            Ok(())
        }
        fn kill(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }
        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    fn test_agents_for_search(files: Arc<dyn TextFiles>, processes: Arc<dyn ProcessManager>) -> Arc<Agents> {
        let cwd = std::env::current_dir().expect("cwd");
        let agents = Agents::new(crate::agents::AgentsParts {
            presets: crate::preset::builtin(),
            processes,
            files,
            probe_cwd: cwd.clone(),
            data_dir: cwd.clone(),
            definitions: cwd,
            refusals: Arc::new(DummyRefusals),
            registry: None,
            mcp_bridge: None,
            enabled: Arc::new(|| true),
            changed: Arc::new(|| {}),
            env: Arc::new(|_| None),
        });
        for preset in crate::preset::builtin() {
            let mut slots = lock(&agents.slots);
            let slot = slots.entry(preset.id.clone()).or_default();
            slot.readiness = Some(Readiness::Ready { version: "1.5.2".into(), models: crate::session::Models::default() });
            slot.program = Some(crate::session::Program::at("fake-agent"));
        }
        agents
    }

    #[tokio::test]
    async fn dropping_search_future_removes_sandbox_dir_and_clears_opening() {
        let _ = mixdog_rt::testing::tokens();
        let files = Arc::new(TrackingFiles::new());
        let spawn_started = Arc::new(tokio::sync::Notify::new());
        let spawn_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let processes = Arc::new(HangingSpawnProcesses { spawn_started: spawn_started.clone(), spawn_count });
        let agents = test_agents_for_search(files.clone(), processes);
        let backend = AgentWebSearch::new(agents.clone());
        let cancel = CancellationToken::new();

        let started_wait = spawn_started.notified();
        tokio::pin!(started_wait);
        started_wait.as_mut().enable();
        let mut search_fut = Box::pin(backend.search(sample_request(), &cancel));
        tokio::select! {
            _ = search_fut.as_mut() => panic!("search_fut should hang in spawn"),
            () = started_wait => {}
        }

        let sandboxes: Vec<AbsPath> = files
            .created
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.as_path().parent().and_then(|parent| parent.file_name()) == Some(std::ffi::OsStr::new(SEARCH_SANDBOX_DIR)))
            .cloned()
            .collect();
        assert_eq!(sandboxes.len(), 1, "one per-search sandbox dir must have been created before spawn");
        let sandbox = sandboxes[0].clone();
        assert_eq!(agents.opening_count(), 1, "search session must be tracked in Agents::opening during spawn");

        drop(search_fut);
        assert_eq!(agents.opening_count(), 0, "dropping search future must clear Agents::opening");

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let removed_wait = files.remove_notify.notified();
                tokio::pin!(removed_wait);
                removed_wait.as_mut().enable();
                if files.removed.lock().unwrap().contains(&sandbox) {
                    return;
                }
                removed_wait.await;
            }
        })
        .await
        .expect("RAII Drop guard must remove per-search sandbox dir when search future is dropped");
    }

    #[tokio::test]
    async fn sweep_leftovers_removes_stale_and_legacy_search_sandboxes_only() {
        let _ = mixdog_rt::testing::tokens();
        let files = Arc::new(TrackingFiles::new());
        let live_name = format!("pid-{}-live", std::process::id());
        let dead_name = "pid-4294967294-stale".to_owned();
        let legacy_name = "0123456789abcdef0123456789abcdef".to_owned();
        *files.listed.lock().unwrap() = vec![live_name.clone(), dead_name.clone(), legacy_name.clone()];
        let processes = Arc::new(HangingSpawnProcesses {
            spawn_started: Arc::new(tokio::sync::Notify::new()),
            spawn_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        });
        let agents = test_agents_for_search(files.clone(), processes);

        agents.sweep_leftovers().await;
        let removed: Vec<String> =
            files.removed.lock().unwrap().iter().filter_map(|p| p.as_path().file_name().map(|n| n.to_string_lossy().into_owned())).collect();
        assert!(removed.contains(&dead_name), "dead-PID sandbox must be swept: {removed:?}");
        assert!(removed.contains(&legacy_name), "legacy unprefixed sandbox must be swept: {removed:?}");
        assert!(!removed.contains(&live_name), "current-PID sandbox must not be swept: {removed:?}");
    }

    #[tokio::test]
    async fn agent_web_search_rejects_agent_file_preset_without_spawning() {
        let _ = mixdog_rt::testing::tokens();
        let files = Arc::new(TrackingFiles::new());
        let spawn_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let processes = Arc::new(HangingSpawnProcesses { spawn_started: Arc::new(tokio::sync::Notify::new()), spawn_count: spawn_count.clone() });
        let agents = test_agents_for_search(files.clone(), processes);
        let backend = AgentWebSearch::new(agents);
        let mut request = sample_request();
        request.provider = "acp-antigravity-cli".into();
        request.model = "claude-opus-4-6".into();
        let cancel = CancellationToken::new();

        let err = backend.search(request, &cancel).await.expect_err("OwnToolsOff::AgentFile preset must be rejected");
        assert_eq!(err.kind, AcpSearchErrorKind::Unavailable);
        assert_eq!(spawn_count.load(Ordering::SeqCst), 0, "rejected AgentFile preset must not spawn a process");
        assert!(files.created.lock().unwrap().is_empty(), "rejected AgentFile preset must not create a sandbox");
    }

    #[tokio::test]
    async fn release_all_during_search_spawn_window_blocks_registration() {
        let _ = mixdog_rt::testing::tokens();
        let files = Arc::new(TrackingFiles::new());
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, _written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let launch = Launch {
            program: "fake-agent".into(),
            args: Vec::new(),
            env: Vec::new(),
            env_remove: Vec::new(),
            cwd: AbsPath::new(std::env::current_dir().unwrap()).unwrap(),
        };
        let (connection, _incoming) = Connection::start(manager.clone(), launch).await.unwrap();
        let session = AgentSession::test_session_for(connection);
        let agents = test_agents_for_search(files.clone(), manager);

        let thread_id = ThreadId::from("acp-search:test-opening");
        let opening = agents.begin_opening(thread_id.clone());
        assert_eq!(agents.opening_count(), 1);

        // ACP disable (`release_all`) clears `opening` even if `enabled()` stays/flips true.
        agents.release_all();
        assert!(!opening.current());

        let sandbox_path = AbsPath::new(std::env::current_dir().unwrap().join(SEARCH_SANDBOX_DIR).join("test")).unwrap();
        let sandbox = SearchSandbox::new(sandbox_path.clone(), files.clone());
        let err = match RegisteredSearchSession::register(agents.clone(), thread_id.clone(), &opening, OwnedSession::new(session), sandbox) {
            Ok(_) => panic!("registration after release_all cleared opening must fail"),
            Err((err, mut sandbox)) => {
                sandbox.cleanup().await;
                err
            }
        };
        assert_eq!(err.kind, AcpSearchErrorKind::NotInstalled);
        assert!(agents.running(&thread_id).is_none(), "session must not be inserted into Agents::sessions");
        assert!(killed.load(Ordering::SeqCst), "rejected session must be ended");
        assert!(files.removed.lock().unwrap().contains(&sandbox_path), "sandbox must be cleaned up");
        drop(event_tx);
    }

    #[tokio::test]
    async fn search_sandbox_armed_before_make_folder_cleans_up_on_drop() {
        struct GatedMakeFolderFiles {
            created: Mutex<Vec<AbsPath>>,
            removed: Mutex<Vec<AbsPath>>,
            make_started: Arc<tokio::sync::Notify>,
            finish_make: Arc<tokio::sync::Notify>,
            remove_notify: Arc<tokio::sync::Notify>,
        }

        #[async_trait]
        impl TextFiles for GatedMakeFolderFiles {
            async fn read(&self, _: AbsPath) -> Result<String, String> {
                Err("unused".into())
            }
            async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
                Ok(path)
            }
            async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
                Ok(())
            }
            async fn make_folder(&self, path: AbsPath) -> Result<(), String> {
                let done = self.finish_make.notified();
                tokio::pin!(done);
                done.as_mut().enable();
                self.created.lock().unwrap().push(path);
                self.make_started.notify_waiters();
                done.await;
                Ok(())
            }
            async fn remove_folder(&self, path: AbsPath) -> Result<(), String> {
                self.removed.lock().unwrap().push(path);
                self.remove_notify.notify_waiters();
                Ok(())
            }
        }

        let _ = mixdog_rt::testing::tokens();
        let make_started = Arc::new(tokio::sync::Notify::new());
        let finish_make = Arc::new(tokio::sync::Notify::new());
        let remove_notify = Arc::new(tokio::sync::Notify::new());
        let files = Arc::new(GatedMakeFolderFiles {
            created: Mutex::default(),
            removed: Mutex::default(),
            make_started: make_started.clone(),
            finish_make: finish_make.clone(),
            remove_notify: remove_notify.clone(),
        });
        let processes = Arc::new(HangingSpawnProcesses {
            spawn_started: Arc::new(tokio::sync::Notify::new()),
            spawn_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        });
        let agents = test_agents_for_search(files.clone(), processes);
        let backend = AgentWebSearch::new(agents);

        let started_wait = make_started.notified();
        tokio::pin!(started_wait);
        started_wait.as_mut().enable();
        let mut create_fut = Box::pin(backend.create_sandbox());
        tokio::select! {
            _ = create_fut.as_mut() => panic!("create_sandbox should suspend inside make_folder"),
            () = started_wait => {}
        }

        let created = files.created.lock().unwrap().clone();
        assert_eq!(created.len(), 1, "make_folder must have started for the sandbox path");

        // Dropping while `make_folder` is still pending must NOT race `remove_folder` against it.
        drop(create_fut);
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(files.removed.lock().unwrap().is_empty(), "remove_folder must wait until the in-flight make_folder completes");

        // Once `make_folder` completes, the same creation task removes the folder sequentially.
        finish_make.notify_waiters();

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let removed_wait = remove_notify.notified();
                tokio::pin!(removed_wait);
                removed_wait.as_mut().enable();
                if files.removed.lock().unwrap().contains(&created[0]) {
                    return;
                }
                removed_wait.await;
            }
        })
        .await
        .expect("SearchSandbox must remove its directory strictly after make_folder finishes");
    }

    struct GatedScriptedAgent {
        events: Mutex<Option<mpsc::UnboundedReceiver<ProcessEvent>>>,
        written_tx: mpsc::UnboundedSender<Value>,
        written_buf: Mutex<String>,
        killed: Arc<AtomicBool>,
        gate_match: Box<dyn Fn(&Value) -> bool + Send + Sync>,
        gate_entered: Arc<tokio::sync::Notify>,
        gate_release: Arc<tokio::sync::Notify>,
        gate_armed: AtomicBool,
    }

    #[async_trait]
    impl ProcessManager for GatedScriptedAgent {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            Ok(SpawnedProcess { handle: request.handle, pid: 7777 })
        }

        fn subscribe(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let rx = self.events.lock().unwrap().take().expect("GatedScriptedAgent supports one subscriber");
            Ok(Box::new(ScriptedEvents(rx)))
        }

        fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            self.subscribe(handle, from_seq)
        }

        async fn write_stdin(&self, _handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let mut lines = Vec::new();
            {
                let mut buf = self.written_buf.lock().unwrap();
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find('\n') {
                    let line: String = buf.drain(..=pos).collect();
                    if let Ok(val) = serde_json::from_str::<Value>(line.trim()) {
                        lines.push(val);
                    }
                }
            }
            for val in lines {
                if self.gate_armed.load(Ordering::SeqCst) && (self.gate_match)(&val) && self.gate_armed.swap(false, Ordering::SeqCst) {
                    let release = self.gate_release.notified();
                    tokio::pin!(release);
                    release.as_mut().enable();
                    self.gate_entered.notify_waiters();
                    release.await;
                }
                let _ = self.written_tx.send(val);
            }
            Ok(())
        }

        fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }

        fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
            Ok(())
        }

        fn kill(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    #[tokio::test]
    async fn dropping_open_on_shared_during_first_answered_ends_session_and_router() {
        struct HangingProbeReadFiles {
            read_started: Arc<tokio::sync::Notify>,
        }

        #[async_trait]
        impl TextFiles for HangingProbeReadFiles {
            async fn read(&self, _: AbsPath) -> Result<String, String> {
                self.read_started.notify_waiters();
                std::future::pending().await
            }
            async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
                Ok(path)
            }
            async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
                Ok(())
            }
            async fn make_folder(&self, _: AbsPath) -> Result<(), String> {
                Ok(())
            }
            async fn remove_folder(&self, _: AbsPath) -> Result<(), String> {
                Ok(())
            }
        }

        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let read_started = Arc::new(tokio::sync::Notify::new());
        let files = Arc::new(HangingProbeReadFiles { read_started: read_started.clone() });
        let agents = test_agents_for_search(files, manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        let search_preset = search_only_preset(&official).expect("search preset");
        let program = crate::session::Program::at("fake-agent");

        let close_seen = Arc::new(Mutex::new(None::<String>));
        let close_notify = Arc::new(tokio::sync::Notify::new());
        let driver_tx = event_tx.clone();
        let driver_close = close_seen.clone();
        let driver_close_notify = close_notify.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            assert_eq!(init["method"], "initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            assert_eq!(new_sess["method"], "session/new");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-first-drop" }
                }),
            );
            while let Some(msg) = written_rx.recv().await {
                if msg["method"] == "session/close" {
                    *driver_close.lock().unwrap() = msg["params"]["sessionId"].as_str().map(str::to_owned);
                    driver_close_notify.notify_waiters();
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                    break;
                }
            }
        });

        let (lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let server = lease.server().clone();
        let cwd = AbsPath::new(std::env::current_dir().unwrap()).unwrap();
        let open = Open {
            preset: &search_preset,
            program: &program,
            cwd,
            definitions: &agents.parts.definitions,
            stored: None,
            rules: Some(SEARCH_ONLY_RULES.to_owned()),
            held: None,
            grants: Arc::default(),
            handed: None,
            temp: None,
        };
        let router_exited = Arc::new(AtomicBool::new(false));
        let router_exited_notify = Arc::new(tokio::sync::Notify::new());
        let on_exit = {
            let router_exited = router_exited.clone();
            let router_exited_notify = router_exited_notify.clone();
            Box::new(move || {
                router_exited.store(true, Ordering::SeqCst);
                router_exited_notify.notify_waiters();
            })
        };

        let probe_wait = read_started.notified();
        tokio::pin!(probe_wait);
        probe_wait.as_mut().enable();
        let mut open_fut = Box::pin(AgentSession::open_on_shared_owned(lease, open, Arc::new(|| {}), on_exit, None));
        tokio::select! {
            _ = open_fut.as_mut() => panic!("open_on_shared_owned should suspend inside first_answered"),
            () = probe_wait => {}
        }
        assert!(!router_exited.load(Ordering::SeqCst), "router must still be alive before drop");

        // Register a sibling session on the same shared server while `first_answered` is suspended.
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);

        drop(open_fut);

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let exited_wait = router_exited_notify.notified();
                tokio::pin!(exited_wait);
                exited_wait.as_mut().enable();
                if router_exited.load(Ordering::SeqCst) {
                    break;
                }
                exited_wait.await;
            }
            loop {
                let close_wait = close_notify.notified();
                tokio::pin!(close_wait);
                close_wait.as_mut().enable();
                if close_seen.lock().unwrap().as_deref() == Some("sess-first-drop") {
                    return;
                }
                close_wait.await;
            }
        })
        .await
        .expect("dropping open_on_shared_owned during first_answered must end only the cancelled session");

        assert!(!killed.load(Ordering::SeqCst), "cancelling during first_answered must not kill shared server");
        assert!(!sibling.gone().is_cancelled(), "sibling session must remain alive");
        assert!(
            matches!(agents.shared.lock().unwrap().get(&official.id), Some(crate::shared::SharedSlot::Running(running)) if Arc::ptr_eq(running, &server)),
            "shared server must remain registered for siblings"
        );

        driver.await.unwrap();
        drop(event_tx);
    }

    #[tokio::test]
    async fn cancelling_search_during_first_answered_closes_only_cancelled_session_and_preserves_sibling() {
        struct HangingProbeReadFiles {
            read_started: Arc<tokio::sync::Notify>,
        }

        #[async_trait]
        impl TextFiles for HangingProbeReadFiles {
            async fn read(&self, _: AbsPath) -> Result<String, String> {
                self.read_started.notify_waiters();
                std::future::pending().await
            }
            async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
                Ok(path)
            }
            async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
                Ok(())
            }
            async fn make_folder(&self, _: AbsPath) -> Result<(), String> {
                Ok(())
            }
            async fn remove_folder(&self, _: AbsPath) -> Result<(), String> {
                Ok(())
            }
        }

        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let read_started = Arc::new(tokio::sync::Notify::new());
        let files = Arc::new(HangingProbeReadFiles { read_started: read_started.clone() });
        let agents = test_agents_for_search(files, manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");

        let close_seen = Arc::new(Mutex::new(None::<String>));
        let close_notify = Arc::new(tokio::sync::Notify::new());
        let driver_tx = event_tx.clone();
        let driver_close = close_seen.clone();
        let driver_close_notify = close_notify.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-search-first-cancel" }
                }),
            );
            while let Some(msg) = written_rx.recv().await {
                if msg["method"] == "session/close" {
                    *driver_close.lock().unwrap() = msg["params"]["sessionId"].as_str().map(str::to_owned);
                    driver_close_notify.notify_waiters();
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                    break;
                }
            }
        });

        let backend = AgentWebSearch::new(agents.clone());
        let cancel = CancellationToken::new();
        let mut request = sample_request();
        request.model = DEFAULT_MODEL.into();

        let probe_wait = read_started.notified();
        tokio::pin!(probe_wait);
        probe_wait.as_mut().enable();
        let mut search_fut = Box::pin(backend.search(request, &cancel));
        tokio::select! {
            _ = search_fut.as_mut() => panic!("search should suspend inside first_answered"),
            () = probe_wait => {}
        }

        // Attach a sibling session on the shared server while the first search is inside `first_answered`.
        let server = match agents.shared.lock().unwrap().get(&official.id) {
            Some(crate::shared::SharedSlot::Running(server)) => server.clone(),
            _ => panic!("expected running shared server"),
        };
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);

        cancel.cancel();
        let err = search_fut.await.expect_err("cancelled search must return Cancelled");
        assert_eq!(err.kind, AcpSearchErrorKind::Cancelled);

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let close_wait = close_notify.notified();
                tokio::pin!(close_wait);
                close_wait.as_mut().enable();
                if close_seen.lock().unwrap().as_deref() == Some("sess-search-first-cancel") {
                    return;
                }
                close_wait.await;
            }
        })
        .await
        .expect("cancelling search during first_answered must close only the cancelled session");

        assert!(!killed.load(Ordering::SeqCst), "shared server must not be killed when sibling is active");
        assert!(!sibling.gone().is_cancelled(), "sibling session must remain alive");
        assert!(
            matches!(agents.shared.lock().unwrap().get(&official.id), Some(crate::shared::SharedSlot::Running(running)) if Arc::ptr_eq(running, &server)),
            "cancelling one search during first_answered must not retire the healthy shared server"
        );

        driver.await.unwrap();
        drop(event_tx);
    }

    #[tokio::test]
    async fn oneshot_dropped_before_consuming_owned_session_ends_session_and_router() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files, manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        let search_preset = search_only_preset(&official).expect("search preset");
        let program = crate::session::Program::at("fake-agent");

        let close_seen = Arc::new(Mutex::new(None::<String>));
        let close_notify = Arc::new(tokio::sync::Notify::new());
        let driver_tx = event_tx.clone();
        let driver_close = close_seen.clone();
        let driver_close_notify = close_notify.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-oneshot-owned" }
                }),
            );
            while let Some(msg) = written_rx.recv().await {
                if msg["method"] == "session/close" {
                    *driver_close.lock().unwrap() = msg["params"]["sessionId"].as_str().map(str::to_owned);
                    driver_close_notify.notify_waiters();
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                    break;
                }
            }
        });

        let (warm_lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let server = warm_lease.server().clone();
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);
        drop(warm_lease);

        let (lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let cwd = AbsPath::new(std::env::current_dir().unwrap()).unwrap();
        let open = Open {
            preset: &search_preset,
            program: &program,
            cwd,
            definitions: &agents.parts.definitions,
            stored: None,
            rules: Some(SEARCH_ONLY_RULES.to_owned()),
            held: None,
            grants: Arc::default(),
            handed: None,
            temp: None,
        };
        let router_exited = Arc::new(AtomicBool::new(false));
        let router_exited_notify = Arc::new(tokio::sync::Notify::new());
        let on_exit = {
            let router_exited = router_exited.clone();
            let router_exited_notify = router_exited_notify.clone();
            Box::new(move || {
                router_exited.store(true, Ordering::SeqCst);
                router_exited_notify.notify_waiters();
            })
        };

        let owned = AgentSession::open_on_shared_owned(lease, open, Arc::new(|| {}), on_exit, None).await.ok().expect("open");
        let (tx, rx) = tokio::sync::oneshot::channel();
        assert!(tx.send(Ok::<_, Fault>(owned)).is_ok(), "oneshot send succeeds before receiver drop");
        drop(rx);

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let exited_wait = router_exited_notify.notified();
                tokio::pin!(exited_wait);
                exited_wait.as_mut().enable();
                if router_exited.load(Ordering::SeqCst) {
                    break;
                }
                exited_wait.await;
            }
            loop {
                let close_wait = close_notify.notified();
                tokio::pin!(close_wait);
                close_wait.as_mut().enable();
                if close_seen.lock().unwrap().as_deref() == Some("sess-oneshot-owned") {
                    return;
                }
                close_wait.await;
            }
        })
        .await
        .expect("dropping a oneshot holding an unconsumed OwnedSession must end the session and router");

        assert!(!killed.load(Ordering::SeqCst), "sibling must keep live shared server running");
        assert!(!sibling.gone().is_cancelled());
        driver.await.unwrap();
        drop(event_tx);
    }

    #[tokio::test]
    async fn open_on_shared_timeout_closes_late_session_new_reply_on_live_server() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files, manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        let search_preset = search_only_preset(&official).expect("search preset");
        let program = crate::session::Program::at("fake-agent");

        let release_new = Arc::new(tokio::sync::Notify::new());
        let close_seen = Arc::new(Mutex::new(None::<String>));
        let close_notify = Arc::new(tokio::sync::Notify::new());
        let driver_tx = event_tx.clone();
        let driver_release = release_new.clone();
        let driver_close = close_seen.clone();
        let driver_close_notify = close_notify.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            driver_release.notified().await;
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-late-timeout" }
                }),
            );
            while let Some(msg) = written_rx.recv().await {
                if msg["method"] == "session/close" {
                    *driver_close.lock().unwrap() = msg["params"]["sessionId"].as_str().map(str::to_owned);
                    driver_close_notify.notify_waiters();
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                    break;
                }
            }
        });

        let (warm_lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let server = warm_lease.server().clone();
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);
        drop(warm_lease);

        let (lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let cwd = AbsPath::new(std::env::current_dir().unwrap()).unwrap();
        let open = Open {
            preset: &search_preset,
            program: &program,
            cwd,
            definitions: &agents.parts.definitions,
            stored: None,
            rules: Some(SEARCH_ONLY_RULES.to_owned()),
            held: None,
            grants: Arc::default(),
            handed: None,
            temp: None,
        };

        let timed_out = AgentSession::open_on_shared_owned(lease, open, Arc::new(|| {}), Box::new(|| {}), Some(Duration::from_millis(40))).await;
        assert!(matches!(timed_out, Err(OpenSharedError::TimedOut)), "slow session/new must time out");

        release_new.notify_waiters();

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let close_wait = close_notify.notified();
                tokio::pin!(close_wait);
                close_wait.as_mut().enable();
                if close_seen.lock().unwrap().as_deref() == Some("sess-late-timeout") {
                    return;
                }
                close_wait.await;
            }
        })
        .await
        .expect("late session/new reply after open_timeout must still close its remote session on a live server");

        assert!(!killed.load(Ordering::SeqCst), "sibling must keep live shared server running");
        assert!(!sibling.gone().is_cancelled());
        driver.await.unwrap();
        drop(event_tx);
    }

    #[tokio::test]
    async fn dropping_open_on_shared_during_tool_digest_sends_no_remote_open_rpc() {
        struct HangingDigestTools {
            started: Arc<tokio::sync::Notify>,
        }

        #[async_trait]
        impl crate::mcp::SessionTools for HangingDigestTools {
            async fn definitions(&self, _thread: &ThreadId) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
                self.started.notify_waiters();
                std::future::pending().await
            }

            fn tasks(&self) -> &mixdog_agent::agent_tool::board::JobBoard {
                unreachable!("tasks() is unused during open_session")
            }
        }

        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files, manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        let program = crate::session::Program::at("fake-agent");

        let rpcs_after_init = Arc::new(Mutex::new(Vec::<String>::new()));
        let driver_tx = event_tx.clone();
        let driver_rpcs = rpcs_after_init.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": {
                            "sessionCapabilities": { "close": {} },
                            "mcpCapabilities": { "http": true }
                        }
                    }
                }),
            );
            while let Some(msg) = written_rx.recv().await {
                if let Some(method) = msg["method"].as_str() {
                    driver_rpcs.lock().unwrap().push(method.to_owned());
                }
            }
        });

        let (warm_lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let server = warm_lease.server().clone();
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);
        drop(warm_lease);

        let (lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let digest_started = Arc::new(tokio::sync::Notify::new());
        let cwd = AbsPath::new(std::env::current_dir().unwrap()).unwrap();
        let open = Open {
            preset: &official,
            program: &program,
            cwd,
            definitions: &agents.parts.definitions,
            stored: None,
            rules: None,
            held: None,
            grants: Arc::default(),
            handed: Some(crate::mcp::Handover {
                thread: ThreadId::from("thread-digest-drop"),
                tools: Arc::new(HangingDigestTools { started: digest_started.clone() }),
                bridge: None,
            }),
            temp: None,
        };

        let digest_wait = digest_started.notified();
        tokio::pin!(digest_wait);
        digest_wait.as_mut().enable();
        let mut open_fut = Box::pin(AgentSession::open_on_shared_owned(lease, open, Arc::new(|| {}), Box::new(|| {}), None));
        tokio::select! {
            _ = open_fut.as_mut() => panic!("open_on_shared_owned should suspend inside handed.current_digest()"),
            () = digest_wait => {}
        }

        drop(open_fut);
        tokio::time::sleep(Duration::from_millis(40)).await;

        assert!(
            rpcs_after_init.lock().unwrap().is_empty(),
            "dropping open_on_shared_owned during tool digest must not send session/new, session/load, or session/close: {:?}",
            rpcs_after_init.lock().unwrap()
        );
        assert!(!killed.load(Ordering::SeqCst), "sibling must keep live shared server running");
        assert!(!sibling.gone().is_cancelled());
        drop(event_tx);
        driver.abort();
    }

    #[tokio::test]
    async fn cancelling_shared_search_after_session_new_sent_closes_remote_session() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files, manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        let program = crate::session::Program::at("fake-agent");

        let new_sent_notify = Arc::new(tokio::sync::Notify::new());
        let release_new_reply = Arc::new(tokio::sync::Notify::new());
        let close_seen_id = Arc::new(Mutex::new(None::<String>));
        let close_seen_notify = Arc::new(tokio::sync::Notify::new());

        let driver_tx = event_tx.clone();
        let driver_new_sent = new_sent_notify.clone();
        let driver_release = release_new_reply.clone();
        let driver_close_id = close_seen_id.clone();
        let driver_close_notify = close_seen_notify.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            assert_eq!(init["method"], "initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            assert_eq!(new_sess["method"], "session/new");
            driver_new_sent.notify_waiters();

            // Wait until the caller cancels `search()` before replying to `session/new`.
            driver_release.notified().await;
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-orphan-check" }
                }),
            );

            // Expect `session/close` for the newly opened session instead of leaving it orphaned.
            while let Some(msg) = written_rx.recv().await {
                if msg["method"] == "session/close" {
                    let closed_id = msg["params"]["sessionId"].as_str().unwrap_or_default().to_owned();
                    *driver_close_id.lock().unwrap() = Some(closed_id);
                    driver_close_notify.notify_waiters();
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                    break;
                }
            }
        });

        // Pre-warm the shared server and register a sibling session so the shared connection stays alive.
        let (warm_lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let server = warm_lease.server().clone();
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);
        drop(warm_lease);

        let backend = AgentWebSearch::new(agents.clone());
        let cancel = CancellationToken::new();
        let mut request = sample_request();
        request.model = DEFAULT_MODEL.into();

        let new_wait = new_sent_notify.notified();
        tokio::pin!(new_wait);
        new_wait.as_mut().enable();
        let mut search_fut = Box::pin(backend.search(request, &cancel));
        tokio::select! {
            _ = search_fut.as_mut() => panic!("search should wait for session/new reply"),
            () = new_wait => {}
        }

        // Cancel while `session/new` is in flight, then let the server send its delayed reply.
        cancel.cancel();
        let err = search_fut.await.expect_err("cancelled search must return Cancelled");
        assert_eq!(err.kind, AcpSearchErrorKind::Cancelled);

        release_new_reply.notify_waiters();

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let close_wait = close_seen_notify.notified();
                tokio::pin!(close_wait);
                close_wait.as_mut().enable();
                if close_seen_id.lock().unwrap().is_some() {
                    return;
                }
                close_wait.await;
            }
        })
        .await
        .expect("cancelled shared open must close the newly opened remote session once session/new replies");
        assert_eq!(close_seen_id.lock().unwrap().as_deref(), Some("sess-orphan-check"));
        assert!(!killed.load(Ordering::SeqCst), "sibling must keep the live shared server running");

        driver.await.unwrap();
        drop(event_tx);
    }

    #[tokio::test]
    async fn dropping_search_future_during_inflight_refusal_write_preserves_sibling() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let gate_entered = Arc::new(tokio::sync::Notify::new());
        let gate_release = Arc::new(tokio::sync::Notify::new());
        let manager = Arc::new(GatedScriptedAgent {
            events: Mutex::new(Some(event_rx)),
            written_tx,
            written_buf: Mutex::new(String::new()),
            killed: killed.clone(),
            gate_match: Box::new(|val| val["id"] == 89),
            gate_entered: gate_entered.clone(),
            gate_release: gate_release.clone(),
            gate_armed: AtomicBool::new(true),
        });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files, manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        let program = crate::session::Program::at("fake-agent");

        let replies = Arc::new(Mutex::new(Vec::<Value>::new()));
        let replies_notify = Arc::new(tokio::sync::Notify::new());
        let driver_tx = event_tx.clone();
        let driver_replies = replies.clone();
        let driver_replies_notify = replies_notify.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-inflight-refusal" }
                }),
            );
            let prompt = written_rx.recv().await.expect("session/prompt");
            assert_eq!(prompt["method"], "session/prompt");

            // Emit a disallowed tool permission RPC (id 89) to trigger a real in-flight refusal write,
            // followed immediately by a queued second permission RPC (id 90).
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": 89,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "sess-inflight-refusal",
                        "toolCall": { "toolCallId": "cmd-1", "name": "run_command", "kind": "execute", "rawInput": { "command": "echo hi" } },
                        "options": [
                            { "optionId": "allow", "kind": "allow_once" },
                            { "optionId": "reject", "kind": "reject_once" }
                        ]
                    }
                }),
            );
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": 90,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "sess-inflight-refusal",
                        "toolCall": { "toolCallId": "ws-2", "name": "search_web", "kind": "search", "rawInput": { "query": "rust" } },
                        "options": [
                            { "optionId": "allow", "kind": "allow_once" },
                            { "optionId": "reject", "kind": "reject_once" }
                        ]
                    }
                }),
            );

            while let Some(msg) = written_rx.recv().await {
                if msg["method"] == "session/close" {
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                }
                driver_replies.lock().unwrap().push(msg);
                driver_replies_notify.notify_waiters();
            }
        });

        let (warm_lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let server = warm_lease.server().clone();
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);
        drop(warm_lease);

        let backend = AgentWebSearch::new(agents.clone());
        let cancel = CancellationToken::new();
        let mut request = sample_request();
        request.model = DEFAULT_MODEL.into();

        // Drive the real search future until the refusal write for id 89 enters `write_stdin`.
        let entered = gate_entered.notified();
        tokio::pin!(entered);
        entered.as_mut().enable();
        let mut search_fut = Box::pin(backend.search(request, &cancel));
        tokio::select! {
            biased;
            () = entered => {}
            _ = search_fut.as_mut() => panic!("search should suspend inside the gated refusal write"),
        }

        // Drop the search future mid-refusal-write: must NOT break the shared connection or kill siblings!
        drop(search_fut);
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!killed.load(Ordering::SeqCst), "dropping during an in-flight refusal write must not kill the shared server");
        assert!(!sibling.gone().is_cancelled(), "sibling session must remain alive while refusal write is in flight");

        // Unblock the refusal write and verify both RPCs receive responses before session/close.
        gate_release.notify_waiters();

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let wait = replies_notify.notified();
                tokio::pin!(wait);
                wait.as_mut().enable();
                let seen = replies.lock().unwrap().clone();
                let pos_89 = seen.iter().position(|m| m["id"] == 89 && m["result"]["outcome"]["optionId"] == "reject");
                let pos_90 = seen.iter().position(|m| m["id"] == 90 && m["result"]["outcome"]["outcome"] == "cancelled");
                let pos_close = seen.iter().position(|m| m["method"] == "session/close" && m["params"]["sessionId"] == "sess-inflight-refusal");
                if let (Some(p89), Some(p90), Some(pclose)) = (pos_89, pos_90, pos_close) {
                    assert!(p89 < pclose && p90 < pclose, "both refusal replies must finish before session/close: {seen:?}");
                    return;
                }
                wait.await;
            }
        })
        .await
        .expect("dropping mid-refusal-write must finish in-flight refusal and queued refusal before session/close");

        assert!(!killed.load(Ordering::SeqCst), "sibling must keep live shared connection alive");
        assert!(!sibling.gone().is_cancelled());

        drop(event_tx);
        driver.abort();
    }

    #[tokio::test]
    async fn dropping_search_turn_mid_teardown_finishes_refusals_before_session_end() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let gate_entered = Arc::new(tokio::sync::Notify::new());
        let gate_release = Arc::new(tokio::sync::Notify::new());
        let manager = Arc::new(GatedScriptedAgent {
            events: Mutex::new(Some(event_rx)),
            written_tx,
            written_buf: Mutex::new(String::new()),
            killed: killed.clone(),
            gate_match: Box::new(|val| val["id"] == 91),
            gate_entered: gate_entered.clone(),
            gate_release: gate_release.clone(),
            gate_armed: AtomicBool::new(true),
        });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files.clone(), manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        let search_preset = search_only_preset(&official).expect("search preset");
        let program = crate::session::Program::at("fake-agent");

        let replies = Arc::new(Mutex::new(Vec::<Value>::new()));
        let replies_notify = Arc::new(tokio::sync::Notify::new());
        let driver_tx = event_tx.clone();
        let driver_replies = replies.clone();
        let driver_replies_notify = replies_notify.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-mid-teardown" }
                }),
            );
            while let Some(msg) = written_rx.recv().await {
                if msg["method"] == "session/close" {
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                }
                driver_replies.lock().unwrap().push(msg);
                driver_replies_notify.notify_waiters();
            }
        });

        let (warm_lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let server = warm_lease.server().clone();
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);
        drop(warm_lease);

        let (lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let cwd = AbsPath::new(std::env::current_dir().unwrap()).unwrap();
        let open = Open {
            preset: &search_preset,
            program: &program,
            cwd,
            definitions: &agents.parts.definitions,
            stored: None,
            rules: Some(SEARCH_ONLY_RULES.to_owned()),
            held: None,
            grants: Arc::default(),
            handed: None,
            temp: None,
        };
        let owned = AgentSession::open_on_shared_owned(lease, open, Arc::new(|| {}), Box::new(|| {}), None).await.ok().expect("open");
        let session = owned.session().clone();
        let thread = ThreadId::from("acp-search:mid-teardown");
        let opening = agents.begin_opening(thread.clone());
        let sandbox = SearchSandbox::new(AbsPath::new(std::env::current_dir().unwrap().join(SEARCH_SANDBOX_DIR).join("mid-teardown")).unwrap(), files);
        let reg = RegisteredSearchSession::register(agents.clone(), thread, &opening, owned, sandbox).ok().expect("register");

        let (waiting, stream) = session.attach(true);
        let mut guard = SearchTurnGuard::new(session.clone(), waiting, stream);
        guard.state_mut().queue.push_back(Incoming::Request {
            id: json!(91),
            method: "session/request_permission".into(),
            params: json!({ "sessionId": "sess-mid-teardown" }),
        });
        guard.state_mut().queue.push_back(Incoming::Request {
            id: json!(92),
            method: "session/request_permission".into(),
            params: json!({ "sessionId": "sess-mid-teardown" }),
        });
        // Also deliver an unread permission RPC into the live stream channel.
        let _ =
            session.take(Incoming::Request { id: json!(93), method: "session/request_permission".into(), params: json!({ "sessionId": "sess-mid-teardown" }) });

        let entered = gate_entered.notified();
        tokio::pin!(entered);
        entered.as_mut().enable();
        {
            let mut td_fut = Box::pin(guard.teardown());
            tokio::select! {
                biased;
                () = entered => {}
                () = td_fut.as_mut() => panic!("teardown should suspend on gated refusal 91"),
            }
            // Drop `td_fut` mid-teardown!
        }
        // Drop `guard` and `reg` while refusal 91 is still in flight in the non-cancellable cleanup task.
        drop(guard);
        drop(reg);

        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!session.gone().is_cancelled(), "session.end() must stay deferred until all refusals finish");
        assert!(!replies.lock().unwrap().iter().any(|m| m["method"] == "session/close"), "session/close must not fire before refusals complete");

        gate_release.notify_waiters();

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let wait = replies_notify.notified();
                tokio::pin!(wait);
                wait.as_mut().enable();
                let seen = replies.lock().unwrap().clone();
                let pos_91 = seen.iter().position(|m| m["id"] == 91 && m["result"]["outcome"]["outcome"] == "cancelled");
                let pos_92 = seen.iter().position(|m| m["id"] == 92 && m["result"]["outcome"]["outcome"] == "cancelled");
                let pos_93 = seen.iter().position(|m| m["id"] == 93 && m["result"]["outcome"]["outcome"] == "cancelled");
                let pos_close = seen.iter().position(|m| m["method"] == "session/close" && m["params"]["sessionId"] == "sess-mid-teardown");
                if let (Some(p91), Some(p92), Some(p93), Some(pclose)) = (pos_91, pos_92, pos_93, pos_close) {
                    assert!(p91 < pclose && p92 < pclose && p93 < pclose, "all three refusal replies must complete strictly before session/close: {seen:?}");
                    break;
                }
                wait.await;
            }
            session.gone().cancelled().await;
        })
        .await
        .expect("dropping mid-teardown must still finish all refusals, detach, and then end the session");

        assert!(!killed.load(Ordering::SeqCst), "sibling must keep live shared server alive");
        assert!(!sibling.gone().is_cancelled());

        drop(event_tx);
        driver.abort();
    }

    #[tokio::test]
    async fn dropping_search_future_refuses_queued_permission_rpc_on_live_shared_connection() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files, manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        let program = crate::session::Program::at("fake-agent");

        let prompt_seen = Arc::new(tokio::sync::Notify::new());
        let send_perm = Arc::new(tokio::sync::Notify::new());
        let perm_emitted = Arc::new(tokio::sync::Notify::new());
        let replies = Arc::new(Mutex::new(Vec::<Value>::new()));
        let replies_notify = Arc::new(tokio::sync::Notify::new());

        let driver_tx = event_tx.clone();
        let driver_prompt = prompt_seen.clone();
        let driver_send_perm = send_perm.clone();
        let driver_perm_emitted = perm_emitted.clone();
        let driver_replies = replies.clone();
        let driver_replies_notify = replies_notify.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-drop-perm" }
                }),
            );
            let prompt = written_rx.recv().await.expect("session/prompt");
            assert_eq!(prompt["method"], "session/prompt");
            driver_prompt.notify_waiters();

            driver_send_perm.notified().await;
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": 88,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "sess-drop-perm",
                        "toolCall": { "toolCallId": "ws-queued", "name": "search_web", "kind": "search", "rawInput": { "query": "rust" } },
                        "options": [
                            { "optionId": "allow", "kind": "allow_once" },
                            { "optionId": "reject", "kind": "reject_once" }
                        ]
                    }
                }),
            );
            driver_perm_emitted.notify_waiters();

            while let Some(msg) = written_rx.recv().await {
                if msg["method"] == "session/close" {
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                }
                driver_replies.lock().unwrap().push(msg);
                driver_replies_notify.notify_waiters();
            }
        });

        let (warm_lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let server = warm_lease.server().clone();
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);
        drop(warm_lease);

        let backend = AgentWebSearch::new(agents.clone());
        let cancel = CancellationToken::new();
        let mut request = sample_request();
        request.model = DEFAULT_MODEL.into();

        let prompt_wait = prompt_seen.notified();
        tokio::pin!(prompt_wait);
        prompt_wait.as_mut().enable();
        let mut search_fut = Box::pin(backend.search(request, &cancel));
        tokio::select! {
            biased;
            () = prompt_wait => {}
            _ = search_fut.as_mut() => panic!("search should wait for agent updates"),
        }

        let emitted_wait = perm_emitted.notified();
        tokio::pin!(emitted_wait);
        emitted_wait.as_mut().enable();
        send_perm.notify_waiters();
        emitted_wait.await;
        tokio::time::sleep(Duration::from_millis(25)).await;

        drop(search_fut);

        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let reply_wait = replies_notify.notified();
                tokio::pin!(reply_wait);
                reply_wait.as_mut().enable();
                let seen = replies.lock().unwrap().clone();
                let pos_88 = seen.iter().position(|m| m["id"] == 88 && m["result"]["outcome"]["outcome"] == "cancelled");
                let pos_close = seen.iter().position(|m| m["method"] == "session/close" && m["params"]["sessionId"] == "sess-drop-perm");
                if let (Some(p88), Some(pclose)) = (pos_88, pos_close) {
                    assert!(p88 < pclose, "queued permission refusal must complete before session/close: {seen:?}");
                    return;
                }
                reply_wait.await;
            }
        })
        .await
        .expect("dropping search future must send cancelled refusal for queued permission RPC before closing session");

        assert!(!killed.load(Ordering::SeqCst), "sibling must keep live shared connection alive");
        assert!(!sibling.gone().is_cancelled());

        drop(event_tx);
        driver.abort();
    }

    #[tokio::test]
    async fn dropping_search_future_during_grant_writing_breaks_connection_synchronously() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let gate_entered = Arc::new(tokio::sync::Notify::new());
        let gate_release = Arc::new(tokio::sync::Notify::new());
        let manager = Arc::new(GatedScriptedAgent {
            events: Mutex::new(Some(event_rx)),
            written_tx,
            written_buf: Mutex::new(String::new()),
            killed: killed.clone(),
            gate_match: Box::new(|val| val["id"] == 77 && val["result"]["outcome"]["optionId"] == "allow"),
            gate_entered: gate_entered.clone(),
            gate_release: gate_release.clone(),
            gate_armed: AtomicBool::new(true),
        });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files, manager);
        let official = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        let program = crate::session::Program::at("fake-agent");

        let driver_tx = event_tx.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-grant-drop" }
                }),
            );
            let prompt = written_rx.recv().await.expect("session/prompt");
            assert_eq!(prompt["method"], "session/prompt");

            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": 77,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "sess-grant-drop",
                        "toolCall": { "toolCallId": "ws-grant-1", "name": "search_web", "kind": "search", "rawInput": { "query": "rust" } },
                        "options": [
                            { "optionId": "allow", "kind": "allow_once" },
                            { "optionId": "reject", "kind": "reject_once" }
                        ]
                    }
                }),
            );
            while written_rx.recv().await.is_some() {}
        });

        let (warm_lease, _) = agents.shared_server_bounded(&official, &program, None).await.expect("shared server");
        let server = warm_lease.server().clone();
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);
        drop(warm_lease);

        let backend = AgentWebSearch::new(agents);
        let cancel = CancellationToken::new();
        let mut request = sample_request();
        request.model = DEFAULT_MODEL.into();

        let entered = gate_entered.notified();
        tokio::pin!(entered);
        entered.as_mut().enable();
        let mut search_fut = Box::pin(backend.search(request, &cancel));
        tokio::select! {
            biased;
            () = entered => {}
            _ = search_fut.as_mut() => panic!("search should suspend inside the gated grant write"),
        }

        assert!(!killed.load(Ordering::SeqCst), "connection must still be alive before drop");

        // Dropping while `GRANT_WRITING` is in flight must synchronously break/kill the connection inside `Drop`,
        // BEFORE any spawned async teardown task is polled.
        drop(search_fut);
        assert!(killed.load(Ordering::SeqCst), "dropping SearchTurnGuard during GRANT_WRITING must break the connection synchronously inside Drop");

        gate_release.notify_waiters();
        drop(event_tx);
        driver.abort();
    }

    #[test]
    fn search_permission_gating_denies_provider_local_file_and_command_keys_case_insensitively() {
        let mut state = SearchTurnState::default();
        let options = json!([
            { "optionId": "allow", "kind": "allow_once" },
            { "optionId": "reject", "kind": "reject_once" }
        ]);

        for (idx, (key, val)) in [
            ("CommandLine", "rm -rf /tmp/x"),
            ("commandline", "whoami"),
            ("Path", "/etc/passwd"),
            ("PATH", "/etc/hosts"),
            ("AbsolutePath", "C:\\Windows\\win.ini"),
            ("absolutePath", "/var/log/syslog"),
            ("TargetFile", "secret.env"),
            ("targetFile", "notes.txt"),
            ("FilePath", "Cargo.toml"),
            ("TargetDirectory", "/tmp"),
        ]
        .into_iter()
        .enumerate()
        {
            let mut raw = serde_json::Map::new();
            raw.insert("query".into(), json!("rust"));
            raw.insert(key.into(), json!(val));
            let params = json!({
                "toolCall": {
                    "toolCallId": format!("ws-local-{idx}"),
                    "name": "search_web",
                    "kind": "search",
                    "rawInput": Value::Object(raw),
                },
                "options": options,
            });
            let (answer, is_grant) = decide_search_permission(&params, &mut state);
            assert!(!is_grant, "search_web permission carrying local key `{key}` must be denied fail-closed");
            assert_eq!(answer["outcome"]["optionId"], "reject", "expected reject_once for `{key}`");
        }

        // Control: clean web search request with only `query` is still allowed.
        let clean = json!({
            "toolCall": {
                "toolCallId": "ws-clean",
                "name": "search_web",
                "kind": "search",
                "rawInput": { "query": "rust 1.85 release notes" },
            },
            "options": options,
        });
        let (answer, is_grant) = decide_search_permission(&clean, &mut state);
        assert!(is_grant, "clean search_web request must still be granted");
        assert_eq!(answer["outcome"]["optionId"], "allow");
    }

    #[tokio::test]
    async fn search_active_refusal_write_on_stalled_stdin_exits_bounded() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let gate_entered = Arc::new(tokio::sync::Notify::new());
        let gate_release = Arc::new(tokio::sync::Notify::new());
        let manager = Arc::new(GatedScriptedAgent {
            events: Mutex::new(Some(event_rx)),
            written_tx,
            written_buf: Mutex::new(String::new()),
            killed: killed.clone(),
            gate_match: Box::new(|val| val["id"] == 95),
            gate_entered: gate_entered.clone(),
            gate_release: gate_release.clone(),
            gate_armed: AtomicBool::new(true),
        });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files, manager);

        let driver_tx = event_tx.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": { "sessionCapabilities": { "close": {} } }
                    }
                }),
            );
            let new_sess = written_rx.recv().await.expect("session/new");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": new_sess["id"],
                    "result": { "sessionId": "sess-stalled-refusal" }
                }),
            );
            let prompt = written_rx.recv().await.expect("session/prompt");
            assert_eq!(prompt["method"], "session/prompt");

            // Trigger an active refusal write whose stdin write stalls indefinitely.
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": 95,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "sess-stalled-refusal",
                        "toolCall": { "toolCallId": "cmd-stall", "name": "run_command", "kind": "execute", "rawInput": { "CommandLine": "id" } },
                        "options": [
                            { "optionId": "allow", "kind": "allow_once" },
                            { "optionId": "reject", "kind": "reject_once" }
                        ]
                    }
                }),
            );
            while written_rx.recv().await.is_some() {}
        });

        let backend = AgentWebSearch::new(agents);
        let cancel = CancellationToken::new();
        let mut request = sample_request();
        request.model = DEFAULT_MODEL.into();

        // Without releasing `gate_release`, the active refusal write must time out under RefuseBudget,
        // break the stalled connection, and return an error within a bounded duration.
        let result = mixdog_rt::time::timeout(Duration::from_secs(2), backend.search(request, &cancel))
            .await
            .expect("active refusal write on stalled stdin must not hang the search turn");
        let err = result.expect_err("stalled refusal write must fail the search turn");
        assert_eq!(err.kind, AcpSearchErrorKind::Failed);
        assert!(killed.load(Ordering::SeqCst), "stalled stdin during active refusal must break/kill the connection");

        gate_release.notify_waiters();
        drop(event_tx);
        driver.abort();
    }

    #[tokio::test]
    async fn open_on_shared_concurrent_reopen_drop_skips_spurious_session_close() {
        struct GatedDigestTools {
            started: Arc<tokio::sync::Notify>,
            release: Arc<tokio::sync::Notify>,
        }

        #[async_trait]
        impl crate::mcp::SessionTools for GatedDigestTools {
            async fn definitions(&self, _thread: &ThreadId) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
                let done = self.release.notified();
                tokio::pin!(done);
                done.as_mut().enable();
                self.started.notify_waiters();
                done.await;
                Ok(Vec::new())
            }

            fn tasks(&self) -> &mixdog_agent::agent_tool::board::JobBoard {
                unreachable!("tasks() is unused during open_session")
            }
        }

        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (written_tx, mut written_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(AtomicBool::new(false));
        let manager =
            Arc::new(ScriptedAgent { events: Mutex::new(Some(event_rx)), written_tx, written_buf: Mutex::new(String::new()), killed: killed.clone() });
        let files = Arc::new(TrackingFiles::new());
        let agents = test_agents_for_search(files, manager);
        let mut load_preset = crate::preset::builtin().into_iter().find(|p| p.id == "antigravity").expect("official preset");
        load_preset.quirks.reopen = crate::preset::Reopen::Load;
        let program = crate::session::Program::at("fake-agent");

        let first_load_seen = Arc::new(tokio::sync::Notify::new());
        let release_first_load = Arc::new(tokio::sync::Notify::new());
        let loads_seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let closes_seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let driver_tx = event_tx.clone();
        let driver_first_load_seen = first_load_seen.clone();
        let driver_release_first_load = release_first_load.clone();
        let driver_loads = loads_seen.clone();
        let driver_closes = closes_seen.clone();
        let driver = tokio::spawn(async move {
            let mut seq = 0u64;
            let init = written_rx.recv().await.expect("initialize");
            emit_json(
                &driver_tx,
                &mut seq,
                json!({
                    "jsonrpc": "2.0",
                    "id": init["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "fake", "version": "1.5.2" },
                        "agentCapabilities": {
                            "sessionCapabilities": { "close": {} },
                            "mcpCapabilities": { "http": true }
                        }
                    }
                }),
            );
            while let Some(msg) = written_rx.recv().await {
                if msg["method"] == "session/load" {
                    let count = driver_loads.fetch_add(1, Ordering::SeqCst) + 1;
                    if count == 1 {
                        let release = driver_release_first_load.notified();
                        tokio::pin!(release);
                        release.as_mut().enable();
                        driver_first_load_seen.notify_waiters();
                        release.await;
                    }
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                } else if msg["method"] == "session/close" {
                    if let Some(id) = msg["params"]["sessionId"].as_str() {
                        driver_closes.lock().unwrap().push(id.to_owned());
                    }
                    emit_json(&driver_tx, &mut seq, json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
                }
            }
        });

        let (warm_lease, _) = agents.shared_server_bounded(&load_preset, &program, None).await.expect("shared server");
        let server = warm_lease.server().clone();
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&sibling);
        drop(warm_lease);

        let cwd = AbsPath::new(std::env::current_dir().unwrap()).unwrap();

        // Open #1 suspends in `handed.current_digest()` BEFORE sending `session/load`.
        let (lease1, _) = agents.shared_server_bounded(&load_preset, &program, None).await.expect("shared server 1");
        let digest1_started = Arc::new(tokio::sync::Notify::new());
        let digest1_release = Arc::new(tokio::sync::Notify::new());
        let open1 = Open {
            preset: &load_preset,
            program: &program,
            cwd: cwd.clone(),
            definitions: &agents.parts.definitions,
            stored: Some("sess-reopen-race".into()),
            rules: None,
            held: None,
            grants: Arc::default(),
            handed: Some(crate::mcp::Handover {
                thread: ThreadId::from("thread-reopen-1"),
                tools: Arc::new(GatedDigestTools { started: digest1_started.clone(), release: digest1_release.clone() }),
                bridge: None,
            }),
            temp: None,
        };
        let wait1 = digest1_started.notified();
        tokio::pin!(wait1);
        wait1.as_mut().enable();
        let mut open1_fut = Box::pin(AgentSession::open_on_shared_owned(lease1, open1, Arc::new(|| {}), Box::new(|| {}), None));
        tokio::select! {
            _ = open1_fut.as_mut() => panic!("open #1 should suspend in tool digest before session/load"),
            () = wait1 => {}
        }
        assert_eq!(loads_seen.load(Ordering::SeqCst), 0, "digest lookup must run before session/load");

        // Dropping Open #1 during tool digest sends neither `session/load` nor `session/close`.
        drop(open1_fut);

        // Open #2 sends `session/load` and is dropped while `session/load` is in flight; when the reply arrives,
        // no spurious `session/close` is emitted against a concurrent Open #3 that completes and registers.
        let (lease2, _) = agents.shared_server_bounded(&load_preset, &program, None).await.expect("shared server 2");
        let open2 = Open {
            preset: &load_preset,
            program: &program,
            cwd: cwd.clone(),
            definitions: &agents.parts.definitions,
            stored: Some("sess-reopen-race".into()),
            rules: None,
            held: None,
            grants: Arc::default(),
            handed: None,
            temp: None,
        };
        let load1_wait = first_load_seen.notified();
        tokio::pin!(load1_wait);
        load1_wait.as_mut().enable();
        let mut open2_fut = Box::pin(AgentSession::open_on_shared_owned(lease2, open2, Arc::new(|| {}), Box::new(|| {}), None));
        tokio::select! {
            _ = open2_fut.as_mut() => panic!("open #2 should wait for session/load reply"),
            () = load1_wait => {}
        }
        drop(open2_fut);
        release_first_load.notify_waiters();

        // Open #3 completes `session/load` and registers cleanly right after.
        let (lease3, _) = agents.shared_server_bounded(&load_preset, &program, None).await.expect("shared server 3");
        let open3 = Open {
            preset: &load_preset,
            program: &program,
            cwd,
            definitions: &agents.parts.definitions,
            stored: Some("sess-reopen-race".into()),
            rules: None,
            held: None,
            grants: Arc::default(),
            handed: None,
            temp: None,
        };
        let owned3 =
            mixdog_rt::time::timeout(Duration::from_secs(2), AgentSession::open_on_shared_owned(lease3, open3, Arc::new(|| {}), Box::new(|| {}), None))
                .await
                .expect("open #3 should finish promptly")
                .ok()
                .expect("open #3 should register cleanly");
        tokio::time::sleep(Duration::from_millis(40)).await;

        assert_eq!(loads_seen.load(Ordering::SeqCst), 2, "only Open #2 and Open #3 should send session/load");
        assert!(
            closes_seen.lock().unwrap().is_empty(),
            "dropping concurrent reopens must never emit a spurious session/close: {:?}",
            closes_seen.lock().unwrap()
        );
        assert!(!owned3.session().gone().is_cancelled(), "Open #3 must stay healthy after registering");
        assert!(!sibling.gone().is_cancelled(), "sibling must stay alive");
        assert!(!killed.load(Ordering::SeqCst), "shared server must stay alive");

        drop(owned3);
        drop(event_tx);
        driver.abort();
    }
}
