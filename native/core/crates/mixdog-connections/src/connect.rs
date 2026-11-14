//! The SSH connect flow: the host-key pre-check that opens an attempt, the decisions of a connect (what the pre-check allows,
//! which saved record a first-time target gets, the progress the connection and the log see), and opening a saved server's
//! window. What the pre-check saw decides, never what the caller says: a revoked or unreadable key is refused outright, a
//! changed one only when the user typed the server's name to replace it, an unknown one only after the user confirmed it, and
//! the key that is pinned is the one the inspection showed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{
    SshConfigSummary, SshConnectRequest, SshConnectResult, SshFailure, SshFailureKind, SshHopStatus, SshHost, SshHostKeyCheck,
    SshInspection, SshMissing, SshPhase, SshProgress,
};
use mixdog_core_api::ids::ConnectionId;
use mixdog_ssh::command::{parse_ssh_target, SshError, SshTarget};
use mixdog_ssh::connect_failure::failure_of;
use mixdog_ssh::context::{AttemptContext, HostSettings, ModelLogin, Platform, SshEnv};
use mixdog_ssh::diagnostics::{diagnostics_key_for, DiagnosticKind, Diagnostics};
use mixdog_ssh::host_key::{inspect_host_key, pin_host_key, replace_host_key, HostKeyInspection};
use mixdog_ssh::resolved_config::ResolvedConfigs;
use mixdog_ssh::session::{Progress, SessionPhase};
use serde_json::json;

use crate::attempts::{Attempt, AttemptError, AttemptState, Attempts};
use crate::host_store::{parse_host_settings, SshHostRecord, SshHostSettings, SshHostStore, DEFAULT_GRACE_MINUTES};
use crate::link::LinkSpec;
use crate::login::{with_login_retry, LoginHelpers};

/// The id of the window `connections/ssh/openEphemeral` opens: a development window that is never saved.
pub const EPHEMERAL_ID: &str = "ssh-env-target";
const REMOTE_CWD_VAR: &str = "MIXDOG_SSH_REMOTE_CWD";

/// What the connect flow reaches the machine through.
#[async_trait]
pub trait SshMachine: Send + Sync {
    /// Reads the key(s) the server presents and compares them with this PC's known_hosts.
    async fn inspect(&self, target: &SshTarget) -> Result<HostKeyInspection, SshError>;
    /// Saves the inspection's pin.
    fn pin(&self, inspection: &HostKeyInspection) -> Result<(), SshError>;
    /// Forgets the old key and saves the one the inspection showed.
    async fn replace(&self, inspection: &HostKeyInspection) -> Result<(), SshError>;
    fn platform(&self) -> Platform;
    fn diagnostics(&self) -> Arc<Diagnostics>;
    /// An environment variable of this process.
    fn var(&self, name: &str) -> Option<String>;
}

/// The machine of this PC.
pub struct EnvMachine {
    pub env: Arc<SshEnv>,
    /// The per-target generated ssh configs (the same instance the ssh environment's `config_files` is).
    pub configs: Arc<ResolvedConfigs>,
}

#[async_trait]
impl SshMachine for EnvMachine {
    async fn inspect(&self, target: &SshTarget) -> Result<HostKeyInspection, SshError> {
        let mut inspection = inspect_host_key(&self.env, &AttemptContext::default(), target).await?;
        if matches!(inspection.check, SshHostKeyCheck::Unreachable { .. }) {
            return Ok(inspection);
        }
        // Mixdog's ssh runs with what ssh resolves for this server, minus every forward; when that cannot be built faithfully the
        // user's config applies and its forwards are listed.
        let resolved = self.configs.resolve_for_target(&self.env, &AttemptContext::default(), target).await;
        if let (Err(unresolved), Some(summary)) = (resolved, inspection.summary.as_mut()) {
            if !unresolved.forwards.is_empty() {
                summary.forwards = Some(unresolved.forwards);
            }
        }
        Ok(inspection)
    }

