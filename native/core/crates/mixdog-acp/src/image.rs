//! Image-only ACP sessions for Antigravity's built-in `generate_image` tool.
//!
//! Each image generation or edit opens an ephemeral ACP session with no Mixdog tools handed over
//! and every built-in agent tool disabled except `generate_image`, stages any reference images in
//! an isolated per-request sandbox directory, auto-approves only `generate_image` calls whose
//! `ImagePaths` stay within the staged references while refusing all other permission requests,
//! extracts the resulting image from the tool-call stream (or agent-home file fallback), and ends
//! the session through `SharedServer`'s end-of-use retirement so helper processes do not pile up.

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use base64::Engine as _;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::ids::ThreadId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

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
use crate::preset::Distribution;
use crate::preset::OwnToolsOff;
use crate::preset::ProcessScope;
use crate::preset::Quirks;
use crate::preset::Version;
use crate::rows::AgentTool;
use crate::rows::Picture;
use crate::rows::block_text;
use crate::session::AgentSession;
use crate::session::Open;
use crate::session::OpenSharedError;
use crate::session::OwnedSession;
use crate::session::RefuseBudget;
use crate::session::not_offered;
use crate::turn::PICTURE_MAX_BYTES;
use crate::turn::TurnEnd;
use crate::turn::local_file_path;

pub const ACP_ANTIGRAVITY_PROVIDER: &str = "acp-antigravity";
pub const IMAGE_MODEL_ID: &str = "antigravity-image";
pub const IMAGE_MODEL_LABEL: &str = "Antigravity Image";

/// Fast Flash model tier preferred inside ephemeral image-only sessions when advertised by the
/// server; `generate_image` always calls the server's own image model regardless of orchestrator.
const PREFERRED_ORCHESTRATOR_MODEL: &str = "gemini-3.8-flash-low";
const SHARED_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const IMAGE_SANDBOX_DIR: &str = "image-sandbox";
const IMAGE_SANDBOX_FOLDER: &str = "the ACP image generation sandbox folder";
const IMAGE_ONLY_RULES: &str = "\
You are running in an image-generation-only session.
- Use ONLY your built-in `generate_image` tool once to fulfill the user's request.
- Do NOT inspect files, run commands, browse the web, or call any other tool.
- When reference image paths are listed in the prompt, pass those exact paths in `ImagePaths`. When none are listed, omit `ImagePaths`.
- If `generate_image` fails or the request violates policy, do not retry; reply with a brief plain-language explanation.";

#[derive(Clone, Debug)]
pub struct AcpImageReference {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct AcpImageRequest {
    pub provider: String,
    pub prompt: String,
    pub aspect_ratio: Option<String>,
    pub references: Vec<AcpImageReference>,
}

#[derive(Clone, Debug)]
pub struct AcpImageReply {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub revised_prompt: Option<String>,
    pub usage: Option<Value>,
    pub served_model: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcpImageErrorKind {
    NotInstalled,
    SignIn,
    Capacity,
    Refusal,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AcpImageError {
    pub kind: AcpImageErrorKind,
    pub message: String,
    pub usage: Option<Value>,
}

impl AcpImageError {
    pub fn not_installed(message: impl Into<String>) -> Self {
        Self { kind: AcpImageErrorKind::NotInstalled, message: message.into(), usage: None }
    }

    pub fn sign_in(message: impl Into<String>) -> Self {
        Self { kind: AcpImageErrorKind::SignIn, message: message.into(), usage: None }
    }

    pub fn capacity(message: impl Into<String>) -> Self {
        Self { kind: AcpImageErrorKind::Capacity, message: message.into(), usage: None }
    }

    pub fn refusal(message: impl Into<String>) -> Self {
        Self { kind: AcpImageErrorKind::Refusal, message: message.into(), usage: None }
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self { kind: AcpImageErrorKind::Cancelled, message: message.into(), usage: None }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self { kind: AcpImageErrorKind::Failed, message: message.into(), usage: None }
    }

    pub fn with_usage(mut self, usage: Option<Value>) -> Self {
        self.usage = usage;
        self
    }

    pub fn code(&self) -> &'static str {
        match self.kind {
            AcpImageErrorKind::NotInstalled => "MEDIA_LANE_UNAUTHENTICATED",
            AcpImageErrorKind::SignIn => "MEDIA_LANE_UNAUTHENTICATED",
            AcpImageErrorKind::Capacity => "MEDIA_RATE_LIMITED",
            AcpImageErrorKind::Refusal => "MEDIA_REFUSED",
            AcpImageErrorKind::Cancelled => "MEDIA_CANCELED",
            AcpImageErrorKind::Failed => "MEDIA_UPSTREAM_FAILED",
        }
    }
}

fn now_ms() -> i64 {
    mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// [`TextFiles`] wrapper for image-only sessions that blocks every client `fs/read_text_file`
/// read and exposes no readable roots while forwarding sandbox folder and binary staging ops.
struct ImageNoReadFiles(Arc<dyn TextFiles>);

#[async_trait]
impl TextFiles for ImageNoReadFiles {
    async fn read(&self, _path: AbsPath) -> Result<String, String> {
        Err("file reads are disabled in image-generation-only sessions".to_owned())
    }

    async fn read_bytes(&self, _path: AbsPath, _offset: u64, _len: u64) -> Result<Vec<u8>, String> {
        Err("file reads are disabled in image-generation-only sessions".to_owned())
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

    async fn create_bytes(&self, path: AbsPath, bytes: Vec<u8>) -> Result<(), String> {
        self.0.create_bytes(path, bytes).await
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

/// RAII guard for a per-request image sandbox directory holding staged reference images.
struct ImageSandbox {
    path: AbsPath,
    files: Arc<dyn TextFiles>,
    state: Arc<std::sync::Mutex<SandboxState>>,
}

impl ImageSandbox {
    async fn create(path: AbsPath, files: Arc<dyn TextFiles>) -> Result<Self, AcpImageError> {
        let state = Arc::new(std::sync::Mutex::new(SandboxState::Creating { remove_after: false }));
        let sandbox = Self { path: path.clone(), files: files.clone(), state: state.clone() };
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task_path = path.clone();
        let task_files = files.clone();
        let task_state = state.clone();
        drop(mixdog_rt::spawn("acp.image.sandbox_create", mixdog_rt::TaskClass::Work, async move {
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
                crate::connection::remove_folder(task_files.as_ref(), task_path, IMAGE_SANDBOX_FOLDER).await;
            }
            let _ = tx.send(made);
        }));
        match rx.await {
            Ok(Ok(())) => Ok(sandbox),
            Ok(Err(error)) => Err(AcpImageError::failed(format!("could not create ACP image sandbox directory: {error}"))),
            Err(_) => Err(AcpImageError::failed("could not create ACP image sandbox directory")),
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
            crate::connection::remove_folder(self.files.as_ref(), self.path.clone(), IMAGE_SANDBOX_FOLDER).await;
        }
    }
}

impl Drop for ImageSandbox {
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
                drop(mixdog_rt::spawn("acp.image.sandbox_cleanup", mixdog_rt::TaskClass::Work, async move {
                    crate::connection::remove_folder(files.as_ref(), path, IMAGE_SANDBOX_FOLDER).await;
                }));
            } else {
                tracing::warn!(
                    "[acp] {IMAGE_SANDBOX_FOLDER} {} was not removed on drop (no async runtime); deferred to startup sweep",
                    path.as_path().display()
                );
            }
        }
    }
}

impl Agents {
    /// Clears away stale per-image sandbox directories left behind by earlier daemon runs or
    /// failed removals.
    pub(crate) async fn sweep_image_sandboxes(&self) {
        let Some(root) = AbsPath::new(self.parts.data_dir.join(IMAGE_SANDBOX_DIR)) else { return };
        let Ok(folders) = self.parts.files.folders(root.clone()).await else { return };
        for name in folders {
            let stale = match name.strip_prefix("pid-").and_then(|rest| rest.split('-').next()).and_then(|pid| pid.parse::<u32>().ok()) {
                Some(pid) => pid != std::process::id() && !mixdog_statefile::process_exists(pid),
                None => true,
            };
            if stale && let Some(folder) = AbsPath::new(root.as_path().join(&name)) {
                crate::connection::remove_folder(self.parts.files.as_ref(), folder, IMAGE_SANDBOX_FOLDER).await;
            }
        }
    }
}

/// Holds a running image-only session's registration in `Agents::sessions` and its `SessionUse`
/// guard so ACP disable (`release_all`), updater drains, and `SharedServer` retirement all see
/// active image runs accurately and clean up on drop.
struct RegisteredImageSession {
    agents: Arc<Agents>,
    thread_id: ThreadId,
    session: Arc<AgentSession>,
    use_guard: Option<crate::shared::SessionUse>,
    sandbox: ImageSandbox,
    home: Option<AbsPath>,
    sign_in_files: Vec<String>,
    brain_dir: Option<AbsPath>,
    brain_cleaned: bool,
    registered: bool,
}

impl RegisteredImageSession {
    fn register(
        agents: Arc<Agents>,
        preset: &AgentPreset,
        thread_id: ThreadId,
        opening: &crate::agents::Opening<'_>,
        owned: OwnedSession,
        sandbox: ImageSandbox,
    ) -> Result<Self, Box<(AcpImageError, ImageSandbox)>> {
        let (session, use_guard) = {
            let mut sessions = lock(&agents.sessions);
            if agents.stopping.load(Ordering::SeqCst) || agents.stop_token.is_cancelled() {
                drop(sessions);
                drop(owned);
                return Err(Box::new((AcpImageError::cancelled("canceled"), sandbox)));
            }
            if !agents.enabled() || !opening.current() {
                drop(sessions);
                drop(owned);
                return Err(Box::new((AcpImageError::not_installed("ACP agents are turned off in Settings."), sandbox)));
            }
            let (session, use_guard) = owned.into_parts();
            sessions.insert(thread_id.clone(), session.clone());
            (session, use_guard)
        };
        let home_path = agents.home(preset);
        let brain_dir = session_brain_dir(&home_path, &session.session_id);
        let home = AbsPath::new(home_path);
        let sign_in_files = match &preset.distribution {
            Distribution::Registry { sign_in_files, .. } => sign_in_files.clone(),
            Distribution::Cli { .. } => Vec::new(),
        };
        Ok(Self { agents, thread_id, session, use_guard, sandbox, home, sign_in_files, brain_dir, brain_cleaned: false, registered: true })
    }

