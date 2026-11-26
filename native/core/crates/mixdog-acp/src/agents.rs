//! The built-in feature's one object: the presets, whether each agent's CLI is ready, and the
//! agent of every session that runs on one. Everything here is behind the feature's switch.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use mixdog_ai::accounts::Account;
use mixdog_ai::accounts::Usage;
use mixdog_ai::accounts::Window;
use mixdog_ai::accounts::policy;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_session::session::failure_record::auth_turn_error;
use mixdog_core_session::session::failure_record::quota_turn_error;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnError;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::connection::Fault;
use crate::files::TextFiles;
use crate::preset::AgentPreset;
use crate::preset::ProcessScope;
use crate::session::AgentSession;
use crate::session::Models;
use crate::session::Open;
use crate::upkeep::Plan;
use crate::upkeep::Slot;

/// The agent's answer to a request it refuses until the user has signed in.
pub(crate) const AUTH_REQUIRED: i64 = -32000;

/// The model id of the agent's own default model, which a route or a call that names no model runs on.
pub const DEFAULT_MODEL: &str = "default";

/// How long a new turn waits for an agent to close a previously cancelled prompt before dropping the stuck session.
const CANCEL_CLOSE_GRACE: Duration = Duration::from_secs(2);

/// How long opening or reopening a session on an already-running shared server may wait before retiring that server
/// as wedged and starting a fresh one.
const SHARED_OPEN_TIMEOUT: Duration = Duration::from_secs(10);

/// What happened to the account an agent's CLI is signed in with, as the core is told of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountEvent {
    /// The account was signed out of, or the feature turned off: nothing read of it stands.
    Left,
    /// A sign-in settled: what was read stands no longer, and the quota is to be read again now.
    SignedIn,
    /// A check found the CLI ready: its quota can be asked now.
    Askable,
}

/// Told (preset id, what happened) of an agent's account.
pub type AccountTold = dyn Fn(&str, AccountEvent) + Send + Sync;

/// Whether an agent's CLI can run a session, each state one the Settings row words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Readiness {
    /// Not looked at yet, or being looked at: what an asker is told that does not wait for the check.
    Checking,
    NotInstalled,
    /// The agent's build does not run on this system, and nothing stands in for it.
    Unsupported,
    /// The CLI ran but printed no version.
    VersionUnknown,
    VersionTooOld {
        version: String,
    },
    SignedOut {
        version: String,
        message: String,
    },
    /// The CLI is there and current, and its ACP mode did not start.
    Failed {
        version: Option<String>,
        message: String,
    },
    Ready {
        version: String,
        models: Models,
    },
}

impl Readiness {
    pub fn state(&self) -> &'static str {
        match self {
            Self::Checking => "checking",
            Self::NotInstalled => "notInstalled",
            Self::Unsupported => "unsupported",
            Self::VersionUnknown => "versionUnknown",
            Self::VersionTooOld { .. } => "versionTooOld",
            Self::SignedOut { .. } => "signedOut",
            Self::Failed { .. } => "failed",
            Self::Ready { .. } => "ready",
        }
    }

    fn version(&self) -> Option<&str> {
        match self {
            Self::VersionTooOld { version } | Self::SignedOut { version, .. } | Self::Ready { version, .. } => Some(version),
            Self::Failed { version, .. } => version.as_deref(),
            _ => None,
        }
    }

    fn message(&self) -> Option<&str> {
        match self {
            Self::SignedOut { message, .. } | Self::Failed { message, .. } => Some(message),
            _ => None,
        }
    }
}

/// Why a session has no agent.
#[derive(Clone, Debug, PartialEq)]
pub enum Refusal {
    /// The feature is off.
    Off,
    NotReady(Readiness),
    Fault(Fault),
    /// The session was closed, deleted or unloaded while its agent started.
    Closed,
}

impl Refusal {
    pub fn message(&self, preset: &AgentPreset) -> String {
        let label = &preset.label;
        match self {
            Self::Off => "ACP agents are turned off in Settings.".to_owned(),
            Self::NotReady(Readiness::NotInstalled) => format!("{label} is not installed: `{}` was not found. Install it in Settings.", preset.command),
            Self::NotReady(Readiness::VersionTooOld { version }) => {
                format!("{label} {version} is too old; {} or later is needed. Update it in Settings.", preset.minimum_version)
            }
            Self::NotReady(Readiness::SignedOut { .. }) => format!("{label} is signed out. Sign in to it in Settings."),
            Self::NotReady(Readiness::VersionUnknown) => format!("{label}'s version could not be read."),
            Self::NotReady(Readiness::Unsupported) => format!("{label} ({}) does not run on this computer.", preset.provider),
            Self::NotReady(Readiness::Failed { message, .. }) => format!("{label} did not start: {message}"),
            Self::Closed => format!("The session was closed while {label} started."),
            Self::NotReady(_) => format!("{label} is still being checked."),
            Self::Fault(Fault::Rpc(error)) if error.code == AUTH_REQUIRED => format!("{label} is signed out. Sign in to it in Settings."),
            Self::Fault(fault) => format!("{label}: {fault}"),
        }
    }

    /// Whether the agent is refused to the user for want of a sign-in.
    pub fn signed_out(&self) -> bool {
        matches!(self, Self::NotReady(Readiness::SignedOut { .. })) || matches!(self, Self::Fault(Fault::Rpc(error)) if error.code == AUTH_REQUIRED)
    }
}

/// The windows of an agent's quota report (the CLI's `command.data`, or the gateway's own summary), each with the
/// models it gates: the CLI names a bucket's fields in its own spelling, which the summary spells differently.
pub fn report_windows(report: &Value) -> Vec<Value> {
    let groups = report.get("groups").and_then(Value::as_array).into_iter().flatten();
    let groups: Vec<Value> = groups
        .map(|group| {
            let buckets = group.get("buckets").and_then(Value::as_array).into_iter().flatten();
            let buckets: Vec<Value> = buckets
                .map(|bucket| {
                    let mut read = serde_json::Map::new();
                    for (ours, theirs) in [
                        ("bucketId", "id"),
                        ("window", "window"),
                        ("remainingFraction", "remaining_fraction"),
                        ("resetTime", "reset_time"),
                        ("displayName", "name"),
                        ("disabled", "disabled"),
                    ] {
                        if let Some(value) = bucket.get(theirs).or_else(|| bucket.get(ours)) {
                            read.insert(ours.to_owned(), value.clone());
                        }
                    }
                    Value::Object(read)
                })
                .collect();
            json!({ "buckets": buckets })
        })
        .collect();
    mixdog_ai::service::usage_antigravity::quota_windows(&json!({ "groups": groups }))
}