    fn pin(&self, inspection: &HostKeyInspection) -> Result<(), SshError> {
        pin_host_key(&self.env, inspection)
    }

    async fn replace(&self, inspection: &HostKeyInspection) -> Result<(), SshError> {
        replace_host_key(&self.env, inspection).await
    }

    fn platform(&self) -> Platform {
        self.env.platform
    }

    fn diagnostics(&self) -> Arc<Diagnostics> {
        self.env.diagnostics.clone()
    }

    fn var(&self, name: &str) -> Option<String> {
        self.env.var(name).map(str::to_owned)
    }
}

/// Puts a server's window in front of the user once its link is attached (`WindowHost::open`, supplied by the service).
#[async_trait]
pub trait ServerWindows: Send + Sync {
    async fn open(&self, id: &str, name: &str) -> Result<(), String>;
}

/// A saved server as the dialog shows it.
pub type HostView = Arc<dyn Fn(&SshHostRecord) -> SshHost + Send + Sync>;

pub struct ConnectDeps {
    pub attempts: Arc<Attempts>,
    pub machine: Arc<dyn SshMachine>,
    pub login: Arc<dyn LoginHelpers>,
    pub hosts: Arc<SshHostStore>,
    pub windows: Arc<dyn ServerWindows>,
    pub view: HostView,
    /// Milliseconds since the Unix epoch.
    pub clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

pub struct Connect {
    attempts: Arc<Attempts>,
    machine: Arc<dyn SshMachine>,
    login: Arc<dyn LoginHelpers>,
    hosts: Arc<SshHostStore>,
    windows: Arc<dyn ServerWindows>,
    view: HostView,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    locks: TargetLocks,
}

/// What the pre-check allows.
enum Decision {
    Refused(SshConnectResult),
    Proceed(KeyAction),
}

/// What is done to known_hosts before connecting.
#[derive(Clone, Copy, PartialEq, Eq)]
enum KeyAction {
    Nothing,
    Pin,
    Replace,
}

fn refusal(kind: SshFailureKind, code: &str) -> Decision {
    Decision::Refused(SshConnectResult::failed(SshFailure { kind, code: Some(code.to_owned()) }))
}

fn cancelled() -> SshConnectResult {
    SshConnectResult::failed(SshFailure { kind: SshFailureKind::Cancelled, code: None })
}

fn status_name(check: &SshHostKeyCheck) -> &'static str {
    match check {
        SshHostKeyCheck::Trusted { .. } => "trusted",
        SshHostKeyCheck::Unknown { .. } => "unknown",
        SshHostKeyCheck::Changed { .. } => "changed",
        SshHostKeyCheck::Revoked { .. } => "revoked",
        SshHostKeyCheck::Unreachable { .. } => "unreachable",
    }
}

/// Refuses an attempt that already ran, and one whose port forwards the user has not accepted.
fn assert_can_connect(state: AttemptState, summary: Option<&SshConfigSummary>, request: &SshConnectRequest) -> Result<(), AttemptError> {
    if state == AttemptState::Connecting || (state == AttemptState::Restartable && request.force_restart != Some(true)) {
        return Err(AttemptError::new("This connection attempt already ran. Check the address again."));
    }
    // Only when Mixdog could not build a config without the user's forwards: they apply, so the user must have accepted them.
    if summary.and_then(|summary| summary.forwards.as_ref()).is_some_and(|forwards| !forwards.is_empty()) && request.accept_forwards != Some(true) {
        return Err(AttemptError::new("Confirm the port forwards before connecting."));
    }
    Ok(())
}

