//! The `update` domain: `update/getUpdateStatus`, `update/checkForUpdate`,
//! `update/runUpdateNow` and `update/desktop/command`.
//!
//! The first three are the self-update controller of the 1.4.5 daemon
//! (`src/session-runtime/self-update.mjs`, `settings-system-api.mjs`): a registry check of
//! the `latest` dist-tag cached in `update-check-cache.json` for 24 h, and a staged install
//! of the version found. What stages and applies a version is the installer's
//! ([`UpdateInstaller`]). `update/desktop/command` has the desktop updater check or install,
//! through `host/update/command`; its state comes back as `host/update/report`.

use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::ReqwestLink;
use mixdog_ai::transport::TransportKind;
use mixdog_ai::transport::deadlines::UPDATE_CHECK;
use mixdog_app_protocol::v2::host::UpdateDesktopCommandParams;
use mixdog_app_protocol::v2::host::UpdaterAction;
use mixdog_app_protocol::v2::params::ConfigSetAutoUpdateParams;
use mixdog_app_protocol::v2::params::UpdateCheckForUpdateParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use mixdog_core_config::config::Settings;
use mixdog_core_config::tool_modules::ToolModulesError;

use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::on_lane;
use mixdog_core_base::support::wrong_method;

const DOMAIN: &str = "update";
/// `https://registry.npmjs.org/mixdog/latest`.
pub const REGISTRY_URL: &str = "https://registry.npmjs.org/mixdog/latest";
const CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const CACHE_FILE: &str = "update-check-cache.json";

/// Stages the next version; the swap into place happens at the next clean launch.
#[async_trait]
pub trait UpdateInstaller: Send + Sync {
    /// A source checkout or any install that is not a normal package: never self-updated.
    fn is_dev_install(&self) -> bool;
    /// Stages and verifies `version`. `Ok` carries the version actually staged when it differs;
    /// `Err` is the failure text the user reads (`npm install exited with code 1`, …).
    async fn stage(&self, version: &str) -> Result<Option<String>, String>;
    /// `isStagedComplete(version)`: a verified package of `version` sits in the staging area.
    async fn is_staged(&self, version: &str) -> bool;
}

/// One GET of the registry: `Some` when a response arrived, whatever its status.
pub struct RegistryAnswer {
    pub success: bool,
    pub body: Vec<u8>,
}

/// The registry the update check asks. Production is [`ReqwestRegistry`]; tests inject a fake, so
/// none of them reaches a network.
#[async_trait]
pub trait RegistryHttp: Send + Sync {
    async fn get(&self, url: &str) -> Option<RegistryAnswer>;
}

/// The real registry client (`fetch` of `update-checker.mjs`, the `UPDATE_CHECK` deadline).
pub struct ReqwestRegistry;

#[async_trait]
impl RegistryHttp for ReqwestRegistry {
    async fn get(&self, url: &str) -> Option<RegistryAnswer> {
        let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).ok()?;
        let request = WireRequest {
            transport: TransportKind::Http1,
            method: "GET".to_owned(),
            url: url.to_owned(),
            headers: Vec::new(),
            body: Vec::new(),
        };
        let response = link.send(request, UPDATE_CHECK).await.ok()?;
        let success = response.is_success();
        if !success {
            return Some(RegistryAnswer { success, body: Vec::new() });
        }
        Some(RegistryAnswer { success, body: response.read_all().await.ok()?.body })
    }
}

