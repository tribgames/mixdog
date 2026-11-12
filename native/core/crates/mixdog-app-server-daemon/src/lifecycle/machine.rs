//! The core state machine (LR §5.1, SPEC R22): pure state and transitions. It performs no
//! I/O: every outside consequence is queued as an [`Effect`] for [`super::Lifecycle`] to run
//! after the lock is released.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use mixdog_core_api::CoreState;
use mixdog_core_api::handle::MigrationProgress;
use sha2::Digest;
use sha2::Sha256;

use super::model::ActivityInfo;
use super::model::BUSY_WORK_SETTLED;
use super::model::SERVICE_CALLS_SETTLED;
use super::model::Blocked;
use super::model::BlockedStatus;
use super::model::ClientGrace;
use super::model::ClientKind;
use super::model::CommandError;
use super::model::CoreStatus;
use super::model::DiscoveryPhase;
use super::model::DiscoveryState;
use super::model::DrainNotice;
use super::model::DrainStatus;
use super::model::Effect;
use super::model::FenceReason;
use super::model::Migration;
use super::model::MigrationStatus;
use super::model::ReleaseCause;
use super::model::Running;
use super::model::RunningWork;
use super::model::StateName;
use super::model::StopMode;
use super::model::StopReason;

#[derive(Debug, Clone)]
struct Drain {
    drain_id: String,
    reason: StopReason,
    /// The busy set at commit: the confirmation token is bound to it (LR §5.1 step 4).
    committed: BTreeSet<u64>,
    aborting: bool,
    releasing: bool,
}

#[derive(Debug, Clone)]
enum Phase {
    Booting,
    Blocked(Blocked),
    Migrating(Migration),
    Serving,
    Draining(Drain),
    Stopped,
    Fenced(FenceReason),
}

pub struct Machine {
    instance_id: String,
    version: String,
    secret: [u8; 32],
    phase: Phase,
    hold: bool,
    clients: usize,
    /// A client has connected since the core served: the `noClients` trigger means "the last
    /// client left", so a core that nobody has reached yet is not stopped by a work item
    /// finishing before its launcher connects.
    client_seen: bool,
    client_grace: ClientGrace,
    /// The armed no-clients grace: its generation and the Node text of the registry that emptied (`client-grace.mjs` `graceTimer`).
    grace: Option<(u64, &'static str)>,
    grace_generation: u64,
    /// The grace ran out with nobody attached (`signalled`): a core idle from now on stops itself, until a client attaches again.
    grace_fired: bool,
    /// Service calls in flight (Node's `inFlightWork().activeCalls`, `daemon.mjs:444-449`): they keep the core from stopping itself with
    /// nobody attached, but are not listed as running work and do not hold an explicit stop.
    calls: usize,
    /// New-task requests in flight (`thread/start` of a task with its first prompt): host logic in Node (`submitNewTask` runs in the
    /// desktop service's `SessionHost`), counted as a call by the self-shutdown (Node's `activeCalls` holds the `desktop.invoke`). A stop
    /// request does not wait for one: Node's `/stop` shuts down without `drainDeferral` (`routes.mjs:200-209` → SIGTERM →
    /// `daemon.mjs:272 shutdown`; `drainDeferral` is consulted by `maybeSelfShutdown` only, `daemon.mjs:533-536`), so the attempts are
    /// cut first ([`Effect::CutNewTasks`]) and their requests no longer hold the drain.
    new_tasks: usize,
    /// The new-task attempts were cut ([`Effect::CutNewTasks`] is sent once).
    new_tasks_cut: bool,
    next_id: u64,
    activities: BTreeMap<u64, Running>,
    /// Node's self-shutdown text for the work that ends last, by activity id (absent: [`BUSY_WORK_SETTLED`]).
    settle_texts: BTreeMap<u64, &'static str>,
    seq: u64,
    release_started: bool,
    effects: Vec<Effect>,
}

impl Machine {
    pub fn new(instance_id: String, version: String) -> Self {
        Self {
            instance_id,
            version,
            secret: rand::random(),
            phase: Phase::Booting,
            hold: false,
            clients: 0,
            client_seen: false,
            client_grace: ClientGrace::immediate(),
            grace: None,
            grace_generation: 0,
            grace_fired: false,
            calls: 0,
            new_tasks: 0,
            new_tasks_cut: false,
            next_id: 1,
            activities: BTreeMap::new(),
            settle_texts: BTreeMap::new(),
            seq: 0,
            release_started: false,
            effects: Vec::new(),
        }
    }

    pub fn with_client_grace(mut self, grace: ClientGrace) -> Self {
        self.client_grace = grace;
        self
    }

    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    // ---- inputs from the running core -------------------------------------------------

    pub fn begin_activity(&mut self, info: ActivityInfo) -> u64 {
        self.begin_activity_settling(info, BUSY_WORK_SETTLED)
    }

    /// As [`Machine::begin_activity`], with the text Node's self-shutdown carries when this is the work whose end lets the core stop
    /// (`SERVICE_CALLS_SETTLED`, `MEMORY_AGENT_ACTIVITY_CHANGED`, or the default `BUSY_WORK_SETTLED`).
    pub fn begin_activity_settling(&mut self, info: ActivityInfo, settled: &'static str) -> u64 {
        let id = self.next_id;
        self.settle_texts.insert(id, settled);
        self.next_id += 1;
        self.activities.insert(
            id,
            Running {
                id,
                kind: info.kind,
                thread_id: info.thread_id,
                turn_id: info.turn_id,
                title: info.title,
            },
        );
        self.seq += 1;
        id
    }