/// Where a quota report that shows `model`'s window exhausted at `now_ms` says it resets: `Some(None)` when it names no
/// time, `None` when the window has room (or the report says nothing of it).
fn exhausted_until(report: &Value, model: &str, now_ms: i64) -> Option<Option<u64>> {
    let windows = report_windows(report).into_iter().filter_map(|window| serde_json::from_value::<Window>(window).ok()).collect();
    let account = Account { usage: Some(Usage { windows, checked_at: now_ms }), ..Account::new("default") };
    policy::account_exhausted(&account, now_ms, model, false)
        .then(|| policy::accounts_reset_at(std::slice::from_ref(&account), now_ms, model, false).and_then(|at| u64::try_from(at).ok()))
}

/// What a failure the agent itself reported for the prompt is checked against: the account's quota, read now.
pub struct QuotaCheck<'a> {
    /// The model the route names; [`DEFAULT_MODEL`] runs the one the agent is on.
    pub model: &'a str,
    /// The model the agent is on, when it is running.
    pub current: Option<&'a str>,
    pub now_ms: i64,
    /// The turn's stop: it ends the read.
    pub stop: &'a CancellationToken,
}

impl Agents {
    /// The failure of a turn on `preset`'s agent as the run reports it. An agent that is signed out (`code` is
    /// [`AUTH_REQUIRED`]) fails as a provider's authentication does. With a `check`, a failure the agent reported fails as
    /// a spent quota does when the account's quota, read within the provider's own request time, shows the window of
    /// `check.model` exhausted, with that window's reset time. A read that is stopped, times out or fails leaves the
    /// failure as it is, as does every failure with no `check`: none of them starts a CLI.
    pub async fn failure(self: &Arc<Self>, preset: &AgentPreset, message: String, code: Option<i64>, data: Value, check: Option<QuotaCheck<'_>>) -> TurnError {
        if code == Some(AUTH_REQUIRED) {
            return auth_turn_error(message, &preset.provider, data);
        }
        // The window is the one of the model the agent runs; the stop is the route's, which the session names.
        let stopped = async {
            let check = check?;
            let on = if check.model == DEFAULT_MODEL { check.current? } else { check.model };
            let report = self.usage_until(preset, check.stop).await?.ok()?;
            exhausted_until(&report, on, check.now_ms).map(|reset_at| (check.model, reset_at))
        }
        .await;
        match stopped {
            Some((model, reset_at)) => quota_turn_error(message, &preset.provider, model, reset_at, data),
            None => TurnError { message, data, provider_error: None },
        }
    }
}

/// The context window each agent reported on each of its models: preset id, then model, then size.
pub type Windows = HashMap<String, HashMap<String, u64>>;

/// Where an agent's refusal of the signed-in account is kept, so it stands across a restart of the app.
#[async_trait::async_trait]
pub trait Refusals: Send + Sync {
    /// What each agent last said when it refused the account, by preset id.
    async fn read(&self) -> HashMap<String, String>;
    /// Keeps `refusals` as the whole of what is refused now.
    async fn keep(&self, refusals: HashMap<String, String>);
    /// The window each agent last reported for its context, by preset id.
    async fn read_windows(&self) -> Windows;
    /// Keeps `windows` as the whole of what the agents last reported.
    async fn keep_windows(&self, windows: Windows);
}

