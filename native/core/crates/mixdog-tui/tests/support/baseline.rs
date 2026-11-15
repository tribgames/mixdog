//! The Node numbers `perf_pty.rs` compares with (`node-perf-baseline.json`, recorded on the baseline machine).

use serde_json::Value;

const BASELINE: &str = include_str!("node-perf-baseline.json");

pub struct Baseline(Value);

impl Baseline {
    pub fn load() -> Self {
        Self::from_json(BASELINE)
    }

    fn from_json(text: &str) -> Self {
        Self(serde_json::from_str(text).expect("the baseline is JSON"))
    }

    /// The recorded number `name`, or the failure that says it was never recorded and what was measured instead.
    pub fn recorded(&self, name: &str, measured: f64) -> Result<f64, String> {
        self.0[name].as_f64().ok_or_else(|| {
            format!("no Node number is recorded for {name} in tests/support/node-perf-baseline.json (measured here: {measured:.2}); record it on the baseline machine first")
        })
    }
}

/// The median of `samples` (the mean of the middle two for an even count).
pub fn median(samples: &mut [f64]) -> f64 {
    samples.sort_by(f64::total_cmp);
    let middle = samples.len() / 2;
    if samples.len() % 2 == 0 { (samples[middle - 1] + samples[middle]) / 2.0 } else { samples[middle] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_of_odd_and_even_counts() {
        assert!((median(&mut [3.0, 1.0, 2.0]) - 2.0).abs() < f64::EPSILON);
        assert!((median(&mut [4.0, 1.0, 2.0, 3.0]) - 2.5).abs() < f64::EPSILON);
    }

    #[test]
    fn an_unrecorded_number_names_what_to_do() {
        let baseline = Baseline::from_json(r#"{ "firstFrameMs": null, "keystrokeToFrameMs": 9.5 }"#);
        let message = baseline.recorded("firstFrameMs", 812.0).expect_err("nothing is recorded");
        assert!(message.contains("firstFrameMs") && message.contains("812.00"));
        assert!((baseline.recorded("keystrokeToFrameMs", 1.0).unwrap() - 9.5).abs() < f64::EPSILON);
    }
}
