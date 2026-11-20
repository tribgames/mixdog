//! What the slash dispatch, the prompt submit and the Tab workflow cycle call back into: [`SlashHost`], the application's side
//! of them. The Node code received these as an injected `deps` bag, React state setters and refs; here they are the methods
//! of one trait over [`AppCtx`], so the pickers of wave 6 plug in by [`Opener`] name and a test drives the same functions with
//! a recording fake.
//!
//! Store calls are [`AppCtx::store_call`]: `Ok(value)` is what the awaited call resolved to (`Value::Null` for `undefined`,
//! and for a method the store does not have when the Node code called it with `?.`), `Err(text)` is a rejection. The calls
//! are made one after another: a host that serves them off the UI thread runs the function from the task that owns the
//! result, and the epoch and write-token guards of [`super::submit::panel_write`] are what keep a late result from closing a
//! surface it no longer owns.

use std::collections::{BTreeMap, BTreeSet};

use mixdog_term::paste::{PastedImage, PromptContent};
use serde_json::{Map, Value};

use crate::app::AppCtx;
use crate::surface::SurfaceClaim;

/// The tone of a notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Info,
    Warn,
    Error,
}

impl Tone {
    /// The tone name the store's `pushNotice` takes.
    pub fn as_str(self) -> &'static str {
        match self {
            Tone::Info => "info",
            Tone::Warn => "warn",
            Tone::Error => "error",
        }
    }
}

/// The part of the application state the commands read (`state.busy`, `state.commandBusy`, `state.provider`, `state.model`,
/// `state.workflow`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SlashState {
    /// A turn is running.
    pub busy: bool,
    /// A session command is running.
    pub command_busy: bool,
    pub provider: String,
    pub model: String,
    /// The active workflow (`{ id, name }`), or `Null`.
    pub workflow: Value,
}

/// A picker, panel or other surface a command opens by name (`deps.open*Picker`). The picker itself is the host's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Opener {
    Model,
    WebSearch,
    Agents,
    Workflow,
    OutputStyle,
    Theme,
    Effort,
    Project,
    Mcp,
    McpServers,
    Skills,
    ProjectSkills,
    Plugins,
    ProviderSetup,
    MemoryCore,
    Settings,
    AutoClear,
    Resume,
    Usage,
    Context,
    Profile,
    Update,
    Developer,
}

impl Opener {
    /// The name the opener goes by in recordings.
    pub fn as_str(self) -> &'static str {
        match self {
            Opener::Model => "model",
            Opener::WebSearch => "websearch",
            Opener::Agents => "agents",
            Opener::Workflow => "workflow",
            Opener::OutputStyle => "outputstyle",
            Opener::Theme => "theme",
            Opener::Effort => "effort",
            Opener::Project => "project",
            Opener::Mcp => "mcp",
            Opener::McpServers => "mcp-servers",
            Opener::Skills => "skills",
            Opener::ProjectSkills => "project-skills",
            Opener::Plugins => "plugins",
            Opener::ProviderSetup => "providers",
            Opener::MemoryCore => "memory",
            Opener::Settings => "settings",
            Opener::AutoClear => "autoclear",
            Opener::Resume => "resume",
            Opener::Usage => "usage",
            Opener::Context => "context",
            Opener::Profile => "profile",
            Opener::Update => "update",
            Opener::Developer => "developer",
        }
    }
}

/// The two text-entry surfaces a prompt can occupy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptSurface {
    Provider,
    Settings,
}

/// A provider or settings text-entry prompt (`providerPrompt` / `settingsPrompt`): its `kind` and the fields its handler
/// reads (`providerId`, `authMode`, `provider`, `projectPath`, `pendingPath`, `skillName`, `_id`, `_indexRevision`,
/// `_projectId`, `_singleSentence`, ...). The callbacks the Node object carried (`afterSave`, `successReturn`,
/// `failureReturn`, `login.completeCode`, `returnTo`) stay with the host, which finds them from the prompt it holds.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextPrompt {
    pub kind: String,
    pub label: String,
    pub hint: String,
    pub fields: Map<String, Value>,
    pub submitting: bool,
    /// The value an editor remounts with after a rejected write.
    pub initial_value: Option<String>,
    pub restore_epoch: u64,
}

