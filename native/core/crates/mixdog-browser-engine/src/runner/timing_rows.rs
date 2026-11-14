//! Owner: s4-engine-runner
//! The timing row of one command (`timing.ts`): the record of [`mixdog_browser_policy::timing`] kept for a command that is running,
//! the phases it enters and leaves, the sequence steps it counts, and what the host measured of the input it dispatched merged in.
//! A command owns its own [`CommandTimer`]: parallel pages never share one, and phases may overlap, so their durations are not added
//! to `command_ms`.

use std::future::Future;
use std::sync::Mutex;

use mixdog_app_protocol::v2::browser_engine::BrowserInputTiming;
use mixdog_browser_policy::timing::Collector;
use mixdog_browser_policy::timing::CommandTiming;
use mixdog_browser_policy::timing::HostPhaseTimes;
use mixdog_browser_policy::timing::Phase;
use mixdog_rt::time::Instant;

/// Runs `operation` inside `phase` of the command's timing row when the command keeps one.
pub async fn timed<T>(timer: Option<&CommandTimer>, phase: Phase, operation: impl Future<Output = T>) -> T {
    match timer {
        Some(timer) => timer.phase(phase, operation).await,
        None => operation.await,
    }
}

/// The clock and the record of one running command.
pub struct CommandTimer {
    origin: Instant,
    collector: Mutex<Option<Collector>>,
}

impl CommandTimer {
    /// A command that waited `queue_ms` in the queue and starts now.
    pub fn start(queue_ms: f64) -> Self {
        Self { origin: Instant::now(), collector: Mutex::new(Some(Collector::start(queue_ms, 0.0))) }
    }

    fn now_ms(&self) -> f64 {
        self.origin.elapsed().as_secs_f64() * 1000.0
    }

    fn with<R>(&self, edit: impl FnOnce(&mut Collector, f64) -> R) -> Option<R> {
        let now = self.now_ms();
        let mut held = self.collector.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        held.as_mut().map(|collector| edit(collector, now))
    }

    /// Runs `operation` inside `phase` (`measureBrowserPhase`): a phase inside the same phase counts once.
    pub async fn phase<T>(&self, phase: Phase, operation: impl Future<Output = T>) -> T {
        self.with(|collector, now| collector.enter(phase, now));
        let out = operation.await;
        self.with(|collector, now| collector.exit(phase, now));
        out
    }

    /// Runs `operation` as step `index` of a sequence (`measureBrowserStep`): the phase deltas belong to exactly that step.
    pub async fn step<T>(&self, index: u32, operation: impl Future<Output = T>) -> T {
        let mark = self.with(|collector, now| collector.step_begin(now));
        let out = operation.await;
        if let Some(mark) = mark {
            self.with(|collector, now| collector.step_end(&mark, index, now));
        }
        out
    }

    /// What the host counted of the input it dispatched: its time is the command's input phase.
    pub fn merge_input(&self, timings: &[BrowserInputTiming]) {
        if timings.is_empty() {
            return;
        }
        let host = HostPhaseTimes { input_ms: timings.iter().map(|timing| timing.input_ms).sum(), ..HostPhaseTimes::default() };
        self.with(|collector, _| collector.merge_host(&host));
    }

    /// The command ended, returned or failed: the record, closed to every later call. A second call answers the same record empty-handed.
    pub fn finish(&self) -> CommandTiming {
        let now = self.now_ms();
        let taken = self.collector.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        taken.map(|collector| collector.finish(now)).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_phase_counts_each_snapshot_and_nested_phases_once() {
        let timer = CommandTimer::start(7.0);
        timer.phase(Phase::Snapshot, async {}).await;
        timer.phase(Phase::Wait, timer.phase(Phase::Wait, async {})).await;
        let timing = timer.finish();
        assert_eq!(timing.queue_ms, 7.0);
        assert_eq!((timing.snapshots, timing.screenshots), (1, 0));
        assert!(timing.command_ms >= timing.wait_ms);
    }

    #[tokio::test]
    async fn host_input_time_joins_the_input_phase_and_the_steps_stop_at_six() {
        let timer = CommandTimer::start(0.0);
        timer.merge_input(&[BrowserInputTiming { input_ms: 4.0, key_events: 1, mouse_events: 0 }, BrowserInputTiming { input_ms: 2.5, key_events: 0, mouse_events: 3 }]);
        for index in 1..=8 {
            timer.step(index, async {}).await;
        }
        let timing = timer.finish();
        assert_eq!(timing.input_ms, 6.5);
        assert_eq!(timing.steps.map(|steps| steps.len()), Some(6));
    }

    #[tokio::test]
    async fn the_target_and_actionability_waits_are_entered_on_the_commands_row_and_a_page_with_none_runs_them_bare() {
        let timer = CommandTimer::start(0.0);
        let slept = || async { std::thread::sleep(std::time::Duration::from_millis(3)) };
        timed(Some(&timer), Phase::Target, slept()).await;
        timed(Some(&timer), Phase::Actionability, slept()).await;
        assert_eq!(timed(None, Phase::Actionability, async { 7 }).await, 7);
        let timing = timer.finish();
        assert!(timing.target_ms >= 3.0 && timing.actionability_ms >= 3.0, "{timing:?}");
    }

    #[tokio::test]
    async fn the_record_is_closed_once_the_command_ended() {
        let timer = CommandTimer::start(1.0);
        let first = timer.finish();
        assert_eq!(first.queue_ms, 1.0);
        timer.phase(Phase::Snapshot, async {}).await;
        timer.merge_input(&[BrowserInputTiming { input_ms: 9.0, key_events: 0, mouse_events: 0 }]);
        assert_eq!(timer.finish(), CommandTiming::default());
    }
}
