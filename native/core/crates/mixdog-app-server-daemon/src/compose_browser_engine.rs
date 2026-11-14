//! What the browser engine is composed from in mixdogd (CORE-WIRE-G7): the ports `BrowserEngine` runs over (the one blob store,
//! the frame files beside the run, the one secret fill, the card holds and the one approval path), the claim the engine's host
//! lane is served by, and the operator's settings it reads. The engine runs a Browser Use action only when the connected desktop
//! serves `browserEngine` (`EngineHostCommands`); any other desktop is sent `host/browser/command` exactly as before.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_app_server::Outgoing;
use mixdog_browser_engine::BlobPort;
use mixdog_browser_engine::FilePort;
use mixdog_browser_engine::TurnEvents;
use mixdog_browser_engine::approval::classify::ActionPolicy;
use mixdog_browser_engine::approval::requester::PoolRow;
use mixdog_browser_engine::approval::requester::Requester;
use mixdog_browser_engine::approval::requester::SessionRow;
use mixdog_browser_engine::approval::requester::Sources;
use mixdog_browser_engine::approval::requester::resolve_requester;
use mixdog_browser_engine::runner::guard::SecretGuard;
use mixdog_browser_engine::types::FileFacts;
use mixdog_browser_policy::url_policy::UrlPolicy;
use mixdog_core::run_host::compose_parts::LateDirectory;
use mixdog_core::run_host::mcp_seams::AllowAllActions;
use mixdog_core_api::HostCapability;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::support::on_lane_wait;
use mixdog_core_rooms::rooms::catalog_rows::MemberNames;
use mixdog_core_session::session::secret_input::CardHolds;
use mixdog_core_session::session::shell_jobs::OwnedShells;
use mixdog_core_session::session::secret_input::CardScope;
use mixdog_core_session::session::secret_input::HumanOnlyCard;
use mixdog_core_session::session::secret_input::Redact;
use mixdog_core_session::session::secret_input::SecretFill;
use mixdog_core_session::session::turn_snapshots::TurnSnapshots;
use mixdog_protocol::ThreadId;
use mixdog_rt::InteractiveIo;
use mixdog_store::blobs::BlobStore;
use mixdog_tools::desktop::browser_approval::ApprovalContext;
use mixdog_tools::desktop::browser_approval::CardHold;
use mixdog_tools::desktop::computer_image_output::ImageOutput;
use mixdog_tools::policy::PolicySettings;
use mixdog_tools::policy::SessionFacts;
use mixdog_tools::policy::SessionGrantRegistry;
use mixdog_tools::policy::SessionGrants;
use tokio_util::sync::CancellationToken;

use crate::browser_engine_service::ClaimantProbe;

/// The engine's frames are kept apart from the computer's: `<data>/frames/browser`.
pub fn frame_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("frames").join("browser")
}

/// The operator's policy of which steps ask or are refused, read once at start (the desktop's `host-foundation.ts` read the same
/// variables of its own environment, which the core inherits).
pub fn action_policy(env: &dyn Fn(&str) -> Option<String>) -> ActionPolicy {
    ActionPolicy::from_env(
        env("MIXDOG_BROWSER_CONFIRM_ACTIONS").as_deref(),
        env("MIXDOG_BROWSER_DENY_ACTIONS").as_deref(),
        env("MIXDOG_BROWSER_CONFIRM_SUBMIT").as_deref(),
        mixdog_browser_engine::actions::registry::is_action,
    )
}

