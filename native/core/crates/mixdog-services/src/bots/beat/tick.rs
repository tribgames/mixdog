//! Mixy's heartbeat (mixy-heartbeat.mjs `createMixyHeartbeat`, `startMixyHeartbeat`): at the
//! user's chosen interval (30 min / 1 h / 2 h / 4 h, default 1 h, read live at each tick), one
//! check of what happened since the last one, in three stages that each stop as early as they
//! can.
//!  1. Collect (no model): a bounded digest of what happened in the interval ([`super::facts`],
//!     [`super::digest`]).
//!  2. Gate: a digest equal to the last check's, or an empty one, ends the check. Otherwise the
//!     Maintainer model reviews each session and task line in its own call, then answers once on
//!     the reviewed digest ([`super::maintainer`]). Without one, after a failed call, or once its
//!     circuit breaker tripped (3 unusable replies or 5 provider failures in a row of the gate
//!     call, until a restart or a Maintainer model change), only a routine failing 3+ times in a
//!     row or newly switched off wakes Mixy.
//!  3. Wake: one unattended routine turn in a new hidden session of Mixy
//!     ([`crate::bots::wake`]); a reply other than the quiet sentinel is posted once into her
//!     home chat.
//!
//! The collection watermark, the digest hash and the routines' report state advance only once a
//! check is handled (a nothing decision, nothing to wake for, or a wake whose reply was
//! delivered); a failed collection (any source), Maintainer call or wake leaves them for the next
//! check, and a routine-only wake after a failed Maintainer call commits just its routine
//! warnings. A due check waits while the user is active: the user is idle only after 30 minutes
//! with no operation. Missed checks run as one; two never run at once; the first one after a
//! start is looked at after a minute.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::stream::FuturesUnordered;
use futures::{FutureExt, StreamExt};
use mixdog_core_base::rooms::ids::{MIXY_AGENT_ID, agent_home_session_id};
use mixdog_rt::{CancellationToken, TaskClass};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use tokio::sync::watch;

use super::activity::UserActivity;
use super::digest::{Digest, SessionReader, Subject, compose_digest, quoted_text, read_session_tail, skipped_note};
use super::facts::FactSources;
use super::maintainer::{DecideInput, Decision, Maintainer, Review, ReviewInput};
use super::state::{Change, Commit, HOUR_MS, HeartbeatState, HeartbeatStore};
use crate::bots::live::LiveSurface;
use crate::bots::wake::{MixyWake, WakeItems};
use crate::scheduler::Clock;

/// The user is idle only after this long with no operation.
const IDLE_MS: i64 = 30 * 60_000;
/// Mixy's last delivered message is shown to the Maintainer and to her for this long.
const REPORT_TTL_MS: i64 = 24 * HOUR_MS;
const PARSE_FAILURES_TO_TRIP: u32 = 3;
const PROVIDER_FAILURES_TO_TRIP: u32 = 5;
/// Hidden sessions that would not close stop new checks.
const MAX_UNRELEASED: usize = 20;
const REVIEWS_AT_ONCE: usize = 4;
const NOTE_LIMIT: usize = 300;
pub const FIRST_TICK: Duration = Duration::from_secs(60);
pub const TICK: Duration = Duration::from_secs(5 * 60);

/// The settings the heartbeat reads live at every tick.
#[async_trait]
pub trait HeartbeatSettings: Send + Sync {
    /// `getConfigSnapshot().heartbeat === true` (setup `set_heartbeat_enabled`).
    async fn is_enabled(&self) -> Result<bool, String>;

    /// Whether the representative bot exists (mixy-presence.mjs, the rule the desktop and her
    /// routines follow): without it no check runs at all.
    async fn mixy_exists(&self) -> Result<bool, String>;

    /// Milliseconds between checks: `normalizeHeartbeatIntervalMinutes(heartbeatIntervalMinutes)`
    /// in ms.
    async fn interval_ms(&self) -> Result<i64, String>;
}