    fn unregister(&mut self) {
        if self.registered {
            self.registered = false;
            lock(&self.agents.sessions).remove(&self.thread_id);
        }
    }
}

impl Drop for RegisteredImageSession {
    fn drop(&mut self) {
        self.use_guard.take();
        if self.registered {
            self.unregister();
            if !self.session.end_after_turn() {
                self.session.end();
            }
        }
        if !self.brain_cleaned
            && let (Some(home), Some(brain_dir)) = (self.home.take(), self.brain_dir.take())
            && tokio::runtime::Handle::try_current().is_ok()
        {
            let files = self.agents.parts.files.clone();
            let sign_in_files = std::mem::take(&mut self.sign_in_files);
            drop(mixdog_rt::spawn("acp.image.brain_cleanup", mixdog_rt::TaskClass::Work, async move {
                cleanup_generated_artifacts(files.as_ref(), &sign_in_files, Some(&home), Some(brain_dir), &[]).await;
            }));
        }
    }
}

enum ImageAvailability {
    Available,
    SignedOut,
    Unavailable(String),
}

/// ACP image-generation backend backed by [`Agents`].
pub struct AgentImageGen {
    agents: Arc<Agents>,
}

impl AgentImageGen {
    pub fn new(agents: Arc<Agents>) -> Arc<Self> {
        Arc::new(Self { agents })
    }

    async fn availability(&self, provider: &str) -> ImageAvailability {
        if !self.agents.enabled() {
            return ImageAvailability::Unavailable("ACP agents are turned off in Settings.".to_owned());
        }
        let Some(preset) = self.agents.preset_of_route(provider) else {
            return ImageAvailability::Unavailable(format!("No ACP preset is configured for provider \"{provider}\"."));
        };
        if let Err(err) = image_only_preset(preset) {
            return ImageAvailability::Unavailable(err.message);
        }
        let observed = self.agents.observed_state(preset);
        match observed.readiness {
            Some(Readiness::Ready { .. }) => ImageAvailability::Available,
            Some(Readiness::NotInstalled) => ImageAvailability::Unavailable(format!("{} is not installed. Install it in Settings.", preset.label)),
            Some(Readiness::Unsupported) => ImageAvailability::Unavailable(format!("{} does not run on this computer.", preset.label)),
            Some(Readiness::VersionTooOld { version }) => ImageAvailability::Unavailable(format!(
                "{} {version} is too old; {} or later is needed. Update it in Settings.",
                preset.label, preset.minimum_version
            )),
            Some(Readiness::VersionUnknown) => ImageAvailability::Unavailable(format!("{}'s version could not be read.", preset.label)),
            Some(Readiness::SignedOut { .. }) => ImageAvailability::SignedOut,
            Some(Readiness::Failed { .. }) | None | Some(Readiness::Checking) => self.registry_files_availability(preset).await,
        }
    }

    /// Reads already-known state and local sign-in/install files only: never starts a readiness
    /// check, updates the CLI, or spawns an ACP server.
    pub async fn authenticated(&self, provider: &str) -> bool {
        matches!(self.availability(provider).await, ImageAvailability::Available)
    }

    /// Plain-language cause when `authenticated` is false for a reason other than sign-in
    /// (ACP agents turned off, not installed, unsupported, or version too old). Reads known state
    /// and local files only; never starts a readiness check.
    pub async fn unavailable_reason(&self, provider: &str) -> Option<String> {
        match self.availability(provider).await {
            ImageAvailability::Unavailable(reason) => Some(reason),
            ImageAvailability::Available | ImageAvailability::SignedOut => None,
        }
    }

    /// Returns the live catalog rows for `provider` (currently one logical image model representing
    /// Antigravity's built-in `generate_image` tool), or an actionable diagnostic when the agent is
    /// disabled, signed out, refused, or failed to start.
    pub async fn catalog_models(&self, provider: &str) -> Result<Vec<Value>, AcpImageError> {
        if !self.agents.enabled() {
            return Err(AcpImageError::not_installed("ACP agents are turned off in Settings."));
        }
        let Some(preset) = self.agents.preset_of_route(provider) else {
            return Err(AcpImageError::failed(format!("no ACP preset is configured for provider \"{provider}\"")));
        };
        image_only_preset(preset)?;
        let observed = self.agents.observed_state(preset);
        if let Some(refusal) = observed.refused {
            return Err(AcpImageError::refusal(refusal));
        }
        match observed.readiness {
            Some(Readiness::Failed { message, .. }) => {
                let detail = message.trim();
                let msg = if detail.is_empty() { format!("{} did not start.", preset.label) } else { format!("{} did not start: {detail}", preset.label) };
                return Err(AcpImageError::failed(msg));
            }
            Some(Readiness::SignedOut { message, .. }) => {
                let msg = if message.trim().is_empty() { format!("{} is signed out. Sign in to it in Settings.", preset.label) } else { message };
                return Err(AcpImageError::sign_in(msg));
            }
            Some(Readiness::NotInstalled) => {
                return Err(AcpImageError::not_installed(format!("{} is not installed. Install it in Settings.", preset.label)));
            }
            Some(Readiness::Unsupported) => {
                return Err(AcpImageError::not_installed(format!("{} does not run on this computer.", preset.label)));
            }
            Some(Readiness::VersionTooOld { version }) => {
                return Err(AcpImageError::not_installed(format!(
                    "{} {version} is too old; {} or later is needed. Update it in Settings.",
                    preset.label, preset.minimum_version
                )));
            }
            Some(Readiness::VersionUnknown) => {
                return Err(AcpImageError::not_installed(format!("{}'s version could not be read.", preset.label)));
            }
            _ => {}
        }
        Ok(vec![json!({
            "id": IMAGE_MODEL_ID,
            "displayName": IMAGE_MODEL_LABEL,
            "description": "Antigravity's built-in image generator over ACP.",
            "imageGeneration": true,
        })])
    }

    async fn registry_files_availability(&self, preset: &AgentPreset) -> ImageAvailability {
        match &preset.distribution {
            Distribution::Registry { supported: false, .. } => ImageAvailability::Unavailable(format!("{} does not run on this computer.", preset.label)),
            Distribution::Registry { supported: true, .. } => {
                let Ok(Some(installed)) = self.agents.installed(preset).await else {
                    return ImageAvailability::Unavailable(format!("{} is not installed. Install it in Settings.", preset.label));
                };
                match Version::find(&installed.version) {
                    Some(found) if found >= preset.minimum_version => {
                        if self.agents.home_signed_in(preset).await {
                            ImageAvailability::Available
                        } else {
                            ImageAvailability::SignedOut
                        }
                    }
                    Some(_) => ImageAvailability::Unavailable(format!(
                        "{} {} is too old; {} or later is needed. Update it in Settings.",
                        preset.label, installed.version, preset.minimum_version
                    )),
                    None => ImageAvailability::Unavailable(format!("{}'s version could not be read.", preset.label)),
                }
            }
            Distribution::Cli { .. } => ImageAvailability::Unavailable(format!("{} is not installed. Install it in Settings.", preset.label)),
        }
    }

