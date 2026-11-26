//! Each agent's CLI on this machine: where it is, whether it can run a session, and getting it
//! installed and current. One check of a preset runs at a time and every asker shares it; a check
//! is a task that owns its processes, so cancelling it ends them.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_protocol::ThreadId;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::agents::AUTH_REQUIRED;
use crate::agents::AccountEvent;
use crate::agents::Agents;
use crate::agents::Readiness;
use crate::agents::lock;
use crate::connection::Connection;
use crate::connection::Fault;
use crate::connection::Launch;
use crate::connection::Ran;
use crate::connection::Temp;
use crate::connection::run_to_exit;
use crate::preset::AgentPreset;
use crate::preset::Distribution;
use crate::preset::Login;
use crate::preset::ProcessScope;
use crate::preset::UsageReport;
use crate::preset::Version;
use crate::session::AgentModel;
use crate::session::Models;
use crate::session::Program;
use crate::session::close_session;
use crate::session::initialize;
use crate::session::launch;
use crate::session::offered;

/// The file of the feature's folder that keeps what each registry agent last told of itself.
const PROBE_CACHE: &str = "probe-cache.json";
/// How long a server started to learn what it tells of itself is given to open a session.
const PROBE_LIMIT: std::time::Duration = std::time::Duration::from_secs(30);

/// What an agent started for a check answered.
enum Probe {
    Opened {
        capabilities: Value,
        answer: Value,
    },
    /// It names no version, or one below the preset's minimum, in `initialize`: it was asked nothing more.
    TooOld(Option<Version>),
    /// It asked for a sign-in in the browser.
    SignIn,
}

/// Opens a session in the agent `connection` runs, which it is asked to forget again where it closes sessions. With a
/// `minimum`, an agent whose `initialize` names no version or an older one is asked nothing more.
async fn open_probe(connection: &Connection, cwd: &AbsPath, minimum: Option<Version>) -> Result<Probe, Fault> {
    let capabilities = initialize(connection).await?;
    if let Some(minimum) = minimum {
        let named = capabilities.pointer("/agentInfo/version").and_then(Value::as_str).and_then(Version::find);
        if named.is_none_or(|found| found < minimum) {
            return Ok(Probe::TooOld(named));
        }
    }
    let answer = open_told(connection, cwd, &capabilities).await?;
    Ok(Probe::Opened { capabilities, answer })
}

/// Opens a session in the initialized agent `connection` runs, for what it answers of itself, and asks it to forget the
/// session again where its `capabilities` close sessions.
async fn open_told(connection: &Connection, cwd: &AbsPath, capabilities: &Value) -> Result<Value, Fault> {
    let answer = connection.request("session/new", json!({ "cwd": cwd.as_path().to_string_lossy(), "mcpServers": [] })).await?;
    if offered(capabilities.pointer("/agentCapabilities/sessionCapabilities/close"))
        && let Some(id) = answer.get("sessionId").and_then(Value::as_str)
    {
        close_session(connection, id).await;
    }
    Ok(answer)
}

/// What `preset`'s agent told of itself in its `capabilities` and the `answer` to a session it opened; `version` where
/// it names none.
fn told(preset: &AgentPreset, capabilities: &Value, answer: &Value, version: String) -> Probed {
    let version = capabilities.pointer("/agentInfo/version").and_then(Value::as_str).map_or(version, str::to_owned);
    Probed { version, models: Models::of(answer), account: account_of(preset, capabilities, answer) }
}

/// Resolves once the agent wrote the line `link` starts, which asks for a sign-in in the browser; never for an agent that
/// writes none.
async fn asks_sign_in(lines: &mut mpsc::UnboundedReceiver<String>, link: Option<&str>) {
    if let Some(link) = link {
        while let Some(line) = lines.recv().await {
            if line.contains(link) {
                return;
            }
        }
    }
    std::future::pending().await
}

/// What a check finds of an agent whose session could not be opened for `fault`.
fn unopened(fault: Fault, version: Option<String>) -> Readiness {
    match fault {
        Fault::NotFound => Readiness::NotInstalled,
        Fault::Rpc(error) if error.code == AUTH_REQUIRED => Readiness::SignedOut { version: version.unwrap_or_default(), message: error.message },
        fault => Readiness::Failed { version, message: fault.to_string() },
    }
}

/// The name of the plan the signed-in account is on, as `preset`'s agent gives it in a session's `answer`.
pub(crate) fn plan_of(preset: &AgentPreset, answer: &Value) -> Option<String> {
    let path = preset.quirks.plan_name.as_ref()?;
    let named = path.iter().try_fold(answer.get("_meta")?, |at, key| at.get(key))?;
    named.as_str().map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned)
}

/// What the agent's `initialize` answer `capabilities` and a session's `answer` tell of the account.
pub(crate) fn account_of(preset: &AgentPreset, capabilities: &Value, answer: &Value) -> Account {
    let sign_out = capabilities.pointer("/agentCapabilities/auth/logout").is_some_and(|logout| !logout.is_null() && logout != &Value::Bool(false));
    Account { plan: plan_of(preset, answer), sign_out }
}

/// What a registry agent last told of itself, kept across a restart of the app so that a check starts nothing for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Probed {
    /// The version it named in `initialize`.
    pub(crate) version: String,
    pub(crate) models: Models,
    pub(crate) account: Account,
}

impl Probed {
    fn value(&self) -> Value {
        let available: Vec<Value> = self.models.available.iter().map(|model| json!({ "id": model.id, "name": model.name })).collect();
        json!({
            "version": self.version,
            "models": { "available": available, "current": self.models.current, "configOption": self.models.config_option },
            "plan": self.account.plan,
            "signOut": self.account.sign_out,
        })
    }

    fn read(value: &Value) -> Option<Self> {
        let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
        let models = value.get("models")?;
        let available = models
            .get("available")?
            .as_array()?
            .iter()
            .filter_map(|model| Some(AgentModel { id: model.get("id")?.as_str()?.to_owned(), name: model.get("name")?.as_str()?.to_owned() }));
        Some(Self {
            version: text(value.get("version"))?,
            models: Models { available: available.collect(), current: text(models.get("current")), config_option: text(models.get("configOption")) },
            account: Account { plan: text(value.get("plan")), sign_out: value.get("signOut").and_then(Value::as_bool).unwrap_or(false) },
        })
    }
}

/// What a running check is doing, as the Settings row words it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Checking,
    Installing,
    Updating,
}

impl Step {
    pub fn state(self) -> &'static str {
        match self {
            Self::Checking => "checking",
            Self::Installing => "installing",
            Self::Updating => "updating",
        }
    }
}

/// The upkeep that failed last.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Install,
    Update,
}

impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Update => "update",
        }
    }
}

/// How far a check goes beyond looking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    /// Looks only: a turn's check, and the one after a sign-in.
    Look,
    /// Brings a CLI that is there to its newest version first: the feature's own checks (first look after the
    /// app started or the feature was turned on, and a re-check).
    Refresh,
    /// Also installs a CLI that is not there: the feature's install step.
    Install,
}

pub(crate) struct Running {
    id: u64,
    /// What it is doing, which a turn waiting on it follows.
    step: watch::Sender<Step>,
    cancel: CancellationToken,
    done: watch::Receiver<bool>,
}

#[cfg(test)]
impl Running {
    pub(crate) fn for_test(step: watch::Sender<Step>, cancel: CancellationToken, done: watch::Receiver<bool>) -> Self {
        Self { id: 1, step, cancel, done }
    }
}

