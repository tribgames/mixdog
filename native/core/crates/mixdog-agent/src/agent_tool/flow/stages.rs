//! The stages a worker's turn passes before its session's actor answers the start: each is told to the turn's job
//! (its card names it), logged with the time it took, warned about while it is still waited on, and ended by the
//! job's cancellation.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use crate::cancel::Cancel;

/// Where a worker's turn stands before it runs, in the order it passes them.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum TurnStage {
    /// The session's message count is being read before anything else of it is asked: where the turn's rows begin for
    /// the job's own accounting.
    CountingBeforeOpen,
    /// The job holds its slot and the session's route has the turn.
    Admitted,
    /// The session is being opened.
    Opening,
    /// The opened session's message count is being read.
    Counting,
    /// The start was handed to the session: its actor has not answered.
    Starting,
    /// The session started the turn.
    Started,
}

impl TurnStage {
    pub fn word(self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::Opening => "opening",
            Self::CountingBeforeOpen => "counting-before-open",
            Self::Counting => "counting-after-open",
            Self::Starting => "starting",
            Self::Started => "started",
        }
    }

    /// What the job's card says the turn is doing.
    pub fn describe(self) -> &'static str {
        match self {
            Self::Admitted => "admitted; preparing the worker's turn",
            Self::Opening => "opening the worker session",
            Self::CountingBeforeOpen => "reading the worker session's message count before its open",
            Self::Counting => "reading the opened worker session's message count",
            Self::Starting => "starting the turn on the worker session",
            Self::Started => "turn started",
        }
    }

    /// A session route reported it and the session has not started the turn.
    pub fn unstarted(self) -> bool {
        matches!(self, Self::Opening | Self::Counting | Self::Starting)
    }
}

pub type StageCallback = dyn Fn(TurnStage) + Send + Sync;

/// How long a stage is waited on before the log says so, and how often it says so again.
pub const STAGE_WARN_AFTER: Duration = Duration::from_secs(10);
pub const STAGE_WARN_EVERY: Duration = Duration::from_secs(60);

/// `wait`, and how long it took. While it is still waited on the core's log names the session, the stage and the
/// `step` of it, first after [`STAGE_WARN_AFTER`] and then every [`STAGE_WARN_EVERY`]: no deadline, `wait` goes on.
pub async fn warned<T>(session: &str, stage: TurnStage, step: Option<&str>, wait: impl Future<Output = T>) -> (T, Duration) {
    let began = mixdog_rt::time::Instant::now();
    let step = step.map(|step| format!(" step={step}")).unwrap_or_default();
    tokio::pin!(wait);
    let mut warn_in = STAGE_WARN_AFTER;
    loop {
        tokio::select! {
            biased;
            out = &mut wait => return (out, began.elapsed()),
            () = mixdog_rt::time::sleep(warn_in) => {
                mixdog_rt::turn_trace!("[turn-start] session={session} stage={}{step} waiting_ms={}", stage.word(), began.elapsed().as_millis());
                warn_in = STAGE_WARN_EVERY;
            }
        }
    }
}

/// One turn's passage through its stages.
#[derive(Clone)]
pub struct TurnStages {
    session: String,
    on_stage: Option<Arc<StageCallback>>,
    cancel: Option<Cancel>,
}

impl TurnStages {
    /// `on_stage`: the job's hook; `cancel`: the job's cancellation. A turn with no job has neither.
    pub fn new(session_id: &str, on_stage: Option<Arc<StageCallback>>, cancel: Option<Cancel>) -> Self {
        Self { session: session_id.to_owned(), on_stage, cancel }
    }

    /// The reason of the job's cancellation, once it came.
    pub fn cancelled(&self) -> Option<String> {
        self.cancel.as_ref().filter(|cancel| cancel.is_aborted()).map(Cancel::reason)
    }

    /// The turn is in `stage` now.
    pub fn enter(&self, stage: TurnStage) {
        if let Some(told) = &self.on_stage {
            told(stage);
        }
    }