    pub fn end_activity(&mut self, id: u64) {
        if self.activities.remove(&id).is_some() {
            self.seq += 1;
            // The last work ending with nobody attached is Node's deferred self-shutdown settling (`daemon.mjs:543`, `:556`, `:1065`).
            let text = self.settle_texts.remove(&id).unwrap_or(BUSY_WORK_SETTLED);
            self.settle(text);
        }
    }

    pub fn client_opened(&mut self) {
        self.clients += 1;
        self.client_seen = true;
        self.seq += 1;
        // A lifecycle client that attaches again keeps the core up: the pending grace and the latch both clear (`noteLifecycleClient`).
        if self.grace.take().is_some() {
            self.effects.push(Effect::CancelGrace);
        }
        self.grace_fired = false;
    }

    /// The grace of generation `generation` ran out. Node's timer re-checks the clients and signals the shutdown, which the work still
    /// running defers like any self-shutdown (`maybeSelfShutdown`): the stop then follows the work's end.
    pub fn grace_expired(&mut self, generation: u64) {
        let Some((armed, text)) = self.grace else { return };
        if armed != generation {
            return;
        }
        self.grace = None;
        if self.clients > 0 {
            return;
        }
        self.grace_fired = true;
        self.seq += 1;
        self.settle(text);
    }

    /// `maybeArm`: only once per emptying (an armed grace is never pushed out, a fired one never re-armed).
    fn arm_grace(&mut self, kind: ClientKind) {
        if self.clients > 0 || !self.client_seen || self.grace.is_some() || self.grace_fired {
            return;
        }
        if matches!(self.phase, Phase::Stopped | Phase::Fenced(_)) {
            return;
        }
        let delay = self.client_grace.after(kind);
        if delay.is_zero() {
            self.grace_fired = true;
            return;
        }
        self.grace_generation += 1;
        self.grace = Some((self.grace_generation, kind.node_text()));
        self.effects.push(Effect::ArmGrace { generation: self.grace_generation, delay });
    }

    pub fn call_started(&mut self) {
        self.calls += 1;
        self.seq += 1;
    }

    /// The last call ending with nobody attached is Node's deferred self-shutdown settling on the calls (`daemon.mjs:543`).
    pub fn call_ended(&mut self) {
        self.calls = self.calls.saturating_sub(1);
        self.seq += 1;
        self.settle(SERVICE_CALLS_SETTLED);
    }

    pub fn new_task_started(&mut self) {
        self.new_tasks += 1;
        self.seq += 1;
    }

    /// As [`Machine::call_ended`], for a new-task request.
    pub fn new_task_ended(&mut self) {
        self.new_tasks = self.new_tasks.saturating_sub(1);
        self.seq += 1;
        self.settle(SERVICE_CALLS_SETTLED);
    }

    /// Node's host dispose at a stop request: the new-task attempts are cut first (each ends at the call it was awaiting), once.
    /// Whether attempts in flight were cut now.
    fn cut_new_tasks(&mut self) -> bool {
        if self.new_tasks_cut {
            return false;
        }
        self.new_tasks_cut = true;
        if self.new_tasks == 0 {
            return false;
        }
        self.seq += 1;
        self.effects.push(Effect::CutNewTasks);
        true
    }

    /// The cut at a stop request, by who asked. Node's `/stop {force:true}` (the app's quit, `session-client.mjs:667-707` →
    /// `routes.mjs:200-209` → `shutdown`) skips `drainDeferral`: every management stop but `Quit` is that stop. A `Quit` stop is Node's
    /// `/shutdown` (`routes.mjs:189-196`) and `NoClients` its last client leaving, both `maybeSelfShutdown`, whose `drainDeferral`
    /// (`daemon.mjs:533-536`, `daemon-drain-policy.mjs:11-16`) waits for every active service call, a new task's `desktop.invoke` included.
    fn cut_new_tasks_for(&mut self, reason: StopReason) -> bool {
        !matches!(reason, StopReason::Quit | StopReason::NoClients) && self.cut_new_tasks()
    }

    /// Calls a drain waits for: every call, and the new-task requests until a stop request cut them. A cut attempt's call in flight is
    /// awaited by the release's session shutdown (`NewTaskReceipts::shutdown`), as Node's shutdown awaits the session's work
    /// (session-service.mjs:271-275); its request is never answered.
    fn calls_in_flight(&self) -> bool {
        self.calls > 0 || (self.new_tasks > 0 && !self.new_tasks_cut)
    }

    /// `kind` is the registry the client was in: the last one leaving names Node's self-shutdown text.
    pub fn client_closed(&mut self, kind: ClientKind) {
        self.clients = self.clients.saturating_sub(1);
        self.seq += 1;
        self.arm_grace(kind);
        self.settle(kind.node_text());
    }

    // ---- boot transitions (LR §3) -----------------------------------------------------

    pub fn set_blocked(&mut self, blocked: Blocked) -> Result<(), CommandError> {
        self.boot_step(Phase::Blocked(blocked), |phase| {
            matches!(phase, Phase::Booting | Phase::Blocked(_))
        })
    }