    async fn create_sandbox(&self) -> Result<ImageSandbox, AcpImageError> {
        let dir = self.agents.parts.data_dir.join(IMAGE_SANDBOX_DIR).join(format!("pid-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        let path = AbsPath::new(dir).ok_or_else(|| AcpImageError::failed("could not create an isolated sandbox directory for ACP image generation"))?;
        ImageSandbox::create(path, self.agents.parts.files.clone()).await
    }

    async fn stage_references(&self, sandbox: &ImageSandbox, references: &[AcpImageReference]) -> Result<Vec<StagedReference>, AcpImageError> {
        let mut staged = Vec::with_capacity(references.len());
        for (idx, reference) in references.iter().enumerate() {
            let ext = mime_extension(&reference.mime);
            let file_path = AbsPath::new(sandbox.path().as_path().join(format!("ref-{}.{ext}", idx + 1)))
                .ok_or_else(|| AcpImageError::failed("could not construct staged reference path"))?;
            self.agents
                .parts
                .files
                .create_bytes(file_path.clone(), reference.bytes.clone())
                .await
                .map_err(|err| AcpImageError::failed(format!("could not stage reference image: {err}")))?;
            let resolved = self.agents.parts.files.resolved(file_path.clone()).await.unwrap_or_else(|_| file_path.clone());
            staged.push(StagedReference { display: file_path, resolved });
        }
        Ok(staged)
    }

    async fn open_image_session(
        &self,
        preset: &AgentPreset,
        image_preset: &AgentPreset,
        sandbox: ImageSandbox,
        cancel: &CancellationToken,
    ) -> Result<RegisteredImageSession, Box<(AcpImageError, ImageSandbox)>> {
        if cancel.is_cancelled() {
            return Err(Box::new((AcpImageError::cancelled("canceled"), sandbox)));
        }
        let thread_id = ThreadId::from(format!("acp-image:{}", uuid::Uuid::new_v4().simple()));
        let opening = self.agents.begin_opening(thread_id.clone());
        let ready = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(Box::new((AcpImageError::cancelled("canceled"), sandbox))),
            ready = self.agents.ready_program(preset) => ready,
        };
        let (program, _starting) = match ready {
            Ok(ready) => ready,
            Err(refusal) => return Err(Box::new((refusal_to_error(preset, &refusal), sandbox))),
        };
        if !self.agents.enabled() || !opening.current() {
            return Err(Box::new((AcpImageError::not_installed("ACP agents are turned off in Settings."), sandbox)));
        }
        let cwd = sandbox.path().clone();
        let wake: crate::session::Wake = Arc::new(|| {});
        let no_read_files: Arc<dyn TextFiles> = Arc::new(ImageNoReadFiles(self.agents.parts.files.clone()));
        let open_session = async {
            match preset.scope {
                ProcessScope::PerSession => {
                    let open = Open {
                        preset: image_preset,
                        program: &program,
                        cwd,
                        definitions: &self.agents.parts.definitions,
                        stored: None,
                        rules: Some(IMAGE_ONLY_RULES.to_owned()),
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
                            preset: image_preset,
                            program: &program,
                            cwd: cwd.clone(),
                            definitions: &self.agents.parts.definitions,
                            stored: None,
                            rules: Some(IMAGE_ONLY_RULES.to_owned()),
                            held: None,
                            grants: Arc::default(),
                            handed: None,
                            temp: None,
                        };
                        // The deadline bounded the server's start; the open has the whole limit of its own.
                        let timeout = (attempt_deadline.is_some() || existing).then_some(SHARED_OPEN_TIMEOUT);
                        match AgentSession::open_on_shared_owned(lease, open, wake.clone(), Box::new(|| {}), timeout).await {
                            Ok(owned) => {
                                result = Ok(owned);
                                break;
                            }
                            Err(OpenSharedError::TimedOut) => {
                                tracing::warn!(
                                    "[acp.image] {}'s shared server did not open an image session within {:?}: {}",
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
            () = cancel.cancelled() => return Err(Box::new((AcpImageError::cancelled("canceled"), sandbox))),
            opened = open_session => opened,
        };
        let owned = match opened {
            Ok(owned) => owned,
            Err(fault) => {
                self.agents.open_failed(preset, &fault).await;
                return Err(Box::new((fault_to_error(preset, &fault), sandbox)));
            }
        };
        if let Some(Readiness::Ready { models, .. }) = lock(&self.agents.slots).get(&preset.id).and_then(|slot| slot.readiness.as_ref()) {
            owned.session().adopt_models(models);
        }
        let registered = RegisteredImageSession::register(self.agents.clone(), preset, thread_id, &opening, owned, sandbox)?;
        if registered.session.gone().is_cancelled() {
            let fault = registered.session.closed();
            self.cleanup_session(preset, registered, None, &[]).await;
            return Err(Box::new((fault_to_error(preset, &fault), self.empty_cleaned_sandbox())));
        }
        Ok(registered)
    }

    fn empty_cleaned_sandbox(&self) -> ImageSandbox {
        let path = AbsPath::new(self.agents.parts.data_dir.join(IMAGE_SANDBOX_DIR)).unwrap_or_else(|| AbsPath::new(std::env::temp_dir()).expect("abs temp"));
        ImageSandbox { path, files: self.agents.parts.files.clone(), state: Arc::new(std::sync::Mutex::new(SandboxState::Cleaned)) }
    }

    /// Ends the ephemeral image-only session through `SharedServer::detach` (`leaked = true`
    /// triggers retirement as soon as the server is quiescent), removes its sandbox directory,
    /// and deletes any generated image files/session brain folder written under the agent's home.
    async fn cleanup_session(&self, preset: &AgentPreset, mut registered: RegisteredImageSession, cancelled_prompt: Option<u64>, reported_paths: &[String]) {
        let session = registered.session.clone();
        // Before its use ends: a server that retires then reopens the sessions still registered.
        registered.unregister();
        if let Some(prompt_id) = cancelled_prompt {
            session.cancel(Some(prompt_id));
            if preset.scope == ProcessScope::Shared {
                self.agents.abandon_shared(preset, &session.session_id);
            }
        } else if session.closes && !session.gone().is_cancelled() && !self.agents.stop_token.is_cancelled() {
            let _ = mixdog_rt::time::timeout(CLOSE_TIMEOUT, session.close()).await;
        }
        registered.use_guard.take();
        session.end();
        registered.sandbox.cleanup().await;
        registered.brain_cleaned = true;
        let brain_dir = registered.brain_dir.take();
        let home = registered.home.take();
        cleanup_generated_artifacts(self.agents.parts.files.as_ref(), &registered.sign_in_files, home.as_ref(), brain_dir, reported_paths).await;
    }

    pub async fn generate(&self, request: AcpImageRequest, cancel: &CancellationToken) -> Result<AcpImageReply, AcpImageError> {
        if cancel.is_cancelled() {
            return Err(AcpImageError::cancelled("canceled"));
        }
        let Some(preset) = self.agents.preset_of_route(&request.provider) else {
            return Err(AcpImageError::failed(format!("no ACP preset is configured for provider \"{}\"", request.provider)));
        };
        if !self.agents.enabled() {
            return Err(AcpImageError::not_installed("ACP agents are turned off in Settings."));
        }
        let image_preset = image_only_preset(preset)?;
        let mut sandbox = self.create_sandbox().await?;
        let staged = match self.stage_references(&sandbox, &request.references).await {
            Ok(staged) => staged,
            Err(err) => {
                sandbox.cleanup().await;
                return Err(err);
            }
        };
        let registered = match self.open_image_session(preset, &image_preset, sandbox, cancel).await {
            Ok(registered) => registered,
            Err(unopened) => {
                let (err, mut sandbox) = *unopened;
                sandbox.cleanup().await;
                return Err(err);
            }
        };
        let session = registered.session.clone();

        // Prefer the lightest Flash orchestrator tier when advertised by the server so the
        // image-only turn spends minimal thinking tokens while still invoking `generate_image`.
        let models = session.models();
        if models.current.as_deref() != Some(PREFERRED_ORCHESTRATOR_MODEL) && models.available.iter().any(|m| m.id == PREFERRED_ORCHESTRATOR_MODEL) {
            let selected = tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    self.cleanup_session(preset, registered, None, &[]).await;
                    return Err(AcpImageError::cancelled("canceled"));
                }
                () = session.gone().cancelled() => {
                    let fault = session.closed();
                    self.cleanup_session(preset, registered, None, &[]).await;
                    return Err(fault_to_error(preset, &fault));
                }
                selected = session.select_model(PREFERRED_ORCHESTRATOR_MODEL) => selected,
            };
            if let Err(fault) = selected {
                tracing::debug!("[acp.image] optional select_model({PREFERRED_ORCHESTRATOR_MODEL}) ignored: {fault}");
            }
        }

        let current_model = session.models().current;
        let sandbox_root = registered.sandbox.path().clone();
        let outcome = run_image_turn(&session, &image_preset.quirks, &request, &staged, cancel).await;

        let allowed_read_roots = {
            let mut roots = vec![sandbox_root];
            if let Some(home) = AbsPath::new(self.agents.home(preset)) {
                roots.push(home);
            }
            roots
        };
        let extracted = extract_generated_image(&outcome, self.agents.parts.files.as_ref(), &allowed_read_roots, &request.prompt).await;
        let reported_paths = reported_image_paths(&outcome);

        self.cleanup_session(preset, registered, outcome.cancelled_prompt, &reported_paths).await;

        let usage = outcome.usage.clone();
        let served_model = current_model.clone();

        match outcome.end {
            TurnEnd::Completed { text, stop_reason, .. } => {
                if let Some(reason) = stop_reason.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
                    let lower = reason.to_ascii_lowercase();
                    if matches!(lower.as_str(), "cancelled" | "canceled" | "aborted") {
                        return Err(AcpImageError::cancelled("canceled").with_usage(usage));
                    }
                    if matches!(lower.as_str(), "refusal" | "refused" | "safety" | "content_filter") {
                        let msg = if !text.is_empty() { text } else { format!("Antigravity refused the image request ({reason}).") };
                        return Err(AcpImageError::refusal(msg).with_usage(usage));
                    }
                }
                match extracted {
                    ExtractedImage::Found { bytes, mime, revised_prompt } => {
                        self.agents.answered(preset).await;
                        let usage = with_generated_image_count(usage);
                        Ok(AcpImageReply { bytes, mime, revised_prompt, usage, served_model })
                    }
                    ExtractedImage::ToolFailed(reason) => {
                        let msg = if !reason.is_empty() {
                            format!("Antigravity image generation failed: {reason}")
                        } else if !text.is_empty() {
                            text
                        } else {
                            "Antigravity image generation failed.".to_owned()
                        };
                        Err(classify_plain_error(msg).with_usage(usage))
                    }
                    ExtractedImage::Missing => {
                        let msg = if !text.is_empty() {
                            text
                        } else if !outcome.refused_tools.is_empty() {
                            "Antigravity tried to run a disallowed tool instead of generating an image.".to_owned()
                        } else {
                            "Antigravity did not return a generated image.".to_owned()
                        };
                        Err(AcpImageError::refusal(msg).with_usage(usage))
                    }
                }
            }
            TurnEnd::Interrupted => Err(AcpImageError::cancelled("canceled").with_usage(usage)),
            TurnEnd::Refused { message } => {
                self.agents.refused(preset, &message).await;
                Err(AcpImageError::refusal(message).with_usage(usage))
            }
            TurnEnd::Failed { message, code, reported } => {
                if code == Some(AUTH_REQUIRED) {
                    self.agents.signed_out(preset, message.clone()).await;
                    return Err(AcpImageError::sign_in(format!("{} is signed out. Sign in to it in Settings → Providers.", preset.label)).with_usage(usage));
                }
                if reported {
                    let check = QuotaCheck { model: DEFAULT_MODEL, current: current_model.as_deref(), now_ms: now_ms(), stop: cancel };
                    let turn_error = self.agents.failure(preset, message.clone(), code, Value::Null, Some(check)).await;
                    let is_quota = turn_error.provider_error.as_ref().is_some_and(|detail| detail.kind == "quota_exhausted");
                    if is_quota || is_capacity_failure(&message, code) {
                        return Err(AcpImageError::capacity(plain_capacity_message(&message)).with_usage(usage));
                    }
                }
                if is_capacity_failure(&message, code) {
                    return Err(AcpImageError::capacity(plain_capacity_message(&message)).with_usage(usage));
                }
                Err(AcpImageError::failed(plain_error_message(&message)).with_usage(usage))
            }
        }
    }
}

/// Clones `preset` into an image-only preset: keeps every built-in tool disabled except
/// `generate_image`, disables client-side `fs/read_text_file`, clears eager MCP servers (no
/// Mixdog tools are handed over), and disables Mixdog tool-preference guidance.
///
/// Ordinary Antigravity sessions keep `"generate_image"` disabled in `preset.rs`.
pub(crate) fn image_only_preset(preset: &AgentPreset) -> Result<AgentPreset, AcpImageError> {
    if matches!(preset.own_tools_off, Some(OwnToolsOff::AgentFile(_))) {
        return Err(AcpImageError::not_installed(format!(
            "ACP provider \"{}\" cannot enforce image-only tool isolation without Mixdog tool handover",
            preset.provider
        )));
    }
    let Some(OwnToolsOff::SessionMeta(_)) = &preset.own_tools_off else {
        return Err(AcpImageError::not_installed(format!("ACP provider \"{}\" does not support isolated image generation", preset.provider)));
    };
    let mut image = preset.clone();
    image.quirks.append_tool_guidance = false;
    image.quirks.fs_read_text_file = false;
    image.quirks.replies_without_prompt = false;
    if let Some(OwnToolsOff::SessionMeta(meta)) = &mut image.own_tools_off {
        meta.disabled_tools.retain(|tool| !tool.eq_ignore_ascii_case("generate_image"));
        meta.eager_mcp_servers.clear();
    }
    Ok(image)
}

#[derive(Clone, Debug)]
struct StagedReference {
    display: AbsPath,
    resolved: AbsPath,
}

fn mime_extension(mime: &str) -> &'static str {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

fn image_prompt(request: &AcpImageRequest, staged: &[StagedReference], unsent_rules: Option<String>) -> String {
    let mut parts = Vec::new();
    if let Some(rules) = unsent_rules.filter(|text| !text.trim().is_empty()) {
        parts.push(rules);
    }
    let mut prompt = if staged.is_empty() {
        "Generate one image using your `generate_image` tool for the following request.".to_owned()
    } else {
        let mut text = "Edit or transform the provided reference image(s) using your `generate_image` tool for the following request.\n\nPass these exact local file paths in `ImagePaths`:".to_owned();
        for reference in staged {
            text.push('\n');
            text.push_str(&reference.display.as_path().to_string_lossy());
        }
        text
    };
    if let Some(aspect) = request.aspect_ratio.as_deref().map(str::trim).filter(|a| !a.is_empty() && !a.eq_ignore_ascii_case("auto")) {
        prompt.push_str(&format!("\n\nAspectRatio: {aspect}"));
    }
    prompt.push_str(&format!("\n\nPrompt:\n{}", request.prompt.trim()));
    prompt.push_str("\n\nCall `generate_image` once and do not call any other tool.");
    parts.push(prompt);
    parts.join("\n\n")
}

struct ImageTurnOutcome {
    end: TurnEnd,
    order: Vec<String>,
    tools: HashMap<String, AgentTool>,
    mcp_tools: HashSet<String>,
    refused_call_ids: HashSet<String>,
    refused_tools: Vec<String>,
    usage: Option<Value>,
    cancelled_prompt: Option<u64>,
}

enum ExtractedImage {
    Found { bytes: Vec<u8>, mime: String, revised_prompt: Option<String> },
    ToolFailed(String),
    Missing,
}

async fn extract_generated_image(outcome: &ImageTurnOutcome, files: &dyn TextFiles, allowed_roots: &[AbsPath], original_prompt: &str) -> ExtractedImage {
    let mut last_failure: Option<String> = None;
    for id in outcome.order.iter().rev() {
        if outcome.mcp_tools.contains(id) || outcome.refused_call_ids.contains(id) {
            continue;
        }
        let Some(tool) = outcome.tools.get(id) else { continue };
        if !tool.is_generate_image() {
            continue;
        }
        let status = tool.status.trim().to_ascii_lowercase();
        if matches!(status.as_str(), "failed" | "error" | "denied" | "refused") {
            if last_failure.is_none() {
                last_failure = Some(tool_failure_reason(tool));
            }
            continue;
        }
        for picture in tool.pictures() {
            if let Some((bytes, mime)) = decode_or_read_picture(picture, files, allowed_roots).await {
                let (used_prompt, _) = tool.picture_request();
                let trimmed = used_prompt.trim();
                let revised_prompt = (!trimmed.is_empty() && trimmed != original_prompt.trim()).then(|| trimmed.to_owned());
                return ExtractedImage::Found { bytes, mime, revised_prompt };
            }
        }
    }
    if let Some(reason) = last_failure { ExtractedImage::ToolFailed(reason) } else { ExtractedImage::Missing }
}

/// Collects every local file path reported by `generate_image` tool calls (`rawOutput.imagePath`,
/// image block `uri`, and `Picture::File` text paths) so they can be removed from the agent's
/// home brain directory once bytes are extracted or the turn ends.
fn reported_image_paths(outcome: &ImageTurnOutcome) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |raw: &str| {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_owned()) {
            paths.push(trimmed.to_owned());
        }
    };
    for id in &outcome.order {
        if outcome.mcp_tools.contains(id) || outcome.refused_call_ids.contains(id) {
            continue;
        }
        let Some(tool) = outcome.tools.get(id) else { continue };
        if !tool.is_generate_image() {
            continue;
        }
        if let Some(path) = tool.output.as_ref().and_then(|o| o.get("imagePath")).and_then(Value::as_str) {
            push(path);
        }
        for block in &tool.content {
            let inner = if block.get("type").and_then(Value::as_str) == Some("content") { block.get("content") } else { Some(block) };
            if let Some(uri) = inner.and_then(|b| b.get("uri")).and_then(Value::as_str) {
                push(uri);
            }
        }
        for picture in tool.pictures() {
            if let Picture::File(path) = picture {
                push(&path);
            }
        }
    }
    paths
}

fn session_brain_dir(home: &Path, session_id: &str) -> Option<AbsPath> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut components = Path::new(trimmed).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(_)), None) => AbsPath::new(home.join("antigravity-acp").join("brain").join(trimmed)),
        _ => None,
    }
}

