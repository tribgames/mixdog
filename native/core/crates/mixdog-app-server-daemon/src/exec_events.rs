//! The consumers of the shell runtime's events (`exec::ExecEvents`), started by `compose()`.
//!
//! Node learns of a detached job's end and of every strip change by polling: the session host's
//! `shellJobsPoller` (`apps/desktop/src/main/shell-jobs-poller.ts`, adaptive delay, `onChange`)
//! republishes `shellJobs` per session and `hostShellJobs` when the status moved, and a finished
//! job reaches its owner through `notifySessionCompletion`. The registry pushes both
//! (DS §6.2, DS-PROC-5: no `listShellJobs` request), so each channel has one consumer:
//!
//! - a completion goes to the session directory (`TaskNotifier::finished`: the live session shows
//!   its card, then it is queued for the model);
//! - a thread's strip is published as its `shellJobs` section, once per change of that thread
//!   (`movedSessionIds`);
//! - the host's strip is published as the `hostShellJobs` section on every change, and its running background shells are running
//!   work of the core's lifecycle until their completion has reached the owner (`background_work`).
//!
//! The tasks end with the run token or when the runtime drops the sending end.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::shell_jobs::host_strip;
use mixdog_core_session::session::shell_jobs::thread_strip;
use mixdog_protocol::SectionName;
use mixdog_rt::TaskClass;
use mixdog_rt::time::Instant;
use mixdog_spawn::tasks::HostShellJobs;
use mixdog_spawn::tasks::ShellJobsState;
use mixdog_tools::exec::ShellControl;
use mixdog_tools::exec::TaskNotifier;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tokio_util::sync::DropGuard;

use crate::exec::ExecEvents;
use crate::exec::Finished;
use crate::late_lifecycle::LateLifecycle;
use crate::lifecycle::ActivityGuard;
use crate::lifecycle::ActivityInfo;
use crate::lifecycle::ActivityKind;
use crate::lifecycle::BUSY_WORK_SETTLED;
use crate::lifecycle::Tracked;

/// Where the events go.
pub struct Targets {
    pub directory: Arc<SessionDirectory>,
    pub threads: Arc<dyn ThreadState>,
    pub publisher: Arc<dyn StatePublisher>,
    /// What counts the running background shells, and what stops one a confirmed stop's abort names.
    pub lifecycle: Arc<LateLifecycle>,
    pub shells: Arc<ShellControl>,
}

/// Starts the four consumers of `events`.
pub fn consume(events: ExecEvents, targets: Targets, stop: CancellationToken) {
    let ExecEvents { finished, thread_strips, host_strip } = events;
    let (delivered_tx, delivered) = mpsc::unbounded_channel();
    mixdog_rt::spawn("exec.finished", TaskClass::Work, completions(finished, targets.directory, delivered_tx, stop.clone()));
    mixdog_rt::spawn("exec.thread-strips", TaskClass::Work, thread_sections(thread_strips, targets.threads, stop.clone()));
    mixdog_rt::spawn("exec.background-work", TaskClass::Work, background_work(host_strip.clone(), delivered, targets.lifecycle, targets.shells, stop.clone()));
    mixdog_rt::spawn("exec.host-strip", TaskClass::Work, host_section(host_strip, targets.publisher, stop));
}

/// Node rechecks a self-shutdown that busy work put off one second later (`daemon.mjs:556-561`): by then a finished background
/// task's completion (`notifySessionCompletion`) has made its owner busy, and the owner's turn holds the core.
const RECHECK: Duration = Duration::from_secs(1);

/// How long a finished shell waits for its completion to reach its owner through [`completions`]: the launching call's hook may take
/// it instead (`ToolNotify`, a worker turn's own queue, whose turn holds the core), and then it never comes.
const COMPLETION_WAIT: Duration = Duration::from_secs(5);

/// A running background shell as the lifecycle counts it; dropping it ends the activity and the wait for its abort.
struct CountedShell {
    _activity: ActivityGuard,
    _abort: Tracked,
    _waiting: DropGuard,
    /// A confirmed stop's abort named it.
    aborted: CancellationToken,
}

/// The background shells the lifecycle counts, by task id: running, or off the strip and held until their completion has made the
/// owner busy. The runtime takes a shell off the strip (`finish_row`) before it reports its completion (`report_finished`), so an
/// activity that ended with the row would let an unattended core stop before the completion's wake turn begins, where Node runs it.
struct Counted<T> {
    shells: HashMap<String, Held<T>>,
}

struct Held<T> {
    work: T,
    /// Its completion reached the owner.
    delivered: bool,
    /// Off the strip: held until then.
    until: Option<Instant>,
}