    pub fn set_migrating(&mut self, migration: Migration) -> Result<(), CommandError> {
        self.boot_step(Phase::Migrating(migration), |phase| {
            matches!(phase, Phase::Booting | Phase::Blocked(_) | Phase::Migrating(_))
        })
    }

    pub fn set_serving(&mut self) -> Result<(), CommandError> {
        self.boot_step(Phase::Serving, |phase| {
            matches!(phase, Phase::Booting | Phase::Blocked(_) | Phase::Migrating(_))
        })
    }

    fn boot_step(
        &mut self,
        next: Phase,
        allowed: impl FnOnce(&Phase) -> bool,
    ) -> Result<(), CommandError> {
        if !allowed(&self.phase) {
            return Err(self.refusal());
        }
        self.phase = next;
        self.seq += 1;
        let discovery = self.discovery();
        self.effects.push(Effect::Discovery(discovery));
        Ok(())
    }

    /// The data directory can no longer be trusted: admission closes, nothing is waited for,
    /// the process leaves (LR §2.4).
    pub fn fence(&mut self, reason: FenceReason) {
        if matches!(self.phase, Phase::Stopped | Phase::Fenced(_)) {
            return;
        }
        self.phase = Phase::Fenced(reason);
        self.seq += 1;
        self.begin_release(ReleaseCause::Fenced(reason));
    }

    /// The discovery file cannot be published: admission closes and the process leaves with Node's fatal-boot code, from any phase.
    pub fn fail_boot(&mut self) {
        if matches!(self.phase, Phase::Stopped | Phase::Fenced(_)) {
            return;
        }
        self.phase = Phase::Stopped;
        self.seq += 1;
        self.begin_release(ReleaseCause::FatalBoot);
    }

    pub fn mark_stopped(&mut self) {
        self.phase = Phase::Stopped;
        self.seq += 1;
    }

    // ---- management commands (LR §6.1) ------------------------------------------------

    pub fn hold(&mut self, on: bool) -> Result<(), CommandError> {
        match self.phase {
            Phase::Booting | Phase::Blocked(_) | Phase::Migrating(_) | Phase::Serving => {}
            _ => return Err(self.refusal()),
        }
        if self.hold != on {
            self.hold = on;
            self.seq += 1;
        }
        Ok(())
    }

    /// `stop{mode, reason, confirmToken?}`. `whenIdle` commits a drain (or, in a drain, only
    /// upgrades a `noClients` reason to the caller's); `abortConfirmed` cancels what runs and
    /// needs the token of the drain it is aimed at.
    pub fn stop(
        &mut self,
        mode: StopMode,
        reason: StopReason,
        confirm_token: Option<&str>,
    ) -> Result<(), CommandError> {
        match &self.phase {
            Phase::Booting | Phase::Blocked(_) | Phase::Serving => match mode {
                StopMode::WhenIdle => {
                    let _ = self.cut_new_tasks_for(reason);
                    self.commit_drain(reason);
                    Ok(())
                }
                StopMode::AbortConfirmed => Err(CommandError::NotDraining),
            },
            Phase::Migrating(_) => Err(CommandError::Migrating),
            Phase::Draining(_) if matches!(mode, StopMode::WhenIdle) => {
                // A stop requested in a self-shutdown's drain: the new-task requests it waited for are cut now.
                if self.cut_new_tasks_for(reason) {
                    self.settle("");
                }
                Ok(())
            }
            Phase::Draining(drain) => match mode {
                StopMode::WhenIdle => Ok(()),
                StopMode::AbortConfirmed => {
                    let expected = self.drain_token(drain);
                    if !confirm_token.is_some_and(|given| ct_eq(given, &expected)) {
                        return Err(CommandError::ConfirmationInvalid);
                    }
                    if drain.releasing || drain.aborting {
                        return Ok(());
                    }
                    self.cut_new_tasks();
                    let running = self.running();
                    if let Phase::Draining(drain) = &mut self.phase {
                        drain.aborting = true;
                    }
                    self.seq += 1;
                    self.effects.push(Effect::CancelRunning(running));
                    Ok(())
                }
            },
            Phase::Stopped | Phase::Fenced(_) => Err(CommandError::Stopped),
        }
    }

    /// Whether a client's request to stop the core is put off while clients are attached. Node's `POST /shutdown` calls
    /// `maybeSelfShutdown('no live session clients')` (`routes.mjs:189-196`, `daemon.mjs:1245`), which returns after logging
    /// `shutdown deferred (..)` while any registry holds a client (`daemon.mjs:508-529`) and leaves the stop to the last client
    /// leaving. That is the `Quit` idle stop only (what `shutdownDaemon` and the headless CLI send): a replacement is not deferred
    /// (`!replacing`, `:512`), nor is a signal, which does not come through here, nor a `UserStop`, which Node has no request for and
    /// which the user's own stop command waits on.
    pub fn defers_stop(&self, mode: StopMode, reason: StopReason) -> bool {
        matches!(self.phase, Phase::Serving)
            && matches!(mode, StopMode::WhenIdle)
            && matches!(reason, StopReason::Quit)
            && self.clients > 0
    }