/// What the pre-check saw decides, never what the caller says.
fn decide_host_key(inspection: &HostKeyInspection, request: &SshConnectRequest) -> Result<Decision, AttemptError> {
    Ok(match &inspection.check {
        SshHostKeyCheck::Revoked { .. } => refusal(SshFailureKind::HostKeyRevoked, "host-key-revoked"),
        SshHostKeyCheck::Unreachable { message, ssh_missing } => match ssh_missing {
            Some(SshMissing { command }) => refusal(SshFailureKind::SshMissing { command: command.clone() }, "ssh-missing"),
            None => refusal(SshFailureKind::Failed { message: message.clone() }, "host-key-unreachable"),
        },
        SshHostKeyCheck::Changed { previous, current, .. } => {
            let typed = request.replace_host_key.as_deref().map(|typed| typed.trim().to_lowercase()).unwrap_or_default();
            match &inspection.replace {
                Some(replace) if !typed.is_empty() && typed == replace.host.to_lowercase() => Decision::Proceed(KeyAction::Replace),
                _ => refusal(SshFailureKind::HostKeyChanged { previous: Some(previous.clone()), current: Some(current.clone()) }, "host-key-changed"),
            }
        }
        SshHostKeyCheck::Unknown { .. } => {
            if request.trust_host_key != Some(true) || inspection.pin.is_none() {
                return Err(AttemptError::new("Confirm the server\u{2019}s fingerprint before connecting."));
            }
            Decision::Proceed(KeyAction::Pin)
        }
        SshHostKeyCheck::Trusted { .. } => Decision::Proceed(KeyAction::Nothing),
    })
}

/// A jump chain is confirmed one server at a time: true while a hop's key is still to be saved.
fn has_pending_hop(check: &SshHostKeyCheck) -> bool {
    let hops = match check {
        SshHostKeyCheck::Unknown { hops, .. } | SshHostKeyCheck::Changed { hops, .. } => hops,
        _ => return false,
    };
    hops.as_ref().is_some_and(|hops| hops.iter().any(|hop| hop.status == SshHopStatus::Pending))
}

/// What a saved server remembers, as the ssh code reads it.
pub(crate) fn host_settings(settings: &SshHostSettings) -> HostSettings {
    HostSettings {
        model_login: settings.model_login.map(|_| ModelLogin::Server),
        remote_cwd: settings.remote_cwd.clone(),
        identity_file: settings.identity_file.clone(),
        auto_reconnect: settings.auto_reconnect,
        allowed_providers: settings.allowed_providers.clone(),
        grace_minutes: settings.grace_minutes,
    }
}

/// The ssh context of a saved server: its settings, the grace period always set (the saved one, else the default).
fn context_for(record: &SshHostRecord, target: &SshTarget, force_restart: bool) -> AttemptContext {
    let mut settings = record.settings.as_ref().map(host_settings).unwrap_or_default();
    settings.grace_minutes = Some(settings.grace_minutes.unwrap_or(DEFAULT_GRACE_MINUTES));
    AttemptContext {
        settings: Some(settings),
        force_restart,
        diagnostics_key: Some(diagnostics_key_for(target)),
        askpass: None,
    }
}

fn parse_target(raw: &str) -> Result<SshTarget, AttemptError> {
    parse_ssh_target(raw).map_err(|error| AttemptError::new(error.to_string()))
}

fn phase_of(phase: SessionPhase) -> (SshPhase, Option<String>) {
    match phase {
        SessionPhase::Connect => (SshPhase::Connect, None),
        SessionPhase::Check { detail } => (SshPhase::Check, Some(detail)),
        SessionPhase::Install => (SshPhase::Install, None),
        SessionPhase::Start => (SshPhase::Start, None),
        SessionPhase::Ready => (SshPhase::Ready, None),
    }
}

fn phase_name(phase: SshPhase) -> &'static str {
    match phase {
        SshPhase::Connect => "connect",
        SshPhase::Check => "check",
        SshPhase::Install => "install",
        SshPhase::Start => "start",
        SshPhase::Ready => "ready",
    }
}

fn failed(kind: SshFailureKind, code: &str) -> SshConnectResult {
    SshConnectResult::failed(SshFailure { kind, code: Some(code.to_owned()) })
}

impl Connect {
    pub fn new(deps: ConnectDeps) -> Self {
        Self {
            attempts: deps.attempts,
            machine: deps.machine,
            login: deps.login,
            hosts: deps.hosts,
            windows: deps.windows,
            view: deps.view,
            clock: deps.clock,
            locks: TargetLocks::default(),
        }
    }