/// What the agents are built on.
pub struct AgentsParts {
    pub refusals: Arc<dyn Refusals>,
    pub presets: Vec<AgentPreset>,
    pub processes: Arc<dyn ProcessManager>,
    pub files: Arc<dyn TextFiles>,
    /// The feature's switch, read at every use.
    pub enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Told when a readiness changed (the settings value's change tick).
    pub changed: Arc<dyn Fn() + Send + Sync>,
    /// The folder a CLI's version, install, update, check and sign-in runs start in: none of Mixdog's own.
    pub probe_cwd: std::path::PathBuf,
    /// Where the agent definitions a session's CLI starts with are kept: a folder of this user's own, as a definition
    /// found in a folder others can write would start the CLI with their tools and instructions.
    pub definitions: std::path::PathBuf,
    /// The feature's own folder: the builds of the registry's agents Mixdog installs (`bin/<preset id>/`) and the homes
    /// it keeps for them (`homes/<preset id>/`).
    pub data_dir: std::path::PathBuf,
    /// The process environment, for the folders a preset's installer puts its CLI in.
    pub env: Arc<EnvRead>,
    /// The program an agent that takes no HTTP MCP server runs as the stdio end of its session's tool server
    /// ([`crate::mcp_bridge`]); `None` hands such an agent no tools.
    pub mcp_bridge: Option<crate::preset::Command>,
    /// Where the builds of the registry's agents are downloaded from; `None` installs and updates none.
    pub registry: Option<Arc<dyn crate::registry::RegistryFetcher>>,
}

/// Reads one variable of the process environment.
pub type EnvRead = dyn Fn(&str) -> Option<String> + Send + Sync;
/// Starts the turn of a reply an agent began on its own.
type Wake = dyn Fn(&ThreadId) + Send + Sync;

pub struct Agents {
    pub(crate) parts: AgentsParts,
    /// Each preset's CLI: its readiness, its running check and its upkeep.
    pub(crate) slots: Mutex<HashMap<String, Slot>>,
    pub(crate) next_check: AtomicU64,
    /// The window each agent last reported for its context, by preset id: what a route on the agent can be sized within.
    windows: Mutex<Windows>,
    pub(crate) sessions: Mutex<HashMap<ThreadId, Arc<AgentSession>>>,
    /// The one server of each preset whose process serves all its sessions, by preset id, while it starts and runs.
    pub(crate) shared: Mutex<HashMap<String, crate::shared::SharedSlot>>,
    /// Held while `probe-cache.json` is read or replaced.
    pub(crate) probe_writes: tokio::sync::Semaphore,
    /// Held from a build's unpack until nothing of it writes any more ([`crate::registry::Unpacking`]).
    pub(crate) unpacking: Arc<tokio::sync::Semaphore>,
    /// How often each preset's account changed hands (a sign-in became the agent's, or it signed out), by preset id: what a
    /// server or a check started before the last change learns is of an account left. Never reset.
    pub(crate) accounts: Mutex<HashMap<String, u64>>,
    /// The presets being signed out: no session opens on them until the files of the sign-in are gone.
    pub(crate) signing_out: Mutex<std::collections::HashSet<String>>,
    /// The app is stopping: no shared server starts from here on.
    pub(crate) stopping: std::sync::atomic::AtomicBool,
    /// Fires when the app begins stopping, cancelling teardown waits such as `session/close`.
    pub(crate) stop_token: CancellationToken,
    /// The stops of shared servers under way, each resolving once its server has exited: the app's stop waits for them.
    pub(crate) stops: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// The threads whose agent is being started, each with its start's number.
    opening: Mutex<HashMap<ThreadId, u64>>,
    /// What the user approved for the rest of each thread's session.
    grants: Mutex<HashMap<ThreadId, Arc<Mutex<std::collections::HashSet<mixdog_tools::policy::GrantKey>>>>>,
    /// What each agent said when it refused the signed-in account, by preset id; `None` until it is read from where it is kept.
    refused: Mutex<Option<HashMap<String, String>>>,
    /// The running sign-in of each preset.
    pub(crate) logins: Mutex<HashMap<String, CancellationToken>>,
    /// Told when the account a preset's CLI is signed in with may no longer be the one a quota was read of, and
    /// when the CLI becomes askable for it.
    pub(crate) account_changed: OnceLock<Arc<AccountTold>>,
    /// Starts the turn of a reply the agent began on its own; bound once the sessions exist.
    wake: OnceLock<Arc<Wake>>,
    /// The sessions' tools, handed to every agent started once they are bound; unbound, an agent is handed none.
    tools: OnceLock<Arc<dyn crate::mcp::SessionTools>>,
    cancel_close_grace_ms: AtomicU64,
    shared_open_timeout_ms: AtomicU64,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Outcome of inspecting a thread's currently running session before opening a replacement.
pub(crate) enum ExistingSession {
    Reuse(Arc<AgentSession>),
    Open { stored: Option<crate::runs::Stored>, abandoned: bool },
}

/// One start of a thread's agent, for as long as it is the thread's current one.
struct Opening<'a> {
    agents: &'a Agents,
    thread: ThreadId,
    id: u64,
}

impl Opening<'_> {
    fn current(&self) -> bool {
        lock(&self.agents.opening).get(&self.thread) == Some(&self.id)
    }
}

impl Drop for Opening<'_> {
    fn drop(&mut self) {
        let mut opening = lock(&self.agents.opening);
        if opening.get(&self.thread) == Some(&self.id) {
            opening.remove(&self.thread);
        }
    }
}

impl Agents {
    pub fn new(parts: AgentsParts) -> Arc<Self> {
        Arc::new(Self {
            parts,
            slots: Mutex::default(),
            next_check: AtomicU64::new(0),
            windows: Mutex::default(),
            sessions: Mutex::default(),
            shared: Mutex::default(),
            probe_writes: tokio::sync::Semaphore::new(1),
            unpacking: Arc::new(tokio::sync::Semaphore::new(1)),
            accounts: Mutex::default(),
            signing_out: Mutex::default(),
            stopping: std::sync::atomic::AtomicBool::new(false),
            stop_token: CancellationToken::new(),
            stops: Mutex::default(),
            opening: Mutex::default(),
            grants: Mutex::default(),
            refused: Mutex::default(),
            logins: Mutex::default(),
            account_changed: OnceLock::new(),
            wake: OnceLock::new(),
            tools: OnceLock::new(),
            cancel_close_grace_ms: AtomicU64::new(CANCEL_CLOSE_GRACE.as_millis() as u64),
            shared_open_timeout_ms: AtomicU64::new(SHARED_OPEN_TIMEOUT.as_millis() as u64),
        })
    }