#[derive(Default)]
pub(crate) struct Slot {
    /// What the last finished check found; `None` before the first.
    pub(crate) readiness: Option<Readiness>,
    /// The program as the last check found it: the preset's command, its file where the installer puts it, or the
    /// build Mixdog installed.
    pub(crate) program: Option<Program>,
    pub(crate) running: Option<Running>,
    fault: Option<(Action, String)>,
    /// Sessions being started on the CLI: it is not replaced under them.
    starting: usize,
    /// What the last check that opened a session learned of the signed-in account.
    pub(crate) account: Account,
    /// The quota reads running on the CLI, by id: the feature's switch and a sign-out end every one.
    usage_reads: Vec<(u64, CancellationToken)>,
    /// A turn found the agent signed out: what it last told of itself stands no longer.
    pub(crate) stale_probe: bool,
    /// The sign-in that succeeded last, while what its server tells of the account is still to come: the agent is ready
    /// without it, and anything kept of the agent from then on stands over it.
    pub(crate) signed_in: Option<u64>,
    /// What `probe-cache.json` keeps of the agent, as last read or written under its lock: a check that ends shows the
    /// models it lists, whatever was kept while the check ran.
    told: Option<Probed>,
}

/// A sign-out of `preset` under way, which no session opens on; its end, however it ends, lets them open again.
struct SigningOut<'a> {
    agents: &'a Agents,
    preset: &'a str,
}

impl Drop for SigningOut<'_> {
    fn drop(&mut self) {
        lock(&self.agents.signing_out).remove(self.preset);
    }
}

/// What stands of a registry agent's account without starting it.
enum Standing {
    /// What it told of itself, kept.
    Told(Probed),
    /// A sign-in succeeded and what its server tells follows.
    SignedIn,
    Unknown,
}

/// What an agent tells of the account its CLI is signed in with. It names no one: the plan is all it says.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Account {
    /// The plan's name, as the agent's session answer gives it.
    pub(crate) plan: Option<String>,
    /// The agent advertises the protocol's `logout` (`agentCapabilities.auth.logout`).
    pub(crate) sign_out: bool,
}

impl Slot {
    /// What the running check is doing, as the Settings row words it.
    pub(crate) fn step(&self) -> Option<&'static str> {
        self.running_step().map(Step::state)
    }

    pub(crate) fn running_step(&self) -> Option<Step> {
        self.running.as_ref().map(|running| *running.step.borrow())
    }

    pub(crate) fn fault(&self) -> Value {
        self.fault.as_ref().map_or(Value::Null, |(action, message)| json!({ "action": action.name(), "message": message }))
    }
}

/// Holds a session's start against an update of the CLI it starts on.
pub(crate) struct Starting {
    agents: Arc<Agents>,
    preset: String,
}

impl Drop for Starting {
    fn drop(&mut self) {
        if let Some(slot) = lock(&self.agents.slots).get_mut(&self.preset) {
            slot.starting = slot.starting.saturating_sub(1);
        }
    }
}

impl Agents {
    /// Holds `preset`'s program against an update, as a session's start does, for as long as the guard lives.
    pub(crate) fn hold_program(self: &Arc<Self>, preset: &AgentPreset) -> Starting {
        lock(&self.slots).entry(preset.id.clone()).or_default().starting += 1;
        Starting { agents: self.clone(), preset: preset.id.clone() }
    }
}

/// Waits for a check to end; one that was dropped unfinished has ended too.
pub(crate) async fn ended(mut done: watch::Receiver<bool>) {
    let _ = done.wait_for(|done| *done).await;
}

/// What the CLI's quota report `ran` printed: its `command.data`, else why it failed, in its own words.
fn command_report(ran: Result<Ran, Fault>) -> Result<Value, String> {
    let ran = ran.map_err(|fault| fault.to_string())?;
    let printed: Option<Value> = ran.stdout.lines().rev().find_map(|line| serde_json::from_str(line.trim()).ok());
    match printed.as_ref().and_then(|printed| printed.pointer("/command/data")) {
        Some(data) if ran.code == Some(0) => Ok(data.clone()),
        _ => Err(printed.as_ref().and_then(|printed| printed.get("error")).and_then(Value::as_str).map_or_else(|| ran.said(), str::to_owned)),
    }
}

fn succeeded(ran: Result<Ran, Fault>) -> Result<(), String> {
    match ran {
        Ok(ran) if ran.code == Some(0) => Ok(()),
        Ok(ran) => Err(ran.said()),
        Err(fault) => Err(fault.to_string()),
    }
}

impl Agents {
    fn plain(program: &str, args: &[String], cwd: &AbsPath) -> Launch {
        Launch { program: program.to_owned(), args: args.to_vec(), env: Vec::new(), env_remove: Vec::new(), cwd: cwd.clone() }
    }

    /// The CLI and what its version run printed: the preset's command on `PATH`, else the first of its other places it is in.
    async fn locate(&self, preset: &AgentPreset, installed_at: &[crate::preset::Location], cwd: &AbsPath) -> Result<(String, Ran), Fault> {
        let installed = installed_at.iter().filter_map(|location| match &location.env {
            Some(env) => {
                let folder = (self.parts.env)(env).filter(|folder| !folder.is_empty())?;
                Some(Path::new(&folder).join(&location.path).to_string_lossy().into_owned())
            }
            None => Some(location.path.clone()),
        });
        for program in std::iter::once(preset.command.clone()).chain(installed) {
            let launch =
                Launch { program: program.clone(), args: preset.version_args.clone(), env: preset.env.clone(), env_remove: Vec::new(), cwd: cwd.clone() };
            match run_to_exit(&self.parts.processes, launch).await {
                Err(Fault::NotFound) => {}
                Ok(ran) => return Ok((program, ran)),
                Err(fault) => return Err(fault),
            }
        }
        Err(Fault::NotFound)
    }

    pub(crate) fn set_step(&self, preset: &AgentPreset, check: u64, step: Step) {
        if let Some(running) = lock(&self.slots).get_mut(&preset.id).and_then(|slot| slot.running.as_mut()).filter(|running| running.id == check) {
            running.step.send_replace(step);
        }
        (self.parts.changed)();
    }