/// What a tick did (`runTick`'s return).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A check is already running.
    Running,
    Off,
    NoMixy,
    Armed,
    Waiting,
    Deferred,
    Blocked,
    Unchanged,
    Empty,
    Nothing,
    Retry,
    Quiet,
    Woke,
    Failed,
}

impl Outcome {
    pub fn word(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Off => "off",
            Self::NoMixy => "no-mixy",
            Self::Armed => "armed",
            Self::Waiting => "waiting",
            Self::Deferred => "deferred",
            Self::Blocked => "blocked",
            Self::Unchanged => "unchanged",
            Self::Empty => "empty",
            Self::Nothing => "nothing",
            Self::Retry => "retry",
            Self::Quiet => "quiet",
            Self::Woke => "woke",
            Self::Failed => "failed",
        }
    }
}

/// The Maintainer gate's circuit breaker, reset by a change of its model.
#[derive(Default)]
struct Breaker {
    key: Option<String>,
    parse: u32,
    provider: u32,
    tripped: bool,
}

#[derive(Clone, Copy)]
enum Failure {
    Parse,
    Provider,
}

pub struct Heartbeat {
    clock: Arc<dyn Clock>,
    store: Arc<HeartbeatStore>,
    activity: Arc<UserActivity>,
    settings: Arc<dyn HeartbeatSettings>,
    facts: FactSources,
    tails: Arc<dyn SessionReader>,
    maintainer: Maintainer,
    wake: Arc<MixyWake>,
    live: Arc<dyn LiveSurface>,
    breaker: Mutex<Breaker>,
    running: watch::Sender<bool>,
}

pub struct HeartbeatParts {
    pub clock: Arc<dyn Clock>,
    pub store: Arc<HeartbeatStore>,
    pub activity: Arc<UserActivity>,
    pub settings: Arc<dyn HeartbeatSettings>,
    pub facts: FactSources,
    pub tails: Arc<dyn SessionReader>,
    pub maintainer: Maintainer,
    pub wake: Arc<MixyWake>,
    pub live: Arc<dyn LiveSurface>,
}

/// Releases the running mark when a tick ends, however it ends.
struct RunningGuard<'a>(&'a watch::Sender<bool>);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.send_replace(false);
    }
}

impl Heartbeat {
    pub fn new(parts: HeartbeatParts) -> Arc<Self> {
        Arc::new(Self {
            clock: parts.clock,
            store: parts.store,
            activity: parts.activity,
            settings: parts.settings,
            facts: parts.facts,
            tails: parts.tails,
            maintainer: parts.maintainer,
            wake: parts.wake,
            live: parts.live,
            breaker: Mutex::new(Breaker::default()),
            running: watch::channel(false).0,
        })
    }

    fn now(&self) -> i64 {
        self.clock.now().timestamp_millis()
    }

    fn breaker(&self) -> std::sync::MutexGuard<'_, Breaker> {
        self.breaker.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Closes the hidden sessions an earlier close left open; never redelivers.
    async fn retry_releases(&self) -> Result<(), String> {
        let unreleased = self.store.state().await.unreleased;
        if unreleased.is_empty() {
            return Ok(());
        }
        let mut closed = Vec::new();
        for id in unreleased {
            if self.wake.release_hidden(&id).await {
                closed.push(id);
            }
        }
        if !closed.is_empty() {
            self.store.update(Change::Released { ids: closed }).await?;
        }
        Ok(())
    }