/// `browserUrlPolicyFromEnvironment` for a session that works on this PC (`remote: false`): private networks are the person's
/// own, and `MIXDOG_BROWSER_ALLOWED_DOMAINS` narrows the domains.
pub fn url_policy(env: &dyn Fn(&str) -> Option<String>) -> UrlPolicy {
    let allowed_domains = env("MIXDOG_BROWSER_ALLOWED_DOMAINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|domain| !domain.is_empty())
        .map(str::to_owned)
        .collect();
    UrlPolicy { allow_private_network: true, allowed_domains }
}

/// The one blob store, by digest: a screenshot or download the desktop handed over by reference.
pub struct StoreBlobPort {
    pub blobs: BlobStore,
    pub lane: InteractiveIo,
}

#[async_trait]
impl BlobPort for StoreBlobPort {
    async fn read(&self, digest: &str) -> Result<Bytes, String> {
        let digest = mixdog_store::blobs::digest_of_reference(digest.strip_prefix("sha256:").unwrap_or(digest)).ok_or_else(|| format!("not a blob digest: {digest}"))?;
        let blobs = self.blobs.clone();
        on_lane_wait(self.lane, &CancellationToken::new(), move |lane| blobs.read(lane, &digest))
            .await
            .map_err(|error| error.to_string())?
            .map(Bytes::from)
            .map_err(|error| error.to_string())
    }
}

/// The files the engine reads facts of (an upload's path) and writes (a frame kept beside the run, pruned as the computer's are).
pub struct EngineFiles {
    pub lane: InteractiveIo,
}

#[async_trait]
impl FilePort for EngineFiles {
    async fn stat(&self, path: &Path) -> FileFacts {
        let path = path.to_path_buf();
        on_lane_wait(self.lane, &CancellationToken::new(), move |_| match std::fs::metadata(&path) {
            Ok(info) => FileFacts { exists: true, is_file: info.is_file(), size: info.len(), canonical: std::fs::canonicalize(&path).ok(), modified: info.modified().ok() },
            Err(_) => FileFacts::default(),
        })
        .await
        .unwrap_or_default()
    }

    async fn write_frame(&self, run_dir: &Path, bytes: Bytes, mime_type: &str) -> std::io::Result<PathBuf> {
        let (output, mime) = (ImageOutput::at(run_dir.to_path_buf()), mime_type.to_owned());
        on_lane_wait(self.lane, &CancellationToken::new(), move |_| output.write("browser", "", &bytes, &mime))
            .await
            .map_err(|error| std::io::Error::other(error.to_string()))?
            .map_err(|error| std::io::Error::other(format!("{error:?}")))
    }
}

/// The session's filled secrets: the one secret fill's registry and the redactor that also hides saved-login passwords.
pub struct FillSecretGuard {
    pub fill: Arc<SecretFill>,
    pub redactor: Arc<dyn Redact>,
}

impl SecretGuard for FillSecretGuard {
    fn redact(&self, session_id: &str, text: &str) -> String {
        self.redactor.redact(&ThreadId::from(session_id), text)
    }

    fn remember(&self, session_id: &str, secret: &str) {
        self.fill.remember(&ThreadId::from(session_id), secret);
    }
}

/// The connection the engine lane is served by: the latest claim that declared `browserEngine`.
pub struct OutgoingClaimants(pub Arc<Outgoing>);

impl ClaimantProbe for OutgoingClaimants {
    fn is_claimant(&self, connection: ConnectionId) -> bool {
        self.0.serves_capability(connection, HostCapability::BrowserEngine)
    }
}

/// What a Browser Use card is decided and named by: the session's life mark, the "Allow all actions" option, the session's
/// allowances (the one registry the sessions' gates read), the requester's name, and the human-only hold of the card.
pub struct BrowserApprovalContext {
    pub late: Arc<LateDirectory>,
    pub allow_all: Arc<dyn AllowAllActions>,
    pub session_grants: Arc<SessionGrantRegistry>,
    pub card_holds: Arc<CardHolds>,
    pub names: Arc<dyn MemberNames>,
    /// The session catalog, bound once it is opened (after the engine is built); unbound, the card is raised unnamed.
    pub catalog: Arc<OnceLock<Arc<mixdog_store::sqlite::SqliteStore>>>,
}

impl BrowserApprovalContext {
    /// The listed row of `session_id` (its title, else its preview, and its folder), as the roster shows it.
    async fn session_row(&self, session_id: &str) -> Option<SessionRow> {
        let summary = self.catalog.get()?.summary(session_id).await.ok()??;
        let row: serde_json::Value = serde_json::from_str(&summary).ok()?;
        let text = |key: &str| row.get(key).and_then(serde_json::Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
        Some(SessionRow {
            id: session_id.to_owned(),
            title: text("title").or_else(|| text("preview")).unwrap_or_default(),
            cwd: text("cwd").unwrap_or_default(),
            agent_session: row.get("agentSession").and_then(serde_json::Value::as_bool).unwrap_or(false),
            agent_home: agent_id_of_home_session(session_id).unwrap_or_default(),
        })
    }
}

#[async_trait]
impl ApprovalContext for BrowserApprovalContext {
    fn facts(&self, thread: &ThreadId) -> SessionFacts {
        // The port keeps the life mark only; the bot is read from the session id, and the session is decided as an attended turn.
        let life = self.late.live_header(thread.as_str()).and_then(|header| mixdog_core_ports::ports::gate::life_mark(&header));
        SessionFacts { life, ..SessionFacts::default() }
    }

    fn settings(&self) -> PolicySettings {
        PolicySettings { allow_all_actions: self.allow_all.allow_all_actions() }
    }

    fn session_grants(&self, thread: &ThreadId) -> SessionGrants {
        SessionGrants::of(self.session_grants.clone(), thread.as_str())
    }

    async fn requester(&self, thread: &ThreadId) -> Requester {
        // Only a bot's own session asks (its home chat, listed; or its room member session, unlisted), and a sub-agent is no bot's:
        // the asking session's own row is all the roster the name needs.
        let sessions: Vec<SessionRow> = self.session_row(thread.as_str()).await.into_iter().collect();
        let names = self.names.names().await;
        let lead = names.get(MIXY_AGENT_ID).cloned().unwrap_or_default();
        let agent_name = |agent: &str| names.get(agent).cloned();
        let pool: [PoolRow; 0] = [];
        resolve_requester(thread.as_str(), &Sources { sessions: &sessions, pool: &pool, agent_name: &agent_name, lead_name: &lead })
    }

    /// A browser tool call raises its card through the call's own gate (`BrowserTool::call` runs inside `with_call_approvals`); a
    /// command no tool call made has no gate.
    fn session_gate(&self, _thread: &ThreadId) -> Option<Arc<dyn ApprovalGate>> {
        None
    }

    fn hold_card(&self, request_id: &str, thread: &ThreadId) -> CardHold {
        self.card_holds.hold_for_request_in(request_id, HumanOnlyCard::BrowserApproval, CardScope { thread: Some(thread.clone()), ..CardScope::default() });
        let (holds, id) = (self.card_holds.clone(), request_id.to_owned());
        CardHold::new(move || {
            holds.release(&id);
        })
    }
}

/// `test/browserEngine/run`'s runner: one `browser` or `browser_devtools` call over the same host commands the tools are built over.
#[cfg(feature = "test-hooks")]
pub struct EngineToolRunner(pub Arc<dyn mixdog_tools::desktop::host::HostCommands>);

#[cfg(feature = "test-hooks")]
#[async_trait]
impl crate::browser_engine_service::BrowserToolRunner for EngineToolRunner {
    async fn run(
        &self,
        thread: ThreadId,
        _tool: mixdog_app_protocol::v2::browser_engine::BrowserTestTool,
        args: serde_json::Value,
        cancel: CancellationToken,
    ) -> mixdog_app_protocol::v2::browser_engine::BrowserEngineTestRunResult {
        use mixdog_app_protocol::v2::browser_engine::BrowserEngineTestRunResult;
        use mixdog_app_protocol::v2::browser_engine::BrowserTestRunImage;
        use mixdog_core_api::domain::tool::ToolPart;

        let Some(action) = args.get("action").and_then(serde_json::Value::as_str) else {
            return BrowserEngineTestRunResult { text: "Error: action is required".to_owned(), image: None, is_error: true, outcome: None };
        };
        let input = match args.get("input") {
            Some(input @ serde_json::Value::Object(_)) => input.clone(),
            _ => serde_json::Value::Object(serde_json::Map::new()),
        };
        match self.0.browser(&thread, action, input, &cancel).await {
            Ok(value) => {
                let rendered = mixdog_tools::desktop::host::browser_output(&value);
                let image = value.get("image").and_then(|image| {
                    Some(BrowserTestRunImage { mime_type: image.get("mimeType")?.as_str()?.to_owned(), data: image.get("data")?.as_str()?.to_owned() })
                });
                let outcome = value.get("outcome").cloned();
                match rendered {
                    Ok(output) => {
                        let text = output.parts.iter().filter_map(|part| if let ToolPart::Text(text) = part { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("\n");
                        BrowserEngineTestRunResult { text, image, is_error: false, outcome }
                    }
                    Err(error) => BrowserEngineTestRunResult { text: error.message_for_model, image, is_error: true, outcome },
                }
            }
            Err(error) => {
                let error = mixdog_tools::desktop::host::command_error(mixdog_tools::desktop::host::BROWSER_UNAVAILABLE, error);
                BrowserEngineTestRunResult { text: error.message_for_model, image: None, is_error: true, outcome: None }
            }
        }
    }
}

/// The session deps' `TurnSnapshots` with the browser engine told beside it: where an agent turn settles the engine ends its running
/// turn, as aborted when the session said the turn did not complete (the host forgets what it remembered of the turn, the pages an
/// aborted turn opened for itself and the untouched blank page are closed). A runtime that stops (an unload, a parked idle agent) is not a
/// release: the engine's session ends in [`EngineSessionRelease`].
pub struct EngineTurnSnapshots {
    inner: Arc<dyn TurnSnapshots>,
    turns: Arc<dyn TurnEvents>,
    /// The threads whose settling turn did not complete.
    aborted: std::sync::Mutex<std::collections::HashSet<ThreadId>>,
}

impl EngineTurnSnapshots {
    pub fn new(inner: Arc<dyn TurnSnapshots>, turns: Arc<dyn TurnEvents>) -> Self {
        Self { inner, turns, aborted: Default::default() }
    }
}

impl TurnSnapshots for EngineTurnSnapshots {
    fn turn_aborted(&self, thread: &ThreadId) {
        self.aborted.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(thread.clone());
        self.inner.turn_aborted(thread);
    }

    fn turn_settled(&self, thread: &ThreadId) {
        let aborted = self.aborted.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(thread);
        self.turns.turn_ended(thread, aborted);
        self.inner.turn_settled(thread);
    }

    fn runtime_stopped(&self, thread: &ThreadId) {
        self.inner.runtime_stopped(thread);
    }

    fn dispose(&self) {
        self.inner.dispose();
    }
}

/// `OwnedShells` that also tells the engine its session was released: a close or a delete of a session (an unload never cancels
/// shells), where TS ran `releaseSession` (the pages the session owned are forgotten, the desktop drops its turn marks).
pub struct EngineSessionRelease {
    inner: Arc<dyn OwnedShells>,
    turns: Arc<dyn TurnEvents>,
}

impl EngineSessionRelease {
    pub fn new(inner: Arc<dyn OwnedShells>, turns: Arc<dyn TurnEvents>) -> Self {
        Self { inner, turns }
    }
}

impl OwnedShells for EngineSessionRelease {
    fn cancel_owned(&self, owner: &ThreadId) {
        self.inner.cancel_owned(owner);
        self.turns.session_ended(owner);
    }
}

#[cfg(test)]
mod turn_tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Log(Mutex<Vec<String>>);

    struct Events(Arc<Log>);

    impl TurnEvents for Events {
        fn turn_ended(&self, thread: &ThreadId, aborted: bool) {
            self.0.0.lock().unwrap().push(format!("ended {} {aborted}", thread.as_str()));
        }

        fn session_ended(&self, thread: &ThreadId) {
            self.0.0.lock().unwrap().push(format!("session {}", thread.as_str()));
        }
    }

    struct Snapshots(Arc<Log>);

    impl TurnSnapshots for Snapshots {
        fn turn_settled(&self, thread: &ThreadId) {
            self.0.0.lock().unwrap().push(format!("settled {}", thread.as_str()));
        }

        fn runtime_stopped(&self, thread: &ThreadId) {
            self.0.0.lock().unwrap().push(format!("stopped {}", thread.as_str()));
        }

        fn dispose(&self) {
            self.0.0.lock().unwrap().push("dispose".to_owned());
        }
    }

    struct Shells(Arc<Log>);

    impl OwnedShells for Shells {
        fn cancel_owned(&self, owner: &ThreadId) {
            self.0.0.lock().unwrap().push(format!("cancel {}", owner.as_str()));
        }
    }

    #[test]
    fn the_engine_is_told_how_a_turn_ended_and_a_stopped_runtime_is_no_release() {
        let log = Arc::new(Log::default());
        let both = EngineTurnSnapshots::new(Arc::new(Snapshots(log.clone())), Arc::new(Events(log.clone())));
        let thread = ThreadId::from("s1");
        both.turn_aborted(&thread);
        both.turn_settled(&thread);
        both.turn_settled(&thread);
        both.runtime_stopped(&thread);
        both.dispose();
        assert_eq!(*log.0.lock().unwrap(), ["ended s1 true", "settled s1", "ended s1 false", "settled s1", "stopped s1", "dispose"]);
    }

    #[test]
    fn a_released_session_reaches_the_engine_after_its_shells() {
        let log = Arc::new(Log::default());
        let release = EngineSessionRelease::new(Arc::new(Shells(log.clone())), Arc::new(Events(log.clone())));
        release.cancel_owned(&ThreadId::from("s1"));
        assert_eq!(*log.0.lock().unwrap(), ["cancel s1", "session s1"]);
    }
}
