use serde_json::Value;

use super::fast_mode::CapacityError;
use super::fast_mode::FastMode;

/// Node's `anthropic-fast-mode.mjs` (`fixtures/fast-mode/golden.json`): every scripted failure is
/// decided the same, and after every step the availability, the cooldown left and the disabled
/// reason read as recorded at that step's clock.
#[test]
fn the_capacity_policy_answers_as_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/fast-mode/golden.json")).expect("fixture");
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("name");
        let policy = FastMode::new();
        for step in scenario["steps"].as_array().expect("steps") {
            let now = step["now"].as_f64().expect("now");
            match step["op"].as_str().expect("op") {
                "note" => {
                    let error = &step["error"];
                    let headers: Vec<(String, String)> = error["headers"]
                        .as_object()
                        .expect("headers")
                        .iter()
                        .map(|(key, value)| (key.clone(), value.as_str().expect("header").to_owned()))
                        .collect();
                    let capacity = CapacityError {
                        status: error["status"].as_u64().expect("status") as u16,
                        message: error["message"].as_str().expect("message"),
                        headers: &headers,
                        retry_after_ms: error["retryAfterMs"].as_f64(),
                    };
                    let decision = policy.note_capacity_error(&capacity, step["fast"].as_bool().expect("fast"), now);
                    assert_eq!(decision.as_str(), step["decision"], "{name}: {step}");
                    assert_eq!(decision.downgraded(), step["downgraded"], "{name}: {step}");
                }
                "clear" => policy.clear(),
                _ => {}
            }
            assert_eq!(policy.available(now), step["available"], "{name}: {step}");
            let remaining = policy.cooldown_remaining_ms(now);
            match &step["cooldownRemainingMs"] {
                Value::String(text) => assert_eq!((text.as_str(), remaining), ("Infinity", f64::INFINITY), "{name}: {step}"),
                number => assert_eq!(number.as_f64(), Some(remaining), "{name}: {step}"),
            }
            assert_eq!(policy.disabled_reason().as_deref(), step["disabledReason"].as_str(), "{name}: {step}");
        }
    }
}