/// Where the sign-in files `sign_in_files` of `home` are as the file system resolves them, one not there yet
/// included; `None` where one has no place to tell.
async fn sign_in_places(files: &dyn TextFiles, sign_in_files: &[String], home: &AbsPath) -> Option<Vec<PathBuf>> {
    let mut places = Vec::with_capacity(sign_in_files.len());
    for rel in sign_in_files {
        places.push(crate::files::resolved(files, AbsPath::new(home.as_path().join(rel))?).await?.0);
    }
    Some(places)
}

async fn remove_session_brain_dir(files: &dyn TextFiles, home: &AbsPath, sign_in: &[PathBuf], brain_dir: AbsPath) {
    let Ok(resolved_home) = files.resolved(home.clone()).await else { return };
    let Ok(resolved_brain) = files.resolved(brain_dir).await else { return };
    let brain = resolved_brain.as_path();
    // A brain folder reached through a link can be one that holds the sign-in.
    if brain.starts_with(resolved_home.as_path()) && brain != resolved_home.as_path() && !sign_in.iter().any(|place| place.starts_with(brain)) {
        crate::connection::remove_folder(files, resolved_brain, "the ACP image session brain folder").await;
    }
}

/// Removes the image files the session reported inside `home` and its brain folder, never a sign-in file of
/// `sign_in_files` nor a folder holding one; nothing is removed where a sign-in file's place cannot be told.
async fn cleanup_generated_artifacts(
    files: &dyn TextFiles,
    sign_in_files: &[String],
    home: Option<&AbsPath>,
    brain_dir: Option<AbsPath>,
    reported_paths: &[String],
) {
    let Some(home) = home else { return };
    let Some(sign_in) = sign_in_places(files, sign_in_files, home).await else { return };
    let protected: HashSet<String> = sign_in.iter().map(|place| normalize_comparable_path(&place.to_string_lossy())).collect();
    let roots = [home.clone()];
    for raw in reported_paths {
        let local = local_file_path(raw);
        let Some(place) = crate::files::inside_file(files, &roots, &local).await else { continue };
        if protected.contains(&normalize_comparable_path(&place.as_path().to_string_lossy())) {
            continue;
        }
        if let Err(err) = files.remove_file(place.clone()).await {
            tracing::warn!("[acp.image] could not remove generated image file {}: {err}", place.as_path().display());
        }
    }
    if let Some(brain_dir) = brain_dir {
        remove_session_brain_dir(files, home, &sign_in, brain_dir).await;
    }
}

