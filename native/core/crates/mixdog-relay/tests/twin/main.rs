//! The twin suites of the relay: the Node relay and the Rust one answer the same scenarios and every event of both is
//! compared. Scenarios are JSON files under `tests/twin/scenarios/<suite>/`; suites are added by the tasks that port
//! each area (see `scenario.rs` for the format, `normalise.rs` for what is masked and what is not).
//!
//! The runner fails, and never skips, when `node` or the `ws` package cannot be resolved: the Node host says what to run.

mod harness;
mod normalise;
mod proc;
mod scenario;
mod transcript;

use harness::Crossover;
use proc::Runtime;
use scenario::Scenario;
use serde_json::Value;

fn load() -> Vec<(String, Scenario)> {
    let all = scenario::load_all().unwrap_or_else(|e| panic!("scenarios: {e}"));
    assert!(!all.is_empty(), "no scenario under {}", scenario::scenarios_dir().display());
    all
}

fn normalised(scenario: &Scenario, start: Runtime, mode: Crossover) -> Vec<Value> {
    let transcript = harness::run(scenario, start, mode).unwrap_or_else(|e| panic!("{e}"));
    normalise::normalise(&transcript, &scenario.keys.vapid_public)
        .unwrap_or_else(|e| panic!("scenario {} on {}: {e}", scenario.id, start.name()))
}

fn require_equal(scenario: &Scenario, a_name: &str, a: &[Value], b_name: &str, b: &[Value]) {
    if let Some(difference) = normalise::first_difference(a_name, a, b_name, b, scenario.time_tolerance_ms) {
        panic!("scenario {} ({}): {difference}", scenario.id, scenario.description);
    }
}

/// Every scenario twice against Node: equal transcripts prove the normaliser masks what is random and flag a scenario
/// whose own steps are nondeterministic.
#[test]
fn twin_harness_self_check() {
    for (_, scenario) in load() {
        let first = normalised(&scenario, Runtime::Node, Crossover::Stay);
        let second = normalised(&scenario, Runtime::Node, Crossover::Stay);
        require_equal(&scenario, "node run 1", &first, "node run 2", &second);
    }
}

/// Node against Rust, every event.
#[test]
#[ignore = "relay assembled by nr-relay-server"]
fn twin_scenarios() {
    for (_, scenario) in load() {
        let node = normalised(&scenario, Runtime::Node, Crossover::Stay);
        let rust = normalised(&scenario, Runtime::Rust, Crossover::Stay);
        require_equal(&scenario, "node", &node, "rust", &rust);
    }
}

/// One runtime writes the data directory and the other reads it: the run that crosses over equals the run that
/// restarts the same runtime, starting from either one.
#[test]
#[ignore = "relay assembled by nr-relay-server"]
fn twin_crossover() {
    let crossing: Vec<_> = load().into_iter().filter(|(_, scenario)| scenario.has_crossover()).collect();
    assert!(!crossing.is_empty(), "no scenario has a crossover step");
    for (_, scenario) in crossing {
        for start in [Runtime::Node, Runtime::Rust] {
            let stay = normalised(&scenario, start, Crossover::Stay);
            let switch = normalised(&scenario, start, Crossover::Switch);
            let stay_name = format!("{} then {}", start.name(), start.name());
            let switch_name = format!("{} then {}", start.name(), start.other().name());
            require_equal(&scenario, &stay_name, &stay, &switch_name, &switch);
        }
    }
}