    pub fn cancel_drain(&mut self, drain_id: &str) -> Result<(), CommandError> {
        let Phase::Draining(drain) = &self.phase else {
            return Err(CommandError::NotDraining);
        };
        if drain.drain_id != drain_id {
            return Err(CommandError::DrainMismatch);
        }
        if drain.releasing || drain.aborting {
            return Err(CommandError::PastIdleWait);
        }
        self.phase = Phase::Serving;
        self.seq += 1;
        let discovery = self.discovery();
        self.effects.push(Effect::Discovery(discovery));
        Ok(())
    }

    /// The one decision a user takes on an undecidable prior owner (LR §3.1).
    pub fn release_decision(&mut self, pid: u32, confirm_token: &str) -> Result<(), CommandError> {
        let Phase::Blocked(blocked @ Blocked::Undecidable { .. }) = &self.phase else {
            return Err(CommandError::NotBlocked);
        };
        if blocked.pid() != pid || !ct_eq(confirm_token, &self.release_token(pid)) {
            return Err(CommandError::ConfirmationInvalid);
        }
        self.effects.push(Effect::ReleaseDecision { pid });
        Ok(())
    }

    pub fn check_terminate(&self, confirm_token: &str) -> Result<(), CommandError> {
        if ct_eq(confirm_token, &self.terminate_token()) {
            Ok(())
        } else {
            Err(CommandError::ConfirmationInvalid)
        }
    }

    // ---- views -----------------------------------------------------------------------

    pub fn status(&self) -> CoreStatus {
        let (blocked, migration, drain, fenced) = match &self.phase {
            Phase::Blocked(blocked) => (
                Some(BlockedStatus {
                    blocked: blocked.clone(),
                    confirm_token: matches!(blocked, Blocked::Undecidable { .. })
                        .then(|| self.release_token(blocked.pid())),
                }),
                None,
                None,
                None,
            ),
            Phase::Migrating(m) => (
                None,
                Some(MigrationStatus { kind: m.kind.clone(), done: m.done, total: m.total }),
                None,
                None,
            ),
            Phase::Draining(d) => (
                None,
                None,
                Some(DrainStatus {
                    drain_id: d.drain_id.clone(),
                    reason: d.reason,
                    confirm_token: self.drain_token(d),
                    releasing: d.releasing,
                }),
                None,
            ),
            Phase::Fenced(reason) => (None, None, None, Some(*reason)),
            Phase::Booting | Phase::Serving | Phase::Stopped => (None, None, None, None),
        };
        CoreStatus {
            state: self.state_name(),
            version: self.version.clone(),
            instance_id: self.instance_id.clone(),
            hold: self.hold,
            clients: self.clients,
            running: self.running().iter().map(RunningWork::from).collect(),
            blocked,
            migration,
            drain,
            fenced,
            terminate_token: self.terminate_token(),
            seq_of_snapshot: self.seq,
        }
    }

    pub fn core_state(&self) -> CoreState {
        match &self.phase {
            Phase::Booting | Phase::Blocked(_) => CoreState::Booting,
            Phase::Migrating(m) => CoreState::Migrating(MigrationProgress {
                kind: m.kind.as_str().into(),
                done: m.done,
                total: m.total,
            }),
            Phase::Serving => CoreState::Serving,
            Phase::Draining(d) => CoreState::Draining { reason: d.reason.drain_reason() },
            Phase::Stopped | Phase::Fenced(_) => CoreState::Stopped,
        }
    }

    pub fn hold_on(&self) -> bool {
        self.hold
    }

    // ---- internals --------------------------------------------------------------------

    fn state_name(&self) -> StateName {
        match self.phase {
            Phase::Booting => StateName::Booting,
            Phase::Blocked(_) => StateName::Blocked,
            Phase::Migrating(_) => StateName::Migrating,
            Phase::Serving => StateName::Serving,
            Phase::Draining(_) => StateName::Draining,
            Phase::Stopped => StateName::Stopped,
            Phase::Fenced(_) => StateName::Fenced,
        }
    }

    fn discovery(&self) -> DiscoveryState {
        let (phase, blocked, drain_id) = match &self.phase {
            Phase::Booting => (DiscoveryPhase::Booting, None, None),
            Phase::Blocked(b) => (DiscoveryPhase::Blocked, Some(b.clone()), None),
            Phase::Migrating(_) => (DiscoveryPhase::Migrating, None, None),
            Phase::Serving => (DiscoveryPhase::Serving, None, None),
            Phase::Draining(d) => (DiscoveryPhase::Draining, None, Some(d.drain_id.clone())),
            Phase::Stopped | Phase::Fenced(_) => (DiscoveryPhase::Draining, None, None),
        };
        DiscoveryState { phase, blocked, drain_id }
    }

    fn refusal(&self) -> CommandError {
        match self.phase {
            Phase::Draining(_) => CommandError::WindingDown,
            Phase::Stopped | Phase::Fenced(_) => CommandError::Stopped,
            _ => CommandError::BadPhase,
        }
    }

    fn running(&self) -> Vec<Running> {
        self.activities.values().filter(|a| a.kind.blocks_idle()).cloned().collect()
    }

