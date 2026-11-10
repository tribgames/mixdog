//! `deadline-plan.test.mjs` replayed: the hold and the run limit of every case Node's
//! `planShellDeadlines` was recorded for (`fixtures/exec-cases`, `record-exec-cases.mjs`, scenario `deadline-plan`).

use super::*;

const VARS: [&str; 3] = ["MIXDOG_SHELL_AUTO_BACKGROUND_MS", "BASH_MAX_TIMEOUT_MS", "MIXDOG_SHELL_BACKGROUND_MAX_MS"];

#[test]
fn every_recorded_deadline_plan_gives_nodes_hold_and_run_limit() {
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../fixtures/exec-cases/golden.json")).unwrap();
    let cases = golden["scenarios"]["deadline-plan"]["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 15);
    for case in cases {
        for name in VARS {
            // SAFETY: the test runner (nextest) runs each test in a process of its own, and this test reads
            // the variables only on this thread, after setting them.
            match case["env"][name].as_str() {
                Some(value) => unsafe { std::env::set_var(name, value) },
                None => unsafe { std::env::remove_var(name) },
            }
        }
        let mut input = case["args"].clone();
        input["command"] = "x".into();
        let args: Args = serde_json::from_value(input).unwrap();
        let background = case["backgroundOnTimeout"].as_bool().unwrap();
        let plan = &case["plan"];
        let limit = time_limit_ms(&args, background);
        let hold = hold_ms(&args, limit, background);
        // With background tasks on, the job's whole deadline is the run limit; without, the foreground timeout is.
        let deadline = if background { &plan["backgroundDeadlineMs"] } else { &plan["timeout"] };
        assert_eq!((hold, limit), (plan["autoBackgroundMs"].as_u64().unwrap(), deadline.as_u64().unwrap()), "{case}");
    }
}
