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
use crate::agents::Agents;
use crate::agents::Readiness;
use crate::agents::lock;
use crate::connection::Connection;
use crate::connection::Fault;
use crate::connection::Launch;
use crate::connection::Ran;
use crate::connection::run_to_exit;
use crate::preset::AgentPreset;
use crate::preset::Version;
use crate::session::Models;
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
    /// The CLI as the last check found it: the preset's command, or its file where the installer puts it.
    pub(crate) program: Option<String>,
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
    async fn locate(&self, preset: &AgentPreset, cwd: &AbsPath) -> Result<(String, Ran), Fault> {
        let installed = preset.upkeep.installed_at.iter().filter_map(|location| {
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

    /// One check of `preset`'s CLI, with the upkeep `plan` allows.
    async fn examine(&self, preset: &AgentPreset, plan: Plan, check: u64) -> Readiness {
        // What an agent refused before the app last stopped stands over what this check finds.
        self.read_refusals().await;
        let Some(cwd) = AbsPath::new(self.parts.probe_cwd.clone()) else {
            return Readiness::Failed { version: None, message: format!("{} is not an absolute folder to check the CLI in", self.parts.probe_cwd.display()) };
        };
        let mut located = self.locate(preset, &cwd).await;
        match (&located, &preset.upkeep.installer, &preset.upkeep.update_args) {
            (Err(Fault::NotFound), Some(installer), _) if plan == Plan::Install => {
                self.set_step(preset, check, Step::Installing);
                let installed = succeeded(run_to_exit(&self.parts.processes, Self::plain(&installer.program, &installer.args, &cwd)).await);
                self.set_step(preset, check, Step::Checking);
                located = self.locate(preset, &cwd).await;
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
                let updated = succeeded(run_to_exit(&self.parts.processes, Self::plain(program, update, &cwd)).await);
                self.set_fault(preset, updated.err().map(|message| (Action::Update, message)));
                self.set_step(preset, check, Step::Checking);
                located = self.locate(preset, &cwd).await;
            }
            _ => {}
        }
        let (program, printed) = match located {
            Ok(found) => found,
            Err(Fault::NotFound) => return Readiness::NotInstalled,
            Err(fault) => return Readiness::Failed { version: None, message: fault.to_string() },
        };
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            slot.program = Some(program.clone());
        }
        let Some(found) = Version::find(&printed.stdout) else { return Readiness::VersionUnknown };
        let version = found.to_string();
        if found < preset.minimum_version {
            return Readiness::VersionTooOld { version };
        }
        // Whether the user is signed in shows only when a session is opened; the agent is asked to forget it again.
        let opened = async {
            let (connection, _incoming) = Connection::start(self.parts.processes.clone(), launch(preset, &program, cwd.clone())).await?;
            let capabilities = initialize(&connection).await?;
            let answer = connection.request("session/new", json!({ "cwd": cwd.as_path().to_string_lossy(), "mcpServers": [] })).await?;
            if let (Some(_), Some(id)) = (capabilities.pointer("/agentCapabilities/sessionCapabilities/close"), answer.get("sessionId").and_then(Value::as_str))
            {
                let _ = connection.request("session/close", json!({ "sessionId": id })).await;
            }
            connection.kill();
            Ok((answer, capabilities))
        };
        match opened.await {
            Ok((answer, capabilities)) => {
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
            Err(Fault::Rpc(error)) if error.code == AUTH_REQUIRED => Readiness::SignedOut { version, message: error.message },
            Err(fault) => Readiness::Failed { version: Some(version), message: fault.to_string() },
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
            if let Some(slot) = lock(&agents.slots).get_mut(&preset.id)
                && slot.running.as_ref().is_some_and(|running| running.id == id)
            {
                slot.running = None;
                slot.readiness = found;
            }
            (agents.parts.changed)();
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
    pub(crate) async fn ready_program(self: &Arc<Self>, preset: &AgentPreset) -> Result<(String, Starting), crate::agents::Refusal> {
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
                        let program = slot.program.clone().unwrap_or_else(|| preset.command.clone());
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
            (slot.program.clone().unwrap_or_else(|| preset.command.clone()), Starting { agents: self.clone(), preset: preset.id.clone() })
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
        // A quota read of the account signed out of has nothing left to report.
        if let Some(slot) = lock(&self.slots).get_mut(&preset.id) {
            for (_, read) in slot.usage_reads.drain(..) {
                read.cancel();
            }
        }
        // The agents that ran under the account hold a session of it no longer.
        let ran: Vec<ThreadId> = lock(&self.sessions).iter().filter(|(_, session)| session.preset.id == preset.id).map(|(thread, _)| thread.clone()).collect();
        for thread in &ran {
            self.end_process(thread);
        }
        // Whoever signs in next is not the account the agent refused.
        self.answered(preset).await;
        self.look(preset).await;
        (self.parts.changed)();
        Ok(())
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
            (slot.program.clone().unwrap_or_else(|| preset.command.clone()), Starting { agents: self.clone(), preset: preset.id.clone() })
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
        let slots: Vec<Slot> = lock(&self.slots).drain().map(|(_, slot)| slot).collect();
        for slot in slots {
            if let Some(running) = slot.running {
                running.cancel.cancel();
            }
            for (_, read) in slot.usage_reads {
                read.cancel();
            }
        }
    }
}