impl TextPrompt {
    /// A prompt of `kind` with no fields.
    pub fn new(kind: &str) -> Self {
        Self { kind: kind.to_owned(), ..Self::default() }
    }

    /// The text field `key`, empty when absent.
    pub fn text(&self, key: &str) -> String {
        match self.fields.get(key) {
            Some(Value::Null) | None => String::new(),
            Some(Value::String(text)) => text.clone(),
            Some(other) => mixdog_js::value_to_string(other),
        }
    }
}

/// What a submitted prompt carries besides its content (`submitPrompt(content, options)`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SubmitOptions {
    /// The text as typed when pasted tokens were expanded into the content.
    pub display_text: Option<String>,
    /// The restore metadata of the referenced pasted images: everything but the bytes, with `sizeBytes`.
    pub pasted_images: BTreeMap<u64, ImageRestoreMeta>,
    pub pasted_texts: BTreeMap<u64, String>,
    /// The ids to clear from the paste holders once the prompt is durably taken (`onCommitted`); `None` when nothing was
    /// referenced.
    pub on_committed: Option<CommittedClear>,
}

/// The pasted snapshots cleared when a prompt commits.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommittedClear {
    pub images: BTreeSet<u64>,
    pub texts: BTreeSet<u64>,
}

/// A pasted image without its bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageRestoreMeta {
    pub id: u64,
    pub media_type: Option<String>,
    pub metadata_text: Option<String>,
    pub size_bytes: u64,
}

/// The application's side of the slash dispatch and the prompt submit.
pub trait SlashHost: AppCtx {
    /// The state the commands read.
    fn state(&self) -> SlashState;
    /// `store.pushNotice(text, tone)`.
    fn push_notice(&mut self, text: &str, tone: Tone);
    /// `store.pushNotice(text, tone, { ttlMs })`.
    fn push_notice_ttl(&mut self, text: &str, tone: Tone, ttl_ms: u64);
    /// `Date.now()`.
    fn now_ms(&self) -> u64;
    /// Whether the store has the method `name` (`typeof store[name] === 'function'`).
    fn has_store_method(&self, name: &str) -> bool;

    /// `surface.claim().context(null)`: the context panel closes.
    fn clear_context_panel(&mut self);
    /// `closeUsagePanel()`.
    fn close_usage_panel(&mut self);
    /// Claims the surface and paints the loading frame of `command` (`Loading <title>...`, `Esc Close`); `None` when the
    /// paint was refused.
    fn paint_loading_frame(&mut self, command: &str, title: &str) -> Option<SurfaceClaim>;
    /// Whether `claim` still owns the surface.
    fn owns_surface(&self, claim: SurfaceClaim) -> bool;
    /// Closes the surface `claim` owns.
    fn close_surface(&mut self, claim: SurfaceClaim);
    /// Paints the `/stop` confirmation under `claim`: items `cancel` and `stop` ([`super::STOP_CANCEL`],
    /// [`super::STOP_CONFIRM`]), the shell commands as its footer. The host answers with
    /// [`super::stop_prompt_select`] or [`super::stop_prompt_cancel`].
    fn paint_stop_confirm(&mut self, claim: SurfaceClaim, title: &str, commands: &[String]);
    /// Opens the picker or panel `opener` with `options` (`{}` for none); an `Err` is reported by the caller.
    fn open(&mut self, opener: Opener, options: Value) -> Result<(), String>;
    /// Opens the auto-clear picker the way a prompt asks (`openAutoClearPicker({ advanced, returnTo })`), `returnTo` being
    /// the one `target` carries.
    fn open_with_return(&mut self, opener: Opener, options: Value, target: &TextPrompt) -> Result<(), String>;
    /// `registerProject(path)`.
    fn register_project(&mut self, path: &str) -> Result<(), String>;
    /// `enterProject(target)`.
    fn enter_project(&mut self, target: &str);
    /// `loginMcpServer(name)`.
    fn login_mcp_server(&mut self, name: &str);
    /// `logoutMcpServer(name)`.
    fn logout_mcp_server(&mut self, name: &str);
    /// `btw.ask(question)`.
    fn btw_ask(&mut self, question: &str);
    /// `runDoctor({ notice: true })`.
    fn run_doctor(&mut self) -> Result<(), String>;
    /// `requestExit()`.
    fn request_exit(&mut self);
    /// `store.forceRenderRepaint?.()`.
    fn force_render_repaint(&mut self);