    fn commit_drain(&mut self, reason: StopReason) {
        let drain = Drain {
            drain_id: hex(&rand::random::<[u8; 16]>()),
            reason,
            committed: self.activities.values().filter(|a| a.kind.blocks_idle()).map(|a| a.id).collect(),
            aborting: false,
            releasing: false,
        };
        self.phase = Phase::Draining(drain);
        self.seq += 1;
        // Deferred starts are released into admission, which now refuses them (LR §5.1 step 2).
        self.hold = false;
        let discovery = self.discovery();
        self.effects.push(Effect::Discovery(discovery));
        self.announce_drain();
        // Already draining: the serving branch of `settle` is not taken, and an empty trigger is the request finding the core idle.
        self.settle("");
    }

    fn announce_drain(&mut self) {
        let Phase::Draining(drain) = &self.phase else { return };
        let notice = DrainNotice {
            drain_id: drain.drain_id.clone(),
            reason: drain.reason.drain_reason(),
            running: self.running(),
            confirm_token: self.drain_token(drain),
        };
        self.effects.push(Effect::DrainNotice(notice));
    }

    /// Ends an idle wait on the event "the busy set is empty", and runs the `noClients`
    /// trigger on "the last client left and nothing keeps the core alive".
    /// `trigger` is Node's text of what made the core idle with nobody attached (`ClientKind::node_text`, `BUSY_WORK_SETTLED`).
    fn settle(&mut self, trigger: &'static str) {
        // A service call in flight defers a drain like busy work does (`drainDeferral`, `daemon-drain-policy.mjs`: calls, then busy).
        let calls = self.calls_in_flight();
        let busy = calls || self.activities.values().any(|a| a.kind.blocks_idle());
        match &mut self.phase {
            Phase::Draining(drain) if !drain.releasing && !busy => {
                drain.releasing = true;
                let reason = drain.reason;
                let cause = ReleaseCause::Stop(reason);
                self.seq += 1;
                // A `Quit` request held back by work is Node's `/shutdown` deferred by `drainDeferral` (`daemon.mjs:530-560`): the stop that
                // follows is the recheck's `maybeSelfShutdown('service calls settled' | 'busy service work settled')`, so it reads what settled.
                // The empty trigger is the request itself finding the core idle. A signal's name, noted before, wins.
                if reason == StopReason::Quit && !trigger.is_empty() {
                    self.effects.push(Effect::NodeTrigger(trigger));
                }
                self.begin_release(cause);
            }
            Phase::Serving
                if self.grace_fired && self.clients == 0 && self.activities.is_empty() && !calls =>
            {
                self.effects.push(Effect::NodeTrigger(trigger));
                self.commit_drain(StopReason::NoClients);
            }
            _ => {}
        }
    }

    fn begin_release(&mut self, cause: ReleaseCause) {
        if !self.release_started {
            self.release_started = true;
            self.effects.push(Effect::BeginRelease(cause));
        }
    }

    fn drain_token(&self, drain: &Drain) -> String {
        let mut parts: Vec<Vec<u8>> = vec![b"drain".to_vec(), drain.drain_id.as_bytes().to_vec()];
        parts.extend(drain.committed.iter().map(|id| id.to_be_bytes().to_vec()));
        self.token(&parts)
    }

    fn release_token(&self, pid: u32) -> String {
        self.token(&[b"release".to_vec(), pid.to_be_bytes().to_vec()])
    }

    pub fn terminate_token(&self) -> String {
        self.token(&[b"terminate".to_vec(), self.instance_id.as_bytes().to_vec()])
    }

    fn token(&self, parts: &[Vec<u8>]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.secret);
        for part in parts {
            hasher.update((part.len() as u64).to_be_bytes());
            hasher.update(part);
        }
        hex(&hasher.finalize())
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// Comparison that does not stop at the first differing byte.
pub(crate) fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::model::ActivityKind;

    fn machine() -> Machine {
        let mut m = Machine::new("inst".into(), "1.4.6".into());
        m.set_serving().unwrap();
        m.take_effects();
        m
    }

    fn work(kind: ActivityKind) -> ActivityInfo {
        ActivityInfo { kind, thread_id: Some("t".into()), turn_id: Some("u".into()), title: "x".into() }
    }

    fn releases(effects: &[Effect]) -> usize {
        effects.iter().filter(|e| matches!(e, Effect::BeginRelease(_))).count()
    }

    fn drain_token(m: &Machine) -> String {
        m.status().drain.unwrap().confirm_token
    }

    #[test]
    fn last_client_leaving_an_idle_core_releases_at_once() {
        let mut m = machine();
        m.client_opened();
        m.client_closed(ClientKind::Session);
        let effects = m.take_effects();
        assert_eq!(releases(&effects), 1);
        assert!(matches!(
            effects.iter().find_map(|e| match e {
                Effect::BeginRelease(c) => Some(*c),
                _ => None,
            }),
            Some(ReleaseCause::Stop(StopReason::NoClients))
        ));
        assert_eq!(m.status().state, StateName::Draining);
    }