    fn fail(self: &Arc<Self>, kind: Failure, detail: &str) {
        let (count, why) = {
            let mut breaker = self.breaker();
            let (count, limit, word, label) = match kind {
                Failure::Parse => (&mut breaker.parse, PARSE_FAILURES_TO_TRIP, "parse", "unusable replies"),
                Failure::Provider => (&mut breaker.provider, PROVIDER_FAILURES_TO_TRIP, "provider", "failed calls"),
            };
            *count += 1;
            let count = *count;
            mixdog_rt::node_stderr!("mixdog heartbeat: Maintainer {word} failure {count} in a row: {detail}");
            if count < limit {
                return;
            }
            breaker.tripped = true;
            (count, label)
        };
        mixdog_rt::node_stderr!("mixdog heartbeat: Maintainer gate off after {count} {why} in a row, until a restart or a Maintainer model change");
        // The app translates this exact text by its pattern
        // (apps/desktop/src/renderer/error-notice-copy.ts localizeHeartbeatBreakerNotice).
        let text = format!(
            "Heartbeat: the Maintainer model gave {count} {why} in a row, so heartbeat checks no longer ask it until Mixdog restarts or its model changes. Only failing routines wake Mixy meanwhile."
        );
        let this = Arc::clone(self);
        mixdog_rt::spawn("services.heartbeat.breaker-notice", TaskClass::Work, async move {
            let home = agent_home_session_id(MIXY_AGENT_ID).unwrap_or_default();
            if let Err(error) = this.live.notice(&home, json!({ "text": text, "tone": "warn" })).await {
                mixdog_rt::node_stderr!("mixdog heartbeat: breaker notice failed: {error}");
            }
        });
    }

    /// The gate's decision: `None` for the routine rule; `failed` when its call or reply failed.
    async fn ask(self: &Arc<Self>, input: &DecideInput) -> (Option<Decision>, bool) {
        match self.maintainer.decide(input).await {
            Err(error) => {
                self.fail(Failure::Provider, &error);
                (None, true)
            }
            Ok(Some(Decision::Unmanaged)) => (None, false),
            Ok(None) => {
                self.fail(Failure::Parse, "unusable reply");
                (None, true)
            }
            Ok(Some(decision)) => {
                let mut breaker = self.breaker();
                breaker.parse = 0;
                breaker.provider = 0;
                (Some(decision), false)
            }
        }
    }

    /// The digest's lines after the Maintainer reviewed each session and task line in its own
    /// call over the conversation since its last review (its previous note given): a line it
    /// found nothing in is dropped, its note is appended, and a line whose read or review failed
    /// stays as collected. A session with no item since its last review keeps that verdict
    /// without a call. The cursors are the reviews to keep once the check is handled.
    async fn reviewed(&self, digest: &Digest, state: &HeartbeatState) -> (Vec<String>, Vec<(String, String, String)>) {
        let mut lines = digest.lines.clone();
        let mut dropped = std::collections::HashSet::new();
        let mut cursors: Vec<(String, String, String)> = Vec::new();
        // A line whose older messages went unreviewed is never dropped as "nothing": it says so,
        // as the overflow lines count what they leave out.
        let mut apply = |lines: &mut Vec<String>, index: usize, note: &str, skipped: &str| {
            if note.is_empty() && skipped.is_empty() {
                dropped.insert(index);
                return;
            }
            let noted = if note.is_empty() { lines[index].clone() } else { format!("{}; reviewed: \"{}\"", lines[index], quoted_text(note, NOTE_LIMIT)) };
            lines[index] = if skipped.is_empty() { noted } else { format!("{noted}; {skipped}") };
        };
        let mut reviews = Vec::new();
        for group in digest.subjects.chunks(REVIEWS_AT_ONCE) {
            let calls: Vec<_> = group.iter().map(|subject| self.review_one(digest, state, subject).boxed()).collect();
            reviews.extend(futures::future::join_all(calls).await);
        }
        for (subject, verdict) in reviews.into_iter().flatten() {
            match verdict {
                Verdict::Prior(note) => apply(&mut lines, subject.index, &note, ""),
                Verdict::Seen { note, tail } => {
                    apply(&mut lines, subject.index, &note, &skipped_note(tail.skipped, tail.exact));
                    if !tail.head.is_empty() {
                        cursors.retain(|(id, ..)| *id != subject.id);
                        cursors.push((subject.id.clone(), tail.head, note));
                    }
                }
            }
        }
        let kept = lines.into_iter().enumerate().filter(|(index, _)| !dropped.contains(index)).map(|(_, line)| line).collect();
        (kept, cursors)
    }