    pub(crate) fn set_fault(&self, preset: &AgentPreset, fault: Option<(Action, String)>) {
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            slot.fault = fault;
        }
    }

    /// Whether the program may be replaced now: no session's agent runs on it, none is being started or waits for the
    /// check to start, no server of it runs, starts or is still ending, and no sign-in runs on it.
    pub(crate) fn begin_update(&self, preset: &AgentPreset, check: u64) -> bool {
        let in_use = lock(&self.sessions).values().any(|session| session.preset.id == preset.id && !session.connection.exited().is_cancelled())
            || lock(&self.shared).contains_key(&preset.id)
            || lock(&self.stops).iter().any(|stop| !stop.is_finished());
        let mut slots = lock(&self.slots);
        let Some(slot) = slots.get_mut(&preset.id) else { return false };
        if in_use || slot.starting > 0 {
            return false;
        }
        match slot.running.as_mut().filter(|running| running.id == check) {
            Some(running) => {
                running.step.send_replace(Step::Updating);
                true
            }
            None => false,
        }
    }

    /// The CLI of a `Cli` preset, installed or brought up to date first as `plan` allows, and what its version run printed.
    async fn examine_cli(&self, preset: &AgentPreset, plan: Plan, check: u64, cwd: &AbsPath) -> Result<(String, Ran), Fault> {
        let Distribution::Cli { installer, installed_at, update_args } = &preset.distribution else { return Err(Fault::NotFound) };
        let mut located = self.locate(preset, installed_at, cwd).await;
        match (&located, installer, update_args) {
            (Err(Fault::NotFound), Some(installer), _) if plan == Plan::Install => {
                self.set_step(preset, check, Step::Installing);
                let installed = succeeded(run_to_exit(&self.parts.processes, Self::plain(&installer.program, &installer.args, cwd)).await);
                self.set_step(preset, check, Step::Checking);
                located = self.locate(preset, installed_at, cwd).await;
                let fault = match (installed, &located) {
                    (Err(message), _) => Some(message),
                    (Ok(()), Err(Fault::NotFound)) => Some(format!("the installer ended and `{}` is still not found", preset.command)),
                    _ => None,
                };
                self.set_fault(preset, fault.map(|message| (Action::Install, message)));
            }
            (Err(Fault::NotFound), None, _) if plan == Plan::Install => {
                self.set_fault(preset, Some((Action::Install, format!("{} has no installer for this system", preset.label))));
            }
            (Ok((program, _)), _, Some(update)) if plan != Plan::Look && self.begin_update(preset, check) => {
                (self.parts.changed)();
                // A failed update leaves the CLI that was there, which the check goes on with.
                let updated = succeeded(run_to_exit(&self.parts.processes, Self::plain(program, update, cwd)).await);
                self.set_fault(preset, updated.err().map(|message| (Action::Update, message)));
                self.set_step(preset, check, Step::Checking);
                located = self.locate(preset, installed_at, cwd).await;
            }
            _ => {}
        }
        located
    }

    /// One check of `preset`'s program, with the upkeep `plan` allows.
    async fn examine(&self, preset: &AgentPreset, plan: Plan, check: u64) -> Readiness {
        // What an agent refused before the app last stopped stands over what this check finds.
        self.read_refusals().await;
        let Some(cwd) = AbsPath::new(self.parts.probe_cwd.clone()) else {
            return Readiness::Failed { version: None, message: format!("{} is not an absolute folder to check the CLI in", self.parts.probe_cwd.display()) };
        };
        match &preset.distribution {
            Distribution::Cli { .. } => self.check_cli(preset, plan, check, &cwd).await,
            Distribution::Registry { .. } => self.check_registry(preset, plan, check, &cwd).await,
        }
    }

    /// A CLI prints its version, and one too old is never started in ACP mode. Whether the user is signed in shows only
    /// when a session is opened, which the agent is asked to forget again.
    async fn check_cli(&self, preset: &AgentPreset, plan: Plan, check: u64, cwd: &AbsPath) -> Readiness {
        let (path, ran) = match self.examine_cli(preset, plan, check, cwd).await {
            Ok(located) => located,
            Err(Fault::NotFound) => return Readiness::NotInstalled,
            Err(fault) => return Readiness::Failed { version: None, message: fault.to_string() },
        };
        let program = Program::at(path);
        self.found_program(preset, program.clone());
        // A version run that failed says why in its own words, whatever version they hold; one that succeeded may print
        // its version on either stream.
        if ran.code != Some(0) {
            return Readiness::Failed { version: None, message: ran.said() };
        }
        let Some(found) = Version::find(&ran.stdout).or_else(|| Version::find(&ran.stderr)) else { return Readiness::VersionUnknown };
        let version = found.to_string();
        if found < preset.minimum_version {
            return Readiness::VersionTooOld { version };
        }
        let opened = async {
            let (connection, _incoming) = Connection::start(self.parts.processes.clone(), launch(preset, &program, cwd.clone())).await?;
            let opened = open_probe(&connection, cwd, None).await;
            connection.kill();
            opened
        }
        .await;
        match opened {
            Ok(Probe::Opened { capabilities, answer }) => {
                self.set_account(preset, account_of(preset, &capabilities, &answer));
                Readiness::Ready { version, models: Models::of(&answer) }
            }
            Ok(_) => Readiness::VersionUnknown,
            Err(fault) => unopened(fault, Some(version)),
        }
    }

    /// The registry's build is found from what this machine holds, and nothing is started for it while what the agent
    /// last told of itself stands: its build, the sign-in its home holds, and its answers kept in `probe-cache.json`. A
    /// system the registry's build does not run on has no build, and nothing stands in for it.
    async fn check_registry(&self, preset: &AgentPreset, plan: Plan, check: u64, cwd: &AbsPath) -> Readiness {
        if matches!(preset.distribution, Distribution::Registry { supported: false, .. }) {
            return Readiness::Unsupported;
        }
        let installed = match self.installed(preset).await {
            Ok(installed) => installed,
            Err(message) => return Readiness::Failed { version: None, message },
        };
        let Some(installed) = self.keep_current(preset, plan, check, installed).await else { return Readiness::NotInstalled };
        self.found_program(preset, installed.program.clone());
        let version = installed.version.clone();
        match Version::find(&version) {
            None => return Readiness::VersionUnknown,
            Some(found) if found < preset.minimum_version => return Readiness::VersionTooOld { version },
            Some(_) => {}
        }
        if !self.home_signed_in(preset).await {
            return Readiness::SignedOut { version, message: format!("{} is not signed in.", preset.label) };
        }
        let stale = lock(&self.slots).get_mut(&preset.id).is_some_and(|slot| std::mem::take(&mut slot.stale_probe));
        if stale {
            self.forget_told(preset).await;
        } else {
            match self.standing(preset).await {
                Standing::Told(probed) if Version::find(&probed.version) == Version::find(&version) => {
                    return Readiness::Ready { version, models: probed.models };
                }
                // Signed in a moment ago: what the sign-in's server tells of the account follows.
                Standing::SignedIn => return Readiness::Ready { version, models: Models::default() },
                _ => {}
            }
        }
        self.probe(preset, &installed.program, cwd, version).await
    }

    /// Starts `preset`'s server to learn what it tells of itself, in a temporary folder of its own, and closes it as the end
    /// of its input closes it. One that asks for a sign-in in the browser is signed out, and is closed at once.
    async fn probe(&self, preset: &AgentPreset, program: &Program, cwd: &AbsPath, version: String) -> Readiness {
        let epoch = self.account_epoch(&preset.id);
        let link = preset.login.as_ref().and_then(Login::link_line);
        let probed = async {
            let temp = Temp { folder: self.server_temp().await?, files: self.parts.files.clone() };
            let (connection, _incoming) = Connection::start_in(self.parts.processes.clone(), launch(preset, program, cwd.clone()), Some(temp)).await?;
            let mut lines = connection.stderr_lines();
            let probed = tokio::select! {
                biased;
                () = asks_sign_in(&mut lines, link) => Ok(Probe::SignIn),
                () = mixdog_rt::time::sleep(PROBE_LIMIT) => Err(Fault::Start(format!("it did not open a session within {} s", PROBE_LIMIT.as_secs()))),
                probed = open_probe(&connection, cwd, Some(preset.minimum_version)) => probed,
            };
            connection.close_gracefully(crate::shared::grace(1)).await;
            probed
        }
        .await;
        match probed {
            Ok(Probe::Opened { capabilities, answer }) => {
                let probed = told(preset, &capabilities, &answer, version);
                let (version, models) = (probed.version.clone(), probed.models.clone());
                // Of an account left where it changed hands while the check ran: the check's end shows nothing of it.
                self.keep_told(preset, probed, epoch, None).await;
                Readiness::Ready { version, models }
            }
            Ok(Probe::TooOld(Some(found))) => Readiness::VersionTooOld { version: found.to_string() },
            Ok(Probe::TooOld(None)) => Readiness::VersionUnknown,
            Ok(Probe::SignIn) => Readiness::SignedOut { version, message: format!("{} asks for a sign-in.", preset.label) },
            Err(fault) => unopened(fault, Some(version)),
        }
    }

    /// What the initialized, signed-in sign-in server `connection` of `preset` tells of itself in a session it opens, in
    /// the probe's bound; `None` where it opens none.
    pub(crate) async fn told_by_sign_in(&self, preset: &AgentPreset, connection: &Connection, capabilities: &Value) -> Option<Probed> {
        let cwd = AbsPath::new(self.parts.probe_cwd.clone())?;
        let version = capabilities.pointer("/agentInfo/version").and_then(Value::as_str)?.to_owned();
        let answer = mixdog_rt::time::timeout(PROBE_LIMIT, open_told(connection, &cwd, capabilities)).await;
        match answer {
            Ok(Ok(answer)) => Some(told(preset, capabilities, &answer, version)),
            Ok(Err(fault)) => {
                tracing::warn!("[acp] {}'s sign-in server opened no session after the sign-in: {fault}", preset.label);
                None
            }
            Err(_) => {
                tracing::warn!("[acp] {}'s sign-in server opened no session within {} s of the sign-in", preset.label, PROBE_LIMIT.as_secs());
                None
            }
        }
    }

    pub(crate) fn set_account(&self, preset: &AgentPreset, account: Account) {
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            slot.account = account;
        }
    }

    fn found_program(&self, preset: &AgentPreset, program: Program) {
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            slot.program = Some(program);
        }
    }

    /// Whether `preset`'s home holds every file of a sign-in.
    pub(crate) async fn home_signed_in(&self, preset: &AgentPreset) -> bool {
        let Distribution::Registry { sign_in_files, .. } = &preset.distribution else { return false };
        let home = self.home(preset);
        for file in sign_in_files {
            let Some(path) = AbsPath::new(home.join(file)) else { return false };
            if !self.parts.files.read(path).await.is_ok_and(|text| !text.trim().is_empty()) {
                return false;
            }
        }
        true
    }

    /// `preset`'s shared server, started while the account's hand-overs stood at `epoch`, opened its first session with
    /// `answer`: what it told of itself is kept and shown, over what was kept before where it tells nothing of it (a
    /// reopened session lists no models and no plan).
    pub(crate) async fn server_told(&self, preset: &AgentPreset, capabilities: &Value, answer: &Value, epoch: u64) {
        let (Distribution::Registry { .. }, Some(version)) = (&preset.distribution, capabilities.pointer("/agentInfo/version").and_then(Value::as_str)) else {
            return;
        };
        if self.keep_told(preset, told(preset, capabilities, answer, version.to_owned()), epoch, None).await {
            (self.parts.changed)();
        }
    }

    /// What the server of the sign-in `sign_in`, which became the agent's at the hand-over `epoch`, told of the account
    /// it signed in; `None` where it told nothing. It is kept and shown only while nothing newer was kept of the agent (a
    /// server started since told it, or the account changed hands again). One that is not kept for telling nothing
    /// leaves the agent to a check of its own, not one that began before.
    pub(crate) async fn sign_in_told(self: &Arc<Self>, preset: &AgentPreset, sign_in: u64, epoch: u64, probed: Option<Probed>) {
        if let Some(probed) = probed
            && self.keep_told(preset, probed, epoch, Some(sign_in)).await
        {
            (self.parts.changed)();
            return;
        }
        {
            let _held = self.probe_writes.acquire().await.expect("the probe file gate is never closed");
            let mut slots = lock(&self.slots);
            let Some(slot) = slots.get_mut(&preset.id).filter(|slot| slot.signed_in == Some(sign_in)) else { return };
            slot.signed_in = None;
        }
        loop {
            let running = {
                let mut slots = lock(&self.slots);
                // The feature turned off, or the account changed hands again, while a check ran: none is this one's to start.
                if !self.enabled() || self.account_epoch(&preset.id) != epoch {
                    return;
                }
                match slots.get(&preset.id).and_then(|slot| slot.running.as_ref()) {
                    Some(running) => running.done.clone(),
                    None => {
                        drop(self.share_check(&mut slots, preset, Plan::Look));
                        return;
                    }
                }
            };
            ended(running).await;
        }
    }

    /// The account `preset`'s registry agent was signed in with is left: the files of its sign-in leave its home, so that
    /// nothing started later finds one to try, and what the agent told of the account stands no longer.
    async fn forget_sign_in(&self, preset: &AgentPreset) {
        let Distribution::Registry { sign_in_files, .. } = &preset.distribution else { return };
        let home = self.home(preset);
        for file in sign_in_files {
            if let Some(path) = AbsPath::new(home.join(file))
                && let Err(error) = self.parts.files.remove_file(path).await
            {
                tracing::warn!("[acp] {file} of {}'s home was not removed: {error}", preset.label);
            }
        }
        self.forget_told(preset).await;
    }

    /// The file the agents' answers are kept in, `<acp data>/probe-cache.json`.
    fn probe_file(&self) -> Option<AbsPath> {
        AbsPath::new(self.parts.data_dir.join(PROBE_CACHE))
    }

    async fn read_probe_file(&self) -> serde_json::Map<String, Value> {
        let Some(file) = self.probe_file() else { return serde_json::Map::new() };
        let text = self.parts.files.read(file).await.unwrap_or_default();
        match serde_json::from_str(&text) {
            Ok(Value::Object(kept)) => kept,
            _ => serde_json::Map::new(),
        }
    }

    /// Puts `probed` in `probe-cache.json` as what `preset`'s agent last told of itself, `None` removing it; the caller holds
    /// `probe_writes`.
    async fn write_told(&self, preset: &AgentPreset, probed: Option<&Probed>) {
        let Some(file) = self.probe_file() else { return };
        let mut kept = self.read_probe_file().await;
        let changed = match probed {
            Some(probed) => kept.insert(preset.id.clone(), probed.value()).is_none_or(|was| was != probed.value()),
            None => kept.shift_remove(&preset.id).is_some(),
        };
        if changed && let Err(error) = self.parts.files.replace(file, Value::Object(kept).to_string()).await {
            tracing::warn!("[acp] what {} told of itself was not kept: {error}", preset.label);
        }
    }

    /// What stands of `preset`'s account, read as one: what is kept of it, which is the account shown, else a sign-in
    /// whose answer is to come. A kept answer that lists no models stands for nothing.
    async fn standing(&self, preset: &AgentPreset) -> Standing {
        let _held = self.probe_writes.acquire().await.expect("the probe file gate is never closed");
        let kept = self.read_probe_file().await.get(&preset.id).and_then(Probed::read).filter(|kept| !kept.models.available.is_empty());
        let mut slots = lock(&self.slots);
        let slot = slots.get_mut(&preset.id);
        let signed_in = slot.as_ref().is_some_and(|slot| slot.signed_in.is_some());
        if let Some(slot) = slot {
            if let Some(kept) = &kept {
                slot.account = kept.account.clone();
            }
            slot.told.clone_from(&kept);
        }
        match kept {
            Some(kept) => Standing::Told(kept),
            None if signed_in => Standing::SignedIn,
            None => Standing::Unknown,
        }
    }

    /// What `preset`'s agent told of itself stands no longer, and no sign-in's answer is to come.
    pub(crate) async fn forget_told(&self, preset: &AgentPreset) {
        let _held = self.probe_writes.acquire().await.expect("the probe file gate is never closed");
        self.write_told(preset, None).await;
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            slot.signed_in = None;
            slot.told = None;
        }
    }

    /// The hand-overs of `preset`'s account so far.
    pub(crate) fn account_epoch(&self, preset_id: &str) -> u64 {
        lock(&self.accounts).get(preset_id).copied().unwrap_or(0)
    }

    /// `preset`'s account changes hands: nothing a server or a check started before learns of an account is kept from
    /// here (a write under way ends first), the check that runs is ended so that a look after this starts one of its
    /// own, and what was told of the account left is forgotten. `signed_in` is the sign-in whose answer is to come.
    /// Returns the hand-over's number.
    pub(crate) async fn hand_over(&self, preset: &AgentPreset, signed_in: Option<u64>) -> u64 {
        let _held = self.probe_writes.acquire().await.expect("the probe file gate is never closed");
        let epoch = {
            let mut accounts = lock(&self.accounts);
            let epoch = accounts.entry(preset.id.clone()).or_default();
            *epoch += 1;
            *epoch
        };
        self.write_told(preset, None).await;
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            if let Some(running) = slot.running.take() {
                running.cancel.cancel();
            }
            slot.signed_in = signed_in;
            slot.told = None;
            slot.stale_probe = false;
            slot.account = Account::default();
        }
        epoch
    }

    /// Keeps `probed`, told of `preset`'s account by a server or check started at the hand-over `epoch`, and shows it:
    /// merged into what is kept where it tells nothing of a part (a reopened session lists no models and no plan), read
    /// and written as one step. Nothing is kept of an account left, nor an answer that lists no models even merged; with
    /// `sign_in`, only while that sign-in's answer is the one to come. Any answer kept stands over a sign-in's to come.
    /// `true` where it was kept.
    async fn keep_told(&self, preset: &AgentPreset, mut probed: Probed, epoch: u64, sign_in: Option<u64>) -> bool {
        let _held = self.probe_writes.acquire().await.expect("the probe file gate is never closed");
        if self.account_epoch(&preset.id) != epoch {
            return false;
        }
        if sign_in.is_some() && lock(&self.slots).get(&preset.id).is_none_or(|slot| slot.signed_in != sign_in) {
            return false;
        }
        if let Some(kept) = self.read_probe_file().await.get(&preset.id).and_then(Probed::read) {
            if probed.models.available.is_empty() {
                probed.models = kept.models;
            }
            probed.account.plan = probed.account.plan.or(kept.account.plan);
        }
        if probed.models.available.is_empty() {
            return false;
        }
        self.write_told(preset, Some(&probed)).await;
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            slot.signed_in = None;
            slot.account = probed.account.clone();
            if let Some(Readiness::Ready { version, models }) = &mut slot.readiness {
                version.clone_from(&probed.version);
                models.clone_from(&probed.models);
            }
            slot.told = Some(probed);
        }
        true
    }

    /// The running check of `preset`, or a new one with `plan`.
    pub(crate) fn share_check(self: &Arc<Self>, slots: &mut HashMap<String, Slot>, preset: &AgentPreset, plan: Plan) -> watch::Receiver<bool> {
        let slot = slots.entry(preset.id.clone()).or_default();
        if let Some(running) = &slot.running {
            return running.done.clone();
        }
        let id = self.next_check.fetch_add(1, Ordering::Relaxed);
        let (finished, done) = watch::channel(false);
        let cancel = CancellationToken::new();
        slot.running = Some(Running { id, step: watch::channel(Step::Checking).0, cancel: cancel.clone(), done: done.clone() });
        let (agents, preset) = (self.clone(), preset.clone());
        drop(mixdog_rt::spawn("acp.check", TaskClass::Work, async move {
            // A cancelled check is dropped here, which ends the processes it started.
            let found = tokio::select! {
                biased;
                () = cancel.cancelled() => None,
                () = agents.stop_token.cancelled() => None,
                found = agents.examine(&preset, plan, id) => Some(found),
            };
            // A check the feature's switch ended finds its slot gone.
            let mut event = None;
            if let Some(slot) = lock(&agents.slots).get_mut(&preset.id)
                && slot.running.as_ref().is_some_and(|running| running.id == id)
            {
                slot.running = None;
                event = match &found {
                    Some(Readiness::Ready { .. }) => Some(AccountEvent::Askable),
                    Some(Readiness::SignedOut { .. }) => Some(AccountEvent::Left),
                    _ => None,
                };
                // What a server told of the account while the check ran (a sign-in's answer) is what it lists.
                let mut found = found;
                if let (Some(Readiness::Ready { models, .. }), Some(told)) = (&mut found, &slot.told) {
                    models.clone_from(&told.models);
                }
                slot.readiness = found;
            }
            (agents.parts.changed)();
            // The quota can be asked of a CLI found ready now (a read that met the check ended with nothing, and one
            // before the first check never started); one found signed out has no account to keep a reading of.
            match event {
                Some(AccountEvent::Left) => agents.account_left(&preset.id, AccountEvent::Left),
                Some(event) => agents.tell(&preset.id, event),
                None => {}
            }
            let _ = finished.send(true);
        }));
        done
    }

    /// What a check of `preset` finds: the running one's result, or a look's.
    pub async fn look(self: &Arc<Self>, preset: &AgentPreset) -> Option<Readiness> {
        let done = self.share_check(&mut lock(&self.slots), preset, Plan::Look);
        ended(done).await;
        lock(&self.slots).get(&preset.id).and_then(|slot| slot.readiness.clone())
    }

    /// Looks at every preset's CLI again, bringing it up to date first; the settings value tells what is found.
    /// Returns at once. Nothing is started while the feature is off.
    pub fn recheck(self: &Arc<Self>) {
        if !self.enabled() {
            return;
        }
        for preset in &self.parts.presets {
            self.share_check(&mut lock(&self.slots), preset, Plan::Refresh);
        }
        (self.parts.changed)();
    }

    /// The feature's install step: every preset's CLI is installed where it is missing and brought up to date
    /// where it is there, one that fails leaving the others to theirs. `Err` tells what failed, a line per preset.
    pub async fn install(self: &Arc<Self>) -> Result<(), String> {
        if !self.enabled() {
            return Err("ACP agents are turned off in Settings.".to_owned());
        }
        let mut failed = Vec::new();
        for preset in &self.parts.presets {
            // A check that already runs is not the install: it is waited out first.
            loop {
                let (done, own) = {
                    let mut slots = lock(&self.slots);
                    let running = slots.get(&preset.id).and_then(|slot| slot.running.as_ref()).map(|running| running.done.clone());
                    match running {
                        Some(done) => (done, false),
                        None => {
                            slots.entry(preset.id.clone()).or_default().fault = None;
                            (self.share_check(&mut slots, preset, Plan::Install), true)
                        }
                    }
                };
                (self.parts.changed)();
                ended(done).await;
                // Turning the feature off ended the install: nothing more is installed and nothing is reported as done.
                if !self.enabled() {
                    return Err("ACP agents were turned off before the install ended.".to_owned());
                }
                if own {
                    break;
                }
            }
            if let Some((action, message)) = lock(&self.slots).get(&preset.id).and_then(|slot| slot.fault.clone()) {
                failed.push(format!("{} could not be {}: {message}", preset.label, if action == Action::Install { "installed" } else { "updated" }));
            }
        }
        if failed.is_empty() { Ok(()) } else { Err(failed.join("\n")) }
    }

    /// Read-only readiness check for route validation: starts one initial look if `preset` has never been checked,
    /// waits for an in-flight check without cancelling updates, and returns the resulting readiness.
    pub(crate) async fn ensure_checked(self: &Arc<Self>, preset: &AgentPreset) -> Result<(), crate::agents::Refusal> {
        use crate::agents::Refusal;
        let mut looked = false;
        loop {
            if !self.enabled() {
                return Err(Refusal::Off);
            }
            let (done, mut stepped) = {
                let mut slots = lock(&self.slots);
                let slot = slots.entry(preset.id.clone()).or_default();
                let running = slot.running.as_ref().map(|running| (*running.step.borrow(), running.done.clone(), running.step.subscribe()));
                match (running, slot.readiness.clone()) {
                    (_, Some(Readiness::Ready { .. })) => return Ok(()),
                    (Some((Step::Installing, ..)), found) => return Err(Refusal::NotReady(found.unwrap_or(Readiness::NotInstalled))),
                    (Some((_, done, stepped)), None) => (done, stepped),
                    (_, Some(other)) => return Err(Refusal::NotReady(other)),
                    (None, None) if looked => return Err(Refusal::Off),
                    (None, None) => {
                        looked = true;
                        drop(self.share_check(&mut slots, preset, Plan::Look));
                        continue;
                    }
                }
            };
            tokio::select! {
                () = ended(done) => {}
                _ = stepped.changed() => {}
            }
        }
    }

    /// The CLI a session of `preset` starts on, once its check says it is ready. A state that is not ready is
    /// looked at once more first: the user may have installed or signed in outside the app. A stalled installer or update
    /// holds no turn: the turn holds the CLI against an update from its start, so none begins while it waits and one
    /// under way is ended (the CLI left as a failed update leaves it); a CLI being installed is not there to start; and a
    /// check of a CLI found ready before leaves it to the turn at once.
    pub(crate) async fn ready_program(self: &Arc<Self>, preset: &AgentPreset) -> Result<(Program, Starting), crate::agents::Refusal> {
        use crate::agents::Refusal;
        let held = self.hold_program(preset);
        let mut looked = false;
        loop {
            if !self.enabled() {
                return Err(Refusal::Off);
            }
            let (done, mut stepped) = {
                let mut slots = lock(&self.slots);
                let slot = slots.entry(preset.id.clone()).or_default();
                if slot.running.as_ref().is_some_and(|running| *running.step.borrow() == Step::Updating)
                    && let Some(running) = slot.running.take()
                {
                    running.cancel.cancel();
                }
                let running = slot.running.as_ref().map(|running| (*running.step.borrow(), running.done.clone(), running.step.subscribe()));
                match (running, slot.readiness.clone()) {
                    (_, Some(Readiness::Ready { .. })) => {
                        let program = slot.program.clone().unwrap_or_else(|| Program::at(preset.command.clone()));
                        return Ok((program, held));
                    }
                    (Some((Step::Installing, ..)), found) => return Err(Refusal::NotReady(found.unwrap_or(Readiness::NotInstalled))),
                    (Some((_, done, stepped)), _) => (done, stepped),
                    (None, Some(other)) if looked => return Err(Refusal::NotReady(other)),
                    // The check this turn asked for was ended by the feature's switch: the turn does not start another.
                    (None, None) if looked => return Err(Refusal::Off),
                    (None, _) => {
                        looked = true;
                        drop(self.share_check(&mut slots, preset, Plan::Look));
                        continue;
                    }
                }
            };
            tokio::select! {
                () = ended(done) => {}
                _ = stepped.changed() => {}
            }
        }
    }

    /// Signs `preset`'s CLI out with the protocol's `logout`, which the agent itself carries out on the credential it
    /// keeps; the sessions that ran under the account end, and the CLI is looked at again. `Err` tells why nothing
    /// was signed out.
    pub async fn sign_out(self: &Arc<Self>, preset: &AgentPreset) -> Result<(), String> {
        if !self.enabled() {
            return Err("ACP agents are turned off in Settings.".to_owned());
        }
        // One sign-out of an agent at a time; no session opens on it, and so no server starts for it, until the sign-in's
        // files are gone.
        if !lock(&self.signing_out).insert(preset.id.clone()) {
            return Err(format!("{} is already signing out.", preset.label));
        }
        let gate = SigningOut { agents: self.as_ref(), preset: &preset.id };
        // Held against an update of the CLI, as a session's start is.
        let (program, starting) = {
            let mut slots = lock(&self.slots);
            let slot = slots.get_mut(&preset.id).filter(|slot| slot.running.is_none() && matches!(slot.readiness, Some(Readiness::Ready { .. })));
            let Some(slot) = slot else { return Err(format!("{} is not signed in, or is being checked.", preset.label)) };
            if !slot.account.sign_out {
                return Err(format!("{} offers no sign-out.", preset.label));
            }
            slot.starting += 1;
            (slot.program.clone().unwrap_or_else(|| Program::at(preset.command.clone())), Starting { agents: self.clone(), preset: preset.id.clone() })
        };
        let Some(cwd) = AbsPath::new(self.parts.probe_cwd.clone()) else { return Err("ACP agents have no folder to start in.".to_owned()) };
        // A shared server that runs is asked itself, held open for it however its sessions leave it; else a process of
        // the agent's own, which on such a preset runs in a temporary folder of its own and is closed as the end of its
        // input closes it.
        let running = match preset.scope {
            ProcessScope::Shared => self.lease_shared(&preset.id),
            ProcessScope::PerSession => None,
        };
        let asked = async {
            if let Some(held) = &running {
                return held.server().connection.request("logout", json!({})).await.map(drop);
            }
            let temp = match preset.scope {
                ProcessScope::Shared => Some(Temp { folder: self.server_temp().await?, files: self.parts.files.clone() }),
                ProcessScope::PerSession => None,
            };
            let graceful = temp.is_some();
            let (connection, _incoming) = Connection::start_in(self.parts.processes.clone(), launch(preset, &program, cwd), temp).await?;
            let mut lines = connection.stderr_lines();
            let link = preset.login.as_ref().and_then(Login::link_line);
            let done = tokio::select! {
                biased;
                // An agent that asks for a sign-in has none to leave.
                () = asks_sign_in(&mut lines, link) => Ok(()),
                () = mixdog_rt::time::sleep(PROBE_LIMIT) => Err(Fault::Start(format!("it did not sign out within {} s", PROBE_LIMIT.as_secs()))),
                done = async {
                    initialize(&connection).await?;
                    connection.request("logout", json!({})).await.map(drop)
                } => done,
            };
            if graceful {
                connection.close_gracefully(crate::shared::grace(0)).await;
            } else {
                connection.kill();
            }
            done
        };
        asked.await.map_err(|fault: Fault| fault.to_string())?;
        drop(starting);
        // Nothing a server or a check started before learns of the account left is kept from here.
        self.hand_over(preset, None).await;
        self.account_left(&preset.id, AccountEvent::Left);
        // The agents that ran under the account hold a session of it no longer. A shared server leaves use before its
        // sessions leave it, and the files of the sign-in go only once the server asked has exited.
        if preset.scope == ProcessScope::Shared {
            self.stop_shared(&preset.id).await;
        }
        if let Some(held) = running {
            held.server().connection.exited().cancelled().await;
        }
        let ran: Vec<ThreadId> = lock(&self.sessions).iter().filter(|(_, session)| session.preset.id == preset.id).map(|(thread, _)| thread.clone()).collect();
        for thread in &ran {
            self.end_process(thread);
        }
        self.forget_sign_in(preset).await;
        drop(gate);
        // Whoever signs in next is not the account the agent refused.
        self.answered(preset).await;
        self.look(preset).await;
        // The CLI still read ready while it was looked at: a quota read begun then is of the account just left, and a
        // check that finds it ready only tells `Askable`, which ends no read.
        self.account_left(&preset.id, AccountEvent::Left);
        (self.parts.changed)();
        Ok(())
    }

    /// The account `preset`'s CLI is signed in with is not the one a quota was read of: the reads running end, and
    /// whoever keeps a reading is told (`Left`, or `SignedIn` to take the next one now).
    pub(crate) fn account_left(&self, preset_id: &str, event: AccountEvent) {
        if let Some(slot) = lock(&self.slots).get_mut(preset_id) {
            for (_, read) in slot.usage_reads.drain(..) {
                read.cancel();
            }
        }
        self.tell(preset_id, event);
    }

    fn tell(&self, preset_id: &str, event: AccountEvent) {
        if let Some(told) = self.account_changed.get() {
            told(preset_id, event);
        }
    }

    /// The preset whose CLI runs the quota report for `preset`, and the arguments it runs with.
    fn usage_command<'a>(&'a self, preset: &'a AgentPreset) -> Option<(&'a AgentPreset, &'a [String])> {
        match preset.usage.as_ref()? {
            UsageReport::Command { args } => Some((preset, args.as_slice())),
            UsageReport::FromPreset { preset_id } => {
                let source = self.parts.presets.iter().find(|other| other.id == *preset_id)?;
                match source.usage.as_ref()? {
                    UsageReport::Command { args } => Some((source, args.as_slice())),
                    UsageReport::FromPreset { .. } => None,
                }
            }
        }
    }

    /// Whether `preset`'s quota can be read now: the feature is on, the preset (and the CLI preset it reads through,
    /// when delegated) was last found ready (installed, current, signed in). Nothing is started to find that out.
    pub fn reports_usage(&self, preset: &AgentPreset) -> bool {
        let Some((source, _)) = self.usage_command(preset) else {
            return false;
        };
        if !self.enabled() {
            return false;
        }
        let slots = lock(&self.slots);
        let ready = |id: &str| matches!(slots.get(id).and_then(|slot| slot.readiness.as_ref()), Some(Readiness::Ready { .. }));
        ready(&preset.id) && (source.id == preset.id || ready(&source.id))
    }

    /// The quota of the account `preset`'s agent is signed in with, as its CLI's report gives it (`command.data`).
    /// `None` where it cannot be asked now: [`Self::reports_usage`] says no, or the CLI is being checked or updated,
    /// and once the feature is turned off or the agent signed out while it is asked (which ends the CLI's run).
    /// `Some(Err)` is a report that failed, in its own words.
    pub async fn usage(self: &Arc<Self>, preset: &AgentPreset) -> Option<Result<Value, String>> {
        self.usage_until(preset, &CancellationToken::new()).await
    }

    /// [`Self::usage`], ended by `stop` (`None`) and by the time a provider's own usage request is given (`Some(Err)`).
    pub async fn usage_until(self: &Arc<Self>, preset: &AgentPreset, stop: &CancellationToken) -> Option<Result<Value, String>> {
        let (source, args) = self.usage_command(preset)?;
        if !self.enabled() {
            return None;
        }
        let cwd = AbsPath::new(self.parts.probe_cwd.clone())?;
        let (read, cancel) = (self.next_check.fetch_add(1, Ordering::Relaxed), CancellationToken::new());
        // A run of the CLI is held against an update of it, as a session's start is.
        let (program, _starting) = {
            let mut slots = lock(&self.slots);
            if source.id != preset.id && !matches!(slots.get(&preset.id).and_then(|slot| slot.readiness.as_ref()), Some(Readiness::Ready { .. })) {
                return None;
            }
            let slot = slots.get_mut(&source.id)?;
            if slot.running.is_some() || !matches!(slot.readiness, Some(Readiness::Ready { .. })) {
                return None;
            }
            slot.usage_reads.push((read, cancel.clone()));
            slot.starting += 1;
            let starting = Starting { agents: self.clone(), preset: source.id.clone() };
            let program = slot.program.clone().map_or_else(|| source.command.clone(), |program| program.path);
            if source.id != preset.id
                && let Some(target) = slots.get_mut(&preset.id)
            {
                target.usage_reads.push((read, cancel.clone()));
            }
            (program, starting)
        };
        let launch = Launch { program, args: args.to_vec(), env: source.env.clone(), env_remove: Vec::new(), cwd };
        let asked = async { command_report(run_to_exit(&self.parts.processes, launch).await) };
        // An ended read drops the run, which ends the CLI's process.
        let answered = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            () = stop.cancelled() => None,
            () = mixdog_rt::time::sleep(std::time::Duration::from_millis(mixdog_ai::service::usage_antigravity::REQUEST_TIMEOUT_MS)) => {
                Some(Err(format!("{}'s quota report took longer than {} s.", preset.label, mixdog_ai::service::usage_antigravity::REQUEST_TIMEOUT_MS / 1_000)))
            }
            answered = asked => Some(answered),
        };
        {
            let mut slots = lock(&self.slots);
            if let Some(slot) = slots.get_mut(&source.id) {
                slot.usage_reads.retain(|(id, _)| *id != read);
            }
            if source.id != preset.id
                && let Some(slot) = slots.get_mut(&preset.id)
            {
                slot.usage_reads.retain(|(id, _)| *id != read);
            }
        }
        answered
    }

    /// Ends every check and quota read and forgets what they found: the feature was turned off.
    pub(crate) fn forget_checks(&self) {
        let slots: Vec<(String, Slot)> = lock(&self.slots).drain().collect();
        for (id, slot) in slots {
            if let Some(running) = slot.running {
                running.cancel.cancel();
            }
            for (_, read) in slot.usage_reads {
                read.cancel();
            }
            self.tell(&id, AccountEvent::Left);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::process::CommandSpec;
    use mixdog_core_api::domain::process::ExitStatus;
    use mixdog_core_api::domain::process::OutputStream;
    use mixdog_core_api::domain::process::ProcessError;
    use mixdog_core_api::domain::process::ProcessEvent;
    use mixdog_core_api::domain::process::ProcessExit;
    use mixdog_core_api::domain::process::ProcessInfo;
    use mixdog_core_api::domain::process::ProcessManager;
    use mixdog_core_api::domain::process::PtySize;
    use mixdog_core_api::domain::process::SpawnRequest;
    use mixdog_core_api::domain::process::SpawnedProcess;
    use mixdog_protocol::ProcessHandle;

    use super::*;
    use crate::agents::AgentsParts;
    use crate::agents::Refusals;
    use crate::agents::Windows;
    use crate::files::TextFiles;

    struct NoRefusals;

    #[async_trait]
    impl Refusals for NoRefusals {
        async fn read(&self) -> HashMap<String, String> {
            HashMap::new()
        }
        async fn keep(&self, _: HashMap<String, String>) {}
        async fn read_windows(&self) -> Windows {
            HashMap::new()
        }
        async fn keep_windows(&self, _: Windows) {}
    }

    struct NoFiles;

    #[async_trait]
    impl TextFiles for NoFiles {
        async fn read(&self, _: AbsPath) -> Result<String, String> {
            Err("no file".into())
        }
        async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
            Ok(path)
        }
        async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
            Ok(())
        }
    }

    struct ChannelEvents(mpsc::UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for ChannelEvents {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    #[derive(Default)]
    struct AgyProbeProcesses {
        spawns: Mutex<Vec<(Vec<String>, Vec<(String, String)>)>>,
        events: Mutex<HashMap<String, mpsc::UnboundedReceiver<ProcessEvent>>>,
        senders: Mutex<HashMap<String, mpsc::UnboundedSender<ProcessEvent>>>,
        stdin_buf: Mutex<HashMap<String, String>>,
    }

    #[async_trait]
    impl ProcessManager for AgyProbeProcesses {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            let CommandSpec::Argv { args, .. } = request.command else { panic!("argv expected") };
            self.spawns.lock().unwrap().push((args.clone(), request.env.set));
            let (tx, rx) = mpsc::unbounded_channel();
            if args.iter().any(|arg| arg == "--version") {
                let _ = tx.send(ProcessEvent::Output { seq: 0, stream: OutputStream::Stdout, bytes: b"1.5.16\n".to_vec() });
                let _ = tx.send(ProcessEvent::Exited { seq: 1, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } });
            } else if args.iter().any(|arg| arg == "/usage") {
                let body = json!({ "status": "SUCCESS", "command": { "data": { "groups": [] } } }).to_string();
                let _ = tx.send(ProcessEvent::Output { seq: 0, stream: OutputStream::Stdout, bytes: format!("{body}\n").into_bytes() });
                let _ = tx.send(ProcessEvent::Exited { seq: 1, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } });
            } else {
                self.senders.lock().unwrap().insert(request.handle.0.clone(), tx);
            }
            self.events.lock().unwrap().insert(request.handle.0.clone(), rx);
            Ok(SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(&self, handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let rx = self.events.lock().unwrap().remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
            Ok(Box::new(ChannelEvents(rx)))
        }

        fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            self.subscribe(handle, from_seq)
        }

        async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let mut lines = Vec::new();
            {
                let mut bufs = self.stdin_buf.lock().unwrap();
                let buf = bufs.entry(handle.0.clone()).or_default();
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find('\n') {
                    lines.push(buf.drain(..=pos).collect::<String>());
                }
            }
            if let Some(tx) = self.senders.lock().unwrap().get(&handle.0) {
                for line in lines {
                    let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    let Some(id) = msg.get("id").cloned() else { continue };
                    let result = match msg.get("method").and_then(Value::as_str) {
                        Some("initialize") => json!({ "protocolVersion": 1, "agentCapabilities": {} }),
                        Some("session/new") => json!({ "sessionId": "sess-1" }),
                        _ => json!({}),
                    };
                    let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
                    let _ = tx.send(ProcessEvent::Output { seq: 0, stream: OutputStream::Stdout, bytes: format!("{reply}\n").into_bytes() });
                }
            }
            Ok(())
        }

        fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }

        fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
            Ok(())
        }

        fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
            if let Some(tx) = self.senders.lock().unwrap().remove(&handle.0) {
                let _ = tx.send(ProcessEvent::Exited { seq: 1, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } });
            }
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    #[tokio::test]
    async fn antigravity_cli_check_and_usage_disable_auto_updater_with_literal_true() {
        let _ = mixdog_rt::testing::tokens();
        let preset = crate::preset::builtin().into_iter().find(|preset| preset.id == "antigravity-cli").expect("antigravity-cli preset");
        let processes = Arc::new(AgyProbeProcesses::default());
        let cwd = std::env::temp_dir();
        let agents = Agents::new(AgentsParts {
            refusals: Arc::new(NoRefusals),
            presets: vec![preset.clone()],
            processes: processes.clone(),
            files: Arc::new(NoFiles),
            cpu: mixdog_rt::testing::tokens().cpu_interactive,
            enabled: Arc::new(|| true),
            changed: Arc::new(|| {}),
            probe_cwd: cwd.clone(),
            definitions: cwd.clone(),
            data_dir: cwd,
            env: Arc::new(|_| None),
            mcp_bridge: None,
            registry: None,
        });

        let readiness = agents.look(&preset).await;
        assert!(matches!(readiness, Some(Readiness::Ready { .. })), "{readiness:?}");
        let report = agents.usage(&preset).await;
        assert_eq!(report, Some(Ok(json!({ "groups": [] }))));

        let spawns = processes.spawns.lock().unwrap().clone();
        let args: Vec<&[String]> = spawns.iter().map(|(args, _)| args.as_slice()).collect();
        assert_eq!(args.len(), 3, "{spawns:?}");
        for (argv, env) in &spawns {
            assert!(
                env.iter().any(|(k, v)| k == "AGY_CLI_DISABLE_AUTO_UPDATE" && v == "true"),
                "spawn {argv:?} must set AGY_CLI_DISABLE_AUTO_UPDATE=true, got {env:?}"
            );
        }
    }

    #[tokio::test]
    async fn official_preset_reads_usage_from_ready_cli_and_none_when_cli_missing_or_signed_out() {
        let _ = mixdog_rt::testing::tokens();
        let presets = crate::preset::builtin();
        let official = presets.iter().find(|p| p.id == "antigravity").expect("antigravity preset").clone();
        let cli = presets.iter().find(|p| p.id == "antigravity-cli").expect("antigravity-cli preset").clone();
        let processes = Arc::new(AgyProbeProcesses::default());
        let cwd = std::env::temp_dir();
        let agents = Agents::new(AgentsParts {
            refusals: Arc::new(NoRefusals),
            presets,
            processes: processes.clone(),
            files: Arc::new(NoFiles),
            cpu: mixdog_rt::testing::tokens().cpu_interactive,
            enabled: Arc::new(|| true),
            changed: Arc::new(|| {}),
            probe_cwd: cwd.clone(),
            definitions: cwd.clone(),
            data_dir: cwd,
            env: Arc::new(|_| None),
            mcp_bridge: None,
            registry: None,
        });

        let ready = || Readiness::Ready { version: "1.5.2".into(), models: Models::default() };
        lock(&agents.slots).entry(official.id.clone()).or_default().readiness = Some(ready());

        // CLI missing or signed out: official preset reports no usage and spawns nothing.
        for cli_state in [Readiness::NotInstalled, Readiness::SignedOut { version: "1.5.16".into(), message: "sign in".into() }] {
            lock(&agents.slots).entry(cli.id.clone()).or_default().readiness = Some(cli_state);
            assert!(!agents.reports_usage(&official));
            assert_eq!(agents.usage(&official).await, None);
        }
        assert!(processes.spawns.lock().unwrap().is_empty());

        // CLI ready: official preset reads usage through `agy --print /usage --output-format json`.
        lock(&agents.slots).entry(cli.id.clone()).or_default().readiness = Some(ready());
        assert!(agents.reports_usage(&official));
        assert_eq!(agents.usage(&official).await, Some(Ok(json!({ "groups": [] }))));

        let spawns = processes.spawns.lock().unwrap().clone();
        assert_eq!(spawns.len(), 1, "{spawns:?}");
        assert_eq!(spawns[0].0, ["--print", "/usage", "--output-format", "json"]);
        assert!(spawns[0].1.iter().any(|(k, v)| k == "AGY_CLI_DISABLE_AUTO_UPDATE" && v == "true"));
    }
}