fn tool_failure_reason(tool: &AgentTool) -> String {
    if let Some(output) = &tool.output {
        if let Some(text) = output.as_str().map(str::trim).filter(|t| !t.is_empty()) {
            return text.to_owned();
        }
        for key in ["error", "message", "reason", "details"] {
            if let Some(text) = output.get(key).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
                return text.to_owned();
            }
        }
    }
    tool.content
        .iter()
        .filter_map(|block| {
            let inner = if block.get("type").and_then(Value::as_str) == Some("content") { block.get("content")? } else { block };
            block_text(inner)
        })
        .map(|s| s.trim().to_owned())
        .find(|s| !s.is_empty())
        .unwrap_or_default()
}

async fn decode_or_read_picture(picture: Picture, files: &dyn TextFiles, allowed_roots: &[AbsPath]) -> Option<(Vec<u8>, String)> {
    match picture {
        Picture::Inline { data, mime } => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()?;
            (!bytes.is_empty() && bytes.len() as u64 <= PICTURE_MAX_BYTES).then_some((bytes, mime))
        }
        Picture::File(path) => {
            let path = local_file_path(&path);
            let extension = Path::new(&path).extension()?.to_str()?.to_ascii_lowercase();
            let mime = match extension.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "gif" => "image/gif",
                _ => return None,
            };
            let place = crate::files::inside_file(files, allowed_roots, &path).await?;
            let bytes = files.read_bytes(place, 0, PICTURE_MAX_BYTES + 1).await.ok()?;
            (!bytes.is_empty() && bytes.len() as u64 <= PICTURE_MAX_BYTES).then(|| (bytes, mime.to_owned()))
        }
    }
}

enum PendingImageRpc {
    Grant { id: Value, write_state: Arc<AtomicU8> },
    Refusal { done: tokio::sync::oneshot::Receiver<()> },
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
                drop(mixdog_rt::spawn("acp.image.reject_rpc", mixdog_rt::TaskClass::Work, async move {
                    if !write_session.connection.exited().is_cancelled() {
                        write_session.connection.respond(id, Err(not_offered(&method))).await;
                    }
                    let _ = done_tx.send(());
                }));
                refuse_budget.wait_write(session, done_rx, "image unsupported RPC refusal timed out on stalled stdin").await;
            }
        }
        Incoming::Tool(ask) => {
            ask.refuse("Mixdog tools are unavailable in image-generation-only sessions.");
        }
        _ => {}
    }
}

