pub mod commit_stage;
pub mod holds;
pub mod review_stage;
pub mod session_save;

use std::time::Instant;

use mixdog_js::json_number;
use serde_json::{Map, Value};

/// `stepMetrics`: how long each step of a finalize took, in milliseconds to two places, under `<step>Ms`.
#[derive(Clone, Debug, Default)]
pub struct StepMetrics {
    steps: Map<String, Value>,
}

impl StepMetrics {
    /// `timedStep(name, ...)`'s record: `Math.max(0, Number(elapsed.toFixed(2)))`.
    pub fn record(&mut self, name: &str, started: Instant) {
        let elapsed = (started.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0;
        self.steps.insert(format!("{name}Ms"), json_number(elapsed.max(0.0)));
    }

    pub fn to_value(&self) -> Value {
        Value::Object(self.steps.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_is_recorded_under_its_name_in_milliseconds() {
        let mut metrics = StepMetrics::default();
        metrics.record("save", Instant::now());
        metrics.record("close", Instant::now());
        let value = metrics.to_value();
        let keys: Vec<&String> = value.as_object().map(|fields| fields.keys().collect()).unwrap_or_default();
        assert_eq!(keys, ["saveMs", "closeMs"]);
        assert!(value["saveMs"].as_f64().is_some_and(|ms| ms >= 0.0));
    }
}
