//! The redial schedule of the desktop leg replays what Node scheduled
//! (`benchmarks/rust-core/recorders/record-remote-relay-redial.mjs`, recorded from `b6f10295a`): after each
//! recorded step the delay `Redial` asks for equals the delay the product asked its timer for.

use std::time::Duration;

use mixdog_remote::leg::redial::{DESKTOP_HANDSHAKE_STALLED_CLOSE, Redial};
use serde_json::Value;

const GOLDEN: &str = include_str!("../../../../fixtures/remote-relay-redial/golden.json");

/// Runs `steps` on a fresh `Redial` and returns the delay of each step that schedules a redial.
fn replay(steps: &Value) -> Vec<(u64, Duration)> {
    let mut redial = Redial::default();
    let mut delays = Vec::new();
    for step in steps.as_array().unwrap() {
        let expected = step["delayMs"].as_u64();
        let delay = match step["op"].as_str().unwrap() {
            // The relay ended an established leg; a close with no frame has no code.
            "drop" => Some(redial.after_close(step["code"].as_u64().map(|code| u16::try_from(code).unwrap()))),
            // A dial that failed is a close with no code.
            "fail" => Some(redial.after_close(None)),
            "recover" => {
                redial.on_open();
                None
            }
            "stable" => {
                redial.on_stable();
                None
            }
            other => panic!("unknown step {other}"),
        };
        assert_eq!(delay.map(|delay| delay.as_millis() as u64), expected, "{step}");
        if let (Some(delay), Some(expected)) = (delay, expected) {
            delays.push((expected, delay));
        }
    }
    delays
}

#[test]
fn every_recorded_close_schedules_the_delay_node_scheduled() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(golden["stalledCloseCode"], DESKTOP_HANDSHAKE_STALLED_CLOSE);
    for script in ["ladder", "stalled", "full"] {
        let delays = replay(&golden[script]);
        assert!(!delays.is_empty(), "{script} records delays");
    }
    // The recording exercises the whole rule: doubling to the cap, immediate stalled redials, the stable reset.
    let full = replay(&golden["full"]);
    let at_cap = full.iter().filter(|(_, delay)| *delay == mixdog_remote::leg::redial::RETRY_MAX).count();
    assert!(at_cap >= 2, "the cap is held, not just reached");
    assert!(full.iter().any(|(_, delay)| delay.is_zero()), "stalled closes redial at once");
}