async fn drain_image_rpcs_and_detach(
    session: &Arc<AgentSession>,
    pending: Option<PendingImageRpc>,
    queue: VecDeque<Incoming>,
    mut stream: Option<tokio::sync::mpsc::UnboundedReceiver<Incoming>>,
    refuse_budget: &mut RefuseBudget,
    cancel_prompt: Option<u64>,
) {
    if let Some(pending) = pending {
        match pending {
            PendingImageRpc::Grant { id, write_state } => {
                abort_image_grant_write(session, refuse_budget, &write_state, id, "image permission grant write interrupted on teardown").await;
            }
            PendingImageRpc::Refusal { done } => {
                refuse_budget.wait_write(session, done, "image permission refusal write timed out on stalled stdin").await;
            }
            PendingImageRpc::Other { done } => {
                refuse_budget.wait_write(session, done, "image unsupported RPC refusal write timed out on stalled stdin").await;
            }
        }
    }
    for item in queue {
        refuse_incoming_item(session, item, refuse_budget).await;
    }
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

struct ImageTurnTeardownState {
    stream: Option<tokio::sync::mpsc::UnboundedReceiver<Incoming>>,
    queue: VecDeque<Incoming>,
    pending: Option<PendingImageRpc>,
    prompt_id: Option<u64>,
    refuse_budget: RefuseBudget,
}

struct ImageTurnGuard {
    session: Arc<AgentSession>,
    state: Option<ImageTurnTeardownState>,
    teardown_done: Option<tokio::sync::oneshot::Receiver<()>>,
}

impl ImageTurnGuard {
    fn new(session: Arc<AgentSession>, waiting: Vec<Incoming>, stream: tokio::sync::mpsc::UnboundedReceiver<Incoming>) -> Self {
        Self {
            session,
            state: Some(ImageTurnTeardownState {
                stream: Some(stream),
                queue: waiting.into(),
                pending: None,
                prompt_id: None,
                refuse_budget: RefuseBudget::new(),
            }),
            teardown_done: None,
        }
    }

    fn state_mut(&mut self) -> &mut ImageTurnTeardownState {
        self.state.as_mut().expect("image turn state held until teardown")
    }

    fn start_teardown(&mut self, cancel_prompt_on_drop: bool) {
        let Some(mut state) = self.state.take() else { return };
        if let Some(PendingImageRpc::Grant { write_state, .. }) = &state.pending
            && write_state.compare_exchange(GRANT_BEFORE_WRITE, GRANT_CANCELLED_BEFORE_WRITE, Ordering::SeqCst, Ordering::SeqCst).is_err()
            && write_state.compare_exchange(GRANT_WRITING, GRANT_DONE, Ordering::SeqCst, Ordering::SeqCst).is_ok()
        {
            self.session.break_connection("image permission grant write interrupted on teardown");
        }
        let session = self.session.clone();
        let pending = state.pending.take();
        let queue = std::mem::take(&mut state.queue);
        let stream = state.stream.take();
        let cancel_prompt = if cancel_prompt_on_drop { state.prompt_id.take() } else { None };
        let mut refuse_budget = state.refuse_budget;
        if tokio::runtime::Handle::try_current().is_ok() {
            let (done_tx, done_rx) = tokio::sync::oneshot::channel();
            drop(mixdog_rt::spawn("acp.image.turn_teardown", mixdog_rt::TaskClass::Work, async move {
                drain_image_rpcs_and_detach(&session, pending, queue, stream, &mut refuse_budget, cancel_prompt).await;
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

impl Drop for ImageTurnGuard {
    fn drop(&mut self) {
        self.start_teardown(true);
    }
}

async fn run_image_turn(
    session: &Arc<AgentSession>,
    quirks: &Quirks,
    request: &AcpImageRequest,
    staged: &[StagedReference],
    cancel: &CancellationToken,
) -> ImageTurnOutcome {
    let (waiting, stream) = session.attach(true);
    let mut guard = ImageTurnGuard::new(session.clone(), waiting, stream);
    let prompt_text = image_prompt(request, staged, session.take_unsent_prompt());
    let prompt_blocks = vec![json!({ "type": "text", "text": prompt_text })];

    let prompt_id = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            guard.teardown().await;
            return ImageTurnOutcome::empty(TurnEnd::Interrupted, None);
        }
        () = session.gone().cancelled() => {
            let fault = session.closed();
            guard.teardown().await;
            return ImageTurnOutcome::empty(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false }, None);
        }
        sent = session.prompt(prompt_blocks) => match sent {
            Ok(id) => id,
            Err(fault) => {
                guard.teardown().await;
                return ImageTurnOutcome::empty(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false }, None);
            }
        },
    };
    guard.state_mut().prompt_id = Some(prompt_id);

    let mut state = ImageTurnState::default();
    let mut cancelled_prompt = None;

    let ended: Result<Value, TurnEnd> = loop {
        let next = if let Some(item) = guard.state_mut().queue.pop_front() {
            Some(item)
        } else {
            let stream = guard.state_mut().stream.as_mut().expect("image turn stream held until teardown");
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
                state.handle_update(quirks, update);
            }
            Incoming::Request { id, method, params } if method == "session/request_permission" => {
                let (answer, is_grant) = decide_image_permission(&params, &mut state, staged);
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
                    guard.state_mut().pending = Some(PendingImageRpc::Grant { id: id.clone(), write_state: write_state.clone() });
                    let granted = send_image_permission_grant_with_state(session, id, answer, cancel, write_state).await;
                    if granted {
                        guard.state_mut().pending = None;
                    } else {
                        if session.gone().is_cancelled() && !cancel.is_cancelled() {
                            let fault = session.closed();
                            break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                        }
                        cancelled_prompt = Some(prompt_id);
                        break Err(TurnEnd::Interrupted);
                    }
                } else {
                    if guard.state_mut().refuse_budget.stalled() || guard.state_mut().refuse_budget.remaining().is_zero() {
                        guard.state_mut().refuse_budget.mark_stalled(session, "image permission refusal budget exhausted on stalled stdin");
                        let fault = session.closed();
                        break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                    }
                    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                    let write_session = session.clone();
                    drop(mixdog_rt::spawn("acp.image.refuse_write", mixdog_rt::TaskClass::Work, async move {
                        if !write_session.connection.exited().is_cancelled() {
                            write_session.connection.respond(id, Ok(answer)).await;
                        }
                        let _ = done_tx.send(());
                    }));
                    guard.state_mut().pending = Some(PendingImageRpc::Refusal { done: done_rx });
                    let limit = guard.state_mut().refuse_budget.remaining();
                    let started = tokio::time::Instant::now();
                    let done = match guard.state_mut().pending.as_mut() {
                        Some(PendingImageRpc::Refusal { done }) => done,
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
                                guard.state_mut().refuse_budget.mark_stalled(session, "image permission refusal write timed out on stalled stdin");
                                let fault = session.closed();
                                break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                            }
                        }
                    }
                }
            }
            Incoming::Request { id, method, .. } => {
                if guard.state_mut().refuse_budget.stalled() || guard.state_mut().refuse_budget.remaining().is_zero() {
                    guard.state_mut().refuse_budget.mark_stalled(session, "image unsupported RPC refusal budget exhausted on stalled stdin");
                    let fault = session.closed();
                    break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                }
                let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                let write_session = session.clone();
                drop(mixdog_rt::spawn("acp.image.reject_rpc", mixdog_rt::TaskClass::Work, async move {
                    if !write_session.connection.exited().is_cancelled() {
                        write_session.connection.respond(id, Err(not_offered(&method))).await;
                    }
                    let _ = done_tx.send(());
                }));
                guard.state_mut().pending = Some(PendingImageRpc::Other { done: done_rx });
                let limit = guard.state_mut().refuse_budget.remaining();
                let started = tokio::time::Instant::now();
                let done = match guard.state_mut().pending.as_mut() {
                    Some(PendingImageRpc::Other { done }) => done,
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
                            guard.state_mut().refuse_budget.mark_stalled(session, "image unsupported RPC refusal write timed out on stalled stdin");
                            let fault = session.closed();
                            break Err(TurnEnd::Failed { message: fault.to_string(), code: fault_code(&fault), reported: false });
                        }
                    }
                }
            }
            Incoming::Tool(ask) => {
                ask.refuse("Mixdog tools are unavailable in image-generation-only sessions.");
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

    match ended {
        Ok(answer) => {
            let usage = media_usage_of(&answer);
            if let Some(held) = state.held.take() {
                if usage.is_none()
                    && let Some(said) = quirks.failure_notice(&held)
                {
                    let end = classify_reported_failure(quirks, said, None, None);
                    return state.into_outcome(end, usage, cancelled_prompt);
                }
                state.answer.push_str(&held);
            }
            let final_text = state.answer.trim().to_owned();
            let tool_calls = state.order.len() as u64;
            if tool_calls == 0 && !final_text.is_empty() && quirks.account_refusals.iter().any(|marker| final_text.contains(marker.as_str())) {
                return state.into_outcome(TurnEnd::Refused { message: final_text }, usage, cancelled_prompt);
            }
            let stop_reason = answer.get("stopReason").and_then(Value::as_str).map(str::to_owned);
            state.into_outcome(TurnEnd::Completed { text: final_text, stop_reason, tool_calls }, usage, cancelled_prompt)
        }
        Err(end) => state.into_outcome(end, None, cancelled_prompt),
    }
}

impl ImageTurnOutcome {
    fn empty(end: TurnEnd, cancelled_prompt: Option<u64>) -> Self {
        Self {
            end,
            order: Vec::new(),
            tools: HashMap::new(),
            mcp_tools: HashSet::new(),
            refused_call_ids: HashSet::new(),
            refused_tools: Vec::new(),
            usage: None,
            cancelled_prompt,
        }
    }
}