/// `STAGE_POLL_MS` and `STAGE_POLL_MAX_MS` of `self-update.mjs`.
const STAGE_POLL: std::time::Duration = std::time::Duration::from_secs(3);
const STAGE_POLL_MAX: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Stores the `update.auto` switch (`setAutoUpdate`'s `saveConfigAndAdopt`). The config
/// actor's [`Settings`] is the production implementation.
#[async_trait]
pub trait AutoUpdateSwitch: Send + Sync {
    async fn set(&self, enabled: &Value) -> Result<(), CoreError>;
}

#[async_trait]
impl AutoUpdateSwitch for Settings {
    async fn set(&self, enabled: &Value) -> Result<(), CoreError> {
        self.set_auto_update(enabled)
            .await
            .map_err(|error| match error {
                ToolModulesError::InvalidArgument(message) => CoreError::InvalidParams {
                    path: "params".into(),
                    expected: message.into(),
                },
                ToolModulesError::Failed(message) => failed("config", message),
                ToolModulesError::Config(error) => failed("config", error.to_string()),
            })
    }
}

pub struct UpdateConfig {
    /// The running version (`package.json` `version`).
    pub current_version: String,
    /// [`REGISTRY_URL`], except in tests.
    pub registry_url: String,
    /// What asks the registry.
    pub registry: Arc<dyn RegistryHttp>,
    /// `emitNotification('update ready', { kind: 'update-notice', version })`: tells the user a
    /// staged version waits for a restart.
    pub ready_notice: Arc<dyn Fn(&str) + Send + Sync>,
    pub data_dir: PathBuf,
    /// `config.update.auto !== false`, read on each use.
    pub auto_update: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Where `config/setAutoUpdate` stores the switch that `auto_update` reads back.
    pub auto_switch: Arc<dyn AutoUpdateSwitch>,
}

/// `parseSemver`: numbers of the core part (0 where not a number), then the prerelease ids.
fn parse_semver(value: &str) -> (Vec<f64>, Vec<String>) {
    let trimmed = value.trim_matches(mixdog_core_base::support::is_js_space);
    let text = trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed);
    let text = text.split('+').next().unwrap_or("");
    let (core, pre) = match text.find('-') {
        Some(dash) => (
            &text[..dash],
            text[dash + 1..].split('.').map(str::to_owned).collect(),
        ),
        None => (text, Vec::new()),
    };
    let mut parts: Vec<f64> = core
        .split('.')
        .map(|n| {
            // `Number.parseInt(n, 10)`: the leading digits, else NaN, which reads as 0.
            let n = n.trim_start_matches(mixdog_core_base::support::is_js_space);
            let n = n.strip_prefix('+').unwrap_or(n);
            let digits: String = n.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<f64>().unwrap_or(0.0)
        })
        .collect();
    while parts.len() < 3 {
        parts.push(0.0);
    }
    (parts, pre)
}

/// Numeric identifiers compare numerically and rank below alphanumeric ones, which compare in
/// ASCII order.
fn compare_identifiers(a: &str, b: &str) -> Ordering {
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    match (numeric(a), numeric(b)) {
        (true, true) => {
            let (a, b) = (a.trim_start_matches('0'), b.trim_start_matches('0'));
            a.len().cmp(&b.len()).then_with(|| a.cmp(b))
        }
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.cmp(b),
    }
}

/// `compareSemver`: a prerelease ranks below its release; of two prereleases sharing every
/// identifier the shorter is lower.
pub fn compare_semver(a: &str, b: &str) -> Ordering {
    let (a_core, a_pre) = parse_semver(a);
    let (b_core, b_pre) = parse_semver(b);
    for i in 0..3 {
        let (x, y) = (a_core[i], b_core[i]);
        if x != y {
            return if x > y {
                Ordering::Greater
            } else {
                Ordering::Less
            };
        }
    }
    if a_pre.is_empty() || b_pre.is_empty() {
        return match (a_pre.is_empty(), b_pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (false, _) => Ordering::Less,
            _ => Ordering::Greater,
        };
    }
    for (x, y) in a_pre.iter().zip(&b_pre) {
        let order = compare_identifiers(x, y);
        if order != Ordering::Equal {
            return order;
        }
    }
    a_pre.len().cmp(&b_pre.len())
}

fn is_newer(latest: Option<&str>, current: &str) -> bool {
    latest.is_some_and(|latest| {
        !latest.is_empty()
            && !current.is_empty()
            && compare_semver(latest, current) == Ordering::Greater
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The result of `checkLatestVersion`.
#[derive(Clone, Debug, PartialEq)]
pub struct Checked {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub last_checked_at: Value,
    pub from_cache: bool,
}

struct Cache {
    latest_version: Option<String>,
    last_checked_at: Value,
}

#[allow(clippy::disallowed_methods, reason = "body of an interactive-io lane job")]
fn read_cache(dir: &std::path::Path) -> Option<Cache> {
    let Ok(Value::Object(raw)) = serde_json::from_slice(&std::fs::read(dir.join(CACHE_FILE)).ok()?)
    else {
        return None;
    };
    Some(Cache {
        latest_version: raw
            .get("latestVersion")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned),
        last_checked_at: raw.get("lastCheckedAt").cloned().unwrap_or(Value::Null),
    })
}

/// Best effort: a cache that cannot be written only costs the next call a fetch.
fn write_cache(lane: &InLane<DurabilityIo>, dir: &std::path::Path, latest: &str, at: i64) {
    let text = json!({ "latestVersion": latest, "lastCheckedAt": at }).to_string();
    let _ = mixdog_core_base::support::write_atomic(lane, &dir.join(CACHE_FILE), text.as_bytes(), false);
}

#[derive(Clone)]
struct CheckState {
    current_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    last_checked_at: Value,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Checking,
    Installing,
    Installed,
    Failed,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Checking => "checking",
            Phase::Installing => "installing",
            Phase::Installed => "installed",
            Phase::Failed => "failed",
        }
    }
}