    /// Node's `maybeSelfShutdown` texts (`daemon.mjs:1245`, `:917`, `:1159`, `:556`), each before the release it names.
    fn node_triggers(effects: &[Effect]) -> Vec<&'static str> {
        effects
            .iter()
            .filter_map(|e| match e {
                Effect::NodeTrigger(text) => Some(*text),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_self_shutdown_names_the_registry_that_emptied_or_the_work_that_settled() {
        for (kind, text) in [
            (ClientKind::Session, "no live session clients"),
            (ClientKind::Channel, "no live channel clients"),
            (ClientKind::Remote, "remote clients changed"),
        ] {
            let mut m = machine();
            m.client_opened();
            m.client_closed(kind);
            let effects = m.take_effects();
            assert_eq!(node_triggers(&effects), [text]);
            let trigger = effects.iter().position(|e| matches!(e, Effect::NodeTrigger(_))).unwrap();
            let begin = effects.iter().position(|e| matches!(e, Effect::BeginRelease(_))).unwrap();
            assert!(trigger < begin, "the text is noted before the release begins");
        }
        let mut m = machine();
        m.client_opened();
        let id = m.begin_activity(work(ActivityKind::Turn));
        m.client_closed(ClientKind::Session);
        assert!(node_triggers(&m.take_effects()).is_empty(), "work keeps it alive: no trigger yet");
        m.end_activity(id);
        assert_eq!(node_triggers(&m.take_effects()), ["busy service work settled"]);
    }

    #[test]
    fn a_core_nobody_reached_is_not_stopped_by_work_ending() {
        let mut m = machine();
        let id = m.begin_activity(work(ActivityKind::ScheduledRun));
        m.end_activity(id);
        assert_eq!(releases(&m.take_effects()), 0);
        assert_eq!(m.status().state, StateName::Serving);
    }

    #[test]
    fn running_work_keeps_the_core_alive_after_the_last_client_leaves() {
        let mut m = machine();
        m.client_opened();
        let id = m.begin_activity(work(ActivityKind::Turn));
        m.client_closed(ClientKind::Session);
        assert_eq!(m.status().state, StateName::Serving);
        m.end_activity(id);
        assert_eq!(releases(&m.take_effects()), 1);
    }

    #[test]
    fn goals_schedules_and_channels_keep_it_alive_but_do_not_hold_a_stop() {
        for kind in [ActivityKind::Goal, ActivityKind::Schedule, ActivityKind::Channel] {
            let mut m = machine();
            m.client_opened();
            let id = m.begin_activity(work(kind));
            m.client_closed(ClientKind::Session);
            assert_eq!(m.status().state, StateName::Serving, "{kind:?}");
            assert_eq!(releases(&m.take_effects()), 0);
            m.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
            assert_eq!(releases(&m.take_effects()), 1, "{kind:?}");
            m.end_activity(id);
        }
    }

    #[test]
    fn stop_waits_for_the_busy_set_and_runs_one_release() {
        let mut m = machine();
        let a = m.begin_activity(work(ActivityKind::Turn));
        let b = m.begin_activity(work(ActivityKind::BackgroundShell));
        m.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        let effects = m.take_effects();
        assert_eq!(releases(&effects), 0);
        assert!(effects.iter().any(|e| matches!(e, Effect::DrainNotice(n) if n.running.len() == 2)));
        m.end_activity(a);
        assert_eq!(releases(&m.take_effects()), 0);
        m.end_activity(b);
        assert_eq!(releases(&m.take_effects()), 1);
        m.fence(FenceReason::LockLost);
        assert_eq!(releases(&m.take_effects()), 0, "one release only");
    }

    #[test]
    fn abort_needs_the_drain_token_and_never_precedes_a_drain() {
        let mut m = machine();
        let _a = m.begin_activity(work(ActivityKind::Turn));
        assert_eq!(
            m.stop(StopMode::AbortConfirmed, StopReason::Quit, Some("x")),
            Err(CommandError::NotDraining)
        );
        m.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        m.take_effects();
        assert_eq!(
            m.stop(StopMode::AbortConfirmed, StopReason::Quit, None),
            Err(CommandError::ConfirmationInvalid)
        );
        assert_eq!(
            m.stop(StopMode::AbortConfirmed, StopReason::Quit, Some("nope")),
            Err(CommandError::ConfirmationInvalid)
        );
        let token = drain_token(&m);
        m.stop(StopMode::AbortConfirmed, StopReason::Quit, Some(&token)).unwrap();
        let effects = m.take_effects();
        assert!(effects.iter().any(|e| matches!(e, Effect::CancelRunning(r) if r.len() == 1)));
    }

    #[test]
    fn a_turn_finishing_keeps_the_token_valid_for_the_rest() {
        let mut m = machine();
        let a = m.begin_activity(work(ActivityKind::Turn));
        let _b = m.begin_activity(work(ActivityKind::Turn));
        m.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        let token = drain_token(&m);
        m.end_activity(a);
        m.take_effects();
        m.stop(StopMode::AbortConfirmed, StopReason::Quit, Some(&token)).unwrap();
        assert!(m.take_effects().iter().any(|e| matches!(e, Effect::CancelRunning(r) if r.len() == 1)));
    }

    #[test]
    fn a_token_of_another_drain_is_refused() {
        let mut m = machine();
        let _a = m.begin_activity(work(ActivityKind::Turn));
        m.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        let first = drain_token(&m);
        let id = m.status().drain.unwrap().drain_id;
        m.cancel_drain(&id).unwrap();
        m.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        assert_eq!(
            m.stop(StopMode::AbortConfirmed, StopReason::Quit, Some(&first)),
            Err(CommandError::ConfirmationInvalid)
        );
    }

    #[test]
    fn cancel_drain_restores_serving_only_while_idle_waiting() {
        let mut m = machine();
        let a = m.begin_activity(work(ActivityKind::Turn));
        m.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
        let id = m.status().drain.unwrap().drain_id;
        assert_eq!(m.cancel_drain("other"), Err(CommandError::DrainMismatch));
        m.take_effects();
        m.cancel_drain(&id).unwrap();
        assert_eq!(m.status().state, StateName::Serving);
        assert!(matches!(
            m.take_effects().as_slice(),
            [Effect::Discovery(d)] if d.phase == DiscoveryPhase::Serving
        ));
        m.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
        m.end_activity(a);
        let id = m.status().drain.unwrap().drain_id;
        assert_eq!(m.cancel_drain(&id), Err(CommandError::PastIdleWait));
    }

    #[test]
    fn a_second_stop_leaves_the_first_drain_alone() {
        let mut m = machine();
        let _a = m.begin_activity(work(ActivityKind::Turn));
        m.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        let first = m.status().drain.unwrap();
        m.take_effects();
        m.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
        assert_eq!(m.status().drain.unwrap(), first);
        assert!(m.take_effects().is_empty());
    }

    #[test]
    fn hold_is_dropped_by_the_drain_commit() {
        let mut m = machine();
        m.hold(true).unwrap();
        assert!(m.hold_on());
        let _a = m.begin_activity(work(ActivityKind::Turn));
        m.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
        assert!(!m.hold_on());
        assert_eq!(m.hold(true), Err(CommandError::WindingDown));
    }

    #[test]
    fn stop_is_refused_during_migration_and_after_the_end() {
        let mut m = Machine::new("i".into(), "1".into());
        m.set_migrating(Migration { kind: "sessions".into(), done: 1, total: 2 }).unwrap();
        assert_eq!(m.stop(StopMode::WhenIdle, StopReason::Quit, None), Err(CommandError::Migrating));
        m.set_serving().unwrap();
        m.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        m.mark_stopped();
        assert_eq!(m.stop(StopMode::WhenIdle, StopReason::Quit, None), Err(CommandError::Stopped));
    }

    /// Node's `/shutdown` waits for a new task's call (`drainDeferral`, `daemon.mjs:533-536`); its `/stop {force:true}` cuts the attempt
    /// and does not wait for its request.
    #[test]
    fn a_quit_stop_waits_for_a_new_task_and_a_user_stop_cuts_it() {
        let mut m = Machine::new("i".into(), "1".into());
        m.set_serving().unwrap();
        m.new_task_started();
        m.take_effects();
        m.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        let effects = m.take_effects();
        assert!(!effects.iter().any(|e| matches!(e, Effect::CutNewTasks)), "{effects:?}");
        assert_eq!(releases(&effects), 0);
        m.stop(StopMode::WhenIdle, StopReason::UserStop, None).unwrap();
        let effects = m.take_effects();
        assert!(effects.iter().any(|e| matches!(e, Effect::CutNewTasks)), "{effects:?}");
        assert_eq!(releases(&effects), 1);
    }

    #[test]
    fn a_blocked_core_stops_without_waiting() {
        let mut m = Machine::new("i".into(), "1".into());
        m.set_blocked(Blocked::WaitExit { pid: 9 }).unwrap();
        m.take_effects();
        m.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        assert_eq!(releases(&m.take_effects()), 1);
    }

    #[test]
    fn release_decision_needs_its_token_and_an_undecidable_owner() {
        let mut m = Machine::new("i".into(), "1".into());
        assert_eq!(m.release_decision(5, "x"), Err(CommandError::NotBlocked));
        m.set_blocked(Blocked::WaitExit { pid: 5 }).unwrap();
        assert_eq!(m.release_decision(5, "x"), Err(CommandError::NotBlocked));
        m.set_blocked(Blocked::Undecidable {
            pid: 5,
            image: "node".into(),
            command_line: "node daemon.mjs".into(),
            start_time: "t".into(),
        })
        .unwrap();
        let token = m.status().blocked.unwrap().confirm_token.unwrap();
        assert_eq!(m.release_decision(6, &token), Err(CommandError::ConfirmationInvalid));
        assert_eq!(m.release_decision(5, "bad"), Err(CommandError::ConfirmationInvalid));
        m.take_effects();
        m.release_decision(5, &token).unwrap();
        assert_eq!(m.take_effects(), vec![Effect::ReleaseDecision { pid: 5 }]);
    }

    #[test]
    fn fence_closes_without_waiting_for_work() {
        let mut m = machine();
        let _a = m.begin_activity(work(ActivityKind::Turn));
        m.fence(FenceReason::DataDirReplaced);
        let effects = m.take_effects();
        assert_eq!(releases(&effects), 1);
        assert_eq!(m.status().state, StateName::Fenced);
        assert_eq!(m.core_state(), CoreState::Stopped);
    }

    #[test]
    fn terminate_token_is_bound_to_the_instance() {
        let a = Machine::new("a".into(), "1".into());
        let token = a.terminate_token();
        assert!(a.check_terminate(&token).is_ok());
        assert!(a.check_terminate("bad").is_err());
        let b = Machine::new("a".into(), "1".into());
        assert!(b.check_terminate(&token).is_err(), "tokens do not cross processes");
    }

    fn graced() -> Machine {
        let mut m = Machine::new("inst".into(), "1.4.6".into()).with_client_grace(ClientGrace::node());
        m.set_serving().unwrap();
        m.take_effects();
        m
    }

    fn armed(effects: &[Effect]) -> Vec<(u64, std::time::Duration)> {
        effects
            .iter()
            .filter_map(|e| match e {
                Effect::ArmGrace { generation, delay } => Some((*generation, *delay)),
                _ => None,
            })
            .collect()
    }

    /// `client-grace.mjs:56-75`: the last client leaving arms the grace and stops nothing; a client attaching inside it cancels it
    /// (`:86-91`); a timer that was cancelled never acts; the next emptying arms a full grace again.
    #[test]
    fn a_client_back_inside_the_grace_keeps_the_core_up() {
        let mut m = graced();
        m.client_opened();
        m.client_closed(ClientKind::Session);
        let effects = m.take_effects();
        assert_eq!(armed(&effects), [(1, ClientGrace::NODE_LOCAL)]);
        assert_eq!(releases(&effects), 0);
        assert_eq!(m.status().state, StateName::Serving);
        m.client_opened();
        assert_eq!(m.take_effects(), [Effect::CancelGrace]);
        m.grace_expired(1);
        assert_eq!(releases(&m.take_effects()), 0, "the timer of a cancelled grace is stale");
        m.client_closed(ClientKind::Session);
        assert_eq!(armed(&m.take_effects()), [(2, ClientGrace::NODE_LOCAL)], "a full grace again");
        m.grace_expired(1);
        assert_eq!(releases(&m.take_effects()), 0);
        m.grace_expired(2);
        let effects = m.take_effects();
        assert_eq!(releases(&effects), 1);
        assert_eq!(node_triggers(&effects), ["no live session clients"]);
        assert_eq!(m.status().state, StateName::Draining);
    }

    /// An armed grace is not pushed out by a later close (`client-grace.mjs:62-66`), and the remote client's is the long one.
    #[test]
    fn the_grace_follows_the_client_that_left_last_and_is_armed_once() {
        let remote = ClientGrace { local: ClientGrace::NODE_LOCAL, remote: Some(ClientGrace::NODE_REMOTE) };
        assert_eq!(remote.after(ClientKind::Remote), std::time::Duration::from_secs(1800));
        assert_eq!(remote.after(ClientKind::Channel), std::time::Duration::from_secs(10));
        let mut m = Machine::new("i".into(), "1".into()).with_client_grace(remote);
        m.set_serving().unwrap();
        m.take_effects();
        m.client_opened();
        m.client_opened();
        m.client_closed(ClientKind::Remote);
        assert!(armed(&m.take_effects()).is_empty(), "one client is still attached");
        m.client_closed(ClientKind::Remote);
        assert_eq!(armed(&m.take_effects()), [(1, ClientGrace::NODE_REMOTE)]);
        m.client_opened();
        m.client_closed(ClientKind::Session);
        m.take_effects();
        m.grace_expired(2);
        assert_eq!(releases(&m.take_effects()), 1);
    }

    /// The grace ending while a turn runs is a self-shutdown deferred by the work (`maybeSelfShutdown`): the turn is not cut, and the
    /// stop follows its end; a client attaching meanwhile keeps the core up for good.
    #[test]
    fn the_grace_ending_over_a_running_turn_waits_for_it_and_a_client_cancels_the_stop() {
        let mut m = graced();
        m.client_opened();
        let turn = m.begin_activity(work(ActivityKind::Turn));
        m.client_closed(ClientKind::Session);
        m.take_effects();
        m.grace_expired(1);
        let effects = m.take_effects();
        assert_eq!(releases(&effects), 0);
        assert!(!effects.iter().any(|e| matches!(e, Effect::CancelRunning(_))));
        assert_eq!(m.status().state, StateName::Serving);
        m.client_opened();
        m.end_activity(turn);
        assert_eq!(releases(&m.take_effects()), 0, "a client is attached again");
        m.client_closed(ClientKind::Session);
        m.grace_expired(2);
        assert_eq!(releases(&m.take_effects()), 1, "idle, nobody attached, the grace is over");
    }

    #[test]
    fn the_stop_after_the_grace_waits_for_the_running_turn_and_names_it() {
        let mut m = graced();
        m.client_opened();
        let turn = m.begin_activity(work(ActivityKind::Turn));
        m.client_closed(ClientKind::Session);
        m.grace_expired(1);
        m.take_effects();
        m.end_activity(turn);
        let effects = m.take_effects();
        assert_eq!(releases(&effects), 1);
        assert_eq!(node_triggers(&effects), ["busy service work settled"]);
    }

    /// A client arriving once the drain is committed does not undo it: the release runs once.
    #[test]
    fn a_client_arriving_in_the_drain_does_not_undo_it() {
        let mut m = graced();
        m.client_opened();
        m.client_closed(ClientKind::Session);
        m.take_effects();
        m.grace_expired(1);
        assert_eq!(releases(&m.take_effects()), 1);
        m.client_opened();
        assert_eq!(m.status().state, StateName::Draining);
        m.client_closed(ClientKind::Session);
        m.grace_expired(1);
        assert_eq!(releases(&m.take_effects()), 0, "one release only");
    }

    #[test]
    fn ct_eq_compares_whole_strings() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "abcd"));
        assert!(ct_eq("", ""));
    }
}