    /// `supersedePanelEpoch()`: a new panel owns the surface; answers the new epoch.
    fn supersede_panel_epoch(&mut self) -> u64;
    /// `isPanelEpochCurrent(token)`.
    fn is_panel_epoch_current(&self, token: u64) -> bool;
    /// The epoch of the write in flight on `surface` (0 for none).
    fn write_token(&self, surface: PromptSurface) -> u64;
    /// Records the write in flight on `surface`.
    fn set_write_token(&mut self, surface: PromptSurface, token: u64);

    /// The provider text-entry prompt on screen.
    fn provider_prompt(&self) -> Option<TextPrompt>;
    /// The settings text-entry prompt on screen.
    fn settings_prompt(&self) -> Option<TextPrompt>;
    /// `setProviderPrompt(next)` / `setSettingsPrompt(next)` with a prompt or `null`.
    fn set_prompt(&mut self, surface: PromptSurface, next: Option<TextPrompt>);
    /// `setPrompt((prompt) => prompt === target ? { ...prompt, submitting: true } : prompt)`.
    fn mark_prompt_submitting(&mut self, surface: PromptSurface, target: &TextPrompt);
    /// `oauthSubmitRef.current`.
    fn oauth_submitting(&self) -> bool;
    fn set_oauth_submitting(&mut self, value: bool);
    /// `target.login.completeCode(code)`; `Err` when the login is no longer active or the completion fails.
    fn oauth_complete_code(&mut self, target: &TextPrompt, code: &str) -> Result<(), String>;
    /// `target.successReturn?.()`: whether the prompt had one.
    fn oauth_success_return(&mut self, target: &TextPrompt) -> bool;
    /// `target.failureReturn?.(error)`.
    fn oauth_failure_return(&mut self, target: &TextPrompt, error: &str);
    /// `target.afterSave?.()`: whether the prompt had one.
    fn provider_after_save(&mut self, target: &TextPrompt) -> bool;
    /// `clearModelCaches(scope)`.
    fn clear_model_caches(&mut self, scope: &str);

    /// The pasted images the prompt holds, by id.
    fn pasted_images(&self) -> BTreeMap<u64, PastedImage>;
    /// The folded pasted texts the prompt holds, by id.
    fn pasted_texts(&self) -> BTreeMap<u64, String>;
    /// `clearPastedImagesSnapshot(snapshot)`: the images with these ids, or every image for `None`.
    fn clear_pasted_images(&mut self, ids: Option<&BTreeSet<u64>>);
    /// `clearPastedTextsSnapshot(snapshot)`.
    fn clear_pasted_texts(&mut self, ids: Option<&BTreeSet<u64>>);
    /// `armTranscriptFollow()`.
    fn arm_transcript_follow(&mut self);
    /// `store.submitAsync(content, options)` or `store.submit(content, options)` (`method`); the result value. `options` is
    /// `None` where the Node code passed none (`submitPrompt(prompt)`).
    fn store_submit(&mut self, method: &str, content: &PromptContent, options: Option<&SubmitOptions>) -> Result<Value, String>;
}