    /// One session or task line's review; `None` when it could not be made.
    async fn review_one<'a>(&self, digest: &'a Digest, state: &HeartbeatState, subject: &'a Subject) -> Option<(&'a Subject, Verdict)> {
        let prior = state.reviews.iter().find(|(id, _)| *id == subject.id).map(|(_, row)| row);
        let tail = match read_session_tail(self.tails.as_ref(), &subject.id, prior.map_or("", |p| p.head.as_str())).await {
            Ok(tail) => tail,
            Err(error) => {
                mixdog_rt::node_stderr!("mixdog heartbeat: review of {} failed: {error}", subject.id);
                return None;
            }
        };
        if let Some(prior) = prior
            && tail.head == prior.head
        {
            return Some((subject, Verdict::Prior(prior.note.clone())));
        }
        // The latest messages since the cursor, in one call; the cursor then moves to the
        // newest item, and what lay before them is said so.
        let input = ReviewInput {
            line: digest.lines[subject.index].clone(),
            transcript: tail.rows.clone(),
            previous: prior.map_or_else(String::new, |p| p.note.clone()),
        };
        match self.maintainer.review(&input).await {
            Err(error) => {
                mixdog_rt::node_stderr!("mixdog heartbeat: review of {} failed: {error}", subject.id);
                None
            }
            Ok(Some(Review::Nothing)) => Some((subject, Verdict::Seen { note: String::new(), tail })),
            Ok(Some(Review::Note(note))) => Some((subject, Verdict::Seen { note, tail })),
            Ok(Some(Review::Unmanaged)) => None,
            Ok(None) => {
                mixdog_rt::node_stderr!("mixdog heartbeat: review of {}: unusable reply", subject.id);
                None
            }
        }
    }

    async fn beat(self: &Arc<Self>, at: i64) -> Result<Outcome, String> {
        let state = self.store.state().await;
        // Hidden sessions that would not close stop new ones from being made: the check waits,
        // with nothing committed, until the retries close them.
        if state.unreleased.len() >= MAX_UNRELEASED {
            return Ok(Outcome::Blocked);
        }
        // A collection that fails ends the check with nothing committed.
        let facts = self.facts.collect(state.last_beat_at).await?;
        let digest = compose_digest(&facts, &state, at);
        let hash = hex(&Sha256::digest(digest.lines.join("\n").as_bytes()));
        let commit = |reported: &[super::digest::ReportedRoutine], seen: bool, report: String, cursors: Vec<(String, String, String)>| {
            Change::Commit(Commit {
                at,
                seen,
                hash: hash.clone(),
                approvals: digest.approvals,
                cursors,
                report,
                closed: digest.closed.clone(),
                reported: reported.iter().map(|routine| (routine.key.clone(), routine.paused)).collect(),
            })
        };
        if hash == state.last_hash {
            self.store.update(commit(&[], true, String::new(), Vec::new())).await?;
            return Ok(Outcome::Unchanged);
        }
        if digest.lines.is_empty() {
            self.store.update(commit(&[], true, String::new(), Vec::new())).await?;
            return Ok(Outcome::Empty);
        }
        let proposals: Vec<String> = state.live_pending(at).into_iter().map(|entry| entry.key).collect();
        let dismissed = state.dismissed.clone();
        let key = self.maintainer.route_key().await?;
        let gated = {
            let mut breaker = self.breaker();
            if breaker.key.as_deref() != Some(key.as_str()) {
                *breaker = Breaker { key: Some(key.clone()), ..Breaker::default() };
            }
            !key.is_empty() && !breaker.tripped
        };
        let (mut lines, mut cursors) = (digest.lines.clone(), Vec::new());
        if gated {
            (lines, cursors) = self.reviewed(&digest, &state).await;
        }
        if lines.is_empty() {
            self.store.update(commit(&[], true, String::new(), cursors)).await?;
            return Ok(Outcome::Nothing);
        }
        let recent = state.last_report.as_ref().filter(|report| at - report.at < REPORT_TTL_MS).map_or_else(String::new, |report| report.text.clone());
        let (decision, failed) = if gated {
            self.ask(&DecideInput { digest: lines.clone(), last_report: recent.clone(), proposals: proposals.clone(), dismissed: dismissed.clone() }).await
        } else {
            (None, false)
        };
        if decision == Some(Decision::Nothing) {
            self.store.update(commit(&[], true, String::new(), cursors)).await?;
            return Ok(Outcome::Nothing);
        }
        let (items, evidence, reported) = match decision {
            Some(Decision::Wake(items)) => (items, lines, digest.routines.clone()),
            _ => {
                let reported: Vec<_> = digest.routines.iter().filter(|routine| routine.severe).cloned().collect();
                if reported.is_empty() {
                    // A failed Maintainer call leaves the digest for the next check.
                    if failed {
                        return Ok(Outcome::Retry);
                    }
                    self.store.update(commit(&[], true, String::new(), cursors)).await?;
                    return Ok(Outcome::Quiet);
                }
                (reported.iter().map(|routine| routine.text.clone()).collect(), Vec::new(), reported)
            }
        };
        // A wake that fails ends the check with nothing committed. After a failed Maintainer
        // call only the routine warnings it carried are handled; the rest of the digest waits
        // for the Maintainer next check.
        let outcome = self.wake.wake(&WakeItems { items, evidence, last_report: recent, proposals, dismissed }).await?;
        let report = if outcome.quiet { String::new() } else { outcome.text.unwrap_or_default() };
        self.store.update(commit(&reported, !failed, report, cursors)).await?;
        Ok(Outcome::Woke)
    }

    /// One timer step: runs a check when one is due, enabled and the user is quiet.
    pub async fn tick(self: &Arc<Self>) -> Outcome {
        if !self.running.send_if_modified(|running| !std::mem::replace(running, true)) {
            return Outcome::Running;
        }
        let _running = RunningGuard(&self.running);
        match self.run_tick().await {
            Ok(outcome) => outcome,
            Err(error) => {
                mixdog_rt::node_stderr!("mixdog heartbeat: check failed: {error}");
                Outcome::Failed
            }
        }
    }

    async fn run_tick(self: &Arc<Self>) -> Result<Outcome, String> {
        self.retry_releases().await?;
        if !self.settings.is_enabled().await? {
            return Ok(Outcome::Off);
        }
        // No Maintainer call, hidden turn or queued report for a Mixy the user never created
        // (issue #243); the first check after she is made arms anew.
        if !self.settings.mixy_exists().await? {
            if self.store.state().await.last_beat_at != 0 {
                self.store.update(Change::ClearWatermark).await?;
            }
            return Ok(Outcome::NoMixy);
        }
        let at = self.now();
        let state = self.store.state().await;
        if state.last_beat_at == 0 {
            self.store.update(Change::Arm { at }).await?;
            return Ok(Outcome::Armed);
        }
        // Checks are due by the last one begun; a check left unhandled keeps its watermark, so
        // the next one collects its changes again.
        if at - state.last_beat_at.max(state.last_attempt_at) < self.settings.interval_ms().await? {
            return Ok(Outcome::Waiting);
        }
        // The user's latest operation: a turn they sent or an input in the desktop app, as this
        // process saw it or the state file kept it (it survives a crash or restart).
        let user_at = self.activity.user_turn_at().max(self.activity.app_input_at()).max(state.last_user_input_at).max(state.last_app_input_at);
        if at - user_at < IDLE_MS {
            return Ok(Outcome::Deferred);
        }
        self.store.update(Change::Attempt { at }).await?;
        let outcome = self.beat(at).await?;
        mixdog_rt::node_stderr!("mixdog heartbeat: check {}", outcome.word());
        Ok(outcome)
    }

    /// Resolves once no check runs.
    pub async fn idle(&self) {
        let mut running = self.running.subscribe();
        let _ = running.wait_for(|running| !*running).await;
    }
}