    fn cancel_close_grace(&self) -> Duration {
        Duration::from_millis(self.cancel_close_grace_ms.load(std::sync::atomic::Ordering::Relaxed))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn set_cancel_close_grace(&self, grace: Duration) {
        self.cancel_close_grace_ms.store(grace.as_millis() as u64, std::sync::atomic::Ordering::Relaxed);
    }

    fn shared_open_timeout(&self) -> Duration {
        Duration::from_millis(self.shared_open_timeout_ms.load(std::sync::atomic::Ordering::Relaxed))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn set_shared_open_timeout(&self, timeout: Duration) {
        self.shared_open_timeout_ms.store(timeout.as_millis() as u64, std::sync::atomic::Ordering::Relaxed);
    }

    /// Binds the sessions' tools: every agent started from here on is handed its session's tool surface.
    pub fn bind_tools(&self, tools: Arc<dyn crate::mcp::SessionTools>) {
        let _ = self.tools.set(tools);
    }

    /// Binds what is told when an agent's account may have changed: a sign-in, a sign-out, the feature turned off.
    pub fn bind_account_change(&self, told: Arc<AccountTold>) {
        let _ = self.account_changed.set(told);
    }

    /// Binds what starts a turn on a thread whose agent began a reply on its own.
    pub fn bind_wake(&self, wake: Arc<dyn Fn(&ThreadId) + Send + Sync>) {
        let _ = self.wake.set(wake);
    }

    pub fn enabled(&self) -> bool {
        (self.parts.enabled)()
    }

    pub fn presets(&self) -> &[AgentPreset] {
        &self.parts.presets
    }

    /// The preset a route's provider id names, whatever the switch says: a session stays an agent's when the feature is turned off.
    pub fn preset_of_route(&self, provider: &str) -> Option<&AgentPreset> {
        self.parts.presets.iter().find(|preset| preset.provider == provider)
    }

    /// What the last finished check of `preset` found. A preset nobody looked at yet is looked at in the
    /// background (its first look, which also brings the CLI up to date) and reads as `None` meanwhile.
    fn known(self: &Arc<Self>, preset: &AgentPreset) -> Option<Readiness> {
        let found = {
            let mut slots = lock(&self.slots);
            let slot = slots.entry(preset.id.clone()).or_default();
            if slot.running.is_none() && slot.readiness.is_none() {
                self.share_check(&mut slots, preset, Plan::Refresh);
                return None;
            }
            // What the last check found holds while a new one runs.
            slot.readiness.clone()
        };
        found.map(|found| self.as_refused(preset, found))
    }

    /// `found` as the user is shown it: a CLI that opens a session for an account the agent refused is not ready, in
    /// the agent's own words. A check opens a session and sends no prompt, so it never learns of the refusal itself.
    fn as_refused(&self, preset: &AgentPreset, found: Readiness) -> Readiness {
        let refused = lock(&self.refused).as_ref().and_then(|refused| refused.get(&preset.id).cloned());
        match (found, refused) {
            (Readiness::Ready { version, .. }, Some(message)) => Readiness::Failed { version: Some(version), message },
            (found, _) => found,
        }
    }

    /// Reads the kept refusals once; what was refused since the app started stands over what was kept.
    pub(crate) async fn read_refusals(&self) {
        if lock(&self.refused).is_some() {
            return;
        }
        let kept = self.parts.refusals.read().await;
        lock(&self.refused).get_or_insert(kept);
    }

    /// `preset`'s agent answered a turn with its refusal of the account, `message`: its row leaves "Ready" and stays
    /// out through every check and a restart, until a sign-in succeeds or the agent answers a turn.
    pub(crate) async fn refused(&self, preset: &AgentPreset, message: &str) {
        self.read_refusals().await;
        let kept = {
            let mut refused = lock(&self.refused);
            let refused = refused.get_or_insert_with(HashMap::new);
            refused.insert(preset.id.clone(), message.to_owned());
            refused.clone()
        };
        self.parts.refusals.keep(kept).await;
        (self.parts.changed)();
    }

    /// Reads the windows the agents reported before the app started; what was reported since stands over what was kept.
    pub async fn restore_windows(&self) {
        let kept = self.parts.refusals.read_windows().await;
        let mut windows = lock(&self.windows);
        for (agent, models) in kept {
            let held = windows.entry(agent).or_default();
            for (model, size) in models {
                held.entry(model).or_insert(size);
            }
        }
        drop(windows);
        (self.parts.changed)();
    }

    /// The agent reported its context's window on `model`: a route on that model can be sized within that window from
    /// here on, across a restart of the app.
    pub(crate) async fn window_reported(&self, preset: &AgentPreset, model: &str, size: u64) {
        let model = self.grouped_model(preset, model);
        let kept = {
            let mut windows = lock(&self.windows);
            if windows.entry(preset.id.clone()).or_default().insert(model, size) == Some(size) {
                return;
            }
            windows.clone()
        };
        self.parts.refusals.keep_windows(kept).await;
        (self.parts.changed)();
    }

    /// The window `preset`'s agent last reported on `model`; `None` until it has reported one on that model.
    pub fn reported_window(&self, preset: &AgentPreset, model: &str) -> Option<u64> {
        let model = self.grouped_model(preset, model);
        lock(&self.windows).get(&preset.id)?.get(&model).copied()
    }

    /// The model a window is kept under: the listed model a route's `model` names (a route saved under the agent's own id
    /// of one of a model's effort tiers names the grouped model), else `model` as it is.
    fn grouped_model(&self, preset: &AgentPreset, model: &str) -> String {
        let found = lock(&self.slots).get(&preset.id).and_then(|slot| slot.readiness.clone());
        match &found {
            Some(Readiness::Ready { models, .. }) => crate::tiers::find(models, &preset.quirks, model).map_or_else(|| model.to_owned(), |listed| listed.id),
            _ => model.to_owned(),
        }
    }

    /// The window `preset`'s agent last reported on `model`, stated as a model row states a window (`contextWindow`, and
    /// the `maxContextWindow` a route can be sized up to); `None` until it has reported one.
    pub fn window_meta(&self, preset: &AgentPreset, model: &str) -> Option<Value> {
        let size = self.reported_window(preset, model)?;
        Some(json!({ "contextWindow": size, "maxContextWindow": size }))
    }

    /// `preset`'s agent serves the account again (it answered a turn, or a sign-in succeeded): a standing refusal ends.
    pub(crate) async fn answered(&self, preset: &AgentPreset) {
        self.read_refusals().await;
        let kept = {
            let mut refused = lock(&self.refused);
            let Some(refused) = refused.as_mut() else { return };
            if refused.remove(&preset.id).is_none() {
                return;
            }
            refused.clone()
        };
        self.parts.refusals.keep(kept).await;
        (self.parts.changed)();
    }

    /// What Settings shows: each agent with its state. Reading it starts the first look at a preset's CLI.
    pub fn status(self: &Arc<Self>) -> Value {
        let enabled = self.enabled();
        if !enabled {
            // The value is read again right after the switch is written: turning the feature off ends its agents here.
            self.release_all();
        }
        let agents: Vec<Value> = self
            .parts
            .presets
            .iter()
            .map(|preset| {
                if enabled {
                    self.known(preset);
                }
                let slots = lock(&self.slots);
                let slot = slots.get(&preset.id).filter(|_| enabled);
                // What the last check found stays on show while a new one runs.
                let found = slot.and_then(|slot| slot.readiness.clone());
                // An account the agent refused is still signed in: it can be left for another.
                let signed_in = matches!(found, Some(Readiness::Ready { .. }));
                let readiness = found.map(|found| self.as_refused(preset, found));
                let readiness = readiness.as_ref();
                // A running check's step is the state; else what was found, a standing refusal included.
                let state = slot.map_or("off", |slot| slot.step().or(readiness.map(Readiness::state)).unwrap_or("checking"));
                let models: Vec<Value> = match readiness {
                    // As the picker lists them: a model the agent runs at several efforts once, under its own name.
                    Some(Readiness::Ready { models, .. }) => {
                        crate::tiers::offered(models, &preset.quirks).iter().map(|model| json!({ "id": model.id, "name": model.name })).collect()
                    }
                    _ => Vec::new(),
                };
                json!({
                    "id": preset.id,
                    "label": preset.label,
                    "provider": preset.provider,
                    "command": preset.command,
                    "minimumVersion": preset.minimum_version.to_string(),
                    "state": state,
                    "version": readiness.and_then(Readiness::version),
                    "message": readiness.and_then(Readiness::message),
                    "models": models,
                    // The window the agent reported on each model: a new one changes this value, which is how the desktop
                    // learns its model rows state a window now (the slider's maximum).
                    "contextWindows": lock(&self.windows).get(&preset.id).cloned().unwrap_or_default(),
                    // What the agent tells of the signed-in account: its plan, and whether it can be signed out here.
                    "plan": slot.filter(|_| matches!(readiness, Some(Readiness::Ready { .. }))).and_then(|slot| slot.account.plan.clone()),
                    "canSignOut": slot.is_some_and(|slot| slot.account.sign_out) && signed_in,
                    "lastError": slot.map_or(Value::Null, Slot::fault),
                    "canInstall": match &preset.distribution {
                        crate::preset::Distribution::Cli { installer, .. } => installer.is_some(),
                        crate::preset::Distribution::Registry { supported, kept_current, .. } => *supported && *kept_current && self.parts.registry.is_some(),
                    },
                    "canSignIn": preset.login.is_some(),
                    // The agent may open its sign-in page in the system's browser itself: the page is shown, not opened.
                    "loginOpensBrowser": preset.login.as_ref().is_some_and(crate::preset::Login::opens_browser),
                    // What a browser on another machine pastes is the address the page ended on, not a code it showed.
                    "loginTakesRedirect": matches!(preset.login, Some(crate::preset::Login::AcpAuthenticate { .. })),
                    // The CLI keeps its sign-in where the vendor's CLI outside Mixdog finds it: signing out here signs that out too.
                    // A registry agent keeps its own in the home Mixdog keeps for it.
                    "sharesExternalSignIn": matches!(preset.distribution, crate::preset::Distribution::Cli { .. }),
                })
            })
            .collect();
        json!({ "enabled": enabled, "agents": agents })
    }

    /// The picker's rows of the agents that can run a session now: one per named model of its scope the agent reports.
    /// The agent's default model is no row of it, though a route or a call may name it. Empty while the feature is off.
    pub fn picker_rows(self: &Arc<Self>) -> Vec<Value> {
        if !self.enabled() {
            return Vec::new();
        }
        let mut rows = Vec::new();
        for preset in &self.parts.presets {
            let Some(Readiness::Ready { models, .. }) = self.known(preset) else { continue };
            rows.extend(
                crate::tiers::offered(&models, &preset.quirks).iter().map(|listed| self.with_window(preset, &listed.id, Self::listed_row(preset, listed))),
            );
        }
        rows
    }

    /// The row of a model the agent lists: its own name and its agent's apart (a list that groups the rows under the
    /// agent names each by the model alone), and, for a model the agent runs at several efforts, those efforts as a
    /// provider's row states its own.
    fn listed_row(preset: &AgentPreset, listed: &crate::tiers::Listed) -> Value {
        let mut row = Self::plain_row(preset, &listed.id, &format!("{} · {}", preset.label, listed.name));
        row["modelName"] = Value::String(listed.name.clone());
        row["agentLabel"] = Value::String(preset.label.clone());
        if !listed.efforts.is_empty() {
            row["supportsReasoning"] = Value::Bool(true);
            row["reasoningLevels"] = listed.efforts.iter().map(|(effort, _)| Value::String(effort.clone())).collect();
            row["defaultEffort"] = listed.default_effort.clone().map_or(Value::Null, Value::String);
            let items = mixdog_ai::effort::effort_items_for(&preset.provider, &row, None, None);
            row["effortOptions"] = items.into_iter().map(|item| json!({ "value": item.value, "label": item.label, "description": item.description })).collect();
            row["notApplicable"] = NOT_APPLICABLE.iter().filter(|control| **control != "effort").map(|control| Value::String((*control).to_owned())).collect();
        }
        row
    }

    fn plain_row(preset: &AgentPreset, model: &str, display: &str) -> Value {
        json!({
            "provider": preset.provider,
            "id": model,
            "name": display,
            "display": display,
            "runner": "acp",
            "agent": preset.id,
            "notApplicable": NOT_APPLICABLE,
        })
    }

    /// `row` of `model` with the window its agent reported on it, where it has reported one.
    fn with_window(&self, preset: &AgentPreset, model: &str, mut row: Value) -> Value {
        if let (Some(window), Some(row)) = (self.window_meta(preset, model), row.as_object_mut()) {
            row.extend(window.as_object().cloned().unwrap_or_default());
        }
        row
    }

    /// The model row a route on `preset`'s agent resolves to: the picker's row of `model` where the agent lists it,
    /// else a row under the agent's name alone (its default model, or one it no longer lists).
    pub fn model_row(&self, preset: &AgentPreset, model: &str) -> Value {
        let found = lock(&self.slots).get(&preset.id).and_then(|slot| slot.readiness.clone());
        let listed = match &found {
            // A route saved under the agent's own id of one tier is that model's.
            Some(Readiness::Ready { models, .. }) => crate::tiers::find(models, &preset.quirks, model),
            _ => None,
        };
        self.with_window(preset, model, listed.map_or_else(|| Self::plain_row(preset, model, &preset.label), |listed| Self::listed_row(preset, &listed)))
    }

    /// Whether a route on `preset` can be chosen now.
    pub fn selectable(self: &Arc<Self>, preset: &AgentPreset) -> Result<(), Refusal> {
        if !self.enabled() {
            return Err(Refusal::Off);
        }
        match self.known(preset) {
            Some(Readiness::Ready { .. }) => Ok(()),
            Some(other) => Err(Refusal::NotReady(other)),
            None => Err(Refusal::NotReady(Readiness::Checking)),
        }
    }

    /// The preset's program as the last check found it.
    pub(crate) fn program(&self, preset: &AgentPreset) -> crate::session::Program {
        lock(&self.slots).get(&preset.id).and_then(|slot| slot.program.clone()).unwrap_or_else(|| crate::session::Program::at(preset.command.clone()))
    }

    /// Why `preset`'s agent is not asked to run `model`, a route's name of one: a model outside the preset's scope runs on
    /// another preset of the agent, and the agent's default model only on a preset that runs it. The preset that runs
    /// it is named, by its provider: the presets of one agent share its name. `None` for a model the preset runs. It
    /// comes before every other refusal: a turn on such a route fails with it whatever state the preset's agent is in,
    /// and never hops to a fallback provider.
    pub fn refuses_model(&self, preset: &AgentPreset, model: &str) -> Option<String> {
        let runs = |preset: &AgentPreset| if model == DEFAULT_MODEL { preset.quirks.runs_default } else { preset.quirks.model_scope.admits(model) };
        if runs(preset) {
            return None;
        }
        let what = if model == DEFAULT_MODEL { "its agent's default model".to_owned() } else { format!("the model \"{model}\"") };
        let runner = self.parts.presets.iter().find(|other| other.id != preset.id && runs(other));
        let refused = format!("{} ({}) does not run {what}.", preset.label, preset.provider);
        Some(match runner {
            Some(runner) => format!("{refused} Choose it under {} ({}).", runner.label, runner.provider),
            None => refused,
        })
    }

    /// The agent of `thread`, started when the thread has none in `cwd` (and reopened from `stored`).
    pub async fn session(
        self: &Arc<Self>,
        thread: &ThreadId,
        preset: &AgentPreset,
        cwd: AbsPath,
        stored: Option<crate::runs::Stored>,
        rules: Option<String>,
    ) -> Result<Arc<AgentSession>, Refusal> {
        // A session reopened on its preset's shared server keeps the server running until the new one is on it.
        let _held = self.hold_shared(thread, preset);
        match self.resolve_running(thread, preset, &cwd, stored).await? {
            ExistingSession::Reuse(running) => Ok(running),
            ExistingSession::Open { stored, .. } => self.open_session(thread, preset, cwd, stored, rules).await,
        }
    }

    /// Checks whether `thread`'s existing running session can be reused, waiting up to [`Self::cancel_close_grace`]
    /// for a cancelled prompt to close and abandoning + ending a stuck session before opening a replacement.
    pub(crate) async fn resolve_running(
        &self,
        thread: &ThreadId,
        preset: &AgentPreset,
        cwd: &AbsPath,
        mut stored: Option<crate::runs::Stored>,
    ) -> Result<ExistingSession, Refusal> {
        if !self.enabled() {
            return Err(Refusal::Off);
        }
        let mut abandoned = false;
        if preset.scope == ProcessScope::Shared && stored.as_ref().is_some_and(|stored| self.is_abandoned(preset, &stored.session_id)) {
            stored = None;
            abandoned = true;
        }
        let running = lock(&self.sessions).get(thread).cloned();
        let mut _held = None;
        if let Some(running) = running {
            if running.preset.id == preset.id && running.cwd == *cwd && !running.gone().is_cancelled() {
                // A session that holds a cancelled prompt would read the next prompt as part of it: the agent
                // closes that prompt first, which is the answer the protocol has it give to a cancel. If the agent
                // never answers, drop the stuck session after a bounded grace so the next turn does not hang.
                let closed = if running.holds_cancelled_prompt() {
                    mixdog_rt::time::timeout(self.cancel_close_grace(), running.cancelled_prompt_closed()).await.is_ok()
                } else {
                    true
                };
                if closed && !running.gone().is_cancelled() {
                    return Ok(ExistingSession::Reuse(running));
                }
                if !closed && preset.scope == ProcessScope::Shared {
                    // Reopening the same session id on the shared server would reattach to the stuck prompt.
                    self.abandon_shared(preset, &running.session_id);
                    stored = None;
                    abandoned = true;
                }
            }
            // A session reopened on its preset's shared server keeps the server running until the new one is on it,
            // unless the detached session still has an unclosed prompt or pending cancel (let an empty server retire).
            if running.preset.id == preset.id && !running.holds_cancelled_prompt() && !running.has_pending_cancel() {
                _held = running.hold_server();
            }
            self.end_process(thread);
        }
        Ok(ExistingSession::Open { stored, abandoned })
    }

    /// Opens a fresh or reopened agent session for `thread`, bounding opens on an existing shared server so a
    /// wedged server is retired and replaced instead of hanging indefinitely.
    pub(crate) async fn open_session(
        self: &Arc<Self>,
        thread: &ThreadId,
        preset: &AgentPreset,
        cwd: AbsPath,
        stored: Option<crate::runs::Stored>,
        rules: Option<String>,
    ) -> Result<Arc<AgentSession>, Refusal> {
        if !self.enabled() {
            return Err(Refusal::Off);
        }
        // A close of the thread while its agent starts ends the start: the agent it would hold is never kept.
        let opening = Opening { agents: self.as_ref(), thread: thread.clone(), id: self.next_check.fetch_add(1, std::sync::atomic::Ordering::Relaxed) };
        lock(&self.opening).insert(opening.thread.clone(), opening.id);
        // The CLI is checked before its ACP mode is started: one too old for it is never run in it. The start is
        // held against an update of the CLI until the session is among those the update looks at.
        let (program, _starting) = self.ready_program(preset).await?;
        let grants = lock(&self.grants).entry(thread.clone()).or_default().clone();
        let wake: crate::session::Wake = {
            let (agents, thread) = (Arc::downgrade(self), thread.clone());
            Arc::new(move || {
                if let Some(wake) = agents.upgrade().and_then(|agents| agents.wake.get().cloned()) {
                    wake(&thread);
                }
            })
        };
        let slot: Arc<OnceLock<std::sync::Weak<AgentSession>>> = Arc::default();
        let make_on_exit = || -> Box<dyn FnOnce() + Send> {
            let (agents, thread, slot) = (Arc::downgrade(self), thread.clone(), slot.clone());
            Box::new(move || {
                let (Some(agents), Some(ended)) = (agents.upgrade(), slot.get().and_then(std::sync::Weak::upgrade)) else { return };
                let mut sessions = lock(&agents.sessions);
                if sessions.get(&thread).is_some_and(|held| Arc::ptr_eq(held, &ended)) {
                    sessions.remove(&thread);
                }
            })
        };
        let make_handed =
            || self.tools.get().map(|tools| crate::mcp::Handover { thread: thread.clone(), tools: tools.clone(), bridge: self.parts.mcp_bridge.clone() });
        let (stored, held) = stored.map(|stored| (stored.session_id, stored.prompt)).unzip();
        let held = held.flatten();
        let opened = match preset.scope {
            ProcessScope::PerSession => {
                let open = Open {
                    preset,
                    program: &program,
                    cwd,
                    definitions: &self.parts.definitions,
                    stored,
                    rules,
                    held,
                    grants,
                    handed: make_handed(),
                    temp: None,
                };
                AgentSession::open(self.parts.processes.clone(), self.parts.files.clone(), open, wake, make_on_exit()).await
            }
            // The preset's one server, started by the first session that needs it, serves this one beside the others.
            ProcessScope::Shared => {
                let mut result = Err(Fault::Start(format!("{} did not open a session in time", preset.label)));
                for attempt in 0..2 {
                    let attempt_deadline = (attempt > 0).then(|| tokio::time::Instant::now() + self.shared_open_timeout());
                    let (lease, existing) = match self.shared_server_bounded(preset, &program, attempt_deadline).await {
                        Ok(found) => found,
                        Err(fault) => {
                            result = Err(fault);
                            break;
                        }
                    };
                    let server = lease.server().clone();
                    let open = Open {
                        preset,
                        program: &program,
                        cwd: cwd.clone(),
                        definitions: &self.parts.definitions,
                        stored: stored.clone(),
                        rules: rules.clone(),
                        held: held.clone(),
                        grants: grants.clone(),
                        handed: make_handed(),
                        temp: None,
                    };
                    let timeout = match attempt_deadline {
                        Some(deadline) => Some(deadline.saturating_duration_since(tokio::time::Instant::now())),
                        None => existing.then(|| self.shared_open_timeout()),
                    };
                    match AgentSession::open_on_shared(lease, open, wake.clone(), make_on_exit(), timeout).await {
                        Ok(session) => {
                            result = Ok(session);
                            break;
                        }
                        Err(crate::session::OpenSharedError::TimedOut) => {
                            tracing::warn!(
                                "[acp] {}'s shared server did not open a session within {:?}: {}",
                                preset.id,
                                self.shared_open_timeout(),
                                if attempt == 0 { "replacing it" } else { "giving up" }
                            );
                            self.retire_wedged_shared(&server);
                            if attempt == 0 {
                                continue;
                            }
                            result = Err(Fault::Start(format!("{} did not open a session in time", preset.label)));
                            break;
                        }
                        Err(crate::session::OpenSharedError::Fault(Fault::Closed(_))) if existing && attempt == 0 => {
                            self.retire_wedged_shared(&server);
                            continue;
                        }
                        Err(crate::session::OpenSharedError::Fault(fault)) => {
                            result = Err(fault);
                            break;
                        }
                    }
                }
                result
            }
        };
        let session = match opened {
            Ok(session) => session,
            Err(fault) => {
                self.open_failed(preset, &fault).await;
                return Err(Refusal::Fault(fault));
            }
        };
        let _ = slot.set(Arc::downgrade(&session));
        // A reopened session whose answer listed no models runs the agent's models as its last check listed them.
        if let Some(Readiness::Ready { models, .. }) = lock(&self.slots).get(&preset.id).and_then(|slot| slot.readiness.as_ref()) {
            session.adopt_models(models);
        }
        // The feature may have been turned off, or the thread closed, while the agent started: the newest holder wins,
        // and a switch that is off holds none.
        if !self.enabled() {
            session.end();
            return Err(Refusal::Off);
        }
        // The thread's close and this start meet under the sessions' lock: a start the close ended keeps nothing.
        let mut sessions = lock(&self.sessions);
        if !opening.current() {
            session.end();
            return Err(Refusal::Closed);
        }
        // A session gone already (its process exited, or its server was retired, while it opened) may have had its end
        // told before the slot above was set, which then forgot nothing: it is not kept.
        if session.gone().is_cancelled() {
            return Err(Refusal::Fault(session.closed()));
        }
        if let Some(replaced) = sessions.insert(thread.clone(), session.clone()) {
            replaced.end();
        }
        Ok(session)
    }

    /// A session of `preset`'s agent could not be opened for `fault`: one that says the user signed out since the last
    /// check is the agent's state.
    pub(crate) async fn open_failed(&self, preset: &AgentPreset, fault: &Fault) {
        if matches!(fault, Fault::Rpc(error) if error.code == AUTH_REQUIRED) {
            self.signed_out(preset, fault.to_string()).await;
        }
    }

    /// A turn or an open found `preset`'s agent signed out, saying `message`: what it last told of itself, the account
    /// included, stands no longer, in memory and in `probe-cache.json`, so no later start of the app reads it ready.
    pub(crate) async fn signed_out(&self, preset: &AgentPreset, message: String) {
        self.not_ready(preset, |version| Readiness::SignedOut { version, message });
        self.forget_told(preset).await;
    }

    /// A turn found `preset`'s agent unable to serve: its state is `state` of the version last found, until a check or
    /// a sign-in finds it ready again.
    pub(crate) fn not_ready(&self, preset: &AgentPreset, state: impl FnOnce(String) -> Readiness) {
        let mut signed_out = false;
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            let version = slot.readiness.as_ref().and_then(|known| known.version().map(str::to_owned)).unwrap_or_default();
            let found = state(version);
            signed_out = matches!(found, Readiness::SignedOut { .. });
            // What the agent last told of itself was of a sign-in that holds no longer.
            slot.stale_probe |= signed_out;
            slot.readiness = Some(found);
        }
        (self.parts.changed)();
        if signed_out {
            self.account_left(&preset.id, AccountEvent::Left);
        }
    }

    /// A turn of `thread` that began on its agent's route ended before it was the agent's: what the agent queued for
    /// that turn (a permission request, a call of a Mixdog tool) is answered with `why`, so none of it waits for the
    /// turn after.
    pub async fn unrun(&self, thread: &ThreadId, why: &str) {
        let Some(session) = self.running(thread) else { return };
        session.abandon_waiting(&format!("The turn this was asked in did not start: {why}")).await;
    }

    /// Holds open the shared server `thread`'s session runs on, where it is `preset`'s, while the lease is kept: the
    /// session is about to be ended and another opened on the server.
    pub(crate) fn hold_shared(&self, thread: &ThreadId, preset: &AgentPreset) -> Option<crate::shared::Lease> {
        self.running(thread)
            .filter(|running| running.preset.id == preset.id && !running.holds_cancelled_prompt() && !running.has_pending_cancel())
            .and_then(|running| running.hold_server())
    }

    pub(crate) fn abandon_shared(&self, preset: &AgentPreset, session_id: &str) {
        if preset.scope != ProcessScope::Shared {
            return;
        }
        if let Some(crate::shared::SharedSlot::Running(server)) = lock(&self.shared).get(&preset.id) {
            server.abandon(session_id);
        }
    }

    pub(crate) fn is_abandoned(&self, preset: &AgentPreset, session_id: &str) -> bool {
        if preset.scope != ProcessScope::Shared {
            return false;
        }
        matches!(lock(&self.shared).get(&preset.id), Some(crate::shared::SharedSlot::Running(server)) if server.is_abandoned(session_id))
    }

    /// Ends the process of `thread`'s agent, or takes its session alone off the shared server it runs on; the thread
    /// stays the agent's, and its next turn starts or reopens one again.
    pub fn end_process(&self, thread: &ThreadId) {
        let session = lock(&self.sessions).remove(thread);
        if let Some(session) = session {
            session.end();
        }
    }

    /// Ends the agent of `thread` with its whole process tree, or takes its session alone off the shared server, one
    /// that is still starting included: the thread closed, was deleted or left memory. What the user approved for the
    /// session goes with it.
    pub fn release(&self, thread: &ThreadId) {
        let session = {
            let mut sessions = lock(&self.sessions);
            lock(&self.opening).remove(thread);
            lock(&self.grants).remove(thread);
            sessions.remove(thread)
        };
        if let Some(session) = session {
            session.end();
        }
    }

    /// Ends every agent, shared server, check and sign-in: the feature was turned off.
    pub fn release_all(&self) {
        let sessions: Vec<_> = lock(&self.sessions).drain().collect();
        for (_, session) in sessions {
            session.end();
        }
        // Each closes as the end of its input closes it, in a task of its own.
        self.close_shared();
        self.forget_checks();
        let logins: Vec<_> = lock(&self.logins).drain().collect();
        for (_, login) in logins {
            login.cancel();
        }
    }

    /// The process of `thread`'s agent, while it has one.
    pub fn running(&self, thread: &ThreadId) -> Option<Arc<AgentSession>> {
        lock(&self.sessions).get(thread).cloned()
    }
}

impl mixdog_core_session::session::purge::SessionAgentProcesses for Agents {
    fn release(&self, session_id: &str) {
        Agents::release(self, &ThreadId::from(session_id));
    }
}

/// The Mixdog controls an agent's session has no use for: the agent owns its reasoning effort and its model's service
/// options. The context window applies: the agent's reported size is the raw window, and the user's selection sets the
/// effective window and the compaction boundary below it. A compaction replaces the stored conversation with its
/// summary, and the agent's next turn starts a session of its own on that summary.
pub const NOT_APPLICABLE: [&str; 4] = ["effort", "autoEffort", "fast", "fallbacks"];

#[cfg(test)]
mod tests {
    use super::*;

