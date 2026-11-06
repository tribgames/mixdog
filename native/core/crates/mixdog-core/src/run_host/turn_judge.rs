//! [`TurnJudge`] over the effort-judge model service: Node's `judgeTurn`
//! (`effort-judge/judge-client.mjs`). The service owns the model, its installs and every wait
//! (cold load, queue, deadline, load back-off); this only maps its verdict to the turn path's answer.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_services::effort_judge::{EffortJudgeModel, JudgeTiming, TurnInput, TurnVerdict};

use crate::run_host::auto_effort::JudgeAnswer;
use crate::run_host::auto_effort::TurnJudge;
use crate::run_host::auto_effort::TurnJudgeInput;
use crate::run_host::run_seams::EnvReader;

/// The turn judge: the shared model plus Node's waits (`MIXDOG_EFFORT_JUDGE_TIMEOUT_MS` and
/// `MIXDOG_EFFORT_JUDGE_COLD_WAIT_MS` read once, at construction).
pub struct ModelTurnJudge {
    model: Arc<EffortJudgeModel>,
    timing: JudgeTiming,
}

impl ModelTurnJudge {
    pub fn new(model: Arc<EffortJudgeModel>, env: &EnvReader) -> Self {
        Self { model, timing: JudgeTiming::from_env(&**env) }
    }

    /// With explicit waits (tests, hosts that choose them).
    pub fn with_timing(model: Arc<EffortJudgeModel>, timing: JudgeTiming) -> Self {
        Self { model, timing }
    }
}

#[async_trait]
impl TurnJudge for ModelTurnJudge {
    async fn judge(&self, input: TurnJudgeInput) -> JudgeAnswer {
        let input = TurnInput { request: input.request, prev: input.prev, prev_request: input.prev_request };
        match self.model.judge_turn(input, self.timing).await {
            TurnVerdict::Probs { probs, ms } => JudgeAnswer::Probs { probs, ms },
            TurnVerdict::Skipped(why) => JudgeAnswer::Skipped(why),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use mixdog_services::effort_judge::model::OrtRuntime;
    use mixdog_services::effort_judge::ModelConfig;

    use super::*;

    fn judge_over(dir: &std::path::Path, timing: JudgeTiming) -> ModelTurnJudge {
        let config = ModelConfig { dir: dir.to_owned(), explicit: true, ort_library: OrtRuntime::Library(dir.join("no-ort")) };
        let model = EffortJudgeModel::new(config, mixdog_rt::testing::tokens().cpu_bulk).unwrap();
        ModelTurnJudge::with_timing(model, timing)
    }

    fn request() -> TurnJudgeInput {
        TurnJudgeInput { request: "fix the bug".into(), prev: "ok".into(), prev_request: "hi".into() }
    }

    #[tokio::test]
    async fn a_model_that_is_not_installed_skips_the_turn_as_nodes_judge_client_does() {
        let dir = tempfile::tempdir().unwrap();
        let judge = judge_over(dir.path(), JudgeTiming::from_env(&|_| None));
        assert_eq!(judge.judge(request()).await, JudgeAnswer::Skipped("model-missing".into()));
    }

    #[tokio::test]
    async fn a_model_that_fails_to_load_skips_with_the_load_error_and_is_not_retried_inside_the_back_off() {
        let dir = tempfile::tempdir().unwrap();
        crate::run_host::fixture_fs::write(dir.path().join("model.onnx"), b"not a model");
        crate::run_host::fixture_fs::write(dir.path().join("tokenizer.json"), b"{}");
        let judge = judge_over(dir.path(), JudgeTiming::from_env(&|_| None));
        let JudgeAnswer::Skipped(first) = judge.judge(request()).await else { panic!("a broken model cannot answer") };
        assert!(first.starts_with("load-error: "), "{first}");
        // The next turn is turned away with the same reason, without loading again.
        assert_eq!(judge.judge(request()).await, JudgeAnswer::Skipped(first));
    }

    #[test]
    fn the_waits_are_nodes_and_the_env_raises_them_only_when_positive() {
        let none = JudgeTiming::from_env(&|_| None);
        assert_eq!((none.warm, none.queue, none.cold, none.retry), (Duration::from_millis(500), Duration::from_secs(1), Duration::from_secs(3), Duration::from_secs(60)));
        let set = |timeout: &'static str, cold: &'static str| {
            JudgeTiming::from_env(&move |name| Some(if name == "MIXDOG_EFFORT_JUDGE_TIMEOUT_MS" { timeout } else { cold }.to_owned()))
        };
        let raised = set("1200", " 5000 ");
        assert_eq!((raised.warm, raised.cold), (Duration::from_millis(1200), Duration::from_secs(5)));
        for bad in ["0", "-5", "soon", ""] {
            let kept = set(bad, bad);
            assert_eq!((kept.warm, kept.cold), (Duration::from_millis(500), Duration::from_secs(3)), "{bad:?}");
        }
    }
}