enum Verdict {
    /// The session had no item since its last review: that verdict stands.
    Prior(String),
    Seen { note: String, tail: super::digest::Tail },
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// The heartbeat on its timers; [`stop`](Self::stop) ends them.
pub struct RunningHeartbeat {
    heartbeat: Arc<Heartbeat>,
    cancel: CancellationToken,
    /// The one task that holds both timers and the checks they began; taken by the first wait for it.
    timers: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// Resolves once the injected clock reads `due` (epoch ms). The wait is the core ticker's, armed
/// for what the clock says is left and re-armed until it says none is, so a clock that moves is
/// followed, never raced.
async fn until(heartbeat: &Heartbeat, due: i64) {
    loop {
        let left = due - heartbeat.now();
        if left <= 0 {
            return;
        }
        mixdog_rt::ticker().wait_until(std::time::Instant::now() + Duration::from_millis(left.unsigned_abs())).await;
    }
}

/// One check begun by a timer (`const tick = () => void heartbeat.tick()`).
fn check(heartbeat: &Arc<Heartbeat>) -> BoxFuture<'static, ()> {
    let heartbeat = Arc::clone(heartbeat);
    async move {
        heartbeat.tick().await;
    }
    .boxed()
}

/// Daemon start (`startMixyHeartbeat`): tick the heartbeat `first` after start, then every `every`
/// (`setTimeout` and `setInterval`, whose next step is a full `every` after the one that ran), all
/// read off the heartbeat's clock. The timers do not wait for a check to end; a tick that finds
/// one running answers [`Outcome::Running`].
pub fn start_mixy_heartbeat(heartbeat: Arc<Heartbeat>, first: Duration, every: Duration) -> RunningHeartbeat {
    let cancel = CancellationToken::new();
    let timers = {
        let (heartbeat, cancel) = (Arc::clone(&heartbeat), cancel.clone());
        mixdog_rt::spawn("services.heartbeat.timers", TaskClass::Work, async move {
            let millis = |wait: Duration| i64::try_from(wait.as_millis()).unwrap_or(i64::MAX);
            let began = heartbeat.now();
            let mut first_at = Some(began.saturating_add(millis(first)));
            let mut every_at = began.saturating_add(millis(every));
            let mut checks: FuturesUnordered<BoxFuture<'static, ()>> = FuturesUnordered::new();
            loop {
                let next = first_at.map_or(every_at, |at| at.min(every_at));
                tokio::select! {
                    // A stop wins over a timer that fell due with it: `clearTimeout` is at once.
                    biased;
                    () = cancel.cancelled() => break,
                    Some(()) = checks.next(), if !checks.is_empty() => {}
                    () = until(&heartbeat, next) => {
                        let now = heartbeat.now();
                        if first_at.is_some_and(|at| now >= at) {
                            first_at = None;
                            checks.push(check(&heartbeat));
                        }
                        if now >= every_at {
                            every_at = now.saturating_add(millis(every));
                            checks.push(check(&heartbeat));
                        }
                    }
                }
            }
            // Checks already begun end; none begins after the stop.
            while checks.next().await.is_some() {}
        })
    };
    RunningHeartbeat { heartbeat, cancel, timers: Mutex::new(Some(timers)) }
}

impl RunningHeartbeat {
    /// `clearTimeout` and `clearInterval`: no check begins after this. Once is as good as twice.
    pub fn halt(&self) {
        self.cancel.cancel();
    }

    /// Resolves when the check in progress has ended (`heartbeat.idle()`), however the timers
    /// were halted; it waits for the timers' task, which holds the checks they began.
    pub async fn ended(&self) {
        let timers = self.timers.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(timers) = timers
            && let Err(error) = timers.await
        {
            tracing::warn!("mixdog heartbeat: timers ended abnormally: {error}");
        }
        self.heartbeat.idle().await;
    }

    /// Node's `stopHeartbeat()`: stops scheduling at once; resolves when the check in progress ends.
    pub async fn stop(&self) {
        self.halt();
        self.ended().await;
    }
}