#[derive(Default)]
struct ImageTurnState {
    answer: String,
    held: Option<String>,
    order: Vec<String>,
    tools: HashMap<String, AgentTool>,
    mcp_tools: HashSet<String>,
    refused_call_ids: HashSet<String>,
    refused_tools: Vec<String>,
}

impl ImageTurnState {
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

    fn handle_update(&mut self, quirks: &Quirks, update: &Value) {
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
        if matches!(kind, "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" | "plan") {
            self.flush_held();
        }
        match kind {
            "agent_message_chunk" => {
                if let Some(content) = update.get("content") {
                    if content.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(text) = content.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                            if quirks.failure_notice(text).is_some() {
                                self.held = Some(text.to_owned());
                            } else {
                                self.answer.push_str(text);
                            }
                        }
                    } else if let Some(text) = block_text(content) {
                        self.answer.push_str(&text);
                    }
                }
            }
            "tool_call" | "tool_call_update" => {
                self.merge_tool(update);
            }
            _ => {}
        }
    }

    fn into_outcome(self, end: TurnEnd, usage: Option<Value>, cancelled_prompt: Option<u64>) -> ImageTurnOutcome {
        ImageTurnOutcome {
            end,
            order: self.order,
            tools: self.tools,
            mcp_tools: self.mcp_tools,
            refused_call_ids: self.refused_call_ids,
            refused_tools: self.refused_tools,
            usage,
            cancelled_prompt,
        }
    }
}