    pub fn attempts(&self) -> &Arc<Attempts> {
        &self.attempts
    }

    /// The host-key pre-check: reads what the server presents and opens the attempt that connect and cancel name, bound to `caller`.
    pub async fn inspect(&self, caller: ConnectionId, raw_target: &str) -> Result<SshInspection, AttemptError> {
        let target = parse_target(raw_target)?;
        let inspection = self.machine.inspect(&target).await.map_err(|error| AttemptError::new(error.message))?;
        let key = diagnostics_key_for(&target);
        self.machine.diagnostics().record(
            Some(key.as_str()),
            DiagnosticKind::Log,
            &format!("host key check: {}", status_name(&inspection.check)),
            (self.clock)(),
        );
        let attempt = self.attempts.register(caller, target, inspection)?;
        Ok(SshInspection {
            attempt_id: attempt.id().to_owned(),
            check: attempt.inspection().check.clone(),
            summary: attempt.inspection().summary.clone(),
        })
    }

    /// Cancels the caller's own attempt.
    pub async fn cancel(&self, caller: ConnectionId, attempt_id: &str) {
        self.attempts.cancel(caller, attempt_id).await;
    }

    /// The caller's answer to a question of ssh; `None` cancels it.
    pub fn askpass_reply(&self, caller: ConnectionId, attempt_id: &str, request_id: &str, secret: Option<String>) {
        self.attempts.answer(caller, attempt_id, request_id, secret);
    }

    /// The caller's connection closed: its attempts are cancelled and its pending questions answer nothing.
    pub async fn caller_closed(&self, caller: ConnectionId) {
        self.attempts.caller_closed(caller).await;
    }

    /// Connects the inspected address, saves the server and opens its window.
    pub async fn connect(&self, caller: ConnectionId, attempt_id: &str, request: SshConnectRequest) -> Result<SshConnectResult, AttemptError> {
        let attempt = self.attempts.owned(caller, attempt_id)?;
        // Checked, decided and marked in one step: a second connect call sees an attempt that is connecting.
        let (restart, action, entered) = {
            let mut run = attempt.run();
            assert_can_connect(run.state, attempt.inspection().summary.as_ref(), &request)?;
            // Same validation as the per-server settings; a bad value is refused before anything is pinned or opened.
            let entered = parse_host_settings(&json!({
                "identityFile": request.settings.as_ref().and_then(|settings| settings.identity_file.clone()),
                "remoteCwd": request.settings.as_ref().and_then(|settings| settings.remote_cwd.clone()),
            }))
            .map_err(|error| AttemptError::new(error.to_string()))?;
            let decision = if run.key_handled { Decision::Proceed(KeyAction::Nothing) } else { decide_host_key(attempt.inspection(), &request)? };
            match decision {
                Decision::Refused(result) => {
                    drop(run);
                    self.attempts.drop_attempt(&attempt);
                    return Ok(result);
                }
                Decision::Proceed(action) => {
                    let restart = run.state == AttemptState::Restartable;
                    run.state = AttemptState::Connecting;
                    (restart, action, entered)
                }
            }
        };
        let outcome = self.connect_serialized(&attempt, restart, action, &entered).await;
        let still_connecting = attempt.run().state == AttemptState::Connecting;
        if still_connecting {
            self.attempts.drop_attempt(&attempt);
        }
        outcome
    }