    fn report(gemini_left: f64, third_party_left: f64) -> Value {
        json!({ "groups": [
            { "name": "Gemini Models", "buckets": [
                { "id": "gemini-5h", "name": "Five Hour Limit Remaining", "window": "5h", "remaining_fraction": gemini_left, "reset_time": "2030-01-01T05:00:00Z" },
            ] },
            { "name": "Claude and GPT models", "buckets": [
                { "id": "3p-5h", "name": "Five Hour Limit Remaining", "window": "5h", "remaining_fraction": third_party_left, "reset_time": "2030-01-01T06:00:00Z" },
            ] },
        ] })
    }

    #[test]
    fn a_failure_is_a_quota_stop_only_when_the_routes_window_is_exhausted() {
        let now = 1_700_000_000_000;
        assert_eq!(exhausted_until(&report(0.0, 1.0), "gemini-3-pro", now), Some(Some(1_893_474_000_000)));
        assert_eq!(exhausted_until(&report(0.0, 1.0), "claude-sonnet-4", now), None, "another window's exhaustion is not the route's");
        assert_eq!(exhausted_until(&report(0.5, 0.0), "gemini-3-pro", now), None, "a window with room stays what it is");
    }

    /// A bucket the report marks disabled meters nothing: it is no window, and its exhaustion stops no turn. The
    /// gateway's own summary, in its own spelling, reads as the CLI's report does.
    #[test]
    fn a_disabled_bucket_is_no_window_and_the_gateways_summary_reads_as_the_clis_report() {
        let now = 1_700_000_000_000;
        let disabled = json!({ "groups": [{ "buckets": [
            { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.0, "reset_time": "2030-01-01T05:00:00Z", "disabled": true },
            { "id": "3p-5h", "window": "5h", "remaining_fraction": 0.5, "reset_time": "2030-01-01T06:00:00Z" },
        ] }] });
        let labels: Vec<Value> = report_windows(&disabled).iter().map(|window| window["label"].clone()).collect();
        assert_eq!(labels, [json!("5H Claude/GPT")]);
        assert_eq!(exhausted_until(&disabled, "gemini-3-pro", now), None);
        let summary = json!({ "groups": [{ "buckets": [
            { "bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0.0, "resetTime": "2030-01-01T05:00:00Z" },
        ] }] });
        assert_eq!(exhausted_until(&summary, "gemini-3-pro", now), Some(Some(1_893_474_000_000)));
    }
}