#[derive(Clone)]
struct ProcessState {
    phase: Phase,
    version: Option<String>,
    error: Option<String>,
}

impl ProcessState {
    fn idle() -> Self {
        Self {
            phase: Phase::Idle,
            version: None,
            error: None,
        }
    }

    fn json(&self) -> Map<String, Value> {
        let mut state = Map::new();
        state.insert("phase".into(), json!(self.phase.name()));
        state.insert("version".into(), json!(self.version));
        state.insert("error".into(), json!(self.error));
        state
    }
}

struct State {
    check: CheckState,
    process: ProcessState,
}

pub struct UpdateService {
    config: UpdateConfig,
    installer: Arc<dyn UpdateInstaller>,
    host: Arc<dyn HostChannel>,
    ops: OpScopes,
    /// The `config` scope's gates, for `config/setAutoUpdate` (`thread_or_global`).
    config_ops: OpScopes,
    interactive: InteractiveIo,
    durability: DurabilityIo,
    state: Mutex<State>,
}

impl UpdateService {
    /// Commands go to the desktop that declared `updater`.
    pub fn new(
        config: UpdateConfig,
        installer: Arc<dyn UpdateInstaller>,
        host: Arc<dyn HostChannel>,
        ops: OpScopes,
        config_ops: OpScopes,
        tokens: &LaneTokens,
    ) -> Arc<Self> {
        Arc::new(Self {
            config,
            installer,
            host,
            ops,
            config_ops,
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            state: Mutex::new(State {
                check: CheckState {
                    current_version: None,
                    latest_version: None,
                    update_available: false,
                    last_checked_at: json!(0),
                },
                process: ProcessState::idle(),
            }),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn fetch_latest(&self) -> Option<String> {
        let answer = self.config.registry.get(&self.config.registry_url).await?;
        if !answer.success {
            return None;
        }
        let body: Value = serde_json::from_slice(&answer.body).ok()?;
        let version = match body.get("version") {
            Some(Value::String(version)) => mixdog_core_base::support::js_trim(version).to_owned(),
            _ => String::new(),
        };
        (!version.is_empty()).then_some(version)
    }

    /// `checkLatestVersion({force})`: never fails.
    pub async fn check_latest(
        &self,
        cancel: &mixdog_rt::CancellationToken,
        force: bool,
    ) -> Checked {
        let current = self.config.current_version.clone();
        let dir = self.config.data_dir.clone();
        let cache = if force {
            None
        } else {
            let dir = dir.clone();
            on_lane(self.interactive, cancel, move |_| read_cache(&dir))
                .await
                .ok()
                .flatten()
        };
        let now = now_ms();
        if let Some(cache) = &cache
            && let Some(at) = cache.last_checked_at.as_f64()
            && (now as f64) - at < CACHE_TTL_MS as f64
        {
            return Checked {
                update_available: is_newer(cache.latest_version.as_deref(), &current),
                latest_version: cache.latest_version.clone(),
                last_checked_at: cache.last_checked_at.clone(),
                from_cache: true,
                current_version: current,
            };
        }
        if let Some(latest) = self.fetch_latest().await {
            let (to, version) = (dir.clone(), latest.clone());
            let _ = on_lane(self.durability, cancel, move |lane| {
                write_cache(lane, &to, &version, now)
            })
            .await;
            return Checked {
                update_available: is_newer(Some(&latest), &current),
                latest_version: Some(latest),
                last_checked_at: json!(now),
                from_cache: false,
                current_version: current,
            };
        }
        // Registry unreachable: a stale cache, read again for a forced call, beats no answer.
        let stale = match cache {
            Some(cache) => Some(cache),
            None => on_lane(self.interactive, cancel, move |_| read_cache(&dir))
                .await
                .ok()
                .flatten(),
        };
        if let Some(stale) = stale
            && stale.latest_version.is_some()
        {
            let at = match stale.last_checked_at.as_f64() {
                Some(at) if at != 0.0 => stale.last_checked_at.clone(),
                _ => json!(now),
            };
            return Checked {
                update_available: is_newer(stale.latest_version.as_deref(), &current),
                latest_version: stale.latest_version,
                last_checked_at: at,
                from_cache: true,
                current_version: current,
            };
        }
        Checked {
            current_version: current,
            latest_version: None,
            update_available: false,
            last_checked_at: json!(now),
            from_cache: false,
        }
    }

    /// `checkForUpdate({force})` of the controller: remembers the result, moves the phase
    /// through `checking` unless an install runs.
    async fn check_for_update(&self, cancel: &mixdog_rt::CancellationToken, force: bool) {
        {
            let mut state = self.state();
            if state.process.phase != Phase::Installing {
                state.process.phase = Phase::Checking;
            }
        }
        let checked = self.check_latest(cancel, force).await;
        let mut state = self.state();
        state.check = Self::check_state(checked);
        if state.process.phase == Phase::Checking {
            state.process.phase = Phase::Idle;
        }
    }

    fn check_state(checked: Checked) -> CheckState {
        CheckState {
            current_version: Some(checked.current_version),
            latest_version: checked.latest_version,
            update_available: checked.update_available,
            last_checked_at: checked.last_checked_at,
        }
    }

    /// `startBootCheck()` of the controller (`self-update.mjs`), run once right after boot: one
    /// forced registry check (`checkLatestVersion({ force: true })`), remembered as the check
    /// state without touching the phase. When `update.auto` is on, this is not a dev install and
    /// a newer version was found, that version is staged in the background and announced once
    /// the staging is complete ([`Self::stage_and_announce`]).
    pub fn start_boot_check(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let service = self.clone();
        mixdog_rt::spawn("update-boot-check", mixdog_rt::TaskClass::Work, async move {
            let checked = service.check_latest(&mixdog_rt::CancellationToken::new(), true).await;
            let version = checked.latest_version.clone().filter(|_| checked.update_available);
            service.state().check = Self::check_state(checked);
            if let Some(version) = version
                && (service.config.auto_update)()
                && !service.installer.is_dev_install()
            {
                service.stage_and_announce(&version).await;
            }
        })
    }

    /// The staging half of `startBootCheck`: a version already staged is announced at once;
    /// otherwise it is staged (best effort, like the detached `spawnStagedInstall`: a failure is
    /// retried by the next launch) and its completion polled every 3 s for up to 10 min. The
    /// notice goes out once, when the staging is complete, never upfront.
    async fn stage_and_announce(&self, version: &str) {
        if self.installer.is_staged(version).await {
            (self.config.ready_notice)(version);
            return;
        }
        let _ = self.installer.stage(version).await;
        let mut waited = std::time::Duration::ZERO;
        while waited <= STAGE_POLL_MAX {
            if self.installer.is_staged(version).await {
                (self.config.ready_notice)(version);
                return;
            }
            mixdog_rt::time::sleep(STAGE_POLL).await;
            waited += STAGE_POLL;
        }
    }

    /// `getUpdateSettings()`.
    pub fn settings(&self) -> Value {
        let check = self.state().check.clone();
        json!({
            "autoUpdate": (self.config.auto_update)(),
            "currentVersion": check.current_version.unwrap_or_else(|| self.config.current_version.clone()),
            "latestVersion": check.latest_version,
            "updateAvailable": check.update_available,
            "lastCheckedAt": check.last_checked_at,
        })
    }

    /// `runUpdateNow()` of the controller, then `{ ok: phase === 'installed', ...state }`.
    async fn run_update_now(&self) -> Value {
        let latest = {
            let mut state = self.state();
            if state.process.phase == Phase::Installing {
                let mut busy = state.process.json();
                busy.insert("alreadyInstalling".into(), json!(true));
                busy.insert("error".into(), json!("update already in progress"));
                busy.insert("ok".into(), json!(false));
                return Value::Object(busy);
            }
            if self.installer.is_dev_install() {
                state.process = ProcessState {
                    phase: Phase::Failed,
                    version: None,
                    error: Some("dev install — update skipped".into()),
                };
                return Self::with_ok(&state.process);
            }
            let latest = state.check.latest_version.clone();
            let available = state.check.update_available;
            match latest.filter(|_| available) {
                Some(version) => {
                    state.process = ProcessState {
                        phase: Phase::Installing,
                        version: Some(version.clone()),
                        error: None,
                    };
                    version
                }
                None => {
                    state.process = ProcessState::idle();
                    let mut none = state.process.json();
                    none.insert("error".into(), json!("no update available"));
                    none.insert("ok".into(), json!(false));
                    return Value::Object(none);
                }
            }
        };
        // "Update now" stages the new version rather than installing over the live one; the
        // swap applies on the next launch. `installed` here means staged and ready.
        let result = self.installer.stage(&latest).await;
        let mut state = self.state();
        state.process = match result {
            Ok(staged) => ProcessState {
                phase: Phase::Installed,
                version: Some(staged.unwrap_or(latest)),
                error: None,
            },
            Err(error) => ProcessState {
                phase: Phase::Failed,
                version: None,
                error: Some(if error.is_empty() {
                    "update failed".into()
                } else {
                    error
                }),
            },
        };
        Self::with_ok(&state.process)
    }

    fn with_ok(process: &ProcessState) -> Value {
        let mut state = process.json();
        state.insert("ok".into(), json!(process.phase == Phase::Installed));
        Value::Object(state)
    }

    async fn ops_run<E, EF, R, RF>(
        &self,
        req: &CoreRequest,
        external: Option<(&'static str, String)>,
        execute: E,
        reproduce: R,
    ) -> Result<Value, CoreError>
    where
        E: FnOnce() -> EF,
        EF: std::future::Future<Output = Result<Value, CoreError>>,
        R: FnOnce() -> RF,
        RF: std::future::Future<Output = Result<Value, CoreError>>,
    {
        Self::value_of(self.ops.run(req, external, execute, reproduce).await?)
    }

    fn value_of(reply: Reply) -> Result<Value, CoreError> {
        match reply {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Err(CoreError::Internal {
                incident_id: "update-subscribe".into(),
            }),
        }
    }

    async fn desktop_command(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: UpdateDesktopCommandParams = decode(req)?;
        let action = match params.action {
            UpdaterAction::Check => "check",
            UpdaterAction::Install => "install",
        };
        let command = match (params.action, params.confirmed) {
            (UpdaterAction::Install, Some(confirmed)) => json!({ "action": action, "confirmed": confirmed }),
            _ => json!({ "action": action }),
        };
        self.ops_run(
            req,
            Some(("host.update.command", action.to_owned())),
            || async {
                match self
                    .host
                    .request_scoped(
                        HostCapability::Updater,
                        Method("host/update/command"),
                        command.clone(),
                        &req.ctx.cancel,
                    )
                    .await
                {
                    Ok(value) => Ok(value),
                    Err(HostError::Core(error)) => Err(error),
                    Err(HostError::Rpc { message, .. }) => Err(CoreError::DomainError {
                        domain: DOMAIN.into(),
                        code: None,
                        message: Some(message.into()),
                        detail: None,
                    }),
                }
            },
            || async { Ok(json!({})) },
        )
        .await
    }
}

#[async_trait]
impl DomainService for UpdateService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let value = match req.method.as_str() {
            "update/getUpdateStatus" => Value::Object(self.state().process.json()),
            "update/checkForUpdate" => {
                let params: UpdateCheckForUpdateParams = decode(&req)?;
                let force = params.options.as_ref().and_then(|o| o.get("force"))
                    == Some(&Value::Bool(true));
                self.ops_run(
                    &req,
                    None,
                    || async {
                        self.check_for_update(&req.ctx.cancel, force).await;
                        Ok(self.settings())
                    },
                    || async { Ok(self.settings()) },
                )
                .await?
            }
            "update/runUpdateNow" => {
                self.ops_run(
                    &req,
                    Some(("update.stage", "latest".into())),
                    || async { Ok(self.run_update_now().await) },
                    || async { Ok(Self::with_ok(&self.state().process)) },
                )
                .await?
            }
            "update/desktop/command" => self.desktop_command(&req).await?,
            // Two `config/*` methods this service declares: the answer is the updater's view,
            // and only the stored switch is the config's, so the op runs in the config scope.
            "config/getUpdateSettings" => self.settings(),
            "config/setAutoUpdate" => {
                let params: ConfigSetAutoUpdateParams = decode(&req)?;
                Self::value_of(
                    self.config_ops
                        .run(
                            &req,
                            None,
                            || async {
                                self.config
                                    .auto_switch
                                    .set(&Value::Bool(params.enabled))
                                    .await?;
                                Ok(self.settings())
                            },
                            || async { Ok(self.settings()) },
                        )
                        .await?,
                )?
            }
            other => return Err(wrong_method(DOMAIN, other)),
        };
        Ok(Reply::Value(value))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "update/getUpdateStatus",
            "update/checkForUpdate",
            "update/runUpdateNow",
            "update/desktop/command",
            "config/getUpdateSettings",
            "config/setAutoUpdate",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests;