/// Decides a `session/request_permission` payload in an image-only session.
///
/// Only Antigravity's built-in `generate_image` tool is auto-approved (preferring `allow_once`),
/// and ONLY when every path in `ImagePaths` matches a staged reference file from this request.
fn decide_image_permission(params: &Value, state: &mut ImageTurnState, staged: &[StagedReference]) -> (Value, bool) {
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
    if call_id.is_some() && !previously_refused && !is_mcp && is_allowed_generate_image(&merged, staged) {
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

fn has_disallowed_local_input(input: &Value) -> bool {
    let Some(obj) = input.as_object() else { return false };
    const EXTRA_LOCAL_KEYS: [&str; 10] = ["paths", "file", "filepath", "directory", "targetdirectory", "target_directory", "dir", "cwd", "pattern", "regex"];
    obj.keys().any(|key| {
        crate::rows::FILE_INPUT_KEYS.iter().any(|local| key.eq_ignore_ascii_case(local))
            || crate::rows::COMMAND_INPUT_KEYS.iter().any(|local| key.eq_ignore_ascii_case(local))
            || EXTRA_LOCAL_KEYS.iter().any(|local| key.eq_ignore_ascii_case(local))
    })
}

fn is_allowed_generate_image(tool: &AgentTool, staged: &[StagedReference]) -> bool {
    let name = tool.tool.trim().to_ascii_lowercase();
    if name.starts_with("mcp_") || name.starts_with("mcp__") {
        return false;
    }
    if !tool.kind.is_empty() && tool.kind != "other" {
        return false;
    }
    if !tool.is_generate_image() {
        return false;
    }
    if has_disallowed_local_input(&tool.input) {
        return false;
    }
    image_paths_allowed(&tool.input, staged)
}

fn normalize_comparable_path(raw: &str) -> String {
    let cleaned = local_file_path(raw.trim());
    let path = PathBuf::from(&cleaned);
    let mut normalized = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        normalized = normalized.replace('/', "\\");
        if let Some(stripped) = normalized.strip_prefix(r"\\?\") {
            normalized = stripped.to_owned();
        }
        normalized.make_ascii_lowercase();
    }
    normalized
}

fn image_paths_allowed(input: &Value, staged: &[StagedReference]) -> bool {
    let Some(obj) = input.as_object() else { return true };
    let allowed: HashSet<String> = staged
        .iter()
        .flat_map(|s| [normalize_comparable_path(&s.display.as_path().to_string_lossy()), normalize_comparable_path(&s.resolved.as_path().to_string_lossy())])
        .collect();
    for (key, value) in obj {
        if !matches!(key.to_ascii_lowercase().as_str(), "imagepaths" | "image_paths" | "imagepath" | "image_path") {
            continue;
        }
        if value.is_null() {
            continue;
        }
        let Some(entries) = value.as_array() else {
            return false;
        };
        if entries.is_empty() {
            continue;
        }
        if allowed.is_empty() {
            return false;
        }
        for entry in entries {
            let Some(path) = entry.as_str().map(str::trim).filter(|p| !p.is_empty()) else {
                return false;
            };
            if !allowed.contains(&normalize_comparable_path(path)) {
                return false;
            }
        }
    }
    true
}

const GRANT_BEFORE_WRITE: u8 = 0;
const GRANT_WRITING: u8 = 1;
const GRANT_DONE: u8 = 2;
const GRANT_CANCELLED_BEFORE_WRITE: u8 = 3;

struct ImageGrantCancelWaker {
    armed: AtomicBool,
    state: Arc<AtomicU8>,
    connection: Arc<crate::connection::Connection>,
    why: &'static str,
    skip_if_exited: bool,
}

impl std::task::Wake for ImageGrantCancelWaker {
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

struct SyncImageGrantCancelHook {
    waker_state: Arc<ImageGrantCancelWaker>,
    _waiter: std::pin::Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>>,
}

impl SyncImageGrantCancelHook {
    fn arm(token: &CancellationToken, state: Arc<AtomicU8>, connection: Arc<crate::connection::Connection>, why: &'static str, skip_if_exited: bool) -> Self {
        let waker_state = Arc::new(ImageGrantCancelWaker { armed: AtomicBool::new(true), state, connection, why, skip_if_exited });
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

impl Drop for SyncImageGrantCancelHook {
    fn drop(&mut self) {
        self.disarm();
    }
}

async fn abort_image_grant_write(session: &Arc<AgentSession>, refuse_budget: &mut RefuseBudget, write_state: &AtomicU8, id: Value, why: &str) {
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

async fn send_image_permission_grant_with_state(
    session: &Arc<AgentSession>,
    id: Value,
    answer: Value,
    cancel: &CancellationToken,
    write_state: Arc<AtomicU8>,
) -> bool {
    let cancel_hook =
        SyncImageGrantCancelHook::arm(cancel, write_state.clone(), session.connection.clone(), "image permission grant write stalled past turn stop", false);
    let gone_hook = SyncImageGrantCancelHook::arm(
        session.gone(),
        write_state.clone(),
        session.connection.clone(),
        "image permission grant write stalled on ended session",
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

/// Normalizes ACP `session/prompt` response `usage` into Mixdog's media usage shape
/// (`{ inputTokens, outputTokens, cachedTokens }`).
fn media_usage_of(answer: &Value) -> Option<Value> {
    let usage = answer.get("usage").and_then(Value::as_object)?;
    let mut out = Map::new();
    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let input = count("inputTokens");
    let cached = count("cachedReadTokens");
    let output = count("outputTokens").saturating_add(count("thoughtTokens"));
    if input > 0 {
        out.insert("inputTokens".into(), json!(input));
    }
    if cached > 0 {
        out.insert("cachedTokens".into(), json!(cached));
    }
    if output > 0 {
        out.insert("outputTokens".into(), json!(output));
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

fn with_generated_image_count(usage: Option<Value>) -> Option<Value> {
    let mut map = match usage {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    map.insert("images".into(), json!(1));
    Some(Value::Object(map))
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
        || lower.contains("quota exhausted")
        || lower.contains("capacity")
        || lower.contains("(code 429)")
        || lower.contains("status 429")
        || lower.contains("http 429")
}

fn is_policy_refusal(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("safety")
        || lower.contains("policy")
        || lower.contains("prohibited")
        || lower.contains("content filter")
        || lower.contains("content_filter")
        || lower.contains("cannot generate")
        || lower.contains("can't generate")
        || lower.contains("unable to generate")
        || lower.contains("blocked")
}

fn classify_plain_error(message: String) -> AcpImageError {
    if is_capacity_failure(&message, None) {
        AcpImageError::capacity(plain_capacity_message(&message))
    } else if is_policy_refusal(&message) {
        AcpImageError::refusal(message)
    } else {
        AcpImageError::failed(message)
    }
}

fn plain_capacity_message(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "Antigravity image generation is temporarily rate-limited or out of quota. Try again later.".to_owned()
    } else if trimmed.to_ascii_lowercase().starts_with("antigravity") {
        trimmed.to_owned()
    } else {
        format!("Antigravity image generation quota or capacity limit reached: {trimmed}")
    }
}

fn plain_error_message(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() { "Antigravity image generation failed.".to_owned() } else { trimmed.to_owned() }
}

fn fault_code(fault: &Fault) -> Option<i64> {
    match fault {
        Fault::Rpc(error) => Some(error.code),
        _ => None,
    }
}

fn fault_to_error(preset: &AgentPreset, fault: &Fault) -> AcpImageError {
    match fault {
        Fault::NotFound => AcpImageError::not_installed(format!("{} is not installed: `{}` was not found.", preset.label, preset.command)),
        Fault::Rpc(error) if error.code == AUTH_REQUIRED => {
            AcpImageError::sign_in(format!("{} is signed out. Sign in to it in Settings → Providers.", preset.label))
        }
        Fault::Rpc(error) if preset.quirks.signed_out_failures.iter().any(|m| error.message.contains(m.as_str())) => {
            AcpImageError::sign_in(format!("{} is signed out. Sign in to it in Settings → Providers.", preset.label))
        }
        Fault::Rpc(error) if is_capacity_failure(&error.message, Some(error.code)) => AcpImageError::capacity(plain_capacity_message(&error.message)),
        Fault::Rpc(error) => AcpImageError::failed(plain_error_message(&error.message)),
        other => AcpImageError::failed(format!("{}: {other}", preset.label)),
    }
}

fn refusal_to_error(preset: &AgentPreset, refusal: &Refusal) -> AcpImageError {
    let message = refusal.message(preset);
    match refusal {
        Refusal::Off | Refusal::NotReady(Readiness::NotInstalled | Readiness::Unsupported | Readiness::VersionTooOld { .. } | Readiness::VersionUnknown) => {
            AcpImageError::not_installed(message)
        }
        Refusal::NotReady(Readiness::SignedOut { .. }) => AcpImageError::sign_in(message),
        Refusal::Fault(Fault::Rpc(error)) if error.code == AUTH_REQUIRED => AcpImageError::sign_in(message),
        Refusal::NotReady(Readiness::Failed { message: detail, .. })
            if preset.quirks.account_refusals.iter().any(|marker| detail.contains(marker.as_str())) =>
        {
            AcpImageError::refusal(detail.clone())
        }
        Refusal::Fault(fault) => fault_to_error(preset, fault),
        Refusal::NotReady(_) | Refusal::Closed => AcpImageError::failed(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_only_preset_enables_only_generate_image_and_leaves_ordinary_preset_unchanged() {
        let presets = crate::preset::builtin();
        let official = presets.iter().find(|p| p.id == "antigravity").expect("antigravity preset");
        let Some(OwnToolsOff::SessionMeta(ordinary_meta)) = &official.own_tools_off else {
            panic!("expected SessionMeta on official antigravity preset");
        };
        assert!(ordinary_meta.disabled_tools.iter().any(|t| t == "generate_image"), "ordinary sessions must keep generate_image disabled");

        let image = image_only_preset(official).expect("official antigravity supports image-only isolation");
        let Some(OwnToolsOff::SessionMeta(image_meta)) = &image.own_tools_off else {
            panic!("expected SessionMeta on image-only preset");
        };
        assert!(!image_meta.disabled_tools.iter().any(|t| t == "generate_image"), "generate_image must be enabled");
        assert!(image_meta.disabled_tools.iter().any(|t| t == "search_web"), "search_web must stay disabled");
        assert!(image_meta.disabled_tools.iter().any(|t| t == "run_command"), "run_command must stay disabled");
        assert!(image_meta.disabled_tools.iter().any(|t| t == "view_file"), "view_file must stay disabled");
        assert_eq!(image_meta.disabled_tools.len() + 1, ordinary_meta.disabled_tools.len());
        assert!(image_meta.eager_mcp_servers.is_empty(), "no MCP servers handed over");
        assert!(!image.quirks.fs_read_text_file);
        assert!(!image.quirks.append_tool_guidance);
        assert!(!image.quirks.replies_without_prompt);

        let cli = presets.iter().find(|p| p.id == "antigravity-cli").expect("antigravity-cli preset");
        assert!(image_only_preset(cli).is_err(), "AgentFile presets must fail closed for image-only isolation");
    }

    #[test]
    fn image_paths_gate_blocks_out_of_sandbox_and_allows_staged_paths() {
        let dir = tempfile::tempdir().unwrap();
        let staged_file = AbsPath::new(dir.path().join("ref-1.png")).unwrap();
        let staged = vec![StagedReference { display: staged_file.clone(), resolved: staged_file.clone() }];

        let allowed_str = staged_file.as_path().to_string_lossy().into_owned();
        let outside_str = dir.path().join("secret.png").to_string_lossy().into_owned();

        // Generate (no staged refs): absent/empty ImagePaths allowed, any path rejected.
        assert!(image_paths_allowed(&json!({ "Prompt": "a fox" }), &[]));
        assert!(image_paths_allowed(&json!({ "Prompt": "a fox", "ImagePaths": [] }), &[]));
        assert!(!image_paths_allowed(&json!({ "Prompt": "a fox", "ImagePaths": [allowed_str.clone()] }), &[]));

        // Edit (staged ref): exact staged path allowed, outside path or non-array rejected.
        assert!(image_paths_allowed(&json!({ "Prompt": "edit", "ImagePaths": [allowed_str.clone()] }), &staged));
        assert!(!image_paths_allowed(&json!({ "Prompt": "edit", "ImagePaths": [outside_str] }), &staged));
        assert!(!image_paths_allowed(&json!({ "Prompt": "edit", "ImagePaths": [allowed_str, "/etc/passwd"] }), &staged));
        assert!(!image_paths_allowed(&json!({ "Prompt": "edit", "ImagePaths": "not-an-array" }), &staged));
    }

    /// A session's brain folder reached through a link to the folder that holds the sign-in is never removed; one of
    /// its own is.
    #[tokio::test]
    async fn brain_cleanup_never_removes_a_folder_that_holds_the_sign_in() {
        struct Linked {
            places: HashMap<PathBuf, PathBuf>,
            removed: std::sync::Mutex<Vec<PathBuf>>,
        }

        #[async_trait]
        impl TextFiles for Linked {
            async fn read(&self, _: AbsPath) -> Result<String, String> {
                Err("not read here".to_owned())
            }
            async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
                self.places.get(path.as_path()).cloned().and_then(AbsPath::new).ok_or_else(|| "NotFound".to_owned())
            }
            async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
                Err("not written here".to_owned())
            }
            async fn remove_folder(&self, path: AbsPath) -> Result<(), String> {
                self.removed.lock().unwrap().push(path.as_path().to_path_buf());
                Ok(())
            }
        }

        let home = std::env::temp_dir().join("mixdog-acp-image-home");
        let agent = home.join("antigravity-acp");
        let brain = agent.join("brain").join("sess-1");
        let sign_in_files = vec!["antigravity-acp/settings.json".to_owned(), "antigravity-acp/acp_token.json".to_owned()];
        let removed_with = |brain_place: PathBuf| {
            let (home, agent, brain, sign_in_files) = (home.clone(), agent.clone(), brain.clone(), sign_in_files.clone());
            async move {
                let mut places: HashMap<PathBuf, PathBuf> = [home.clone(), agent.clone(), agent.join("settings.json"), agent.join("acp_token.json")]
                    .into_iter()
                    .map(|path| (path.clone(), path))
                    .collect();
                places.insert(brain.clone(), brain_place);
                let files = Linked { places, removed: std::sync::Mutex::default() };
                cleanup_generated_artifacts(&files, &sign_in_files, AbsPath::new(&home).as_ref(), AbsPath::new(&brain), &[]).await;
                files.removed.into_inner().unwrap()
            }
        };

        assert_eq!(removed_with(agent.clone()).await, Vec::<PathBuf>::new(), "a brain folder linked to the sign-in's folder is kept");
        assert_eq!(removed_with(brain.clone()).await, vec![brain.clone()], "a brain folder of its own is removed");
    }

    #[test]
    fn media_usage_normalizes_acp_prompt_usage() {
        let answer = json!({
            "stopReason": "end_turn",
            "usage": { "inputTokens": 7580, "outputTokens": 173, "thoughtTokens": 109, "cachedReadTokens": 2027 }
        });
        let usage = media_usage_of(&answer).expect("normalized usage");
        assert_eq!(usage, json!({ "inputTokens": 7580, "cachedTokens": 2027, "outputTokens": 282 }));
        assert_eq!(with_generated_image_count(Some(usage)), Some(json!({ "inputTokens": 7580, "cachedTokens": 2027, "outputTokens": 282, "images": 1 })));
    }
}
