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
//! - the host's strip is published as the `hostShellJobs` section on every change.
//!
//! The tasks end with the run token or when the runtime drops the sending end.

use std::collections::HashMap;
use std::sync::Arc;

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
use mixdog_spawn::tasks::HostShellJobs;
use mixdog_spawn::tasks::ShellJobsState;
use mixdog_tools::exec::TaskNotifier;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::exec::ExecEvents;
use crate::exec::Finished;

/// Where the events go.
pub struct Targets {
    pub directory: Arc<SessionDirectory>,
    pub threads: Arc<dyn ThreadState>,
    pub publisher: Arc<dyn StatePublisher>,
}

/// Starts the three consumers of `events`.
pub fn consume(events: ExecEvents, targets: Targets, stop: CancellationToken) {
    let ExecEvents { finished, thread_strips, host_strip } = events;
    mixdog_rt::spawn("exec.finished", TaskClass::Work, completions(finished, targets.directory, stop.clone()));
    mixdog_rt::spawn("exec.thread-strips", TaskClass::Work, thread_sections(thread_strips, targets.threads, stop.clone()));
    mixdog_rt::spawn("exec.host-strip", TaskClass::Work, host_section(host_strip, targets.publisher, stop));
}

async fn completions(mut finished: mpsc::Receiver<Finished>, directory: Arc<SessionDirectory>, stop: CancellationToken) {
    loop {
        let next = tokio::select! {
            () = stop.cancelled() => return,
            next = finished.recv() => next,
        };
        let Some(done) = next else { return };
        directory.finished(&done.owner, &done.surface, &done.task_id, &done.status, done.notification).await;
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