    /// Validate, open and save run one at a time per server: a queued attempt sees what the first one left (a live connection, the
    /// saved settings) instead of reusing its connection with settings it never tested.
    async fn connect_serialized(
        &self,
        attempt: &Arc<Attempt>,
        restart: bool,
        action: KeyAction,
        entered: &SshHostSettings,
    ) -> Result<SshConnectResult, AttemptError> {
        let _turn = self.locks.lock(&attempt.target().key()).await;
        // Cancelled (or its connection closed) while queued: no trust is changed for it.
        if attempt.cancelled() {
            return Ok(cancelled());
        }
        let target = attempt.target();
        let reservation = self.hosts.reserve_for_target(&target.display).map_err(|error| AttemptError::new(error.to_string()))?;
        // The entered settings ride the record: the context puts the key file on this attempt's ssh argv, and the save keeps them.
        let mut record = reservation.record.clone();
        if !entered.is_empty() {
            let mut settings = record.settings.clone().unwrap_or_default();
            if entered.remote_cwd.is_some() {
                settings.remote_cwd.clone_from(&entered.remote_cwd);
            }
            if entered.identity_file.is_some() {
                settings.identity_file.clone_from(&entered.identity_file);
            }
            record.settings = Some(settings);
        }
        let was_open = self.attempts.links().is_open(&record.id);
        {
            let mut run = attempt.run();
            run.record_id.clone_from(&record.id);
            run.was_open = was_open;
        }
        // A live connection is reused without logging in again, so a new key or folder would be saved untested.
        let saved = reservation.record.settings.clone().unwrap_or_default();
        if was_open
            && ((entered.remote_cwd.is_some() && entered.remote_cwd != saved.remote_cwd)
                || (entered.identity_file.is_some() && entered.identity_file != saved.identity_file))
        {
            return Ok(SshConnectResult::failed(SshFailure { kind: SshFailureKind::AlreadyConnected, code: None }));
        }
        match action {
            KeyAction::Replace => self.machine.replace(attempt.inspection()).await.map_err(|error| AttemptError::new(error.message))?,
            KeyAction::Pin => self.machine.pin(attempt.inspection()).map_err(|error| AttemptError::new(error.message))?,
            KeyAction::Nothing => {}
        }
        attempt.run().key_handled = true;
        if attempt.cancelled() {
            return Ok(cancelled());
        }
        // A jump chain is confirmed one server at a time: this key is saved, the next one is checked.
        if has_pending_hop(&attempt.inspection().check) {
            return Ok(SshConnectResult::failed(SshFailure { kind: SshFailureKind::HostKeyNext, code: None }));
        }
        let progress = self.progress_reporter(attempt);
        let base = context_for(&record, target, restart);
        let prompter = self.attempts.prompter(attempt.clone(), target.label().to_owned());
        let result = with_login_retry(
            self.login.as_ref(),
            prompter,
            base,
            |context| self.open_link(&record, target, Some(progress.clone()), Some(attempt), context),
            || attempt.cancelled(),
        )
        .await;
        // A daemon outside proxy mode, or one of another version, is the failure the attempt outlives: the user may restart exactly
        // that connection.
        if let SshConnectResult::Failed(failure) = &result {
            if matches!(failure.failure.kind, SshFailureKind::DaemonRunning { .. } | SshFailureKind::DaemonBusy { .. }) && !attempt.cancelled() {
                attempt.run().state = AttemptState::Restartable;
            }
        }
        self.saved(result, &record).await
    }

    /// Tells the log and, unless the attempt was cancelled, the connection how the connection is going.
    fn progress_reporter(&self, attempt: &Arc<Attempt>) -> Progress {
        let attempts = self.attempts.clone();
        let attempt = attempt.clone();
        let diagnostics = self.machine.diagnostics();
        let clock = self.clock.clone();
        let key = diagnostics_key_for(attempt.target());
        Arc::new(move |phase| {
            let (phase, detail) = phase_of(phase);
            let line = format!("{}{}", phase_name(phase), detail.as_ref().map(|detail| format!(": {detail}")).unwrap_or_default());
            diagnostics.record(Some(key.as_str()), DiagnosticKind::Phase, &line, clock());
            if !attempt.cancelled() {
                attempts.push().progress(attempt.caller(), SshProgress { attempt_id: attempt.id().to_owned(), phase, detail });
            }
        })
    }