    /// `wait` as `stage`, never dropped: for a wait whose end must be known whatever the job does meanwhile.
    pub async fn hold<T>(&self, stage: TurnStage, wait: impl Future<Output = T>) -> T {
        self.enter(stage);
        let (out, took) = warned(&self.session, stage, None, wait).await;
        mixdog_rt::turn_trace!("[turn-start] session={} stage={} ms={}", self.session, stage.word(), took.as_millis());
        out
    }

    /// `wait` as `stage`. The job's cancellation ends it: `wait` is dropped and the cancellation's reason is the error.
    pub async fn pass<T>(&self, stage: TurnStage, wait: impl Future<Output = T>) -> Result<T, String> {
        let Some(cancel) = self.cancel.clone() else { return Ok(self.hold(stage, wait).await) };
        if cancel.is_aborted() {
            return Err(cancel.reason());
        }
        // The cancellation first: a wait that follows the same cancellation ends with it, and is not a stage passed.
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                mixdog_rt::turn_trace!("[turn-start] session={} stage={} cancelled", self.session, stage.word());
                Err(cancel.reason())
            }
            out = self.hold(stage, wait) => Ok(out),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn traced(lines: &Arc<std::sync::Mutex<Vec<(mixdog_rt::node_log::Origin, mixdog_rt::node_log::Channel, String)>>>) -> Vec<String> {
        lines.lock().unwrap().iter().map(|(_, _, line)| line.clone()).collect()
    }

    /// A stage that is passed is logged once with its time; one still waited on is named while it waits, and the wait goes on.
    #[tokio::test(start_paused = true)]
    async fn a_stage_is_logged_when_passed_and_named_while_it_is_waited_on() {
        let (lines, _guard) = mixdog_rt::node_log::capture_trace();
        let told: Arc<std::sync::Mutex<Vec<TurnStage>>> = Arc::default();
        let sink = told.clone();
        let stages = TurnStages::new("sess_w1", Some(Arc::new(move |stage| sink.lock().unwrap().push(stage))), None);
        assert_eq!(stages.pass(TurnStage::Opening, async { 7 }).await, Ok(7));
        let slow = stages.pass(TurnStage::Counting, mixdog_rt::time::sleep(STAGE_WARN_AFTER + STAGE_WARN_EVERY + Duration::from_secs(1)));
        assert_eq!(slow.await, Ok(()));
        assert_eq!(*told.lock().unwrap(), [TurnStage::Opening, TurnStage::Counting]);
        let lines = traced(&lines);
        let want = [
            "[turn-start] session=sess_w1 stage=opening ms=",
            "[turn-start] session=sess_w1 stage=counting-after-open waiting_ms=",
            "[turn-start] session=sess_w1 stage=counting-after-open waiting_ms=",
            "[turn-start] session=sess_w1 stage=counting-after-open ms=",
        ];
        assert_eq!(lines.len(), want.len(), "{lines:?}");
        for (line, want) in lines.iter().zip(want) {
            assert!(line.starts_with(want), "{lines:?}");
        }
    }

    /// The job's cancellation ends the stage it is in with the cancellation's reason; a stage after it does not begin.
    #[tokio::test(start_paused = true)]
    async fn a_cancelled_job_ends_the_stage_it_waits_in() {
        let (lines, _guard) = mixdog_rt::node_log::capture_trace();
        let cancel = Cancel::new();
        let stages = TurnStages::new("sess_w1", None, Some(cancel.clone()));
        let held = stages.pass(TurnStage::Opening, std::future::pending::<()>());
        tokio::pin!(held);
        assert!(futures::poll!(held.as_mut()).is_pending());
        cancel.abort("stop");
        assert_eq!(held.await, Err("stop".to_owned()));
        assert_eq!(stages.pass(TurnStage::Counting, async {}).await, Err("stop".to_owned()));
        assert_eq!(stages.cancelled().as_deref(), Some("stop"));
        assert_eq!(traced(&lines), ["[turn-start] session=sess_w1 stage=opening cancelled"]);
    }
}