impl<T> Default for Counted<T> {
    fn default() -> Self {
        Self { shells: HashMap::new() }
    }
}

impl<T> Counted<T> {
    /// `task_id` runs: whether it is counted already (one that had left the strip is running again).
    fn runs(&mut self, task_id: &str) -> bool {
        let Some(held) = self.shells.get_mut(task_id) else { return false };
        held.until = None;
        true
    }

    fn insert(&mut self, task_id: String, work: T) {
        self.shells.insert(task_id, Held { work, delivered: false, until: None });
    }

    /// At `now` the strip lists only the shells `running` names: each other one is held for [`RECHECK`] once its completion reached
    /// the owner, or for [`COMPLETION_WAIT`] while it has not; one `at_once` names goes now, or at this wake if it was held already.
    fn left(&mut self, running: impl Fn(&str) -> bool, at_once: impl Fn(&T) -> bool, now: Instant) {
        self.shells.retain(|task_id, held| {
            if held.until.is_none() && running(task_id.as_str()) {
                return true;
            }
            if at_once(&held.work) {
                return false;
            }
            if held.until.is_none() {
                held.until = Some(now + if held.delivered { RECHECK } else { COMPLETION_WAIT });
            }
            true
        });
    }

    /// The completion of `task_id` reached its owner at `now`: a shell off the strip is held for one recheck from then.
    fn delivered(&mut self, task_id: &str, now: Instant) {
        let Some(held) = self.shells.get_mut(task_id) else { return };
        held.delivered = true;
        if held.until.is_some() {
            held.until = Some(now + RECHECK);
        }
    }

    /// Drops the shells whose hold ran out by `now`, and answers when the next hold does.
    fn expire(&mut self, now: Instant) -> Option<Instant> {
        self.shells.retain(|_, held| held.until.is_none_or(|until| until > now));
        self.shells.values().filter_map(|held| held.until).min()
    }
}

/// Node's `busySessions` counts a session whose background task still runs (`busy.mjs` `liveBusyCount`, `hasActiveBackgroundTasks`;
/// "Keep the owner runtime (and daemon self-shutdown guard) live until the task reaches a terminal state and its completion can be
/// delivered back into this session"): each running background shell of the host's strip is a `BackgroundShell` of the lifecycle
/// until it leaves the strip and its completion has made the owner busy ([`Counted`]), and a confirmed stop's abort stops it as
/// `stopBackgroundShellJob` does. `delivered` names each shell whose completion [`completions`] handed to its owner.
async fn background_work(
    mut strip: watch::Receiver<HostShellJobs>,
    mut delivered: mpsc::UnboundedReceiver<String>,
    lifecycle: Arc<LateLifecycle>,
    shells: Arc<ShellControl>,
    stop: CancellationToken,
) {
    let mut counted: Counted<CountedShell> = Counted::default();
    loop {
        // A held shell whose termination is not confirmed has finished: its processes are no task.
        let running: Vec<_> = strip.borrow_and_update().jobs.iter().filter(|row| !row.termination_unconfirmed).cloned().collect();
        let now = Instant::now();
        // An aborted shell's completion starts no turn: the abort closed the starts.
        counted.left(|task_id| running.iter().any(|row| row.task_id == task_id), |shell| shell.aborted.is_cancelled(), now);
        for row in running {
            if counted.runs(&row.task_id) {
                continue;
            }
            // A task no session owns keeps no session busy.
            let Some(owner) = row.owner else { continue };
            let info = ActivityInfo { kind: ActivityKind::BackgroundShell, thread_id: Some(owner.clone()), turn_id: None, title: row.command };
            let Some(activity) = lifecycle.begin_work(info, BUSY_WORK_SETTLED) else { continue };
            let abort = CancellationToken::new();
            let tracked = lifecycle.cancels().track(activity.id(), abort.clone());
            let waiting = CancellationToken::new();
            let aborted = abort.clone();
            let (shells, owner, task_id, ended) = (shells.clone(), ThreadId::from(owner), row.task_id.clone(), waiting.clone());
            drop(mixdog_rt::spawn("exec.background-abort", TaskClass::Work, async move {
                tokio::select! {
                    () = abort.cancelled() => drop(shells.stop_job(&owner, &task_id).await),
                    () = ended.cancelled() => {}
                }
            }));
            counted.insert(row.task_id, CountedShell { _activity: activity, _abort: tracked, _waiting: waiting.drop_guard(), aborted });
        }
        let next = counted.expire(now);
        tokio::select! {
            () = stop.cancelled() => return,
            changed = strip.changed() => if changed.is_err() { return },
            Some(task_id) = delivered.recv() => counted.delivered(&task_id, Instant::now()),
            () = mixdog_rt::time::sleep_until(next.unwrap_or(now)), if next.is_some() => {}
        }
    }
}