    /// Attaches the server's link and puts its window forward. A cancelled attempt neither shows a window nor leaves the link it
    /// just opened.
    async fn open_link(
        &self,
        record: &SshHostRecord,
        target: &SshTarget,
        progress: Option<Progress>,
        attempt: Option<&Arc<Attempt>>,
        context: AttemptContext,
    ) -> SshConnectResult {
        let spec = LinkSpec { id: record.id.clone(), name: record.name.clone(), target: target.clone() };
        if let Err(error) = self.attempts.links().open(spec, context, progress).await {
            return SshConnectResult::failed(failure_of(&error, target, self.machine.platform()).into_failure());
        }
        if let Some(attempt) = attempt.filter(|attempt| attempt.cancelled()) {
            if !attempt.run().was_open {
                self.attempts.links().close(&record.id).await;
            }
            return cancelled();
        }
        if let Err(message) = self.windows.open(&record.id, &record.name).await {
            return failed(SshFailureKind::Failed { message }, "window-open");
        }
        SshConnectResult::connected((self.view)(record))
    }

    /// Saves the server once its window is up.
    async fn saved(&self, result: SshConnectResult, record: &SshHostRecord) -> Result<SshConnectResult, AttemptError> {
        if !matches!(result, SshConnectResult::Connected(_)) {
            return Ok(result);
        }
        let stamped = SshHostRecord { last_connected_at: Some((self.clock)().into()), ..record.clone() };
        let saved = self.hosts.save(stamped).await.map_err(|error| AttemptError::new(error.to_string()))?;
        Ok(SshConnectResult::connected((self.view)(&saved)))
    }

    /// Focuses a saved server whose link is attached.
    pub async fn open(&self, id: &str) -> Result<SshConnectResult, AttemptError> {
        let record = self.hosts.get(id).ok_or_else(|| AttemptError::new("This SSH server is no longer saved."))?;
        if !self.attempts.links().is_open(&record.id) {
            return Err(AttemptError::new("This SSH server is not connected. Connect it from the SSH server dialog."));
        }
        let target = parse_target(&record.target)?;
        let result = self.open_link(&record, &target, None, None, context_for(&record, &target, false)).await;
        self.saved(result, &record).await
    }

    /// The window of the target named by `MIXDOG_SSH_TARGET` (development and tests): connected like a saved server, never saved.
    pub async fn open_ephemeral(&self, raw_target: &str, name: &str) -> Result<SshConnectResult, AttemptError> {
        let target = parse_target(raw_target)?;
        let remote_cwd = self.machine.var(REMOTE_CWD_VAR).map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
        let record = SshHostRecord { id: EPHEMERAL_ID.to_owned(), name: name.to_owned(), target: target.display.clone(), last_connected_at: None, settings: None };
        let context = AttemptContext {
            settings: remote_cwd.map(|remote_cwd| HostSettings { remote_cwd: Some(remote_cwd), ..HostSettings::default() }),
            diagnostics_key: Some(diagnostics_key_for(&target)),
            ..AttemptContext::default()
        };
        Ok(self.open_link(&record, &target, None, None, context).await)
    }
}

/// A lock per target: held from the check to the end of the save.
#[derive(Default)]
struct TargetLocks {
    held: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

struct TargetTurn<'a> {
    locks: &'a TargetLocks,
    key: String,
    mutex: Arc<tokio::sync::Mutex<()>>,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl TargetLocks {
    async fn lock(&self, key: &str) -> TargetTurn<'_> {
        let mutex = self.held.lock().unwrap_or_else(PoisonError::into_inner).entry(key.to_owned()).or_default().clone();
        let guard = mutex.clone().lock_owned().await;
        TargetTurn { locks: self, key: key.to_owned(), mutex, guard: Some(guard) }
    }
}

impl Drop for TargetTurn<'_> {
    fn drop(&mut self) {
        self.guard = None;
        let mut held = self.locks.held.lock().unwrap_or_else(PoisonError::into_inner);
        // Only the map and this turn hold it: nobody is queued.
        if Arc::strong_count(&self.mutex) == 2 {
            held.remove(&self.key);
        }
    }
}

#[cfg(test)]
#[path = "connect_tests.rs"]
mod connect_tests;
