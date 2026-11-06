//! What a running tool reports about itself, shown to clients (Node: the shell tool's
//! `onOutputTail` → `markSessionToolOutputTail`, read by transcript consumers as the running
//! card's live output; `onProgress` text).
//!
//! [`RunToolProgress`] is the run's `ProgressSink` (`ToolEnv.progress`): it only writes the
//! session cell's progress value and never blocks. [`ToolHints`] watches that value and
//! publishes the running tool's hint as the thread's runtime section (`progressHint` of
//! `thread/runtime/updated`), so every client of the thread sees it; a changed hint is sent
//! once however many writes came in between, and the hint disappears when the turn leaves
//! `tool_running`.

use std::sync::Arc;

use mixdog_app_protocol::v2::thread::ThreadRuntime;
use mixdog_core_api::domain::tool::ProgressSink;
use mixdog_core_api::domain::tool::ToolProgress;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::sync::DropGuard;

use mixdog_core_run::run_host::progress::RunProgress;
use mixdog_core_session::session::RunPort;
use mixdog_core_ports::ports::threads::Section;

/// The run's progress sink over the session cell's progress value.
pub struct RunToolProgress {
    progress: watch::Sender<RunProgress>,
}

impl RunToolProgress {
    pub fn new(progress: watch::Sender<RunProgress>) -> Arc<Self> {
        Arc::new(Self { progress })
    }
}

impl ProgressSink for RunToolProgress {
    fn progress(&self, progress: ToolProgress) {
        self.progress.send_if_modified(|run| run.tool_progress(progress));
    }
}

/// The task that publishes the running tool's hint for the length of one run. Dropping it stops
/// the task; [`ToolHints::finish`] also waits for it, so nothing is published after the run's
/// outcome is on its way.
pub struct ToolHints {
    stop: DropGuard,
    task: JoinHandle<()>,
}

impl ToolHints {
    pub fn start(mut changes: watch::Receiver<RunProgress>, port: RunPort) -> Self {
        let stop = CancellationToken::new();
        let done = stop.clone();
        let task = mixdog_rt::spawn("run-tool-hint", TaskClass::Work, async move {
            let mut shown: Option<Value> = None;
            loop {
                tokio::select! {
                    _ = done.cancelled() => return,
                    changed = changes.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
                let hint = changes.borrow_and_update().tool_hint().to_value();
                if hint == shown {
                    continue;
                }
                let section = Section::Runtime(ThreadRuntime { progress_hint: hint.clone(), ..ThreadRuntime::default() });
                tokio::select! {
                    _ = done.cancelled() => return,
                    sent = port.section(section) => {
                        if sent.is_err() {
                            return;
                        }
                    }
                }
                shown = hint;
            }
        });
        Self { stop: stop.drop_guard(), task }
    }

    pub async fn finish(self) {
        drop(self.stop);
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests {
    use mixdog_protocol::ProcessHandle;
    use serde_json::json;

    use super::*;
    use mixdog_core_run::run_host::progress::ProgressPublisher;
    use mixdog_agent::env::Clock;

    struct At(i64);
    impl Clock for At {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    fn run() -> (watch::Sender<RunProgress>, ProgressPublisher, Arc<RunToolProgress>) {
        let (tx, _rx) = watch::channel(RunProgress::default());
        let publisher = ProgressPublisher::new(tx.clone(), Arc::new(At(1_000)));
        let sink = RunToolProgress::new(tx.clone());
        (tx, publisher, sink)
    }

    fn hint(tx: &watch::Sender<RunProgress>) -> Option<Value> {
        tx.borrow().tool_hint().to_value()
    }

    #[test]
    fn a_running_tools_reports_form_its_hint_and_the_next_tool_call_clears_it() {
        let (tx, publisher, sink) = run();
        publisher.ask_start();
        publisher.tool_call(Some("shell"));
        assert_eq!(hint(&tx), None, "nothing reported yet");

        sink.progress(ToolProgress::ProcessStarted(ProcessHandle::from("p1")));
        sink.progress(ToolProgress::Stage("running 3s".into()));
        sink.progress(ToolProgress::Output(b"building\n".to_vec()));
        assert_eq!(hint(&tx), Some(json!({ "text": "running 3s", "processHandle": "p1", "outputTail": "building\n" })));

        // Output is the tool's current tail: a later one replaces it.
        sink.progress(ToolProgress::Output(b"done\n".to_vec()));
        assert_eq!(hint(&tx).unwrap()["outputTail"], "done\n");

        publisher.tool_call(Some("read"));
        assert_eq!(hint(&tx), None, "a new tool call invalidates the previous call's output");
    }

    #[test]
    fn the_tail_keeps_its_last_4000_characters_and_reads_lossily() {
        let (tx, publisher, sink) = run();
        publisher.ask_start();
        publisher.tool_call(Some("shell"));
        let long: String = (0..5000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        sink.progress(ToolProgress::Output(long.clone().into_bytes()));
        let tail = hint(&tx).unwrap()["outputTail"].as_str().unwrap().to_owned();
        assert_eq!(tail.chars().count(), 4000);
        assert!(long.ends_with(&tail));

        sink.progress(ToolProgress::Output(vec![b'o', b'k', 0xff]));
        assert_eq!(hint(&tx).unwrap()["outputTail"], "ok\u{fffd}");
    }

    #[test]
    fn the_hint_shows_only_while_the_turn_runs_a_tool_and_late_writes_are_ignored() {
        let (tx, publisher, sink) = run();
        // No entry yet: a write creates none.
        sink.progress(ToolProgress::Output(b"early".to_vec()));
        assert_eq!(tx.borrow().stage(), None);

        publisher.ask_start();
        publisher.tool_call(Some("shell"));
        sink.progress(ToolProgress::Output(b"out".to_vec()));
        assert!(hint(&tx).is_some());
        publisher.stream_delta(mixdog_core_run::run_host::progress::StreamKind::Text);
        publisher.stage("streaming");
        assert_eq!(hint(&tx), None, "the tail is read in tool_running only");

        publisher.done(false);
        sink.progress(ToolProgress::Output(b"late".to_vec()));
        publisher.tool_call(Some("shell"));
        assert_eq!(hint(&tx), None, "a settled turn is never revived");
    }

    #[test]
    fn an_unchanged_report_wakes_nobody() {
        let (tx, publisher, sink) = run();
        publisher.ask_start();
        publisher.tool_call(Some("shell"));
        let mut changes = tx.subscribe();
        sink.progress(ToolProgress::Output(b"same".to_vec()));
        assert!(changes.has_changed().unwrap());
        changes.borrow_and_update();
        sink.progress(ToolProgress::Output(b"same".to_vec()));
        assert!(!changes.has_changed().unwrap());
    }
}