/// Each completion goes to its owner's session, and its task id to `delivered` once the owner took it.
async fn completions(mut finished: mpsc::Receiver<Finished>, directory: Arc<SessionDirectory>, delivered: mpsc::UnboundedSender<String>, stop: CancellationToken) {
    loop {
        let next = tokio::select! {
            () = stop.cancelled() => return,
            next = finished.recv() => next,
        };
        let Some(done) = next else { return };
        directory.finished(&done.owner, &done.surface, &done.task_id, &done.status, done.notification).await;
        let _ = delivered.send(done.task_id);
    }
}

async fn thread_sections(mut strips: watch::Receiver<HashMap<String, ShellJobsState>>, threads: Arc<dyn ThreadState>, stop: CancellationToken) {
    let mut published: HashMap<String, ShellJobsState> = HashMap::new();
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            changed = strips.changed() => if changed.is_err() { return },
        }
        let all = strips.borrow_and_update().clone();
        for (thread, state) in all {
            if published.get(&thread) == Some(&state) {
                continue;
            }
            let section = Section::ShellJobs(thread_strip(&state));
            if let Err(error) = threads.publish(&ThreadId::from(thread.as_str()), section).await {
                tracing::warn!(%thread, ?error, "the shell-job strip could not be published");
            }
            published.insert(thread, state);
        }
    }
}

async fn host_section(mut strip: watch::Receiver<HostShellJobs>, publisher: Arc<dyn StatePublisher>, stop: CancellationToken) {
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            changed = strip.changed() => if changed.is_err() { return },
        }
        let state = strip.borrow_and_update().clone();
        publisher.publish(SectionName::HostShellJobs, None, SectionChange::Set(Bytes::from(host_strip(&state).to_string())));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(SectionName, Option<String>, SectionChange)>>);

    impl StatePublisher for Recorder {
        fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
            self.0.lock().unwrap().push((section, key, change));
        }
    }

    /// `busy.mjs` keeps the owner live "until the task reaches a terminal state and its completion can be delivered back": a shell off
    /// the strip stays counted one recheck past its completion reaching the owner (handed over before or after it left), or for the
    /// completion wait when none comes; an aborted one goes at once, and one back on the strip is counted as running again.
    #[test]
    fn a_finished_shell_is_counted_until_its_completion_reached_its_owner() {
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        let mut counted: Counted<bool> = Counted::default();
        for task in ["late", "early", "none", "aborted", "back"] {
            counted.insert(task.to_owned(), task == "aborted");
        }
        counted.delivered("early", start);
        counted.left(|_| false, |aborted| *aborted, start);
        assert!(!counted.shells.contains_key("aborted"), "an aborted shell goes at once");
        assert!(counted.runs("back"), "a shell back on the strip is counted");
        counted.delivered("late", at(2));

        assert_eq!(counted.expire(start), Some(start + RECHECK), "the completion handed over first: one recheck");
        assert_eq!(counted.expire(start + RECHECK), Some(at(2) + RECHECK), "the completion handed over later: one recheck from then");
        assert_eq!(counted.expire(at(2) + RECHECK), Some(start + COMPLETION_WAIT), "no completion: the wait");
        assert_eq!(counted.expire(start + COMPLETION_WAIT), None);
        assert_eq!(counted.shells.keys().collect::<Vec<_>>(), ["back"], "the running shell stays");
    }

    /// A change of the host's strip reaches the `hostShellJobs` section as the poller's status shape; the consumer ends when the runtime drops its end.
    #[tokio::test]
    async fn a_host_strip_change_is_published_as_the_host_section() {
        let (strip, changes) = watch::channel(HostShellJobs::default());
        let recorder = Arc::new(Recorder::default());
        let consumer = tokio::spawn(host_section(changes, recorder.clone(), CancellationToken::new()));
        strip.send(HostShellJobs { count: 0, jobs: Vec::new(), orphaned: Vec::new() }).unwrap();
        drop(strip);
        consumer.await.unwrap();
        let published = recorder.0.lock().unwrap();
        assert_eq!(published.len(), 1);
        let (section, key, change) = &published[0];
        assert!(matches!(section, SectionName::HostShellJobs) && key.is_none());
        let SectionChange::Set(bytes) = change else { panic!("a strip is published as a value") };
        let value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(value, serde_json::json!({ "count": 0, "elapsedLabel": "", "jobs": [], "orphaned": [] }));
    }
}
