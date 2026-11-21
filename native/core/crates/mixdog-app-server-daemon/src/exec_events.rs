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
use mixdog_tools::orch::util::PortError;
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

/// Each completion goes to its owner's session, and its task id to `delivered` once the owner took it.
async fn completions(
    mut finished: mpsc::Receiver<Finished>,
    directory: Arc<SessionDirectory>,
    delivered: mpsc::UnboundedSender<String>,
    stop: CancellationToken,
) {
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

const PUBLISH_RETRY: Duration = Duration::from_secs(1);

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

/// Starts the four consumers of `events`.
pub fn consume(events: ExecEvents, targets: Targets, stop: CancellationToken) {
    let ExecEvents { finished, thread_strips, host_strip, forget_thread } = events;
    let (delivered_tx, delivered) = mpsc::unbounded_channel();
    mixdog_rt::spawn("exec.finished", TaskClass::Work, completions(finished, targets.directory, delivered_tx, stop.clone()));
    mixdog_rt::spawn("exec.thread-strips", TaskClass::Work, thread_sections(thread_strips, targets.threads, forget_thread, stop.clone()));
    mixdog_rt::spawn("exec.background-work", TaskClass::Work, background_work(host_strip.clone(), delivered, targets.lifecycle, targets.shells, stop.clone()));
    mixdog_rt::spawn("exec.host-strip", TaskClass::Work, host_section(host_strip, targets.publisher, stop));
}
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
// The publish retry is a poll interval, not a Node timer a replay orders: on a virtual clock it must wake once per advance as tokio's sleep did,
// not stop the clock's driver at every retry deadline.
#[allow(clippy::disallowed_methods, reason = "the retry of a failed publish is not a timer of Node's lists; a replay's clock must not stop at each retry")]
async fn thread_sections(
    mut strips: watch::Receiver<HashMap<String, ShellJobsState>>,
    threads: Arc<dyn ThreadState>,
    forget: crate::exec::ForgetThread,
    stop: CancellationToken,
) {
    let mut published: HashMap<String, ShellJobsState> = HashMap::new();
    let mut failed = false;
    loop {
        // Node's poller re-read every poll: a failed publish is tried again without waiting for the strip to change.
        tokio::select! {
            () = stop.cancelled() => return,
            changed = strips.changed() => if changed.is_err() { return },
            () = tokio::time::sleep(PUBLISH_RETRY), if failed => {}
        }
        failed = false;
        let all = strips.borrow_and_update().clone();
        for (thread, state) in all {
            if published.get(&thread) == Some(&state) {
                continue;
            }
            let section = Section::ShellJobs(thread_strip(&state));
            match threads.publish(&ThreadId::from(thread.as_str()), section).await {
                Ok(()) => {
                    published.insert(thread, state);
                }
                // A thread that no longer exists never will again: its retry and its snapshot end.
                Err(PortError::NotFound { .. }) => {
                    published.remove(&thread);
                    forget(&thread);
                }
                Err(error) => {
                    tracing::warn!(%thread, ?error, "the shell-job strip could not be published");
                    failed = true;
                }
            }
        }
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

    struct FlakyThreads {
        /// The error the next publish answers; later ones succeed.
        fail: Mutex<Option<mixdog_tools::orch::util::PortError>>,
        published: tokio::sync::mpsc::UnboundedSender<()>,
    }

    #[async_trait::async_trait]
    impl ThreadState for FlakyThreads {
        async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, mixdog_tools::orch::util::PortError> {
            unimplemented!()
        }
        async fn patch_header(
            &self,
            _: &ThreadId,
            _: serde_json::Map<String, serde_json::Value>,
            _: Vec<String>,
        ) -> Result<(), mixdog_tools::orch::util::PortError> {
            unimplemented!()
        }
        async fn patch_header_at(
            &self,
            thread: &ThreadId,
            at: &mixdog_core_ports::ports::threads::RunFence,
            expect: serde_json::Map<String, serde_json::Value>,
            set: serde_json::Map<String, serde_json::Value>,
            unset: Vec<String>,
        ) -> Result<mixdog_core_ports::ports::threads::FencedPatch, mixdog_tools::orch::util::PortError> {
            mixdog_core_ports::ports::threads::patch_at_rest(self, thread, at, expect, set, unset).await
        }
        async fn patch_header_if(
            &self,
            _: &ThreadId,
            _: serde_json::Map<String, serde_json::Value>,
            _: serde_json::Map<String, serde_json::Value>,
            _: Vec<String>,
        ) -> Result<Option<serde_json::Map<String, serde_json::Value>>, mixdog_tools::orch::util::PortError> {
            unimplemented!()
        }
        async fn store_header(
            &self,
            thread: &ThreadId,
            write: mixdog_core_ports::ports::threads::HeaderWrite,
        ) -> mixdog_core_ports::ports::threads::HeaderStored {
            mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
        }
        fn log_identity(&self, _: &ThreadId) -> Option<String> {
            None
        }
        /// This fake holds nothing but the header it answers.
        async fn held_fields(
            &self,
            thread: &ThreadId,
            keys: &'static [&'static str],
        ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
            Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
        }
        async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), mixdog_tools::orch::util::PortError> {
            let _ = self.published.send(());
            match self.fail.lock().unwrap().take() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
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

    /// A strip whose publish failed is published again on the next pass, though the strip itself did not change.
    #[tokio::test]
    async fn a_failed_thread_strip_publish_is_retried() {
        let (strips, changes) = watch::channel(HashMap::from([("t1".to_owned(), ShellJobsState::default())]));
        let (published, mut seen) = tokio::sync::mpsc::unbounded_channel();
        let failure = mixdog_tools::orch::util::PortError::Denied("refused once".into());
        let threads = Arc::new(FlakyThreads { fail: Mutex::new(Some(failure)), published });
        let stop = CancellationToken::new();
        let consumer = tokio::spawn(thread_sections(changes, threads, Arc::new(|_| {}), stop.clone()));
        strips.send_modify(|_| {});
        for _ in 0..2 {
            mixdog_rt::time::timeout(Duration::from_secs(10), seen.recv()).await.expect("the retry published").unwrap();
        }
        stop.cancel();
        consumer.await.unwrap();
    }
    /// A thread that no longer exists is not retried, and its snapshot is dropped from the strips.
    #[tokio::test]
    async fn a_missing_thread_ends_its_retry_and_its_snapshot() {
        let (strips, changes) = watch::channel(HashMap::from([("gone".to_owned(), ShellJobsState::default())]));
        let strips = Arc::new(strips);
        let (published, mut seen) = tokio::sync::mpsc::unbounded_channel();
        let missing = mixdog_tools::orch::util::PortError::NotFound { target: "gone".into(), message: "no such thread".into() };
        let threads = Arc::new(FlakyThreads { fail: Mutex::new(Some(missing)), published });
        let forget: crate::exec::ForgetThread = {
            let strips = strips.clone();
            Arc::new(move |thread| {
                strips.send_modify(|all| {
                    all.remove(thread);
                });
            })
        };
        let stop = CancellationToken::new();
        let consumer = tokio::spawn(thread_sections(changes, threads, forget, stop.clone()));
        strips.send_modify(|_| {});
        seen.recv().await.unwrap();
        mixdog_rt::time::sleep(Duration::from_millis(2500)).await;
        assert!(strips.borrow().is_empty(), "the snapshot is dropped");
        assert!(seen.try_recv().is_err(), "no retry follows");
        stop.cancel();
        consumer.await.unwrap();
    }
}
