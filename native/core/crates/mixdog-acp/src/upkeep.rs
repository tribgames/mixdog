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
use crate::connection::run_to_exit;
use crate::preset::AgentPreset;
use crate::preset::Distribution;
use crate::preset::Version;
use crate::session::Models;
use crate::session::Program;
use crate::session::initialize;
use crate::session::launch;

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
    step: Step,
    cancel: CancellationToken,
    done: watch::Receiver<bool>,
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
        self.running.as_ref().map(|running| running.step.state())
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

/// Waits for a check to end; one that was dropped unfinished has ended too.
pub(crate) async fn ended(mut done: watch::Receiver<bool>) {
    let _ = done.wait_for(|done| *done).await;
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

    /// The CLI and what its version run printed: the preset's command on `PATH`, else its file where the installer puts it.
    async fn locate(&self, preset: &AgentPreset, installed_at: &[crate::preset::Location], cwd: &AbsPath) -> Result<(String, Ran), Fault> {
        let installed = installed_at.iter().filter_map(|location| {
            let folder = (self.parts.env)(&location.env).filter(|folder| !folder.is_empty())?;
            Some(Path::new(&folder).join(&location.path).to_string_lossy().into_owned())
        });
        for program in std::iter::once(preset.command.clone()).chain(installed) {
            match run_to_exit(&self.parts.processes, Self::plain(&program, &preset.version_args, cwd)).await {
                Err(Fault::NotFound) => {}
                Ok(ran) => return Ok((program, ran)),
                Err(fault) => return Err(fault),
            }
        }
        Err(Fault::NotFound)
    }

    fn set_step(&self, preset: &AgentPreset, check: u64, step: Step) {
        if let Some(running) = lock(&self.slots).get_mut(&preset.id).and_then(|slot| slot.running.as_mut()).filter(|running| running.id == check) {
            running.step = step;
        }
        (self.parts.changed)();
    }

    fn set_fault(&self, preset: &AgentPreset, fault: Option<(Action, String)>) {
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            slot.fault = fault;
        }
    }

    /// Whether the CLI may be replaced now: no session's agent runs on it and none is being started.
    fn begin_update(&self, preset: &AgentPreset, check: u64) -> bool {
        let in_use = lock(&self.sessions).values().any(|session| session.preset.id == preset.id && !session.connection.exited().is_cancelled());
        let mut slots = lock(&self.slots);
        let Some(slot) = slots.get_mut(&preset.id) else { return false };
        if in_use || slot.starting > 0 {
            return false;
        }
        match slot.running.as_mut().filter(|running| running.id == check) {
            Some(running) => {
                running.step = Step::Updating;
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

    /// The build of `preset`'s registry agent this machine holds, as `<acp data>/bin/<preset id>/installed.json` names it:
    /// its program (`cmd`, under the build's own folder `<version>/` unless it is absolute) with the build's arguments,
    /// in the home Mixdog keeps for the agent, which `home_env` names. `Ok(None)` where no build is installed.
    async fn installed(&self, preset: &AgentPreset, home_env: &str) -> Result<Option<Program>, String> {
        let folder = self.parts.data_dir.join("bin").join(&preset.id);
        let Some(file) = AbsPath::new(folder.join("installed.json")) else {
            return Err(format!("{} is not an absolute folder to keep the agents in", self.parts.data_dir.display()));
        };
        let Ok(text) = self.parts.files.read(file).await else { return Ok(None) };
        let unreadable = |why: &str| format!("the record of {}'s installed build cannot be read: {why}", preset.label);
        let installed: Value = serde_json::from_str(&text).map_err(|error| unreadable(&error.to_string()))?;
        let field = |key: &str| installed.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
        let (Some(version), Some(cmd)) = (field("version"), field("cmd")) else { return Err(unreadable("it names no version or no program")) };
        let args = installed.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        let home = self.parts.data_dir.join("homes").join(&preset.id);
        Ok(Some(Program {
            path: folder.join(version).join(cmd).to_string_lossy().into_owned(),
            args,
            env: vec![(home_env.to_owned(), home.to_string_lossy().into_owned())],
        }))
    }

    /// One check of `preset`'s program, with the upkeep `plan` allows.
    async fn examine(&self, preset: &AgentPreset, plan: Plan, check: u64) -> Readiness {
        // What an agent refused before the app last stopped stands over what this check finds.
        self.read_refusals().await;
        let Some(cwd) = AbsPath::new(self.parts.probe_cwd.clone()) else {
            return Readiness::Failed { version: None, message: format!("{} is not an absolute folder to check the CLI in", self.parts.probe_cwd.display()) };
        };
        // A CLI prints its version, and one too old is never started in ACP mode; an agent of the registry has no version
        // run and names its version in `initialize`.
        let (program, printed) = match &preset.distribution {
            Distribution::Cli { .. } => match self.examine_cli(preset, plan, check, &cwd).await {
                Ok((path, ran)) => match Version::find(&ran.stdout) {
                    Some(found) => (Program::at(path), Some(found)),
                    None => {
                        self.found_program(preset, Program::at(path));
                        return Readiness::VersionUnknown;
                    }
                },
                Err(Fault::NotFound) => return Readiness::NotInstalled,
                Err(fault) => return Readiness::Failed { version: None, message: fault.to_string() },
            },
            Distribution::Registry { supported: false, .. } => {
                return Readiness::Failed { version: None, message: format!("{} does not run on this system.", preset.label) };
            }
            Distribution::Registry { home_env, .. } => match self.installed(preset, home_env).await {
                Ok(Some(program)) => (program, None),
                Ok(None) => return Readiness::NotInstalled,
                Err(message) => return Readiness::Failed { version: None, message },
            },
        };
        self.found_program(preset, program.clone());
        if let Some(found) = printed.filter(|found| *found < preset.minimum_version) {
            return Readiness::VersionTooOld { version: found.to_string() };
        }
        // Whether the user is signed in shows only when a session is opened; the agent is asked to forget it again.
        let mut named = printed;
        let opened = async {
            let (connection, _incoming) = Connection::start(self.parts.processes.clone(), launch(preset, &program, cwd.clone())).await?;
            let opened = async {
                let capabilities = initialize(&connection).await?;
                if named.is_none() {
                    named = capabilities.pointer("/agentInfo/version").and_then(Value::as_str).and_then(Version::find);
                }
                // An agent whose version is unknown or too old is asked nothing more.
                if named.is_none_or(|found| found < preset.minimum_version) {
                    return Ok(None);
                }
                let answer = connection.request("session/new", json!({ "cwd": cwd.as_path().to_string_lossy(), "mcpServers": [] })).await?;
                if let (Some(_), Some(id)) =
                    (capabilities.pointer("/agentCapabilities/sessionCapabilities/close"), answer.get("sessionId").and_then(Value::as_str))
                {
                    let _ = connection.request("session/close", json!({ "sessionId": id })).await;
                }
                Ok::<_, Fault>(Some((answer, capabilities)))
            }
            .await;
            connection.kill();
            opened
        }
        .await;
        let version = named.map(|found| found.to_string());
        match (opened, version) {
            (Ok(Some((answer, capabilities))), Some(version)) => {
                let plan = preset.quirks.plan_name.as_ref().and_then(|path| {
                    let named = path.iter().try_fold(answer.get("_meta")?, |at, key| at.get(key))?;
                    named.as_str().map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned)
                });
                let sign_out = capabilities.pointer("/agentCapabilities/auth/logout").is_some_and(|logout| !logout.is_null() && logout != &Value::Bool(false));
                if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
                    slot.account = Account { plan, sign_out };
                }
                Readiness::Ready { version, models: Models::of(&answer) }
            }
            (Ok(_), None) => Readiness::VersionUnknown,
            (Ok(None), Some(version)) => Readiness::VersionTooOld { version },
            (Err(Fault::NotFound), _) => Readiness::NotInstalled,
            (Err(Fault::Rpc(error)), version) if error.code == AUTH_REQUIRED => Readiness::SignedOut { version: version.unwrap_or_default(), message: error.message },
            (Err(fault), version) => Readiness::Failed { version, message: fault.to_string() },
        }
    }

    fn found_program(&self, preset: &AgentPreset, program: Program) {
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            slot.program = Some(program);
        }
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
        slot.running = Some(Running { id, step: Step::Checking, cancel: cancel.clone(), done: done.clone() });
        let (agents, preset) = (self.clone(), preset.clone());
        drop(mixdog_rt::spawn("acp.check", TaskClass::Work, async move {
            // A cancelled check is dropped here, which ends the processes it started.
            let found = tokio::select! {
                biased;
                () = cancel.cancelled() => None,
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
    /// where it is there. `Err` tells what failed.
    pub async fn install(self: &Arc<Self>) -> Result<(), String> {
        if !self.enabled() {
            return Err("ACP agents are turned off in Settings.".to_owned());
        }
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
                return Err(format!("{} could not be {}: {message}", preset.label, if action == Action::Install { "installed" } else { "updated" }));
            }
        }
        Ok(())
    }

    /// The CLI a session of `preset` starts on, once its check says it is ready. A state that is not ready is
    /// looked at once more first: the user may have installed or signed in outside the app.
    pub(crate) async fn ready_program(self: &Arc<Self>, preset: &AgentPreset) -> Result<(Program, Starting), crate::agents::Refusal> {
        use crate::agents::Refusal;
        let mut looked = false;
        loop {
            if !self.enabled() {
                return Err(Refusal::Off);
            }
            let done = {
                let mut slots = lock(&self.slots);
                let slot = slots.entry(preset.id.clone()).or_default();
                match (slot.running.as_ref().map(|running| running.done.clone()), slot.readiness.clone()) {
                    (Some(done), _) => done,
                    (None, Some(Readiness::Ready { .. })) => {
                        slot.starting += 1;
                        let program = slot.program.clone().unwrap_or_else(|| Program::at(preset.command.clone()));
                        return Ok((program, Starting { agents: self.clone(), preset: preset.id.clone() }));
                    }
                    (None, Some(other)) if looked => return Err(Refusal::NotReady(other)),
                    // The check this turn asked for was ended by the feature's switch: the turn does not start another.
                    (None, None) if looked => return Err(Refusal::Off),
                    (None, _) => {
                        looked = true;
                        self.share_check(&mut slots, preset, Plan::Look)
                    }
                }
            };
            ended(done).await;
        }
    }

    /// Signs `preset`'s CLI out with the protocol's `logout`, which the agent itself carries out on the credential it
    /// keeps; the sessions that ran under the account end, and the CLI is looked at again. `Err` tells why nothing
    /// was signed out.
    pub async fn sign_out(self: &Arc<Self>, preset: &AgentPreset) -> Result<(), String> {
        if !self.enabled() {
            return Err("ACP agents are turned off in Settings.".to_owned());
        }
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
        let asked = async {
            let (connection, _incoming) = Connection::start(self.parts.processes.clone(), launch(preset, &program, cwd)).await?;
            let done = async {
                initialize(&connection).await?;
                connection.request("logout", json!({})).await
            }
            .await;
            connection.kill();
            done.map(|_| ())
        };
        asked.await.map_err(|fault: Fault| fault.to_string())?;
        drop(starting);
        self.account_left(&preset.id, AccountEvent::Left);
        // The agents that ran under the account hold a session of it no longer.
        let ran: Vec<ThreadId> = lock(&self.sessions).iter().filter(|(_, session)| session.preset.id == preset.id).map(|(thread, _)| thread.clone()).collect();
        for thread in &ran {
            self.end_process(thread);
        }
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

    /// Whether `preset`'s CLI has a quota to report now: the feature is on, the agent reports one, and its CLI was
    /// last found ready (installed, current, signed in). Nothing is started to find that out.
    pub fn reports_usage(&self, preset: &AgentPreset) -> bool {
        preset.usage.is_some()
            && self.enabled()
            && matches!(lock(&self.slots).get(&preset.id).and_then(|slot| slot.readiness.as_ref()), Some(Readiness::Ready { .. }))
    }

    /// The quota of the account `preset`'s CLI is signed in with, as the CLI's own report gives it (its
    /// `command.data`). `None` where it cannot be asked now: [`Self::reports_usage`] says no, or the CLI is being
    /// checked or updated, and once the feature is turned off or the agent signed out while the CLI runs (which ends
    /// it). `Some(Err)` is a report that failed, in the CLI's words.
    pub async fn usage(self: &Arc<Self>, preset: &AgentPreset) -> Option<Result<Value, String>> {
        self.usage_until(preset, &CancellationToken::new()).await
    }

    /// [`Self::usage`], ended by `stop` (`None`) and by the time a provider's own usage request is given (`Some(Err)`).
    pub async fn usage_until(self: &Arc<Self>, preset: &AgentPreset, stop: &CancellationToken) -> Option<Result<Value, String>> {
        let report = preset.usage.as_ref()?;
        if !self.enabled() {
            return None;
        }
        let cwd = AbsPath::new(self.parts.probe_cwd.clone())?;
        let (read, cancel) = (self.next_check.fetch_add(1, Ordering::Relaxed), CancellationToken::new());
        // The run is held against an update of the CLI, as a session's start is.
        let (program, _starting) = {
            let mut slots = lock(&self.slots);
            let slot = slots.get_mut(&preset.id)?;
            if slot.running.is_some() || !matches!(slot.readiness, Some(Readiness::Ready { .. })) {
                return None;
            }
            slot.starting += 1;
            slot.usage_reads.push((read, cancel.clone()));
            (slot.program.clone().map_or_else(|| preset.command.clone(), |program| program.path), Starting { agents: self.clone(), preset: preset.id.clone() })
        };
        let launch = Launch { program, args: report.args.clone(), env: preset.env.clone(), env_remove: Vec::new(), cwd };
        // An ended read drops the run, which ends the CLI's process.
        let ran = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            () = stop.cancelled() => None,
            () = mixdog_rt::time::sleep(std::time::Duration::from_millis(mixdog_ai::service::usage_antigravity::REQUEST_TIMEOUT_MS)) => {
                Some(Err(format!("{}'s quota report took longer than {} s.", preset.label, mixdog_ai::service::usage_antigravity::REQUEST_TIMEOUT_MS / 1_000)))
            }
            ran = run_to_exit(&self.parts.processes, launch) => Some(ran.map_err(|fault| fault.to_string())),
        };
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            slot.usage_reads.retain(|(id, _)| *id != read);
        }
        let ran = match ran? {
            Ok(ran) => ran,
            Err(why) => return Some(Err(why)),
        };
        let printed: Option<Value> = ran.stdout.lines().rev().find_map(|line| serde_json::from_str(line.trim()).ok());
        Some(match printed.as_ref().and_then(|printed| printed.pointer("/command/data")) {
            Some(data) if ran.code == Some(0) => Ok(data.clone()),
            _ => Err(printed.as_ref().and_then(|printed| printed.get("error")).and_then(Value::as_str).map_or_else(|| ran.said(), str::to_owned)),
        })
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
